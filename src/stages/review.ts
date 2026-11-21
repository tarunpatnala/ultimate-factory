import { out } from '../util/output.js';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { RunContext } from '../context.js';
import { chatJson } from '../llm/client.js';
import { getPersona, personaSystemPrompt, type Persona } from '../personas/personas.js';
import { diffText } from '../policy/diff.js';
import { ConfigError } from '../util/errors.js';
import { run } from '../util/exec.js';

export type PersonaVerdict = 'approve' | 'approve-with-nits' | 'request-changes' | 'block' | 'error';
export type Severity = 'blocker' | 'major' | 'minor' | 'nit';

export interface Finding {
  severity: Severity;
  file?: string | null;
  line?: number | null;
  title: string;
  detail: string;
  fix: string;
  persona: string;
}

export interface PersonaReview {
  persona: string;
  title: string;
  model: string;
  verdict: PersonaVerdict;
  score?: number;
  summary: string;
  findings: Finding[];
  error?: string;
}

export interface PanelResult {
  aggregate: 'approve' | 'approve-with-nits' | 'request-changes' | 'block' | 'incomplete';
  reviews: PersonaReview[];
  mustFix: Finding[];
  minor: Finding[];
}

const VERDICTS = ['approve', 'approve-with-nits', 'request-changes', 'block'];
const SEVERITIES = ['blocker', 'major', 'minor', 'nit'];

export function validatePersonaOutput(v: unknown): string | undefined {
  if (!v || typeof v !== 'object') return 'not an object';
  const o = v as Record<string, unknown>;
  if (!VERDICTS.includes(String(o.verdict))) return `verdict must be one of ${VERDICTS.join(', ')}`;
  if (!Array.isArray(o.findings)) return 'findings must be an array';
  for (const f of o.findings as unknown[]) {
    const ff = f as Record<string, unknown>;
    if (!ff || typeof ff !== 'object') return 'each finding must be an object';
    if (!SEVERITIES.includes(String(ff.severity))) return `finding severity must be one of ${SEVERITIES.join(', ')}`;
    if (!ff.title) return 'finding title is required';
  }
  return undefined;
}

/**
 * Combine persona verdicts. A "block" needs `blockQuorum` independent blocks: with a large panel,
 * "any block blocks" turns each persona's false-positive rate into a panel-wide one. Fewer blocks
 * still count as request-changes, so a lone block never becomes an approval.
 */
export function aggregate(reviews: PersonaReview[], blockQuorum = 1): PanelResult {
  const ok = reviews.filter((r) => r.verdict !== 'error');
  const errored = reviews.length - ok.length;
  const all = ok.flatMap((r) => r.findings);
  const mustFix = dedupeFindings(all.filter((f) => f.severity === 'blocker' || f.severity === 'major'));
  const minor = dedupeFindings(all.filter((f) => f.severity === 'minor' || f.severity === 'nit'));
  let agg: PanelResult['aggregate'];
  if (reviews.length === 0 || errored / reviews.length > 0.3) agg = 'incomplete';
  else if (ok.filter((r) => r.verdict === 'block').length >= Math.min(blockQuorum, ok.length)) agg = 'block';
  else if (ok.some((r) => r.verdict === 'request-changes' || r.verdict === 'block') || mustFix.length) agg = 'request-changes';
  else if (ok.some((r) => r.verdict === 'approve-with-nits') || minor.length) agg = 'approve-with-nits';
  else agg = 'approve';
  return { aggregate: agg, reviews, mustFix, minor };
}

function dedupeFindings(fs: Finding[]): Finding[] {
  const map = new Map<string, Finding>();
  const rank = (s: Severity) => SEVERITIES.indexOf(s);
  for (const f of fs) {
    const key = `${(f.file ?? '').toLowerCase()}|${f.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()}`;
    const prev = map.get(key);
    if (!prev) map.set(key, { ...f });
    else {
      if (rank(f.severity) < rank(prev.severity)) prev.severity = f.severity;
      if (!prev.persona.split(', ').includes(f.persona)) prev.persona += `, ${f.persona}`;
    }
  }
  return [...map.values()].sort((a, b) => rank(a.severity) - rank(b.severity));
}

export async function runPanel(ctx: RunContext, subjectLabel: string, subject: string, personaIds: string[]): Promise<PanelResult> {
  const personas: Persona[] = personaIds.map((id) => {
    const p = getPersona(id);
    if (!p) throw new ConfigError(`unknown review persona "${id}"`);
    return p;
  });
  const reviews: PersonaReview[] = new Array(personas.length);
  let next = 0;
  const worker = async () => {
    while (next < personas.length) {
      const i = next++;
      const p = personas[i]!;
      const llm = ctx.llm('review', p.id);
      try {
        const { value } = await chatJson<any>(
          llm,
          [
            { role: 'system', content: personaSystemPrompt(p, ctx.fence.instruction) },
            { role: 'user', content: `Review this ${subjectLabel}.\n\n${ctx.fence.wrap(subjectLabel, subject)}` },
          ],
          validatePersonaOutput,
          `review/${p.id}`,
        );
        reviews[i] = {
          persona: p.id,
          title: p.title,
          model: llm.label,
          verdict: value.verdict,
          score: typeof value.score === 'number' ? value.score : undefined,
          summary: String(value.summary ?? ''),
          findings: (value.findings as any[]).map((f) => ({
            severity: f.severity,
            file: f.file ?? null,
            line: typeof f.line === 'number' ? f.line : null,
            title: String(f.title),
            detail: String(f.detail ?? ''),
            fix: String(f.fix ?? ''),
            persona: p.id,
          })),
        };
        ctx.log.info(`  ${p.id}: ${value.verdict}`);
      } catch (e) {
        reviews[i] = { persona: p.id, title: p.title, model: llm.label, verdict: 'error', summary: '', findings: [], error: ctx.redactor.redact((e as Error).message) };
        ctx.log.warn(`  ${p.id}: error ${(e as Error).message}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(ctx.cfg.review.concurrency, personas.length) }, worker));
  return aggregate(reviews, ctx.cfg.review.block_quorum);
}

export const PANEL_MARKER = '<!-- factory-review-panel:v1 -->';

export function renderPanel(r: PanelResult, subject: string): string {
  const icon: Record<string, string> = { approve: 'approve', 'approve-with-nits': 'approve (nits)', 'request-changes': 'REQUEST CHANGES', block: 'BLOCK', error: 'error' };
  let md = `${PANEL_MARKER}\n### Engineering review panel\n\n**Subject:** ${subject}\n**Aggregate verdict:** ${r.aggregate.toUpperCase()}\n\n`;
  md += '| Persona | Model | Verdict | Score | Summary |\n|---|---|---|---|---|\n';
  for (const v of r.reviews) md += `| ${v.title} | ${v.model} | ${icon[v.verdict]} | ${v.score ?? '-'} | ${(v.error ?? v.summary).replace(/\|/g, '/').slice(0, 160)} |\n`;
  md += `\n#### Must fix (${r.mustFix.length})\n`;
  if (!r.mustFix.length) md += '\nNone.\n';
  r.mustFix.forEach((f, i) => {
    md += `\n${i + 1}. **[${f.severity}] ${f.title}**${f.file ? ` — \`${f.file}${f.line ? `:${f.line}` : ''}\`` : ''} _(${f.persona})_\n   - ${f.detail}\n   - Fix: ${f.fix}\n`;
  });
  if (r.minor.length) {
    md += `\n<details><summary>Minor and nits (${r.minor.length})</summary>\n\n`;
    for (const f of r.minor) md += `- [${f.severity}] ${f.title}${f.file ? ` (\`${f.file}\`)` : ''}: ${f.fix} _(${f.persona})_\n`;
    md += '\n</details>\n';
  }
  return md;
}

/** CLI: ufactory review --diff <base> | --pr <n> | --path <file|dir> [--personas a,b] [--out file] */
export async function reviewCommand(ctx: RunContext, o: { diff?: string; pr?: number; path?: string; personas?: string[]; out?: string }): Promise<number> {
  let subject: string;
  let label: string;
  if (o.pr !== undefined) {
    const pr = await ctx.gh.getPullRequest(o.pr);
    const r = await run(process.env.UFACTORY_GH_BIN || 'gh', ['pr', 'diff', String(o.pr)], { cwd: ctx.root, maxOutput: 400_000 });
    subject = `PR #${pr.number}: ${pr.title}\n\n${r.stdout.slice(0, 60_000)}`;
    label = `pull request #${o.pr}`;
    ctx.record.set('pull_request', o.pr);
  } else if (o.path) {
    subject = readSubjectPath(ctx.root, o.path);
    label = `file(s) ${o.path}`;
  } else {
    const base = o.diff ?? 'HEAD';
    subject = await diffText(ctx.root, base, 60_000);
    if (!subject.trim()) {
      ctx.log.info('nothing to review: empty diff');
      ctx.finish('succeeded', 'empty-diff');
      return 0;
    }
    label = `diff against ${base}`;
  }
  const personas = o.personas?.length ? o.personas : ctx.cfg.review.personas;
  ctx.log.info(`review panel: ${personas.length} personas on ${label}`);
  const result = await runPanel(ctx, label, subject, personas);
  const md = renderPanel(result, label);
  if (o.out) writeFileSync(join(ctx.root, o.out), md);
  out.write(md + '\n');
  if (o.pr !== undefined) await ctx.gh.upsertMarkerComment(o.pr, PANEL_MARKER, md);
  ctx.record.section('Panel', `aggregate: ${result.aggregate}\n\n` + result.reviews.map((r) => `- ${r.persona} (${r.model}): ${r.verdict}`).join('\n'));
  const failing = result.aggregate === 'block' || result.aggregate === 'request-changes' || result.aggregate === 'incomplete';
  ctx.finish(failing ? 'rejected' : 'succeeded', failing ? `panel-${result.aggregate}` : 'none');
  return failing ? 1 : 0;
}

function readSubjectPath(root: string, p: string): string {
  const abs = join(root, p);
  if (!existsSync(abs)) throw new ConfigError(`review path not found: ${p}`);
  const files: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d)) {
      if (e === '.git' || e === 'node_modules' || e === 'dist') continue;
      const f = join(d, e);
      if (statSync(f).isDirectory()) walk(f);
      else files.push(f);
    }
  };
  if (statSync(abs).isDirectory()) walk(abs);
  else files.push(abs);
  let out = '';
  for (const f of files.sort()) {
    const buf = readFileSync(f);
    if (buf.subarray(0, 8000).includes(0) || /\.(env|pem|key)$/.test(f)) continue;
    out += `\n===== ${relative(root, f)} =====\n${buf.toString('utf8')}`;
    if (out.length > 60_000) {
      out = out.slice(0, 60_000) + '\n[... truncated ...]';
      break;
    }
  }
  return out;
}
