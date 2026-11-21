import type { ChatMessage, LlmLike, ToolCall } from '../llm/types.js';
import type { UsageTracker } from '../llm/usage.js';
import { BudgetExceededError } from '../util/errors.js';
import type { Logger } from '../util/log.js';
import { AGENT_TOOLS, TOOL_NAMES } from './tools.js';

export type ToolOutcome =
  | { kind: 'result'; payload: Record<string, unknown> }
  | { kind: 'refused'; error: string }
  /** Hard stop: the run must end now (policy violation, gates red twice, ...). */
  | { kind: 'stop'; reason: string; detail: string }
  /** finish accepted by the runtime. */
  | { kind: 'finished'; summary: string; testPaths: string[] };

export type ToolHandler = (name: string, args: Record<string, unknown>) => Promise<ToolOutcome>;

export interface AgentResult {
  outcome: 'finished' | 'stopped';
  reason: string;
  detail: string;
  summary?: string;
  testPaths?: string[];
  turns: number;
  refusals: number;
  messages: ChatMessage[];
}

export interface AgentOptions {
  llm: LlmLike;
  usage: UsageTracker;
  log: Logger;
  system: string;
  user: string;
  handler: ToolHandler;
  maxRefusals: number;
  /** Continue an earlier conversation (verifier feedback round). */
  history?: ChatMessage[];
}

/** Max characters of one tool result sent to the model. */
export const TOOL_RESULT_CHARS = 24_000;
/** Tool results older than this many assistant turns are replaced by short stubs. */
export const KEEP_FULL_TURNS = 6;

/** Tool-calling loop. Only `finish` accepted by the handler can produce a "finished" outcome. */
export async function runAgent(o: AgentOptions): Promise<AgentResult> {
  const messages: ChatMessage[] = o.history ? [...o.history, { role: 'user', content: o.user }] : [
    { role: 'system', content: o.system },
    { role: 'user', content: o.user },
  ];
  let refusals = 0;
  let nudges = 0;
  const stop = (reason: string, detail: string): AgentResult => ({ outcome: 'stopped', reason, detail, turns: o.usage.turns, refusals, messages });

  for (;;) {
    try {
      o.usage.countTurn();
      compactHistory(messages);
      const res = await o.llm.chat({ messages, tools: AGENT_TOOLS, purpose: 'implement' });
      messages.push({ role: 'assistant', content: res.content || null, ...(res.toolCalls.length ? { tool_calls: res.toolCalls } : {}) });
      if (res.content) o.log.debug(`agent: ${res.content.slice(0, 400)}`);
      if (!res.toolCalls.length) {
        nudges++;
        if (nudges > 3) return stop('no-progress', 'model stopped calling tools without calling finish');
        const why = res.finishReason === 'length' ? 'Your reply hit the output limit. Make smaller tool calls (write one file at a time).' : 'Continue using the tools.';
        messages.push({ role: 'user', content: `${why} When the work is complete and tested, call finish. If you cannot complete it within the rules, call give_up with the reason.` });
        continue;
      }
      nudges = 0;
      for (let i = 0; i < res.toolCalls.length; i++) {
        const call = res.toolCalls[i]!;
        const outcome = await dispatch(call, o.handler);
        if (outcome.kind === 'stop' || outcome.kind === 'finished') {
          messages.push(toolMsg(call, outcome.kind === 'stop' ? { ok: false, error: `run stopped: ${outcome.detail}` } : { ok: true, result: 'accepted' }));
          // Answer the rest of the batch so the transcript stays valid if it is continued.
          for (const rest of res.toolCalls.slice(i + 1)) messages.push(toolMsg(rest, { ok: false, error: 'not executed: run ended earlier in this batch' }));
          if (outcome.kind === 'stop') return stop(outcome.reason, outcome.detail);
          return { outcome: 'finished', reason: 'finished', detail: outcome.summary, summary: outcome.summary, testPaths: outcome.testPaths, turns: o.usage.turns, refusals, messages };
        }
        if (outcome.kind === 'refused') {
          refusals++;
          messages.push(toolMsg(call, { ok: false, error: outcome.error }));
          if (refusals >= o.maxRefusals) {
            for (const rest of res.toolCalls.slice(i + 1)) messages.push(toolMsg(rest, { ok: false, error: 'not executed' }));
            return stop('too-many-refusals', `${refusals} tool calls were refused; last: ${outcome.error}`);
          }
          continue;
        }
        messages.push(toolMsg(call, { ok: true, ...outcome.payload }));
      }
    } catch (e) {
      if (e instanceof BudgetExceededError) return stop('budget', e.message);
      throw e;
    }
  }
}

async function dispatch(call: ToolCall, handler: ToolHandler): Promise<ToolOutcome> {
  if (!TOOL_NAMES.has(call.function.name)) return { kind: 'refused', error: `unknown tool "${call.function.name}"` };
  let args: Record<string, unknown>;
  try {
    const parsed = call.function.arguments ? JSON.parse(call.function.arguments) : {};
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('arguments must be a JSON object');
    args = parsed;
  } catch (e) {
    return { kind: 'refused', error: `invalid JSON arguments: ${(e as Error).message}` };
  }
  try {
    return await handler(call.function.name, args);
  } catch (e) {
    if (e instanceof BudgetExceededError) throw e;
    return { kind: 'refused', error: (e as Error).message };
  }
}

/**
 * Serialize a tool result within TOOL_RESULT_CHARS without ever producing invalid JSON:
 * long strings and arrays are trimmed field by field, with explicit truncation markers.
 */
export function toolMsg(call: ToolCall, payload: Record<string, unknown>): ChatMessage {
  let content = JSON.stringify(payload);
  if (content.length > TOOL_RESULT_CHARS) {
    const trimmed: Record<string, unknown> = { ...payload, truncated_by_runtime: true };
    for (const [k, v] of Object.entries(trimmed)) {
      if (typeof v === 'string' && v.length > 2_000) trimmed[k] = v.slice(0, TOOL_RESULT_CHARS - 4_000) + `\n[... ${v.length - (TOOL_RESULT_CHARS - 4_000)} more characters not shown ...]`;
      if (Array.isArray(v) && v.length > 50) trimmed[k] = [...v.slice(0, 50), `[... ${v.length - 50} more items not shown ...]`];
    }
    content = JSON.stringify(trimmed);
    if (content.length > TOOL_RESULT_CHARS) content = JSON.stringify({ ok: payload.ok, error: 'tool result too large to show; narrow the request (line range, glob or pattern)' });
  }
  return { role: 'tool', tool_call_id: call.id, content };
}

/** Replace tool results older than KEEP_FULL_TURNS assistant turns with short stubs. */
export function compactHistory(messages: ChatMessage[]): void {
  let turnsSeen = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === 'assistant') turnsSeen++;
    if (turnsSeen > KEEP_FULL_TURNS && m.role === 'tool' && m.content.length > 400) {
      let summary = 'elided';
      try {
        const p = JSON.parse(m.content);
        summary = JSON.stringify({ ok: p.ok, path: p.path, status: p.status, verdict: p.verdict, error: p.error, elided: 'older tool output removed to save context; call the tool again if needed' });
      } catch {
        /* keep generic stub */
      }
      messages[i] = { ...m, content: summary };
    }
  }
}
