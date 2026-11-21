import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runGit } from '../util/git.js';
import type { Logger } from '../util/log.js';

/**
 * Durable run records: a branch (default factory-records) whose root holds one file per run.
 * Written with git plumbing only (hash-object, mktree, commit-tree), so the checkout, index and
 * HEAD are never touched and no repository code runs.
 */
export const RECORDS_BRANCH = 'factory-records';
const NAME = /^\d{4}-\d{2}-\d{2}T\d{6}Z-[\w.-]+\.md$/;

async function g(cwd: string, args: string[], input?: string) {
  return runGit(args, { cwd, input, maxOutput: 5_000_000, timeoutMs: 300_000 });
}

async function remoteTip(cwd: string, remote: string, branch: string): Promise<string | undefined> {
  const f = await g(cwd, ['fetch', '--no-tags', remote, `+refs/heads/${branch}:refs/ufactory/${branch}`]);
  if (f.code !== 0) {
    if (/couldn't find remote ref|not found/i.test(f.stderr)) return undefined;
    throw new Error(`git fetch ${branch}: ${f.stderr.trim()}`);
  }
  return (await g(cwd, ['rev-parse', `refs/ufactory/${branch}`])).stdout.trim() || undefined;
}

async function treeNames(cwd: string, commit: string): Promise<Map<string, string>> {
  const r = await g(cwd, ['ls-tree', commit]);
  const m = new Map<string, string>();
  for (const line of r.stdout.split('\n')) {
    const x = /^\d+ blob ([0-9a-f]+)\t(.+)$/.exec(line);
    if (x) m.set(x[2]!, x[1]!);
  }
  return m;
}

/** Copy records from the branch into runsDir (only the last `days` days; existing files kept). */
export async function pullRecords(o: { cwd: string; remote: string; runsDir: string; branch?: string; days?: number; log: Logger }): Promise<number> {
  const branch = o.branch ?? RECORDS_BRANCH;
  const tip = await remoteTip(o.cwd, o.remote, branch);
  if (!tip) {
    o.log.info(`no ${branch} branch on ${o.remote} yet`);
    return 0;
  }
  const since = new Date(Date.now() - (o.days ?? 31) * 86_400_000).toISOString().slice(0, 10);
  const dir = join(o.cwd, o.runsDir);
  mkdirSync(dir, { recursive: true });
  let n = 0;
  for (const [name, blob] of await treeNames(o.cwd, tip)) {
    if (!NAME.test(name) || name.slice(0, 10) < since || existsSync(join(dir, name))) continue;
    const r = await g(o.cwd, ['cat-file', 'blob', blob]);
    if (r.code !== 0) continue;
    writeFileSync(join(dir, name), r.stdout);
    n++;
  }
  o.log.info(`pulled ${n} run record(s) from ${branch}`);
  return n;
}

/** Add local records missing from the branch as one new commit; retries when another job pushed first. */
export async function pushRecords(o: { cwd: string; remote: string; runsDir: string; branch?: string; apply: boolean; log: Logger }): Promise<number> {
  const branch = o.branch ?? RECORDS_BRANCH;
  const dir = join(o.cwd, o.runsDir);
  const local = existsSync(dir) ? readdirSync(dir).filter((f) => NAME.test(f)).sort() : [];
  for (let attempt = 1; attempt <= 4; attempt++) {
    const tip = await remoteTip(o.cwd, o.remote, branch);
    const tree = tip ? await treeNames(o.cwd, tip) : new Map<string, string>();
    const fresh = local.filter((f) => !tree.has(f));
    if (!fresh.length) {
      o.log.info(`${branch}: nothing new to push`);
      return 0;
    }
    if (!o.apply) {
      o.log.info(`would push ${fresh.length} record(s) to ${branch} (pass --apply)`);
      return fresh.length;
    }
    for (const f of fresh) {
      const h = await g(o.cwd, ['hash-object', '-w', '--', join(dir, f)]);
      if (h.code !== 0) throw new Error(`git hash-object ${f}: ${h.stderr.trim()}`);
      tree.set(f, h.stdout.trim());
    }
    const listing = [...tree.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([name, sha]) => `100644 blob ${sha}\t${name}`).join('\n') + '\n';
    const t = await g(o.cwd, ['mktree'], listing);
    if (t.code !== 0) throw new Error(`git mktree: ${t.stderr.trim()}`);
    const c = await g(o.cwd, ['-c', 'user.name=factory-bot', '-c', 'user.email=factory-bot@users.noreply.github.com', 'commit-tree', t.stdout.trim(), ...(tip ? ['-p', tip] : []), '-m', `records: add ${fresh.length} run record(s)`]);
    if (c.code !== 0) throw new Error(`git commit-tree: ${c.stderr.trim()}`);
    // Non-forced: if another job pushed first the server refuses and we rebuild on its tip.
    const p = await g(o.cwd, ['push', o.remote, `${c.stdout.trim()}:refs/heads/${branch}`]);
    if (p.code === 0) {
      o.log.info(`pushed ${fresh.length} record(s) to ${branch}`);
      return fresh.length;
    }
    if (!/rejected|non-fast-forward|fetch first/i.test(p.stderr)) throw new Error(`git push ${branch}: ${p.stderr.trim()}`);
    o.log.warn(`${branch} moved; retrying (${attempt}/4)`);
  }
  throw new Error(`could not push records to ${branch} after 4 attempts`);
}
