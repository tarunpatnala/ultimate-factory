import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { RunContext } from '../context.js';
import { encodeHandoff, HANDOFF_MARKER } from '../github/handoff.js';
import { setState } from '../github/queue.js';
import { extractJson } from '../llm/json.js';
import { FactoryError } from '../util/errors.js';

export const GATES = ['product', 'architecture', 'design', 'slices'] as const;
export type SpecGate = (typeof GATES)[number];

const FILES: Record<SpecGate, string> = { product: '01-product.md', architecture: '02-architecture.md', design: '03-design.md', slices: '04-slices.md' };

const INSTRUCTIONS: Record<SpecGate, string> = {
  product: 'Gate 1 - Product. No technical content. The user problem as a person\'s problem; measurable success; a short announcement as if shipped; what we are deliberately NOT doing (and whether this should exist at all).',
  architecture: 'Gate 2 - Architecture. Systems and modules touched; new endpoints/data shapes; end-to-end call flow; external dependencies and whether each is required; which LOAD_BEARING paths are involved; what could break. If this is a migration, first answer: what is the oracle?',
  design: 'Gate 3 - Program design. Exact file paths (new/modified); type signatures and function contracts, no implementations; main call stack; test list (what each test proves); the three decisions you are least confident about.',
  slices: 'Gate 4 - Slices. Vertical slices, each independently shippable and testable, reviewable in one sitting. Slice 0 is a tracer bullet. For EACH slice end with a fenced ```json block: {"title":"...","done_when":"checkable","files_expected":["..."],"gate_level":"fast|full|deep"}.',
};

interface Status {
  item: string;
  gates: Record<SpecGate, 'not-started' | 'drafted' | 'approved'>;
  approved_by: Partial<Record<SpecGate, string>>;
  /** sha256 of each gate file at approval: publish refuses edited-after-approval content. */
  approved_sha256?: Partial<Record<SpecGate, string>>;
  schema?: string;
}

function sha256(b: Buffer): string {
  return createHash('sha256').update(b).digest('hex');
}

function dirFor(ctx: RunContext, issue: number): string {
  return ctx.cfg.spec.format === 'openspec' ? join(ctx.root, 'openspec', 'changes', `fq-${issue}`) : join(ctx.root, ctx.cfg.factory.specs_dir, `FQ-${issue}`);
}

function readStatus(dir: string, issue: number): Status {
  const p = join(dir, '00-status.json');
  if (existsSync(p)) {
    let s: Status;
    try {
      s = JSON.parse(readFileSync(p, 'utf8')) as Status;
    } catch (e) {
      throw new FactoryError(`${p} is corrupt: ${(e as Error).message}`, 'CONFIG', 2);
    }
    if (!s.gates || GATES.some((g) => !['not-started', 'drafted', 'approved'].includes(s.gates[g]))) throw new FactoryError(`${p} has an invalid gates map`, 'CONFIG', 2);
    return s;
  }
  return { item: `FQ-${issue}`, gates: { product: 'not-started', architecture: 'not-started', design: 'not-started', slices: 'not-started' }, approved_by: {} };
}

function writeStatus(dir: string, s: Status): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '00-status.json'), JSON.stringify({ ...s, schema: 'spec-status/v1' }, null, 2) + '\n');
  const md = `item: ${s.item}\n${GATES.map((g, i) => `gate_${i + 1}_${g}: ${s.gates[g]}${s.approved_by[g] ? ` (${s.approved_by[g]})` : ''}`).join('\n')}\n`;
  writeFileSync(join(dir, '00-status.md'), md);
}

/** Draft the next unapproved gate and stop. Never advances on its own. */
export async function specDraftCommand(ctx: RunContext, o: { issue: number; notes?: string }): Promise<number> {
  if (process.env.CI) throw new FactoryError('spec is interactive and refuses to run in CI: a routine that approves its own spec has no gates', 'POLICY', 4);
  const charter = ctx.charter;
  const dir = dirFor(ctx, o.issue);
  const status = readStatus(dir, o.issue);
  const gate = GATES.find((g) => status.gates[g] !== 'approved');
  if (!gate) {
    ctx.log.info('all four gates are approved. Run "ufactory spec publish --issue N --apply" to create slice issues.');
    return 0;
  }
  const issue = ctx.cfg.github.enabled ? await ctx.gh.getIssue(o.issue).catch(() => undefined) : undefined;
  const prior = GATES.slice(0, GATES.indexOf(gate))
    .map((g) => (existsSync(join(dir, FILES[g])) ? `### Approved ${g}\n${readFileSync(join(dir, FILES[g]), 'utf8')}` : ''))
    .join('\n\n');
  const res = await ctx.llm('spec').chat({
    purpose: `spec/${gate}`,
    messages: [
      { role: 'system', content: `You write one gate of a factory spec. ${INSTRUCTIONS[gate]}\nCharter tier ${charter.tier}; load-bearing: ${charter.loadBearing.join(', ')}.\n${ctx.fence.instruction}\nWrite Markdown only.` },
      { role: 'user', content: [issue ? ctx.fence.wrap(`issue #${o.issue}`, `${issue.title}\n\n${issue.body}`) : `FQ-${o.issue}`, prior, o.notes ? `Human notes for this gate: ${o.notes}` : ''].filter(Boolean).join('\n\n') },
    ],
  });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, FILES[gate]), res.content.trim() + '\n');
  status.gates[gate] = 'drafted';
  writeStatus(dir, status);
  ctx.log.info(`drafted ${gate} -> ${join(dir, FILES[gate])}. STOP: a human must read it, then run "ufactory spec approve --issue ${o.issue} --gate ${gate}".`);
  ctx.finish('succeeded', `awaiting-approval-${gate}`);
  return 0;
}

export async function specApproveCommand(ctx: RunContext, o: { issue: number; gate: SpecGate; by: string }): Promise<number> {
  if (process.env.CI) throw new FactoryError('spec approval must be done by a human outside CI', 'POLICY', 4);
  const dir = dirFor(ctx, o.issue);
  const status = readStatus(dir, o.issue);
  const idx = GATES.indexOf(o.gate);
  if (idx < 0) throw new FactoryError(`unknown gate ${o.gate}`, 'USAGE', 2);
  if (status.gates[o.gate] !== 'drafted') throw new FactoryError(`gate ${o.gate} is ${status.gates[o.gate]}; only a drafted gate can be approved`, 'USAGE', 2);
  for (const g of GATES.slice(0, idx)) if (status.gates[g] !== 'approved') throw new FactoryError(`gate ${g} must be approved first`, 'USAGE', 2);
  status.gates[o.gate] = 'approved';
  status.approved_by[o.gate] = `${o.by} ${new Date().toISOString()}`;
  status.approved_sha256 = { ...(status.approved_sha256 ?? {}), [o.gate]: sha256(readFileSync(join(dir, FILES[o.gate]))) };
  writeStatus(dir, status);
  ctx.log.info(`approved ${o.gate} for FQ-${o.issue}`);
  return 0;
}

/** After gate 4 approval: create one ready-to-implement issue per slice (with --apply). */
export async function specPublishCommand(ctx: RunContext, o: { issue: number }): Promise<number> {
  const dir = dirFor(ctx, o.issue);
  const status = readStatus(dir, o.issue);
  if (GATES.some((g) => status.gates[g] !== 'approved')) throw new FactoryError('all four gates must be approved before slices are published', 'POLICY', 4);
  for (const g of GATES) {
    const want = status.approved_sha256?.[g];
    if (!want || sha256(readFileSync(join(dir, FILES[g]))) !== want) throw new FactoryError(`gate ${g} was edited after approval (or has no recorded hash); re-approve it`, 'POLICY', 4);
  }
  const text = readFileSync(join(dir, FILES.slices), 'utf8');
  const blocks = [...text.matchAll(/```json\s*([\s\S]*?)```/g)].map((m) => extractJson(m[1]!) as any);
  let n = 0;
  for (const s of blocks) {
    if (!s?.title || !s?.done_when || !Array.isArray(s.files_expected)) continue;
    const refused = s.files_expected.map((f: string) => ctx.policy.writeRefusal(f)).filter(Boolean);
    const title = `FQ-${o.issue} slice: ${s.title}`;
    const num = await ctx.gh.createIssue(title, `Slice of #${o.issue}. Spec: \`${relative(ctx.root, dir).split('\\').join('/')}\`\n\ndone_when: ${s.done_when}`, []);
    if (num) {
      const key = process.env[ctx.cfg.github.handoff_key_env];
      await ctx.gh.comment(num, encodeHandoff({ disposition: refused.length ? 'ready-to-spec' : 'ready-to-implement', done_when: s.done_when, files_expected: s.files_expected, load_bearing: false, gate_level: s.gate_level ?? 'full', confidence: 'high', notes: `from approved spec FQ-${o.issue}` }, key ? { key, issue: num } : undefined));
      await setState(ctx.gh, { number: num, labels: [] }, refused.length ? 'factory:ready-to-spec' : 'factory:ready-to-implement');
    }
    n++;
  }
  ctx.log.info(`${n} slice(s) ${ctx.opts.apply ? 'published' : 'planned (dry run)'}; marker ${HANDOFF_MARKER}`);
  ctx.finish('succeeded');
  return 0;
}
