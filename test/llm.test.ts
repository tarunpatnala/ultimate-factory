import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfigFromString, resolveModel } from '../src/config/load.js';
import { backoff, chatJson, LlmClient, parseRetryAfter } from '../src/llm/client.js';
import { UsageTracker } from '../src/llm/usage.js';
import { BudgetExceededError, LlmError } from '../src/util/errors.js';
import { Logger } from '../src/util/log.js';
import { Redactor } from '../src/util/redact.js';

const KEY = 'sk-test-SECRETVALUE-abcdefghijklmnop';
const env = { OPENAI_API_KEY: KEY };
const loaded = loadConfigFromString(`providers:\n  openai: { type: openai, api_key_env: OPENAI_API_KEY, max_retries: 3 }\nmodels:\n  default: { provider: openai, model: gpt-5.1 }`, { cwd: '/', env });

function client(responses: Array<() => Response>, usage = new UsageTracker({ maxTokens: 100_000, maxTurns: 10 }, {}), sleeps: number[] = []) {
  let i = 0;
  const fetchImpl = (async () => {
    const f = responses[Math.min(i++, responses.length - 1)]!;
    return f();
  }) as unknown as typeof fetch;
  return {
    c: new LlmClient(resolveModel(loaded, 'implement'), { runId: 'r', stage: 't', usage, log: new Logger('error'), redactor: new Redactor(['OPENAI_API_KEY'], env), env, fetchImpl, sleep: async (ms) => void sleeps.push(ms), random: () => 0.5 }),
    usage,
    sleeps,
    calls: () => i,
  };
}
const ok = (body: unknown) => () => new Response(JSON.stringify(body), { status: 200 });
const completion = (content: string, usage = true) => ({ model: 'gpt-5.1-2025-11-13', choices: [{ message: { content }, finish_reason: 'stop' }], ...(usage ? { usage: { prompt_tokens: 10, completion_tokens: 5 } } : {}) });

test('429 with Retry-After is honoured then succeeds', async () => {
  const t = client([() => new Response('{"error":{"message":"rate"}}', { status: 429, headers: { 'retry-after': '2' } }), ok(completion('hi'))]);
  const r = await t.c.chat({ messages: [{ role: 'user', content: 'x' }] });
  assert.equal(r.content, 'hi');
  assert.equal(r.attempts, 2);
  assert.equal(t.sleeps[0], 2000);
  assert.equal(r.servedModel, 'gpt-5.1-2025-11-13', 'served model recorded from response');
});

test('400 is not retried', async () => {
  const t = client([() => new Response('{"error":{"message":"bad"}}', { status: 400 }), ok(completion('never'))]);
  await assert.rejects(t.c.chat({ messages: [{ role: 'user', content: 'x' }] }), (e: LlmError) => e.status === 400);
  assert.equal(t.calls(), 1);
});

test('503 retried with backoff then success', async () => {
  const t = client([() => new Response('down', { status: 503 }), () => new Response('down', { status: 503 }), ok(completion('ok'))]);
  const r = await t.c.chat({ messages: [{ role: 'user', content: 'x' }] });
  assert.equal(r.attempts, 3);
  assert.equal(t.sleeps.length, 2);
});

test('missing usage is estimated and flagged', async () => {
  const t = client([ok(completion('hello world', false))]);
  const r = await t.c.chat({ messages: [{ role: 'user', content: 'abcdefgh' }] });
  assert.equal(r.usageEstimated, true);
  assert.ok(r.promptTokens > 0);
  assert.equal(t.usage.usageEstimated, true);
});

test('provider error echoing the key is redacted', async () => {
  const t = client([() => new Response(JSON.stringify({ error: { message: `invalid key ${KEY}` } }), { status: 401 })]);
  await assert.rejects(t.c.chat({ messages: [{ role: 'user', content: 'x' }] }), (e: Error) => !e.message.includes(KEY) && e.message.includes('[REDACTED]'));
});

test('token budget stops further calls', async () => {
  const usage = new UsageTracker({ maxTokens: 20, maxTurns: 10 }, {});
  const t = client([ok(completion('a')), ok(completion('b'))], usage);
  await t.c.chat({ messages: [{ role: 'user', content: 'x' }] }); // 15 tokens used, 5 left
  // the next prompt alone (~8 estimated tokens) would exceed what is left: refused before sending
  await assert.rejects(t.c.chat({ messages: [{ role: 'user', content: 'x' }] }), /would exceed the remaining/);
  assert.equal(t.calls(), 1);
  usage.record({ purpose: 'x', provider: 'p', requestedModel: 'm', servedModel: 'm', promptTokens: 10, completionTokens: 0, usageEstimated: false, latencyMs: 1, attempts: 1, ok: true });
  await assert.rejects(t.c.chat({ messages: [{ role: 'user', content: 'x' }] }), BudgetExceededError);
});

test('USD budget uses price table', async () => {
  const usage = new UsageTracker({ maxTokens: 1e9, maxUsd: 0.00001, maxTurns: 10 }, { 'gpt-5.1': { input_per_mtok: 1000, output_per_mtok: 1000 } });
  const t = client([ok(completion('a'))], usage);
  await t.c.chat({ messages: [{ role: 'user', content: 'x' }] });
  assert.ok(usage.costUsd > 0);
  await assert.rejects(t.c.chat({ messages: [{ role: 'user', content: 'x' }] }), BudgetExceededError);
});

test('chatJson repairs once, then fails', async () => {
  const t = client([ok(completion('not json')), ok(completion('```json\n{"verdict":"ok"}\n```'))]);
  const { value } = await chatJson<{ verdict: string }>(t.c, [{ role: 'user', content: 'x' }], (v: any) => (v.verdict ? undefined : 'missing'));
  assert.equal(value.verdict, 'ok');
  const t2 = client([ok(completion('nope')), ok(completion('still nope'))]);
  await assert.rejects(chatJson(t2.c, [{ role: 'user', content: 'x' }], () => undefined), /invalid JSON twice/);
});

test('retry helpers', () => {
  assert.equal(parseRetryAfter('3'), 3000);
  assert.equal(parseRetryAfter(null), undefined);
  assert.ok(backoff(10, () => 1) <= 30_000);
  assert.ok(backoff(1, () => 0) >= 250);
});

test('gateway HTML error page (200, not JSON) is retried', async () => {
  const t = client([() => new Response('<html>bad gateway</html>', { status: 200 }), ok(completion('ok'))]);
  const r = await t.c.chat({ messages: [{ role: 'user', content: 'x' }] });
  assert.equal(r.content, 'ok');
  assert.equal(r.attempts, 2);
});

test('wall-clock budget stops calls', async () => {
  const usage = new UsageTracker({ maxTokens: 1e9, maxTurns: 10, maxWallClockMs: -1 }, {});
  const t = client([ok(completion('a'))], usage);
  await assert.rejects(t.c.chat({ messages: [{ role: 'user', content: 'x' }] }), /wall-clock/);
});

test('cost uses the served model price when a gateway falls back', () => {
  const u = new UsageTracker({ maxTokens: 1e9, maxTurns: 1 }, { cheap: { input_per_mtok: 1, output_per_mtok: 1 }, pricey: { input_per_mtok: 100, output_per_mtok: 100 }, '*': { input_per_mtok: 1, output_per_mtok: 1 } });
  u.record({ purpose: 'x', provider: 'p', requestedModel: 'cheap', servedModel: 'pricey', promptTokens: 1_000_000, completionTokens: 0, usageEstimated: false, latencyMs: 1, attempts: 1, ok: true });
  assert.equal(u.costUsd, 100);
});
