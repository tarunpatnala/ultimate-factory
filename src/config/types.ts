/** Shapes of factory.config.yaml after validation. */

export type ProviderType = 'openai' | 'portkey' | 'azure-openai' | 'openai-compatible';

export interface ProviderConfig {
  type: ProviderType;
  /** Base URL up to and including the API version path, e.g. https://api.openai.com/v1 */
  base_url: string;
  /** Name of the env var holding the API key. Empty string = no auth (local servers). */
  api_key_env: string;
  /** OpenAI: optional organization / project env var names. */
  organization_env?: string;
  project_env?: string;
  /** Portkey: upstream provider slug, e.g. "openai" or "@my-openai-integration". */
  provider?: string;
  /** Portkey: env var for the upstream provider key (sent as Authorization: Bearer). */
  provider_api_key_env?: string;
  /** Portkey: env var for a legacy virtual key. */
  virtual_key_env?: string;
  /** Portkey: saved config id (pc-...) or env var reference via ${VAR}. */
  config?: string;
  /** Portkey: metadata attached to each request (x-portkey-metadata). */
  metadata?: Record<string, string>;
  /** Azure: api-version query param. When set, the deployments path is used. */
  api_version?: string;
  /** Extra static headers. Values may use ${ENV} interpolation; never put secrets inline. */
  headers?: Record<string, string>;
  timeout_ms: number;
  max_retries: number;
  capabilities: ProviderCapabilities;
}

export interface ProviderCapabilities {
  tools: boolean;
  json_mode: boolean;
  usage: boolean;
  temperature: boolean;
}

export interface ModelSettings {
  provider: string;
  model: string;
  temperature?: number;
  top_p?: number;
  max_output_tokens?: number;
  /** Which request field carries the output limit. OpenAI reasoning models need max_completion_tokens. */
  token_param: 'max_completion_tokens' | 'max_tokens';
  reasoning_effort?: 'minimal' | 'low' | 'medium' | 'high';
  /** Ask for response_format json_object on structured calls. Disable for servers that reject it. */
  json_mode: boolean;
  /** Merged verbatim into the request body (e.g. provider-specific params). */
  extra_body?: Record<string, unknown>;
  /** Tried in order when this model fails after its retries (outage, rate limit, bad deployment). */
  fallbacks?: Array<Partial<ModelSettings>>;
}

export const ROLES = ['triage', 'spec', 'implement', 'verify', 'critic', 'review', 'monitor'] as const;
export type Role = (typeof ROLES)[number];

export interface ModelsConfig {
  default: Partial<ModelSettings> & { provider: string; model: string };
  roles: Partial<Record<Role, Partial<ModelSettings>>>;
}

export interface PriceEntry {
  input_per_mtok: number;
  output_per_mtok: number;
}

export interface FactoryConfig {
  version: 1;
  providers: Record<string, ProviderConfig>;
  models: ModelsConfig;
  profiles: Record<string, { models: Partial<ModelsConfig> }>;
  active_profile?: string;
  factory: {
    charter: string;
    contract: string;
    gates_script: string;
    prove_script: string;
    runs_dir: string;
    specs_dir: string;
  };
  github: {
    enabled: boolean;
    remote: string;
    default_branch?: string;
    branch_prefix: string;
    max_issues_per_triage: number;
    trusted_associations: string[];
    stale_claim_hours: number;
    /** Env var holding the HMAC key that signs handoff comments. Unset variable = unsigned handoffs. */
    handoff_key_env: string;
  };
  budget: {
    max_turns: number;
    max_tokens_per_run: number;
    max_usd_per_run?: number;
    max_runs_per_day: number;
    /** Spend cap over the last 24 hours, summed from run records (implement refuses to start above it). */
    max_usd_per_day?: number;
    max_minutes_per_run: number;
    prices: Record<string, PriceEntry>;
  };
  agent: {
    max_file_bytes: number;
    max_files_listed: number;
    test_command?: string;
    test_paths: string[];
    command_timeout_ms: number;
    allowed_commands: Record<string, string>;
    protected_extra: string[];
    passthrough_env: string[];
    max_refusals: number;
    sandbox: SandboxConfig;
    /** What to do with AI-slop patterns in added lines: refuse finish, note in the PR, or ignore. */
    slop: 'block' | 'warn' | 'off';
  };
  review: {
    personas: string[];
    min_personas: number;
    persona_models: Record<string, Partial<ModelSettings>>;
    concurrency: number;
    /** Blocks needed for a panel "block". Fewer blocks count as request-changes. */
    block_quorum: number;
  };
  spec: {
    format: 'factory' | 'openspec';
  };
  logging: {
    level: 'debug' | 'info' | 'warn' | 'error';
  };
}

export interface SandboxConfig {
  /** none: repository code runs as the factory's OS user. docker/podman: in a throwaway container. */
  mode: 'none' | 'docker' | 'podman';
  /** Image with the repository's toolchain plus git and bash. Required unless mode is none. */
  image?: string;
  /** Container network: none (default) or bridge for test suites that need the network. */
  network: 'none' | 'bridge';
}

export interface ResolvedModel {
  role: Role | string;
  settings: ModelSettings;
  provider: ProviderConfig & { name: string };
  /** Resolved fallback chain (each a complete model), in order. */
  fallbacks: ResolvedModel[];
}
