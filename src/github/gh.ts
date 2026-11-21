import { FactoryError } from '../util/errors.js';
import { run } from '../util/exec.js';
import type { Logger } from '../util/log.js';

export interface Issue {
  number: number;
  title: string;
  body: string;
  labels: string[];
  author: string;
  authorAssociation: string;
  createdAt: string;
  updatedAt: string;
  url: string;
  isPullRequest: boolean;
}

export interface Comment {
  id: number;
  body: string;
  author: string;
  authorAssociation: string;
  createdAt: string;
}

export interface PullRequest {
  number: number;
  title: string;
  body: string;
  labels: string[];
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  isFork: boolean;
  draft: boolean;
  url: string;
}

/**
 * Thin `gh` wrapper. Reads always execute; writes execute only when `apply` is true and are
 * otherwise recorded in `planned` for a dry-run report.
 */
export class GitHub {
  readonly planned: string[] = [];
  private readonly bin: string;
  private me?: string;

  constructor(
    readonly cwd: string,
    readonly apply: boolean,
    private readonly log: Logger,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {
    this.bin = env.UFACTORY_GH_BIN || 'gh';
  }

  private async gh(args: string[], input?: string, retryable = false): Promise<string> {
    const attempts = retryable ? 4 : 1;
    let last = '';
    for (let i = 1; i <= attempts; i++) {
      const r = await run(this.bin, args, { cwd: this.cwd, env: this.env, input, maxOutput: 5_000_000, timeoutMs: 120_000 });
      if (r.code === 0) return r.stdout;
      last = (r.stderr || r.stdout).trim().slice(0, 500);
      const transient = /HTTP 5\d\d|HTTP 429|rate limit|timeout|ECONNRESET|EAI_AGAIN|connection reset/i.test(last);
      if (!transient || i === attempts) break;
      this.log.warn(`gh transient error, retry ${i}/${attempts - 1}: ${last.split('\n')[0]}`);
      await new Promise((res) => setTimeout(res, 1000 * 2 ** i));
    }
    throw new FactoryError(`gh ${args.slice(0, 4).join(' ')} failed: ${last}`, 'GITHUB', 5);
  }

  private async api<T>(path: string, method = 'GET', fields: Record<string, string | string[] | boolean> = {}): Promise<T> {
    const args = ['api', '-X', method, path, '-H', 'Accept: application/vnd.github+json'];
    for (const [k, v] of Object.entries(fields)) {
      if (Array.isArray(v)) for (const x of v) args.push('-f', `${k}[]=${x}`);
      else if (typeof v === 'boolean') args.push('-F', `${k}=${v}`);
      else args.push('-f', `${k}=${v}`);
    }
    const out = await this.gh(args, undefined, method === 'GET');
    return (out.trim() ? JSON.parse(out) : {}) as T;
  }

  private async write(description: string, fn: () => Promise<unknown>): Promise<void> {
    if (!this.apply) {
      this.planned.push(description);
      this.log.info(`[dry-run] ${description}`);
      return;
    }
    this.log.info(`github: ${description}`);
    await fn();
  }

  async available(): Promise<{ ok: boolean; detail: string }> {
    const r = await run(this.bin, ['auth', 'status'], { cwd: this.cwd, env: this.env, timeoutMs: 30_000 });
    return { ok: r.code === 0, detail: (r.stdout + r.stderr).trim().split('\n').slice(0, 3).join(' ') };
  }

  /**
   * The identity whose handoff comments implement trusts. In GitHub Actions the default token
   * cannot call GET /user and posts as github-actions[bot]; override with UFACTORY_BOT_LOGIN
   * when a GitHub App or PAT is used.
   */
  async botLogin(): Promise<string> {
    if (this.env.UFACTORY_BOT_LOGIN) return this.env.UFACTORY_BOT_LOGIN;
    if (this.env.GITHUB_ACTIONS === 'true') return 'github-actions[bot]';
    return this.login().catch(() => '');
  }

  async login(): Promise<string> {
    if (!this.me) this.me = String((await this.api<{ login: string }>('user')).login);
    return this.me;
  }

  async listOpenIssues(maxPages = 10): Promise<Issue[]> {
    const out: Issue[] = [];
    for (let page = 1; page <= maxPages; page++) {
      const batch = await this.api<any[]>(`repos/{owner}/{repo}/issues?state=open&per_page=100&page=${page}&sort=updated&direction=desc`);
      for (const i of batch) out.push(toIssue(i));
      if (batch.length < 100) break;
    }
    return out.filter((i) => !i.isPullRequest);
  }

  async getIssue(n: number): Promise<Issue> {
    return toIssue(await this.api<any>(`repos/{owner}/{repo}/issues/${n}`));
  }

  async listComments(n: number): Promise<Comment[]> {
    const raw: any[] = [];
    for (let page = 1; page <= 10; page++) {
      const batch = await this.api<any[]>(`repos/{owner}/{repo}/issues/${n}/comments?per_page=100&page=${page}`);
      raw.push(...batch);
      if (batch.length < 100) break;
    }
    return raw.map((c) => ({ id: c.id, body: String(c.body ?? ''), author: c.user?.login ?? '', authorAssociation: String(c.author_association ?? 'NONE'), createdAt: c.created_at }));
  }

  async addLabels(n: number, labels: string[]): Promise<void> {
    if (!labels.length) return;
    await this.write(`#${n} add labels ${labels.join(', ')}`, () => this.api(`repos/{owner}/{repo}/issues/${n}/labels`, 'POST', { labels }));
  }

  async removeLabel(n: number, label: string): Promise<void> {
    await this.write(`#${n} remove label ${label}`, async () => {
      try {
        await this.api(`repos/{owner}/{repo}/issues/${n}/labels/${encodeURIComponent(label)}`, 'DELETE');
      } catch (e) {
        if (!/404|Label does not exist/i.test((e as Error).message)) throw e;
      }
    });
  }

  /** Create or update the single comment containing `marker` written by the authenticated user. */
  async upsertMarkerComment(n: number, marker: string, body: string): Promise<void> {
    const existing = (await this.listComments(n)).filter((c) => c.body.includes(marker));
    const me = this.apply ? await this.botLogin() : '';
    const mine = existing.find((c) => (me ? c.author === me : ['OWNER', 'MEMBER'].includes(c.authorAssociation)));
    if (mine) await this.write(`#${n} update ${marker} comment`, () => this.api(`repos/{owner}/{repo}/issues/comments/${mine.id}`, 'PATCH', { body }));
    else await this.write(`#${n} add ${marker} comment`, () => this.api(`repos/{owner}/{repo}/issues/${n}/comments`, 'POST', { body }));
  }

  async comment(n: number, body: string): Promise<void> {
    await this.write(`#${n} comment: ${body.split('\n')[0]!.slice(0, 80)}`, () => this.api(`repos/{owner}/{repo}/issues/${n}/comments`, 'POST', { body }));
  }

  async createIssue(title: string, body: string, labels: string[]): Promise<number | undefined> {
    let num: number | undefined;
    await this.write(`create issue "${title}" [${labels.join(', ')}]`, async () => {
      const r = await this.api<{ number: number }>('repos/{owner}/{repo}/issues', 'POST', { title, body, labels });
      num = r.number;
    });
    return num;
  }

  async searchOpenIssueByTitle(title: string): Promise<Issue | undefined> {
    return (await this.listOpenIssues(2)).find((i) => i.title.trim().toLowerCase() === title.trim().toLowerCase());
  }

  async createPullRequest(o: { title: string; body: string; head: string; base: string; draft: boolean; labels?: string[] }): Promise<number | undefined> {
    let num: number | undefined;
    await this.write(`open ${o.draft ? 'draft ' : ''}PR ${o.head} -> ${o.base}: ${o.title}`, async () => {
      // Idempotent: reuse an open PR for the same head (e.g. a retried run).
      const existing = (await this.listOpenPullRequests()).find((p) => p.headRef === o.head);
      if (existing) num = existing.number;
      else num = (await this.api<{ number: number }>('repos/{owner}/{repo}/pulls', 'POST', { title: o.title, body: o.body, head: o.head, base: o.base, draft: o.draft })).number;
      if (o.labels?.length) {
        try {
          await this.api(`repos/{owner}/{repo}/issues/${num}/labels`, 'POST', { labels: o.labels });
        } catch (e) {
          this.log.warn(`PR #${num} opened but labeling failed: ${(e as Error).message}`);
        }
      }
    });
    return num;
  }

  async getPullRequest(n: number): Promise<PullRequest> {
    const p = await this.api<any>(`repos/{owner}/{repo}/pulls/${n}`);
    return {
      number: p.number,
      title: p.title ?? '',
      body: p.body ?? '',
      labels: (p.labels ?? []).map((l: any) => l.name),
      headRef: p.head?.ref,
      headSha: p.head?.sha,
      baseRef: p.base?.ref,
      baseSha: p.base?.sha,
      isFork: Boolean(p.head?.repo?.full_name && p.base?.repo?.full_name && p.head.repo.full_name !== p.base.repo.full_name),
      draft: Boolean(p.draft),
      url: p.html_url ?? '',
    };
  }

  async listOpenPullRequests(): Promise<PullRequest[]> {
    const raw = await this.api<any[]>('repos/{owner}/{repo}/pulls?state=open&per_page=100');
    return raw.map((p) => ({
      number: p.number,
      title: p.title ?? '',
      body: p.body ?? '',
      labels: (p.labels ?? []).map((l: any) => l.name),
      headRef: p.head?.ref,
      headSha: p.head?.sha,
      baseRef: p.base?.ref,
      baseSha: p.base?.sha,
      isFork: Boolean(p.head?.repo?.full_name && p.base?.repo?.full_name && p.head.repo.full_name !== p.base.repo.full_name),
      draft: Boolean(p.draft),
      url: p.html_url ?? '',
    }));
  }

  /** Closed PRs whose head is a factory claim branch (most recent 300). */
  async listClosedFactoryPulls(prefix: string): Promise<Array<{ number: number; merged: boolean }>> {
    const res: Array<{ number: number; merged: boolean }> = [];
    for (let page = 1; page <= 3; page++) {
      const batch = await this.api<any[]>(`repos/{owner}/{repo}/pulls?state=closed&per_page=100&page=${page}`);
      for (const p of batch) if (String(p.head?.ref ?? '').startsWith(`${prefix}fq-`)) res.push({ number: p.number, merged: Boolean(p.merged_at) });
      if (batch.length < 100) break;
    }
    return res;
  }

  async ensureLabel(name: string, color: string, description: string): Promise<void> {
    await this.write(`ensure label ${name}`, () => this.gh(['label', 'create', name, '--color', color, '--description', description, '--force']));
  }

  async defaultBranch(): Promise<string> {
    const r = await this.api<{ default_branch: string }>('repos/{owner}/{repo}');
    return r.default_branch;
  }
}

function toIssue(i: any): Issue {
  return {
    number: i.number,
    title: String(i.title ?? ''),
    body: String(i.body ?? ''),
    labels: (i.labels ?? []).map((l: any) => (typeof l === 'string' ? l : l.name)),
    author: i.user?.login ?? '',
    authorAssociation: String(i.author_association ?? 'NONE').toUpperCase(),
    createdAt: i.created_at,
    updatedAt: i.updated_at,
    url: i.html_url ?? '',
    isPullRequest: Boolean(i.pull_request),
  };
}
