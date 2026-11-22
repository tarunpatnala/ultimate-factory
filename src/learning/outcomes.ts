import type { PrOutcome } from '../runs/record.js';
import { runGit } from '../util/git.js';

export interface PullState {
  number: number;
  state: 'open' | 'closed';
  mergedAt?: string;
  mergeCommitSha?: string;
  labels: string[];
}

export interface OutcomeDecision {
  /** A final outcome is written as a record once; open, pending and unknown are re-checked next time. */
  outcome: PrOutcome | 'open' | 'pending' | 'unknown';
  evidence: string[];
}

const FIX_SUBJECT = /\b(fix|fixes|fixed|bug|bugfix|hotfix|regression)\b/i;

/**
 * What happened to a factory PR after it was opened. Revert and fix-up detection reads the
 * default branch's history (`ref`, e.g. origin/main), so it needs a fetch with full history.
 */
export async function decideOutcome(o: { cwd: string; ref: string; pr: PullState; issue: number | 'none'; windowDays: number; now?: number }): Promise<OutcomeDecision> {
  const { pr } = o;
  if (pr.state === 'open') return { outcome: 'open', evidence: [] };
  if (!pr.mergedAt) return { outcome: 'closed-unmerged', evidence: [`PR #${pr.number} was closed without merging`] };
  const sha = pr.mergeCommitSha;
  if (pr.labels.includes('factory:escaped')) return { outcome: 'escaped', evidence: [`PR #${pr.number} is labelled factory:escaped`] };
  if (!sha || (await git(o.cwd, ['cat-file', '-e', `${sha}^{commit}`])).code !== 0) {
    return { outcome: 'unknown', evidence: [`merge commit ${sha ?? '(none)'} is not in local history; fetch the default branch with full history`] };
  }

  const reverts = new Set<string>();
  for (const grep of [`This reverts commit ${sha}`, ...(o.issue !== 'none' ? [`Revert "FQ-${o.issue}:`] : [])]) {
    const r = await git(o.cwd, ['log', '-F', `--grep=${grep}`, '--format=%h %s', `${sha}..${o.ref}`]);
    for (const line of r.stdout.split('\n').filter(Boolean)) reverts.add(line);
  }
  if (reverts.size) return { outcome: 'reverted', evidence: [...reverts].map((l) => `reverted by ${l}`) };

  const mergedMs = Date.parse(pr.mergedAt);
  const windowEnd = mergedMs + o.windowDays * 86_400_000;
  const files = (await git(o.cwd, ['diff', '--name-only', `${sha}^1`, sha])).stdout.split('\n').filter(Boolean);
  if (files.length) {
    const log = await git(o.cwd, ['log', '--format=%h%x09%cI%x09%s', `${sha}..${o.ref}`, '--', ...files]);
    const fixes = log.stdout
      .split('\n')
      .filter(Boolean)
      .map((l) => l.split('\t'))
      .filter(([, date, subject]) => Date.parse(date ?? '') <= windowEnd && FIX_SUBJECT.test(subject ?? ''));
    if (fixes.length) {
      return { outcome: 'fixed-after-merge', evidence: fixes.slice(0, 5).map(([h, date, subject]) => `${h} ${subject} (${Math.max(0, Math.round((Date.parse(date!) - mergedMs) / 86_400_000))} days after merge, same files)`) };
    }
  }
  if ((o.now ?? Date.now()) < windowEnd) return { outcome: 'pending', evidence: [`merged ${pr.mergedAt.slice(0, 10)}; watched until ${new Date(windowEnd).toISOString().slice(0, 10)}`] };
  return { outcome: 'merged-clean', evidence: [`no revert or fix-up of the same files within ${o.windowDays} days of merge`] };
}

function git(cwd: string, args: string[]) {
  return runGit(args, { cwd, maxOutput: 2_000_000, timeoutMs: 120_000 });
}
