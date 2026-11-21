# Engineering review: 10 personas

The implementation (`src/`, `template/`, `test/`) was reviewed by **10 senior engineering
personas**. Five independent reviewers ran in fresh contexts, each covering two personas. None
saw the author's reasoning, and each checked its findings against the code (file:line) before
reporting. This file records the verdicts, every blocker and major finding, and how each was
resolved. Minor findings that were fixed are listed at the end; findings that were consciously
accepted are listed with the reason.

## Verdicts (before fixes)

| # | Persona | Verdict | Score |
|---|---|---|---|
| 1 | Principal Software Architect | request-changes | 6/10 |
| 2 | API & Interface Design | request-changes | 6/10 |
| 3 | Principal Security Engineer | **block** | 3/10 |
| 4 | Staff ML / AI Systems Engineer | request-changes | 5/10 |
| 5 | Staff Backend Engineer | request-changes | 5/10 |
| 6 | Staff Site Reliability Engineer | **block** | 4/10 |
| 7 | QA & Test Architect | request-changes | 6/10 |
| 8 | Performance & Cost Engineer | request-changes | 5/10 |
| 9 | Developer Experience & Platform | **block** | 4/10 |
| 10 | Staff Data Engineer | request-changes | 6/10 |

Test suite at review time: 59 node tests and 5 shell suites passing. After fixes: **81 node tests
and 5 shell suites passing**, lint and typecheck clean.

## Blockers and resolutions

| Persona | Finding | Resolution |
|---|---|---|
| Security | Agent-written code runs during gates *after* the last policy check, and its side effects (new workflow files, git hooks, `core.fsmonitor`) could be committed and pushed. Git ran with full env, so hooks could steal secrets. | (1) every factory git call runs with `core.hooksPath=/dev/null` and `core.fsmonitor=false` (`src/util/git.ts`); (2) policy is re-evaluated after **every** gate run, after the proof, and on the committed diff right before push (`tamperCheck`, final `committed` check in `implement.ts`); (3) `.git/config` digest must be unchanged; (4) the tree must be clean after the proof; (5) workflows use `persist-credentials: false` and push via `gh auth setup-git`, whose helper needs `GH_TOKEN`, which gates never see. Test: *a test that writes a protected file while gates run is caught*. |
| Security | Gate nonce visible to tests; gate script and `gates.conf` read from the mutable worktree | `gates.sh` unsets `FACTORY_GATES_NONCE` immediately; `runGates`/`runProof` execute **pristine copies from the base commit** (`FACTORY_ROOT`, `FACTORY_GATES_CONF`). |
| SRE | `verify` never runs for factory PRs: PRs opened with `GITHUB_TOKEN` do not trigger workflows | Implement writes `pr_number` to `GITHUB_OUTPUT`; the implement job runs `ufactory verify` inline. Optional `FACTORY_GH_TOKEN` (App/PAT) documented. |
| SRE | A killed or cancelled job leaves the claim and no run record | SIGTERM/SIGINT handler releases an unpushed claim, restores the label, writes an `infrastructure-failed` record. New wall-clock budget `max_minutes_per_run` (default 50) keeps runs inside job timeouts. |
| Backend | Failure after claim restored labels from a stale copy, so issues got stuck at `in-progress` | `setState` re-reads live labels before writing. Test: *a failure after the claim restores exactly one state label*. |
| DevEx | Workflows ran `npx ultimate-factory@1` but the name is unpublished (404). `--yes` would execute whatever someone else later publishes under that name, with secrets present | Workflows install from the **required** repository variable `UFACTORY_PACKAGE` (pinned version or git URL + tag) and fail with a clear error when unset. No floating version. Publishing to npm is left to the owner. |
| DevEx | In Actions, `GET /user` fails, so implement distrusted triage's own `github-actions[bot]` handoffs | `GitHub.botLogin()`: `UFACTORY_BOT_LOGIN` → `github-actions[bot]` in Actions → `gh api user`. Test: *implement in Actions trusts handoffs from github-actions[bot]*. |

## Major findings and resolutions

| Persona | Finding | Resolution |
|---|---|---|
| Architect, Security, DevEx | `factory:human-approved` label not tied to a commit or to the approver; `ACTOR` was the pusher | Policy workflow accepts only an **APPROVED review on the current head SHA** by an OWNER/MEMBER/COLLABORATOR who is not the PR author, plus the label. A new push invalidates it. |
| Architect | Protected paths and tests had no override, so the required check blocked legitimate human PRs | A verified approval overrides `load-bearing`, `protected`, `test-modified`, line and file limits; **secret files are never overridable**. Test added. |
| Architect | `policy-check` failed if the *model* config was broken | `policyOnly` loading; works with no config file at all. Test added. |
| Architect | Charter limits regexed from prose, silent default on rewording | Explicit `LIMITS:` block wins; prose that mentions a limit but cannot be parsed is a charter error. Tests added. |
| Architect | Review-queue count ignored open factory PRs (spec mismatch) | Count = issues `awaiting-review` ∪ open `factory/fq-*` PRs, deduplicated by issue. |
| API | Exit codes did not match help; `--json` printed text before JSON in two shapes | One documented exit-code table in `--help` and README; `policy-check --json` emits a single `factory-policy/v1` object; line carries `v=1`. |
| API | `"false"` from `${ENV}` ignored; unknown config keys silently dropped | Boolean strings accepted; **unknown keys are errors** at every level. Tests added. |
| Security | `search` followed symlinks out of the repository | `lstat`, symlinks skipped, total scan capped at 50 MB, regex complexity guard. Test added. |
| Security | `verify` took gate level and `done_when` from the PR body (agent-influenced) | Taken from the factory-authored handoff for `fq-<n>` and the charter; the PR body is only compared, never trusted. |
| ML/AI | Model could lower the gate level below the charter default | `gateLevel = max(requested, charter default)`. Test added. |
| ML/AI | Verifier `done_when_true:false` / `scope_ok:false` ignored; scope not checked in code | Either flag forces `rejected`; out-of-scope files become a draft reason. Test added. |
| ML/AI, Perf | Unbounded context growth; permanent 4xx re-queued forever | History compaction (tool results older than 6 turns become stubs), 24k-char cap per tool result with valid JSON; permanent 4xx moves the item to `needs-info`. Tests added. |
| ML/AI | Same model for writer and verifier only annotated | Now a **draft reason** (human read required). |
| ML/AI | Policy line to verifier always `PASS`; critic `oppose` ignored | Real status passed; `oppose` on a load-bearing change stops the run. |
| Backend | One orphaned claim branch stalled the whole queue; push errors looked like lost races | Implement checks `ls-remote`, tries the next ready issue, distinguishes non-fast-forward from network errors; publish failure after push goes to `needs-info`. |
| Backend | `createPullRequest` not idempotent | Reuses an open PR for the same head; labeling is best-effort. |
| Backend | `verify` ignored checkout failures and could not restore a detached HEAD | Checkout result checked; restore to original ref or SHA, failures logged. |
| SRE | Timeouts killed only `bash`, grandchildren kept pipes open | Children run in their own process group; the whole group is killed; hard resolve after 5 s. |
| SRE | LLM timeout did not cover reading the body; 200 + HTML not retried | Timer covers `res.text()`; non-JSON 200 is retryable. Tests added. |
| SRE | No retries on GitHub 5xx/rate limits | `gh` GET calls retry with backoff on transient errors. |
| SRE | Triage concurrency dropped burst events; jobs had no timeouts | Per-issue concurrency group; `timeout-minutes` on every job. |
| Perf | Panel subject (150k chars × 10) exceeded the default budget | Subject capped at 60k characters per persona. |
| Perf | Budget checked only after the fact | Calls refused when the estimated prompt alone exceeds what remains; cost priced by the **served** model. Tests added. |
| QA | Verifier double-reject, budget stop and crash record untested | Added e2e tests for each, plus unknown-tool and tamper refusals asserted on the transcript. |
| Data | `QUEUE.md` overwritten by single-issue triage | Entries merged by FQ id, schema marker `queue-snapshot/v1`. Test added. |
| Data | Run records parsed with regexes (CRLF, quoting) | `yaml.parse` on normalized front matter; records carry `schema: run-record/v1`; written atomically (temp file + `link`, never overwrite). |
| Data | Spec approvals not tied to content | `approved_sha256` per gate; `publish` refuses edited-after-approval gates. `--by` required. |
| DevEx | Empty `UFACTORY_PROFILE` from an unset Actions variable overrode `active_profile` | Empty strings mean unset. Test added. |
| DevEx | Init next steps assumed `ufactory` on PATH, said nothing about CI | Prints the actual invocation, CI variables, secrets and the ruleset. |

## Minor findings fixed

`triage` only feeds trusted commenters' comments to the model · triage requires a size estimate ·
handoff decoder reads only the fenced block and validates `triaged_at` · backticks escaped ·
`DOC_FILES` by extension only · `gates` command labels synthesized verdicts · `verify
--test-paths` in help · `capabilities.usage: false` forces estimation · `@types/picomatch` moved
to devDependencies and published files narrowed to `dist/src` · env vars referenced in provider
settings added to the redaction list · comment pagination.

## Accepted, documented, not changed

| Finding | Why accepted |
|---|---|
| Gates execute repository code with network access (no container sandbox) | The structural boundary is branch protection plus a token without merge rights. Secrets are removed from the environment, hooks are disabled and the tree is re-checked after execution. A container sandbox is recommended in the README for high-risk repos. |
| `max_runs_per_day` cannot see runs on fresh CI checkouts | In Actions the hourly schedule and the implement concurrency group bound throughput to 24 runs/day; documented in README Limits. |
| Untracked delete+add is not detected as a rename | It overcounts lines, which is the conservative (safe) direction. |
| Per-write diff rescans the repository | Correct and bounded by the 5-file / 400-line charter scope; optimisation deferred. |

## Verification round

A separate fresh-context reviewer re-checked the seven blocker fixes against the code. It
confirmed three as complete (inline verification output, stale labels, bot login) and found
holes in the others. Those were closed:

| Gap found | Fix |
|---|---|
| Repository code could edit `~/.gitconfig` (credential helper, `pushInsteadOf`, filter driver) that the factory's git would read | `freezeGitConfig()` copies the system and global git config at process start; every factory git call uses that copy (`GIT_CONFIG_GLOBAL`, `GIT_CONFIG_NOSYSTEM=1`, `GIT_NO_REPLACE_OBJECTS=1`). Test: *git config written by repository code after startup is invisible*. |
| `refs/replace` or a moved HEAD could change what is pushed | Digest covers `.git/config`, `.git/info`, `refs/replace`, `shallow`; HEAD must equal the checked commit; the push sends that commit SHA explicitly. |
| Inline verify ran in the same workspace and `$HOME` as the agent's code | Verification of new PRs moved to a separate `verify-new-pr` job on a fresh runner, sharing the verify concurrency group. |
| PR created already labelled `factory:verified` | No label at creation; only `verify` sets `verified` or `rejected`. |
| Read-only `COLLABORATOR` reviews could approve overrides; a later "changes requested" was ignored | Latest review per reviewer must approve the head SHA, and the reviewer's permission must be `write`, `maintain` or `admin`. |
| Wall clock checked only before model calls; signal after push left `in-progress`; gate children orphaned | Budget checked before the finish gate run; signal handler sets `needs-info` after a push and kills every process group it started. |
| `UFACTORY_PACKAGE` accepted unpinned values | Workflows require an exact semver, tag or 40-character commit. |
| Repository code run by `run_gates`, `run_tests`, `run_command` was not re-checked immediately | `tamperCheck` runs after each of them. |

Accepted with documentation: on Linux a test can read the gate nonce from a parent process's
environment; the exit-code agreement check still prevents turning RED into GREEN.
