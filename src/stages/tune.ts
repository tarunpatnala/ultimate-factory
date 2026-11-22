import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunContext } from '../context.js';
import { analyze, renderAnalysis, TUNE_MARKER, type Proposal } from '../learning/analyze.js';
import { readLessons } from '../learning/lessons.js';
import { decideOutcome } from '../learning/outcomes.js';
import { readRecordFields, RunRecord, makeRunId } from '../runs/record.js';
import { runGit } from '../util/git.js';
import { out } from '../util/output.js';

export const TUNE_ISSUE_TITLE = 'Factory: tuning proposals';
const MAX_PR_LOOKUPS = 50;

export const LESSONS_TEMPLATE = `# Factory lessons

Maintainer-approved lessons from earlier factory runs. The implementation agent and the verifier
read the Active section on every run. The agent cannot edit this file, and \`ufactory tune\` only
proposes lessons (in its issue, or in a draft PR you merge).

## Active
`;

/**
 * The learning loop. Records PR outcomes, finds recurring problems in run records and proposes
 * changes. It never edits the charter, gates or lessons in place: proposals go to one GitHub
 * issue, and with --open-pr the proposed lessons go to a draft PR that a human merges or closes.
 */
export async function tuneCommand(ctx: RunContext, o: { days?: number; openPr: boolean }): Promise<number> {
  const cfg = ctx.cfg;
  const runsDir = ctx.path(cfg.factory.runs_dir);
  const days = o.days ?? cfg.learning.window_days;
  const useGithub = cfg.github.enabled;
  let ref: string | undefined;
  let def: string | undefined;
  const notes: string[] = [];

  if (useGithub) {
    def = cfg.github.default_branch ?? (await ctx.gh.defaultBranch());
    const f = await runGit(['fetch', cfg.github.remote, def], { cwd: ctx.root, timeoutMs: 300_000 });
    if (f.code === 0) ref = `${cfg.github.remote}/${def}`;
    else notes.push(`could not fetch ${def}; revert and fix-up detection skipped (${f.stderr.trim().split('\n')[0]})`);
    const written = await recordOutcomes(ctx, runsDir, ref, notes);
    if (written) ctx.log.info(`recorded ${written} PR outcome(s)`);
  } else notes.push('github.enabled is false: PR outcomes are not tracked');

  const records = readRecordFields(runsDir);
  const lessons = readLessons(ctx.root, cfg.learning);
  const analysis = analyze({ records, activeLessonIds: lessons.ids, minOccurrences: cfg.learning.min_occurrences, windowDays: days });

  let prNumber: number | undefined;
  if (o.openPr && useGithub && ref && def) prNumber = await openLessonsPr(ctx, ref, def, analysis.proposals);

  const body = renderAnalysis(analysis, { runId: ctx.runId, lessonsPath: cfg.learning.lessons, prNumber }) + (notes.length ? `\nNotes:\n${notes.map((n) => `- ${n}`).join('\n')}\n` : '');
  out.write(body);

  if (useGithub) {
    const existing = (await ctx.gh.listOpenIssues()).find((i) => i.body.includes(TUNE_MARKER));
    if (existing) await ctx.gh.updateIssueBody(existing.number, body);
    else if (analysis.proposals.length) await ctx.gh.createIssue(TUNE_ISSUE_TITLE, body, ['factory:tune']);
  }
  ctx.record.section('Proposals', analysis.proposals.map((p) => `${p.id} ${p.kind}: ${p.title}`).join('\n') || 'none');
  ctx.finish('succeeded');
  return 0;
}

/** One immutable outcome record per factory PR, written once its outcome is final. */
async function recordOutcomes(ctx: RunContext, runsDir: string, ref: string | undefined, notes: string[]): Promise<number> {
  const records = readRecordFields(runsDir);
  const done = new Set(records.filter((r) => r.stage === 'outcome').map((r) => Number(r.pull_request)));
  const opened = new Map<number, (typeof records)[number]>();
  for (const r of records) if (r.stage === 'implement' && r.status === 'succeeded' && typeof r.pull_request === 'number' && !done.has(r.pull_request)) opened.set(r.pull_request, r);
  let written = 0;
  let looked = 0;
  for (const [pr, run] of opened) {
    if (looked++ >= MAX_PR_LOOKUPS) {
      notes.push(`outcome lookups capped at ${MAX_PR_LOOKUPS}; the rest are checked on the next run`);
      break;
    }
    try {
      const state = await ctx.gh.getPullOutcome(pr);
      if (!ref && state.mergedAt) continue;
      const d = await decideOutcome({ cwd: ctx.root, ref: ref ?? 'HEAD', pr: state, issue: run.issue ?? 'none', windowDays: ctx.cfg.learning.outcome_window_days });
      if (d.outcome === 'open' || d.outcome === 'pending') continue;
      if (d.outcome === 'unknown') {
        notes.push(`PR #${pr}: ${d.evidence.join('; ')}`);
        continue;
      }
      const rec = new RunRecord(makeRunId('outcome', pr), 'outcome', ctx.loaded.profile ?? 'default');
      rec.set('status', 'succeeded').set('pull_request', pr).set('issue', run.issue ?? 'none').set('outcome', d.outcome).set('outcome_evidence', d.evidence).set('source_run', String(run.run_id ?? run.file));
      rec.set('finished_at', new Date().toISOString());
      rec.section('Outcome', `${d.outcome}\n${d.evidence.join('\n')}`);
      rec.write(runsDir, ctx.redactor);
      written++;
    } catch (e) {
      ctx.log.warn(`PR #${pr}: outcome unavailable: ${(e as Error).message}`);
    }
  }
  return written;
}

/** Proposed lessons as one commit on a new branch, built with git plumbing (the checkout is untouched). */
async function openLessonsPr(ctx: RunContext, ref: string, def: string, proposals: Proposal[]): Promise<number | undefined> {
  const path = ctx.cfg.learning.lessons;
  const g = (args: string[], input?: string, env?: NodeJS.ProcessEnv) => runGit(args, { cwd: ctx.root, input, env, timeoutMs: 120_000 });
  const base = (await g(['rev-parse', ref])).stdout.trim();
  const shown = await g(['show', `${base}:${path}`]);
  const current = shown.code === 0 ? shown.stdout : LESSONS_TEMPLATE;
  const fresh = proposals.filter((p) => p.kind === 'lesson' && p.lesson && !current.includes(p.id));
  if (!fresh.length) return undefined;
  const date = new Date().toISOString().slice(0, 10);
  const entries = fresh.map((p) => `### ${p.id}\n\n${p.lesson!.trim()}\n\nEvidence: ${p.evidence[0] ?? 'see the tune issue'} (proposed by ufactory tune on ${date})\n`).join('\n');
  const next = insertIntoActive(current, entries);
  const branch = `${ctx.cfg.github.branch_prefix}tune-${date.replace(/-/g, '')}`;
  if (!ctx.opts.apply) {
    ctx.log.info(`[dry-run] would open a draft PR from ${branch} adding ${fresh.length} lesson(s) to ${path}`);
    return undefined;
  }
  const blob = (await g(['hash-object', '-w', '--stdin'], next)).stdout.trim();
  const dir = mkdtempSync(join(tmpdir(), 'ufactory-tune-'));
  try {
    const env = { ...process.env, GIT_INDEX_FILE: join(dir, 'index') };
    for (const args of [['read-tree', base], ['update-index', '--add', '--cacheinfo', `100644,${blob},${path}`]]) {
      const r = await g(args, undefined, env);
      if (r.code !== 0) throw new Error(`git ${args[0]}: ${r.stderr.trim()}`);
    }
    const tree = (await g(['write-tree'], undefined, env)).stdout.trim();
    const commit = await g(['-c', 'user.name=factory-bot', '-c', 'user.email=factory-bot@users.noreply.github.com', 'commit-tree', tree, '-p', base, '-m', `factory: propose ${fresh.length} lesson(s) from tune\n\n${fresh.map((p) => p.id).join(', ')}`]);
    if (commit.code !== 0) throw new Error(`git commit-tree: ${commit.stderr.trim()}`);
    const push = await g(['push', ctx.cfg.github.remote, `${commit.stdout.trim()}:refs/heads/${branch}`]);
    if (push.code !== 0) {
      ctx.log.warn(`not opening a lessons PR: ${branch} could not be pushed (${push.stderr.trim().split('\n')[0]})`);
      return undefined;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const body = `Lessons proposed by \`ufactory tune\` (\`${ctx.runId}\`) from recurring verifier and gate findings. Each one goes into the Active section of \`${path}\`, which the implementation agent and the verifier read on every run.\n\nDelete any lesson you disagree with before merging. Merging is the approval; closing the PR rejects them all. \`${path}\` is a protected path, so \`factory-policy\` asks for a maintainer's approval and the \`factory:human-approved\` label.\n\n${fresh.map((p) => `- **${p.id}**: ${p.title}`).join('\n')}`;
  return ctx.gh.createPullRequest({ title: `factory: proposed lessons (${date})`, body, head: branch, base: def, draft: true, labels: ['factory:tune'] });
}

export function insertIntoActive(text: string, entries: string): string {
  const t = text.replace(/\r\n/g, '\n');
  const m = /^## Active[ \t]*\n/m.exec(t);
  if (!m) return `${t.trimEnd()}\n\n## Active\n\n${entries}`;
  const start = m.index + m[0].length;
  const nextHeading = t.slice(start).search(/^## /m);
  const end = nextHeading === -1 ? t.length : start + nextHeading;
  const section = t.slice(start, end).trimEnd();
  return `${t.slice(0, start)}${section ? `${section}\n\n` : '\n'}${entries}${end < t.length ? `\n${t.slice(end)}` : ''}`;
}
