import { existsSync, readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { PolicyViolationError } from '../util/errors.js';

export const TIERS = ['revival', 'greenfield', 'oss', 'client-production'] as const;
export type Tier = (typeof TIERS)[number];
export type GateLevel = 'fast' | 'full' | 'deep';
export const GATE_ORDER: GateLevel[] = ['fast', 'full', 'deep'];

export interface Charter {
  status: string;
  tier: Tier;
  loadBearing: string[];
  testsAreLoadBearing: boolean;
  automatable: string[];
  needsSpec: string[];
  neverAutomate: string[];
  gates: { default: GateLevel; load_bearing: GateLevel; docs_only: GateLevel };
  stopIf: string[];
  done: string[];
  maxChangedLines: number;
  maxChangedFiles: number;
  maxAwaitingReview: number;
  /** Full text, for prompts. */
  text: string;
}

export interface CharterParseResult {
  charter?: Charter;
  problems: string[];
}

const KNOWN_KEYS = ['LIMITS', 'CHARTER_STATUS', 'TIER', 'LOAD_BEARING', 'TESTS_ARE_LOAD_BEARING', 'AUTOMATABLE', 'NEEDS_SPEC', 'NEVER_AUTOMATE', 'DONE', 'GATES', 'STOP_IF', 'LAST_REVIEWED', 'NEXT_REVIEW'];
const REQUIRED_KEYS = ['CHARTER_STATUS', 'TIER', 'LOAD_BEARING', 'STOP_IF'];

/**
 * Parse the machine-readable fenced blocks of CHARTER.md. Only fenced code blocks whose
 * YAML contains known UPPERCASE keys are read; prose is ignored. Never guesses.
 */
export function parseCharter(text: string): CharterParseResult {
  const problems: string[] = [];
  const merged: Record<string, unknown> = {};
  const fenceRe = /^```[^\n]*\n([\s\S]*?)^```/gm;
  let m: RegExpExecArray | null;
  while ((m = fenceRe.exec(text))) {
    const body = m[1] ?? '';
    if (!KNOWN_KEYS.some((k) => new RegExp(`^${k}:`, 'm').test(body))) continue;
    let parsed: unknown;
    try {
      parsed = parseYaml(body);
    } catch (e) {
      problems.push(`charter block starting "${body.split('\n')[0]}" is not valid YAML: ${(e as Error).message.split('\n')[0]}`);
      continue;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (KNOWN_KEYS.includes(k)) {
        if (k in merged) problems.push(`charter key ${k} is defined more than once`);
        merged[k] = v;
      }
    }
  }
  for (const k of REQUIRED_KEYS) if (!(k in merged)) problems.push(`charter is missing required key ${k}`);

  const status = String(merged.CHARTER_STATUS ?? '').trim();
  const tier = String(merged.TIER ?? '').trim() as Tier;
  if ('TIER' in merged && !TIERS.includes(tier)) problems.push(`TIER must be one of ${TIERS.join(', ')} (got "${tier}")`);

  const list = (k: string): string[] => {
    const v = merged[k];
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v)) {
      problems.push(`charter ${k} must be a list`);
      return [];
    }
    return v.map((x) => String(x).replace(/\s+/g, ' ').trim());
  };
  const loadBearing = list('LOAD_BEARING');
  const stopIf = list('STOP_IF');
  const needsSpec = list('NEEDS_SPEC');

  const gatesRaw = (merged.GATES ?? {}) as Record<string, unknown>;
  const gate = (k: string, def: GateLevel): GateLevel => {
    const v = gatesRaw[k];
    if (v === undefined) return def;
    if (!GATE_ORDER.includes(v as GateLevel)) {
      problems.push(`GATES.${k} must be fast, full or deep`);
      return def;
    }
    return v as GateLevel;
  };

  // Limits: an explicit LIMITS block wins; otherwise the template's prose is parsed.
  // Prose that mentions a limit we cannot read is an error, never a silent default.
  const limitsBlock = (merged.LIMITS ?? {}) as Record<string, unknown>;
  const limit = (key: string, items: string[], re: RegExp, mention: RegExp, def: number): number => {
    const explicit = limitsBlock[key];
    if (explicit !== undefined) {
      const n = Number(explicit);
      if (!Number.isInteger(n) || n < 0) problems.push(`LIMITS.${key} must be a non-negative integer`);
      return n;
    }
    const found = findNumber(items, re);
    if (found !== undefined) return found;
    if (items.some((i) => mention.test(i) && /\d/.test(i))) problems.push(`could not read the ${key} limit from the charter text; add "LIMITS: { ${key}: N }"`);
    return def;
  };
  const tal = merged.TESTS_ARE_LOAD_BEARING;
  const charter: Charter = {
    status,
    tier,
    loadBearing,
    testsAreLoadBearing: tal === undefined ? true : tal === true || String(tal).toLowerCase() === 'true',
    automatable: list('AUTOMATABLE'),
    needsSpec,
    neverAutomate: list('NEVER_AUTOMATE'),
    gates: { default: gate('default', 'full'), load_bearing: gate('load_bearing', 'deep'), docs_only: gate('docs_only', 'fast') },
    stopIf,
    done: list('DONE'),
    maxChangedLines: limit('max_changed_lines', stopIf, /exceed\s+(\d+)\s+changed\s+lines/i, /changed lines/i, 400),
    maxAwaitingReview: limit('max_awaiting_review', stopIf, /more than\s+(\d+)\s+items?\s+are\s+already\s+awaiting/i, /awaiting/i, 3),
    maxChangedFiles: limit('max_changed_files', needsSpec, /more than\s+(\d+)\s+files/i, /\bfiles\b/i, 5),
    text,
  };
  return { charter: problems.length ? undefined : charter, problems };
}

function findNumber(items: string[], re: RegExp): number | undefined {
  for (const it of items) {
    const m = re.exec(it);
    if (m?.[1]) return Number(m[1]);
  }
  return undefined;
}

/** Load and require a ready charter; throws PolicyViolationError (exit 4) otherwise. */
export function requireReadyCharter(path: string): Charter {
  if (!existsSync(path)) throw new PolicyViolationError(`charter-missing: ${path} does not exist. Run "ufactory init".`);
  const { charter, problems } = parseCharter(readFileSync(path, 'utf8'));
  if (!charter) throw new PolicyViolationError(`charter-invalid: ${problems.join('; ')}`);
  if (charter.status !== 'ready') {
    throw new PolicyViolationError(`charter-not-ready: CHARTER_STATUS is "${charter.status}". A human must review ${path} and set CHARTER_STATUS: ready.`);
  }
  return charter;
}

export function maxGate(...levels: GateLevel[]): GateLevel {
  return levels.reduce((a, b) => (GATE_ORDER.indexOf(b) > GATE_ORDER.indexOf(a) ? b : a), 'fast' as GateLevel);
}
