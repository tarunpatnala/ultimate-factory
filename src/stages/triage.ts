import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { RunContext } from '../context.js';
import { chatJson } from '../llm/client.js';
import { DISPOSITIONS, encodeHandoff, HANDOFF_MARKER, type Disposition, type Handoff } from '../github/handoff.js';
import type { Issue } from '../github/gh.js';
import { isUntriaged, setState, type StateLabel } from '../github/queue.js';
import type { Charter, GateLevel } from '../policy/charter.js';
import type { PolicyEngine } from '../policy/engine.js';
import { BudgetExceededError, LlmError } from '../util/errors.js';

export interface TriageModelOutput {
  disposition: Disposition;
  done_when: string;
  files_expected: string[];
  gate_level: GateLevel;
  confidence: 'high' | 'medium' | 'low';
  estimated_changed_lines?: number;
  question?: string;
  blocker?: string;
  notes?: string;
}

export function validateTriage(v: unknown): string | undefined {
  const o = v as Record<string, unknown>;
  if (!o || typeof o !== 'object') return 'not an object';
  if (!DISPOSITIONS.includes(o.disposition as Disposition)) return `disposition must be one of ${DISPOSITIONS.join(', ')}`;
  if (!Array.isArray(o.files_expected)) return 'files_expected must be an array of paths';
  if (!['fast', 'full', 'deep'].includes(String(o.gate_level))) return 'gate_level must be fast, full or deep';
  if (!['high', 'medium', 'low'].includes(String(o.confidence))) return 'confidence must be high, medium or low';
  if (typeof o.done_when !== 'string') return 'done_when must be a string';
  return undefined;
}

/**
 * Code-side overrides. The model proposes; the charter disposes. Returns the final handoff and
 * the list of overrides applied (for the record).
 */
export function applyOverrides(m: TriageModelOutput, charter: Charter, policy: PolicyEngine): { handoff: Handoff; overrides: string[] } {
  const overrides: string[] = [];
  let disposition = m.disposition;
  const files = m.files_expected.map(String).map((s) => s.trim()).filter(Boolean);
  let loadBearing = false;
  for (const f of files) {
    const c = policy.paths.classify(f);
    if (c.loadBearing) loadBearing = true;
    if (disposition === 'ready-to-implement' && (c.loadBearing || c.protected || c.secret)) {
      disposition = 'ready-to-spec';
      overrides.push(`${f} is ${c.loadBearing ? 'load-bearing' : c.protected ? 'protected' : 'secret'}`);
    }
  }
  if (disposition === 'ready-to-implement') {
    if (!m.done_when.trim()) {
      disposition = 'ready-to-spec';
      overrides.push('no checkable done_when');
    } else if (!files.length) {
      disposition = 'ready-to-spec';
      overrides.push('no files_expected');
    } else if (files.length > charter.maxChangedFiles) {
      disposition = 'ready-to-spec';
      overrides.push(`${files.length} files > limit ${charter.maxChangedFiles}`);
    } else if (m.confidence === 'low') {
      disposition = 'ready-to-spec';
      overrides.push('low confidence: bias toward the slower path');
    } else if (typeof m.estimated_changed_lines !== 'number') {
      disposition = 'ready-to-spec';
      overrides.push('no size estimate');
    } else if (m.estimated_changed_lines > charter.maxChangedLines) {
      disposition = 'ready-to-spec';
      overrides.push(`estimated ${m.estimated_changed_lines} lines > limit ${charter.maxChangedLines}`);
    }
  }
  const gate = policy.gateLevel(m.gate_level, { docsOnly: false, touchesLoadBearing: loadBearing });
  const handoff: Handoff = {
    disposition,
    done_when: m.done_when.trim() || undefined,
    files_expected: files,
    load_bearing: loadBearing,
    gate_level: gate,
    confidence: m.confidence,
    triaged_at: new Date().toISOString(),
    question: disposition === 'needs-info' ? m.question || 'What decision or information is needed to proceed?' : undefined,
    blocker: disposition === 'wait-to-implement' ? m.blocker || 'unnamed blocker' : undefined,
    notes: [m.notes, overrides.length ? `charter overrides: ${overrides.join('; ')}` : ''].filter(Boolean).join(' | ') || undefined,
  };
  return { handoff, overrides };
}

const SYSTEM = (charter: Charter, fenceInstruction: string) => `You are the triage stage of a software factory. Classify ONE GitHub issue into exactly one disposition.
Dispositions:
- ready-to-implement: unambiguous, matches an AUTOMATABLE entry, touches no load-bearing path, has a machine-checkable done_when.
- ready-to-spec: real work but scope, product intent or design must be decided by a human first (any NEEDS_SPEC match).
- needs-info: cannot proceed without an answer only a human has (state the question).
- wait-to-implement: valid but blocked on something named (state the blocker).
If unsure whether it is automatable, choose ready-to-spec. Silence in the charter means stop.
done_when must be checkable by a machine or reader (e.g. "tests/test_auth.py::test_expired_token passes and returns 401"), not "bug is fixed".
Charter tier: ${charter.tier}
AUTOMATABLE: ${charter.automatable.join(' | ')}
NEEDS_SPEC: ${charter.needsSpec.join(' | ')}
NEVER_AUTOMATE: ${charter.neverAutomate.join(' | ')}
LOAD_BEARING: ${charter.loadBearing.join(', ')}
Limits: ${charter.maxChangedLines} changed lines, ${charter.maxChangedFiles} files.
${fenceInstruction}
Reply with ONLY JSON: {"disposition":"...","done_when":"...","files_expected":["path"],"gate_level":"fast|full|deep","confidence":"high|medium|low","estimated_changed_lines":0,"question":"","blocker":"","notes":"one line for the next stage"}`;

export async function triageCommand(ctx: RunContext, o: { issue?: number; repoFiles?: string[] }): Promise<number> {
  const charter = ctx.charter;
  const policy = ctx.policy;
  const cfg = ctx.cfg;
  const all = await ctx.gh.listOpenIssues();
  // Never re-triage work that is claimed or waiting on a human review: implement/verify own it.
  const busy = (i: Issue) => i.labels.includes('factory:in-progress') || i.labels.includes('factory:awaiting-review');
  let candidates = o.issue !== undefined ? all.filter((i) => i.number === o.issue && !busy(i)) : all.filter(isUntriaged);
  const untrusted = candidates.filter((i) => !cfg.github.trusted_associations.includes(i.authorAssociation));
  candidates = candidates.filter((i) => cfg.github.trusted_associations.includes(i.authorAssociation));
  const skippedCap = Math.max(0, candidates.length - cfg.github.max_issues_per_triage);
  candidates = candidates.slice(0, cfg.github.max_issues_per_triage);

  const counts: Record<string, number> = {};
  const rows: string[] = [];
  const charterGaps: string[] = [];
  let failures = 0;
  for (const issue of candidates) {
    try {
      // Only comments from trusted authors may shape the classification.
      const comments = (await ctx.gh.listComments(issue.number)).filter((c) => !c.body.includes(HANDOFF_MARKER) && cfg.github.trusted_associations.includes(c.authorAssociation)).slice(-10);
      const text = `#${issue.number} ${issue.title}\n\n${issue.body}\n\n${comments.map((c) => `--- comment by ${c.author} (${c.authorAssociation}) ---\n${c.body}`).join('\n')}`.slice(0, 30_000);
      let model: TriageModelOutput;
      try {
        ({ value: model } = await chatJson<TriageModelOutput>(
          ctx.llm('triage'),
          [
            { role: 'system', content: SYSTEM(charter, ctx.fence.instruction) },
            { role: 'user', content: ctx.fence.wrap(`issue #${issue.number}`, text) },
          ],
          validateTriage,
          `triage/#${issue.number}`,
        ));
      } catch (e) {
        if (e instanceof BudgetExceededError) throw e;
        if (!(e instanceof LlmError) || !/invalid JSON/.test(e.message)) throw e;
        model = { disposition: 'needs-info', done_when: '', files_expected: [], gate_level: 'full', confidence: 'low', question: 'triage-model-invalid-output: a human must triage this issue' };
      }
      const { handoff, overrides } = applyOverrides(model, charter, policy);
      if (/charter (does not|doesn't) cover|not covered/i.test(model.notes ?? '')) charterGaps.push(`#${issue.number}: ${model.notes}`);
      await writeHandoff(ctx, issue, handoff);
      counts[handoff.disposition] = (counts[handoff.disposition] ?? 0) + 1;
      rows.push(`## FQ-${issue.number}: ${issue.title}\n- disposition: ${handoff.disposition}\n- source: ${issue.url}\n- last_triaged: ${handoff.triaged_at?.slice(0, 10)}\n- files_expected: ${handoff.files_expected.join(', ') || 'n/a'}\n- load_bearing: ${handoff.load_bearing}\n- gate_level: ${handoff.gate_level}\n- done_when: ${handoff.done_when ?? 'n/a'}\n- confidence: ${handoff.confidence}\n- notes: ${handoff.notes ?? ''}`);
      ctx.log.info(`#${issue.number} -> ${handoff.disposition}${overrides.length ? ` (overrides: ${overrides.join('; ')})` : ''}`);
    } catch (e) {
      if (e instanceof BudgetExceededError) {
        ctx.record.section('Stop', e.message);
        ctx.finish('stopped', 'budget');
        return 3;
      }
      failures++;
      ctx.log.error(`#${issue.number}: ${(e as Error).message}`);
    }
  }

  if (rows.length && ctx.opts.apply) {
    const p = ctx.path('docs/factory/QUEUE.md');
    if (!existsSync(dirname(p))) mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, mergeQueueSnapshot(existsSync(p) ? readFileSync(p, 'utf8') : '', rows, ctx.runId));
  }
  ctx.record.section(
    'Summary',
    [
      `triaged: ${rows.length}`,
      `by disposition: ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(', ') || 'none'}`,
      `skipped (cap ${cfg.github.max_issues_per_triage}): ${skippedCap}`,
      `skipped (untrusted author): ${untrusted.length}${untrusted.length ? ` (#${untrusted.map((i) => i.number).join(', #')})` : ''}`,
      `failures: ${failures}`,
      `charter gaps: ${charterGaps.length ? '\n' + charterGaps.map((g) => `- ${g}`).join('\n') : 'none'}`,
    ].join('\n'),
  );
  if (!ctx.opts.apply && ctx.gh.planned.length) ctx.record.section('Planned writes (dry run)', ctx.gh.planned.map((p) => `- ${p}`).join('\n'));
  ctx.finish(failures ? 'stopped' : 'succeeded', failures ? 'some-issues-failed' : 'none');
  return failures ? 1 : 0;
}

/** Merge this run's entries into the snapshot by FQ id (a single-issue triage must not wipe the rest). */
export function mergeQueueSnapshot(existing: string, rows: string[], runId: string): string {
  const entries = new Map<string, string>();
  const parse = (text: string) => {
    for (const block of text.split(/\n(?=## FQ-)/)) {
      const m = /^## (FQ-\d+):/.exec(block.trim());
      if (m) entries.set(m[1]!, block.trim());
    }
  };
  parse(existing);
  parse(rows.join('\n'));
  const sorted = [...entries.entries()].sort((a, b) => Number(a[0].slice(3)) - Number(b[0].slice(3))).map(([, v]) => v);
  return `# Factory queue snapshot\n\n<!-- schema: queue-snapshot/v1 -->\nLast updated by \`${runId}\` at ${new Date().toISOString()}. GitHub labels are authoritative; this file is an audit snapshot.\n\n${sorted.join('\n\n')}\n`;
}

async function writeHandoff(ctx: RunContext, issue: Issue, h: Handoff): Promise<void> {
  const label = `factory:${h.disposition}` as StateLabel;
  const key = process.env[ctx.cfg.github.handoff_key_env];
  await ctx.gh.upsertMarkerComment(issue.number, HANDOFF_MARKER, encodeHandoff(h, key ? { key, issue: issue.number } : undefined));
  // Triage never overrides a state owned by an implement run (claimed or awaiting review).
  await setState(ctx.gh, issue, label, { yieldToOwner: true });
}
