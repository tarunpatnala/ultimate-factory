import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { run, type ExecOptions, type ExecResult } from './exec.js';

/**
 * Every git call the factory makes disables repository hooks, fsmonitor and replace refs, so code
 * the agent wrote (or a planted .git/hooks/*, refs/replace/*) never runs or takes effect inside
 * the factory's own git process, which holds the GitHub credentials.
 */
export const SAFE_GIT_FLAGS = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '--no-replace-objects'];

let snapshotEnv: NodeJS.ProcessEnv | undefined;

/**
 * Freeze the system + global git configuration as it was when the factory started. Repository
 * code executed later (gates, tests) may rewrite ~/.gitconfig to add a credential helper, a
 * pushInsteadOf redirect or a filter driver; the factory's git never reads those edits.
 * Call once at startup, before any repository code runs.
 */
export function freezeGitConfig(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  if (snapshotEnv) return snapshotEnv;
  const parts: string[] = [];
  for (const scope of ['--system', '--global']) {
    const r = spawnSync('git', ['config', scope, '--list', '--show-origin', '--name-only'], { env, encoding: 'utf8' });
    const origin = /^file:(\S+)/m.exec(r.stdout ?? '')?.[1];
    if (origin) {
      try {
        parts.push(`# frozen copy of ${origin}\n${readFileSync(origin, 'utf8')}`);
      } catch {
        /* unreadable: skip */
      }
    }
  }
  const dir = mkdtempSync(join(tmpdir(), 'ufactory-gitconfig-'));
  const file = join(dir, 'gitconfig');
  writeFileSync(file, parts.join('\n'), { mode: 0o600 });
  snapshotEnv = { GIT_CONFIG_GLOBAL: file, GIT_CONFIG_NOSYSTEM: '1', GIT_NO_REPLACE_OBJECTS: '1', GIT_TERMINAL_PROMPT: '0' };
  return snapshotEnv;
}

export function runGit(args: string[], opts: ExecOptions): Promise<ExecResult> {
  const frozen = snapshotEnv ?? freezeGitConfig(opts.env ?? process.env);
  return run('git', [...SAFE_GIT_FLAGS, ...args], { ...opts, env: { ...(opts.env ?? process.env), ...frozen } });
}
