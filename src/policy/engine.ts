import type { FactoryConfig } from '../config/types.js';
import { type Charter, type GateLevel, maxGate } from './charter.js';
import type { DiffStats, FileChange } from './diff.js';
import { PathPolicy } from './paths.js';

export type ViolationCode = 'protected-path' | 'load-bearing-path' | 'test-modified' | 'too-many-lines' | 'too-many-files' | 'secret-file';

export interface Violation {
  code: ViolationCode;
  path?: string;
  detail: string;
}

export interface PolicyResult {
  violations: Violation[];
  changedLines: number;
  changedFiles: number;
  docsOnly: boolean;
  touchesLoadBearing: boolean;
  modifiesTests: boolean;
  files: Array<{ path: string }>;
}

export class PolicyEngine {
  readonly paths: PathPolicy;
  constructor(
    readonly charter: Charter,
    readonly cfg: FactoryConfig,
  ) {
    this.paths = new PathPolicy(charter, cfg);
  }

  /** Evaluate a real diff against the charter. */
  evaluate(diff: DiffStats, opts: { allowLoadBearing?: boolean } = {}): PolicyResult {
    const v: Violation[] = [];
    let docsOnly = diff.files.length > 0;
    let touchesLoadBearing = false;
    let modifiesTests = false;
    for (const f of diff.files) {
      const paths = [f.path, ...(f.oldPath ? [f.oldPath] : [])];
      for (const p of paths) {
        const c = this.paths.classify(p);
        if (!c.doc) docsOnly = false;
        if (c.secret) v.push({ code: 'secret-file', path: p, detail: 'secret-like file changed' });
        if (c.protected) v.push({ code: 'protected-path', path: p, detail: 'factory-protected path changed' });
        if (c.loadBearing) {
          touchesLoadBearing = true;
          if (!opts.allowLoadBearing) v.push({ code: 'load-bearing-path', path: p, detail: 'charter LOAD_BEARING path changed' });
        }
        if (c.test && this.isExistingTestChange(f, p)) {
          modifiesTests = true;
          if (this.charter.testsAreLoadBearing) v.push({ code: 'test-modified', path: p, detail: `existing test file ${describe(f)}` });
        }
      }
    }
    if (diff.changedLines > this.charter.maxChangedLines) {
      v.push({ code: 'too-many-lines', detail: `${diff.changedLines} changed lines > limit ${this.charter.maxChangedLines}` });
    }
    if (diff.files.length > this.charter.maxChangedFiles) {
      v.push({ code: 'too-many-files', detail: `${diff.files.length} changed files > limit ${this.charter.maxChangedFiles}` });
    }
    return { violations: dedupe(v), changedLines: diff.changedLines, changedFiles: diff.files.length, docsOnly, touchesLoadBearing, modifiesTests, files: diff.files.map((f) => ({ path: f.path })) };
  }

  private isExistingTestChange(f: FileChange, p: string): boolean {
    if (f.status === 'A') return false; // new test files are allowed
    if (f.status === 'R' || f.status === 'C') return p === f.oldPath || f.status === 'R';
    return true; // M, D, T
  }

  /** Can a single path be written by the agent? Returns a refusal reason or undefined. */
  writeRefusal(path: string): string | undefined {
    const c = this.paths.classify(path);
    if (c.secret) return 'secret file';
    if (c.protected) return 'protected path (factory policy, build manifest or test-runner config)';
    if (c.loadBearing) return 'load-bearing path (charter LOAD_BEARING); this item needs a spec and a human';
    return undefined;
  }

  readRefusal(path: string): string | undefined {
    return this.paths.classify(path).secret ? 'secret file' : undefined;
  }

  /** Required gate level after tier and change-type effects. */
  gateLevel(requested: GateLevel | undefined, result?: Pick<PolicyResult, 'docsOnly' | 'touchesLoadBearing'>): GateLevel {
    const g = this.charter.gates;
    // The model may raise the gate level, never lower it below the charter default.
    let level: GateLevel = maxGate(requested ?? g.default, g.default);
    if (result?.docsOnly) level = maxGate(requested ?? g.docs_only, g.docs_only);
    if (result?.touchesLoadBearing) level = maxGate(level, g.load_bearing);
    if (this.charter.tier === 'client-production') level = maxGate(level, 'full');
    return level;
  }

  /** Must the PR be opened as draft? */
  draftReasons(result: PolicyResult, extra: string[] = []): string[] {
    const reasons = [...extra];
    if (this.charter.tier === 'client-production') reasons.push('tier client-production: every PR is draft');
    if (this.charter.tier === 'oss' && !result.docsOnly) reasons.push('tier oss: non-doc change');
    if (result.touchesLoadBearing) reasons.push('touches a load-bearing path');
    if (result.modifiesTests) reasons.push('modifies an existing test');
    return reasons;
  }

  criticRequired(result: Pick<PolicyResult, 'touchesLoadBearing'>): boolean {
    return result.touchesLoadBearing || this.charter.tier === 'client-production';
  }
}

function describe(f: FileChange): string {
  switch (f.status) {
    case 'D':
      return 'deleted';
    case 'R':
      return `renamed from ${f.oldPath}`;
    default:
      return 'modified';
  }
}

function dedupe(v: Violation[]): Violation[] {
  const seen = new Set<string>();
  return v.filter((x) => {
    const k = `${x.code}|${x.path ?? ''}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export function formatPolicyLine(status: 'PASS' | 'FAIL' | 'MISCONFIGURED', r?: PolicyResult, extra = ''): string {
  const codes = r ? [...new Set(r.violations.map((x) => x.code))] : [];
  return `FACTORY_POLICY: v=1 status=${status} violations=${codes.length ? codes.join(',') : 'none'} lines=${r?.changedLines ?? 0} files=${r?.changedFiles ?? 0}${extra}`;
}
