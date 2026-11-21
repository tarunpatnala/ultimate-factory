# How Ultimate Factory works at run time

This page follows one command from start to exit: which code runs, what each model sees, where
the checks sit, and what is written to disk and to GitHub. File references point at `src/`.

## Components

```mermaid
flowchart TB
  subgraph CLI["ufactory (one process per command)"]
    C[cli.ts<br/>parse args, freeze git config] --> X[context.ts<br/>config, run id, budget, redactor]
    X --> S{stage}
    S --> T[triage.ts]
    S --> I[implement.ts]
    S --> V[verify.ts]
    S --> R[review.ts]
    S --> P[policy-check.ts]
    S --> M[ops.ts: monitor, status, doctor]
  end
  X --> L[llm/client.ts<br/>FallbackLlm -> LlmClient per model]
  L -->|Chat Completions| API[(OpenAI / Portkey / Azure / local)]
  I --> A[agent/loop.ts<br/>tool loop]
  A --> W[agent/workspace.ts<br/>path guard]
  I --> PE[policy/engine.ts<br/>charter rules on the real diff]
  I --> G[gates/gates.ts<br/>pristine gates.sh + nonce]
  T & I & V --> GH[github/gh.ts -> gh CLI]
  I & V --> GIT[util/git.ts<br/>hooks off, frozen config]
  X --> REC[runs/record.ts<br/>docs/factory/runs/*.md]
```

Each command is a short-lived process. There is no daemon and no database. State lives in
GitHub labels and comments, in Git branches, and in the run record each command writes.

## The issue lifecycle (labels)

```mermaid
stateDiagram-v2
  [*] --> untriaged
  untriaged --> ready_to_implement: triage (charter allows, files allowed, estimate fits)
  untriaged --> ready_to_spec: triage (needs decisions or touches protected/load-bearing paths)
  untriaged --> needs_info: triage (question for a human)
  untriaged --> wait_to_implement: triage (blocked)
  ready_to_spec --> ready_to_implement: spec gates 1-4 approved by a human, slices published
  ready_to_implement --> needs_info: handoff missing or malformed (before any claim)
  ready_to_implement --> ready_to_spec: expected files are protected or load-bearing (before any claim)
  ready_to_implement --> in_progress: implement wins the claim branch push and the base is green
  in_progress --> awaiting_review: PR opened
  in_progress --> needs_info: stopped (budget, gave up, verifier rejected, proof failed, 3rd failure in a row, ...)
  in_progress --> ready_to_spec: stopped (scope or tamper check hit protected or load-bearing paths)
  in_progress --> ready_to_implement: stopped by an infrastructure or internal error, nothing pushed
  needs_info --> untriaged: a human answers and removes the label
  wait_to_implement --> untriaged: a human removes the label when the blocker is gone
  awaiting_review --> [*]: human merges or closes
```

## `ufactory implement --apply`, step by step

```mermaid
sequenceDiagram
  autonumber
  participant U as ufactory
  participant GH as GitHub (gh)
  participant G as git
  participant M as implement model
  participant Gt as gates.sh (pristine copy)
  participant Vf as verify model
  U->>U: load config, freeze git config, check charter is ready
  U->>GH: list issues + open PRs (review queue size)
  alt queue at limit
    U-->>U: stop (exit 0), no model call
  end
  U->>GH: read handoff comment written by the factory's own login
  U->>G: fetch default branch, push empty claim commit to factory/fq-N (no force)
  alt push rejected
    U-->>U: another run owns it, try the next ready issue
  end
  U->>Gt: fast gates on the base commit (circuit breaker)
  alt base not green
    U-->>U: release claim, stop baseline-red (exit 0), no model call
  end
  U->>GH: label in-progress
  loop agent turns (max_turns, token, USD and wall-clock budgets)
    U->>M: system rules + handoff + compacted history + tools
    M-->>U: tool calls
    U->>U: path guard, write, re-measure diff, refuse or revert violations
  end
  M-->>U: finish(summary, test_paths)
  U->>Gt: run gates (nonce, scrubbed env)
  U->>U: re-check policy and .git state after repository code ran
  U->>G: commit
  U->>Gt: negative-test proof: revert the fix, the new test must fail
  U->>Vf: done_when + diff + gate/proof/policy lines (never the agent's summary)
  Vf-->>U: verdict JSON (code overrides: RED, FAILED proof, false or missing flags force reject)
  opt load-bearing change or client-production tier
    U->>Vf: critic model argues against the change (advisory: concerns or oppose make the PR a draft)
  end
  U->>U: HEAD unchanged, tree clean, committed diff passes policy
  U->>G: push the checked commit SHA
  U->>GH: open PR (draft when a human read is required), label awaiting-review
  U->>U: write run record
```

Every early exit takes the `catch` path in `implement.ts`. It releases an unpushed claim, moves
the issue to the right label, comments the reason, and writes the run record. SIGTERM and SIGINT
take the same path.

## What each model call contains

| Stage | System prompt | User content | Output | Size limit |
|---|---|---|---|---|
| triage | charter lists (automatable, needs-spec, never, load-bearing, limits) | issue + trusted comments, fenced | JSON disposition | 30k chars of issue text |
| implement | rules, tier, limits, contract (12k chars) | handoff + issue, fenced; then tool results | tool calls | 24k chars per tool result; results older than 6 turns become stubs |
| verify | verifier rules | done_when, files_expected, gate/proof/policy lines, fenced diff | JSON verdict | 120k chars of diff |
| critic | critic rules | same evidence as verify | JSON position | same |
| review (x10) | one persona's mandate and checklist | fenced diff, PR or files | JSON findings | 60k chars per persona |
| spec | one gate's instructions | issue + approved earlier gates | Markdown | none |

The implement agent does not receive the repository up front. It asks for files with `list_files`,
`search` and `read_file` (`agent.max_file_bytes`, default 20,000 characters per read, paged by
line), so context grows only with what it reads. File contents, test and gate output reach the model
inside the run's fence. Tool results larger than 400 characters and older than 6 turns are replaced
by stubs; the agent's own earlier messages are kept. The system prompt and first user message stay
identical across turns, so providers that cache prompt prefixes (OpenAI does this automatically
above 1,024 tokens) can bill that part at the cached rate; the run record reports list-price cost
and does not subtract cache discounts.

## Where the safety checks sit

| Moment | Check | Code |
|---|---|---|
| Before any model call | charter ready, review queue below limit, clean tree, daily cap | `implement.ts` |
| Before the claim | expected files are not protected or load-bearing | `checkScope` |
| Every write | path guard, existing tests untouchable, diff line/file limits | `workspace.ts`, handler |
| After any repository code runs | policy on the working tree, `.git` config/info/replace digest | `tamperCheck` |
| At finish | gates GREEN (one retry), nonce + exit code agree | `gates.ts` |
| After commit | proof PROVEN, tree still clean | `runProof` |
| Before push | HEAD is the checked commit, committed diff passes policy | publish block |
| On every PR | `policy-check` required status, no secrets | `factory-policy.yml` |

## Model selection at run time

`ctx.llm(role)` resolves the role's model from `factory.config.yaml` (default, profile, role,
persona) and builds one `FallbackLlm` per role and persona for the whole command: the primary model
followed by its `fallbacks`. Each model retries its own transient errors (429, 5xx, timeouts) with
backoff. If it still fails, the next model in the chain takes over and stays in use for that role
until the command ends. The run record lists every requested model and the model each provider
reported it served. Writer and verifier count as independent only if their chains share no model
and the providers served different models.
