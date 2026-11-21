import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { loadConfigFromString, resolveModel } from '../src/config/load.js';
import { buildBody, buildRequest } from '../src/llm/providers.js';
import { ConfigError } from '../src/util/errors.js';

const base = (extra = '') => `
version: 1
providers:
  openai: { type: openai, api_key_env: OPENAI_API_KEY }
  portkey:
    type: portkey
    api_key_env: PORTKEY_API_KEY
models:
  default: { provider: openai, model: gpt-5.1 }
  roles:
    verify: { provider: portkey, model: "@anthropic/claude-sonnet-4-5" }
${extra}`;
const opts = (env: Record<string, string> = {}) => ({ cwd: '/tmp', env: { OPENAI_API_KEY: 'test-openai-key-123456', PORTKEY_API_KEY: 'test-portkey-key-123456', ...env } });

test('example config file loads and resolves every role in both profiles', () => {
  const text = readFileSync(new URL('../../factory.config.example.yaml', import.meta.url), 'utf8');
  const a = loadConfigFromString(text, opts());
  assert.equal(resolveModel(a, 'implement').provider.type, 'openai');
  const b = loadConfigFromString(text, { ...opts(), profile: 'portkey' });
  assert.equal(resolveModel(b, 'verify').settings.model, '@anthropic/claude-sonnet-4-5');
  assert.equal(resolveModel(b, 'verify').provider.name, 'portkey');
});

test('role override routes only that role to Portkey', () => {
  const l = loadConfigFromString(base(), opts());
  assert.equal(resolveModel(l, 'implement').provider.name, 'openai');
  assert.equal(resolveModel(l, 'verify').provider.name, 'portkey');
});

test('literal api_key is rejected', () => {
  assert.throws(() => loadConfigFromString(base().replace('api_key_env: OPENAI_API_KEY', 'api_key: abc123secretvalue'), opts()), (e: Error) => e instanceof ConfigError && /literal secret/.test(e.message));
});

test('sk- key hidden in a header is rejected', () => {
  const t = base().replace('api_key_env: OPENAI_API_KEY }', 'api_key_env: OPENAI_API_KEY, headers: { x-extra: "sk-proj-ABCDEFGHIJKLMNOPQRSTUV" } }');
  assert.throws(() => loadConfigFromString(t, opts()), /looks like a OpenAI-style secret key/);
});

test('env reference for a secret-named key is accepted', () => {
  const t = base().replace('api_key_env: PORTKEY_API_KEY', 'api_key_env: PORTKEY_API_KEY\n    headers: { x-portkey-config: "${PK_CFG:-pc-default}" }');
  const l = loadConfigFromString(t, opts());
  assert.equal(l.config.providers.portkey!.headers!['x-portkey-config'], 'pc-default');
});

test('URL with embedded credentials is rejected', () => {
  const t = base().replace('{ type: openai, api_key_env: OPENAI_API_KEY }', '{ type: openai, api_key_env: OPENAI_API_KEY, base_url: "https://user:pw@example.com/v1" }');
  assert.throws(() => loadConfigFromString(t, opts()), /embedded credentials/);
});

test('unknown provider type and unknown role are path-qualified errors', () => {
  assert.throws(() => loadConfigFromString(base().replace('type: openai,', 'type: anthropic-native,'), opts()), /providers\.openai\.type/);
  assert.throws(() => loadConfigFromString(base('    builder: { model: x }'), opts()), /models\.roles\.builder: unknown role/);
});

test('undefined profile fails; profile switch applies', () => {
  const t = base(`profiles:\n  cheap:\n    models:\n      default: { provider: openai, model: gpt-5.1-mini }`);
  assert.throws(() => loadConfigFromString(t, { ...opts(), profile: 'nope' }), /profile "nope" is not defined/);
  const l = loadConfigFromString(t, { ...opts(), profile: 'cheap' });
  assert.equal(resolveModel(l, 'implement').settings.model, 'gpt-5.1-mini');
  assert.equal(resolveModel(l, 'verify').settings.model, '@anthropic/claude-sonnet-4-5', 'role override still wins over profile default');
});

test('Portkey without routing and without @catalog model is rejected at load', () => {
  const t = base().replace('"@anthropic/claude-sonnet-4-5"', 'claude-sonnet-4-5');
  assert.throws(() => loadConfigFromString(t, opts()), /cannot route model/);
});

test('fewer personas than min_personas is a config error', () => {
  assert.throws(() => loadConfigFromString(base('review:\n  personas: [security-engineer]'), opts()), /min_personas is 10/);
});

test('secret-looking passthrough env is rejected', () => {
  assert.throws(() => loadConfigFromString(base('agent:\n  passthrough_env: [MY_API_TOKEN]'), opts()), /looks like a secret/);
});

// ---------------------------------------------------------------------------
// provider request building
// ---------------------------------------------------------------------------
const ctx = { runId: 'run-1', stage: 'test' };

test('OpenAI: bearer auth and max_completion_tokens; temperature omitted when unset', () => {
  const l = loadConfigFromString(base('    implement: { max_output_tokens: 100, reasoning_effort: high }'), opts());
  const m = resolveModel(l, 'implement');
  const r = buildRequest(m, { ...ctx, env: opts().env });
  assert.equal(r.url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(r.headers.authorization, 'Bearer test-openai-key-123456');
  const body = buildBody(m, { messages: [] });
  assert.equal(body.max_completion_tokens, 100);
  assert.equal(body.reasoning_effort, 'high');
  assert.equal('temperature' in body, false);
});

test('Portkey catalog model: api key, trace id, metadata, no provider header', () => {
  const l = loadConfigFromString(base(), opts());
  const r = buildRequest(resolveModel(l, 'verify'), { ...ctx, env: opts().env });
  assert.equal(r.url, 'https://api.portkey.ai/v1/chat/completions');
  assert.equal(r.headers['x-portkey-api-key'], 'test-portkey-key-123456');
  assert.equal(r.headers['x-portkey-trace-id'], 'run-1');
  assert.equal(JSON.parse(r.headers['x-portkey-metadata']!).run_id, 'run-1');
  assert.equal(r.headers['x-portkey-provider'], undefined);
  assert.equal(r.headers.authorization, undefined);
});

test('Portkey precedence: config > virtual key > provider', () => {
  const mk = (extra: string) => loadConfigFromString(base().replace('api_key_env: PORTKEY_API_KEY', `api_key_env: PORTKEY_API_KEY\n    ${extra}`), opts({ PK_VK: 'vk-test-1234', UP_KEY: 'upstream-key-1234' }));
  let r = buildRequest(resolveModel(mk('config: pc-abc\n    virtual_key_env: PK_VK\n    provider: openai'), 'verify'), { ...ctx, env: opts({ PK_VK: 'vk-test-1234' }).env });
  assert.equal(r.headers['x-portkey-config'], 'pc-abc');
  assert.equal(r.headers['x-portkey-virtual-key'], undefined);
  r = buildRequest(resolveModel(mk('virtual_key_env: PK_VK\n    provider: openai'), 'verify'), { ...ctx, env: opts({ PK_VK: 'vk-test-1234' }).env });
  assert.equal(r.headers['x-portkey-virtual-key'], 'vk-test-1234');
  assert.equal(r.headers['x-portkey-provider'], undefined);
  r = buildRequest(resolveModel(mk('provider: openai\n    provider_api_key_env: UP_KEY'), 'verify'), { ...ctx, env: opts({ UP_KEY: 'upstream-key-1234' }).env });
  assert.equal(r.headers['x-portkey-provider'], 'openai');
  assert.equal(r.headers.authorization, 'Bearer upstream-key-1234');
});

test('Azure: deployments path with api-version, api-key header; v1 path without', () => {
  const t = (v: string) => `
providers:
  az: { type: azure-openai, base_url: "https://res.openai.azure.com", api_key_env: AZ_KEY ${v} }
models:
  default: { provider: az, model: gpt-4o-prod }`;
  const env = { AZ_KEY: 'azure-key-123456' };
  let r = buildRequest(resolveModel(loadConfigFromString(t(', api_version: "2024-10-21"'), { cwd: '/', env }), 'triage'), { ...ctx, env });
  assert.equal(r.url, 'https://res.openai.azure.com/openai/deployments/gpt-4o-prod/chat/completions?api-version=2024-10-21');
  assert.equal(r.headers['api-key'], 'azure-key-123456');
  r = buildRequest(resolveModel(loadConfigFromString(t(''), { cwd: '/', env }), 'triage'), { ...ctx, env });
  assert.equal(r.url, 'https://res.openai.azure.com/openai/v1/chat/completions');
});

test('openai-compatible without key sends no Authorization and uses max_tokens', () => {
  const t = `providers:\n  local: { type: openai-compatible, base_url: "http://localhost:11434/v1", api_key_env: "" }\nmodels:\n  default: { provider: local, model: llama3.1, max_output_tokens: 50 }`;
  const m = resolveModel(loadConfigFromString(t, { cwd: '/', env: {} }), 'triage');
  assert.equal(buildRequest(m, { ...ctx, env: {} }).headers.authorization, undefined);
  assert.equal(buildBody(m, { messages: [] }).max_tokens, 50);
});

test('missing key env var gives an actionable error', () => {
  const m = resolveModel(loadConfigFromString(base(), opts()), 'implement');
  assert.throws(() => buildRequest(m, { ...ctx, env: {} }), /OPENAI_API_KEY is not set/);
});

test('unknown keys are errors (typos never silently keep defaults)', () => {
  assert.throws(() => loadConfigFromString(base('budget:\n  max_usd: 1'), opts()), /budget\.max_usd: unknown key/);
  assert.throws(() => loadConfigFromString(base().replace('api_key_env: OPENAI_API_KEY }', 'api_key_env: OPENAI_API_KEY, apikey_env: X }'), opts()), /providers\.openai\.apikey_env: unknown key/);
});

test('boolean strings from env interpolation are honoured', () => {
  const l = loadConfigFromString(base('github:\n  enabled: ${GH_ON:-false}'), opts());
  assert.equal(l.config.github.enabled, false);
});

test('empty UFACTORY_PROFILE falls back to active_profile', () => {
  const t = base('active_profile: cheap\nprofiles:\n  cheap:\n    models:\n      default: { provider: openai, model: gpt-5.1-mini }');
  const l = loadConfigFromString(t, { cwd: '/', env: { ...opts().env, UFACTORY_PROFILE: '' } });
  assert.equal(l.profile, 'cheap');
});

test('env vars interpolated into provider headers are treated as secrets for redaction', () => {
  const t = base().replace('api_key_env: PORTKEY_API_KEY', 'api_key_env: PORTKEY_API_KEY\n    headers: { x-custom-auth: "${MY_GATEWAY_SECRET}" }');
  const l = loadConfigFromString(t, opts({ MY_GATEWAY_SECRET: 'abc-very-secret' }));
  assert.ok(l.secretEnvNames.includes('MY_GATEWAY_SECRET'));
});

test('policy-only load ignores broken model config', () => {
  const l = loadConfigFromString('version: 1\nmodels:\n  default: { provider: nope, model: x }\n', { cwd: '/', env: {}, policyOnly: true });
  assert.equal(l.config.factory.charter, 'docs/factory/CHARTER.md');
});

test('fallback chain resolves in order and inherits role settings', () => {
  const t = base().replace("    verify: { provider: portkey, model: \"@anthropic/claude-sonnet-4-5\" }", "    verify: { provider: portkey, model: \"@anthropic/claude-sonnet-4-5\", reasoning_effort: high, fallbacks: [ { provider: openai, model: gpt-5.1 }, \"@openai/gpt-4.1\" ] }");
  const m = resolveModel(loadConfigFromString(t, opts()), 'verify');
  assert.deepEqual(m.fallbacks.map((f) => `${f.provider.name}:${f.settings.model}`), ['openai:gpt-5.1', 'portkey:@openai/gpt-4.1']);
  assert.equal(m.fallbacks[0]!.settings.reasoning_effort, 'high');
  assert.throws(() => loadConfigFromString(t.replace('"@openai/gpt-4.1"', '{ model: x, fallbacks: [y] }'), opts()), /cannot be nested/);
});
