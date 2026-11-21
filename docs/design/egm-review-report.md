# EGM goldfish review report: design_draft.md

Three fresh-context goldfish reviewers (EGM personas `implementation_readiness`, `design_critic`,
`zoom_out`) read `design_draft.md` with no conversation history. This file records their findings
and how the elephant (author) resolved each one.

## 1. Implementation Readiness goldfish

Verdict: **not ready**. It reads as a design overview and leaves decisions to the implementer.

| # | Sev | Finding | Resolution |
|---|---|---|---|
| IR1 | Blocker | `factory.config.yaml` schema undefined | Full annotated schema in `factory.config.example.yaml`; TypeScript types in `src/config/types.ts`; spec `config` |
| IR2 | Blocker | No exact file list | File list in OpenSpec `design.md` |
| IR3 | Blocker | Policy engine rules unspecified (charter grammar, glob dialect, line counting, defaults) | Decision table in OpenSpec spec `policy-engine` |
| IR4 | Blocker | Agent tool contracts missing | Tool schemas, limits and stop conditions in spec `agent-sandbox` |
| IR5 | Blocker | Stage contracts missing; `critic` inconsistency; `--local` undefined | Stage table in `design.md`; critic is a role used by `verify`, not a stage; `--local` defined |
| IR6 | Major | GitHub adapter undefined (labels, handoff, claim) | Spec `github-queue` |
| IR7 | Major | Triage JSON schema + invalid JSON fallback | Spec `triage` |
| IR8 | Major | Gate/PROOF grammar and fail-closed behaviour | Spec `gates` |
| IR9 | Major | Run record schema, run-id, usage fallback, retry numbers | Spec `run-records`, `llm-providers` |
| IR10 | Major | Review personas not named, aggregation undefined | Spec `review-panel`, `src/personas/` |
| IR11 | Major | Verification plan lists areas, not cases | Concrete test cases in `tasks.md` |
| IR12 | Nit | No phasing; workflow permissions | Phases in `tasks.md`; workflow permissions in `design.md` |

## 2. Zoom-Out goldfish

| # | Sev | Finding | Resolution (elephant decision) |
|---|---|---|---|
| ZO1 | Blocker | Draft overrides the original design's "no orchestrator / no custom agent API" principle without saying so; cheaper alternative (point Claude Code / Codex at a gateway) not considered | **Accepted, principle override made explicit.** The requirement is an unattended factory that runs on an OpenAI key *or* a Portkey gateway with a model chosen in a config file. Harness re-pointing is added as Alternative D and shipped as documentation (`docs/HARNESS-GATEWAYS.md`) for people who stay on Claude Code / Codex, but it cannot enforce policy in code or run headless in plain GitHub Actions, so the runtime stays. |
| ZO2 | Blocker | Policy only enforced on the `ufactory` path | **Adopted.** New harness-neutral `ufactory policy-check --base <ref>` runs as a required GitHub status check on every PR, whichever harness wrote it. |
| ZO3 | Major | "Sandbox" boundary overstated; gates execute repo code; no shell makes agent weak | **Adopted.** Boundary = branch protection + least-privilege token. Tool allowlist is a guardrail. Added `agent.allowed_commands` (exact-match allowlist, e.g. formatter) so the agent is not crippled. |
| ZO4 | Major | YAGNI: Portkey depth, 4 provider types, 10-persona panel, USD budgets, OpenSpec | **Partially accepted.** Portkey and the 10-persona panel are explicit owner requirements, so they stay. Provider types are thin header maps over one client. The panel is opt-in and aggregates into **one** verdict + must-fix list so it saves review attention instead of spending it. Work is phased (MVP first). |
| ZO5 | Major | Tier ignored; spec needs human gates in a headless runtime | **Adopted.** `TIER` is parsed and changes behaviour (see policy decision table). `spec` drafts one gate per invocation and stops; `ufactory spec approve <issue> <gate>` is the only way to advance. Never runs in Actions. |
| ZO6 | Major | Charter is prose; no machine-readable source | **Adopted.** Parser reads only the fenced `KEY:` blocks already present in the original template. `CHARTER_STATUS` must be `ready`. Any parse failure = stop (fail closed). |
| ZO7 | Major | Public-repo trigger lets outsiders spend tokens / inject | **Adopted.** `github.trusted_associations` (default OWNER, MEMBER, COLLABORATOR); untrusted authors are skipped and recorded. Workflow uses least-privilege permissions + concurrency groups. Structural mitigation = tool restriction + code-side policy, not fencing. |
| ZO8 | Major | No claim lifecycle / recovery | **Adopted.** Claim lifecycle section: release on clean stop before code commits; label restored with reason comment; stale claims (> `github.stale_claim_hours`) reported by `monitor` and `status`, never auto-taken-over. Budget-exceeded → `factory:needs-info` with reason. |
| ZO9 | Nit | Audience + success criteria | **Adopted.** Audience: solo developers to small teams. Success criteria added. |
| ZO10 | Nit | Implementation detail in design doc | **Adopted.** Detail moved to the OpenSpec change. |

## 3. Design Critic goldfish

| # | Sev | Finding | Resolution |
|---|---|---|---|
| DC1 | Blocker | `run_gates`/`run_tests` execute agent-written code that can read API keys / GitHub token | **Adopted.** Gates and tests run with a **scrubbed environment** (allowlist: PATH, HOME, LANG, TMPDIR, CI, NODE_*/npm_config_* non-secret; every configured `*_env` secret, `GITHUB_TOKEN`, `GH_TOKEN` and any name matching `KEY|TOKEN|SECRET|PASSWORD` removed). Build manifests and test-runner config (package.json, lockfiles, pyproject.toml, Makefile, conftest.py, jest/vitest/pytest configs, .github/**) are protected by default. Recommended workflow gives implement a token without merge rights; branch protection is the boundary. Container isolation is documented as a hardening option. |
| DC2 | Blocker | Fork PRs / `pull_request_target` / outsider issues | **Adopted.** Workflow never uses `pull_request_target`; verify skips fork PRs; triage filters on `author_association`; `edited` only re-triages issues without a state label; `concurrency:` groups per stage. |
| DC3 | Major | Static `<untrusted>` tags can be closed by an attacker; diffs/files also untrusted | **Adopted.** Per-run random nonce delimiters; any occurrence of the delimiter in the content is escaped. Applied to issues, comments, diffs and file contents sent to verify/critic/review. Residual risk recorded in README. |
| DC4 | Major | Tests can print a fake `FACTORY_GATES ... GREEN` line | **Adopted.** Exit code is authoritative; the runtime passes `FACTORY_GATES_NONCE`; `gates.sh` echoes `nonce=`; only the **last** line with the right nonce is accepted and it must agree with the exit code, otherwise MISCONFIGURED. |
| DC5 | Major | Policy checks the model's `files_expected`, not the real diff; tamper via deletes/renames/config | **Adopted.** Policy is enforced on the **actual diff** (tracked + untracked) at every write and at finish; deletes and renames of test files count as tampering; test-runner config is protected; charter parse failure or `CHARTER_STATUS != ready` stops every writing stage. |
| DC6 | Major | Wire compatibility assumptions | **Adopted.** Per-provider `capabilities` (tools, json_mode, usage, temperature); `doctor --ping` performs a real tool-call round trip; missing `usage` → estimated (chars/4) and flagged `usage_estimated: true`; Portkey header precedence table; served model (from response) recorded; verify warns when verifier model == implementer model. |
| DC7 | Major | No cost estimates or default dollar cap | **Adopted.** Token budget always on (default 400k/run); `budget.max_usd_per_run` default 5 with a built-in price table that users override; per-stage estimate table in README; daily run cap `budget.max_runs_per_day` via a local usage ledger. |
| DC8 | Major | Retrying POSTs / 409 / GitHub writes | **Adopted.** LLM retries only on 429, 500, 502, 503, 504 and network errors (not 409/408 on POST... 408 kept as it means not processed); retries count toward the turn budget; GitHub writes are idempotent (marker-comment upsert, label set computed from current state). |
| DC9 | Major | Secret handling holes | **Adopted.** Every config string is scanned for secret patterns (`sk-`, `pk-`, bearer tokens, long hex/base64, userinfo in URLs); redaction covers `authorization`, `api-key`, `x-portkey-api-key`, `x-portkey-virtual-key`; `read_file`/`search` refuse secret files (`.env*`, `*.pem`, `*.key`, `id_rsa*`, `.npmrc`, `.pypirc`, `credentials*`); run records pass through the redactor. |
| DC10 | Major | Concurrency, crashed claims | **Adopted.** Claim commit carries run id + UTC timestamp (lease); local single-flight lock in `.git/ufactory.lock`; stale claims reported, never stolen; queue count re-read immediately before claiming. |
| DC11 | Major | Risks table, alternatives, success metrics | **Adopted.** Added to `design_draft.md`. Alternative A claim corrected. |
| DC12 | Nit | Hand-written glob is a security boundary | **Adopted.** Uses `picomatch` (zero-dependency, mature) with `dot: true`; deny-list matching is case-insensitive (over-match is the safe direction). |

## Outcome

All 3 Blockers from IR, 2 from ZO and 2 from DC are resolved. The design was revised and
approved by the elephant (who holds the owner's delegated decision authority for this build).
Detailed contracts live in OpenSpec change `build-ultimate-factory`.
