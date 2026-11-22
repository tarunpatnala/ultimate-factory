import { createHash } from 'node:crypto';
import type { RunFields } from '../runs/record.js';
import { LESSON_ID } from './lessons.js';

export type Rec = Partial<RunFields> & { file: string };

export type ProposalKind = 'tighten' | 'lesson' | 'lesson-not-working' | 'gate' | 'charter' | 'check' | 'loosen-candidate';

export interface Proposal {
  /** Stable across tune runs for the same pattern, so a proposal can be referred to and tracked. */
  id: string;
  kind: ProposalKind;
  title: string;
  evidence: string[];
  action: string;
  /** For kind lesson: the text a maintainer can paste into the lessons file (or merge from the tune PR). */
  lesson?: string;
}

export interface Analysis {
  window: { days: number; since: string };
  summary: {
    records: number;
    implement_attempted: number;
    prs_opened: number;
    verifier_rejections: number;
    stop_reasons: Record<string, number>;
    outcomes: Record<string, number>;
    cost_usd: number;
  };
  proposals: Proposal[];
}

const BAD_OUTCOMES = new Set(['reverted', 'fixed-after-merge', 'escaped']);
/** must_fix lines the runtime adds itself; they duplicate the gate, proof and policy signals. */
const MECHANICAL = /^(gates are not GREEN|policy check failed|the test passes without the fix|PR body claims gates)/i;
const SCOPE_REASONS = new Set(['load-bearing-path', 'protected-path', 'too-many-lines', 'too-many-files', 'test-modified', 'secret-file', 'scope-needs-spec', 'malformed-handoff']);
const LOOSEN_MIN_CLEAN = 10;

const STOP = new Set('the and for with this that are was not does should must when then than into only also any all its from have has but use used using code change changes diff file files test tests line lines add added new missing make made'.split(' '));

function tokens(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(LESSON_ID, ' ')
      .replace(/`[^`]*`|"[^"]*"/g, ' ')
      .replace(/[\w./-]+\.[a-z]{1,5}\b/g, ' ')
      .replace(/[^a-z\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 3 && !STOP.has(w))
      .map((w) => (w.length > 5 ? w.replace(/(ing|ed|es|s)$/, '') : w)),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter || 1);
}

const hid = (prefix: string, s: string) => `${prefix}-${createHash('sha1').update(s).digest('hex').slice(0, 6)}`;

interface Cluster {
  key: Set<string>;
  runs: Set<string>;
  examples: Map<string, number>;
  lessonIds: Set<string>;
}

/**
 * Turn run records and outcome records into tuning proposals. Deterministic: no model call, so
 * the same records always give the same proposals, and text in a record cannot steer the result
 * beyond being quoted as evidence.
 */
export function analyze(o: { records: Rec[]; activeLessonIds: string[]; minOccurrences: number; windowDays: number; now?: number }): Analysis {
  const now = o.now ?? Date.now();
  const sinceMs = now - o.windowDays * 86_400_000;
  const inWindow = o.records.filter((r) => Date.parse(String(r.started_at ?? '')) >= sinceMs);
  const runs = inWindow.filter((r) => r.stage !== 'outcome');
  const outcomes = inWindow.filter((r) => r.stage === 'outcome' && r.outcome);
  const impl = runs.filter((r) => r.stage === 'implement' && r.attempted === true);
  const min = o.minOccurrences;
  const proposals: Proposal[] = [];
  const runId = (r: Rec) => String(r.run_id ?? r.file);
  const byId = new Map(runs.map((r) => [runId(r), r]));

  // 1. Escaped defects first: each one is a gate that let something through.
  for (const r of outcomes.filter((x) => BAD_OUTCOMES.has(String(x.outcome)))) {
    proposals.push({
      id: `T-${r.pull_request}`,
      kind: 'tighten',
      title: `PR #${r.pull_request} (${r.issue === 'none' ? 'no issue' : `issue #${r.issue}`}) was ${r.outcome} after merge`,
      evidence: [...(r.outcome_evidence ?? []), `run ${r.source_run ?? 'unknown'}`],
      action: 'Find which gate should have caught this and tighten it now (a test, a lint rule, a LOAD_BEARING path or a lower limit). Record the change in DECISIONS.md.',
    });
  }

  // 2. Recurring verifier objections become lesson proposals; lessons that keep being broken become gates.
  const clusters: Cluster[] = [];
  const lessonHits = new Map<string, Set<string>>();
  for (const r of runs) {
    for (const s of r.learn_signals ?? []) {
      if (!s.startsWith('verifier:')) continue;
      const text = s.slice('verifier:'.length).trim();
      for (const id of text.match(LESSON_ID) ?? []) (lessonHits.get(id) ?? lessonHits.set(id, new Set()).get(id)!).add(runId(r));
      if (MECHANICAL.test(text)) continue;
      const t = tokens(text);
      if (t.size < 2) continue;
      let best: Cluster | undefined;
      let score = 0;
      for (const c of clusters) {
        const j = jaccard(t, c.key);
        if (j > score) [best, score] = [c, j];
      }
      if (!best || score < 0.5) clusters.push((best = { key: t, runs: new Set(), examples: new Map(), lessonIds: new Set() }));
      best.runs.add(runId(r));
      best.examples.set(text, (best.examples.get(text) ?? 0) + 1);
    }
  }
  for (const c of clusters.filter((x) => x.runs.size >= min).sort((a, b) => b.runs.size - a.runs.size)) {
    const example = [...c.examples.entries()].sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)[0]![0];
    const id = hid('L', [...c.key].sort().join(' '));
    const evidence = [`${c.runs.size} runs: ${[...c.runs].slice(0, 5).join(', ')}${c.runs.size > 5 ? ', ...' : ''}`, ...[...c.examples.keys()].slice(0, 3).map((e) => `verifier: "${e}"`)];
    if (o.activeLessonIds.includes(id)) {
      // Judge a lesson only by runs whose models were given it; objections from before it was accepted are why it exists.
      const since = [...c.runs].filter((rid) => byId.get(rid)?.lessons_active?.includes(id));
      if (since.length >= min) proposals.push({ id, kind: 'lesson-not-working', title: `Lesson ${id} is active but the verifier still raised it in ${since.length} runs that had the lesson`, evidence: [`${since.length} runs: ${since.slice(0, 5).join(', ')}${since.length > 5 ? ', ...' : ''}`, ...evidence.slice(1)], action: 'Reword the lesson so it is concrete, or replace it with a deterministic check (lint rule, test helper, gate).' });
    } else {
      proposals.push({ id, kind: 'lesson', title: `The verifier asked for the same fix in ${c.runs.size} runs`, evidence, action: `Accept by merging the lesson into the Active section of the lessons file. Reword it as an instruction that holds for any issue first.${c.runs.size >= 2 * min ? ' At this frequency, also consider a deterministic check instead.' : ''}`, lesson: `Recurring verifier objection; check the diff for it before calling finish: ${example}` });
    }
  }
  for (const [id, hits] of lessonHits) {
    if (hits.size >= min && o.activeLessonIds.includes(id) && !proposals.some((p) => p.id === id)) {
      proposals.push({ id: `G-${id.slice(2)}`, kind: 'gate', title: `The verifier rejected ${hits.size} diffs for breaking lesson ${id}`, evidence: [`runs: ${[...hits].slice(0, 5).join(', ')}`], action: `The implementer keeps missing ${id}. Turn it into a lint rule, test or gate so it fails before the verifier runs.` });
    }
  }

  // 3. Repeated mechanical failures: gates, AI-slop rules, policy refusals.
  const byKind = (kind: string) => {
    const m = new Map<string, Set<string>>();
    for (const r of runs) for (const s of r.learn_signals ?? []) if (s.startsWith(`${kind}:`)) (m.get(s.slice(kind.length + 1)) ?? m.set(s.slice(kind.length + 1), new Set()).get(s.slice(kind.length + 1))!).add(runId(r));
    return [...m.entries()].filter(([, v]) => v.size >= min).sort((a, b) => b[1].size - a[1].size);
  };
  for (const [gate, ids] of byKind('gate')) {
    proposals.push({ id: hid('C', `gate ${gate}`), kind: 'check', title: `The ${gate} gate failed at finish in ${ids.size} runs`, evidence: [`runs: ${[...ids].slice(0, 5).join(', ')}`], action: `Read the gate output in those records. If the failures share a cause, add a lesson naming it; if the gate is flaky, fix the gate. Never loosen the gate to pass.` });
  }
  for (const [rule, ids] of byKind('slop')) {
    proposals.push({ id: hid('L', `slop ${rule}`), kind: 'lesson', title: `The AI-slop check refused "${rule}" in ${ids.size} runs`, evidence: [`runs: ${[...ids].slice(0, 5).join(', ')}`], action: 'Accept to tell the implementer up front, which saves a refused finish per run.', lesson: `Do not write ${rule} in comments or docs; the AI-slop check refuses finish for it.` });
  }
  const scope = new Map<string, Set<string>>();
  for (const [code, ids] of byKind('refusal')) scope.set(code, new Set(ids));
  for (const r of impl) if (SCOPE_REASONS.has(String(r.stop_reason))) (scope.get(String(r.stop_reason)) ?? scope.set(String(r.stop_reason), new Set()).get(String(r.stop_reason))!).add(runId(r));
  for (const [code, ids] of [...scope.entries()].filter(([, v]) => v.size >= min)) {
    if (code === 'test-modified') {
      // The agent editing existing tests is model behaviour, not a triage problem.
      proposals.push({ id: hid('L', 'refusal test-modified'), kind: 'lesson', title: `The agent tried to modify an existing test in ${ids.size} runs`, evidence: [`runs: ${[...ids].slice(0, 5).join(', ')}`], action: 'Accept to tell the implementer up front; the runtime already refuses the write. If the items genuinely need test changes, they are not automatable: route them to a human in triage.', lesson: 'Never edit or relax an existing test file, even when it looks wrong; the runtime refuses the write. Add a new test file instead, or give_up if the item needs an existing test changed.' });
      continue;
    }
    proposals.push({ id: hid('S', `scope ${code}`), kind: 'charter', title: `${ids.size} runs hit "${code}"`, evidence: [`runs: ${[...ids].slice(0, 5).join(', ')}`], action: 'Triage is sending items the charter does not allow. Narrow AUTOMATABLE or add the paths to the triage rules in the charter; do not widen the charter to fit the items.' });
  }
  const proofFailed = impl.filter((r) => r.stop_reason === 'proof-failed');
  if (proofFailed.length >= min) {
    proposals.push({ id: hid('L', 'proof-failed'), kind: 'lesson', title: `${proofFailed.length} runs stopped because the new test passed without the fix`, evidence: [`runs: ${proofFailed.slice(0, 5).map(runId).join(', ')}`], action: 'Accept to tell the implementer how the proof works.', lesson: 'Write the new test against the behaviour the issue describes and check that it fails on the current code before writing the fix; the negative-test proof runs it without the fix.' });
  }

  // 4. Loosening is only ever a candidate for a human decision, never automatic.
  const clean = outcomes.filter((r) => r.outcome === 'merged-clean').length;
  const bad = outcomes.filter((r) => BAD_OUTCOMES.has(String(r.outcome))).length;
  if (clean >= LOOSEN_MIN_CLEAN && bad === 0) {
    proposals.push({ id: hid('R', `loosen ${o.windowDays}`), kind: 'loosen-candidate', title: `${clean} merged factory PRs in ${o.windowDays} days, none reverted or fixed afterwards`, evidence: [`outcomes: ${clean} merged-clean, 0 reverted, 0 fixed-after-merge, 0 escaped`], action: 'The evidence supports reviewing whether a limit or the AUTOMATABLE list can widen for the classes of change that merged. A human decides, edits the charter and records the decision in DECISIONS.md.' });
  }

  const count = (xs: string[]) => xs.reduce<Record<string, number>>((a, x) => ((a[x] = (a[x] ?? 0) + 1), a), {});
  return {
    window: { days: o.windowDays, since: new Date(sinceMs).toISOString().slice(0, 10) },
    summary: {
      records: inWindow.length,
      implement_attempted: impl.length,
      prs_opened: impl.filter((r) => r.status === 'succeeded' && typeof r.pull_request === 'number').length,
      verifier_rejections: runs.filter((r) => (r.learn_signals ?? []).some((s) => s.startsWith('verifier:'))).length,
      stop_reasons: count(impl.filter((r) => r.status !== 'succeeded').map((r) => String(r.stop_reason))),
      outcomes: count(outcomes.map((r) => String(r.outcome))),
      cost_usd: Math.round(runs.reduce((s, r) => s + (Number(r.cost_usd) || 0), 0) * 100) / 100,
    },
    proposals,
  };
}

export const TUNE_MARKER = '<!-- factory-tune:v1 -->';

export function renderAnalysis(a: Analysis, o: { runId: string; lessonsPath: string; prNumber?: number }): string {
  const order: ProposalKind[] = ['tighten', 'gate', 'lesson-not-working', 'lesson', 'check', 'charter', 'loosen-candidate'];
  const sorted = [...a.proposals].sort((x, y) => order.indexOf(x.kind) - order.indexOf(y.kind));
  const s = a.summary;
  const lines = [
    TUNE_MARKER,
    `## Factory tuning proposals`,
    '',
    `Window: last ${a.window.days} days (since ${a.window.since}). Generated by \`ufactory tune\` (\`${o.runId}\`). Nothing here changes the factory until a human acts on it.`,
    '',
    `| Measure | Value |`,
    `|---|---|`,
    `| Records | ${s.records} |`,
    `| Implement runs that claimed work | ${s.implement_attempted} |`,
    `| PRs opened | ${s.prs_opened} |`,
    `| Runs with a verifier rejection | ${s.verifier_rejections} |`,
    `| PR outcomes | ${Object.entries(s.outcomes).map(([k, v]) => `${k} ${v}`).join(', ') || 'none final yet'} |`,
    `| Stop reasons | ${Object.entries(s.stop_reasons).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'} |`,
    `| Cost | $${s.cost_usd} |`,
    '',
  ];
  if (!sorted.length) lines.push('No pattern reached the reporting threshold (`learning.min_occurrences`). Nothing to change.');
  for (const p of sorted) {
    lines.push(`### ${p.id} · ${p.kind}: ${p.title}`, '', ...p.evidence.map((e) => `- ${e.replace(/\n/g, ' ').slice(0, 300)}`), '', `**Action:** ${p.action}`);
    if (p.lesson) lines.push('', 'Lesson text:', '', '```markdown', `### ${p.id}`, p.lesson.replace(/```/g, "'''"), '```');
    lines.push('');
  }
  if (o.prNumber) lines.push(`Proposed lessons are in draft PR #${o.prNumber} against \`${o.lessonsPath}\`. Delete the ones you reject before merging; merging is the approval.`);
  else if (sorted.some((p) => p.lesson)) lines.push(`To accept a lesson, add it under \`## Active\` in \`${o.lessonsPath}\` (or run \`ufactory tune --apply --open-pr\` for a draft PR).`);
  return lines.join('\n') + '\n';
}
