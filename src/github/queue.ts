import { runGit } from '../util/git.js';
import { run } from '../util/exec.js';
import type { Logger } from '../util/log.js';
import type { GitHub, Issue } from './gh.js';

export const STATE_LABELS = [
  'factory:ready-to-implement',
  'factory:ready-to-spec',
  'factory:needs-info',
  'factory:wait-to-implement',
  'factory:in-progress',
  'factory:awaiting-review',
] as const;
export type StateLabel = (typeof STATE_LABELS)[number];
export const PROVENANCE_LABEL = 'factory:monitor';
export const PR_LABELS = ['factory:verified', 'factory:rejected'] as const;

export const LABEL_SPECS: Array<{ name: string; color: string; description: string }> = [
  { name: 'factory:ready-to-implement', color: '0e8a16', description: 'Eligible for an unattended implementation run' },
  { name: 'factory:ready-to-spec', color: 'fbca04', description: 'Needs human-guided spec decisions first' },
  { name: 'factory:needs-info', color: 'd93f0b', description: 'Blocked on a named question for a human' },
  { name: 'factory:wait-to-implement', color: 'c5def5', description: 'Understood but blocked on a named dependency' },
  { name: 'factory:in-progress', color: '1d76db', description: 'Claimed by one implementation run' },
  { name: 'factory:awaiting-review', color: '5319e7', description: 'PR open; a human owns the next decision' },
  { name: 'factory:monitor', color: 'bfdadc', description: 'Filed by the factory monitor' },
  { name: 'factory:verified', color: '0e8a16', description: 'Factory verification accepted this PR' },
  { name: 'factory:rejected', color: 'b60205', description: 'Factory verification rejected this PR' },
  { name: 'factory:tune', color: 'c2e0c6', description: 'Tuning proposals from ufactory tune; a human decides' },
  { name: 'factory:escaped', color: 'b60205', description: 'A merged factory PR that later needed a fix (set by a human)' },
];

export function stateOf(issue: Pick<Issue, 'labels'>): StateLabel | undefined {
  const states = issue.labels.filter((l): l is StateLabel => (STATE_LABELS as readonly string[]).includes(l));
  return states[0];
}

export function isUntriaged(issue: Pick<Issue, 'labels'>): boolean {
  return !issue.labels.some((l) => (STATE_LABELS as readonly string[]).includes(l));
}

/** States owned by the implement run that claimed the issue; only that run moves them. */
export const OWNED_STATES: readonly StateLabel[] = ['factory:in-progress', 'factory:awaiting-review'];

/**
 * Move an issue to exactly one state label, preserving provenance and non-factory labels.
 * GitHub has no transactional label update, so concurrent writers are resolved by ownership:
 * with `yieldToOwner` (triage), the write is skipped when an implement-owned state is present
 * before the write, and undone when one appears during it. Returns false when it yielded.
 */
export async function setState(gh: GitHub, issue: Pick<Issue, 'number' | 'labels'>, next: StateLabel, o: { yieldToOwner?: boolean } = {}): Promise<boolean> {
  const live = async (fallback: string[]) => (gh.apply ? ((await gh.getIssue(issue.number).catch(() => undefined))?.labels ?? fallback) : fallback);
  // Re-read live labels before writing: the caller's copy may be stale (e.g. after a claim).
  let labels = await live(issue.labels);
  const owned = (ls: string[]) => ls.find((l) => (OWNED_STATES as readonly string[]).includes(l) && l !== next);
  if (o.yieldToOwner && owned(labels)) return false;
  // Add first, then remove: a failure in between never leaves the issue without a state label.
  if (!labels.includes(next)) await gh.addLabels(issue.number, [next]);
  for (const l of labels) {
    if ((STATE_LABELS as readonly string[]).includes(l) && l !== next) await gh.removeLabel(issue.number, l);
  }
  if (!gh.apply) return true;
  // Read back: another writer may have added a state label between our read and our writes.
  labels = await live(labels);
  const extra = labels.filter((l) => (STATE_LABELS as readonly string[]).includes(l) && l !== next);
  if (!extra.length) return true;
  if (o.yieldToOwner && owned(labels)) {
    await gh.removeLabel(issue.number, next);
    return false;
  }
  for (const l of extra) await gh.removeLabel(issue.number, l);
  return true;
}

/**
 * Decisions pending a human: issues labeled awaiting-review plus open factory PRs
 * (head <prefix>fq-<n>), deduplicated by issue number.
 */
export function awaitingReviewCount(issues: Issue[], prHeads: string[] = [], branchPrefix = 'factory/'): number {
  const ids = new Set<number>(issues.filter((i) => i.labels.includes('factory:awaiting-review')).map((i) => i.number));
  const re = new RegExp(`^${branchPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}fq-(\\d+)$`);
  for (const h of prHeads) {
    const m = re.exec(h);
    if (m) ids.add(Number(m[1]));
  }
  return ids.size;
}

// ---------------------------------------------------------------------------
// Deterministic claim via a Git ref
// ---------------------------------------------------------------------------

export interface Claim {
  branch: string;
  claimSha: string;
  remote: string;
  pushed: boolean;
}

async function git(cwd: string, args: string[], allowFail = false): Promise<{ code: number | null; out: string; err: string }> {
  const r = await runGit(args, { cwd, maxOutput: 200_000, timeoutMs: 300_000 });
  if (r.code !== 0 && !allowFail) throw new Error(`git ${args.join(' ')} failed: ${r.stderr.trim()}`);
  return { code: r.code, out: r.stdout.trim(), err: r.stderr.trim() };
}

/** Clean apart from paths under `ignore` (run records are written by every run). */
export async function isCleanTree(cwd: string, ignore: string[] = []): Promise<boolean> {
  const r = await git(cwd, ['status', '--porcelain', '--untracked-files=all']);
  const ex = ignore.map((e) => e.replace(/\/+$/, '') + '/');
  return r.out
    .split('\n')
    .filter(Boolean)
    .map((l) => l.slice(3))
    .filter((p) => !ex.some((e) => p.startsWith(e))).length === 0;
}

export async function headSha(cwd: string): Promise<string> {
  return (await git(cwd, ['rev-parse', 'HEAD'])).out;
}

/**
 * Claim issue N. With `push`, the first non-forced push of refs/heads/<branch> wins.
 * Returns undefined when another run already owns the claim.
 */
export async function claimIssue(o: { cwd: string; remote: string; baseRef: string; branch: string; runId: string; issue: number; push: boolean; log: Logger }): Promise<Claim | undefined> {
  if (o.push) {
    const remote = await git(o.cwd, ['ls-remote', '--heads', o.remote, `refs/heads/${o.branch}`], true);
    if (remote.code !== 0) throw new Error(`cannot reach remote ${o.remote}: ${remote.err.split('\n')[0]}`);
    if (remote.out) {
      o.log.info(`${o.branch} already exists on ${o.remote}; issue is claimed by another run`);
      return undefined;
    }
  }
  const exists = await git(o.cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${o.branch}`], true);
  if (exists.code === 0) {
    if (o.push) {
      // stale local branch from an earlier run on this machine; the remote is authoritative
      await git(o.cwd, ['branch', '-D', o.branch], true);
    } else {
      o.log.warn(`local branch ${o.branch} already exists; treating issue as claimed`);
      return undefined;
    }
  }
  await git(o.cwd, ['switch', '-c', o.branch, o.baseRef]);
  await git(o.cwd, ['commit', '--allow-empty', '-m', `factory: claim FQ-${o.issue} (${o.runId}) at ${new Date().toISOString()}`]);
  const claimSha = await headSha(o.cwd);
  if (!o.push) return { branch: o.branch, claimSha, remote: o.remote, pushed: false };
  const r = await git(o.cwd, ['push', o.remote, `HEAD:refs/heads/${o.branch}`], true);
  if (r.code !== 0) {
    await git(o.cwd, ['switch', '--detach', o.baseRef], true);
    await git(o.cwd, ['branch', '-D', o.branch], true);
    if (/rejected|non-fast-forward|fetch first|already exists|stale info/i.test(r.err)) {
      o.log.warn(`claim push rejected for ${o.branch}: another run won`);
      return undefined;
    }
    throw new Error(`claim push failed (not a race): ${r.err.split('\n')[0]}`);
  }
  return { branch: o.branch, claimSha, remote: o.remote, pushed: true };
}

/** Release a claim only if the remote branch still points at our claim commit. */
export async function releaseClaim(cwd: string, claim: Claim, log: Logger): Promise<boolean> {
  if (!claim.pushed) return false;
  const r = await git(cwd, ['ls-remote', claim.remote, `refs/heads/${claim.branch}`], true);
  const remoteSha = r.out.split(/\s+/)[0];
  if (remoteSha !== claim.claimSha) {
    log.warn(`not releasing ${claim.branch}: remote tip ${remoteSha ?? '(none)'} is not our claim commit`);
    return false;
  }
  // Compare-and-delete: the server refuses if the branch moved since our check.
  const d = await git(cwd, ['push', `--force-with-lease=refs/heads/${claim.branch}:${claim.claimSha}`, claim.remote, `:refs/heads/${claim.branch}`], true);
  return d.code === 0;
}
