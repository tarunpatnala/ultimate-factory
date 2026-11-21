import { spawn } from 'node:child_process';

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Combined output, tail-capped. */
  output: string;
}

export interface ExecOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  input?: string;
  maxOutput?: number;
  shell?: boolean;
}

const SAFE_ENV_EXACT = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'TMPDIR', 'TMP', 'TEMP',
  'CI', 'TZ', 'PWD', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'WINDIR', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE',
  'PROGRAMFILES', 'NODE_ENV', 'GOPATH', 'GOROOT', 'GOCACHE', 'CARGO_HOME', 'RUSTUP_HOME', 'JAVA_HOME',
  'PYTHONPATH', 'VIRTUAL_ENV', 'PNPM_HOME', 'NVM_DIR', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'NO_COLOR', 'FORCE_COLOR',
]);
const SECRETISH = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|COOKIE|SESSION/i;

/**
 * Build an environment for running repository code (gates, tests, allowlisted commands).
 * Allowlist-based: only known-safe variables pass, never anything secret-looking, never the
 * configured LLM / GitHub secrets, plus explicit non-secret passthrough names.
 */
export function scrubbedEnv(secretEnvNames: string[], passthrough: string[] = [], src: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const deny = new Set(secretEnvNames);
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(src)) {
    if (v === undefined) continue;
    if (deny.has(k) || SECRETISH.test(k)) continue;
    if (SAFE_ENV_EXACT.has(k) || passthrough.includes(k) || k.startsWith('LC_') || k.startsWith('npm_config_')) out[k] = v;
  }
  return out;
}

const live = new Set<number>();

/** Kill every process group we started (used on SIGTERM so gate children are not orphaned). */
export function killAllChildren(): void {
  for (const pid of live) {
    try {
      process.kill(process.platform === 'win32' ? pid : -pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
  live.clear();
}

export function run(cmd: string, args: string[], opts: ExecOptions): Promise<ExecResult> {
  const max = opts.maxOutput ?? 20_000;
  return new Promise((resolve) => {
    const posix = process.platform !== 'win32';
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      shell: opts.shell ?? false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      // Own process group so a timeout kills grandchildren (npm -> node -> ...) too.
      detached: posix,
    });
    if (child.pid) live.add(child.pid);
    let settled = false;
    const finish = (r: ExecResult) => {
      if (child.pid) live.delete(child.pid);
      if (settled) return;
      settled = true;
      resolve(r);
    };
    let stdout = '';
    let stderr = '';
    let combined = '';
    let timedOut = false;
    const cap = (s: string) => (s.length > max * 4 ? s.slice(-max * 4) : s);
    child.stdout.on('data', (d: Buffer) => {
      const t = d.toString();
      stdout = cap(stdout + t);
      combined = cap(combined + t);
    });
    child.stderr.on('data', (d: Buffer) => {
      const t = d.toString();
      stderr = cap(stderr + t);
      combined = cap(combined + t);
    });
    const killTree = () => {
      try {
        if (posix && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    };
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          killTree();
          // If an orphan still holds the pipes, do not wait for 'close' forever.
          setTimeout(() => finish({ code: null, stdout, stderr, timedOut: true, output: tail(combined, max) }), 5_000).unref();
        }, opts.timeoutMs)
      : undefined;
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      finish({ code: 127, stdout, stderr: stderr + String(err), timedOut, output: tail(combined + String(err), max) });
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      finish({ code: timedOut ? null : code, stdout, stderr, timedOut, output: tail(combined, max) });
    });
    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}

export function tail(s: string, max: number): string {
  if (s.length <= max) return s;
  return `[... ${s.length - max} earlier characters truncated ...]\n` + s.slice(-max);
}
