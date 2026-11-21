# Review by 10 PhD scientists

Five fresh-context reviewers, each playing two scientists, read the docs and the code, checked
every finding against file and line, and fact-checked the answers in [FAQ.md](../FAQ.md). This
file records their verdicts, what was changed, and what remains open.

## Verdicts

| Scientist (PhD) | Verdict | One-line assessment |
|---|---|---|
| Formal methods / programming languages | major revision | Checks are in the right places, but code under test runs as the same user, and the gated tree could differ from the committed tree |
| Distributed systems | major revision | The Git-ref claim is a correct compare-and-swap; lease, recovery and writer coordination around it were weak |
| Computer security | major revision | Write controls are solid; secret isolation and proof authenticity were overstated |
| Machine learning (LLM agents) | major revision | Overrides only push toward rejection (right direction); no evaluation of correctness |
| Empirical software engineering | major revision | Small batches and WIP limits match the evidence; the proof was skipped by default |
| Human-computer interaction | major revision | Good error messages; three different setup lists and a self-contradicting charter |
| Operations research / queueing | major revision | WIP limit is sound; budgets and spend in CI were loose |
| Statistics / experimental design | major revision | Records described process, not outcomes |
| NLP / information retrieval | major revision | Whole-file writes with compaction and no way to give up |
| Reliability engineering / control | major revision | Monitor could flood the tracker; no circuit breaker on a red baseline |

## Changed because of this review

| Finding | Change |
|---|---|
| Proof skipped by default (empty `test_command`) | `implement` refuses to start without `agent.test_command`; `doctor` fails on it |
| A test could print `PROOF: status=PROVEN` and downgrade a FAILED proof | Proof line carries a per-run nonce, removed from the environment before tests run, and must agree with the exit code. Test added |
| Proof counted any non-zero exit, including tests that are not new | `finish` requires `test_paths` to be test files added by this change; `{tests}` in `test_command` runs only those during the proof |
| Pristine gate copy was a temp file a running test could rewrite | Gate and proof scripts run from memory (`bash -c`); the gate config is passed as text |
| Gated tree could differ from the committed tree | Writes to gitignored paths and the run-records directory are refused. Test added |
| Default verifier was the same model as the writer | Example config uses `o4-mini` to verify and `gpt-4.1` as critic; independence is checked across whole fallback chains and served models |
| Fallback did not stick across calls | One `FallbackLlm` per role and persona for the whole command |
| Verifier schema let missing fields through; critic unvalidated | Booleans and arrays required (missing means retry, then reject); critic fields validated |
| Whole-file writes only; a limit overflow ended the run; no way to give up | `edit_file` (unique-match replace), `give_up` (reverts all changes), overflow now reverts and refuses. Tests added |
| File contents and tool output reached the model unfenced | `read_file` content and gate/test/command output are fenced |
| No circuit breaker on a red default branch | Fast gates run on the base commit after the claim; red releases the claim and stops with `baseline-red` before any model call. Test added |
| Poison issue re-queued every hour | After two earlier failed runs, the item goes to `needs-info` |
| Monitor titles changed every run, so dedupe failed | Stable titles and a hidden `factory-monitor:<key>` marker; orphaned claim branches are reported |
| Triage could rewrite the handoff of claimed work | Triage skips `in-progress` and `awaiting-review` issues. Test added |
| Label change left no state label on failure | New label is added before the old one is removed |
| Claim release was check-then-delete | Delete uses `--force-with-lease` on the claim commit |
| Signal handler raced the main path | Handler kills child process groups and lets the main path clean up; a timer writes the record if cleanup stalls |
| Marker comments matched any author in Actions | Uses the factory bot login |
| `policy-check` workflow skipped the version pin | Same exact-version check as the main workflow |
| Records could not measure outcomes | New fields `attempted`, `changed_lines`, `changed_files`, `agent_turns`, `duration_seconds`; `ufactory metrics` reports attempted, opened and merged rates, stop reasons, proof and verifier mix, cost per attempt and per merged PR |
| PR bodies invited rubber-stamping | Every PR body has a "Not checked by the factory" section |
| Charter template contradicted the code; typo; dead reference | Tier table rewritten to match the code; explicit `LIMITS` block; typo and reference fixed |
| `doctor` reported one problem at a time | Lists every charter problem; skips the `gh` auth check when `gh` is missing |
| Test-file patterns missed Java, C#, Kotlin and others | Defaults cover JS/TS, Python, Go, Java, Kotlin, C#, Ruby, PHP, Elixir, nested test folders |
| VS Code tasks assumed `origin/main` | Use `origin/HEAD` |
| FAQ, RUNTIME and README overstated several points | Corrected: Q1, Q2, Q3, Q4, Q6, Q7, Q8, Q9, the state diagram, the cost table and the safety table |

## Closed in the second round

| Open item | Change |
|---|---|
| OS-level isolation | `agent.sandbox.mode: docker` or `podman` runs gates, tests, allowlisted commands and the proof in a throwaway container: own PID namespace, `--network none` by default, `--cap-drop ALL`, `no-new-privileges`, the factory's UID, variables passed by name so values never reach argv. Timed-out and signalled containers are removed. `doctor` warns when the sandbox is off. Test added |
| Durable records in CI | `ufactory records push` appends records to the `factory-records` branch with git plumbing (no checkout, no repository code; retries when another job pushed first). A `records` job in `factory.yml` collects every job's records; implement pulls the last two days before it starts. Test added |
| Daily spend cap | `budget.max_usd_per_day` sums `cost_usd` from records started in the last 24 hours; implement stops with `daily-spend-cap` before any claim. Test added |
| Panel aggregation | `review.block_quorum` (default 2): one block among ten personas becomes request-changes, never approve; the quorum is capped at the number of personas that answered. Test added |
| Handoff signing | With `UFACTORY_HANDOFF_KEY` set, triage and spec publish sign each handoff (HMAC-SHA256 over its fields and the issue number); implement and verify reject unsigned, altered or moved handoffs. Test added |
| Label writes | Triage yields to the states only the claim holder writes (`in-progress`, `awaiting-review`): it skips when one is present and removes its own label when one appears during its write. The owner reads back and removes any extra state label. `monitor` reports issues with two state labels. Test added |

## Still open

1. **Correctness evaluation.** There is no benchmark. A team should replay historically fixed
   issues (revert the fix, hide the tests) and measure resolve rate, and feed known-bad patches to
   the verifier to measure its false-accept rate.
   It needs a team's own fixed issues, so it cannot ship as code; the run-record fields and
   `ufactory metrics` are the measurement side.
2. **Panel calibration.** The quorum reduces false rejections; whether 2 is the right number for a
   given team still needs human-labelled reviews.
3. **Network inside the sandbox.** Test suites that need the network must use
   `network: bridge`, which gives code under test outbound access again.

## How to evaluate the factory (from the statistics review)

Randomise at the issue level, not by calendar period. Stratify by gate level and size, keep human
reviewers blind to the arm, and use "merged and not reverted within 30 days, per attempted issue"
as the primary metric. Compute cost per merged PR as the cost of all runs, failures included,
divided by merges. Detecting a 15-point change from 50% needs about 170 issues per arm.
