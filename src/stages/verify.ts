import { runGit } from '../util/git.js';
import { out } from '../util/output.js';
import type { RunContext } from '../context.js';
import { runGates, runProof } from '../gates/gates.js';
import { isCleanTree } from '../github/queue.js';
import { diffStats, diffText } from '../policy/diff.js';
import { formatPolicyLine } from '../policy/engine.js';
import { decodeHandoff, HANDOFF_MARKER, type Handoff } from '../github/handoff.js';
import type { GateLevel } from '../policy/charter.js';
import { run } from '../util/exec.js';
import { runCritic, runVerifier } from './judges.js';

export const VERIFY_MARKER = '<!-- factory-verify:v1 -->';

/**
 * Verify an open PR (same-repository only). Checks out the PR head detached, reruns gates,
 * proof and policy, asks verifier (+critic) and posts one marker comment.
 */
export async function verifyCommand(ctx: RunContext, o: { pr: number; testPaths?: string[] }): Promise<number> {
  const cfg = ctx.cfg;
  ctx.charter;
  const pr = await ctx.gh.getPullRequest(o.pr);
  ctx.record.set('pull_request', pr.number);
  if (pr.isFork) {
    ctx.log.warn(`PR #${pr.number} comes from a fork; skipping (secrets must never run fork code). policy-check still applies.`);
    ctx.finish('stopped', 'fork-pr');
    return 0;
  }
  if (!(await isCleanTree(ctx.root, [cfg.factory.runs_dir]))) {
    ctx.log.error('working tree is not clean');
    ctx.finish('stopped', 'dirty-tree');
    return 2;
  }
  const fetch = await runGit(['fetch', cfg.github.remote, `+refs/pull/${pr.number}/head:refs/remotes/${cfg.github.remote}/pr-${pr.number}`, pr.baseRef], { cwd: ctx.root, timeoutMs: 300_000 });
  if (fetch.code !== 0) {
    ctx.log.error(fetch.stderr);
    ctx.finish('infrastructure-failed', 'git-fetch-failed');
    return 5;
  }
  const originalRef = (await runGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: ctx.root })).stdout.trim();
  const originalSha = (await runGit(['rev-parse', 'HEAD'], { cwd: ctx.root })).stdout.trim();
  const sw = await runGit(['switch', '--detach', pr.headSha], { cwd: ctx.root });
  if (sw.code !== 0) {
    ctx.log.error(`cannot check out PR head ${pr.headSha}: ${sw.stderr.trim()}`);
    ctx.finish('infrastructure-failed', 'checkout-failed');
    return 5;
  }
  try {
    const base = (await runGit(['merge-base', pr.baseSha, pr.headSha], { cwd: ctx.root })).stdout.trim() || pr.baseSha;
    const policyResult = ctx.policy.evaluate(await diffStats(ctx.root, base, [ctx.cfg.factory.runs_dir]));
    const policyLine = formatPolicyLine(policyResult.violations.length ? 'FAIL' : 'PASS', policyResult);
    // Never trust the PR body for what to check: the handoff (written by the factory) and the
    // charter decide the gate level and done_when.
    const handoff = await handoffForBranch(ctx, pr.headRef);
    const level = ctx.policy.gateLevel(handoff?.gate_level, policyResult);
    const gates = await runGates({ cwd: ctx.root, script: cfg.factory.gates_script, level, env: ctx.codeEnv, sandbox: cfg.agent.sandbox, timeoutMs: cfg.agent.command_timeout_ms, pristineFrom: base });
    const gateLines = [...pr.body.matchAll(/`(FACTORY_GATES: level=\S+ status=(\w+)[^`]*)`/g)];
    const claimedStatus = gateLines[gateLines.length - 1]?.[2];
    const testPaths = o.testPaths ?? (await newTestFiles(ctx, base));
    const proof =
      cfg.agent.test_command && testPaths.length
        ? await runProof({ cwd: ctx.root, script: cfg.factory.prove_script, base, testPaths, testCommand: cfg.agent.test_command, env: ctx.codeEnv, sandbox: cfg.agent.sandbox, timeoutMs: cfg.agent.command_timeout_ms })
        : { status: 'MISCONFIGURED' as const, line: `PROOF: status=MISCONFIGURED reason=${cfg.agent.test_command ? 'no-new-test-files' : 'no-test-command'}`, output: '' };
    const doneWhen = handoff?.done_when ?? '(no factory handoff found; judge the diff on its own merits)';
    const input = { doneWhen, filesExpected: handoff?.files_expected ?? [], diff: await diffText(ctx.root, base), gateLine: gates.line, proofLine: proof.line, policyLine };
    const verifier = await runVerifier(ctx, input);
    const mustFix = [...verifier.must_fix];
    if (claimedStatus && claimedStatus !== gates.status) mustFix.unshift(`PR body claims gates ${claimedStatus} but re-run is ${gates.status}`);
    const verdict = claimedStatus && claimedStatus !== gates.status ? 'rejected' : verifier.verdict;
    if (verdict === 'rejected') for (const m of mustFix) ctx.record.signal('verifier', m);
    if (gates.status === 'RED') for (const gate of /failing=(\S+)/.exec(gates.line)?.[1]?.split(',').filter((x) => x !== 'none') ?? []) ctx.record.signal('gate', gate);
    const critic = ctx.policy.criticRequired(policyResult) ? await runCritic(ctx, input) : undefined;
    const humanReasons = ctx.policy.draftReasons(policyResult, proof.status !== 'PROVEN' ? [`proof ${proof.status}`] : []);

    const body = `${VERIFY_MARKER}
### Factory verification

**Verdict:** ${verdict}
**Human read required:** ${humanReasons.length ? `yes (${humanReasons.join('; ')})` : 'no'}

\`${gates.line}\`
\`${proof.line}\`
\`${policyLine}\`

| Check | Result |
|---|---|
| Gates reproduce PR claim | ${claimedStatus ? (claimedStatus === gates.status ? 'yes' : 'no') : 'no claim in PR body'} |
| Test fails without fix | ${proof.status === 'PROVEN' ? 'yes' : proof.status === 'FAILED' ? 'no' : 'could-not-determine'} |
| Pre-existing tests untouched | ${policyResult.modifiesTests ? 'no' : 'yes'} |
| Policy (charter) | ${policyResult.violations.length ? policyResult.violations.map((v) => v.code).join(', ') : 'pass'} |
| done_when literally true | ${verifier.done_when_true ? 'yes' : 'no'} |

**Must fix**
${mustFix.length ? mustFix.map((m, i) => `${i + 1}. ${m}`).join('\n') : 'none'}
${critic ? `\n**Critic:** ${critic.position} — ${critic.strongest_objection}\n` : ''}
<sub>run \`${ctx.runId}\` · verifier ${ctx.llm('verify').label}</sub>`;
    out.write(body + '\n');
    await ctx.gh.upsertMarkerComment(pr.number, VERIFY_MARKER, body);
    const accepted = verdict !== 'rejected';
    await ctx.gh.addLabels(pr.number, [accepted ? 'factory:verified' : 'factory:rejected']);
    await ctx.gh.removeLabel(pr.number, accepted ? 'factory:rejected' : 'factory:verified');
    ctx.record.set('gate_level', level).set('gate_status', gates.status).set('proof_status', proof.status).set('verifier', verdict).set('critic', critic?.position ?? 'not-run').set('human_required', humanReasons.length > 0).set('policy_violations', policyResult.violations.map((v) => v.code));
    ctx.finish(accepted ? 'succeeded' : 'rejected', accepted ? 'none' : 'verifier-rejected');
    return accepted ? 0 : 1;
  } finally {
    const back = originalRef ? await runGit(['switch', originalRef], { cwd: ctx.root }) : await runGit(['switch', '--detach', originalSha], { cwd: ctx.root });
    if (back.code !== 0) ctx.log.error(`could not restore the original checkout (${originalRef || originalSha}): ${back.stderr.trim()}`);
  }
}

async function handoffForBranch(ctx: RunContext, headRef: string): Promise<Handoff | undefined> {
  const m = new RegExp(`^${ctx.cfg.github.branch_prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}fq-(\\d+)$`).exec(headRef);
  if (!m) return undefined;
  const bot = await ctx.gh.botLogin();
  const comments = await ctx.gh.listComments(Number(m[1])).catch(() => []);
  const own = comments.filter((c) => c.body.includes(HANDOFF_MARKER) && (bot ? c.author === bot : ['OWNER', 'MEMBER'].includes(c.authorAssociation)));
  const last = own[own.length - 1];
  const key = process.env[ctx.cfg.github.handoff_key_env];
  return last ? decodeHandoff(last.body, key ? { key, issue: Number(m[1]) } : undefined).handoff : undefined;
}

async function newTestFiles(ctx: RunContext, base: string): Promise<string[]> {
  const d = await diffStats(ctx.root, base, [ctx.cfg.factory.runs_dir]);
  return d.files.filter((f) => f.status === 'A' && ctx.policy.paths.classify(f.path).test).map((f) => f.path);
}
