import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { decodeHandoff, encodeHandoff, type Handoff } from '../src/github/handoff.js';
import { setState } from '../src/github/queue.js';
import { scanDiff, scanLines } from '../src/policy/slop.js';
import { spendLast24h } from '../src/runs/record.js';
import { pullRecords, pushRecords } from '../src/runs/sync.js';
import { aggregate, type PersonaReview } from '../src/stages/review.js';
import { log } from '../src/util/log.js';
import { runRepoCode } from '../src/util/sandbox.js';
import { git } from './helpers/repo.js';

// ---- AI-slop -----------------------------------------------------------------------------

test('slop: generated-code patterns are found in added lines of any language', () => {
  const diff = [
    'diff --git a/src/Orders/OrderService.cs b/src/Orders/OrderService.cs',
    '--- a/src/Orders/OrderService.cs',
    '+++ b/src/Orders/OrderService.cs',
    '@@ -10,2 +10,7 @@ public class OrderService',
    ' public void Place(Order o) {',
    '+    // Here we validate the order before saving it',
    '+    try { Save(o); } catch (Exception) { }',
    '+    // Updated: added null check',
    '+    // ... existing code ...',
    '+    var total = o.Total; // compute the total',
    ' }',
    'diff --git a/app/util.py b/app/util.py',
    '--- /dev/null',
    '+++ b/app/util.py',
    '@@ -0,0 +1,4 @@',
    '+def load(p):',
    '+    # This function will leverage the cache to load data',
    '+    try:',
    '+        return read(p)',
    'diff --git a/docs/guide.md b/docs/guide.md',
    '--- a/docs/guide.md',
    '+++ b/docs/guide.md',
    '@@ -1,1 +1,2 @@',
    ' # Guide',
    "+It's worth noting that this robust tool is seamless.",
  ].join('\n');
  const rules = scanDiff(diff).map((f) => `${f.path}:${f.line}:${f.rule}`);
  assert.ok(rules.includes('src/Orders/OrderService.cs:11:narrating comment'), rules.join('\n'));
  assert.ok(rules.includes('src/Orders/OrderService.cs:12:swallowed error (empty catch)'));
  assert.ok(rules.some((r) => r.startsWith('src/Orders/OrderService.cs:13:change-log comment')));
  assert.ok(rules.includes('src/Orders/OrderService.cs:14:elided code'));
  assert.ok(rules.includes('app/util.py:2:comment restates the code'));
  assert.ok(rules.includes('app/util.py:2:banned word "leverage"'));
  assert.ok(rules.includes('docs/guide.md:2:empty phrase "it\'s worth noting"'));
  assert.ok(!rules.some((r) => r.includes(':15:')), 'a plain explanatory comment is fine');
});

test('slop: context lines and clean code are not reported', () => {
  const clean = ['using System;', '// Orders are idempotent per request id; retries must not double-charge.', 'public sealed class OrderService { }'];
  assert.deepEqual(scanLines('src/OrderService.cs', clean), []);
  const diff = ['--- a/a.ts', '+++ b/a.ts', '@@ -1,2 +1,3 @@', ' // Here we keep an old narrating comment', '+export const x = 1;', ' const y = 2;'].join('\n');
  assert.deepEqual(scanDiff(diff), []);
  // URLs and shell flags are not comments.
  assert.deepEqual(scanLines('run.sh', ['curl https://example.com/simply --network none']), []);
});

// ---- signed handoffs --------------------------------------------------------------------

const H: Handoff = { disposition: 'ready-to-implement', done_when: 'x returns 1', files_expected: ['src/x.ts'], load_bearing: false, gate_level: 'full', confidence: 'high' };

test('handoff: signed handoffs verify; forged, altered, unsigned or moved ones do not', () => {
  const body = encodeHandoff(H, { key: 'k1', issue: 7 });
  assert.ok(decodeHandoff(body, { key: 'k1', issue: 7 }).handoff);
  assert.match(decodeHandoff(body, { key: 'other', issue: 7 }).problems.join(), /signature does not match/);
  assert.match(decodeHandoff(body.replace('src/x.ts', 'src/auth/login.ts'), { key: 'k1', issue: 7 }).problems.join(), /signature does not match/);
  assert.match(decodeHandoff(body, { key: 'k1', issue: 8 }).problems.join(), /for issue 7, not #8/);
  assert.match(decodeHandoff(encodeHandoff(H), { key: 'k1', issue: 7 }).problems.join(), /not signed/);
  // Without a configured key, signatures are ignored (backwards compatible).
  assert.ok(decodeHandoff(body).handoff);
});

// ---- panel aggregation ----------------------------------------------------------------

const rv = (verdict: PersonaReview['verdict']): PersonaReview => ({ persona: `p${Math.random()}`, title: 't', model: 'm', verdict, summary: '', findings: [] });

test('panel: a lone block below quorum is request-changes, never approve; quorum blocks', () => {
  const nine = [...Array(9)].map(() => rv('approve'));
  assert.equal(aggregate([...nine, rv('block')], 2).aggregate, 'request-changes');
  assert.equal(aggregate([...nine.slice(1), rv('block'), rv('block')], 2).aggregate, 'block');
  assert.equal(aggregate([rv('block')], 2).aggregate, 'block', 'quorum never exceeds the number of working personas');
});

// ---- daily spend cap ------------------------------------------------------------------

test('spendLast24h sums cost from records that started in the last 24 hours', () => {
  const dir = mkdtempSync(join(tmpdir(), 'uf-spend-'));
  const now = Date.parse('2026-11-21T12:00:00Z');
  const rec = (name: string, started: string, cost: number) => writeFileSync(join(dir, name), `---\nstarted_at: ${started}\ncost_usd: ${cost}\n---\n`);
  rec('2026-11-21T110000Z-implement-1-aaaa.md', '2026-11-21T11:00:00Z', 1.5);
  rec('2026-11-20T130000Z-implement-2-bbbb.md', '2026-11-20T13:00:00Z', 2);
  rec('2026-11-20T090000Z-implement-3-cccc.md', '2026-11-20T09:00:00Z', 100); // older than 24h
  assert.equal(spendLast24h(dir, now), 3.5);
});

// ---- label ownership ------------------------------------------------------------------

function fakeGh(initial: string[], onAdd?: (labels: string[]) => void) {
  const labels = [...initial];
  return {
    labels,
    gh: {
      apply: true,
      getIssue: async () => ({ labels: [...labels] }),
      addLabels: async (_n: number, ls: string[]) => {
        labels.push(...ls);
        onAdd?.(labels);
      },
      removeLabel: async (_n: number, l: string) => {
        const i = labels.indexOf(l);
        if (i >= 0) labels.splice(i, 1);
      },
    } as any,
  };
}

test('labels: triage yields to an implement-owned state, before and during its write', async () => {
  const before = fakeGh(['factory:in-progress']);
  assert.equal(await setState(before.gh, { number: 1, labels: [] }, 'factory:needs-info', { yieldToOwner: true }), false);
  assert.deepEqual(before.labels, ['factory:in-progress']);
  // A claim lands between triage's read and its write.
  const during = fakeGh(['factory:ready-to-implement'], (ls) => {
    if (!ls.includes('factory:in-progress')) ls.push('factory:in-progress');
  });
  assert.equal(await setState(during.gh, { number: 1, labels: [] }, 'factory:needs-info', { yieldToOwner: true }), false);
  assert.deepEqual(during.labels, ['factory:in-progress']);
  // The owner always ends with exactly one state label.
  const owner = fakeGh(['factory:ready-to-implement', 'factory:needs-info']);
  assert.equal(await setState(owner.gh, { number: 1, labels: [] }, 'factory:in-progress'), true);
  assert.deepEqual(owner.labels, ['factory:in-progress']);
});

// ---- durable records -------------------------------------------------------------------

test('records: push appends to the records branch without touching the checkout; pull restores', async () => {
  const base = mkdtempSync(join(tmpdir(), 'uf-rec-'));
  const remote = join(base, 'remote.git');
  git(base, 'init', '--bare', '-q', remote);
  const clone = (name: string) => {
    const d = join(base, name);
    git(base, 'init', '-q', d);
    writeFileSync(join(d, 'a.txt'), 'a\n');
    git(d, 'add', '.');
    git(d, 'commit', '-qm', 'init');
    git(d, 'remote', 'add', 'origin', remote);
    return d;
  };
  const a = clone('a');
  const runs = 'docs/factory/runs';
  mkdirSync(join(a, runs), { recursive: true });
  const today = new Date().toISOString().slice(0, 10);
  writeFileSync(join(a, runs, `${today}T010203Z-triage-none-ab12.md`), 'one\n');
  const head = git(a, 'rev-parse', 'HEAD');
  assert.equal(await pushRecords({ cwd: a, remote: 'origin', runsDir: runs, apply: true, log }), 1);
  assert.equal(git(a, 'rev-parse', 'HEAD'), head, 'HEAD unchanged');
  assert.equal(git(a, 'status', '--porcelain', '--', 'a.txt'), '');
  // A second job pushes concurrently from another checkout; nothing is lost.
  const b = clone('b');
  mkdirSync(join(b, runs), { recursive: true });
  writeFileSync(join(b, runs, `${today}T020304Z-implement-4-cd34.md`), 'two\n');
  assert.equal(await pushRecords({ cwd: b, remote: 'origin', runsDir: runs, apply: true, log }), 1);
  assert.equal(await pushRecords({ cwd: a, remote: 'origin', runsDir: runs, apply: true, log }), 0);
  const c = clone('c');
  assert.equal(await pullRecords({ cwd: c, remote: 'origin', runsDir: runs, log }), 2);
  assert.deepEqual(readdirSync(join(c, runs)).sort(), [`${today}T010203Z-triage-none-ab12.md`, `${today}T020304Z-implement-4-cd34.md`]);
  assert.equal(readFileSync(join(c, runs, `${today}T020304Z-implement-4-cd34.md`), 'utf8'), 'two\n');
});

// ---- sandbox ----------------------------------------------------------------------------

test('sandbox: repository code runs in a container with no network, values passed by name only', async () => {
  const bin = mkdtempSync(join(tmpdir(), 'uf-docker-'));
  const fake = join(bin, 'docker');
  writeFileSync(fake, '#!/usr/bin/env bash\nprintf "%s\\n" "$@"\nprintf "ENV FACTORY_X=%s\\n" "$FACTORY_X"\n');
  chmodSync(fake, 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  try {
    const r = await runRepoCode({ mode: 'docker', image: 'img:1', network: 'none' }, 'bash', ['-c', 'npm test'], { cwd: bin, env: { FACTORY_X: 'value-1', PATH: '/host/bin', HOME: '/Users/me' }, timeoutMs: 10_000 });
    const args = r.stdout.split('\n');
    assert.ok(args.includes('--network') && args[args.indexOf('--network') + 1] === 'none');
    assert.ok(args.includes('--cap-drop') && args.includes('no-new-privileges'));
    assert.ok(args.includes(`${bin}:${bin}`));
    assert.ok(args.includes('FACTORY_X'), 'variable passed by name');
    assert.ok(!r.stdout.includes('value-1\n--') && !args.includes('FACTORY_X=value-1'), 'value never in argv');
    assert.ok(r.stdout.includes('ENV FACTORY_X=value-1'), 'value reaches the client environment');
    assert.ok(!args.includes('PATH') && !args.includes('/host/bin'), 'host PATH not forwarded');
    assert.deepEqual(args.slice(args.indexOf('img:1'), args.indexOf('img:1') + 4), ['img:1', 'bash', '-c', 'npm test']);
  } finally {
    process.env.PATH = oldPath;
  }
});
