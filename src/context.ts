import { basename, join } from 'node:path';
import { loadConfig, resolveModel, type LoadedConfig } from './config/load.js';
import type { Role } from './config/types.js';
import { GitHub } from './github/gh.js';
import { FallbackLlm, LlmClient } from './llm/client.js';
import { UsageTracker } from './llm/usage.js';
import { requireReadyCharter, type Charter } from './policy/charter.js';
import { PolicyEngine } from './policy/engine.js';
import { makeRunId, RunRecord, type RunStatus } from './runs/record.js';
import { scrubbedEnv } from './util/exec.js';
import { Fence } from './util/fence.js';
import { log, type Logger } from './util/log.js';
import { Redactor } from './util/redact.js';

export interface GlobalOptions {
  cwd: string;
  config?: string;
  profile?: string;
  apply: boolean;
  verbose?: boolean;
  quiet?: boolean;
  /** Skip writing a run record (doctor, status, models). */
  noRecord?: boolean;
}

export class RunContext {
  readonly runId: string;
  readonly usage: UsageTracker;
  readonly record: RunRecord;
  readonly redactor: Redactor;
  readonly fence = new Fence();
  readonly log: Logger = log;
  private _gh?: GitHub;
  private _charter?: Charter;
  private _policy?: PolicyEngine;
  private recordPath?: string;
  /** False when the stage did real work without external writes (e.g. implement --local). */
  externalWrites = true;

  constructor(
    readonly stage: string,
    readonly opts: GlobalOptions,
    readonly loaded: LoadedConfig,
    ref?: number | string,
  ) {
    this.runId = makeRunId(stage, ref);
    this.redactor = new Redactor(loaded.secretEnvNames);
    log.setRedactor(this.redactor);
    log.setLevel(opts.verbose ? 'debug' : opts.quiet ? 'warn' : loaded.config.logging.level);
    const b = loaded.config.budget;
    this.usage = new UsageTracker({ maxTokens: b.max_tokens_per_run, maxUsd: b.max_usd_per_run, maxTurns: b.max_turns, maxWallClockMs: b.max_minutes_per_run * 60_000 }, b.prices);
    this.record = new RunRecord(this.runId, stage, loaded.profile ?? 'default');
    if (typeof ref === 'number') this.record.set(stage === 'verify' ? 'pull_request' : 'issue', ref);
  }

  static create(stage: string, opts: GlobalOptions, ref?: number | string): RunContext {
    const loaded = loadConfig({ cwd: opts.cwd, configPath: opts.config, profile: opts.profile });
    return new RunContext(stage, opts, loaded, ref);
  }

  get cfg() {
    return this.loaded.config;
  }
  get root(): string {
    return this.opts.cwd;
  }

  /** Client for a role: the configured model plus its fallback chain (automatic switching). */
  /** One chain per role/persona for the whole command, so a switch to a fallback sticks. */
  llm(role: Role | string, persona?: string): FallbackLlm {
    const key = `${role}/${persona ?? ''}`;
    const cached = this.llms.get(key);
    if (cached) return cached;
    const resolved = resolveModel(this.loaded, role, persona);
    const deps = { runId: this.runId, stage: this.stage, usage: this.usage, log: this.log, redactor: this.redactor };
    const chain = new FallbackLlm([resolved, ...resolved.fallbacks].map((m) => new LlmClient(m, deps)), this.log);
    this.llms.set(key, chain);
    return chain;
  }

  private readonly llms = new Map<string, FallbackLlm>();

  get gh(): GitHub {
    if (!this._gh) this._gh = new GitHub(this.root, this.opts.apply, this.log);
    return this._gh;
  }

  get charter(): Charter {
    if (!this._charter) this._charter = requireReadyCharter(join(this.root, this.cfg.factory.charter));
    return this._charter;
  }

  get policy(): PolicyEngine {
    if (!this._policy) this._policy = new PolicyEngine(this.charter, this.cfg);
    return this._policy;
  }

  /** Environment for running repository code: no LLM keys, no GitHub token. */
  get codeEnv(): NodeJS.ProcessEnv {
    return scrubbedEnv(this.loaded.secretEnvNames, this.cfg.agent.passthrough_env);
  }

  path(rel: string): string {
    return join(this.root, rel);
  }

  /** Finalize and write the run record (once). */
  finish(status: RunStatus, stopReason = 'none'): string | undefined {
    if (this.recordPath || this.opts.noRecord) return this.recordPath;
    this.record.set('status', status === 'succeeded' && this.externalWrites && !this.opts.apply ? 'dry-run' : status);
    this.record.set('stop_reason', stopReason);
    this.record.set('finished_at', new Date().toISOString());
    this.record.applyUsage(this.usage);
    this.recordPath = this.record.write(join(this.root, this.cfg.factory.runs_dir), this.redactor);
    this.log.info(`run record: ${this.cfg.factory.runs_dir}/${basename(this.recordPath)}`);
    return this.recordPath;
  }
}
