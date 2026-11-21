import type { ResolvedModel } from '../config/types.js';
import { ConfigError } from '../util/errors.js';

export interface BuiltRequest {
  url: string;
  headers: Record<string, string>;
}

export interface RequestContext {
  runId: string;
  stage: string;
  purpose?: string;
  env?: NodeJS.ProcessEnv;
}

/** Build URL + headers for one chat completion call. Pure function, unit tested. */
export function buildRequest(m: ResolvedModel, ctx: RequestContext): BuiltRequest {
  const env = ctx.env ?? process.env;
  const p = m.provider;
  const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' };
  const key = p.api_key_env ? env[p.api_key_env] : undefined;
  if (p.api_key_env && !key && p.type !== 'openai-compatible') {
    throw new ConfigError(`environment variable ${p.api_key_env} is not set (needed by provider "${p.name}")`);
  }
  let url = `${p.base_url}/chat/completions`;

  switch (p.type) {
    case 'openai':
    case 'openai-compatible': {
      if (key) headers.authorization = `Bearer ${key}`;
      if (p.organization_env && env[p.organization_env]) headers['openai-organization'] = env[p.organization_env]!;
      if (p.project_env && env[p.project_env]) headers['openai-project'] = env[p.project_env]!;
      break;
    }
    case 'azure-openai': {
      headers['api-key'] = key!;
      url = p.api_version
        ? `${p.base_url}/openai/deployments/${encodeURIComponent(m.settings.model)}/chat/completions?api-version=${encodeURIComponent(p.api_version)}`
        : `${p.base_url}/openai/v1/chat/completions`;
      break;
    }
    case 'portkey': {
      headers['x-portkey-api-key'] = key!;
      headers['x-portkey-trace-id'] = ctx.runId;
      headers['x-portkey-metadata'] = JSON.stringify({
        ...(p.metadata ?? {}),
        run_id: ctx.runId,
        stage: ctx.stage,
        role: String(m.role),
        ...(ctx.purpose ? { purpose: ctx.purpose } : {}),
        _user: 'ultimate-factory',
      });
      if (p.config) {
        headers['x-portkey-config'] = p.config;
      } else if (p.virtual_key_env) {
        const vk = env[p.virtual_key_env];
        if (!vk) throw new ConfigError(`environment variable ${p.virtual_key_env} is not set (Portkey virtual key for "${p.name}")`);
        headers['x-portkey-virtual-key'] = vk;
      } else if (p.provider) {
        headers['x-portkey-provider'] = p.provider;
        if (p.provider_api_key_env) {
          const pk = env[p.provider_api_key_env];
          if (!pk) throw new ConfigError(`environment variable ${p.provider_api_key_env} is not set (upstream key for Portkey provider "${p.provider}")`);
          headers.authorization = `Bearer ${pk}`;
        }
      } else if (!m.settings.model.startsWith('@')) {
        throw new ConfigError(`Portkey provider "${p.name}" has no config, virtual key or provider, and model "${m.settings.model}" is not a catalog reference (@slug/model)`);
      }
      break;
    }
  }
  for (const [k, v] of Object.entries(p.headers ?? {})) headers[k.toLowerCase()] = v;
  return { url, headers };
}

export function buildBody(m: ResolvedModel, req: { messages: unknown[]; tools?: unknown[]; json?: boolean }): Record<string, unknown> {
  const s = m.settings;
  const body: Record<string, unknown> = { model: s.model, messages: req.messages };
  if (req.tools && req.tools.length) {
    body.tools = req.tools;
    body.tool_choice = 'auto';
  }
  if (s.temperature !== undefined && m.provider.capabilities.temperature) body.temperature = s.temperature;
  if (s.top_p !== undefined && m.provider.capabilities.temperature) body.top_p = s.top_p;
  if (s.max_output_tokens) body[s.token_param] = s.max_output_tokens;
  if (s.reasoning_effort) body.reasoning_effort = s.reasoning_effort;
  if (req.json && s.json_mode && m.provider.capabilities.json_mode && !(req.tools && req.tools.length)) {
    body.response_format = { type: 'json_object' };
  }
  if (s.extra_body) Object.assign(body, s.extra_body);
  return body;
}
