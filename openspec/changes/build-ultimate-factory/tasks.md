# Tasks

## 1. Phase 1: Config and LLM (exit: unit tests green, mock round trip works)

- [x] 1.1 Config types, discovery, YAML load, env interpolation, defaults
- [x] 1.2 Validation with path-qualified errors; secret scan (test: literal `api_key` rejected; `sk-` in header rejected; `${ENV}` value accepted; URL user-info rejected)
- [x] 1.3 Profiles and role resolution (test: role override; profile switch; unknown profile error)
- [x] 1.4 Provider request builder (tests: OpenAI auth, no-auth local, Portkey precedence ×4, unroutable Portkey error, Azure deployments vs v1 URL)
- [x] 1.5 Client with retry/backoff/Retry-After/timeout (tests: 429 + Retry-After honoured; 400 not retried; 503 retried then success; served model recorded)
- [x] 1.6 Usage tracker, price table, budget (tests: token budget stop; usage missing → estimated flag)
- [x] 1.7 Redactor (test: key in error body redacted)

## 2. Phase 2: Policy and gates (exit: policy tests green)

- [x] 2.1 Charter parser fail-closed (tests: shipped template incomplete → not ready; filled charter parses; custom STOP_IF limits)
- [x] 2.2 Path classes via picomatch (tests: dotfile glob; case-insensitive; secret files)
- [x] 2.3 Real diff stats incl. untracked, deletes, renames, binary
- [x] 2.4 Policy engine + tier effects + gate level (tests: test deleted → test-modified; lines over limit)
- [x] 2.5 `policy-check` command output line and exit codes
- [x] 2.6 Gate runner with nonce authenticity (tests: forged line → RED; exit mismatch → MISCONFIGURED); proof runner

## 3. Phase 3: Agent and implement (exit: e2e implement with mock LLM green)

- [x] 3.1 Workspace path guard (tests: charter write refused; `..` refused; symlink escape refused; secret read refused)
- [x] 3.2 Tools + dispatcher + output caps; scrubbed env (test: secret not visible to test command)
- [x] 3.3 Agent loop + stop conditions (test: diff limit crossed → write reverted, stopped)
- [x] 3.4 Implement stage `--local` (e2e: mock model writes code + test, gates green, proof, verifier accepts, record written)
- [x] 3.5 Verifier + critic calls with independence warning

## 4. Phase 4: GitHub stages (exit: dry-run plans correct with stubbed gh)

- [x] 4.1 gh wrapper with dry-run planner and idempotent marker upserts
- [x] 4.2 Handoff codec (tests: round trip; malformed detection; unknown keys ignored)
- [x] 4.3 Labels, transitions, review-queue count, claim + release
- [x] 4.4 Triage with overrides and trusted authors (test: injection naming protected path cannot become ready-to-implement)
- [x] 4.5 Implement with GitHub claim/PR; verify stage; spec stage with approve gates

## 5. Phase 5: Review, monitor, status, doctor, models (exit: panel test green)

- [x] 5.1 10+ personas; panel with concurrency, per-persona models, aggregation (tests: blocks below `block_quorum` → request-changes; >30% errors → incomplete)
- [x] 5.2 Monitor, status, run, doctor (`--ping` tool round trip), models list/test

## 6. Phase 6: Template, workflows, docs (exit: init idempotent; README complete)

- [x] 6.1 Template (reference files + nonce-aware gates.sh + factory.config.yaml + workflows)
- [x] 6.2 `init` never overwrites (test: second run creates nothing)
- [x] 6.3 README with tool/skill/plugin list, Portkey + OpenAI quickstarts, harness gateway doc
- [x] 6.4 CI workflow for this repo

## 7. Phase 7: Review and hardening

- [x] 7.1 10-persona engineering review of the implementation; record in `docs/reviews/`
- [x] 7.2 Fix all blocker/major findings; re-run tests

## 8. Phase 8: Second-round review items, AI-slop, .NET, scanners

- [x] 8.1 Container sandbox for repository code (`agent.sandbox`), doctor warning (test: no network, values not in argv)
- [x] 8.2 `factory-records` branch with `records pull|push`; `records` job in the workflow (test: concurrent pushes)
- [x] 8.3 `budget.max_usd_per_day` from records (test: 24-hour window)
- [x] 8.4 Panel `block_quorum` (test: lone block is request-changes)
- [x] 8.5 HMAC-signed handoffs (tests: altered, unsigned, other issue)
- [x] 8.6 Label ownership in `setState`; monitor reports conflicts (test: claim lands mid-write)
- [x] 8.7 AI-slop rules for code and prose in `src/policy/slop.ts`; implement refuses finish, policy-check reports, lint applies them to this repo, `ufactory slop` (test: model writes a narrating comment)
- [x] 8.8 C#/.NET in gates.sh, protected .NET manifests, .NET test paths, setup-dotnet in workflows (shell test with a stand-in dotnet)
- [x] 8.9 Optional SonarQube, Snyk and Wiz PR jobs in `factory-scanners.yml`

## 9. Phase 9: Learning loop

- [x] 9.1 `learn_signals` in run records from implement and verify (test: protected write recorded as a refusal signal)
- [x] 9.2 PR outcome records from GitHub state and default-branch history (tests: revert, same-file fix-up, unrelated fix, pending, clean, escaped label, unknown commit)
- [x] 9.3 Deterministic proposal analysis with stable ids and thresholds (tests: clustering, below threshold, active lesson still recurring, loosening blocked by a revert)
- [x] 9.4 `ufactory tune` with one proposals issue and an optional draft lessons PR built with git plumbing (tests: idempotent issue and outcome, checkout untouched, default branch unchanged)
- [x] 9.5 `docs/factory/LESSONS.md` read by implement and the verifier, protected from the agent (test: model writes the lessons file; proposed lessons never reach a prompt)
- [x] 9.6 Weekly `tune` job without repository code; `learning:` config; metrics shows outcomes
- [x] 9.7 Closed-loop evaluation over real implement runs with scripted models (`test/eval.test.ts`): lessons judged only by runs that had them, test edits proposed as a lesson, refusal codes normalised; proof temp file unique on macOS (shell test: two proofs at once)
