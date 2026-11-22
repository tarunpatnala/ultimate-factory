import { runGit } from '../util/git.js';
import { out } from '../util/output.js';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { RunContext } from '../context.js';
import { runAgent, type AgentResult, type ToolOutcome } from '../agent/loop.js';
import { Workspace, WorkspaceError } from '../agent/workspace.js';
import { decodeHandoff, HANDOFF_MARKER, type Handoff } from '../github/handoff.js';
import type { Issue } from '../github/gh.js';
import { awaitingReviewCount, claimIssue, headSha, isCleanTree, releaseClaim, setState, type Claim, type StateLabel } from '../github/queue.js';
import { fullTestCommand, runGates, runProof, type GateVerdict, type ProofResult } from '../gates/gates.js';
import type { ChatMessage } from '../llm/types.js';
import type { GateLevel } from '../policy/charter.js';
import { diffStats, diffText } from '../policy/diff.js';
import { formatPolicyLine, type PolicyResult } from '../policy/engine.js';
import { runsToday, spendLast24h } from '../runs/record.js';
import { formatFindings, scanDiff, type SlopFinding } from '../policy/slop.js';
import { BudgetExceededError, LlmError } from '../util/errors.js';
import { killAllChildren } from '../util/exec.js';
import { removeAllContainers, runRepoCode } from '../util/sandbox.js';
import { lessonsBlock, readLessons } from '../learning/lessons.js';
import { runCritic, runVerifier, verifierIndependent, type CriticVerdict, type VerifierVerdict } from './judges.js';

export interface ImplementOptions {
  issue?: number;
  local: boolean;
  /** Local mode: describe the work directly. */
  task?: string;
  doneWhen?: string;
  files?: string[];
  gate?: GateLevel;
}

interface WorkItem {
  number: number;
  title: string;
  body: string;
  handoff: Handoff;
  issue?: Issue;
}

class Stop extends Error {
  constructor(
    readonly reason: string,
    readonly detail: string,
    public nextState: StateLabel | undefined,
    readonly exitCode: number,
    readonly status: 'stopped' | 'rejected' | 'infrastructure-failed' = 'stopped',
  ) {
    super(detail);
  }
}

const NEEDS_INFO_REASONS = new Set(['agent-gave-up', 'budget', 'no-progress', 'too-many-refusals', 'gates-red-twice', 'proof-failed', 'verifier-rejected', 'critic-opposed']);
const SPEC_REASONS = new Set(['load-bearing-path', 'protected-path', 'too-many-lines', 'too-many-files', 'test-modified', 'secret-file', 'scope-needs-spec']);

export async function implementCommand(ctx: RunContext, o: ImplementOptions): Promise<number> {
  const cfg = ctx.cfg;
  const useGithub = cfg.github.enabled && !o.local;
  if (!useGithub) ctx.externalWrites = false;
  const charter = ctx.charter; // throws (exit 4) when not ready
  let claim: Claim | undefined;
  let item: WorkItem | undefined;
  let originalBranch = '';
  let pushed = false;
  // A cancelled or timed-out CI job sends SIGTERM/SIGINT: leave a record and release the claim.
  let terminating = false;
  const onSignal = (sig: NodeJS.Signals) => {
    if (terminating) return;
    terminating = true;
    ctx.log.warn(`received ${sig}; releasing claim and writing the run record`);
    // Kill running gates/tests: the main path then fails, and its catch block releases the claim,
    // fixes labels and writes the record. If it does not finish in time, exit with a record.
    killAllChildren();
    removeAllContainers(cfg.agent.sandbox);
    setTimeout(() => {
      ctx.record.section('Stop', `terminated by ${sig} before cleanup finished`);
      ctx.finish('infrastructure-failed', 'terminated');
      process.exit(143);
    }, 8_000).unref();
  };
  process.once('SIGTERM', onSignal);
  process.once('SIGINT', onSignal);

  try {
    if (!cfg.agent.test_command) {
      throw new Stop('no-test-command', 'agent.test_command is not set in factory.config.yaml; without it the negative-test proof cannot run. Set it to your test command (e.g. "npm test").', undefined, 2);
    }
    if (!(await isCleanTree(ctx.root, [cfg.factory.runs_dir]))) throw new Stop('dirty-tree', 'working tree is not clean; commit or stash first', undefined, 2);
    if (runsToday(ctx.path(cfg.factory.runs_dir)) >= cfg.budget.max_runs_per_day) {
      throw new Stop('daily-cap', `budget.max_runs_per_day (${cfg.budget.max_runs_per_day}) reached`, undefined, 0);
    }
    if (cfg.budget.max_usd_per_day !== undefined) {
      const spent = spendLast24h(ctx.path(cfg.factory.runs_dir));
      if (spent >= cfg.budget.max_usd_per_day) throw new Stop('daily-spend-cap', `$${spent} spent in the last 24 hours (budget.max_usd_per_day ${cfg.budget.max_usd_per_day})`, undefined, 0);
    }
    originalBranch = (await runGit(['branch', '--show-current'], { cwd: ctx.root })).stdout.trim();

    // ---- select work + claim ------------------------------------------------------------
    let baseSha: string;
    if (useGithub) {
      const issues = await ctx.gh.listOpenIssues();
      const prHeads = (await ctx.gh.listOpenPullRequests()).map((p) => p.headRef);
      const queue = awaitingReviewCount(issues, prHeads, cfg.github.branch_prefix);
      if (queue >= charter.maxAwaitingReview) {
        throw new Stop('review-queue-full', `${queue} items awaiting human review (limit ${charter.maxAwaitingReview})`, undefined, 0);
      }
      const ready = issues.filter((i) => i.labels.includes('factory:ready-to-implement')).sort((a, b) => a.number - b.number);
      const candidates = o.issue !== undefined ? ready.filter((i) => i.number === o.issue) : ready;
      if (!candidates.length) throw new Stop('nothing-to-do', o.issue !== undefined ? `issue #${o.issue} is not labeled factory:ready-to-implement` : 'no ready-to-implement issues', undefined, 0);
      const remote = cfg.github.remote;
      const def = cfg.github.default_branch ?? (await ctx.gh.defaultBranch());
      const f = await runGit(['fetch', remote, def], { cwd: ctx.root, timeoutMs: 300_000 });
      if (f.code !== 0) throw new Stop('git-fetch-failed', f.stderr.trim(), undefined, 5, 'infrastructure-failed');
      baseSha = (await runGit(['rev-parse', `${remote}/${def}`], { cwd: ctx.root })).stdout.trim();
      // Only trust handoffs written by the factory's own identity.
      const bot = await ctx.gh.botLogin();
      for (const chosen of candidates) {
        const comments = await ctx.gh.listComments(chosen.number);
        const handoffs = comments.filter((c) => c.body.includes(HANDOFF_MARKER) && (bot ? c.author === bot : ['OWNER', 'MEMBER'].includes(c.authorAssociation)));
        const latest = handoffs[handoffs.length - 1];
        const handoffKey = process.env[cfg.github.handoff_key_env];
        const decoded = latest ? decodeHandoff(latest.body, handoffKey ? { key: handoffKey, issue: chosen.number } : undefined) : { problems: [`no factory-handoff:v1 comment by ${bot || 'an owner/member'}`] };
        ctx.record.set('issue', chosen.number);
        if (!decoded.handoff || decoded.handoff.disposition !== 'ready-to-implement') {
          item = { number: chosen.number, title: chosen.title, body: chosen.body, handoff: { disposition: 'needs-info', files_expected: [], load_bearing: false }, issue: chosen };
          throw new Stop('malformed-handoff', decoded.problems.join('; ') || 'handoff disposition is not ready-to-implement', 'factory:needs-info', 1);
        }
        const candidate: WorkItem = { number: chosen.number, title: chosen.title, body: chosen.body, handoff: decoded.handoff, issue: chosen };
        checkScope(ctx, candidate);
        const c = await claimIssue({ cwd: ctx.root, remote, baseRef: baseSha, branch: `${cfg.github.branch_prefix}fq-${chosen.number}`, runId: ctx.runId, issue: chosen.number, push: ctx.opts.apply, log: ctx.log }).catch((e) => {
          throw new Stop('claim-failed', (e as Error).message, undefined, 5, 'infrastructure-failed');
        });
        if (!c) {
          ctx.log.info(`#${chosen.number} is claimed by another run; trying the next ready issue`);
          continue;
        }
        item = candidate;
        claim = c;
        // Circuit breaker: if the base itself is not green, every attempt would fail the same way.
        const baseline = await runGates({ cwd: ctx.root, script: cfg.factory.gates_script, level: 'fast', env: ctx.codeEnv, sandbox: cfg.agent.sandbox, timeoutMs: cfg.agent.command_timeout_ms, pristineFrom: baseSha });
        if (baseline.status !== 'GREEN') {
          await releaseClaim(ctx.root, c, ctx.log).catch(() => false);
          claim = undefined;
          throw new Stop('baseline-red', `fast gates are not green on the default branch: ${baseline.line}`, undefined, 0);
        }
        break;
      }
      if (!claim || !item) throw new Stop('already-claimed', 'every ready issue is claimed by another run', undefined, 0);
      if (item.issue) await setState(ctx.gh, item.issue, 'factory:in-progress');
    } else {
      if (!o.task || !o.doneWhen) throw new Stop('missing-local-item', '--local needs --task and --done-when (and usually --files)', undefined, 2);
      const n = o.issue ?? 0;
      item = {
        number: n,
        title: o.task.split('\n')[0]!.slice(0, 80),
        body: o.task,
        handoff: { disposition: 'ready-to-implement', done_when: o.doneWhen, files_expected: o.files ?? [], load_bearing: false, gate_level: o.gate, confidence: 'medium' },
      };
      if (n) ctx.record.set('issue', n);
      checkScope(ctx, item);
      baseSha = (await runGit(['rev-parse', 'HEAD'], { cwd: ctx.root })).stdout.trim();
      claim = await claimIssue({ cwd: ctx.root, remote: cfg.github.remote, baseRef: baseSha, branch: `${cfg.github.branch_prefix}fq-${n || ctx.runId.slice(-4)}`, runId: ctx.runId, issue: n, push: false, log: ctx.log });
      if (!claim) throw new Stop('already-claimed', 'local claim branch already exists', undefined, 0);
    }
    ctx.record.set('attempted', true);
    const branch = claim.branch;
    const workItem: WorkItem = item;
    ctx.log.info(`claimed ${branch} (base ${baseSha.slice(0, 8)})`);
    const gitConfigBefore = gitConfigDigest(ctx.root);

    // ---- agent ----------------------------------------------------------------------
    const ws = new Workspace(ctx.root, ctx.policy, { maxFileBytes: cfg.agent.max_file_bytes, maxFilesListed: cfg.agent.max_files_listed });
    let requestedLevel = item.handoff.gate_level;
    const levelFor = (pr?: PolicyResult): GateLevel => ctx.policy.gateLevel(requestedLevel, pr);
    let finishAttempts = 0;
    let lastGate: GateVerdict | undefined;
    let lastPolicy: PolicyResult | undefined;
    let slop: SlopFinding[] = [];
    let slopRefusals = 0;

    /** Policy + .git/config re-check after any execution of repository code. */
    const tamperCheck = async (): Promise<{ reason: string; detail: string } | undefined> => {
      if (gitConfigDigest(ctx.root) !== gitConfigBefore) return { reason: 'git-config-tampered', detail: '.git/config changed while repository code ran' };
      const post = ctx.policy.evaluate(await diffStats(ctx.root, baseSha, [cfg.factory.runs_dir]));
      lastPolicy = post;
      const v = post.violations[0];
      if (v) return { reason: v.code, detail: `after running repository code: ${post.violations.map((x) => `${x.code}${x.path ? ` ${x.path}` : ''}`).join(', ')}` };
      return undefined;
    };

    const existedAtBase = async (p: string) => (await runGit(['cat-file', '-e', `${baseSha}:${p}`], { cwd: ctx.root })).code === 0;

    const handler = async (name: string, args: Record<string, unknown>): Promise<ToolOutcome> => {
      try {
        switch (name) {
          case 'list_files':
            return { kind: 'result', payload: await ws.listFiles(optS(args.path) ?? '.', optS(args.glob)) };
          case 'read_file':
            const f = ws.readFile(reqS(args.path, 'path'), optN(args.start_line), optN(args.end_line));
            // Repository content is untrusted: it reaches the model inside the run's fence.
            return { kind: 'result', payload: { ...f, content: ctx.fence.wrap(f.path, f.content) } };
          case 'search':
            return { kind: 'result', payload: await ws.search(reqS(args.pattern, 'pattern'), optS(args.glob), args.regex === true) };
          case 'give_up': {
            const reverted = ws.revertAll();
            return { kind: 'stop', reason: 'agent-gave-up', detail: `${String(args.reason ?? '').slice(0, 1000)} (reverted: ${reverted.join(', ') || 'nothing'})` };
          }
          case 'write_file':
          case 'edit_file':
          case 'delete_file': {
            const p = reqS(args.path, 'path');
            const rel = ws.resolve(p).rel;
            if (charter.testsAreLoadBearing && ctx.policy.paths.classify(rel).test && (await existedAtBase(rel))) {
              ctx.record.signal('refusal', 'test-modified');
              return { kind: 'refused', error: 'existing test files may not be modified or deleted in an unattended run (TESTS_ARE_LOAD_BEARING). Add a new test file instead.' };
            }
            const result =
              name === 'write_file'
                ? ws.writeFile(p, reqS(args.content, 'content', true))
                : name === 'edit_file'
                  ? ws.editFile(p, reqS(args.old_text, 'old_text'), reqS(args.new_text, 'new_text', true))
                  : ws.deleteFile(p);
            const pr = ctx.policy.evaluate(await diffStats(ctx.root, baseSha, [cfg.factory.runs_dir]));
            const hard = pr.violations.find((v) => v.code === 'too-many-lines' || v.code === 'too-many-files');
            if (hard) {
              // Revert and refuse: the agent can try a smaller change (edit_file) or give_up.
              ws.revert(rel);
              ctx.record.signal('refusal', hard.code);
              return { kind: 'refused', error: `${hard.code}: ${hard.detail}. The change to ${rel} was reverted; make a smaller change with edit_file, or call give_up.` };
            }
            const other = pr.violations[0];
            if (other) {
              ws.revert(rel);
              ctx.record.signal('refusal', other.code);
              return { kind: 'refused', error: `${other.code}: ${other.detail}` };
            }
            return { kind: 'result', payload: { ...result, diff_lines: pr.changedLines, diff_files: pr.changedFiles, limits: { lines: charter.maxChangedLines, files: charter.maxChangedFiles } } };
          }
          case 'run_gates': {
            const lvl = (['fast', 'full', 'deep'].includes(String(args.level)) ? args.level : 'fast') as GateLevel;
            const g = await runGates({ cwd: ctx.root, script: cfg.factory.gates_script, level: lvl, env: ctx.codeEnv, sandbox: cfg.agent.sandbox, timeoutMs: cfg.agent.command_timeout_ms, pristineFrom: baseSha });
            const t = await tamperCheck();
            if (t) return { kind: 'stop', reason: t.reason, detail: t.detail };
            return { kind: 'result', payload: { verdict: g.line, status: g.status, output_tail: ctx.fence.wrap('gate output', g.output.slice(-6000)) } };
          }
          case 'run_tests': {
            if (!cfg.agent.test_command) return { kind: 'refused', error: 'no agent.test_command configured; use run_gates with level "full"' };
            const r = await runRepoCode(cfg.agent.sandbox, 'bash', ['-c', fullTestCommand(cfg.agent.test_command)], { cwd: ctx.root, env: ctx.codeEnv, timeoutMs: cfg.agent.command_timeout_ms, maxOutput: 20_000 });
            const t = await tamperCheck();
            if (t) return { kind: 'stop', reason: t.reason, detail: t.detail };
            return { kind: 'result', payload: { exit_code: r.code, timed_out: r.timedOut, output_tail: ctx.fence.wrap('test output', r.output) } };
          }
          case 'run_command': {
            const cmdName = reqS(args.name, 'name');
            const cmd = cfg.agent.allowed_commands[cmdName];
            if (!cmd) return { kind: 'refused', error: `command "${cmdName}" is not in agent.allowed_commands (${Object.keys(cfg.agent.allowed_commands).join(', ') || 'none configured'})` };
            const r = await runRepoCode(cfg.agent.sandbox, 'bash', ['-c', cmd], { cwd: ctx.root, env: ctx.codeEnv, timeoutMs: cfg.agent.command_timeout_ms, maxOutput: 20_000 });
            const t = await tamperCheck();
            if (t) return { kind: 'stop', reason: t.reason, detail: t.detail };
            return { kind: 'result', payload: { exit_code: r.code, output_tail: ctx.fence.wrap('command output', r.output) } };
          }
          case 'finish': {
            finishAttempts++;
            const testPaths = Array.isArray(args.test_paths) ? args.test_paths.map(String) : [];
            // The proof is only meaningful for test files this change adds.
            const added = new Set((await diffStats(ctx.root, baseSha, [cfg.factory.runs_dir])).files.filter((f) => f.status === 'A').map((f) => f.path));
            const notNew = testPaths.filter((p) => !added.has(p) || !ctx.policy.paths.classify(p).test);
            if (notNew.length) return { kind: 'refused', error: `test_paths must be test files added by this change; not new test files: ${notNew.join(', ')}` };
            const pr = ctx.policy.evaluate(await diffStats(ctx.root, baseSha, [cfg.factory.runs_dir]));
            lastPolicy = pr;
            if (pr.changedFiles === 0) return { kind: 'stop', reason: 'no-change', detail: `agent finished without changing any file: ${String(args.summary ?? '').slice(0, 300)}` };
            if (pr.violations.length) return { kind: 'stop', reason: pr.violations[0]!.code, detail: pr.violations.map((v) => `${v.code}: ${v.detail}`).join('; ') };
            if (cfg.agent.slop !== 'off') {
              slop = scanDiff(await diffText(ctx.root, baseSha));
              slopRefusals += slop.length && cfg.agent.slop === 'block' ? 1 : 0;
              for (const f of slop) ctx.record.signal('slop', f.rule);
              if (slop.length && cfg.agent.slop === 'block' && slopRefusals <= 2) {
                return { kind: 'refused', error: `finish rejected: AI-slop in added lines. Rewrite or delete these comments and lines, then call finish again:\n${formatFindings(slop)}` };
              }
            }
            ctx.usage.checkBeforeCall(); // wall clock and budget before the long gate run
            const g = await runGates({ cwd: ctx.root, script: cfg.factory.gates_script, level: levelFor(pr), env: ctx.codeEnv, sandbox: cfg.agent.sandbox, timeoutMs: cfg.agent.command_timeout_ms, pristineFrom: baseSha });
            lastGate = g;
            // Gates execute repository code the agent may have written: re-check what it left behind.
            const tamper = await tamperCheck();
            if (tamper) return { kind: 'stop', reason: tamper.reason, detail: tamper.detail };
            if (g.status !== 'GREEN') {
              for (const gate of failingGates(g.line)) ctx.record.signal('gate', gate);
              if (finishAttempts >= 2) return { kind: 'stop', reason: 'gates-red-twice', detail: g.line };
              return { kind: 'refused', error: `finish rejected: gates are not GREEN.\n${g.line}\n${g.output.slice(-6000)}\nFix the failures, then call finish again (last attempt).` };
            }
            return { kind: 'finished', summary: String(args.summary ?? ''), testPaths };
          }
        }
        return { kind: 'refused', error: `unknown tool ${name}` };
      } catch (e) {
        if (e instanceof WorkspaceError) {
          const why = /^(?:write|delete) refused: ([^(;]+)/.exec(e.message)?.[1];
          if (why) ctx.record.signal('refusal', why.trim());
          return { kind: 'refused', error: e.message };
        }
        if (e instanceof BudgetExceededError) throw e;
        return { kind: 'refused', error: (e as Error).message };
      }
    };

    const system = buildSystemPrompt(ctx, item, levelFor());
    const user = buildUserPrompt(ctx, item);
    let result = await runAgent({ llm: ctx.llm('implement'), usage: ctx.usage, log: ctx.log, system, user, handler, maxRefusals: cfg.agent.max_refusals });
    let verifier: VerifierVerdict | undefined;
    let critic: CriticVerdict | undefined;
    let proof: ProofResult = { status: 'not-run', line: 'PROOF: status=not-run', output: '' };
    let commitSha = '';

    for (let round = 1; round <= 2; round++) {
      if (result.outcome !== 'finished') throw stopFromAgent(result);
      const finalPolicy = lastPolicy ?? ctx.policy.evaluate(await diffStats(ctx.root, baseSha, [cfg.factory.runs_dir]));
      ctx.record.set('gate_level', levelFor(finalPolicy));
      ctx.record.set('gate_status', lastGate?.status ?? 'not-run');

      // Commit the scoped change so the proof script can revert it reversibly.
      await git(ctx, ['add', '-A', '--', '.', `:(exclude)${cfg.factory.runs_dir}`]);
      await git(ctx, ['commit', '--allow-empty', '-m', `factory: FQ-${item.number} ${item.title}\n\nRun: ${ctx.runId}\ndone_when: ${item.handoff.done_when}`]);
      commitSha = await headSha(ctx.root);

      if (cfg.agent.test_command && result.testPaths?.length) {
        proof = await runProof({ cwd: ctx.root, script: cfg.factory.prove_script, base: baseSha, testPaths: result.testPaths, testCommand: cfg.agent.test_command, env: ctx.codeEnv, sandbox: cfg.agent.sandbox, timeoutMs: cfg.agent.command_timeout_ms });
      } else {
        proof = { status: 'MISCONFIGURED', line: `PROOF: status=MISCONFIGURED reason=${cfg.agent.test_command ? 'no-test-paths' : 'no-test-command'}`, output: '' };
      }
      ctx.record.set('proof_status', proof.status);
      if (proof.status === 'FAILED') throw new Stop('proof-failed', proof.line, 'factory:needs-info', 1, 'rejected');
      if (!(await isCleanTree(ctx.root, [cfg.factory.runs_dir]))) throw new Stop('tree-changed-by-tests', 'the negative-test proof left changes in the working tree', 'factory:needs-info', 4, 'rejected');
      const tamper = await tamperCheck();
      if (tamper) throw new Stop(tamper.reason, tamper.detail, 'factory:ready-to-spec', 4, 'rejected');

      const input = {
        doneWhen: item.handoff.done_when ?? '',
        filesExpected: item.handoff.files_expected,
        diff: await diffText(ctx.root, baseSha),
        gateLine: lastGate?.line ?? 'FACTORY_GATES: not-run',
        proofLine: proof.line,
        policyLine: formatPolicyLine(finalPolicy.violations.length ? 'FAIL' : 'PASS', finalPolicy),
      };
      verifier = await runVerifier(ctx, input);
      ctx.record.set('verifier', verifier.verdict);
      ctx.record.set('verifier_independent', verifierIndependent(ctx));
      if (verifier.verdict === 'rejected') for (const m of verifier.must_fix) ctx.record.signal('verifier', m);
      if (verifier.verdict === 'rejected') {
        if (round === 2) throw new Stop('verifier-rejected', `verifier rejected twice: ${verifier.must_fix.join('; ')}`, 'factory:needs-info', 1, 'rejected');
        ctx.log.warn(`verifier rejected (round 1): ${verifier.must_fix.join('; ')}`);
        finishAttempts = 0;
        // Keep the commit; the agent revises on top of it and the next round amends nothing (new commit).
        result = await runAgent({
          llm: ctx.llm('implement'),
          usage: ctx.usage,
          log: ctx.log,
          system,
          history: result.messages,
          user: `An independent verifier REJECTED your change. Address exactly these points, then call finish again:\n${verifier.must_fix.map((m) => `- ${m}`).join('\n')}\nReasons: ${verifier.reasons.join('; ')}`,
          handler,
          maxRefusals: cfg.agent.max_refusals,
        });
        continue;
      }
      if (ctx.policy.criticRequired(finalPolicy)) {
        critic = await runCritic(ctx, input);
        ctx.record.set('critic', critic.position);
        if (critic.position === 'oppose' && finalPolicy.touchesLoadBearing) {
          throw new Stop('critic-opposed', `critic opposes a load-bearing change: ${critic.strongest_objection}`, 'factory:needs-info', 1, 'rejected');
        }
      }
      lastPolicy = finalPolicy;
      break;
    }

    // ---- publish ----------------------------------------------------------------------
    const policyNow = lastPolicy!;
    const draftReasons = ctx.policy.draftReasons(policyNow, [
      ...(proof.status !== 'PROVEN' ? [`negative-test proof ${proof.status}`] : []),
      ...(verifier?.verdict === 'accepted-with-reservations' ? ['verifier accepted with reservations'] : []),
      ...(lastGate?.skipped.length ? [`skipped gates: ${lastGate.skipped.join(',')}`] : []),
      ...(critic && critic.position !== 'no-objection' ? [`critic: ${critic.position}`] : []),
      ...(verifierIndependent(ctx) ? [] : ['verifier used the same model as the implementer']),
      ...outOfScope(policyNow.files, workItem.handoff.files_expected),
      ...(slop.length ? [`${slop.length} AI-slop finding(s) left in the diff`] : []),
    ]);
    const humanRequired = draftReasons.length > 0;
    ctx.record.set('changed_lines', policyNow.changedLines).set('changed_files', policyNow.changedFiles);
    ctx.record.set('human_required', humanRequired);
    const body = prBody(ctx, item, lastGate!, proof, verifier!, critic, draftReasons, result.summary ?? '', slop);
    ctx.record.section('Outcome', `branch: ${claim.branch}\ncommit: ${commitSha}\n${lastGate?.line}\n${proof.line}\nverifier: ${verifier?.verdict}\ndraft reasons: ${draftReasons.join('; ') || 'none'}`);

    // Last line of defence: the exact commits about to leave this machine must satisfy the charter.
    if ((await headSha(ctx.root)) !== commitSha) throw new Stop('head-moved', 'HEAD changed after the checked commit; refusing to push', 'factory:needs-info', 4, 'rejected');
    if (!(await isCleanTree(ctx.root, [cfg.factory.runs_dir]))) throw new Stop('tree-changed-by-tests', 'working tree changed after the checked commit', 'factory:needs-info', 4, 'rejected');
    const finalTamper = await tamperCheck();
    if (finalTamper) throw new Stop(finalTamper.reason, finalTamper.detail, 'factory:ready-to-spec', 4, 'rejected');
    const committed = ctx.policy.evaluate(await diffStats(ctx.root, baseSha, [cfg.factory.runs_dir]));
    if (committed.violations.length) throw new Stop(committed.violations[0]!.code, `committed diff violates the charter: ${committed.violations.map((v) => v.code).join(', ')}`, 'factory:ready-to-spec', 4, 'rejected');

    if (useGithub) {
      if (ctx.opts.apply) {
        // Push the exact commit that was checked, never whatever HEAD points to.
        const p = await runGit(['push', cfg.github.remote, `${commitSha}:refs/heads/${claim.branch}`], { cwd: ctx.root, timeoutMs: 300_000 });
        if (p.code !== 0) throw new Stop('push-failed', p.stderr.trim(), 'factory:ready-to-implement', 5, 'infrastructure-failed');
        pushed = true;
      }
      const def = cfg.github.default_branch ?? (await ctx.gh.defaultBranch());
      const prNum = await ctx.gh.createPullRequest({ title: `FQ-${workItem.number}: ${workItem.title}`, body, head: claim.branch, base: def, draft: humanRequired });
      if (prNum) ctx.record.set('pull_request', prNum);
      if (prNum) writeGithubOutput('pr_number', String(prNum));
      claim = undefined; // ownership passes to the PR
      if (workItem.issue) {
        await setState(ctx.gh, workItem.issue, 'factory:awaiting-review');
        if (prNum) await ctx.gh.comment(workItem.number, `Factory opened #${prNum} (${humanRequired ? 'draft, human read required' : 'ready for review'}). Run: \`${ctx.runId}\``);
      }
    } else {
      out.write(`\n${body}\n`);
      ctx.log.info(`local run complete on branch ${claim.branch}. Review with: git log -p ${baseSha.slice(0, 8)}..${claim.branch}`);
    }
    ctx.finish('succeeded');
    return 0;
  } catch (e) {
    const stop = toStop(e, pushed);
    ctx.log.warn(`implement stopped: ${stop.reason}: ${stop.detail}`);
    ctx.record.section('Stop', `${stop.reason}: ${stop.detail}`);
    if (claim && useGithub) {
      const released = ctx.opts.apply ? await releaseClaim(ctx.root, claim, ctx.log).catch(() => false) : false;
      ctx.record.section('Claim', `branch ${claim.branch} ${released ? 'released' : 'kept for human recovery'}`);
    }
    if (useGithub && item?.issue && stop.nextState === 'factory:ready-to-implement') {
      // Poison-issue guard: after repeated failed runs, hand the item to a human instead of re-queuing.
      const bot = await ctx.gh.botLogin();
      const prior = (await ctx.gh.listComments(item.number).catch(() => [])).filter((c) => (!bot || c.author === bot) && c.body.startsWith('Factory implement run')).length;
      if (prior >= 2) stop.nextState = 'factory:needs-info';
    }
    if (useGithub && item?.issue && stop.nextState !== undefined) {
      await setState(ctx.gh, item.issue, stop.nextState).catch((err) => ctx.log.error(`could not restore label: ${(err as Error).message}`));
      await ctx.gh.comment(item.number, `Factory implement run \`${ctx.runId}\` stopped: **${stop.reason}**\n\n${stop.detail.slice(0, 1500)}`).catch(() => undefined);
    } else if (useGithub && item?.issue && claim) {
      await setState(ctx.gh, item.issue, 'factory:ready-to-implement').catch(() => undefined);
    }
    if (claim && originalBranch && !useGithub) ctx.log.info(`work kept on local branch ${claim.branch}`);
    ctx.finish(stop.status, stop.reason);
    return stop.exitCode;
  } finally {
    process.removeListener('SIGTERM', onSignal);
    process.removeListener('SIGINT', onSignal);
    // GitHub mode works on a throwaway claim branch: return the checkout to where it was.
    if (useGithub && originalBranch) await runGit(['switch', originalBranch], { cwd: ctx.root }).catch(() => undefined);
  }
}

function failingGates(line: string): string[] {
  const f = /failing=(\S+)/.exec(line)?.[1];
  return f && f !== 'none' ? f.split(',') : [];
}

/** Changed files outside the triaged scope become a reason for a human read. */
function outOfScope(files: Array<{ path: string }> | undefined, expected: string[]): string[] {
  if (!files || !expected.length) return [];
  const extra = files.map((f) => f.path).filter((p) => !expected.includes(p) && !/(^|\/)(test|tests|__tests__)\/|\.(test|spec)\.|(^|\/)test_/.test(p));
  return extra.length ? [`changed files outside files_expected: ${extra.slice(0, 5).join(', ')}${extra.length > 5 ? ', ...' : ''}`] : [];
}

function writeGithubOutput(key: string, value: string): void {
  const f = process.env.GITHUB_OUTPUT;
  if (f) appendFileSync(f, `${key}=${value}\n`);
}

/** Triage can be wrong: re-check expected files against the charter before claiming. */
function checkScope(ctx: RunContext, item: WorkItem): void {
  for (const f of item.handoff.files_expected) {
    const refusal = ctx.policy.writeRefusal(f);
    if (refusal) throw new Stop('scope-needs-spec', `expected file ${f}: ${refusal}`, 'factory:ready-to-spec', 4);
  }
}

/** Hash of .git/config: repository code run by gates must not redirect remotes, helpers or hooks. */
function gitConfigDigest(root: string): string {
  const h = createHash('sha256');
  const add = (p: string) => {
    try {
      const st = statSync(p);
      if (st.isDirectory()) for (const e of readdirSync(p).sort()) add(join(p, e));
      else h.update(p).update(readFileSync(p));
    } catch {
      h.update(`${p}:absent`);
    }
  };
  for (const p of ['config', 'info', 'refs/replace', 'shallow', 'commondir']) add(join(root, '.git', p));
  return h.digest('hex');
}

function stopFromAgent(r: AgentResult): Stop {
  const state: StateLabel = SPEC_REASONS.has(r.reason) ? 'factory:ready-to-spec' : 'factory:needs-info';
  const code = r.reason === 'budget' ? 3 : SPEC_REASONS.has(r.reason) ? 4 : 1;
  return new Stop(r.reason, r.detail, state, code);
}

function toStop(e: unknown, pushed = false): Stop {
  if (e instanceof Stop) return pushed && e.nextState === 'factory:ready-to-implement' ? new Stop(e.reason, e.detail, 'factory:needs-info', e.exitCode, e.status) : e;
  if (e instanceof BudgetExceededError) return new Stop('budget', e.message, 'factory:needs-info', 3);
  if (e instanceof LlmError) {
    // Permanent request errors (bad model name, unsupported parameter) would fail every retry.
    const permanent = e.status !== undefined && e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429;
    return new Stop('provider-error', e.message, permanent || pushed ? 'factory:needs-info' : 'factory:ready-to-implement', 5, 'infrastructure-failed');
  }
  if (pushed) return new Stop('publish-failed', (e as Error).message ?? String(e), 'factory:needs-info', 1, 'infrastructure-failed');
  return new Stop('internal-error', (e as Error).message ?? String(e), 'factory:ready-to-implement', 1, 'infrastructure-failed');
}

async function git(ctx: RunContext, args: string[]): Promise<void> {
  const r = await runGit(args, { cwd: ctx.root, maxOutput: 50_000 });
  if (r.code !== 0) throw new Stop('git-failed', `git ${args[0]}: ${r.stderr.trim()}`, 'factory:ready-to-implement', 5, 'infrastructure-failed');
}

function buildSystemPrompt(ctx: RunContext, item: WorkItem, level: GateLevel): string {
  const c = ctx.charter;
  const contractPath = join(ctx.root, ctx.cfg.factory.contract);
  const contract = existsSync(contractPath) ? readFileSync(contractPath, 'utf8').slice(0, 12_000) : '';
  const lessons = readLessons(ctx.root, ctx.cfg.learning);
  return [
    'You are the implementation agent of a software factory. You implement exactly ONE queue item with the smallest diff that makes done_when true.',
    'Rules (enforced by the runtime; violating them ends the run):',
    `- Tier: ${c.tier}. Max ${c.maxChangedLines} changed lines and ${c.maxChangedFiles} changed files.`,
    '- Never modify existing test files; add new test files instead. Never touch factory, CI, build-manifest or test-runner config files.',
    `- Load-bearing paths you must not touch: ${c.loadBearing.join(', ') || '(none)'}.`,
    '- Write the failing test first, then the fix. Do not add dependencies. Do not refactor unrelated code.',
    `- Gate level required at finish: ${level}. Use run_gates to check; finish runs them again and is refused if not GREEN (you get one retry).`,
    `- Allowlisted commands for run_command: ${Object.entries(ctx.cfg.agent.allowed_commands).map(([k, v]) => `${k} (${v})`).join(', ') || 'none'}.`,
    '- You have no shell, no network and no git. Your narrative is ignored by the verifier; only the diff and evidence count.',
    '- Prefer edit_file for changes to existing files. Call finish with the list of NEW test files that prove the change. If the item cannot be done within these rules, call give_up with the reason.',
    ctx.fence.instruction,
    contract ? `Factory contract (reference):\n${contract}` : '',
    lessons.text ? lessonsBlock('implement', lessons.text) : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function buildUserPrompt(ctx: RunContext, item: WorkItem): string {
  const h = item.handoff;
  return [
    `Queue item FQ-${item.number}: ${item.title}`,
    `done_when: ${h.done_when}`,
    `files_expected: ${h.files_expected.join(', ') || '(not specified)'}`,
    h.notes ? `notes: ${h.notes}` : '',
    'Issue text (untrusted):',
    ctx.fence.wrap(`issue #${item.number}`, item.body.slice(0, 20_000)),
  ]
    .filter(Boolean)
    .join('\n');
}

function prBody(ctx: RunContext, item: WorkItem, gate: GateVerdict, proof: ProofResult, v: VerifierVerdict, critic: CriticVerdict | undefined, draftReasons: string[], summary: string, slop: SlopFinding[]): string {
  return `## What
${summary.split('\n')[0] || item.title}

## Queue item
FQ-${item.number}${item.issue ? ` - ${item.issue.url}` : ''}
done_when: ${item.handoff.done_when}

## Why this is safe
${summary || '(no summary provided)'}

## Gates
\`${gate.line}\`
Skipped gates: ${gate.skipped.join(', ') || 'none'}

## Negative-test proof
\`${proof.line}\`

## Verification
Verifier verdict: ${v.verdict} (independent model: ${verifierIndependent(ctx) ? 'yes' : 'NO - same model as implementer'})
${v.reasons.slice(0, 5).map((r) => `- ${r}`).join('\n')}

## AI-slop check
${slop.length ? '```\n' + formatFindings(slop) + '\n```' : 'no findings in added lines'}
${critic ? `\n## Critic\nposition: ${critic.position}\nstrongest_objection: ${critic.strongest_objection}\n` : ''}
## Not checked by the factory
${notChecked(gate, proof).map((n) => `- ${n}`).join('\n')}

## Human read required
${draftReasons.length ? `yes - ${draftReasons.join('; ')}` : 'no'}

## Not done
${v.must_fix.length ? v.must_fix.map((m) => `- ${m}`).join('\n') : 'nothing'}

---
Run \`${ctx.runId}\` · tokens ${ctx.usage.totalTokens}${ctx.usage.usageEstimated ? ' (estimated)' : ''} · ~$${ctx.usage.costUsd} · ultimate-factory`;
}

/** What the automated checks did not cover, shown in every PR to counter automation bias. */
function notChecked(gate: GateVerdict, proof: ProofResult): string[] {
  const items: string[] = [];
  if (gate.skipped.length) items.push(`skipped gates: ${gate.skipped.join(', ')}`);
  if (gate.level !== 'deep') items.push(`gate level was ${gate.level}: no audit or architecture rules`);
  if (proof.status !== 'PROVEN') items.push(`negative-test proof: ${proof.status}`);
  items.push('test adequacy beyond the new test (no mutation testing on this run unless your gates run it)');
  items.push('behaviour not covered by tests, product fit, and maintainability: that is the human review');
  return items;
}

function reqS(v: unknown, name: string, allowEmpty = false): string {
  if (typeof v !== 'string' || (!allowEmpty && v === '')) throw new WorkspaceError(`${name} must be a non-empty string`);
  return v;
}
function optS(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}
function optN(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : undefined;
}

export type { ChatMessage };
