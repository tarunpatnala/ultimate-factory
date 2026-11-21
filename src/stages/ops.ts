import { runGit } from '../util/git.js';
import { out as sink } from '../util/output.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { RunContext } from '../context.js';
import { resolveModel, type LoadedConfig } from '../config/load.js';
import { ROLES } from '../config/types.js';
import { runGates } from '../gates/gates.js';
import type { Issue } from '../github/gh.js';
import { awaitingReviewCount, LABEL_SPECS, STATE_LABELS, stateOf } from '../github/queue.js';
import { LlmClient } from '../llm/client.js';
import { UsageTracker } from '../llm/usage.js';
import type { GateLevel } from '../policy/charter.js';
import { parseCharter } from '../policy/charter.js';
import { recentRuns } from '../runs/record.js';
import { run } from '../util/exec.js';
import { readFileSync } from 'node:fs';
import type { Logger } from '../util/log.js';
import { Redactor } from '../util/redact.js';

// ---------------------------------------------------------------------------
// gates
// ---------------------------------------------------------------------------
export async function gatesCommand(ctx: RunContext, level: GateLevel): Promise<number> {
  const g = await runGates({ cwd: ctx.root, script: ctx.cfg.factory.gates_script, level, env: ctx.codeEnv, sandbox: ctx.cfg.agent.sandbox, timeoutMs: ctx.cfg.agent.command_timeout_ms });
  sink.write(g.output + '\n');
  sink.write(`\n${g.reason ? 'verdict (synthesized by ufactory)' : 'verdict (nonce-authenticated)'}: ${g.line}\n`);
  return g.status === 'GREEN' ? 0 : g.status === 'RED' ? 1 : 2;
}

// ---------------------------------------------------------------------------
// status (control room)
// ---------------------------------------------------------------------------
export async function statusCommand(ctx: RunContext): Promise<number> {
  const out: string[] = [];
  const charterPath = ctx.path(ctx.cfg.factory.charter);
  const parsed = existsSync(charterPath) ? parseCharter(readFileSync(charterPath, 'utf8')) : { problems: ['missing'] };
  const limit = parsed.charter?.maxAwaitingReview ?? 3;
  out.push(`# Factory control room  (${new Date().toISOString()})`);
  out.push(`charter: ${parsed.charter ? `${parsed.charter.status} · tier ${parsed.charter.tier}` : `NOT READY (${parsed.problems.join('; ')})`}`);
  out.push(`profile: ${ctx.loaded.profile ?? 'default'} · implement model ${ctx.llm('implement').label} · verify model ${ctx.llm('verify').label}`);
  if (ctx.cfg.github.enabled) {
    try {
      const issues = await ctx.gh.listOpenIssues();
      const queue = awaitingReviewCount(issues);
      out.push('', `## Needs you: review queue ${queue}/${limit}${queue >= limit ? '  ** FULL: implement will refuse to start **' : ''}`);
      for (const i of issues.filter((x) => x.labels.includes('factory:awaiting-review'))) out.push(`- #${i.number} ${i.title} (${ageDays(i)}d)`);
      for (const i of issues.filter((x) => x.labels.includes('factory:needs-info'))) out.push(`- needs-info #${i.number} ${i.title}`);
      for (const i of issues.filter((x) => x.labels.includes('factory:ready-to-spec'))) out.push(`- ready-to-spec #${i.number} ${i.title}`);
      out.push('', '## Queue');
      for (const l of STATE_LABELS) out.push(`- ${l}: ${issues.filter((i) => stateOf(i) === l).length}`);
      out.push(`- untriaged: ${issues.filter((i) => !stateOf(i)).length}`);
      const stale = issues.filter((i) => i.labels.includes('factory:in-progress') && hoursSince(i.updatedAt) > ctx.cfg.github.stale_claim_hours);
      if (stale.length) out.push('', '## Stale claims (recover by hand; never auto-taken)', ...stale.map((i) => `- #${i.number} in-progress for ${Math.round(hoursSince(i.updatedAt))}h (branch ${ctx.cfg.github.branch_prefix}fq-${i.number})`));
    } catch (e) {
      out.push('', `GitHub unavailable: ${(e as Error).message}`);
    }
  }
  out.push('', '## Recent runs');
  for (const r of recentRuns(ctx.path(ctx.cfg.factory.runs_dir), 8)) out.push(`- ${r.file}: ${r.fields.status ?? '?'} ${r.fields.stop_reason && r.fields.stop_reason !== 'none' ? `(${r.fields.stop_reason})` : ''} tokens=${Number(r.fields.tokens_prompt ?? 0) + Number(r.fields.tokens_completion ?? 0)} $${r.fields.cost_usd ?? 0}`);
  sink.write(out.join('\n') + '\n');
  return 0;
}

// ---------------------------------------------------------------------------
// monitor
// ---------------------------------------------------------------------------
export async function monitorCommand(ctx: RunContext): Promise<number> {
  ctx.charter;
  // Titles never contain changing numbers and every finding has a stable key, so a re-run finds
  // the existing issue (hidden marker) instead of filing a new one.
  type Finding = { key: string; title: string; category: string; severity: string; what: string; evidence: string; disposition: string };
  const findings: Finding[] = [];
  const clean: string[] = [];
  const g = await runGates({ cwd: ctx.root, script: ctx.cfg.factory.gates_script, level: 'deep', env: ctx.codeEnv, sandbox: ctx.cfg.agent.sandbox, timeoutMs: ctx.cfg.agent.command_timeout_ms });
  if (g.status === 'GREEN') clean.push(`gate health: ${g.line}`);
  else findings.push({ key: 'gate-health', title: 'Factory: gates are not green on the default branch', category: 'gate-health', severity: 'blocks-factory', what: 'Deep gates are not green on the checked-out default branch; every downstream verdict is measured against a broken baseline. Implement stops with baseline-red until this is fixed.', evidence: `${g.line}\n\n${g.output.slice(-3000)}`, disposition: g.status === 'MISCONFIGURED' ? 'needs-info' : 'ready-to-implement' });
  if (g.skipped.length) findings.push({ key: 'gate-skips', title: 'Factory: optional gates are skipped', category: 'gate-health', severity: 'low', what: 'Decide whether these should become required in .factory/gates.conf.', evidence: g.line, disposition: 'needs-info' });

  let issues: Issue[] = [];
  if (ctx.cfg.github.enabled) {
    issues = await ctx.gh.listOpenIssues();
    const prs = await ctx.gh.listOpenPullRequests();
    const prefix = ctx.cfg.github.branch_prefix;
    const limit = ctx.charter.maxAwaitingReview;
    const queue = awaitingReviewCount(issues, prs.map((p) => p.headRef), prefix);
    if (queue >= limit) findings.push({ key: 'queue-full', title: 'Factory: human review queue is full', category: 'queue-staleness', severity: 'blocks-factory', what: `Implementation is throttled until a human reviews pending PRs (${queue}/${limit}).`, evidence: issues.filter((i) => i.labels.includes('factory:awaiting-review')).map((i) => `#${i.number}`).join(', '), disposition: 'needs-info' });
    for (const i of issues.filter((x) => x.labels.includes('factory:in-progress') && hoursSince(x.updatedAt) > ctx.cfg.github.stale_claim_hours)) {
      findings.push({ key: `stale-${i.number}`, title: `Factory: stale claim on #${i.number}`, category: 'queue-staleness', severity: 'medium', what: `In progress with no update for more than ${ctx.cfg.github.stale_claim_hours}h. Recover by hand; the factory never takes over a claim.`, evidence: `branch ${prefix}fq-${i.number}`, disposition: 'needs-info' });
    }
    for (const i of issues.filter((x) => x.labels.includes('factory:awaiting-review') && ageDays(x) > 7)) {
      findings.push({ key: `awaiting-${i.number}`, title: `Factory: #${i.number} has waited more than a week for review`, category: 'queue-staleness', severity: 'medium', what: 'The human review queue is the bottleneck.', evidence: i.url, disposition: 'needs-info' });
    }
    // GitHub label writes are not transactional: report issues left with two state labels.
    for (const i of issues) {
      const states = i.labels.filter((l) => (STATE_LABELS as readonly string[]).includes(l));
      if (states.length > 1) findings.push({ key: `labels-${i.number}`, title: `Factory: #${i.number} has ${states.length} state labels`, category: 'queue-staleness', severity: 'medium', what: `Concurrent label writes left ${states.join(', ')}. Keep the one that matches the claim branch and PR state, remove the rest.`, evidence: i.url, disposition: 'needs-info' });
    }
    // Orphaned claims: a claim branch with no open PR and no in-progress issue blocks that issue forever.
    const refs = await runGit(['ls-remote', '--heads', ctx.cfg.github.remote, `${prefix}fq-*`], { cwd: ctx.root, timeoutMs: 60_000 });
    const prHeads = new Set(prs.map((p) => p.headRef));
    for (const line of refs.stdout.split('\n').filter(Boolean)) {
      const ref = line.split(/\s+/)[1]?.replace('refs/heads/', '') ?? '';
      const n = Number(/fq-(\d+)$/.exec(ref)?.[1]);
      const inProgress = issues.some((i) => i.number === n && i.labels.includes('factory:in-progress'));
      if (n && !prHeads.has(ref) && !inProgress) findings.push({ key: `orphan-${n}`, title: `Factory: orphaned claim branch for #${n}`, category: 'queue-staleness', severity: 'medium', what: `${ref} exists without an open PR or an in-progress issue, so implement skips #${n}. Delete the branch after checking it, or open a PR from it.`, evidence: ref, disposition: 'needs-info' });
    }
    clean.push(`queue: ${issues.length} open issues and ${prs.length} open PRs scanned`);
  }
  const advisories = existsSync(join(ctx.root, 'package.json')) ? await run('npm', ['audit', '--json', '--audit-level=high'], { cwd: ctx.root, env: ctx.codeEnv, timeoutMs: 120_000, maxOutput: 2_000_000 }).catch(() => undefined) : undefined;
  if (advisories?.stdout) {
    try {
      const j = JSON.parse(advisories.stdout);
      const v = j.metadata?.vulnerabilities ?? {};
      if ((v.high ?? 0) + (v.critical ?? 0) > 0) findings.push({ key: 'npm-advisories', title: 'Factory: high or critical dependency advisories', category: 'advisory', severity: 'high', what: `${v.critical ?? 0} critical and ${v.high ?? 0} high advisories in dependencies.`, evidence: JSON.stringify(v), disposition: 'ready-to-spec' });
      else clean.push('advisories: no high/critical');
    } catch {
      clean.push('advisories: npm audit output not parseable');
    }
  }

  const MAX = 10;
  const filed: string[] = [];
  for (const f of findings.slice(0, MAX)) {
    const marker = `<!-- factory-monitor:${f.key} -->`;
    const dup = issues.find((i) => i.body.includes(marker));
    if (dup) {
      filed.push(`${f.title} (already open as #${dup.number})`);
      continue;
    }
    const body = `${marker}\n**Detected:** ${new Date().toISOString().slice(0, 10)} by factory-monitor (\`${ctx.runId}\`)\n**Category:** ${f.category}\n**Severity:** ${f.severity}\n\n**What**\n${f.what}\n\n**Evidence**\n\`\`\`\n${f.evidence.slice(0, 4000)}\n\`\`\`\n\n**Suggested disposition**\n${f.disposition}`;
    const num = ctx.cfg.github.enabled ? await ctx.gh.createIssue(f.title, body, ['factory:monitor']) : undefined;
    filed.push(`${f.title}${num ? ` (#${num})` : ctx.opts.apply ? '' : ' (dry run)'}`);
  }
  const dropped = Math.max(0, findings.length - MAX);
  const report = [`findings: ${findings.length}${dropped ? ` (filed top ${MAX}, dropped ${dropped})` : ''}`, ...filed.map((f) => `- ${f}`), '', 'checked and clean:', ...clean.map((c) => `- ${c}`)].join('\n');
  sink.write(report + '\n');
  ctx.record.section('Findings', report);
  ctx.finish('succeeded');
  return findings.some((f) => f.severity === 'blocks-factory') ? 1 : 0;
}

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------
export async function doctorCommand(loaded: LoadedConfig, o: { ping: boolean; log: Logger }): Promise<number> {
  const root = loaded.root;
  const cfg = loaded.config;
  let bad = 0;
  const ok = (m: string) => sink.write(`  ok    ${m}\n`);
  const warn = (m: string) => sink.write(`  warn  ${m}\n`);
  const fail = (m: string) => {
    bad++;
    sink.write(`  FAIL  ${m}\n`);
  };
  sink.write(`ufactory doctor\nconfig: ${loaded.path}${loaded.profile ? ` (profile ${loaded.profile})` : ''}\n\n`);

  let ghMissing = false;
  sink.write('Tools\n');
  for (const [bin, args, required] of [['git', ['--version'], true], ['bash', ['--version'], true], ['gh', ['--version'], cfg.github.enabled], ['node', ['--version'], true], ['jq', ['--version'], false]] as const) {
    const r = await run(bin === 'gh' ? process.env.UFACTORY_GH_BIN || 'gh' : bin, [...args], { cwd: root, timeoutMs: 15_000 });
    if (r.code === 0) ok(`${bin}: ${r.stdout.split('\n')[0]}`);
    else {
      (required ? fail : warn)(`${bin} not found${required ? '' : ' (optional)'}${bin === 'gh' ? ' (install from https://cli.github.com, then gh auth login)' : ''}${bin === 'bash' ? ' (Windows: use Git Bash or WSL)' : ''}`);
      if (bin === 'gh') ghMissing = true;
    }
  }
  if (cfg.github.enabled && !ghMissing) {
    const r = await run(process.env.UFACTORY_GH_BIN || 'gh', ['auth', 'status'], { cwd: root, timeoutMs: 15_000 });
    r.code === 0 ? ok('gh authenticated') : fail('gh is not authenticated (run: gh auth login, or set GH_TOKEN in CI)');
  }

  sink.write('\nFactory files\n');
  for (const f of [cfg.factory.charter, cfg.factory.contract, cfg.factory.gates_script, cfg.factory.prove_script]) existsSync(join(root, f)) ? ok(f) : fail(`${f} missing (run ufactory init)`);
  const cp = join(root, cfg.factory.charter);
  if (existsSync(cp)) {
    const text = readFileSync(cp, 'utf8');
    const { charter, problems } = parseCharter(text);
    if (!charter) {
      for (const p of problems) fail(`charter: ${p}`);
      const status = /CHARTER_STATUS:\s*(\S+)/.exec(text)?.[1];
      if (status !== 'ready') fail(`charter: CHARTER_STATUS is "${status ?? 'missing'}"; a human sets it to ready after reviewing every section`);
    } else if (charter.status !== 'ready') warn(`CHARTER_STATUS is "${charter.status}"; writing stages refuse to run until a human sets it to ready`);
    else ok(`charter ready · tier ${charter.tier} · limits ${charter.maxChangedLines} lines / ${charter.maxChangedFiles} files / queue ${charter.maxAwaitingReview}`);
  }

  const sb = cfg.agent.sandbox;
  if (sb.mode === 'none') warn('agent.sandbox.mode is none: gates and tests run as your OS user and can read this process (and its tokens) through /proc on Linux. Use docker or podman for unattended runs.');
  else {
    const v = await run(sb.mode, ['image', 'inspect', '--format', '{{.Id}}', sb.image!], { cwd: root, timeoutMs: 30_000 });
    v.code === 0 ? ok(`sandbox: ${sb.mode} image ${sb.image} (network ${sb.network})`) : fail(`sandbox: ${sb.mode} cannot find image ${sb.image} (${(v.stderr || v.stdout).split('\n')[0]}); pull it first`);
  }
  if (cfg.github.enabled) process.env[cfg.github.handoff_key_env] ? ok(`handoffs signed with ${cfg.github.handoff_key_env}`) : warn(`${cfg.github.handoff_key_env} is not set: handoffs are unsigned, so any comment by the bot identity counts as one`);
  if (cfg.budget.max_usd_per_day === undefined) warn('budget.max_usd_per_day is not set: spend is capped per run only');

  if (!cfg.agent.test_command) fail('agent.test_command is empty: implement refuses to run without it (the negative-test proof needs it)');
  else ok(`agent.test_command: ${cfg.agent.test_command}`);

  sink.write('\nModels\n');
  for (const n of loaded.missingEnv) warn(`config references unset env var ${n}`);
  const seen = new Set<string>();
  for (const role of ROLES) {
    const m = resolveModel(loaded, role);
    const keyEnv = m.provider.api_key_env;
    const keyOk = !keyEnv || Boolean(process.env[keyEnv]);
    const line = `${role.padEnd(9)} -> ${m.provider.name} (${m.provider.type}) ${m.settings.model}${m.fallbacks.length ? ` (+${m.fallbacks.length} fallback${m.fallbacks.length > 1 ? 's' : ''})` : ''}`;
    keyOk ? ok(line) : fail(`${line}: env ${keyEnv} is not set`);
    if (role === 'implement' && !m.provider.capabilities.tools) fail('implement provider has capabilities.tools=false; implement needs tool calling');
    const imp = resolveModel(loaded, 'implement').settings;
    if (role === 'verify' && m.settings.provider === imp.provider && m.settings.model === imp.model) warn('verify uses the same provider+model as implement (correlated blind spots). Consider a different model for roles.verify.');
    if (o.ping && keyOk) {
      const key = `${m.provider.name}|${m.settings.model}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const usage = new UsageTracker({ maxTokens: 50_000, maxTurns: 10 }, cfg.budget.prices);
      const client = new LlmClient(m, { runId: `doctor-${Date.now()}`, stage: 'doctor', usage, log: o.log, redactor: new Redactor(loaded.secretEnvNames) });
      try {
        const res = await client.chat({
          purpose: 'doctor/ping',
          messages: [
            { role: 'system', content: 'You are a connectivity check. Call the ping tool with ok=true.' },
            { role: 'user', content: 'ping' },
          ],
          tools: m.provider.capabilities.tools
            ? [{ type: 'function', function: { name: 'ping', description: 'connectivity check', parameters: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] } } }]
            : undefined,
        });
        const toolOk = res.toolCalls.some((t) => t.function.name === 'ping');
        (m.provider.capabilities.tools && !toolOk ? warn : ok)(`ping ${client.label}: served ${res.servedModel} in ${res.latencyMs}ms${m.provider.capabilities.tools ? (toolOk ? ' · tool call ok' : ' · NO tool call returned') : ''}${res.usageEstimated ? ' · usage missing (estimated)' : ''}`);
      } catch (e) {
        fail(`ping ${client.label}: ${(e as Error).message}`);
      }
    }
  }
  sink.write(`\n${bad ? `${bad} problem(s) found` : 'all checks passed'}\n`);
  return bad ? 2 : 0;
}

// ---------------------------------------------------------------------------
// models
// ---------------------------------------------------------------------------
export function modelsCommand(loaded: LoadedConfig): number {
  sink.write(`profile: ${loaded.profile ?? '(none)'}\n\nrole       provider            type               model\n`);
  for (const role of ROLES) {
    const m = resolveModel(loaded, role);
    sink.write(`${role.padEnd(10)} ${m.provider.name.padEnd(19)} ${m.provider.type.padEnd(18)} ${m.settings.model}${m.fallbacks.length ? `   fallbacks: ${m.fallbacks.map((f) => `${f.provider.name}:${f.settings.model}`).join(' -> ')}` : ''}\n`);
  }
  const pm = Object.keys(loaded.config.review.persona_models);
  if (pm.length) {
    sink.write('\npersona overrides\n');
    for (const p of pm) {
      const m = resolveModel(loaded, 'review', p);
      sink.write(`  ${p.padEnd(22)} ${m.provider.name}:${m.settings.model}\n`);
    }
  }
  sink.write(`\nreview panel: ${loaded.config.review.personas.join(', ')}\n`);
  return 0;
}

export async function bootstrapLabels(ctx: RunContext): Promise<number> {
  for (const l of LABEL_SPECS) await ctx.gh.ensureLabel(l.name, l.color, l.description);
  ctx.log.info(ctx.opts.apply ? `ensured ${LABEL_SPECS.length} labels` : `would ensure ${LABEL_SPECS.length} labels (pass --apply)`);
  return 0;
}

function hoursSince(iso: string): number {
  return (Date.now() - Date.parse(iso)) / 3_600_000;
}
function ageDays(i: Issue): number {
  return Math.floor(hoursSince(i.updatedAt) / 24);
}
