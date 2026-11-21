# Ultimate Factory

Status: Approved after EGM goldfish review (see `egm-review-report.md`) · Owner: repository maintainer · Method: Elephant-Goldfish Model (EGM)

## Overview

Ultimate Factory is a provider-neutral software factory. It keeps the policy model of
the original prompt-only factory design (charter, label queue, fail-closed gates, independent verifier, human
merge) and adds a small Node.js runtime, `ufactory`, that runs every stage against any
OpenAI-compatible endpoint. A single config file, `factory.config.yaml`, selects the provider
(OpenAI, Portkey gateway, Azure OpenAI, or any OpenAI-compatible server) and the model per
stage. The runtime enforces in code the charter rules that the original design left to model
judgement.

## Audience and success criteria

Audience: solo developers and small teams (1–10 engineers) who want an unattended factory on
the model provider they already pay for.

Success criteria:
1. A new user goes from `ufactory init` to a dry-run triage with either an OpenAI key or a
   Portkey key by editing only `factory.config.yaml` and `CHARTER.md`.
2. No charter rule in the policy decision table can be bypassed by model output: each rule has
   a test where the model attempts the violation and the runtime refuses it.
3. `ufactory policy-check` blocks a PR written by *any* harness that violates the charter.
4. Every run leaves a schema-valid run record with token usage, even when it fails.

## The Problem

The reverse-engineering report (`docs/reverse-engineering/FACTORY-REVERSE-ENGINEERING.md`)
shows the original factory design is a policy pack with no runtime of its own:

1. It runs only inside Claude Code routines or Codex. A team with an OpenAI key or a
   Portkey gateway cannot run it unattended (gaps G1, G2).
2. Load-bearing globs, the 400-line limit, the review-queue limit and the test-tamper rule
   are prompts. A model that misreads them ships a change the charter forbids (G4).
3. The verifier is the same model family as the writer (G5), there is no budget (G6), the
   merge guard is a pattern-matching hook (G7), and run records are free text (G9).

## Goals

1. **Configurable models.** Every stage (`triage`, `spec`, `implement`, `verify`, `critic`,
   `review`, `monitor`) resolves a model from `factory.config.yaml`. Provider types:
   `openai`, `portkey`, `azure-openai`, `openai-compatible`. Secrets are read only from
   environment variables named in the config.
2. **Portkey first-class.** Support Portkey API key, provider slug or virtual key, saved
   config id, model catalog names (`@slug/model`), trace id and metadata headers.
3. **Deterministic policy engine.** Code enforces: load-bearing globs, protected paths,
   changed-line limit, changed-file limit, test-file tamper, review-queue back-pressure,
   gate verdict parsing, and never-merge. The LLM cannot override these.
4. **Sandboxed agent.** The implement agent has only the tools `list_files`, `read_file`,
   `search`, `write_file`, `run_gates`, `run_tests` and `finish`. Writes are path-checked.
   There is no general shell tool, so there is no merge path to guard.
5. **Model diversity in review.** Verifier and critic can use a different provider/model
   from the implementer; the 10-persona review panel can spread personas across models.
6. **Runs anywhere.** Local CLI, cron, and GitHub Actions with a native `issues: opened`
   trigger (closes G3).
7. **Budgets and evidence.** Per-run token and turn limits; structured run records written
   by code, including token usage per model.
8. **Drop-in install.** `ufactory init` installs the charter, contract, gates, Claude Code
   and Codex adapters, config and workflows into a target repo, never overwriting.

## Non-Goals

- Auto-merge on any tier. Merge stays human; branch protection stays the boundary.
- A hosted service, queue server, or database. GitHub stays the queue.
- Replacing Claude Code or Codex. Their adapters keep working; the runtime is an extra path.
- Fine-tuning, embeddings, or a vector index of the codebase.
- A web dashboard. `ufactory status` is the control room.

## Open Questions

| Question | Decision |
|---|---|
| Chat Completions or Responses API? | Chat Completions with tools. It is the format Portkey, Azure, vLLM, Ollama and LiteLLM all accept. |
| Runtime language? | TypeScript on Node.js 20+. One runtime dependency (`yaml`). Matches the npm distribution of OpenSpec and REA. |
| Should GitHub writes be on by default? | No. Every stage that writes to GitHub needs `--apply`; default is a dry run that prints the planned writes. |
| Where do spec outputs go? | `docs/factory/specs/FQ-<n>/` by default; OpenSpec change layout when `spec.format: openspec`. |

## Critical User Journeys (CUJs)

### CUJ 1: Run with an OpenAI key
`npx ufactory init .` → edit `CHARTER.md` → `export OPENAI_API_KEY=…` →
`ufactory doctor --ping` → `ufactory triage --apply` → `ufactory implement --apply`.

### CUJ 2: Run through a Portkey gateway with a catalog model
Set `providers.portkey` in `factory.config.yaml`, `export PORTKEY_API_KEY=…`, set
`models.default.model: "@openai-prod/gpt-5.1"`. All calls go to `https://api.portkey.ai/v1`
with `x-portkey-*` headers and a per-run trace id.

### CUJ 3: Unattended in GitHub Actions
Installed workflow `factory.yml` runs `triage` on `issues: opened|edited`, `verify` on
`pull_request: opened|synchronize`, `implement` hourly, `monitor` weekly. Secrets come from
repository secrets.

### CUJ 4: Panel review before merge
`ufactory review --pr 42` runs 10 engineering personas (configurable list and models) and
posts one consolidated comment with a verdict table.

## Technical Plan (Architecture)

```
factory.config.yaml ──> config loader (schema-checked, ${ENV} interpolation, no inline secrets)
                               │
                       provider registry ──> LLM client (fetch, retries, timeouts, usage, tools)
                               │
CHARTER.md ──> charter parser ──> policy engine (globs, limits, protected paths, queue)
                               │
GitHub (gh CLI) <── github adapter ──> stages: triage | spec | implement | verify | review | monitor | status
                               │
gates.sh / prove-test.sh <── gates runner (parses FACTORY_GATES / PROOF lines)
                               │
                       run recorder (docs/factory/runs/*.md, YAML front matter written by code)
```

Key decisions:
- **Policy outranks model output.** Triage asks the model for a JSON classification, then
  the policy engine re-derives `load_bearing` from `files_expected` and downgrades any
  `ready-to-implement` that violates the charter. The implement loop refuses writes to
  protected paths and stops when the diff crosses the line or file limit.
- **Untrusted input fencing.** Issue bodies and comments are wrapped in
  `<untrusted_issue>` blocks with an instruction hierarchy note; handoff fields are parsed
  by code with an allowlist of keys, not by the model.
- **Claim by Git ref.** Same `fq-<n>` deterministic branch push as the original design; branch
  prefix is configurable (`factory/` default, `claude/` for Claude cloud compatibility).

## Alternatives Considered

### Alternative A: Keep Claude/Codex only, add a model setting to the skills
Rejected. Skills cannot change the harness model or endpoint, and the gaps in G4 stay
prompt-only.

### Alternative B: Build on LangGraph / an agent framework
Rejected. Adds heavy dependencies and a second abstraction over the same 7 tools. The loop
is about 150 lines and is easier to audit.

### Alternative C: Use the official `openai` SDK
Rejected for the runtime core. Raw `fetch` keeps the dependency surface at one package and
makes Portkey/Azure header handling explicit. The wire format is the same.

### Alternative D: Point Claude Code or Codex at a gateway
Claude Code can be routed through a gateway (`ANTHROPIC_BASE_URL`, e.g. Portkey or LiteLLM) and
Codex CLI accepts custom OpenAI-compatible providers. This is cheaper and is documented in
`docs/HARNESS-GATEWAYS.md`. It is not enough on its own: policy stays prompt-enforced (G4),
unattended runs still need the vendor's cloud routines (G2), and a plain GitHub Actions runner
with only an OpenAI key cannot run it. **Principle override, stated plainly:** the original design
avoids a custom orchestrator. This design adds a small one because the owner's requirement is
provider-neutral unattended operation, and because moving policy into code is the main safety
gain. The override is bounded: no queue service, no database, GitHub stays the queue.

### Alternative E: Container isolation for the agent instead of path-checked tools
Stronger isolation, but needs Docker on every runner and slows each gate run. Adopted as an
optional hardening note; default is a scrubbed-environment subprocess plus branch protection.

### Alternative F: LiteLLM proxy or the Responses API
LiteLLM is a gateway like Portkey and is supported through `openai-compatible`. The Responses
API is not accepted by most gateways and local servers; Chat Completions is the common format.

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Agent-written test exfiltrates secrets | Scrubbed env for gates/tests; least-privilege token; branch protection |
| Fake gate verdict printed by a test | Nonce + exit-code agreement; last line only |
| Prompt injection via issue, diff or file | Nonce delimiters; no shell tool; policy enforced in code on the real diff |
| Provider outage mid-run | Bounded retries; run stops `infrastructure-failed`; claim released; label restored |
| Dirty working tree / partial writes | Implement refuses a dirty tree; all work on the claim branch; nothing pushed until gates + verifier pass |
| Runaway cost | Token budget always on, USD cap with default prices, daily run cap, turn cap |
| Same model grades its own work | Separate verify role, warning when identical, served model recorded |
| `gh` auth expiry | `doctor` checks auth; GitHub errors stop the run with a recorded reason |
| Crashed run leaves claim | Lease timestamp, stale-claim report in `status`/`monitor`, never auto-stolen |

## Non-Functional Requirements

- **Security:** secrets only from env; config containing a literal `api_key` value fails
  validation; logs redact `Authorization` and `x-portkey-api-key`; agent file tools reject
  absolute paths, `..`, symlinks out of the repo and protected globs.
- **Reliability:** retries with exponential backoff and jitter on 408/409/429/5xx and
  network errors; per-request timeout; `Retry-After` honoured.
- **Cost:** `budget.max_tokens_per_run`, `budget.max_turns`, `budget.max_usd_per_run`
  (when prices are configured). Exceeding a budget stops the run with status `stopped`.
- **Portability:** macOS, Linux, Windows via Git Bash for gates; Node 20+.
- **Observability:** each LLM call records model, provider, latency, tokens, retries into
  the run record; Portkey trace id equals the run id.

## Detailed Implementation Plan

Tracked as OpenSpec change `build-ultimate-factory` (`openspec/changes/`). Source layout:

| Path | Purpose |
|---|---|
| `src/config/` | schema, loader, env interpolation, role resolution |
| `src/llm/` | client, provider header mapping, retry, JSON extraction, mock server for tests |
| `src/policy/` | charter parser, glob matcher, policy engine |
| `src/github/` | `gh` adapter, labels, handoff comment codec |
| `src/gates/` | gates and prove-test runners and verdict parsers |
| `src/agent/` | tool definitions, sandboxed workspace, agent loop |
| `src/stages/` | triage, spec, implement, verify, review, monitor, status, doctor, init |
| `src/runs/` | run record writer |
| `src/personas/` | 10 built-in engineering personas |
| `template/` | files `ufactory init` installs |
| `test/` | node:test unit and end-to-end tests with a mock OpenAI server |

### Verification Plan

1. Unit tests: config validation, Portkey/OpenAI/Azure header building, retry policy,
   charter parsing, glob matching, policy decisions, handoff codec, gate-line parsing,
   workspace path guard.
2. End-to-end: temp Git repo + mock OpenAI-compatible server scripted to call tools;
   `implement --local` must write code, run gates, get a verifier verdict and write a run
   record; a scripted attempt to write `CHARTER.md` must be refused.
3. Ported shell tests from the original template for gates, prove-test and install idempotency.
4. Live smoke test against a real key when one is present (`ufactory doctor --ping`).
