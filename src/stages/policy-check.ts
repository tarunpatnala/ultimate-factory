import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FactoryConfig } from '../config/types.js';
import { parseCharter } from '../policy/charter.js';
import { diffStats } from '../policy/diff.js';
import { formatFindings, scanDiff } from '../policy/slop.js';
import { diffText } from '../policy/diff.js';
import { formatPolicyLine, PolicyEngine, type PolicyResult, type ViolationCode } from '../policy/engine.js';
import { runGit } from '../util/git.js';
import { out } from '../util/output.js';

/** Violations a verified human approval may override. Secret files never are. */
export const OVERRIDABLE: ViolationCode[] = ['load-bearing-path', 'protected-path', 'test-modified', 'too-many-lines', 'too-many-files'];

export interface PolicyCheckOptions {
  cwd: string;
  cfg: FactoryConfig;
  base: string;
  /** GitHub login of a maintainer who approved the current head commit (verified by the caller/workflow). */
  humanApprovedBy?: string;
  json?: boolean;
}

interface Report {
  schema: 'factory-policy/v1';
  status: 'PASS' | 'FAIL' | 'MISCONFIGURED';
  reason?: string;
  violations: Array<{ code: string; path?: string; detail: string; overridden: boolean }>;
  lines: number;
  files: number;
  approved_by?: string;
  problems?: string[];
}

/**
 * Harness-neutral charter enforcement. Needs no LLM and no secrets, so it can run as a required
 * status check on every PR, including fork PRs and PRs written by Claude Code, Codex or humans.
 */
export async function policyCheckCommand(o: PolicyCheckOptions): Promise<number> {
  const fail = (reason: string, problems: string[] = []) => emit(o, { schema: 'factory-policy/v1', status: 'MISCONFIGURED', reason, violations: [], lines: 0, files: 0, problems }, 2);
  if (o.humanApprovedBy !== undefined && !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(o.humanApprovedBy)) return fail('invalid-approver-login');
  const charterPath = join(o.cwd, o.cfg.factory.charter);
  if (!existsSync(charterPath)) return fail('charter-missing');
  const { charter, problems } = parseCharter(readFileSync(charterPath, 'utf8'));
  if (!charter) return fail('charter-invalid', problems);
  if (charter.status !== 'ready') return fail('charter-not-ready');
  if ((await runGit(['rev-parse', '--verify', `${o.base}^{commit}`], { cwd: o.cwd })).code !== 0) return fail('invalid-base', [`cannot resolve base ref ${o.base}`]);
  const mb = await runGit(['merge-base', o.base, 'HEAD'], { cwd: o.cwd });
  // Without a merge base (shallow clone) the diff would include unrelated base commits: fail closed.
  if (mb.code !== 0 || !mb.stdout.trim()) return fail('no-merge-base', ['fetch full history (actions/checkout fetch-depth: 0)']);
  const engine = new PolicyEngine(charter, o.cfg);
  const r: PolicyResult = engine.evaluate(await diffStats(o.cwd, mb.stdout.trim(), [o.cfg.factory.runs_dir]));
  const approved = Boolean(o.humanApprovedBy);
  const violations = r.violations.map((v) => ({ code: v.code, path: v.path, detail: v.detail, overridden: approved && OVERRIDABLE.includes(v.code) }));
  const blocking = violations.filter((v) => !v.overridden);
  // AI-slop is reported, never a policy failure: a human decides on prose and comments.
  if (!o.json && o.cfg.agent.slop !== 'off') {
    const slop = scanDiff(await diffText(o.cwd, mb.stdout.trim()));
    out.write(slop.length ? `AI-slop in added lines (advisory, ${slop.length}):\n${formatFindings(slop)}\n` : 'AI-slop: none in added lines\n');
  }
  return emit(o, { schema: 'factory-policy/v1', status: blocking.length ? 'FAIL' : 'PASS', violations, lines: r.changedLines, files: r.changedFiles, ...(approved ? { approved_by: o.humanApprovedBy } : {}) }, blocking.length ? 1 : 0, r);
}

function emit(o: { json?: boolean }, rep: Report, code: number, r?: PolicyResult): number {
  if (o.json) {
    out.write(JSON.stringify(rep, null, 2) + '\n');
    return code;
  }
  for (const v of rep.violations) out.write(`  - ${v.code}${v.path ? ` ${v.path}` : ''}: ${v.detail}${v.overridden ? ' (overridden by human approval)' : ''}\n`);
  for (const p of rep.problems ?? []) out.write(`  - ${p}\n`);
  const blocking = r ? { ...r, violations: r.violations.filter((v) => !rep.violations.find((x) => x.code === v.code && x.path === v.path)?.overridden) } : undefined;
  const extra = `${rep.reason ? ` reason=${rep.reason}` : ''}${rep.approved_by ? ` approved_by=${rep.approved_by}` : ''}`;
  out.write(formatPolicyLine(rep.status, blocking, extra) + '\n');
  return code;
}
