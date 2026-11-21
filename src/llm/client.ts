import type { ResolvedModel } from '../config/types.js';
import { LlmError } from '../util/errors.js';
import type { Logger } from '../util/log.js';
import type { Redactor } from '../util/redact.js';
import { extractJson } from './json.js';
import { buildBody, buildRequest } from './providers.js';
import type { ChatMessage, ChatRequest, ChatResult, LlmLike, ToolCall } from './types.js';
import { estimateTokens, type UsageTracker } from './usage.js';

export const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

export interface ClientDeps {
  runId: string;
  stage: string;
  usage: UsageTracker;
  log: Logger;
  redactor: Redactor;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export class LlmClient implements LlmLike {
  constructor(
    readonly model: ResolvedModel,
    private readonly deps: ClientDeps,
  ) {}

  get label(): string {
    return `${this.model.provider.name}:${this.model.settings.model}`;
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    const { usage, log, redactor } = this.deps;
    usage.checkBeforeCall(estimateTokens(JSON.stringify(req.messages)));
    const purpose = req.purpose ?? String(this.model.role);
    const { url, headers } = buildRequest(this.model, { runId: this.deps.runId, stage: this.deps.stage, purpose, env: this.deps.env });
    if (req.tools?.length && !this.model.provider.capabilities.tools) {
      throw new LlmError(`provider "${this.model.provider.name}" is configured without tool support; it cannot run ${purpose}`);
    }
    const body = buildBody(this.model, req);
    const fetchImpl = this.deps.fetchImpl ?? fetch;
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    const random = this.deps.random ?? Math.random;
    const maxRetries = this.model.provider.max_retries;
    const started = Date.now();
    let attempt = 0;
    let lastErr: LlmError | undefined;

    while (attempt <= maxRetries) {
      attempt++;
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), this.model.provider.timeout_ms);
      let res: Response;
      let text: string;
      try {
        log.debug(`llm ${purpose} -> ${this.label} attempt ${attempt} ${redactor.redact(url)}`);
        res = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body), signal: ac.signal });
        // The timeout also covers reading the body: a stalled stream must not hang the run.
        text = await res.text();
      } catch (e) {
        clearTimeout(timer);
        const aborted = (e as Error).name === 'AbortError';
        lastErr = new LlmError(
          redactor.redact(`${this.label}: ${aborted ? `timed out after ${this.model.provider.timeout_ms}ms` : `network error: ${(e as Error).message}`}`),
          undefined,
          true,
        );
        if (attempt > maxRetries) break;
        await sleep(backoff(attempt, random));
        continue;
      }
      clearTimeout(timer);
      if (!res.ok) {
        const msg = redactor.redact(`${this.label}: HTTP ${res.status} ${summarizeError(text)}`);
        const retryable = RETRYABLE_STATUS.has(res.status);
        lastErr = new LlmError(msg, res.status, retryable);
        if (!retryable || attempt > maxRetries) break;
        const ra = parseRetryAfter(res.headers.get('retry-after'));
        const wait = ra !== undefined ? Math.min(ra, 60_000) : backoff(attempt, random);
        log.warn(`${msg}; retrying in ${Math.round(wait)}ms`);
        await sleep(wait);
        continue;
      }
      let data: any;
      try {
        data = JSON.parse(text);
      } catch {
        // A gateway or proxy error page with status 200: transient, retry.
        lastErr = new LlmError(redactor.redact(`${this.label}: response was not JSON: ${text.slice(0, 200)}`), res.status, true);
        if (attempt > maxRetries) break;
        await sleep(backoff(attempt, random));
        continue;
      }
      const choice = data?.choices?.[0];
      if (!choice) throw new LlmError(redactor.redact(`${this.label}: response had no choices: ${text.slice(0, 300)}`));
      const msg = choice.message ?? {};
      const content: string = typeof msg.content === 'string' ? msg.content : Array.isArray(msg.content) ? msg.content.map((p: any) => p?.text ?? '').join('') : '';
      const toolCalls: ToolCall[] = Array.isArray(msg.tool_calls)
        ? msg.tool_calls
            .filter((t: any) => t?.function?.name)
            .map((t: any, i: number) => ({
              id: String(t.id ?? `call_${i}`),
              type: 'function' as const,
              function: { name: String(t.function.name), arguments: typeof t.function.arguments === 'string' ? t.function.arguments : JSON.stringify(t.function.arguments ?? {}) },
            }))
        : [];
      const u = data.usage;
      const hasUsage = this.model.provider.capabilities.usage && u && typeof u.prompt_tokens === 'number';
      const promptTokens = hasUsage ? u.prompt_tokens : estimateTokens(JSON.stringify(req.messages));
      const completionTokens = hasUsage ? (u.completion_tokens ?? 0) : estimateTokens(content + JSON.stringify(toolCalls));
      const result: ChatResult = {
        content,
        toolCalls,
        finishReason: String(choice.finish_reason ?? 'stop'),
        servedModel: String(data.model ?? this.model.settings.model),
        promptTokens,
        completionTokens,
        usageEstimated: !hasUsage,
        latencyMs: Date.now() - started,
        attempts: attempt,
      };
      usage.record({
        purpose,
        provider: this.model.provider.name,
        requestedModel: this.model.settings.model,
        servedModel: result.servedModel,
        promptTokens,
        completionTokens,
        usageEstimated: !hasUsage,
        latencyMs: result.latencyMs,
        attempts: attempt,
        ok: true,
      });
      return result;
    }
    usage.record({
      purpose,
      provider: this.model.provider.name,
      requestedModel: this.model.settings.model,
      servedModel: '',
      promptTokens: 0,
      completionTokens: 0,
      usageEstimated: false,
      latencyMs: Date.now() - started,
      attempts: attempt,
      ok: false,
    });
    throw lastErr ?? new LlmError(`${this.label}: request failed`);
  }
}

/**
 * Ask for a JSON object and validate it. One repair retry on invalid output.
 * `validate` returns an error string or undefined.
 */
export async function chatJson<T>(
  llm: LlmLike,
  messages: ChatMessage[],
  validate: (v: unknown) => string | undefined,
  purpose?: string,
): Promise<{ value: T; result: ChatResult }> {
  let convo = messages;
  let lastProblem = '';
  for (let i = 0; i < 2; i++) {
    const result = await llm.chat({ messages: convo, json: true, purpose });
    try {
      const value = extractJson(result.content);
      const problem = validate(value);
      if (!problem) return { value: value as T, result };
      lastProblem = problem;
    } catch (e) {
      lastProblem = (e as Error).message;
    }
    convo = [
      ...messages,
      { role: 'assistant', content: result.content },
      { role: 'user', content: `Your previous reply was invalid: ${lastProblem}. Reply again with ONLY the corrected JSON object.` },
    ];
  }
  throw new LlmError(`model returned invalid JSON twice (${purpose ?? llm.label}): ${lastProblem}`);
}

export function backoff(attempt: number, random: () => number = Math.random): number {
  const cap = Math.min(30_000, 1000 * 2 ** (attempt - 1));
  return Math.max(250, Math.floor(random() * cap));
}

export function parseRetryAfter(v: string | null): number | undefined {
  if (!v) return undefined;
  const secs = Number(v);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const date = Date.parse(v);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return undefined;
}

function summarizeError(text: string): string {
  try {
    const j = JSON.parse(text);
    const m = j?.error?.message ?? j?.message ?? j?.error;
    if (m) return typeof m === 'string' ? m.slice(0, 500) : JSON.stringify(m).slice(0, 500);
  } catch {
    /* not json */
  }
  return text.slice(0, 500);
}

/**
 * Automatic model switching: tries the primary model, then each configured fallback in order,
 * when a call fails after that model's own retries (outage, rate limit, removed deployment,
 * unsupported parameter). Budget errors are never retried on another model.
 */
export class FallbackLlm implements LlmLike {
  private active = 0;

  constructor(
    private readonly chain: LlmClient[],
    private readonly log: Logger,
  ) {
    if (!chain.length) throw new Error('FallbackLlm needs at least one model');
  }

  /** The primary model (used for reporting). */
  get model(): ResolvedModel {
    return this.chain[0]!.model;
  }

  /** Every model this chain may use, as "provider:model". */
  get models(): string[] {
    return this.chain.map((c) => c.label);
  }

  get label(): string {
    return this.chain[this.active]!.label;
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    let lastErr: unknown;
    // Stick with a fallback once switched, so one run does not bounce between models.
    for (let i = this.active; i < this.chain.length; i++) {
      const c = this.chain[i]!;
      try {
        const r = await c.chat(req);
        this.active = i;
        return r;
      } catch (e) {
        if (!(e instanceof LlmError)) throw e;
        lastErr = e;
        const next = this.chain[i + 1];
        if (next) this.log.warn(`${c.label} failed (${e.message.slice(0, 160)}); switching to fallback ${next.label}`);
      }
    }
    throw lastErr;
  }
}
