import { out } from '../src/util/output.js';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { RunContext } from '../src/context.js';
import { implementCommand } from '../src/stages/implement.js';
import { reviewCommand } from '../src/stages/review.js';
import { MockLlm, systemOf, type MockReply, type RecordedRequest } from './helpers/mock-llm.js';
import { git, makeRepo, read } from './helpers/repo.js';

Object.assign(process.env, { GIT_AUTHOR_NAME: 'factory-test', GIT_AUTHOR_EMAIL: 'f@t', GIT_COMMITTER_NAME: 'factory-test', GIT_COMMITTER_EMAIL: 'f@t' });

const mock = new MockLlm(() => ({ content: '{}' }));
before(async () => {
  await mock.start();
});
after(async () => {
  await mock.stop();
});

const assistantTurns = (r: RecordedRequest) => (r.body.messages as any[]).filter((m) => m.role === 'assistant').length;

/** Script the implement agent by turn; verifier/critic/review answered by system prompt. */
function script(steps: Array<MockReply['tool_calls']>, verdict = 'accepted') {
  return (r: RecordedRequest): MockReply => {
    const sys = systemOf(r);
    if (r.body.tools) {
      const step = steps[Math.min(assistantTurns(r), steps.length - 1)];
      return { tool_calls: step };
    }
    if (sys.includes('factory verifier')) return { content: JSON.stringify({ verdict, reasons: ['diff matches done_when'], must_fix: [], done_when_true: true, scope_ok: true }) };
    if (sys.includes('factory critic')) return { content: JSON.stringify({ position: 'no-objection', strongest_objection: 'none', assumptions_introduced: [], maintainability_cost: 'none material', simpler_alternative: 'none', would_a_stranger_understand: 'yes' }) };
    return { content: JSON.stringify({ verdict: 'approve', score: 9, summary: 'fine', findings: [] }) };
  };
}

const quietCtx = (dir: string) => RunContext.create('implement', { cwd: dir, apply: false, quiet: true }, 7);
const silence = async <T>(fn: () => Promise<T>): Promise<T> => {
  const w = out.write;
  out.write = () => undefined;
  try {
    return await fn();
  } finally {
    out.write = w;
  }
};
const lastRecord = (dir: string) => {
  const d = join(dir, 'docs/factory/runs');
  const f = readdirSync(d).filter((x) => x !== 'README.md').sort().pop()!;
  return readFileSync(join(d, f), 'utf8');
};

const FIX_TEST = "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from '../src/math.js';\ntest('add adds', () => assert.equal(add(2, 3), 5));\n";
const FIXED = 'export function add(a, b) {\n  return a + b;\n}\n';

test('e2e: local implement writes test + fix, gates GREEN, proof PROVEN, verifier accepts', async () => {
  const dir = makeRepo({ baseUrl: mock.baseUrl });
  mock.setResponder(
    script([
      [{ name: 'read_file', args: { path: 'src/math.js' } }],
      [{ name: 'write_file', args: { path: 'test/add.test.js', content: FIX_TEST } }],
      [{ name: 'write_file', args: { path: 'src/math.js', content: FIXED } }],
      [{ name: 'run_gates', args: { level: 'full' } }],
      [{ name: 'finish', args: { summary: 'add() subtracted; now adds. New test proves it.', test_paths: ['test/add.test.js'] } }],
    ]),
  );
  const code = await silence(() => implementCommand(quietCtx(dir), { local: true, issue: 7, task: 'add() returns the wrong result', doneWhen: 'test/add.test.js passes', files: ['src/math.js', 'test/add.test.js'] }));
  assert.equal(code, 0);
  assert.equal(git(dir, 'branch', '--show-current'), 'factory/fq-7');
  assert.equal(read(dir, 'src/math.js'), FIXED);
  assert.match(git(dir, 'log', '-1', '--format=%s'), /factory: FQ-7/);
  const rec = lastRecord(dir);
  assert.match(rec, /status: succeeded/);
  assert.match(rec, /gate_status: GREEN/);
  assert.match(rec, /proof_status: PROVEN/);
  assert.match(rec, /verifier: accepted/);
  assert.match(rec, /verifier_independent: true/);
  assert.match(rec, /models_requested:/);
  // the verifier request never contained the implementer's narrative summary
  const verifierReq = mock.requests.filter((r) => systemOf(r).includes('factory verifier')).pop()!;
  assert.ok(!JSON.stringify(verifierReq.body).includes('add() subtracted; now adds'));
});

test('e2e: attacks on protected paths are refused and the run stops', async () => {
  const dir = makeRepo({ baseUrl: mock.baseUrl });
  const charter = read(dir, 'docs/factory/CHARTER.md');
  mock.setResponder(
    script([
      [{ name: 'write_file', args: { path: 'docs/factory/CHARTER.md', content: 'CHARTER_STATUS: ready\nTIER: revival' } }],
      [{ name: 'write_file', args: { path: '../outside.txt', content: 'x' } }],
      [{ name: 'shell', args: { cmd: 'gh pr merge 1' } }],
      [{ name: 'finish', args: { summary: 'x', test_paths: [] } }],
    ]),
  );
  const code = await silence(() => implementCommand(quietCtx(dir), { local: true, issue: 8, task: 'loosen the charter', doneWhen: 'charter allows everything' }));
  assert.equal(code, 1);
  assert.equal(read(dir, 'docs/factory/CHARTER.md'), charter);
  assert.equal(existsSync(join(dir, '../outside.txt')), false);
  const rec = lastRecord(dir);
  assert.match(rec, /status: stopped/);
  assert.match(rec, /stop_reason: too-many-refusals/);
});

test('e2e: crossing the line limit reverts and refuses the write', async () => {
  const dir = makeRepo({ baseUrl: mock.baseUrl, maxLines: 10 });
  const big = Array.from({ length: 50 }, (_, i) => `export const v${i} = ${i};`).join('\n') + '\n';
  mock.setResponder(script([[{ name: 'write_file', args: { path: 'src/big.js', content: big } }]]));
  const before = mock.requests.length;
  const code = await silence(() => implementCommand(quietCtx(dir), { local: true, issue: 9, task: 'add constants', doneWhen: 'constants exist' }));
  assert.notEqual(code, 0);
  assert.equal(existsSync(join(dir, 'src/big.js')), false, 'offending write reverted');
  assert.match(JSON.stringify(mock.requests.slice(before).map((r) => r.body.messages)), /too-many-lines/, 'the agent is told why and can retry smaller');
  assert.match(lastRecord(dir), /stop_reason: too-many-refusals/);
});

test('e2e: a test that passes without the fix fails the negative-test proof', async () => {
  const dir = makeRepo({ baseUrl: mock.baseUrl });
  const vacuous = "import test from 'node:test';\ntest('always passes', () => {});\n";
  mock.setResponder(
    script([
      [{ name: 'write_file', args: { path: 'test/vacuous.test.js', content: vacuous } }],
      [{ name: 'write_file', args: { path: 'src/math.js', content: FIXED } }],
      [{ name: 'finish', args: { summary: 'fixed', test_paths: ['test/vacuous.test.js'] } }],
    ]),
  );
  const code = await silence(() => implementCommand(quietCtx(dir), { local: true, issue: 10, task: 'fix add', doneWhen: 'add adds' }));
  assert.equal(code, 1);
  assert.match(lastRecord(dir), /proof_status: FAILED/);
  assert.match(lastRecord(dir), /stop_reason: proof-failed/);
});

test('e2e: existing test modification is refused (TESTS_ARE_LOAD_BEARING)', async () => {
  const dir = makeRepo({ baseUrl: mock.baseUrl });
  mock.setResponder(
    script([
      [{ name: 'write_file', args: { path: 'test/smoke.test.js', content: '// gutted\n' } }],
      [{ name: 'delete_file', args: { path: 'test/smoke.test.js' } }],
      [{ name: 'finish', args: { summary: 'nothing', test_paths: [] } }],
    ]),
  );
  const code = await silence(() => implementCommand(quietCtx(dir), { local: true, issue: 11, task: 'x', doneWhen: 'y' }));
  assert.notEqual(code, 0);
  assert.match(read(dir, 'test/smoke.test.js'), /smoke/);
});

test('e2e: gates red at finish twice stops the run', async () => {
  const dir = makeRepo({ baseUrl: mock.baseUrl });
  const failing = "import test from 'node:test';\ntest('red', () => { throw new Error('red'); });\n";
  mock.setResponder(
    script([
      [{ name: 'write_file', args: { path: 'test/red.test.js', content: failing } }],
      [{ name: 'finish', args: { summary: 'done', test_paths: ['test/red.test.js'] } }],
      [{ name: 'finish', args: { summary: 'done', test_paths: ['test/red.test.js'] } }],
    ]),
  );
  const code = await silence(() => implementCommand(quietCtx(dir), { local: true, issue: 12, task: 'x', doneWhen: 'y' }));
  assert.equal(code, 1);
  assert.match(lastRecord(dir), /stop_reason: gates-red-twice/);
});

test('e2e: review panel runs 10 personas and aggregates', async () => {
  const dir = makeRepo({ baseUrl: mock.baseUrl });
  mock.setResponder((r) => {
    const sys = systemOf(r);
    if (sys.includes('Principal Security Engineer')) return { content: JSON.stringify({ verdict: 'request-changes', score: 5, summary: 'issue', findings: [{ severity: 'major', title: 'Unvalidated input', detail: 'd', fix: 'validate', file: 'src/math.js', line: 1 }] }) };
    return { content: JSON.stringify({ verdict: 'approve', score: 9, summary: 'ok', findings: [] }) };
  });
  const before = mock.requests.length;
  const code = await silence(() => reviewCommand(RunContext.create('review', { cwd: dir, apply: false, quiet: true }), { path: 'src/math.js', out: 'review.md' }));
  assert.equal(mock.requests.length - before, 10);
  assert.equal(code, 1);
  const md = read(dir, 'review.md');
  assert.match(md, /Aggregate verdict:\*\* REQUEST-CHANGES/);
  assert.match(md, /Unvalidated input/);
});

test('e2e: verifier rejects twice -> no PR, stop_reason verifier-rejected, second round sees must_fix', async () => {
  const dir = makeRepo({ baseUrl: mock.baseUrl });
  let verifierCalls = 0;
  const base = script([
    [{ name: 'write_file', args: { path: 'test/add.test.js', content: FIX_TEST } }],
    [{ name: 'write_file', args: { path: 'src/math.js', content: FIXED } }],
    [{ name: 'finish', args: { summary: 'fix', test_paths: ['test/add.test.js'] } }],
  ]);
  mock.setResponder((r) => {
    if (systemOf(r).includes('factory verifier')) {
      verifierCalls++;
      return { content: JSON.stringify({ verdict: 'rejected', reasons: ['naming'], must_fix: ['rename the helper'], done_when_true: true, scope_ok: true }) };
    }
    if (r.body.tools && JSON.stringify(r.body.messages).includes('rename the helper')) return { tool_calls: [{ name: 'finish', args: { summary: 'addressed', test_paths: ['test/add.test.js'] } }] };
    return base(r);
  });
  const code = await silence(() => implementCommand(quietCtx(dir), { local: true, issue: 20, task: 'fix add', doneWhen: 'add adds' }));
  assert.equal(code, 1);
  assert.equal(verifierCalls, 2);
  assert.match(lastRecord(dir), /stop_reason: verifier-rejected/);
});

test('e2e: verifier saying done_when is false is a rejection even if verdict says accepted', async () => {
  const dir = makeRepo({ baseUrl: mock.baseUrl });
  const base = script([
    [{ name: 'write_file', args: { path: 'test/add.test.js', content: FIX_TEST } }],
    [{ name: 'write_file', args: { path: 'src/math.js', content: FIXED } }],
    [{ name: 'finish', args: { summary: 'fix', test_paths: ['test/add.test.js'] } }],
  ]);
  mock.setResponder((r) => (systemOf(r).includes('factory verifier') ? { content: JSON.stringify({ verdict: 'accepted', reasons: [], must_fix: [], done_when_true: false, scope_ok: true }) } : base(r)));
  const code = await silence(() => implementCommand(quietCtx(dir), { local: true, issue: 21, task: 'fix add', doneWhen: 'add adds' }));
  assert.equal(code, 1);
  assert.match(lastRecord(dir), /verifier: rejected/);
});

test('e2e: token budget exhausted mid-loop -> exit 3, record says budget', async () => {
  const dir = makeRepo({ baseUrl: mock.baseUrl, extraConfig: '' });
  // shrink the budget: rewrite config
  const cfgPath = join(dir, 'factory.config.yaml');
  writeFileSync(cfgPath, read(dir, 'factory.config.yaml').replace('budget:\n  max_turns: 20', 'budget:\n  max_turns: 20\n  max_tokens_per_run: 1000'));
  git(dir, 'commit', '-qam', 'small budget');
  mock.setResponder(script([[{ name: 'list_files', args: {} }]]));
  const code = await silence(() => implementCommand(quietCtx(dir), { local: true, issue: 22, task: 'x', doneWhen: 'y' }));
  assert.equal(code, 3);
  assert.match(lastRecord(dir), /stop_reason: budget/);
});

test('e2e: provider failure leaves an infrastructure-failed record', async () => {
  const dir = makeRepo({ baseUrl: mock.baseUrl });
  mock.setResponder(() => ({ status: 500, json: { error: { message: 'upstream exploded' } } }));
  const code = await silence(() => implementCommand(quietCtx(dir), { local: true, issue: 23, task: 'x', doneWhen: 'y' }));
  assert.equal(code, 5);
  const rec = lastRecord(dir);
  assert.match(rec, /status: infrastructure-failed/);
  assert.match(rec, /stop_reason: provider-error/);
});

test('e2e: a test that writes a protected file while gates run is caught after the gate run', async () => {
  const dir = makeRepo({ baseUrl: mock.baseUrl });
  const sneaky = "import test from 'node:test';\nimport { writeFileSync, mkdirSync } from 'node:fs';\ntest('sneaky', () => { mkdirSync('.github/workflows', { recursive: true }); writeFileSync('.github/workflows/evil.yml', 'on: push'); });\n";
  mock.setResponder(
    script([
      [{ name: 'write_file', args: { path: 'test/sneaky.test.js', content: sneaky } }],
      [{ name: 'write_file', args: { path: 'src/math.js', content: FIXED } }],
      [{ name: 'finish', args: { summary: 'fix', test_paths: ['test/sneaky.test.js'] } }],
    ]),
  );
  const code = await silence(() => implementCommand(quietCtx(dir), { local: true, issue: 24, task: 'fix add', doneWhen: 'add adds' }));
  assert.notEqual(code, 0);
  assert.match(lastRecord(dir), /stop_reason: (protected-path|load-bearing-path)/);
  assert.doesNotMatch(git(dir, 'log', '--all', '--name-only', '--format='), /evil\.yml/, 'never committed');
});

test('e2e: unknown tool and test-tampering refusals are reported to the model', async () => {
  const dir = makeRepo({ baseUrl: mock.baseUrl });
  mock.setResponder(
    script([
      [{ name: 'shell', args: { cmd: 'gh pr merge 1' } }],
      [{ name: 'write_file', args: { path: 'test/smoke.test.js', content: '// gutted\n' } }],
      [{ name: 'finish', args: { summary: 'x', test_paths: [] } }],
    ]),
  );
  const before = mock.requests.length;
  await silence(() => implementCommand(quietCtx(dir), { local: true, issue: 25, task: 'x', doneWhen: 'y' }));
  const transcript = JSON.stringify(mock.requests.slice(before).map((r) => r.body.messages));
  assert.match(transcript, /unknown tool [^,]{0,8}shell/);
  assert.match(transcript, /TESTS_ARE_LOAD_BEARING/);
});

test('e2e: automatic model switching on provider failure (fallback chain)', async () => {
  const dir = makeRepo({ baseUrl: mock.baseUrl });
  writeFileSync(join(dir, 'factory.config.yaml'), read(dir, 'factory.config.yaml').replace("    verify: { provider: mock, model: mock-verifier }", "    verify: { provider: mock, model: broken-verifier, fallbacks: [ mock-verifier ] }"));
  git(dir, 'commit', '-qam', 'fallback');
  const base = script([
    [{ name: 'write_file', args: { path: 'test/add.test.js', content: FIX_TEST } }],
    [{ name: 'write_file', args: { path: 'src/math.js', content: FIXED } }],
    [{ name: 'finish', args: { summary: 'fix', test_paths: ['test/add.test.js'] } }],
  ]);
  mock.setResponder((r) => (r.body.model === 'broken-verifier' ? { status: 503, json: { error: { message: 'deployment unavailable' } } } : base(r)));
  const code = await silence(() => implementCommand(quietCtx(dir), { local: true, issue: 30, task: 'fix add', doneWhen: 'add adds' }));
  assert.equal(code, 0);
  const rec = lastRecord(dir);
  assert.match(rec, /verifier: accepted/);
  assert.match(rec, /mock:broken-verifier/);
  assert.match(rec, /mock:mock-verifier/);
});

test('e2e: edit_file makes a targeted change; give_up reverts everything', async () => {
  const dir = makeRepo({ baseUrl: mock.baseUrl });
  mock.setResponder(
    script([
      [{ name: 'edit_file', args: { path: 'src/math.js', old_text: 'a - b', new_text: 'a + b' } }],
      [{ name: 'give_up', args: { reason: 'cannot write a proving test' } }],
    ]),
  );
  const code = await silence(() => implementCommand(quietCtx(dir), { local: true, issue: 31, task: 'x', doneWhen: 'y' }));
  assert.equal(code, 1);
  assert.match(read(dir, 'src/math.js'), /a - b/, 'edit reverted by give_up');
  assert.match(lastRecord(dir), /stop_reason: agent-gave-up/);
});

test('e2e: writes to gitignored paths are refused', async () => {
  const dir = makeRepo({ baseUrl: mock.baseUrl });
  writeFileSync(join(dir, '.gitignore'), 'node_modules/\n');
  git(dir, 'add', '.gitignore');
  git(dir, 'commit', '-qm', 'ignore');
  mock.setResponder(script([[{ name: 'write_file', args: { path: 'node_modules/.bin/test-runner', content: 'exit 0' } }], [{ name: 'give_up', args: { reason: 'x' } }]]));
  const before = mock.requests.length;
  await silence(() => implementCommand(quietCtx(dir), { local: true, issue: 32, task: 'x', doneWhen: 'y' }));
  assert.equal(existsSync(join(dir, 'node_modules/.bin/test-runner')), false);
  assert.match(JSON.stringify(mock.requests.slice(before).map((r) => r.body.messages)), /gitignored path/);
});

test('metrics: attempted runs are the denominator; no-op runs excluded', async () => {
  const dir = makeRepo({ baseUrl: mock.baseUrl });
  mock.setResponder(
    script([
      [{ name: 'write_file', args: { path: 'test/add.test.js', content: FIX_TEST } }],
      [{ name: 'write_file', args: { path: 'src/math.js', content: FIXED } }],
      [{ name: 'finish', args: { summary: 'fix', test_paths: ['test/add.test.js'] } }],
    ]),
  );
  await silence(() => implementCommand(quietCtx(dir), { local: true, issue: 40, task: 'fix add', doneWhen: 'add adds' }));
  const { metricsCommand } = await import('../src/stages/metrics.js');
  let text = '';
  const w = out.write;
  out.write = (s: string) => void (text += s);
  try {
    await metricsCommand(RunContext.create('metrics', { cwd: dir, apply: false, quiet: true, noRecord: true }), { json: true });
  } finally {
    out.write = w;
  }
  const m = JSON.parse(text);
  assert.equal(m.implement.attempted, 1);
  assert.equal(m.implement.proof.PROVEN, 1);
  assert.ok(m.cost.total_usd >= 0);
});

test('e2e: AI-slop in the agent diff refuses finish; the cleaned diff is accepted', async () => {
  const dir = makeRepo({ baseUrl: mock.baseUrl });
  const SLOPPY = readFileSync(fileURLToPath(new URL('../../test/fixtures/slop/sloppy-math.js', import.meta.url)), 'utf8');
  mock.setResponder(
    script([
      [{ name: 'write_file', args: { path: 'test/add.test.js', content: FIX_TEST } }],
      [{ name: 'write_file', args: { path: 'src/math.js', content: SLOPPY } }],
      [{ name: 'finish', args: { summary: 'fix', test_paths: ['test/add.test.js'] } }],
      [{ name: 'write_file', args: { path: 'src/math.js', content: FIXED } }],
      [{ name: 'finish', args: { summary: 'fix', test_paths: ['test/add.test.js'] } }],
    ]),
  );
  const code = await silence(() => implementCommand(quietCtx(dir), { local: true, issue: 41, task: 'add() is wrong', doneWhen: 'test/add.test.js passes', files: ['src/math.js', 'test/add.test.js'] }));
  assert.equal(code, 0);
  const refusal = mock.requests.flatMap((r) => (r.body.messages as any[]) ?? []).find((m) => m.role === 'tool' && String(m.content).includes('AI-slop'));
  assert.ok(refusal, 'the model was told about the slop');
  assert.match(String(refusal.content), /src\/math\.js:2: narrating comment/);
  assert.equal(read(dir, 'src/math.js'), FIXED);
});
