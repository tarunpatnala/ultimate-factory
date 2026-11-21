import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import type { SandboxConfig } from '../config/types.js';
import { run, type ExecOptions, type ExecResult } from './exec.js';

/** Host-specific variables that must not leak into a container (the image sets its own). */
const HOST_ONLY = new Set(['PATH', 'HOME', 'SHELL', 'TMPDIR', 'TMP', 'TEMP', 'USER', 'LOGNAME', 'PWD']);
/** Variables the container client itself needs to reach the daemon. */
const CLIENT_ENV = ['PATH', 'HOME', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'DOCKER_CERT_PATH', 'DOCKER_TLS_VERIFY', 'CONTAINER_HOST', 'XDG_RUNTIME_DIR'];

const containers = new Set<string>();

/**
 * Run repository code (gates, tests, allowlisted commands, the proof). With a sandbox the command
 * runs in a throwaway container: its own PID namespace (the factory's environment and tokens are
 * not readable through /proc), no network by default, no capabilities, the repository mounted at
 * the same path, and only the scrubbed variables passed in.
 */
export async function runRepoCode(sandbox: SandboxConfig | undefined, cmd: string, args: string[], opts: ExecOptions): Promise<ExecResult> {
  if (!sandbox || sandbox.mode === 'none') return run(cmd, args, opts);
  const name = `ufactory-${randomBytes(6).toString('hex')}`;
  const env = opts.env ?? {};
  const pass = Object.keys(env).filter((k) => !HOST_ONLY.has(k) && env[k] !== undefined);
  const user = typeof process.getuid === 'function' ? [`--user`, `${process.getuid()}:${process.getgid?.() ?? process.getuid()}`] : [];
  const dockerArgs = [
    'run', '--rm', '-i', '--name', name,
    '--network', sandbox.network,
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '1024',
    ...user,
    '-v', `${opts.cwd}:${opts.cwd}`, '-w', opts.cwd,
    '-e', 'HOME=/tmp',
    ...pass.flatMap((k) => ['-e', k]),
    sandbox.image!, cmd, ...args,
  ];
  // Values travel through the client's environment, never through argv.
  const clientEnv: NodeJS.ProcessEnv = {};
  for (const k of pass) clientEnv[k] = env[k];
  for (const k of CLIENT_ENV) if (process.env[k] !== undefined) clientEnv[k] = process.env[k];
  containers.add(name);
  try {
    const r = await run(sandbox.mode, dockerArgs, { ...opts, env: clientEnv });
    // A killed client can leave its container running.
    if (r.timedOut) removeContainer(sandbox.mode, name);
    return r;
  } finally {
    containers.delete(name);
  }
}

function removeContainer(bin: string, name: string): void {
  spawnSync(bin, ['rm', '-f', name], { stdio: 'ignore', timeout: 15_000 });
}

/** Stop every container started by this process (signal handler). */
export function removeAllContainers(sandbox: SandboxConfig | undefined): void {
  if (!sandbox || sandbox.mode === 'none') return;
  for (const n of containers) removeContainer(sandbox.mode, n);
  containers.clear();
}
