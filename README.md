# Ultimate Factory

Ultimate Factory turns GitHub issues into tested, independently verified pull requests. Each
stage runs on the model and endpoint you set in one config file: an OpenAI API key, a Portkey
gateway (including Model Catalog models), Azure OpenAI, or any OpenAI-compatible server. A human
writes the charter that limits what the factory may touch, approves specs, and makes every merge.

```
issue ──triage──▶ factory:ready-to-implement ──implement──▶ claim branch ──▶ agent (sandboxed)
                                                              │
        gates (nonce-authenticated) ◀─────────────────────────┘
              │
   negative-test proof ──▶ verifier (separately configured model) ──▶ critic (advisory)
              │
        draft PR ──▶ verify on PR ──▶ 10-persona review panel (optional) ──▶ HUMAN MERGE
              │
   policy-check (no LLM, every PR, any harness) ─── required status check
```

Factories built only from agent instructions ask the model to follow the rules. Ultimate Factory
ships the same kind of charter, contract and skills, checks the rules in code at every step, and
runs on a laptop, a cron job or GitHub Actions.

**Status:** published on npm as
[`ultimate-factory`](https://www.npmjs.com/package/ultimate-factory). Install it with
`npm install --global ultimate-factory`, or run it with `npx ultimate-factory`.

New here? Read [docs/FAQ.md](docs/FAQ.md) first. It answers what the factory is for, how it runs
in VS Code with Claude Code, how context and cost are handled, and how it differs from Claude Code
skills. [docs/RUNTIME.md](docs/RUNTIME.md) shows what happens inside a run.

---

## Contents

- [Design choices](#design-choices)
- [How it works](#how-it-works)
- [What it needs](#what-it-needs)
- [Setup](#setup)
- [Quick start with Portkey](#quick-start-with-portkey)
- [Configuration: models and endpoints](#configuration-models-and-endpoints)
- [Commands](#commands)
- [Run it unattended on GitHub Actions](#run-it-unattended-on-github-actions)
- [Safety model](#safety-model)
- [The 10-persona review panel](#the-10-persona-review-panel)
- [Required and optional tools, skills and plugins](#required-and-optional-tools-skills-and-plugins)
- [Cost](#cost)
- [Using it from VS Code and Claude Code](#using-it-from-vs-code-and-claude-code)
- [How this was built](#how-this-was-built)
- [Development](#development)
- [Limits](#limits)

---

## Design choices

| Problem with instruction-only factories | What Ultimate Factory does |
|---|---|
| Model and endpoint are fixed by the harness | `factory.config.yaml`: provider + model per stage, profiles, per-persona models |
| Needs Claude Code cloud routines | Plain Node CLI: laptop, cron, or GitHub Actions with only an API key |
| No `issues` trigger (up to 1 h latency) | Actions workflow reacts to `issues: opened` directly |
| Load-bearing paths, 400-line limit, test tampering, queue limit enforced by prompts | Enforced in code on the **real diff**; violating writes are refused or reverted |
| Rules apply only to runs of that harness | `ufactory policy-check` is a required status check for **every** PR |
| Verifier is the same model as the writer | Separate `verify`/`critic` roles; warns when they are identical |
| Agent-printed text can fake a green gate | Per-run nonce + exit-code agreement on the `FACTORY_GATES` line |
| No cost limit | Token, USD, turn and daily-run budgets; usage per model in every run record |
| Free-text run records | Schema-valid, redacted YAML front matter written by code |

## How it works

`ufactory` is a command-line tool you run inside the repository you want worked on. It reads
GitHub issues, has a model write the change, grades the change with your own tests and with
rules checked in code, and opens a pull request with the evidence. It never merges.

| Stage | What it does |
|---|---|
| `triage` | Reads new issues from owners, members and collaborators. The model classifies each one (small and safe, needs a spec, needs a human); the factory posts a handoff comment (files expected, definition of done) and sets one `factory:*` label. With `UFACTORY_HANDOFF_KEY` set the handoff is signed, so an edited or forged comment is rejected later |
| `spec` | For risky work only. Drafts a plan that a person approves with `spec approve`. Refuses to run in CI |
| `implement` | See below |
| `verify` | Re-runs gates, proof, policy, verifier and critic on the PR, since the PR can change after it is opened |
| `review` | Ten engineering personas (architect, security, SRE, QA and others) review the diff; one combined verdict, and a block needs `review.block_quorum` personas (default 2) |
| `monitor` | Weekly: deep gates (audits, mutation testing) on the default branch, stale claims, a full review queue; opens at most 10 deduplicated issues |

`implement` does the work, in this order:

1. **Back-pressure and budgets.** Stops if too many factory PRs are waiting for review or a
   budget is spent.
2. **Claim.** Creates `factory/fq-<issue>` on the remote. Only one run can create it, so two runs
   never work the same issue.
3. **Agent loop.** The model gets a small tool set: read and search files, write files, run tests,
   run gates, run commands you allowed, finish. Every write is checked in code against the
   charter: protected paths, secret files, load-bearing paths and size limits are refused
   whatever the model says.
4. **Gates.** `.factory/scripts/gates.sh` runs your type check, lint, tests and build, with a
   per-run nonce so printed text cannot fake a green result.
5. **Negative-test proof.** The new tests must fail on the old code and pass on the new code.
6. **AI-slop check.** `finish` is refused while added lines contain narrating comments,
   placeholders, swallowed errors and the like.
7. **Verifier and critic.** A separately configured model judges the diff.
8. **Pull request.** Opened with the gate, proof and verifier evidence in its body.

Every run writes a run record (tokens, cost, outcome, stop reason) that `ufactory status` and
`ufactory metrics` read. [docs/RUNTIME.md](docs/RUNTIME.md) walks through one run in detail.

## What it needs

| Need | Why |
|---|---|
| Node.js ≥ 20.10, git, bash | Runs the CLI and the gates |
| A model key: `OPENAI_API_KEY`, `PORTKEY_API_KEY`, Azure OpenAI or a local OpenAI-compatible server | Every stage calls a model. Keys are read from environment variables only, never from the config file |
| GitHub CLI `gh`, signed in | Reads issues, sets labels, opens PRs (not needed for `implement --local`) |
| Your stack's tools (npm, pytest, cargo, go, dotnet, ...) | The gates run your real checks |
| Docker or Podman (optional) | `agent.sandbox`: runs repository code with no network; recommended for unattended runs |
| Sonar, Snyk or Wiz accounts (optional) | Extra PR scanners, each off until you enable it |

## Setup

**1. Install the CLI** from npm:

```bash
npm install --global ultimate-factory
```

```bash
ufactory --version
```

Or run it without installing: `npx ultimate-factory <command>`.

**2. Install the factory into your repository.** This never overwrites existing files.

```bash
cd /path/to/your/repo
ufactory init . --with-workflows
```

It writes `factory.config.yaml`, `docs/factory/CHARTER.md` and `CONTRACT.md`, `.factory/gates.conf`
and its scripts, the `CLAUDE.md` and `AGENTS.md` adapters, and (with `--with-workflows`) the
GitHub workflows.

**3. Choose models** in `factory.config.yaml`: a provider and a model per role. Use a different
model for `verify` than for `implement`. Then export the key the config names:

```bash
export OPENAI_API_KEY=...
```

**4. Fill in the charter.** Nothing that writes will run until you do. In
`docs/factory/CHARTER.md` choose a `TIER`, list your `LOAD_BEARING` paths (code the factory may not
touch without a spec), set the `LIMITS` (files and lines per change), review every section and set
`CHARTER_STATUS: ready`. This is a human decision on purpose.

**5. Point the gates at your real checks.** Check `.factory/gates.conf` (and, for a stack it does
not detect, the `DETECT` block of `.factory/scripts/gates.sh`), then set `agent.test_command` in
`factory.config.yaml`, for example `npm test` or `dotnet test`. `{tests}` in the command is
replaced by the new test files during the negative-test proof.

**6. Check everything.** `doctor` checks tools, auth and the charter, prints the role-to-model
table and makes one real tool call:

```bash
ufactory doctor --ping
```

**7. Try one task with no GitHub at all.** The work lands on a local `factory/fq-…` branch, with
the evidence printed as the PR body would show it:

```bash
ufactory implement --local --task "parseDate() throws on ISO strings with a Z suffix" --done-when "test/parse-date.test.js passes" --files src/parse-date.js,test/parse-date.test.js
```

**8. Connect GitHub.** Every stage that writes to GitHub is a dry run until you add `--apply`.

```bash
gh auth login
```

```bash
ufactory labels --apply
```

```bash
ufactory triage
```

When the dry run looks right, run `ufactory triage --apply`, then `ufactory implement --apply`.
After that: `ufactory status` and `ufactory metrics`. To run it on a schedule without a laptop,
see [Run it unattended on GitHub Actions](#run-it-unattended-on-github-actions).

## Quick start with Portkey

```bash
export PORTKEY_API_KEY=...
ufactory --profile portkey models     # see what each role resolves to
ufactory --profile portkey doctor --ping
```

The shipped `portkey` profile uses Model Catalog names (`@<provider-slug>/<model>`). Replace the
slugs with the ones in your Portkey workspace. Other Portkey routing options, in precedence order:

| Option in `providers.portkey` | Header sent | Use when |
|---|---|---|
| `config: pc-xxxx` | `x-portkey-config` | You use saved configs (fallbacks, load balancing, caching, guardrails) |
| `virtual_key_env: PORTKEY_VIRTUAL_KEY` | `x-portkey-virtual-key` | Legacy virtual keys |
| `provider: openai` (+ `provider_api_key_env`) | `x-portkey-provider` (+ `Authorization`) | Bring your own upstream key |
| none of the above | (none) | Model is a catalog reference `@slug/model` |

Every request also carries `x-portkey-trace-id` = the run id and `x-portkey-metadata`
(`run_id`, `stage`, `role`, plus your metadata), so each factory run appears as one trace in
Portkey. For a self-hosted gateway set `PORTKEY_BASE_URL=http://localhost:8787/v1`.

Make it the default with `active_profile: portkey`, `UFACTORY_PROFILE=portkey`, or the Actions
variable `UFACTORY_PROFILE`.

## Configuration: models and endpoints

Everything lives in `factory.config.yaml`. The fully annotated reference is
[`factory.config.example.yaml`](factory.config.example.yaml). The shape:

```yaml
providers:                       # where requests go
  openai:  { type: openai,  api_key_env: OPENAI_API_KEY }
  portkey: { type: portkey, api_key_env: PORTKEY_API_KEY, config: "${PORTKEY_CONFIG_ID:-}" }
  azure:   { type: azure-openai, base_url: https://res.openai.azure.com, api_key_env: AZURE_OPENAI_API_KEY, api_version: 2024-10-21 }
  local:   { type: openai-compatible, base_url: http://localhost:11434/v1, api_key_env: "" }

models:                          # which model each stage uses
  default: { provider: openai, model: gpt-5.1 }
  roles:
    triage:    { model: gpt-5.1-mini }
    implement: { model: gpt-5.1, reasoning_effort: medium, max_output_tokens: 16000 }
    verify:    { provider: portkey, model: "@anthropic/claude-sonnet-4-5" }   # independent judge
    critic:    { provider: portkey, model: "@anthropic/claude-sonnet-4-5" }
    review:    { model: gpt-5.1-mini }

profiles:                        # switch everything with --profile NAME
  portkey: { models: { default: { provider: portkey, model: "@openai/gpt-5.1" } } }

review:
  persona_models:                # spread the panel across vendors
    security-engineer: { provider: portkey, model: "@anthropic/claude-opus-4-1" }
```

Resolution order for a role: `models.default` → profile default → `models.roles.<role>` → profile
role → `review.persona_models.<persona>`.

Automatic switching on failure: give a role `fallbacks`. When a model still fails after its own
retries (outage, rate limit, removed deployment), the next model takes over for the rest of the
command:

```yaml
models:
  roles:
    implement:
      model: gpt-5.1
      fallbacks: [ gpt-4.1, { provider: portkey, model: "@anthropic/claude-sonnet-4-5" } ]
```

Model settings: `provider`, `model`, `temperature`, `top_p`, `max_output_tokens`,
`reasoning_effort` (`minimal|low|medium|high`), `token_param` (`max_completion_tokens` default,
`max_tokens` for older servers), `json_mode`, `extra_body`, `fallbacks`.

Provider settings: `type`, `base_url`, `api_key_env`, `headers`, `timeout_ms` (120000),
`max_retries` (4), and `capabilities` (`tools`, `json_mode`, `usage`, `temperature`) for servers
that lack a feature.

Secrets: only `*_env` names and `${ENV}` references. The loader **rejects** literal keys
(`sk-…`, `Bearer …`, long hex/base64, `user:pass@` URLs) anywhere in the file.

## Commands

| Command | What it does | Writes |
|---|---|---|
| `init [path] [--with-workflows] [--harness claude,codex]` | Install charter, contract, gates, Claude/Codex adapters, config, workflows. Never overwrites. | files |
| `doctor [--ping]` | Tools, auth, charter, role → model table, real tool-call ping | none |
| `models` | Show the resolved provider/model per role and persona | none |
| `labels --apply` | Create the `factory:*` labels | GitHub |
| `triage [--issue N] [--apply]` | Classify untriaged trusted issues; handoff comment + one state label | GitHub |
| `spec draft\|approve\|publish --issue N` | Human-gated spec: draft one gate, approve it, publish slices. Refuses in CI. | files, GitHub |
| `implement [--issue N] [--apply]` | Back-pressure check → claim → agent → gates → commit → proof → verifier (+critic) → PR | git, GitHub |
| `implement --local --task … --done-when …` | Same pipeline, no GitHub, local branch only | git |
| `verify --pr N [--apply]` | Re-run gates, proof, policy, verifier, critic; post verdict; label PR | GitHub |
| `review --diff BASE \| --pr N \| --path P` | 10-persona engineering panel, one aggregated verdict | GitHub (with `--pr --apply`) |
| `policy-check --base REF` | Charter on the real diff. No LLM, no secrets. | none |
| `gates [fast\|full\|deep]` | Run gates with verdict authentication | none |
| `slop [--base REF] [paths]` | AI-slop check on added lines since REF, or on whole files; same rules `implement` applies at finish | none |
| `records pull\|push [--apply]` | Sync run records with the `factory-records` branch (git plumbing; the checkout is not touched) | git |
| `monitor [--apply]` | Deep gates on main, stale claims, full queue, advisories → ≤10 deduplicated issues | GitHub |
| `status` | Control room: review queue first | none |
| `metrics [--json]` | Attempted, opened and merged rates; stop reasons; proof and verifier mix; cost per merged PR | none |
| `run [--apply]` | `triage` then `implement` (for cron) | GitHub |

Global: `--config FILE`, `--profile NAME`, `--cwd DIR`, `--apply`, `--verbose`, `--quiet`.
Every stage that writes to GitHub is a dry run unless you pass `--apply`.

| Exit code | Meaning |
|---|---|
| 0 | success, dry run, or deliberate stop (nothing to do, review queue full, already claimed) |
| 1 | failing verdict (gates RED, policy FAIL, verifier or panel rejected, run stopped on its rules) |
| 2 | configuration or setup problem (bad config or flags, MISCONFIGURED gates or policy, dirty tree) |
| 3 | budget exceeded (tokens, USD, turns, wall clock) |
| 4 | charter not ready, or the work needs a spec or a human (load-bearing or protected scope) |
| 5 | provider, GitHub or git infrastructure error |

## Run it unattended on GitHub Actions

`ufactory init --with-workflows` installs:

- **`.github/workflows/factory.yml`**: triage on `issues: opened|reopened|labeled` (owners,
  members, collaborators only) and hourly; one implementation item hourly; `verify` on
  same-repository `factory/fq-*` PRs; `monitor` weekly; manual `workflow_dispatch`.
- **`.github/workflows/factory-policy.yml`**: `policy-check` on every PR, no LLM, no secrets,
  safe for forks. To let a charter-violating change through (load-bearing, protected, test or
  size rules; **secret files never**), a maintainer who is not the PR author submits an
  **approving review on the current head commit** and adds the label `factory:human-approved`.
  Any new push invalidates the approval.
- **`.github/workflows/factory-scanners.yml`**: optional SonarQube/SonarCloud, Snyk and Wiz jobs
  on every same-repository PR, each off until you set its variable (`UFACTORY_SONAR`,
  `UFACTORY_SNYK`, `UFACTORY_WIZ`) and its secret. The file header lists what each needs.
- A **`records`** job in `factory.yml` that appends every job's run records to the
  `factory-records` branch, so history survives artifact expiry.

Setup:

1. **Variable `UFACTORY_PACKAGE` (required)**: where Actions installs ultimate-factory from,
   pinned, e.g. `ultimate-factory@1.0.1` (the npm release) or `github:tarunpatnala/ultimate-factory#v1.0.1`.
   Workflows refuse to run without it; they never install a floating version.
2. Secrets: `OPENAI_API_KEY` and/or `PORTKEY_API_KEY` (plus any other `*_env` names your config
   uses). Optional `FACTORY_GH_TOKEN`: a GitHub App token or fine-grained PAT (contents, issues,
   pull requests write; no admin/bypass) so factory PRs trigger your other CI. Without it,
   verification runs inline in the implement job, because PRs opened with the default
   `GITHUB_TOKEN` do not trigger workflows.
3. Optional variables `UFACTORY_PROFILE` (`openai` or `portkey`) and `UFACTORY_BOT_LOGIN` (the
   login that posts factory comments when you use an App/PAT; default `github-actions[bot]`).
4. **Protect the default branch with a ruleset**: require a PR, require
   `factory-policy / policy-check`, require a review, and give no bypass to the factory token.
   Branch protection is the real merge boundary; nothing in the factory merges.
5. Allow Actions to create pull requests (Settings → Actions → General).
6. Secret `UFACTORY_HANDOFF_KEY` (recommended): a random string (`openssl rand -hex 32`). Triage
   signs handoffs with it, and implement and verify reject unsigned or altered ones.
7. For unattended runs set `agent.sandbox.mode: docker` and an image with your toolchain plus git
   and bash. Docker is preinstalled on `ubuntu-latest`.
8. Let `github-actions` (or your `FACTORY_GH_TOKEN`) push to the `factory-records` branch.

The workflows never use `pull_request_target`, declare least-privilege permissions per job, and
use concurrency groups so two implement runs never overlap. The Git-ref claim still protects you
if a laptop run and an Actions run race.

## Safety model

The merge boundary is GitHub branch protection plus a token without merge rights. Each control
below is enforced by code, so it holds even when the model ignores its instructions.

| Threat | Control (in code) |
|---|---|
| Agent edits the charter, gates, CI or factory config | Write tools refuse protected and load-bearing globs (case-insensitive, dotfiles included) |
| Agent weakens tests | Existing test files cannot be modified, deleted or renamed; test-runner configs are protected |
| Path traversal / symlink escape | Absolute paths, `..`, `.git` and symlinks resolving outside the repo are refused |
| Scope creep | Diff measured after every write (tracked + untracked); crossing the line or file limit reverts the write and stops |
| Fake green | Gate line must carry the run's nonce and agree with the exit code; the nonce is unset before any test runs; gate script, gate config and proof script run as pristine copies from the base commit |
| Repository code tampering while gates run | Policy re-checked after every gate run, after the proof and on the committed diff before push; `.git/config` must be unchanged; git runs with hooks and fsmonitor disabled; checkout does not persist credentials |
| Gates see files the commit leaves out | Writes to gitignored paths and the run-records directory are refused, so the tree the gates test is the tree that is committed |
| Model weakening its own checks | Gate level can only be raised above the charter default; verifier's `done_when_true:false` or `scope_ok:false` forces rejection; same writer/verifier model forces a human read |
| Test that proves nothing | `prove-test.sh` reverts the fix and requires the new test to fail |
| Secret theft by repository code | Gates, tests and allowlisted commands get an allowlisted environment without LLM keys or `GITHUB_TOKEN`; `search` never follows symlinks. With `agent.sandbox.mode: docker` (or `podman`) they run in a throwaway container: own PID namespace (the factory's environment is not readable through `/proc`), no network, no capabilities, `no-new-privileges`. With `mode: none` (the default, for local use) they run as your OS user and `doctor` warns |
| Secret leakage in logs/records | Redaction of configured key values, auth headers and token patterns |
| Prompt injection via issues, diffs, files or tool output | Issue text, diffs, file contents and test/gate output are wrapped in per-run random delimiters; the model has no shell, git or network tool; code-side overrides apply after every model answer |
| Outsiders burning tokens | Triage only processes `trusted_associations` authors; untrusted issues get no LLM call |
| Forged handoff comment | Implement only trusts handoffs authored by the factory's own identity; with `UFACTORY_HANDOFF_KEY` set, each handoff carries an HMAC bound to its issue number and unsigned or altered handoffs are rejected |
| AI-slop in generated code | `finish` is refused while added lines contain narrating or change-log comments, elided code, placeholders, swallowed errors, emoji or no-ai-slop prose (`agent.slop: block`); anything left is listed in the PR body and forces a human read |
| Concurrent label writes | Triage yields to the states an implement run owns (`in-progress`, `awaiting-review`), before and after its write; `monitor` reports issues left with two state labels |
| Runaway spend | Token, USD, turn, wall-clock, daily-run and daily-USD (`budget.max_usd_per_day`, from run records) budgets; a call whose prompt alone would overrun is refused; old tool output is compacted; back-pressure stops before any LLM call |
| Crashed or cancelled run | SIGTERM/SIGINT releases an unpushed claim, restores the label and writes the record; stale claims shown by `status` and `monitor` |
| Two runs on one issue | First non-forced push of `factory/fq-<n>` wins; losers stop without touching labels |
| Self-approval | `spec` drafts one gate and stops; only `spec approve` advances; refuses in CI. Nothing merges. |

Residual risks you should know: the gates execute your repository's own test code, which the agent
may have just written, so run unattended implementation on runners without production credentials.
Prompt-injection resistance is reduced, not eliminated. Turn on `agent.sandbox` for unattended
runs.

## The 10-persona review panel

`ufactory review` asks ten senior engineering personas, each with a distinct lens and checklist,
and returns one aggregated verdict with a deduplicated must-fix list:

principal-architect · staff-backend · staff-frontend (CLI/UX) · security-engineer ·
sre-reliability · performance-engineer · qa-test-architect · devex-platform · data-engineer ·
ml-ai-engineer (plus optional api-design and accessibility).

Aggregation: any `block` → block; any `request-changes` or blocker/major finding →
request-changes; nits only → approve-with-nits; more than 30% of personas erroring → incomplete.
Each persona can use a different provider/model (`review.persona_models`), so reviewers need not
share the blind spots of the model that wrote the code.

```bash
ufactory review --diff origin/main --out review.md
ufactory review --pr 42 --apply            # posts/updates one panel comment
ufactory review --path docs/design/spec.md # review a document
```

## Required and optional tools, skills and plugins

### Required

| Tool | Why | Install |
|---|---|---|
| Node.js ≥ 20.10 | Runtime | https://nodejs.org |
| git | Diff, claim branch, proof | system package manager |
| bash | `gates.sh`, `prove-test.sh` (Windows: Git Bash or WSL) | built in |
| GitHub CLI `gh`, authenticated | Issues, labels, comments, PRs (`gh auth login`; in Actions `GH_TOKEN`) | https://cli.github.com |
| An LLM endpoint | OpenAI key, Portkey key, Azure OpenAI, or an OpenAI-compatible server with tool calling | see the providers in factory.config.example.yaml |

### Needed for your gates (pick what matches your stack)

| Stack | Gate tools detected by `.factory/scripts/gates.sh` |
|---|---|
| Node/TypeScript | npm/pnpm/yarn/bun scripts `typecheck`, `lint`, `test`, `build`, `mutation` (e.g. tsc, eslint, vitest/jest, Stryker); `npm audit` |
| Python | `ruff`, `mypy`, `pytest`, `pip-audit`, `mutmut` |
| Rust | `cargo check`, `cargo clippy`, `cargo test`, `cargo-audit` |
| Go | `go vet`, `golangci-lint`, `go test`, `govulncheck` |
| C# / .NET (`*.sln`, `*.slnx`, `*.csproj`, `*.fsproj`, `global.json`) | .NET SDK 6+: `dotnet build` (types), `dotnet format --verify-no-changes` (lint, rules from `.editorconfig`), `dotnet test`, `dotnet build -c Release`, `dotnet list package --vulnerable --include-transitive` (audit), Stryker.NET `dotnet stryker` (mutation, optional). Set `agent.test_command: "dotnet test"`. Project, solution, `Directory.Build.*`, `Directory.Packages.props`, `global.json`, `NuGet.config`, `.editorconfig` and `*.runsettings` are protected; `*Tests.cs` files and `*.Tests/` projects count as tests |

### Optional, recommended

| Tool / skill / plugin | Use in the factory | Install |
|---|---|---|
| **Portkey** account or self-hosted gateway | Routing, fallbacks, caching, budgets and traces across providers | https://portkey.ai |
| **OpenSpec** (`@fission-ai/openspec`) | Spec-driven changes; set `spec.format: openspec` so `ufactory spec` writes gates under `openspec/changes/fq-<n>/` | `npm i -g @fission-ai/openspec` then `openspec init` |
| **Elephant-Goldfish Model (EGM)** plugin | Fresh-context design reviews of specs before slices are published (`/egm:egm-review`) | `claude plugin marketplace add google/elephant-goldfish-model && claude plugin install egm@egm` |
| **REA** (`rea-agents`) | Reverse-engineer an existing app or brownfield codebase before writing the charter or a migration spec | `npm i -g rea-agents` then `rea setup` |
| **Claude Code** | Interactive factory work through the installed skills `/factory`, `factory-triage`, `factory-spec`, `factory-implement`, `factory-verify`, `factory-monitor` and subagents `factory-verifier`, `factory-critic` | https://code.claude.com |
| **Codex CLI** | Same workflows via `AGENTS.md` and `.agents/skills/` | https://developers.openai.com/codex |
| **Docker** or **Podman** | `agent.sandbox`: run gates, tests and the proof in a container with your toolchain image (for .NET, `mcr.microsoft.com/dotnet/sdk:8.0` plus git) | https://docs.docker.com/get-docker/ |
| **SonarQube / SonarCloud** | Quality gate on every PR (`factory-scanners.yml`, `UFACTORY_SONAR=true`; .NET uses `dotnet-sonarscanner`) | https://www.sonarsource.com |
| **Snyk** | Dependency (`snyk test --all-projects`) and code (`snyk code test`) scans on every PR (`UFACTORY_SNYK=true`) | https://snyk.io |
| **Wiz CLI** | IaC, secret and vulnerability scan of the repository on every PR (`UFACTORY_WIZ=true`) | your Wiz tenant |
| **`/simplify` and `/code-review`** (Claude Code built-in skills) | Interactive cleanup and bug review of a factory PR before you approve it; the deterministic `ufactory slop` check is what runs unattended | built in |
| **no-ai-slop** skill | The prose rules behind `ufactory slop`; install it to have Claude Code apply them while you write | `claude plugin marketplace add petergyang/no-ai-slop` |

The scanners are not part of the factory runtime: they run as separate PR checks, each with only
its own token, and you make them required in the branch ruleset next to `factory-policy`.
| `jq` | Faster JSON parsing in the merge-guard hook (falls back to sed) | package manager |

Routing Claude Code or Codex themselves through Portkey is described in
[docs/HARNESS-GATEWAYS.md](docs/HARNESS-GATEWAYS.md).

### Installed into your repo by `init`

| Path | Purpose |
|---|---|
| `factory.config.yaml` | Providers, models, budgets, agent sandbox, GitHub settings |
| `docs/factory/CHARTER.md` | Human-owned policy: tier, load-bearing paths, limits, stop conditions |
| `docs/factory/CONTRACT.md` | Harness-neutral queue protocol and rules |
| `.factory/gates.conf`, `.factory/scripts/*.sh` | Gates (nonce-aware), negative-test proof, doctor, label bootstrap |
| `.claude/` + `CLAUDE.md` | Claude Code skills, subagents, `/factory` command, merge-guard hook, permission denies |
| `.agents/`, `.codex/` + `AGENTS.md` | Codex adapters |
| `.github/workflows/factory*.yml` | Unattended stages + policy status check (with `--with-workflows`) |
| `docs/factory/runs/` | One immutable run record per run |

## Cost

Typical tokens per run (your numbers depend on repository size and model):

| Stage | Tokens | LLM calls |
|---|---|---|
| triage (per issue) | 4–8k | 1–2 |
| implement | 80–400k (the 400k budget is the usual ceiling) | 8–25 |
| verify (+critic) | 15–60k | 1–6 (two rounds, one JSON repair each) |
| review panel (10 personas, optional, not in the workflow) | 80–200k | 10–20 |
| monitor | 0–15k | 0–1 |

Defaults: `max_tokens_per_run: 400000`, `max_usd_per_run: 5` (indicative built-in prices,
override in `budget.prices`; cost uses the model that actually served each call), `max_turns: 40`,
`max_minutes_per_run: 50`, `max_runs_per_day: 50`, `max_usd_per_day` unset. Every run record shows
tokens, estimated cost, requested and served models.

These are estimates from the code's limits, not measurements. With current list prices the token
budget usually binds before the $5 cap; lower `max_usd_per_run` once `ufactory metrics` shows your
real cost per attempt. Set `budget.max_usd_per_day` to cap the last 24 hours across runs; in CI
the implement job pulls earlier records from the `factory-records` branch first, so the cap and
`ufactory metrics` see history from previous jobs.

## Using it from VS Code and Claude Code

`init` installs Claude Code skills (`/factory`, `factory-triage`, `factory-spec`,
`factory-implement`, `factory-verify`, `factory-monitor`) and a `.vscode/tasks.json` with one task
per `ufactory` command. Use the Claude Code panel for interactive and spec work, and the tasks or
terminal for `ufactory` runs. Both follow the same charter and claim branches. Walkthrough:
[docs/VSCODE-CLAUDE-CODE.md](docs/VSCODE-CLAUDE-CODE.md).

## How this was built

1. **Reverse engineering with REA**: `rea import-reference-source` and
   `rea inspect-desktop-application` produced an evidence-backed inventory of an existing prompt-only factory design;
   findings and 12 gaps in
   [docs/reverse-engineering/FACTORY-REVERSE-ENGINEERING.md](docs/reverse-engineering/FACTORY-REVERSE-ENGINEERING.md).
2. **Plan with the Elephant-Goldfish Model**: the design
   ([docs/design/design_draft.md](docs/design/design_draft.md)) was reviewed by three
   fresh-context goldfish reviewers (zoom-out, design critic, implementation readiness). Seven
   blockers and all majors were resolved
   ([docs/design/egm-review-report.md](docs/design/egm-review-report.md)).
3. **Execution with OpenSpec**: change `build-ultimate-factory` with 10 capability specs,
   design and phased tasks in [openspec/changes/](openspec/changes/).
4. **10-persona engineering review** of the implementation and fixes:
   [docs/reviews/ENGINEERING-REVIEW.md](docs/reviews/ENGINEERING-REVIEW.md).
5. **Review by 10 PhD scientists** (formal methods, distributed systems, security, ML, empirical
   software engineering, HCI, operations research, statistics, NLP, reliability), with fixes and
   the list of what is still open: [docs/reviews/SCIENTIST-REVIEW.md](docs/reviews/SCIENTIST-REVIEW.md).
6. **AI-slop check** with the rules of [no-ai-slop](https://github.com/petergyang/no-ai-slop)
   for prose, plus rules for generated code (`src/policy/slop.ts`). `npm run lint` applies it to
   this repository's docs and code comments, and `implement` applies it to every diff it writes.

## Development

```bash
npm install
npm run lint && npm run typecheck
npm test              # unit + e2e (mock OpenAI server, fake gh, real git repos)
npm run test:shell    # ported template-script tests (gates, proof, claim, hook, doctor)
```

Layout: `src/config` (config), `src/llm` (providers, client, budgets), `src/policy` (charter,
paths, diff, engine), `src/agent` (sandboxed workspace, tools, loop), `src/gates`,
`src/github` (gh, handoff, queue), `src/stages` (commands), `src/personas`, `src/runs`,
`template/` (installed files), `test/`.

## Limits

- Chat Completions API only (the format every gateway and local server accepts). Models without
  tool calling can triage, verify and review but cannot implement.
- The implement agent has no shell; give it named commands through `agent.allowed_commands`.
- Daily caps count the records the implement job can see: local records, plus the last two days
  pulled from `factory-records` in CI. A run whose `records` job failed is not counted.
- Without `agent.sandbox`, gates run your repository's code as your OS user with network access.
- The slop check is pattern-based. It finds the common tells, not every redundant comment; the
  human read and `/simplify` cover the rest.
- Not yet published to npm: install from source, or set `UFACTORY_PACKAGE` to a git URL + tag.
- When a provider omits `usage`, tokens are estimated (characters ÷ 4) and flagged.
- Spec gates are interactive by design; the factory never approves its own spec.

## License

MIT. See [LICENSE](LICENSE).
