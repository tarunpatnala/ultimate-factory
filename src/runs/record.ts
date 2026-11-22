import { randomBytes } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml, stringify } from 'yaml';
import type { UsageTracker } from '../llm/usage.js';
import type { Redactor } from '../util/redact.js';
import { VERSION } from '../version.js';

export type RunStatus = 'succeeded' | 'stopped' | 'rejected' | 'infrastructure-failed' | 'dry-run';

export const RUN_RECORD_SCHEMA = 'run-record/v1';

export interface RunFields {
  schema: string;
  run_id: string;
  stage: string;
  started_at: string;
  finished_at?: string;
  status: RunStatus;
  stop_reason: string;
  issue: number | 'none';
  pull_request: number | 'none';
  gate_level: string;
  gate_status: string;
  proof_status: string;
  verifier: string;
  verifier_independent: boolean | 'n/a';
  critic: string;
  human_required: boolean;
  policy_violations: string[];
  /** True once work was claimed: the denominator for success rates (no-op runs excluded). */
  attempted: boolean;
  changed_lines: number;
  changed_files: number;
  agent_turns: number;
  duration_seconds: number;
  tokens_prompt: number;
  tokens_completion: number;
  usage_estimated: boolean;
  cost_usd: number;
  llm_calls: number;
  models_requested: string[];
  models_served: string[];
  profile: string;
  factory_version: string;
  /**
   * What went wrong on the way, in a fixed vocabulary that `tune` counts: verifier:<must_fix>,
   * gate:<failing gate>, slop:<rule>, refusal:<policy code>. Empty for a clean run.
   */
  learn_signals: string[];
  /** Outcome records only (stage "outcome"): what happened to the PR after it was opened. */
  outcome?: PrOutcome;
  outcome_evidence?: string[];
  source_run?: string;
}

/** Final states only: an outcome record is written once, when nothing can change it any more. */
export type PrOutcome = 'merged-clean' | 'reverted' | 'fixed-after-merge' | 'escaped' | 'closed-unmerged';
export const MAX_SIGNALS = 40;

export function makeRunId(stage: string, ref?: number | string, now = new Date()): string {
  const ts = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  // 2026-11-21T153012Z format (keeps the date dashes for readability)
  const pretty = `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}T${ts.slice(9, 15)}Z`;
  return `${pretty}-${stage}-${ref ?? 'none'}-${randomBytes(2).toString('hex')}`;
}

export class RunRecord {
  readonly fields: RunFields;
  readonly sections: Array<{ title: string; body: string }> = [];

  constructor(runId: string, stage: string, profile = 'default') {
    this.fields = {
      schema: RUN_RECORD_SCHEMA,
      run_id: runId,
      stage,
      started_at: new Date().toISOString(),
      status: 'stopped',
      stop_reason: 'none',
      issue: 'none',
      pull_request: 'none',
      gate_level: 'none',
      gate_status: 'not-run',
      proof_status: 'not-run',
      verifier: 'not-run',
      verifier_independent: 'n/a',
      critic: 'not-run',
      human_required: false,
      policy_violations: [],
      attempted: false,
      changed_lines: 0,
      changed_files: 0,
      agent_turns: 0,
      duration_seconds: 0,
      tokens_prompt: 0,
      tokens_completion: 0,
      usage_estimated: false,
      cost_usd: 0,
      llm_calls: 0,
      models_requested: [],
      models_served: [],
      profile,
      factory_version: VERSION,
      learn_signals: [],
    };
  }

  set<K extends keyof RunFields>(k: K, v: RunFields[K]): this {
    this.fields[k] = v;
    return this;
  }

  /** Add a learning signal: one line, no duplicates, at most MAX_SIGNALS per run. */
  signal(kind: 'verifier' | 'gate' | 'slop' | 'refusal', text: string): this {
    const s = `${kind}:${text.replace(/\s+/g, ' ').trim().slice(0, 200)}`;
    if (s.length > kind.length + 1 && !this.fields.learn_signals.includes(s) && this.fields.learn_signals.length < MAX_SIGNALS) this.fields.learn_signals.push(s);
    return this;
  }

  section(title: string, body: string): this {
    this.sections.push({ title, body });
    return this;
  }

  applyUsage(u: UsageTracker): void {
    this.fields.tokens_prompt = u.promptTokens;
    this.fields.tokens_completion = u.completionTokens;
    this.fields.usage_estimated = u.usageEstimated;
    this.fields.cost_usd = u.costUsd;
    this.fields.llm_calls = u.calls.length;
    this.fields.agent_turns = u.turns;
    this.fields.duration_seconds = Math.round((Date.now() - u.startedAt) / 1000);
    this.fields.models_requested = [...new Set(u.calls.map((c) => `${c.provider}:${c.requestedModel}`))];
    this.fields.models_served = [...new Set(u.calls.filter((c) => c.servedModel).map((c) => c.servedModel))];
  }

  render(redactor: Redactor): string {
    const fm = redactor.redactDeep({ ...this.fields, finished_at: this.fields.finished_at ?? new Date().toISOString() });
    let out = `---\n${stringify(fm).trimEnd()}\n---\n\n# ${this.fields.stage} run ${this.fields.run_id}\n`;
    for (const s of this.sections) out += `\n## ${s.title}\n\n${redactor.redact(s.body).trim()}\n`;
    return out;
  }

  /** Write once, atomically (temp file + link); never overwrites. Returns the path written. */
  write(dir: string, redactor: Redactor): string {
    mkdirSync(dir, { recursive: true });
    const tmp = join(dir, `.${this.fields.run_id}.${process.pid}.tmp`);
    writeFileSync(tmp, this.render(redactor));
    try {
      for (let n = 0; n < 100; n++) {
        const path = join(dir, n ? `${this.fields.run_id}-${n}.md` : `${this.fields.run_id}.md`);
        try {
          linkSync(tmp, path); // fails with EEXIST instead of overwriting
          return path;
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        }
      }
      throw new Error('could not find a free run record name');
    } finally {
      rmSync(tmp, { force: true });
    }
  }
}

export function recentRuns(dir: string, limit = 10): Array<{ file: string; fields: Record<string, string> }> {
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.md') && f !== 'README.md')
    .sort()
    .reverse()
    .slice(0, limit);
  return files.map((f) => {
    const text = readFileSync(join(dir, f), 'utf8').replace(/\r\n/g, '\n');
    const fm = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? '';
    const fields: Record<string, string> = {};
    try {
      const parsed = parseYaml(fm) as Record<string, unknown>;
      if (parsed && typeof parsed === 'object') for (const [k, v] of Object.entries(parsed)) fields[k] = Array.isArray(v) ? v.join(',') : String(v);
    } catch {
      fields.status = 'unparseable';
    }
    return { file: f, fields };
  });
}

export function runsToday(dir: string, now = new Date()): number {
  if (!existsSync(dir)) return 0;
  const day = now.toISOString().slice(0, 10);
  return readdirSync(dir).filter((f) => f.startsWith(day) && f.endsWith('.md')).length;
}

/** USD spent by runs that started in the last 24 hours, from their records. */
export function spendLast24h(dir: string, now = Date.now()): number {
  if (!existsSync(dir)) return 0;
  const since = now - 86_400_000;
  const days = new Set([new Date(now).toISOString().slice(0, 10), new Date(since).toISOString().slice(0, 10)]);
  let total = 0;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.md') || !days.has(f.slice(0, 10))) continue;
    const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(readFileSync(join(dir, f), 'utf8'))?.[1];
    if (!fm) continue;
    try {
      const p = parseYaml(fm) as { started_at?: string; cost_usd?: number };
      if (p && Date.parse(String(p.started_at)) >= since && typeof p.cost_usd === 'number') total += p.cost_usd;
    } catch {
      /* an unparseable record is reported by metrics; it does not count here */
    }
  }
  return Math.round(total * 10_000) / 10_000;
}

/** Every parseable record in dir with its front matter (arrays kept), sorted by file name. */
export function readRecordFields(dir: string): Array<Partial<RunFields> & { file: string }> {
  if (!existsSync(dir)) return [];
  const out: Array<Partial<RunFields> & { file: string }> = [];
  for (const f of readdirSync(dir).sort()) {
    if (!f.endsWith('.md') || f === 'README.md') continue;
    const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(readFileSync(join(dir, f), 'utf8'))?.[1];
    if (!fm) continue;
    try {
      const p = parseYaml(fm) as Partial<RunFields>;
      if (p && typeof p === 'object') out.push({ ...p, file: f });
    } catch {
      /* metrics reports unparseable records; analysis skips them */
    }
  }
  return out;
}
