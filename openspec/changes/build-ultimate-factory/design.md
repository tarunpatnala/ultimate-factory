# Design

## Context

Approved EGM design: `docs/design/design_draft.md`; goldfish findings and resolutions:
`docs/design/egm-review-report.md`. The original template policy files are reused
verbatim where possible (charter, contract, skills, `prove-test.sh`), with `gates.sh` extended
to echo a nonce.

## Goals / Non-Goals

**Goals:** provider-neutral runtime; config-selected models per stage; policy in code;
harness-neutral policy check; 10-persona panel; safe install; tests with a mock provider.

**Non-Goals:** auto-merge; hosted service; database; web UI; replacing Claude/Codex adapters.

## Decisions

### D1. Runtime: TypeScript, Node ≥ 20.10, two runtime deps
`yaml` (config parsing) and `picomatch` (security-relevant glob matching). HTTP via global
`fetch`. Tests via `node:test`. Rationale: matches npm distribution of OpenSpec/REA, auditable.

### D2. Exact source files

| File | Responsibility |
|---|---|
| `bin/ufactory.js` | ESM shim importing `dist/src/cli.js` |
| `src/cli.ts` | argument parsing, command dispatch, exit codes |
| `src/version.ts` | version constant |
| `src/config/types.ts` | config types |
| `src/config/load.ts` | discovery, YAML parse, env interpolation, defaults, validation, secret scan, role resolution |
| `src/llm/providers.ts` | URL + header building per provider type (Portkey precedence) |
| `src/llm/client.ts` | chat call, retry/backoff, Retry-After, timeout, usage, served model |
| `src/llm/json.ts` | JSON extraction from model text, one repair retry |
| `src/llm/usage.ts` | usage tracker, price table, budget enforcement |
| `src/util/redact.ts` | secret redaction |
| `src/util/exec.ts` | subprocess runner with scrubbed env, timeouts, output caps |
| `src/util/log.ts` | levelled logger to stderr |
| `src/util/fence.ts` | nonce delimiters for untrusted content |
| `src/util/errors.ts` | error classes with exit codes |
| `src/policy/charter.ts` | fenced-block charter parser, fail closed |
| `src/policy/paths.ts` | path classes (protected, load-bearing, test, secret) via picomatch |
| `src/policy/diff.ts` | real diff stats via git (tracked + untracked, numstat, renames, deletes) |
| `src/policy/engine.ts` | violation evaluation, tier effects, gate level selection |
| `src/github/gh.ts` | `gh` wrapper, dry-run planner, idempotent writes |
| `src/github/handoff.ts` | handoff comment encode/decode |
| `src/github/queue.ts` | labels, state transitions, review-queue count, claim/release |
| `src/gates/gates.ts` | gate runner + verdict authenticity; proof runner |
| `src/agent/workspace.ts` | path guard, file tools |
| `src/agent/tools.ts` | tool JSON schemas + dispatcher |
| `src/agent/loop.ts` | agent loop with stop conditions |
| `src/personas/personas.ts` | built-in personas |
| `src/stages/*.ts` | `init`, `doctor`, `models`, `triage`, `spec`, `implement`, `verify`, `review`, `policy-check`, `gates`, `monitor`, `status`, `run` |
| `src/runs/record.ts` | run id, record writer |
| `template/**` | installed files (see factory-install spec) |
| `test/*.test.ts` | unit + e2e tests; `test/helpers/mock-llm.ts` mock server |
| `.github/workflows/ci.yml` | this repo's CI |

### D3. Portkey routing precedence
`config` → `x-portkey-config`; else `virtual_key_env` → `x-portkey-virtual-key`; else
`provider` → `x-portkey-provider` (+ `Authorization` from `provider_api_key_env` if set); else
model must be `@slug/model`. Always: `x-portkey-api-key`, `x-portkey-trace-id = run_id`,
`x-portkey-metadata`. Redacted headers: `authorization`, `api-key`, `x-portkey-api-key`,
`x-portkey-virtual-key`.

### D4. Policy decision table

| Condition | triage | implement (per write) | implement (finish) | policy-check |
|---|---|---|---|---|
| charter missing / not ready | stop (4) | stop (4) | n/a | MISCONFIGURED (2) |
| protected path | downgrade → ready-to-spec | refuse write | violation → stop | FAIL |
| load-bearing path | downgrade → ready-to-spec | refuse write | violation → stop | FAIL unless human-approved |
| existing test modified/deleted/renamed (`TESTS_ARE_LOAD_BEARING`) | n/a | refuse write/delete | violation → stop | FAIL |
| lines > limit | downgrade if estimated | revert write, stop | stop | FAIL |
| files > limit | downgrade | revert write, stop | stop | FAIL |
| secret file | n/a | refuse read/write | n/a | FAIL |
| review queue ≥ limit | n/a | stop before claim | n/a | n/a |
| tier client-production | n/a | n/a | draft PR, min gate `full`, critic required | n/a |
| tier oss | n/a | n/a | draft if non-doc change | n/a |

Gate level = max(handoff `gate_level`, charter `GATES.default`, tier minimum); docs-only diff may
use `GATES.docs_only`.

### D5. Agent loop
System prompt = contract + charter summary + handoff (`done_when`, `files_expected`) + rules.
Issue text is fenced with nonce delimiters. Each turn: one chat call with tools; every tool call
dispatched; results appended as `tool` messages. Parallel tool calls are processed in order.
Models without tool support (`capabilities.tools: false`) cannot run implement (doctor warns).

### D6. Verifier and critic
Verifier receives: `done_when`, diff (fenced), gate line, proof line, policy result. It never
sees the implementer's narrative. Output JSON `{verdict: accepted|accepted-with-reservations|rejected, reasons[], must_fix[]}`.
Critic output mirrors the original template's YAML as JSON. If the verify model equals the implement model
(same provider+model) a warning is recorded (`verifier_independent: false`).

### D7. Workflows
`factory.yml`: triggers `issues: [opened, edited, labeled]`, `pull_request: [opened, synchronize, ready_for_review]`,
`schedule` (hourly implement, weekly monitor), `workflow_dispatch`. Permissions per job:
triage `issues: write, contents: read`; implement `contents: write, issues: write, pull-requests: write`;
verify `contents: read, pull-requests: write, issues: read`. Concurrency `factory-${stage}-${issue||pr||ref}`.
`factory-policy.yml`: `pull_request`, permissions `contents: read`, no secrets, runs
`npx ultimate-factory policy-check --base origin/${base_ref}`.

### D8. Cost estimates (defaults, gpt-5.1-class pricing)

| Stage | Typical tokens | Calls |
|---|---|---|
| triage (per issue) | 4–8k | 1–2 |
| implement | 60–250k | 10–40 |
| verify (+critic) | 15–40k | 1–2 |
| review panel (10 personas) | 10 × 8–20k | 10 |
| monitor | 5–15k | 1 |

Default `budget.max_tokens_per_run: 400000`, `max_usd_per_run: 5`, `max_turns: 40`,
`max_runs_per_day: 50`.

## Risks / Trade-offs

- Agent without shell is weaker than Claude Code; mitigated by `allowed_commands`.
- Scrubbed env may break tests that legitimately need a token; such tests must use
  `agent.passthrough_env` explicitly (documented, never includes configured LLM keys).
- Chars/4 estimation is coarse; flagged in records.
- Gates run repo code; boundary is branch protection plus least-privilege token.
