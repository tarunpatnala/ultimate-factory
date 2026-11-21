import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GateLevel } from '../policy/charter.js';
import type { SandboxConfig } from '../config/types.js';
import { runRepoCode } from '../util/sandbox.js';
import { runGit } from '../util/git.js';

export type GateStatus = 'GREEN' | 'RED' | 'MISCONFIGURED';

export interface GateVerdict {
  level: GateLevel;
  status: GateStatus;
  /** The authenticated FACTORY_GATES line (or a synthesized MISCONFIGURED line). */
  line: string;
  exitCode: number | null;
  reason?: string;
  output: string;
  skipped: string[];
}

const LINE_RE = /^FACTORY_GATES: level=(fast|full|deep) status=(GREEN|RED|MISCONFIGURED) passed=(\d+) failed=(\d+) failing=(\S+) skipped=(\S+) misconfigured=(\S+) nonce=(\S+)\s*$/;

/**
 * Parse gate output. Only the LAST line that starts with FACTORY_GATES: and carries our nonce
 * counts, and its status must agree with the exit code. Anything else is MISCONFIGURED.
 */
export function parseGateOutput(stdout: string, exitCode: number | null, nonce: string, level: GateLevel): Omit<GateVerdict, 'output'> {
  const lines = stdout.split(/\r?\n/).filter((l) => l.startsWith('FACTORY_GATES:'));
  const mine = lines.filter((l) => l.includes(` nonce=${nonce}`));
  const last = mine[mine.length - 1];
  const fail = (reason: string): Omit<GateVerdict, 'output'> => ({
    level,
    status: 'MISCONFIGURED',
    line: `FACTORY_GATES: level=${level} status=MISCONFIGURED passed=0 failed=0 failing=none skipped=none misconfigured=${reason} nonce=${nonce}`,
    exitCode,
    reason,
    skipped: [],
  });
  if (exitCode === null) return fail('timeout');
  if (!last) return fail('no-authentic-verdict-line');
  const m = LINE_RE.exec(last);
  if (!m) return fail('malformed-verdict-line');
  if (m[8] !== nonce) return fail('nonce-mismatch');
  if (m[1] !== level) return fail('level-mismatch');
  const status = m[2] as GateStatus;
  const expected: Record<number, GateStatus> = { 0: 'GREEN', 1: 'RED', 2: 'MISCONFIGURED' };
  if (expected[exitCode] !== status) return fail(`exit-code-${exitCode}-disagrees-with-${status}`);
  return { level, status, line: last, exitCode, skipped: m[6] === 'none' ? [] : m[6]!.split(',') };
}

/**
 * Script text to execute: from the base commit when it exists there (code under test cannot have
 * changed it), else from the working tree. It runs with `bash -c`, so no file on disk exists that
 * a running test could rewrite while bash is still reading it.
 */
async function scriptText(cwd: string, path: string, pristineFrom?: string): Promise<string | undefined> {
  if (pristineFrom) {
    const r = await runGit(['show', `${pristineFrom}:${path}`], { cwd, maxOutput: 2_000_000 });
    if (r.code === 0) return r.stdout;
  }
  const abs = join(cwd, path);
  return existsSync(abs) ? readFileSync(abs, 'utf8') : undefined;
}

export interface GateRunOptions {
  cwd: string;
  script: string;
  level: GateLevel;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  /** Commit to take the gate script and .factory/gates.conf from (pristine copies). */
  pristineFrom?: string;
  gatesConf?: string;
  sandbox?: SandboxConfig;
}

export async function runGates(o: GateRunOptions): Promise<GateVerdict> {
  const nonce = randomBytes(8).toString('hex');
  const text = await scriptText(o.cwd, o.script, o.pristineFrom);
  if (text === undefined) {
    const v = parseGateOutput('', 2, nonce, o.level);
    return { ...v, reason: 'gate-script-missing', line: v.line.replace('no-authentic-verdict-line', 'gate-script-missing'), output: `gate script not found: ${o.script}` };
  }
  const env: NodeJS.ProcessEnv = { ...o.env, FACTORY_GATES_NONCE: nonce, FACTORY_ROOT: o.cwd };
  // With a pristine base, the gate config from that commit is inlined before the script and the
  // worktree copy is ignored (FACTORY_GATES_CONF=/dev/null).
  const conf = o.pristineFrom ? await runGit(['show', `${o.pristineFrom}:${o.gatesConf ?? '.factory/gates.conf'}`], { cwd: o.cwd, maxOutput: 200_000 }) : undefined;
  if (conf) {
    env.FACTORY_GATES_CONF = '/dev/null';
    if (conf.code === 0) env.FACTORY_GATES_CONF_TEXT = conf.stdout;
  }
  const r = await runRepoCode(o.sandbox, 'bash', ['-c', text, 'gates.sh', o.level], { cwd: o.cwd, env, timeoutMs: o.timeoutMs, maxOutput: 20_000 });
  return { ...parseGateOutput(r.stdout, r.timedOut ? null : r.code, nonce, o.level), output: r.output };
}

export type ProofStatus = 'PROVEN' | 'FAILED' | 'MISCONFIGURED' | 'not-run';

export interface ProofResult {
  status: ProofStatus;
  line: string;
  output: string;
}

/**
 * Authenticate the proof verdict: only the last PROOF line carrying our nonce counts, and its
 * status must agree with the exit code (0 PROVEN, 1 FAILED, 2 MISCONFIGURED).
 */
export function parseProofOutput(text: string, exitCode: number | null, nonce: string): Omit<ProofResult, 'output'> {
  const mine = text.split(/\r?\n/).filter((l) => l.startsWith('PROOF: status=') && l.trimEnd().endsWith(` nonce=${nonce}`));
  const last = mine[mine.length - 1];
  const expected: Record<number, ProofStatus> = { 0: 'PROVEN', 1: 'FAILED', 2: 'MISCONFIGURED' };
  const fallback = (reason: string): Omit<ProofResult, 'output'> => {
    const status: ProofStatus = exitCode === 1 ? 'FAILED' : 'MISCONFIGURED';
    return { status, line: `PROOF: status=${status} reason=${reason}` };
  };
  if (exitCode === null) return fallback('timeout');
  if (!last) return fallback(`no-authentic-proof-line-exit-${exitCode}`);
  const status = /^PROOF: status=(\w+)/.exec(last)?.[1] as ProofStatus;
  if (expected[exitCode] !== status) return fallback(`exit-code-${exitCode}-disagrees-with-${status}`);
  return { status, line: last.replace(/ nonce=\S+\s*$/, '') };
}

export async function runProof(o: { cwd: string; script: string; base: string; testPaths: string[]; testCommand: string; env: NodeJS.ProcessEnv; timeoutMs: number; sandbox?: SandboxConfig }): Promise<ProofResult> {
  const text = await scriptText(o.cwd, o.script, o.base);
  if (text === undefined) return { status: 'MISCONFIGURED', line: 'PROOF: status=MISCONFIGURED reason=proof-script-missing', output: '' };
  const nonce = randomBytes(8).toString('hex');
  // "{tests}" in the test command is replaced by the new test files, so only they run in the proof.
  const quoted = o.testPaths.map((p) => `'${p.replace(/'/g, `'\\''`)}'`).join(' ');
  const command = o.testCommand.includes('{tests}') ? o.testCommand.split('{tests}').join(quoted) : o.testCommand;
  const args = ['-c', text, 'prove-test.sh', o.base];
  for (const p of o.testPaths) args.push('--test-path', p);
  args.push('--', 'bash', '-c', command);
  const r = await runRepoCode(o.sandbox, 'bash', args, { cwd: o.cwd, env: { ...o.env, FACTORY_PROOF_NONCE: nonce }, timeoutMs: o.timeoutMs, maxOutput: 20_000 });
  return { ...parseProofOutput(`${r.stdout}\n${r.stderr}`, r.timedOut ? null : r.code, nonce), output: r.output };
}

/** The command used for run_tests and gates: the {tests} placeholder removed so the whole suite runs. */
export function fullTestCommand(cmd: string): string {
  return cmd.split('{tests}').join('').trim();
}
