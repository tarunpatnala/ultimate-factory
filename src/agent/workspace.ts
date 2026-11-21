import { runGit } from '../util/git.js';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import picomatch from 'picomatch';
import type { PolicyEngine } from '../policy/engine.js';
import { run } from '../util/exec.js';

export class WorkspaceError extends Error {}

interface Snapshot {
  existed: boolean;
  content?: Buffer;
}

/**
 * Path-guarded view of the repository for the agent. All paths are repo-relative POSIX.
 * Rejects absolute paths, "..", .git, symlink escapes, secret reads and protected writes.
 */
export class Workspace {
  readonly root: string;
  private readonly realRoot: string;
  /** First-touch snapshots so any write can be reverted. */
  private readonly snapshots = new Map<string, Snapshot>();

  constructor(
    root: string,
    private readonly policy: PolicyEngine,
    private readonly limits: { maxFileBytes: number; maxFilesListed: number },
  ) {
    this.root = root;
    this.realRoot = realpathSync(root);
  }

  /** Validate and resolve a repo-relative path. */
  resolve(rel: string): { abs: string; rel: string } {
    if (typeof rel !== 'string' || rel.trim() === '') throw new WorkspaceError('path is required');
    const clean = rel.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
    if (isAbsolute(rel) || /^[A-Za-z]:/.test(rel) || clean.startsWith('/')) throw new WorkspaceError('absolute paths are not allowed');
    if (clean.split('/').some((seg) => seg === '..')) throw new WorkspaceError('".." path segments are not allowed');
    if (clean === '.git' || clean.startsWith('.git/')) throw new WorkspaceError('.git is not accessible');
    const abs = clean === '' || clean === '.' ? this.root : join(this.root, clean);
    // Walk up to the nearest existing ancestor and check its real path stays inside the repo.
    let probe = abs;
    while (!existsSync(probe) && probe !== dirname(probe)) probe = dirname(probe);
    const real = realpathSync(probe);
    if (real !== this.realRoot && !real.startsWith(this.realRoot + sep)) throw new WorkspaceError('path resolves outside the repository');
    if (existsSync(abs) && lstatSync(abs).isSymbolicLink()) {
      const target = realpathSync(abs);
      if (target !== this.realRoot && !target.startsWith(this.realRoot + sep)) throw new WorkspaceError('symlink points outside the repository');
    }
    return { abs, rel: clean === '' ? '.' : clean };
  }

  async listFiles(path = '.', glob?: string): Promise<{ files: string[]; truncated: boolean; total: number }> {
    const { rel } = this.resolve(path);
    const all = await this.trackedAndUntracked();
    const prefix = rel === '.' ? '' : rel + '/';
    const matcher = glob ? picomatch(glob, { dot: true }) : undefined;
    const files = all.filter((f) => (prefix === '' || f.startsWith(prefix)) && (!matcher || matcher(f)));
    return { files: files.slice(0, this.limits.maxFilesListed), truncated: files.length > this.limits.maxFilesListed, total: files.length };
  }

  readFile(path: string, startLine?: number, endLine?: number): { path: string; content: string; truncated: boolean; total_lines: number; next_start_line?: number } {
    const { abs, rel } = this.resolve(path);
    const refusal = this.policy.readRefusal(rel);
    if (refusal) throw new WorkspaceError(`read refused: ${refusal}`);
    if (!existsSync(abs) || !statSync(abs).isFile()) throw new WorkspaceError(`not a file: ${rel}`);
    const buf = readFileSync(abs);
    if (buf.subarray(0, 8000).includes(0)) throw new WorkspaceError(`binary file: ${rel}`);
    const lines = buf.toString('utf8').split('\n');
    const s = Math.max(1, startLine ?? 1);
    const e = Math.min(lines.length, endLine ?? lines.length);
    let content = '';
    let last = s - 1;
    for (let i = s; i <= e; i++) {
      const next = `${lines[i - 1]}\n`;
      if (content.length + next.length > this.limits.maxFileBytes) break;
      content += next;
      last = i;
    }
    const truncated = last < e;
    return { path: rel, content, truncated, total_lines: lines.length, ...(truncated ? { next_start_line: last + 1 } : {}) };
  }

  async search(pattern: string, glob?: string, regex = false): Promise<{ matches: Array<{ path: string; line: number; text: string }>; truncated: boolean }> {
    if (!pattern) throw new WorkspaceError('pattern is required');
    let re: RegExp;
    try {
      re = regex ? new RegExp(pattern) : new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    } catch (e) {
      throw new WorkspaceError(`invalid regex: ${(e as Error).message}`);
    }
    const matcher = glob ? picomatch(glob, { dot: true }) : undefined;
    if (regex && (pattern.length > 200 || /(\([^)]*[+*][^)]*\))[+*{]/.test(pattern))) throw new WorkspaceError('regex too complex (nested quantifiers or > 200 chars); simplify it');
    const matches: Array<{ path: string; line: number; text: string }> = [];
    let scanned = 0;
    for (const f of await this.trackedAndUntracked()) {
      if (matcher && !matcher(f)) continue;
      if (this.policy.readRefusal(f)) continue;
      const abs = join(this.root, f);
      let buf: Buffer;
      try {
        // Never follow symlinks: a tracked link to /proc/self/environ or ~/.config must not be read.
        const lst = lstatSync(abs);
        if (lst.isSymbolicLink() || !lst.isFile() || lst.size > 2_000_000) continue;
        scanned += lst.size;
        if (scanned > 50_000_000) return { matches, truncated: true };
        buf = readFileSync(abs);
      } catch {
        continue;
      }
      if (buf.subarray(0, 8000).includes(0)) continue;
      const lines = buf.toString('utf8').split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i]!)) {
          matches.push({ path: f, line: i + 1, text: lines[i]!.slice(0, 300) });
          if (matches.length >= 200) return { matches, truncated: true };
        }
      }
    }
    return { matches, truncated: false };
  }

  /** Paths the gates would see but the commit would not include must never be written. */
  private outOfCommit(rel: string): string | undefined {
    const runs = this.policy.cfg.factory.runs_dir.replace(/\/+$/, '') + '/';
    if (rel.startsWith(runs)) return 'run-records directory';
    const r = spawnSync('git', ['check-ignore', '-q', '--no-index', rel], { cwd: this.root });
    if (r.status === 0) return 'gitignored path (it would affect the gates but not be committed)';
    return undefined;
  }

  writeFile(path: string, content: string): { path: string; bytes: number; created: boolean } {
    const { abs, rel } = this.resolve(path);
    const ignored = this.outOfCommit(rel);
    if (ignored) throw new WorkspaceError(`write refused: ${ignored}`);
    const refusal = this.policy.writeRefusal(rel);
    if (refusal) throw new WorkspaceError(`write refused: ${refusal}`);
    if (typeof content !== 'string') throw new WorkspaceError('content must be a string');
    if (Buffer.byteLength(content) > this.limits.maxFileBytes * 2) throw new WorkspaceError(`content too large (max ${this.limits.maxFileBytes * 2} bytes)`);
    if (existsSync(abs) && !statSync(abs).isFile()) throw new WorkspaceError(`not a file: ${rel}`);
    this.snapshot(rel, abs);
    const created = !existsSync(abs);
    mkdirSync(dirname(abs), { recursive: true });
    // Re-check the parent after mkdir (defends against a symlinked intermediate directory).
    this.resolve(rel);
    writeFileSync(abs, content);
    return { path: rel, bytes: Buffer.byteLength(content), created };
  }

  editFile(path: string, oldText: string, newText: string): { path: string; bytes: number; created: boolean } {
    const { abs, rel } = this.resolve(path);
    if (!existsSync(abs)) throw new WorkspaceError(`not a file: ${rel}`);
    if (!oldText) throw new WorkspaceError('old_text must not be empty');
    const current = readFileSync(abs, 'utf8');
    const count = current.split(oldText).length - 1;
    if (count !== 1) throw new WorkspaceError(`old_text must occur exactly once in ${rel} (found ${count}); include more surrounding lines`);
    return this.writeFile(rel, current.replace(oldText, () => newText));
  }

  /** Revert every path this run touched. */
  revertAll(): string[] {
    const paths = this.touched;
    for (const p of paths) this.revert(p);
    return paths;
  }

  deleteFile(path: string): { path: string; deleted: boolean } {
    const { abs, rel } = this.resolve(path);
    const ignored = this.outOfCommit(rel);
    if (ignored) throw new WorkspaceError(`delete refused: ${ignored}`);
    const refusal = this.policy.writeRefusal(rel);
    if (refusal) throw new WorkspaceError(`delete refused: ${refusal}`);
    if (!existsSync(abs) || !statSync(abs).isFile()) throw new WorkspaceError(`not a file: ${rel}`);
    this.snapshot(rel, abs);
    rmSync(abs);
    return { path: rel, deleted: true };
  }

  /** Revert one path to its first-touch snapshot. */
  revert(rel: string): void {
    const snap = this.snapshots.get(rel);
    if (!snap) return;
    const abs = join(this.root, rel);
    if (snap.existed && snap.content) {
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, snap.content);
    } else if (existsSync(abs)) {
      rmSync(abs);
    }
    this.snapshots.delete(rel);
  }

  /** Paths written or deleted during this run. */
  get touched(): string[] {
    return [...this.snapshots.keys()];
  }

  private snapshot(rel: string, abs: string): void {
    if (this.snapshots.has(rel)) return;
    this.snapshots.set(rel, existsSync(abs) ? { existed: true, content: readFileSync(abs) } : { existed: false });
  }

  private async trackedAndUntracked(): Promise<string[]> {
    const r = await runGit(['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: this.root, maxOutput: 10_000_000 });
    if (r.code !== 0) throw new WorkspaceError(`git ls-files failed: ${r.stderr}`);
    return [...new Set(r.stdout.split('\0').filter(Boolean))].filter((f) => existsSync(join(this.root, f))).sort();
  }

  relative(abs: string): string {
    return relative(this.root, abs).split(sep).join('/');
  }
}
