# FAQ

## 1. What is the factory for? Is it only for code, and does the language matter?

It turns GitHub issues in a software repository into tested, reviewed pull requests, with a
human deciding every merge. The unit of work is an issue small enough to finish in one run:
a bug with a reproducible test, a dependency bump, a missing test, a documentation fix.

It works on any Git repository hosted on GitHub, and only on software repositories in the sense
that it needs commands that can fail: tests, a type checker, a linter. The runtime does not parse
source code, so the language does not matter to it. The language matters in two places:

- **Gates.** `.factory/scripts/gates.sh` detects Node/TypeScript, Python, Rust, Go and C#/.NET
  (a solution, project or `global.json`: `dotnet build`, `dotnet format`, `dotnet test`, the NuGet
  vulnerability list and optional Stryker.NET). For Java, Ruby, PHP, C++ or anything else you edit its `DETECT` block and `.factory/gates.conf` to call
  your build tool; until you do, required gates are skipped and the verdict is `MISCONFIGURED`, so
  nothing passes by accident.
- **Test files.** The rule "never modify an existing test" uses `agent.test_paths`. The defaults
  cover common layouts for JavaScript/TypeScript, Python, Go, Java, Kotlin, C#, Ruby, PHP and
  Elixir. Rust unit tests inside `src/` files are not detectable by path; add your patterns.

Changes that cannot have a new failing test, such as a dependency bump, get no negative-test proof,
so their PRs are opened as drafts for a human read.

## 2. How is it executed in VS Code with Claude Code?

Two ways, on the same repository: interactively through the installed Claude Code skills
(`/factory`, `factory-triage`, `factory-spec`, `factory-implement`, `factory-verify`) in the
Claude Code panel, or by running `ufactory` (installed globally) from the integrated terminal or
the installed VS Code tasks. The two paths are not equally strict: in the Claude Code panel the
charter rules are instructions plus a shell hook, and are only checked in code when `policy-check`
runs on the pull request; with `ufactory` they are checked on every write. Details:
[VSCODE-CLAUDE-CODE.md](VSCODE-CLAUDE-CODE.md).

## 3. Does it have an agentic loop?

Yes, in one place. `implement` runs a tool-calling loop (`src/agent/loop.ts`): the model calls
`list_files`, `read_file`, `search`, `write_file`, `edit_file`, `delete_file`, `run_gates`,
`run_tests`, `run_command`, `give_up` and `finish`, sees each result, and decides the next call.
The loop ends on `finish` (which the runtime may refuse), `give_up`, a stop condition, or a budget
limit (`max_turns`, tokens, dollars, wall clock). If the verifier rejects the change, the loop
runs a second time with the verifier's must-fix list; a second rejection ends the run.

The other stages (triage, verify, critic, the review personas, spec and monitor) are single
structured calls with validated JSON output and one repair retry when the JSON is invalid.

## 4. Does it include an agent harness?

Yes. `ufactory` is a small harness of its own: tool definitions, a path-guarded workspace
(protected, load-bearing, secret and gitignored paths refused), a loop with stop conditions,
budgets, retries, model fallback and run records. The model has no shell, network or git tool of
its own.

`run_gates`, `run_tests`, `run_command` and the proof run code the model wrote. Their environment
never holds secrets, and the factory re-checks the tree and `.git` after each run. With
`agent.sandbox.mode: docker` (or `podman`) they also run in a throwaway container with no
network, no capabilities and their own PID namespace, so the factory's tokens cannot be read
through `/proc`. The default is `none` (your OS user), which suits local runs; `doctor` warns
about it.

It also installs adapters for two existing harnesses, Claude Code (`.claude/`) and Codex
(`.agents/`, `.codex/`), so you can use those instead of, or alongside, `ufactory`.

## 5. Is there a picture of how it works at run time?

Yes: [RUNTIME.md](RUNTIME.md) has the component diagram, the issue state machine, a step-by-step
sequence diagram of `implement`, what each model call contains, and where each safety check sits.

## 6. Is it simple enough to install, adjust and use?

For local use, these are the steps `ufactory init` prints:

1. Edit `factory.config.yaml` (provider and models) and export the API key it names
   (`OPENAI_API_KEY` or `PORTKEY_API_KEY`).
2. Fill in `docs/factory/CHARTER.md` and set `CHARTER_STATUS: ready`.
3. Point `.factory/gates.conf` at your real type, lint and test commands and set
   `agent.test_command`.
4. `ufactory doctor --ping`.
5. `gh auth login`, then `ufactory labels --apply`.
6. `ufactory triage` (dry run), then add `--apply`.

Before that, install the CLI from npm with `npm install --global ultimate-factory`, or run it
without installing with `npx ultimate-factory`.

Steps 2 and 3 take real thought, and that is deliberate: the charter decides what the factory may
touch, and the gates are what it is graded on. The files you edit are `factory.config.yaml`,
`CHARTER.md` and `.factory/gates.conf`, plus the `DETECT` block of `gates.sh` for a stack it does
not recognise. `doctor` lists every problem it finds, and unknown config keys are errors, so a
typo cannot silently fall back to a default.

Unattended GitHub Actions adds three more things: a pinned `UFACTORY_PACKAGE` variable, API key
secrets, and a branch ruleset that requires the policy check. It is usable by an engineer who is
comfortable with GitHub settings; it is not yet a one-click install.

## 7. How is context handled? Does it reduce token cost?

It is an agentic loop, so token use grows with each turn; the design bounds that growth rather
than claiming to be cheaper than other agents. What it does:

- **Fresh context per stage.** Triage, implement, verify and each review persona start from an
  empty conversation. Nothing carries over between issues or runs.
- **Files on demand.** The implement agent does not receive the repository; it reads what it
  asks for, 20k bytes per read, paged by line.
- **Compaction.** Tool results over 400 characters and older than 6 turns are replaced with
  one-line stubs; any single tool result is capped at 24k characters. The agent's own messages,
  including file contents it wrote, are kept, so a long run still grows linearly; the 400k-token
  run budget usually ends a stuck run within 15 to 25 turns.
- **Stable prefix.** System rules and the first user message never change within a run, so
  providers that cache prompt prefixes charge less for that part. The run record shows list-price
  cost and does not subtract cache discounts.
- **Targeted edits.** `edit_file` replaces one exact snippet instead of re-sending a whole file.
- **Cheaper models where judgement is lighter.** The example config uses a mini model for triage,
  monitor and the review panel.
- **Hard limits.** Per-run token, dollar, turn and wall-clock budgets, plus an optional cap on
  dollars over the last 24 hours (`budget.max_usd_per_day`). A call is refused when its
  prompt alone would exceed the remaining tokens; the dollar limit is checked between calls, so one
  call can overshoot it. Back-pressure stops `implement` before any model call when the human
  review queue is full, and a red default branch stops it before any model call too.
  `ufactory metrics` shows cost per attempt and per merged PR.

There is no embedding index or retrieval layer. For the issue sizes the charter allows (5 files,
400 lines by default), reading files on demand is enough.

## 8. Does model switching happen automatically?

Partly, by design:

- **Per stage, automatically.** Each stage (triage, implement, verify, critic, review, monitor,
  spec) uses the model configured for its role, and each review persona can use its own model.
- **On failure, automatically.** A role can list `fallbacks`. When a model still fails after its
  own retries, the next one takes over for that role until the command ends, and the run record
  shows which models served the calls. If a fallback would make the writer and the verifier the
  same model, the PR is marked for a human read.
- **By profile, manually.** `--profile portkey` or `UFACTORY_PROFILE` switches the whole set.
- **Through Portkey.** A Portkey config adds gateway-side fallbacks, load balancing and caching.

It does not pick a model by guessing how hard a task is. That choice is yours, per role.

## 9. How is it different from Claude Code and its skills?

Claude Code is a general interactive agent harness. Skills are instructions it reads and follows.
The original factory this project is based on is a set of such skills.

`ufactory` runs the same factory procedure as a program:

| | Claude Code + factory skills | ufactory |
|---|---|---|
| Rules such as "never edit the charter", "max 400 lines", "do not modify tests" | instructions the model is asked to follow, plus a shell hook | checked in code on every write, after every run of repository code, and on the commit before push |
| Model | Claude models, through Anthropic, Bedrock, Vertex or a gateway such as Portkey | any OpenAI-compatible endpoint, per stage and per review persona, with fallbacks |
| Unattended runs | cloud routines, or headless `claude -p` in CI | any machine or GitHub Actions with an API key |
| Gate and proof verdicts | the model quotes a line | the runtime authenticates each line (nonce + exit code) |
| Verification | a subagent, usually the same model family | a separately configured model, never shown the writer's summary; same-model setups force a human read |
| Cost control | turn limits and account limits | per-run token, dollar, turn and wall-clock budgets, recorded per run; `ufactory metrics` |
| Interactive exploration and spec writing | strong | limited to drafting one spec gate at a time |

They work together. Claude Code is better for exploratory and interactive work; `ufactory` is
better for repeatable, unattended, provider-neutral runs. `policy-check` holds pull requests from
both to the same charter.

## 10. How does it keep AI slop out of its own code and the code it generates?

One rule set, in `src/policy/slop.ts`, used in three places:

- **On every diff the factory writes.** When the agent calls `finish`, the added lines are
  checked. Narrating comments ("here we..."), comments that restate the code, change-log
  comments, elided code ("... existing code ..."), placeholders, empty `catch`/`except: pass`,
  emoji in comments, and the no-ai-slop prose rules (banned words, empty phrases) in comments
  and Markdown all refuse `finish` with a list of lines to fix (`agent.slop: block`, the
  default). After two refusals the run continues, and the remaining findings go in the PR body
  and force a human read. Comments are found by each language's comment syntax, so this works
  for C#, TypeScript, Python, Go, SQL and the rest.
- **On any pull request.** `policy-check` prints the findings for the PR's added lines as
  advisory output, so PRs written in Claude Code or by hand get the same check. `ufactory slop
  --base origin/main` runs it locally.
- **On this repository.** `npm run lint` runs it over the docs and every code comment.

The right skills for the parts a pattern cannot judge: Claude Code's built-in `/simplify`
(redundant code, needless abstraction) and `/code-review` on the factory PR before you approve
it, and the [no-ai-slop](https://github.com/petergyang/no-ai-slop) skill for prose you write.

## 11. Are SonarQube, Snyk and Wiz included?

As optional PR checks, not inside the factory runtime. `ufactory init --with-workflows` installs
`.github/workflows/factory-scanners.yml` with three jobs, each off until you set its repository
variable and secret: SonarQube or SonarCloud (with the .NET scanner for C# solutions), Snyk
(`snyk test --all-projects` and `snyk code test`) and the Wiz CLI. They run on factory PRs and on
everyone else's. Make the ones you enable required checks in the branch ruleset next to
`factory-policy`, so a factory PR cannot merge while a scanner is red. Each job holds only its
own scanner token; the factory's model keys and GitHub write token are never present there.

The factory's own `deep` gate already runs each stack's free audit tool (`npm audit`,
`pip-audit`, `cargo audit`, `govulncheck`, the NuGet vulnerability list).

## 12. Does the factory improve itself?

Yes, through proposals a human approves. It never changes its own rules.

Inside a run it already retries with feedback: red gates, policy refusals, AI-slop refusals and
the verifier's `must_fix` list go back to the agent, with fixed limits on retries. Across runs,
`ufactory tune` (weekly in Actions) does three things:

- It records what happened to each factory PR after merge: reverted, fixed in the same files
  within two weeks, labelled `factory:escaped`, or clean.
- It finds problems that recur across runs (the same verifier objection, failing gate, AI-slop
  rule or scope refusal) and posts proposals to one `factory:tune` issue. Escaped defects come
  first, as gates to tighten.
- Proposed lessons can arrive as a draft PR against `docs/factory/LESSONS.md` (`--open-pr`). Once
  merged, the implementation agent and the verifier read them on every run.

Why proposals and not automatic changes: the charter, protected paths and gates work because the
model cannot change them. A loop that rewrote them could be steered by text that ends up in a run
record, would learn to pass the verifier rather than to be right, and would tune on a few dozen
runs a month, which is mostly noise. So the loop counts patterns without a model call, the lessons
file is protected from the agent, a PR that changes it needs a maintainer's approval, and a lesson
cannot relax a rule. See README, "The learning loop".
