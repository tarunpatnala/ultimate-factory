import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { ConfigError } from '../util/errors.js';
import {
  ROLES,
  type FactoryConfig,
  type ModelSettings,
  type ModelsConfig,
  type ProviderCapabilities,
  type ProviderConfig,
  type ProviderType,
  type ResolvedModel,
  type Role,
  type SandboxConfig,
} from './types.js';

export const CONFIG_CANDIDATES = ['factory.config.yaml', 'factory.config.yml'];

const PROVIDER_TYPES: ProviderType[] = ['openai', 'portkey', 'azure-openai', 'openai-compatible'];

const DEFAULT_BASE_URL: Record<ProviderType, string | undefined> = {
  openai: 'https://api.openai.com/v1',
  portkey: 'https://api.portkey.ai/v1',
  'azure-openai': undefined,
  'openai-compatible': undefined,
};

export const DEFAULT_PERSONAS = [
  'principal-architect',
  'staff-backend',
  'staff-frontend',
  'security-engineer',
  'sre-reliability',
  'performance-engineer',
  'qa-test-architect',
  'devex-platform',
  'data-engineer',
  'ml-ai-engineer',
];

/** Indicative USD prices per million tokens. Users override in budget.prices. */
export const DEFAULT_PRICES: Record<string, { input_per_mtok: number; output_per_mtok: number }> = {
  'gpt-5.1': { input_per_mtok: 1.25, output_per_mtok: 10 },
  'gpt-5.1-mini': { input_per_mtok: 0.25, output_per_mtok: 2 },
  'gpt-5': { input_per_mtok: 1.25, output_per_mtok: 10 },
  'gpt-5-mini': { input_per_mtok: 0.25, output_per_mtok: 2 },
  'gpt-4.1': { input_per_mtok: 2, output_per_mtok: 8 },
  'o4-mini': { input_per_mtok: 1.1, output_per_mtok: 4.4 },
  'gpt-4.1-mini': { input_per_mtok: 0.4, output_per_mtok: 1.6 },
  'gpt-4o': { input_per_mtok: 2.5, output_per_mtok: 10 },
  'gpt-4o-mini': { input_per_mtok: 0.15, output_per_mtok: 0.6 },
  '*': { input_per_mtok: 3, output_per_mtok: 15 },
};

export interface LoadOptions {
  cwd: string;
  /** policy-check: only factory/agent sections matter; model/provider problems must not break the status check. */
  policyOnly?: boolean;
  configPath?: string;
  profile?: string;
  env?: NodeJS.ProcessEnv;
}

export interface LoadedConfig {
  config: FactoryConfig;
  path: string;
  root: string;
  profile?: string;
  /** Env var names referenced by ${VAR} that were unset (reported by doctor). */
  missingEnv: string[];
  /** Env var names that hold secrets (api keys etc.). Used for redaction and env scrubbing. */
  secretEnvNames: string[];
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

export function findConfigPath(opts: LoadOptions): string {
  const env = opts.env ?? process.env;
  const explicit = opts.configPath ?? env.UFACTORY_CONFIG;
  if (explicit) {
    const p = isAbsolute(explicit) ? explicit : resolve(opts.cwd, explicit);
    if (!existsSync(p)) throw new ConfigError(`config file not found: ${p}`);
    return p;
  }
  for (const name of CONFIG_CANDIDATES) {
    const p = join(opts.cwd, name);
    if (existsSync(p)) return p;
  }
  throw new ConfigError(
    `no config file found. Searched: ${CONFIG_CANDIDATES.map((c) => join(opts.cwd, c)).join(', ')}. ` +
      `Run "ufactory init" or pass --config.`,
  );
}

export function loadConfig(opts: LoadOptions): LoadedConfig {
  const path = findConfigPath(opts);
  const text = readFileSync(path, 'utf8');
  return loadConfigFromString(text, { ...opts, configPath: path });
}

export function loadConfigFromString(text: string, opts: LoadOptions): LoadedConfig {
  const env = opts.env ?? process.env;
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (e) {
    throw new ConfigError(`invalid YAML in config: ${(e as Error).message}`);
  }
  if (!isObj(raw)) throw new ConfigError('config must be a YAML mapping');

  // Secret scan happens on the raw (pre-interpolation) document so values that come from
  // ${ENV} are allowed and literals are not.
  const secretProblems: string[] = [];
  scanForSecrets(raw, '', secretProblems);
  if (secretProblems.length) {
    throw new ConfigError(
      `config contains inline secrets (use *_env fields or \${ENV} references instead):\n  - ${secretProblems.join('\n  - ')}`,
    );
  }

  const missingEnv = new Set<string>();
  const interpolated = interpolate(raw, env, missingEnv) as Record<string, unknown>;
  const errors: string[] = [];
  checkUnknownKeys(interpolated, errors);
  const config = normalize(interpolated, errors, opts.policyOnly === true);
  if (errors.length) throw new ConfigError(`invalid config:\n  - ${errors.join('\n  - ')}`);

  // Empty strings (e.g. an unset Actions variable) mean "not set".
  const profile = opts.profile || env.UFACTORY_PROFILE || config.active_profile || undefined;
  if (profile && !config.profiles[profile]) {
    throw new ConfigError(
      `profile "${profile}" is not defined. Defined profiles: ${Object.keys(config.profiles).join(', ') || '(none)'}`,
    );
  }

  const secretEnvNames = [...new Set([...collectSecretEnvNames(config), ...envRefs(isObj(raw) ? raw.providers : undefined)])];
  const loaded: LoadedConfig = {
    config,
    path: opts.configPath ?? '(inline)',
    root: opts.cwd,
    profile,
    missingEnv: [...missingEnv],
    secretEnvNames,
  };
  // Validate every role resolves (fail early on dangling provider references).
  if (opts.policyOnly) return loaded;
  for (const role of ROLES) resolveModel(loaded, role);
  for (const persona of Object.keys(config.review.persona_models)) resolveModel(loaded, 'review', persona);
  return loaded;
}

// ---------------------------------------------------------------------------
// Secret scanning
// ---------------------------------------------------------------------------

const SECRET_KEY_NAMES = /^(api[_-]?key|apikey|token|secret|password|access[_-]?token|client[_-]?secret)$/i;
const SECRET_VALUE_PATTERNS: Array<[RegExp, string]> = [
  [/\bsk-[A-Za-z0-9_-]{16,}/, 'OpenAI-style secret key (sk-...)'],
  [/\bpk-[A-Za-z0-9_-]{16,}/, 'key-like value (pk-...)'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/i, 'Bearer token'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/, 'GitHub token'],
  [/\b[A-Fa-f0-9]{40,}\b/, 'long hex string'],
  [/\b[A-Za-z0-9+/]{48,}={0,2}(?![A-Za-z0-9+/=])/, 'long base64 string'],
];

function scanForSecrets(node: unknown, path: string, problems: string[]): void {
  if (Array.isArray(node)) {
    node.forEach((v, i) => scanForSecrets(v, `${path}[${i}]`, problems));
    return;
  }
  if (isObj(node)) {
    for (const [k, v] of Object.entries(node)) {
      const p = path ? `${path}.${k}` : k;
      if (SECRET_KEY_NAMES.test(k) && typeof v === 'string' && v.trim() !== '' && !isPureEnvRef(v)) {
        problems.push(`${p}: literal secret value; use "${k}_env: YOUR_ENV_VAR"`);
        continue;
      }
      scanForSecrets(v, p, problems);
    }
    return;
  }
  if (typeof node === 'string') {
    const withoutRefs = node.replace(/\$\{[^}]*\}/g, '');
    for (const [re, label] of SECRET_VALUE_PATTERNS) {
      if (re.test(withoutRefs)) {
        problems.push(`${path}: looks like a ${label}`);
        return;
      }
    }
    if (/^[a-z][a-z0-9+.-]*:\/\/[^/\s]*@/i.test(withoutRefs)) {
      problems.push(`${path}: URL contains embedded credentials`);
    }
  }
}

function isPureEnvRef(v: string): boolean {
  return /^\$\{[A-Za-z_][A-Za-z0-9_]*(:-[^}]*)?\}$/.test(v.trim());
}

// ---------------------------------------------------------------------------
// Interpolation
// ---------------------------------------------------------------------------

function interpolate(node: unknown, env: NodeJS.ProcessEnv, missing: Set<string>): unknown {
  if (Array.isArray(node)) return node.map((v) => interpolate(v, env, missing));
  if (isObj(node)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) out[k] = interpolate(v, env, missing);
    return out;
  }
  if (typeof node === 'string') {
    return node.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_m, name: string, def?: string) => {
      const v = env[name];
      if (v !== undefined && v !== '') return v;
      if (def !== undefined) return def;
      missing.add(name);
      return '';
    });
  }
  return node;
}

// ---------------------------------------------------------------------------
// Normalization + validation
// ---------------------------------------------------------------------------

function normalize(raw: Record<string, unknown>, errors: string[], policyOnly = false): FactoryConfig {
  if (raw.version !== undefined && raw.version !== 1) errors.push('version: must be 1');

  const providers: Record<string, ProviderConfig> = {};
  const rawProviders = raw.providers;
  if (!isObj(rawProviders) || Object.keys(rawProviders).length === 0) {
    if (!policyOnly) errors.push('providers: at least one provider is required');
  } else {
    for (const [name, p] of Object.entries(rawProviders)) {
      const np = normalizeProvider(name, p, errors);
      if (np) providers[name] = np;
    }
  }

  const models = normalizeModels(raw.models, 'models', policyOnly ? [] : errors, !policyOnly) as ModelsConfig;

  const profiles: FactoryConfig['profiles'] = {};
  if (raw.profiles !== undefined) {
    if (!isObj(raw.profiles)) errors.push('profiles: must be a mapping');
    else
      for (const [name, prof] of Object.entries(raw.profiles)) {
        if (!isObj(prof)) {
          errors.push(`profiles.${name}: must be a mapping`);
          continue;
        }
        profiles[name] = { models: normalizeModels(prof.models ?? {}, `profiles.${name}.models`, errors, false) };
      }
  }

  const factory = obj(raw.factory);
  const github = obj(raw.github);
  const budget = obj(raw.budget);
  const agent = obj(raw.agent);
  const review = obj(raw.review);
  const spec = obj(raw.spec);
  const logging = obj(raw.logging);

  const cfg: FactoryConfig = {
    version: 1,
    providers,
    models,
    profiles,
    active_profile: optStr(raw.active_profile, 'active_profile', errors),
    factory: {
      charter: str(factory.charter, 'docs/factory/CHARTER.md'),
      contract: str(factory.contract, 'docs/factory/CONTRACT.md'),
      gates_script: str(factory.gates_script, '.factory/scripts/gates.sh'),
      prove_script: str(factory.prove_script, '.factory/scripts/prove-test.sh'),
      runs_dir: str(factory.runs_dir, 'docs/factory/runs'),
      specs_dir: str(factory.specs_dir, 'docs/factory/specs'),
    },
    github: {
      enabled: bool(github.enabled, true),
      remote: str(github.remote, 'origin'),
      default_branch: optStr(github.default_branch, 'github.default_branch', errors),
      branch_prefix: str(github.branch_prefix, 'factory/'),
      max_issues_per_triage: int(github.max_issues_per_triage, 20, 'github.max_issues_per_triage', errors, 1, 100),
      trusted_associations: strList(github.trusted_associations, ['OWNER', 'MEMBER', 'COLLABORATOR'], 'github.trusted_associations', errors).map((s) => s.toUpperCase()),
      stale_claim_hours: num(github.stale_claim_hours, 2, 'github.stale_claim_hours', errors),
      handoff_key_env: str(github.handoff_key_env, 'UFACTORY_HANDOFF_KEY'),
    },
    budget: {
      max_turns: int(budget.max_turns, 40, 'budget.max_turns', errors, 1, 500),
      max_tokens_per_run: int(budget.max_tokens_per_run, 400_000, 'budget.max_tokens_per_run', errors, 1000),
      max_usd_per_run: budget.max_usd_per_run === null ? undefined : num(budget.max_usd_per_run, 5, 'budget.max_usd_per_run', errors),
      max_runs_per_day: int(budget.max_runs_per_day, 50, 'budget.max_runs_per_day', errors, 1),
      max_usd_per_day: budget.max_usd_per_day === undefined || budget.max_usd_per_day === null ? undefined : num(budget.max_usd_per_day, 0, 'budget.max_usd_per_day', errors),
      max_minutes_per_run: num(budget.max_minutes_per_run, 50, 'budget.max_minutes_per_run', errors),
      prices: { ...DEFAULT_PRICES, ...normalizePrices(budget.prices, errors) },
    },
    agent: {
      max_file_bytes: int(agent.max_file_bytes, 20_000, 'agent.max_file_bytes', errors, 1000),
      max_files_listed: int(agent.max_files_listed, 500, 'agent.max_files_listed', errors, 10),
      test_command: optStr(agent.test_command, 'agent.test_command', errors),
      test_paths: strList(agent.test_paths, ['**/test/**', '**/tests/**', '**/__tests__/**', '**/spec/**', '**/*.test.*', '**/*.spec.*', '**/test_*.py', '**/*_test.py', '**/*_test.go', '**/*Test.java', '**/*Tests.java', '**/*IT.java', '**/*Test.kt', '**/*Tests.cs', '**/*Test.cs', '**/*.Tests/**', '**/*.UnitTests/**', '**/*.IntegrationTests/**', '**/*.Specs/**', '**/*Tests.fs', '**/*_spec.rb', '**/*_test.rb', '**/*Test.php', '**/*_test.exs'], 'agent.test_paths', errors),
      command_timeout_ms: int(agent.command_timeout_ms, 600_000, 'agent.command_timeout_ms', errors, 1000),
      allowed_commands: strMap(agent.allowed_commands, 'agent.allowed_commands', errors),
      protected_extra: strList(agent.protected_extra, [], 'agent.protected_extra', errors),
      passthrough_env: strList(agent.passthrough_env, [], 'agent.passthrough_env', errors),
      max_refusals: int(agent.max_refusals, 5, 'agent.max_refusals', errors, 1, 50),
      sandbox: normalizeSandbox(agent.sandbox, errors),
      slop: oneOf(agent.slop, ['block', 'warn', 'off'] as const, 'block', 'agent.slop', errors),
    },
    review: {
      personas: strList(review.personas, DEFAULT_PERSONAS, 'review.personas', errors),
      min_personas: int(review.min_personas, 10, 'review.min_personas', errors, 1, 50),
      persona_models: {},
      concurrency: int(review.concurrency, 4, 'review.concurrency', errors, 1, 20),
      block_quorum: int(review.block_quorum, 2, 'review.block_quorum', errors, 1, 50),
    },
    spec: {
      format: oneOf(spec.format, ['factory', 'openspec'] as const, 'factory', 'spec.format', errors),
    },
    logging: {
      level: oneOf(logging.level, ['debug', 'info', 'warn', 'error'] as const, 'info', 'logging.level', errors),
    },
  };

  if (isObj(review.persona_models)) {
    for (const [id, m] of Object.entries(review.persona_models)) {
      cfg.review.persona_models[id] = normalizeModelSettings(m, `review.persona_models.${id}`, errors, false);
    }
  }
  if (cfg.review.personas.length < cfg.review.min_personas) {
    errors.push(`review.personas: ${cfg.review.personas.length} personas selected but review.min_personas is ${cfg.review.min_personas}`);
  }
  for (const pa of cfg.agent.passthrough_env) {
    if (/KEY|TOKEN|SECRET|PASSWORD/i.test(pa)) errors.push(`agent.passthrough_env: "${pa}" looks like a secret and cannot be passed to gate/test commands`);
  }
  return cfg;
}

function normalizeSandbox(raw: unknown, errors: string[]): SandboxConfig {
  const o = obj(raw);
  if (raw !== undefined && !isObj(raw)) errors.push('agent.sandbox: must be a mapping');
  for (const k of Object.keys(o)) if (!['mode', 'image', 'network'].includes(k)) errors.push(`agent.sandbox.${k}: unknown key (allowed: mode, image, network)`);
  const sb: SandboxConfig = {
    mode: oneOf(o.mode, ['none', 'docker', 'podman'] as const, 'none', 'agent.sandbox.mode', errors),
    image: optStr(o.image, 'agent.sandbox.image', errors),
    network: oneOf(o.network, ['none', 'bridge'] as const, 'none', 'agent.sandbox.network', errors),
  };
  if (sb.mode !== 'none' && !sb.image) errors.push(`agent.sandbox.image: required when agent.sandbox.mode is ${sb.mode}`);
  return sb;
}

function normalizeProvider(name: string, p: unknown, errors: string[]): ProviderConfig | undefined {
  const at = `providers.${name}`;
  if (!isObj(p)) {
    errors.push(`${at}: must be a mapping`);
    return undefined;
  }
  const type = p.type as ProviderType;
  if (!PROVIDER_TYPES.includes(type)) {
    errors.push(`${at}.type: must be one of ${PROVIDER_TYPES.join(', ')} (got ${JSON.stringify(p.type)})`);
    return undefined;
  }
  const baseUrl = str(p.base_url, DEFAULT_BASE_URL[type] ?? '');
  if (!baseUrl) errors.push(`${at}.base_url: required for type ${type}`);
  else if (!/^https?:\/\//.test(baseUrl)) errors.push(`${at}.base_url: must start with http:// or https://`);
  const apiKeyEnv = p.api_key_env === undefined ? defaultKeyEnv(type) : String(p.api_key_env ?? '');
  if (type !== 'openai-compatible' && !apiKeyEnv) errors.push(`${at}.api_key_env: required for type ${type}`);
  const caps = obj(p.capabilities);
  const capabilities: ProviderCapabilities = {
    tools: bool(caps.tools, true),
    json_mode: bool(caps.json_mode, true),
    usage: bool(caps.usage, true),
    temperature: bool(caps.temperature, true),
  };
  const headers = p.headers === undefined ? undefined : strMap(p.headers, `${at}.headers`, errors);
  const metadata = p.metadata === undefined ? undefined : strMap(p.metadata, `${at}.metadata`, errors);
  return {
    type,
    base_url: baseUrl.replace(/\/+$/, ''),
    api_key_env: apiKeyEnv,
    organization_env: optStr(p.organization_env, `${at}.organization_env`, errors),
    project_env: optStr(p.project_env, `${at}.project_env`, errors),
    provider: optStr(p.provider, `${at}.provider`, errors) || undefined,
    provider_api_key_env: optStr(p.provider_api_key_env, `${at}.provider_api_key_env`, errors) || undefined,
    virtual_key_env: optStr(p.virtual_key_env, `${at}.virtual_key_env`, errors) || undefined,
    config: optStr(p.config, `${at}.config`, errors) || undefined,
    metadata,
    api_version: optStr(p.api_version, `${at}.api_version`, errors) || undefined,
    headers,
    timeout_ms: int(p.timeout_ms, 120_000, `${at}.timeout_ms`, errors, 1000),
    max_retries: int(p.max_retries, 4, `${at}.max_retries`, errors, 0, 10),
    capabilities,
  };
}

function defaultKeyEnv(type: ProviderType): string {
  switch (type) {
    case 'openai':
      return 'OPENAI_API_KEY';
    case 'portkey':
      return 'PORTKEY_API_KEY';
    case 'azure-openai':
      return 'AZURE_OPENAI_API_KEY';
    default:
      return '';
  }
}

function normalizeModels(raw: unknown, at: string, errors: string[], requireDefault: boolean): Partial<ModelsConfig> {
  if (!isObj(raw)) {
    if (requireDefault) errors.push(`${at}: required (with a "default" entry)`);
    return { roles: {} } as Partial<ModelsConfig>;
  }
  const out: Partial<ModelsConfig> = { roles: {} };
  if (raw.default !== undefined) {
    out.default = normalizeModelSettings(raw.default, `${at}.default`, errors, requireDefault) as ModelsConfig['default'];
  } else if (requireDefault) {
    errors.push(`${at}.default: required (provider + model)`);
  }
  if (raw.roles !== undefined) {
    if (!isObj(raw.roles)) errors.push(`${at}.roles: must be a mapping`);
    else
      for (const [role, m] of Object.entries(raw.roles)) {
        if (!(ROLES as readonly string[]).includes(role)) {
          errors.push(`${at}.roles.${role}: unknown role (valid: ${ROLES.join(', ')})`);
          continue;
        }
        out.roles![role as Role] = normalizeModelSettings(m, `${at}.roles.${role}`, errors, false);
      }
  }
  return out;
}

function normalizeModelSettings(raw: unknown, at: string, errors: string[], requireCore: boolean): Partial<ModelSettings> {
  if (typeof raw === 'string') raw = { model: raw };
  if (!isObj(raw)) {
    errors.push(`${at}: must be a mapping or a model name`);
    return {};
  }
  const out: Partial<ModelSettings> = {};
  if (raw.provider !== undefined) out.provider = String(raw.provider);
  if (raw.model !== undefined) out.model = String(raw.model);
  if (requireCore) {
    if (!out.provider) errors.push(`${at}.provider: required`);
    if (!out.model) errors.push(`${at}.model: required`);
  }
  if (raw.temperature !== undefined) out.temperature = num(raw.temperature, 0, `${at}.temperature`, errors);
  if (raw.top_p !== undefined) out.top_p = num(raw.top_p, 1, `${at}.top_p`, errors);
  if (raw.max_output_tokens !== undefined) out.max_output_tokens = int(raw.max_output_tokens, 4096, `${at}.max_output_tokens`, errors, 16);
  if (raw.token_param !== undefined) out.token_param = oneOf(raw.token_param, ['max_completion_tokens', 'max_tokens'] as const, 'max_completion_tokens', `${at}.token_param`, errors);
  if (raw.reasoning_effort !== undefined) out.reasoning_effort = oneOf(raw.reasoning_effort, ['minimal', 'low', 'medium', 'high'] as const, 'medium', `${at}.reasoning_effort`, errors);
  if (raw.json_mode !== undefined) out.json_mode = bool(raw.json_mode, true);
  if (raw.extra_body !== undefined) {
    if (!isObj(raw.extra_body)) errors.push(`${at}.extra_body: must be a mapping`);
    else out.extra_body = raw.extra_body;
  }
  if (raw.fallbacks !== undefined) {
    if (!Array.isArray(raw.fallbacks)) errors.push(`${at}.fallbacks: must be a list of models (name or {provider, model})`);
    else out.fallbacks = raw.fallbacks.map((f, i) => {
      const fb = normalizeModelSettings(f, `${at}.fallbacks[${i}]`, errors, false);
      if (fb.fallbacks) errors.push(`${at}.fallbacks[${i}]: fallbacks cannot be nested`);
      return fb;
    });
  }
  return out;
}

function normalizePrices(raw: unknown, errors: string[]): FactoryConfig['budget']['prices'] {
  const out: FactoryConfig['budget']['prices'] = {};
  if (raw === undefined) return out;
  if (!isObj(raw)) {
    errors.push('budget.prices: must be a mapping of model -> {input_per_mtok, output_per_mtok}');
    return out;
  }
  for (const [model, p] of Object.entries(raw)) {
    const o = obj(p);
    out[model] = {
      input_per_mtok: num(o.input_per_mtok, 0, `budget.prices.${model}.input_per_mtok`, errors),
      output_per_mtok: num(o.output_per_mtok, 0, `budget.prices.${model}.output_per_mtok`, errors),
    };
  }
  return out;
}

function collectSecretEnvNames(cfg: FactoryConfig): string[] {
  const names = new Set<string>(['OPENAI_API_KEY', 'PORTKEY_API_KEY', 'AZURE_OPENAI_API_KEY', 'GITHUB_TOKEN', 'GH_TOKEN']);
  if (cfg.github.handoff_key_env) names.add(cfg.github.handoff_key_env);
  for (const p of Object.values(cfg.providers)) {
    for (const n of [p.api_key_env, p.provider_api_key_env, p.virtual_key_env]) if (n) names.add(n);
  }
  return [...names];
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

export function resolveModel(loaded: LoadedConfig, role: Role | string, persona?: string): ResolvedModel {
  const primary = resolveOne(loaded, role, persona);
  const chain = primary.settingsFallbacks.map((fb, i) => {
    // A fallback inherits the role's settings except provider/model unless it overrides them.
    const { fallbacks: _ignored, ...base } = primary.merged;
    const r = resolveOne(loaded, role, persona, { ...base, ...fb, provider: fb.provider ?? (fb.model ? base.provider : undefined) ?? base.provider }, `fallbacks[${i}]`);
    return { role, settings: r.settings, provider: r.provider, fallbacks: [] };
  });
  return { role, settings: primary.settings, provider: primary.provider, fallbacks: chain };
}

function resolveOne(loaded: LoadedConfig, role: Role | string, persona?: string, override?: Partial<ModelSettings>, label = '') {
  const { config } = loaded;
  const prof = loaded.profile ? config.profiles[loaded.profile]?.models : undefined;
  const r = role as Role;
  const merged: Partial<ModelSettings> = override ?? {
    ...config.models.default,
    ...(prof?.default ?? {}),
    ...(config.models.roles[r] ?? {}),
    ...(prof?.roles?.[r] ?? {}),
    ...(persona ? (config.review.persona_models[persona] ?? {}) : {}),
  };
  const where = `role ${role}${persona ? `/${persona}` : ''}${label ? ` ${label}` : ''}`;
  if (!merged.provider || !merged.model) {
    throw new ConfigError(`${where}: no provider/model resolved`);
  }
  const provider = config.providers[merged.provider];
  if (!provider) {
    throw new ConfigError(
      `${where}: provider "${merged.provider}" is not defined in providers (defined: ${Object.keys(config.providers).join(', ')})`,
    );
  }
  if (provider.type === 'portkey' && !provider.config && !provider.virtual_key_env && !provider.provider && !merged.model.startsWith('@')) {
    throw new ConfigError(
      `${where}: Portkey provider "${merged.provider}" cannot route model "${merged.model}". ` +
        `Use a model catalog name like "@openai-prod/${merged.model}", or set provider, virtual_key_env or config on the provider.`,
    );
  }
  const settings: ModelSettings = {
    provider: merged.provider,
    model: merged.model,
    temperature: merged.temperature,
    top_p: merged.top_p,
    max_output_tokens: merged.max_output_tokens,
    token_param: merged.token_param ?? (provider.type === 'openai-compatible' ? 'max_tokens' : 'max_completion_tokens'),
    reasoning_effort: merged.reasoning_effort,
    json_mode: merged.json_mode ?? provider.capabilities.json_mode,
    extra_body: merged.extra_body,
  };
  return { settings, provider: { ...provider, name: merged.provider }, merged, settingsFallbacks: merged.fallbacks ?? [] };
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

export function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function obj(v: unknown): Record<string, unknown> {
  return isObj(v) ? v : {};
}
function str(v: unknown, def: string): string {
  return typeof v === 'string' && v !== '' ? v : def;
}
function optStr(v: unknown, at: string, errors: string[]): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') {
    errors.push(`${at}: must be a string`);
    return undefined;
  }
  return v;
}
function bool(v: unknown, def: boolean): boolean {
  if (typeof v === 'boolean') return v;
  if (v === 'true') return true;
  if (v === 'false') return false;
  return def;
}

/** Every ${VAR} referenced under a node: values interpolated into provider settings are secrets. */
function envRefs(node: unknown, out: string[] = []): string[] {
  if (typeof node === 'string') for (const m of node.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)/g)) out.push(m[1]!);
  else if (Array.isArray(node)) node.forEach((n) => envRefs(n, out));
  else if (isObj(node)) Object.values(node).forEach((n) => envRefs(n, out));
  return out;
}

const KNOWN_KEYS: Record<string, string[]> = {
  '': ['version', 'providers', 'models', 'profiles', 'active_profile', 'factory', 'github', 'budget', 'agent', 'review', 'spec', 'logging'],
  factory: ['charter', 'contract', 'gates_script', 'prove_script', 'runs_dir', 'specs_dir'],
  github: ['enabled', 'remote', 'default_branch', 'branch_prefix', 'max_issues_per_triage', 'trusted_associations', 'stale_claim_hours', 'handoff_key_env'],
  budget: ['max_turns', 'max_tokens_per_run', 'max_usd_per_run', 'max_runs_per_day', 'max_usd_per_day', 'max_minutes_per_run', 'prices'],
  agent: ['max_file_bytes', 'max_files_listed', 'test_command', 'test_paths', 'command_timeout_ms', 'allowed_commands', 'protected_extra', 'passthrough_env', 'max_refusals', 'sandbox', 'slop'],
  review: ['personas', 'min_personas', 'persona_models', 'concurrency', 'block_quorum'],
  spec: ['format'],
  logging: ['level'],
};
const PROVIDER_KEYS = ['type', 'base_url', 'api_key_env', 'organization_env', 'project_env', 'provider', 'provider_api_key_env', 'virtual_key_env', 'config', 'metadata', 'api_version', 'headers', 'timeout_ms', 'max_retries', 'capabilities'];
const MODEL_KEYS = ['provider', 'model', 'temperature', 'top_p', 'max_output_tokens', 'token_param', 'reasoning_effort', 'json_mode', 'extra_body', 'fallbacks'];

/** Unknown keys are errors: a typo such as budget.max_usd must not silently keep the default. */
function checkUnknownKeys(raw: Record<string, unknown>, errors: string[]): void {
  const check = (obj: unknown, allowed: string[], at: string) => {
    if (!isObj(obj)) return;
    for (const k of Object.keys(obj)) if (!allowed.includes(k)) errors.push(`${at ? at + '.' : ''}${k}: unknown key (allowed: ${allowed.join(', ')})`);
  };
  check(raw, KNOWN_KEYS['']!, '');
  for (const [section, keys] of Object.entries(KNOWN_KEYS)) if (section) check(raw[section], keys, section);
  if (isObj(raw.providers)) for (const [n, p] of Object.entries(raw.providers)) check(p, PROVIDER_KEYS, `providers.${n}`);
  const checkModels = (m: unknown, at: string) => {
    if (!isObj(m)) return;
    check(m, ['default', 'roles'], at);
    if (isObj(m.default)) check(m.default, MODEL_KEYS, `${at}.default`);
    if (isObj(m.roles)) for (const [r, v] of Object.entries(m.roles)) if (isObj(v)) check(v, MODEL_KEYS, `${at}.roles.${r}`);
  };
  checkModels(raw.models, 'models');
  if (isObj(raw.profiles)) for (const [n, p] of Object.entries(raw.profiles)) if (isObj(p)) { check(p, ['models'], `profiles.${n}`); checkModels(p.models, `profiles.${n}.models`); }
}
function num(v: unknown, def: number, at: string, errors: string[]): number {
  if (v === undefined || v === null || v === '') return def;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) {
    errors.push(`${at}: must be a number`);
    return def;
  }
  return n;
}
function int(v: unknown, def: number, at: string, errors: string[], min = 0, max = Number.MAX_SAFE_INTEGER): number {
  const n = num(v, def, at, errors);
  if (!Number.isInteger(n) || n < min || n > max) {
    errors.push(`${at}: must be an integer between ${min} and ${max}`);
    return def;
  }
  return n;
}
function strList(v: unknown, def: string[], at: string, errors: string[]): string[] {
  if (v === undefined || v === null) return def;
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) {
    errors.push(`${at}: must be a list of strings`);
    return def;
  }
  return v as string[];
}
function strMap(v: unknown, at: string, errors: string[]): Record<string, string> {
  if (v === undefined || v === null) return {};
  if (!isObj(v)) {
    errors.push(`${at}: must be a mapping of strings`);
    return {};
  }
  const out: Record<string, string> = {};
  for (const [k, x] of Object.entries(v)) {
    if (typeof x !== 'string' && typeof x !== 'number' && typeof x !== 'boolean') errors.push(`${at}.${k}: must be a string`);
    else out[k] = String(x);
  }
  return out;
}
function oneOf<T extends string>(v: unknown, allowed: readonly T[], def: T, at: string, errors: string[]): T {
  if (v === undefined || v === null) return def;
  if (!allowed.includes(v as T)) {
    errors.push(`${at}: must be one of ${allowed.join(', ')}`);
    return def;
  }
  return v as T;
}
