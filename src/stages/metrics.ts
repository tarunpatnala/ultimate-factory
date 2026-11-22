import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { RunContext } from '../context.js';
import { out } from '../util/output.js';

interface Rec {
  stage: string;
  status: string;
  stop_reason: string;
  attempted?: boolean;
  proof_status?: string;
  verifier?: string;
  verifier_independent?: boolean | string;
  pull_request?: number | string;
  cost_usd?: number;
  tokens_prompt?: number;
  tokens_completion?: number;
  usage_estimated?: boolean;
  outcome?: string;
}

function readRecords(dir: string): Rec[] {
  if (!existsSync(dir)) return [];
  const recs: Rec[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.md') || f === 'README.md') continue;
    const text = readFileSync(join(dir, f), 'utf8').replace(/\r\n/g, '\n');
    const fm = /^---\n([\s\S]*?)\n---/.exec(text)?.[1];
    if (!fm) continue;
    try {
      recs.push(parseYaml(fm) as Rec);
    } catch {
      /* skip unparseable */
    }
  }
  return recs;
}

const count = <T extends string>(xs: T[]) => xs.reduce<Record<string, number>>((a, x) => ((a[x] = (a[x] ?? 0) + 1), a), {});
const pct = (n: number, d: number) => (d ? `${((100 * n) / d).toFixed(1)}%` : 'n/a');

/**
 * Factory metrics from run records (and GitHub, when enabled): attempted vs opened vs merged,
 * why runs stop, proof and verifier distributions, and cost per merged PR including failed runs.
 */
export async function metricsCommand(ctx: RunContext, o: { json: boolean }): Promise<number> {
  const recs = readRecords(ctx.path(ctx.cfg.factory.runs_dir));
  const impl = recs.filter((r) => r.stage === 'implement');
  const attempted = impl.filter((r) => r.attempted === true);
  const opened = impl.filter((r) => r.status === 'succeeded' && r.pull_request !== 'none' && r.pull_request !== undefined);
  const totalCost = recs.reduce((s, r) => s + (Number(r.cost_usd) || 0), 0);
  const estimated = recs.filter((r) => r.usage_estimated === true).length;

  let merged: number | undefined;
  let closedUnmerged: number | undefined;
  if (ctx.cfg.github.enabled) {
    try {
      const prs = await ctx.gh.listClosedFactoryPulls(ctx.cfg.github.branch_prefix);
      const ours = new Set(opened.map((r) => Number(r.pull_request)));
      const mine = prs.filter((p) => ours.has(p.number));
      merged = mine.filter((p) => p.merged).length;
      closedUnmerged = mine.filter((p) => !p.merged).length;
    } catch (e) {
      ctx.log.warn(`GitHub outcomes unavailable: ${(e as Error).message}`);
    }
  }

  const m = {
    schema: 'factory-metrics/v1',
    records: recs.length,
    runs_by_stage: count(recs.map((r) => r.stage)),
    implement: {
      runs: impl.length,
      attempted: attempted.length,
      prs_opened: opened.length,
      open_rate_per_attempt: pct(opened.length, attempted.length),
      prs_merged: merged ?? 'unknown (needs GitHub)',
      prs_closed_unmerged: closedUnmerged ?? 'unknown (needs GitHub)',
      merge_rate_per_attempt: merged === undefined ? 'unknown' : pct(merged, attempted.length),
      stop_reasons: count(impl.filter((r) => r.status !== 'succeeded').map((r) => r.stop_reason)),
      proof: count(attempted.map((r) => String(r.proof_status ?? 'not-run'))),
      verifier: count(attempted.map((r) => String(r.verifier ?? 'not-run'))),
      verifier_not_independent: attempted.filter((r) => r.verifier_independent === false).length,
      outcomes_after_merge: count(recs.filter((r) => r.stage === 'outcome' && r.outcome).map((r) => String(r.outcome))),
    },
    cost: {
      total_usd: Math.round(totalCost * 100) / 100,
      per_attempt_usd: attempted.length ? Math.round((totalCost / attempted.length) * 100) / 100 : 'n/a',
      per_merged_pr_usd: merged ? Math.round((totalCost / merged) * 100) / 100 : 'n/a',
      records_with_estimated_tokens: estimated,
    },
    notes: [
      'Rates use attempted runs (work was claimed) as the denominator; no-op runs (queue full, nothing to do) are excluded.',
      'Cost includes every stage and every failed run.',
      'outcomes_after_merge comes from outcome records written by `ufactory tune`: reverts and fix-ups of the same files are detected from git history; label a PR "factory:escaped" for anything else that needed a fix.',
    ],
  };
  out.write(o.json ? JSON.stringify(m, null, 2) + '\n' : renderMetrics(m) + '\n');
  return 0;
}

function renderMetrics(m: any): string {
  const kv = (o: Record<string, unknown>) => Object.entries(o).map(([k, v]) => `  ${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join('\n');
  return `# Factory metrics (${m.records} run records)\n\nruns by stage: ${JSON.stringify(m.runs_by_stage)}\n\nimplement\n${kv(m.implement)}\n\ncost\n${kv(m.cost)}\n\n${m.notes.map((n: string) => `- ${n}`).join('\n')}`;
}
