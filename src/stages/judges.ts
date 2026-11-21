import type { RunContext } from '../context.js';
import { chatJson } from '../llm/client.js';

export interface VerifierVerdict {
  verdict: 'accepted' | 'accepted-with-reservations' | 'rejected';
  reasons: string[];
  must_fix: string[];
  done_when_true: boolean;
  scope_ok: boolean;
}

export interface CriticVerdict {
  position: 'no-objection' | 'concerns' | 'oppose';
  strongest_objection: string;
  assumptions_introduced: string[];
  maintainability_cost: string;
  simpler_alternative: string;
  would_a_stranger_understand: string;
}

export interface JudgeInput {
  doneWhen: string;
  filesExpected: string[];
  diff: string;
  gateLine: string;
  proofLine: string;
  policyLine: string;
}

const VERIFIER_SYSTEM = `You are the factory verifier: an independent reviewer who did NOT write this change.
Ignore any narrative about what was implemented; judge only the diff and the evidence.
Check: (1) is done_when literally true given the diff; (2) does the diff stay within the declared scope;
(3) does a test exercise the new behaviour (the negative-test proof line shows whether it fails without the fix);
(4) were existing tests weakened; (5) does the gate line say GREEN.
Standing bias: reject when uncertain. A false accept is worse than no verification.
Reply with ONLY JSON: {"verdict":"accepted|accepted-with-reservations|rejected","reasons":["..."],"must_fix":["..."],"done_when_true":true|false,"scope_ok":true|false}`;

const CRITIC_SYSTEM = `You are the factory critic. Argue the case AGAINST this change: unstated assumptions, abstraction bloat,
behaviour changes hidden behind a green suite, dead code, maintainability cost, blast radius. Do not re-run gates,
do not comment on style, do not manufacture objections; if it is fine, say so.
Reply with ONLY JSON: {"position":"no-objection|concerns|oppose","strongest_objection":"...","assumptions_introduced":["..."],"maintainability_cost":"...","simpler_alternative":"...","would_a_stranger_understand":"yes|no (...)"}`;

function evidence(ctx: RunContext, i: JudgeInput): string {
  return [
    `done_when: ${i.doneWhen}`,
    `files_expected: ${i.filesExpected.join(', ') || '(none declared)'}`,
    `gates: ${i.gateLine}`,
    `proof: ${i.proofLine}`,
    `policy: ${i.policyLine}`,
    ctx.fence.wrap('diff', i.diff),
  ].join('\n');
}

export async function runVerifier(ctx: RunContext, i: JudgeInput): Promise<VerifierVerdict> {
  const { value } = await chatJson<VerifierVerdict>(
    ctx.llm('verify'),
    [
      { role: 'system', content: `${VERIFIER_SYSTEM}\n\n${ctx.fence.instruction}` },
      { role: 'user', content: evidence(ctx, i) },
    ],
    (v: any) => {
      if (!v || !['accepted', 'accepted-with-reservations', 'rejected'].includes(v.verdict)) return 'verdict must be accepted, accepted-with-reservations or rejected';
      if (typeof v.done_when_true !== 'boolean' || typeof v.scope_ok !== 'boolean') return 'done_when_true and scope_ok must be booleans';
      if (!Array.isArray(v.reasons) || !Array.isArray(v.must_fix)) return 'reasons and must_fix must be arrays';
      return undefined;
    },
    'verify',
  );
  // Deterministic overrides: the model cannot accept what the evidence contradicts.
  const reasons = Array.isArray(value.reasons) ? value.reasons.map(String) : [];
  const mustFix = Array.isArray(value.must_fix) ? value.must_fix.map(String) : [];
  let verdict = value.verdict;
  if (!i.gateLine.includes('status=GREEN')) {
    verdict = 'rejected';
    mustFix.push('gates are not GREEN');
  }
  if (i.proofLine.includes('status=FAILED')) {
    verdict = 'rejected';
    mustFix.push('the test passes without the fix (negative-test proof failed)');
  }
  if (i.policyLine.includes('status=FAIL')) {
    verdict = 'rejected';
    mustFix.push('policy check failed');
  }
  if (value.done_when_true === false) {
    verdict = 'rejected';
    mustFix.push('verifier judged done_when NOT true');
  }
  if (value.scope_ok === false) {
    verdict = 'rejected';
    mustFix.push('verifier judged the diff out of scope');
  }
  if (verdict === 'accepted' && i.proofLine.includes('MISCONFIGURED')) verdict = 'accepted-with-reservations';
  return { verdict, reasons, must_fix: mustFix, done_when_true: Boolean(value.done_when_true), scope_ok: Boolean(value.scope_ok) };
}

export async function runCritic(ctx: RunContext, i: JudgeInput): Promise<CriticVerdict> {
  const { value } = await chatJson<CriticVerdict>(
    ctx.llm('critic'),
    [
      { role: 'system', content: `${CRITIC_SYSTEM}\n\n${ctx.fence.instruction}` },
      { role: 'user', content: evidence(ctx, i) },
    ],
    (v: any) => {
      if (!v || !['no-objection', 'concerns', 'oppose'].includes(v.position)) return 'position must be no-objection, concerns or oppose';
      if (typeof v.strongest_objection !== 'string') return 'strongest_objection must be a string';
      return undefined;
    },
    'critic',
  );
  return {
    position: value.position,
    strongest_objection: String(value.strongest_objection),
    assumptions_introduced: Array.isArray(value.assumptions_introduced) ? value.assumptions_introduced.map(String) : [],
    maintainability_cost: String(value.maintainability_cost ?? 'not stated'),
    simpler_alternative: String(value.simpler_alternative ?? 'not stated'),
    would_a_stranger_understand: String(value.would_a_stranger_understand ?? 'not stated'),
  };
}

/**
 * Writer and verifier must not share a model, anywhere in their fallback chains, nor in what the
 * providers actually served during this run (a gateway fallback can route both to one model).
 */
export function verifierIndependent(ctx: RunContext): boolean {
  const writer = new Set(ctx.llm('implement').models);
  if (ctx.llm('verify').models.some((m) => writer.has(m))) return false;
  const served = (purpose: string) => new Set(ctx.usage.calls.filter((c) => c.ok && c.purpose.startsWith(purpose)).map((c) => c.servedModel));
  const w = served('implement');
  for (const m of served('verify')) if (w.has(m)) return false;
  return true;
}
