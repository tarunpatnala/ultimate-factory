import { createHmac, timingSafeEqual } from 'node:crypto';
import type { GateLevel } from '../policy/charter.js';

export const HANDOFF_MARKER = '<!-- factory-handoff:v1 -->';
export const DISPOSITIONS = ['ready-to-implement', 'ready-to-spec', 'needs-info', 'wait-to-implement'] as const;
export type Disposition = (typeof DISPOSITIONS)[number];
const KEYS = ['disposition', 'done_when', 'files_expected', 'load_bearing', 'gate_level', 'confidence', 'triaged_at', 'question', 'blocker', 'notes', 'issue', 'sig'] as const;

export interface Handoff {
  disposition: Disposition;
  done_when?: string;
  files_expected: string[];
  load_bearing: boolean;
  gate_level?: GateLevel;
  confidence?: 'high' | 'medium' | 'low';
  triaged_at?: string;
  question?: string;
  blocker?: string;
  notes?: string;
}

/** HMAC-SHA256 over the handoff's field lines (everything except sig), bound to the issue number. */
export function handoffSignature(fieldLines: string[], key: string): string {
  return createHmac('sha256', key).update(fieldLines.join('\n')).digest('hex');
}

/**
 * Encode a handoff. With `sign`, the block carries the issue number and an HMAC so that only a
 * holder of the key (the factory's triage job) can produce a handoff implement will accept.
 */
export function encodeHandoff(h: Handoff, sign?: { key: string; issue: number }): string {
  const lines = [HANDOFF_MARKER, '```text'];
  const one = (s: string) => s.replace(/\r?\n/g, ' ').replace(/`{3,}/g, "'''").trim();
  lines.push(`disposition: ${h.disposition}`);
  if (h.done_when) lines.push(`done_when: ${one(h.done_when)}`);
  lines.push(`files_expected: ${h.files_expected.map(one).join(', ')}`);
  lines.push(`load_bearing: ${h.load_bearing}`);
  if (h.gate_level) lines.push(`gate_level: ${h.gate_level}`);
  if (h.confidence) lines.push(`confidence: ${h.confidence}`);
  lines.push(`triaged_at: ${h.triaged_at ?? new Date().toISOString()}`);
  if (h.question) lines.push(`question: ${one(h.question)}`);
  if (h.blocker) lines.push(`blocker: ${one(h.blocker)}`);
  if (h.notes) lines.push(`notes: ${one(h.notes)}`);
  if (sign) {
    lines.push(`issue: ${sign.issue}`);
    lines.push(`sig: ${handoffSignature(lines.slice(2), sign.key)}`);
  }
  lines.push('```');
  return lines.join('\n');
}

export interface DecodeResult {
  handoff?: Handoff;
  problems: string[];
}

/**
 * Decode a handoff comment body. Unknown keys are ignored; required keys are enforced for ready
 * items. With `verify`, the signature must be present, match, and name this issue.
 */
export function decodeHandoff(body: string, verify?: { key: string; issue: number }): DecodeResult {
  const problems: string[] = [];
  if (!body.includes(HANDOFF_MARKER)) return { problems: ['missing factory-handoff:v1 marker'] };
  let after = body.slice(body.indexOf(HANDOFF_MARKER) + HANDOFF_MARKER.length);
  // Only the fenced block directly after the marker is the handoff.
  const fenced = /^\s*```text\n([\s\S]*?)\n```/.exec(after);
  if (fenced) after = fenced[1]!;
  const fields: Record<string, string> = {};
  const signed: string[] = [];
  for (const raw of after.split(/\r?\n/)) {
    const m = /^\s*([a-z_]+):\s*(.*)$/.exec(raw);
    if (!m) continue;
    const key = m[1]!;
    if (!(KEYS as readonly string[]).includes(key)) continue;
    if (key in fields) problems.push(`duplicate key ${key}`);
    fields[key] = m[2]!.trim();
    if (key !== 'sig') signed.push(raw);
  }
  if (verify) {
    const want = Buffer.from(handoffSignature(signed, verify.key));
    const got = Buffer.from(fields.sig ?? '');
    if (!fields.sig) problems.push('handoff is not signed (a handoff key is configured)');
    else if (got.length !== want.length || !timingSafeEqual(got, want)) problems.push('handoff signature does not match');
    else if (fields.issue !== String(verify.issue)) problems.push(`signed handoff is for issue ${fields.issue ?? '(none)'}, not #${verify.issue}`);
  }
  const disposition = fields.disposition as Disposition;
  if (!DISPOSITIONS.includes(disposition)) problems.push(`invalid disposition "${fields.disposition ?? ''}"`);
  const gate = fields.gate_level as GateLevel | undefined;
  if (gate !== undefined && !['fast', 'full', 'deep'].includes(gate)) problems.push(`invalid gate_level "${gate}"`);
  const conf = fields.confidence as Handoff['confidence'];
  if (conf !== undefined && !['high', 'medium', 'low'].includes(conf)) problems.push(`invalid confidence "${conf}"`);
  const files = (fields.files_expected ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (disposition === 'ready-to-implement') {
    if (!fields.done_when) problems.push('ready-to-implement handoff is missing done_when');
    if (!files.length) problems.push('ready-to-implement handoff is missing files_expected');
    if (!gate) problems.push('ready-to-implement handoff is missing gate_level');
  }
  if (fields.triaged_at !== undefined && Number.isNaN(Date.parse(fields.triaged_at))) problems.push('triaged_at is not an ISO-8601 timestamp');
  if (problems.length) return { problems };
  return {
    handoff: {
      disposition,
      done_when: fields.done_when,
      files_expected: files,
      load_bearing: fields.load_bearing === 'true',
      gate_level: gate,
      confidence: conf,
      triaged_at: fields.triaged_at,
      question: fields.question,
      blocker: fields.blocker,
      notes: fields.notes,
    },
    problems,
  };
}
