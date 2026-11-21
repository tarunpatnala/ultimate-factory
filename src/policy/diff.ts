import { runGit } from '../util/git.js';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../util/exec.js';

export interface FileChange {
  path: string;
  oldPath?: string;
  status: 'A' | 'M' | 'D' | 'R' | 'C' | 'T';
  added: number;
  deleted: number;
  binary: boolean;
  untracked: boolean;
}

export interface DiffStats {
  base: string;
  files: FileChange[];
  changedLines: number;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const r = await runGit(args, { cwd, maxOutput: 5_000_000 });
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr.trim()}`);
  return r.stdout;
}

/**
 * Real diff between `base` and the working tree, including staged, unstaged and untracked
 * (non-ignored) files. Renames are detected; deletes are reported.
 */
export async function diffStats(cwd: string, base: string, exclude: string[] = []): Promise<DiffStats> {
  const nameStatus = await git(cwd, ['diff', '--name-status', '-z', '-M', base]);
  const numstat = await git(cwd, ['diff', '--numstat', '-z', '-M', base]);
  const untracked = await git(cwd, ['ls-files', '--others', '--exclude-standard', '-z']);

  const files = new Map<string, FileChange>();
  const ns = nameStatus.split('\0');
  for (let i = 0; i < ns.length; ) {
    const code = ns[i++];
    if (!code) continue;
    const kind = code[0] as FileChange['status'];
    if (kind === 'R' || kind === 'C') {
      const oldPath = ns[i++]!;
      const path = ns[i++]!;
      files.set(path, { path, oldPath, status: kind, added: 0, deleted: 0, binary: false, untracked: false });
    } else {
      const path = ns[i++]!;
      files.set(path, { path, status: kind, added: 0, deleted: 0, binary: false, untracked: false });
    }
  }

  const nm = numstat.split('\0');
  for (let i = 0; i < nm.length; ) {
    const rec = nm[i++];
    if (!rec) continue;
    const parts = rec.split('\t');
    const a = parts[0]!;
    const d = parts[1]!;
    let path = parts[2] ?? '';
    if (path === '') {
      // rename: "a\td\t" followed by old\0new\0
      i++; // old path
      path = nm[i++] ?? '';
    }
    const f = files.get(path);
    if (!f) continue;
    if (a === '-' || d === '-') {
      f.binary = true;
      f.added = 1;
    } else {
      f.added = Number(a);
      f.deleted = Number(d);
    }
  }

  for (const path of untracked.split('\0').filter(Boolean)) {
    if (files.has(path)) continue;
    const { lines, binary } = countLines(join(cwd, path));
    files.set(path, { path, status: 'A', added: lines, deleted: 0, binary, untracked: true });
  }

  const ex = exclude.map((e) => e.replace(/\/+$/, '') + '/');
  const list = [...files.values()].filter((f) => !ex.some((e) => f.path.startsWith(e))).sort((x, y) => x.path.localeCompare(y.path));
  return { base, files: list, changedLines: list.reduce((s, f) => s + f.added + f.deleted, 0) };
}

function countLines(abs: string): { lines: number; binary: boolean } {
  try {
    const st = statSync(abs);
    if (!st.isFile()) return { lines: 1, binary: true };
    const buf = readFileSync(abs);
    if (buf.subarray(0, 8000).includes(0)) return { lines: 1, binary: true };
    const text = buf.toString('utf8');
    if (text.length === 0) return { lines: 0, binary: false };
    const n = text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
    return { lines: n, binary: false };
  } catch {
    return { lines: 1, binary: true };
  }
}

/** Unified diff text (tracked changes + untracked files), capped, for reviewers. */
export async function diffText(cwd: string, base: string, maxChars = 120_000): Promise<string> {
  // intent-to-add is avoided (it mutates the index); untracked files are appended manually.
  const tracked = await git(cwd, ['diff', '-M', base]);
  const untracked = (await git(cwd, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean);
  let out = tracked;
  for (const p of untracked) {
    const { binary } = countLines(join(cwd, p));
    if (binary) {
      out += `\nnew file (binary): ${p}\n`;
      continue;
    }
    const content = readFileSync(join(cwd, p), 'utf8');
    out += `\ndiff --git a/${p} b/${p}\nnew file\n--- /dev/null\n+++ b/${p}\n` + content.split('\n').map((l) => `+${l}`).join('\n') + '\n';
  }
  if (out.length > maxChars) return out.slice(0, maxChars) + `\n[... diff truncated: ${out.length - maxChars} more characters ...]\n`;
  return out;
}
