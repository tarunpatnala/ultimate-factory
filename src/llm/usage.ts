import type { PriceEntry } from '../config/types.js';
import { BudgetExceededError } from '../util/errors.js';

export interface CallRecord {
  purpose: string;
  provider: string;
  requestedModel: string;
  servedModel: string;
  promptTokens: number;
  completionTokens: number;
  usageEstimated: boolean;
  latencyMs: number;
  attempts: number;
  ok: boolean;
}

export interface BudgetLimits {
  maxTokens: number;
  maxUsd?: number;
  maxTurns: number;
  /** Wall-clock limit for the whole run (keeps unattended runs inside CI job timeouts). */
  maxWallClockMs?: number;
}

/** Tracks token usage and cost for one run and enforces the budget before each call. */
export class UsageTracker {
  readonly calls: CallRecord[] = [];
  turns = 0;
  readonly startedAt = Date.now();

  constructor(
    readonly limits: BudgetLimits,
    private readonly prices: Record<string, PriceEntry>,
  ) {}

  get promptTokens(): number {
    return this.calls.reduce((a, c) => a + c.promptTokens, 0);
  }
  get completionTokens(): number {
    return this.calls.reduce((a, c) => a + c.completionTokens, 0);
  }
  get totalTokens(): number {
    return this.promptTokens + this.completionTokens;
  }
  get usageEstimated(): boolean {
    return this.calls.some((c) => c.usageEstimated);
  }
  get costUsd(): number {
    let usd = 0;
    for (const c of this.calls) {
      // Price what was actually served (a gateway fallback may be a pricier model) when known.
      const served = c.servedModel ? priceFor(this.prices, c.servedModel, true) : undefined;
      const p = served ?? priceFor(this.prices, c.requestedModel);
      usd += (c.promptTokens / 1e6) * p.input_per_mtok + (c.completionTokens / 1e6) * p.output_per_mtok;
    }
    return Math.round(usd * 10000) / 10000;
  }

  /** Throws when the run is out of budget or the next prompt alone would exceed what is left. */
  checkBeforeCall(estimatedPromptTokens = 0): void {
    if (this.totalTokens >= this.limits.maxTokens) {
      throw new BudgetExceededError(`token budget exhausted: ${this.totalTokens} >= ${this.limits.maxTokens}`);
    }
    if (this.totalTokens + estimatedPromptTokens > this.limits.maxTokens) {
      throw new BudgetExceededError(`token budget: next prompt (~${estimatedPromptTokens}) would exceed the remaining ${this.limits.maxTokens - this.totalTokens} tokens`);
    }
    if (this.limits.maxWallClockMs !== undefined && Date.now() - this.startedAt > this.limits.maxWallClockMs) {
      throw new BudgetExceededError(`wall-clock budget exhausted: ${Math.round(this.limits.maxWallClockMs / 60000)} minutes`);
    }
    if (this.limits.maxUsd !== undefined && this.costUsd >= this.limits.maxUsd) {
      throw new BudgetExceededError(`cost budget exhausted: $${this.costUsd} >= $${this.limits.maxUsd}`);
    }
  }

  countTurn(): void {
    this.turns += 1;
    if (this.turns > this.limits.maxTurns) throw new BudgetExceededError(`turn budget exhausted: ${this.limits.maxTurns} turns`);
  }

  record(c: CallRecord): void {
    this.calls.push(c);
  }
}

export function priceFor(prices: Record<string, PriceEntry>, model: string, exactOnly: true): PriceEntry | undefined;
export function priceFor(prices: Record<string, PriceEntry>, model: string, exactOnly?: false): PriceEntry;
export function priceFor(prices: Record<string, PriceEntry>, model: string, exactOnly = false): PriceEntry | undefined {
  const bare = model.replace(/^@[^/]+\//, '');
  if (prices[model]) return prices[model]!;
  if (prices[bare]) return prices[bare]!;
  // Longest prefix match: "gpt-5.1-2025-11-13" -> "gpt-5.1".
  const keys = Object.keys(prices)
    .filter((k) => k !== '*' && bare.startsWith(k))
    .sort((a, b) => b.length - a.length);
  if (keys[0]) return prices[keys[0]]!;
  if (exactOnly) return undefined;
  return prices['*'] ?? { input_per_mtok: 0, output_per_mtok: 0 };
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
