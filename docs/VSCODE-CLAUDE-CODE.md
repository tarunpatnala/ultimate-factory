# Using the factory in VS Code with Claude Code

There are two ways to drive the factory from VS Code. They share the same charter, contract,
gates, labels and claim branches, so you can mix them on the same repository.

| | Claude Code panel (interactive) | `ufactory` in the terminal or Tasks |
|---|---|---|
| Who runs the loop | Claude Code, with the installed skills | `ufactory`, with its own tool loop |
| Model | whatever Claude Code is set to (or a gateway, see HARNESS-GATEWAYS.md) | `factory.config.yaml` per stage: OpenAI, Portkey, Azure, local |
| Charter rules | prompts + hook + `policy-check` on the PR | enforced in code at every step + `policy-check` |
| Best for | spec work, exploring, one-off fixes you watch | repeatable runs, review panel, CI parity |

## 1. Install once

```bash
npm install --global /path/to/ultimate-factory   # or a published version later
cd /path/to/your/repo
ufactory init . --with-workflows
```

`init` adds `.claude/` (skills, subagents, `/factory` command, merge-guard hook), `CLAUDE.md`,
`docs/factory/`, `.factory/`, `factory.config.yaml` and `.vscode/tasks.json`. It never
overwrites a file that already exists.

Install the Claude Code extension for VS Code (Extensions view, search "Claude Code"), open the
repository folder, and open the Claude Code panel.

## 2. Interactive work in the Claude Code panel

Claude Code reads `CLAUDE.md` and discovers the skills in `.claude/skills/` automatically.

| Type in the panel | What happens |
|---|---|
| `/factory` | Control room: review queue, labels, recent runs |
| "triage the open issues" | `factory-triage` skill classifies issues and writes handoffs |
| "spec issue 42" | `factory-spec` skill walks the four human approval gates with you |
| "implement issue 42" | `factory-implement` skill claims `factory/fq-42`, writes test + fix, runs gates, calls the `factory-verifier` subagent, opens a draft PR |
| "verify PR 57" | `factory-verify` skill re-runs gates and the proof, posts a verdict |

The `.claude/settings.json` permissions deny edits to the charter and gate files, and the hook
blocks merge commands. Before you push, run the same check CI runs:

```bash
ufactory policy-check --base origin/main
```

## 3. Running `ufactory` from VS Code

Open the integrated terminal (`` Ctrl+` ``) and run any command, or use **Terminal → Run Task**
and pick one of the installed tasks:

| Task | Command |
|---|---|
| factory: doctor (ping models) | `ufactory doctor --ping` |
| factory: models | `ufactory models` |
| factory: status | `ufactory status` |
| factory: gates full | `ufactory gates full` |
| factory: policy-check vs main | `ufactory policy-check --base origin/main` |
| factory: triage (dry run) | `ufactory triage` |
| factory: implement locally | prompts for task, done condition and files, then `ufactory implement --local ...` |
| factory: 10-persona review of my changes | `ufactory review --diff origin/main --out review.md` |

Set API keys in the shell VS Code starts from (for example in `~/.zshrc`:
`export OPENAI_API_KEY=...` or `export PORTKEY_API_KEY=...`), then restart VS Code so the
terminal and tasks inherit them. Do not put keys in `.vscode/settings.json` or in the config file.

## 4. A typical day

1. Open the repo; run the **status** task to see the review queue.
2. In the Claude Code panel, talk through a fuzzy feature with `factory-spec`; approve each gate.
3. Let the scheduled GitHub Actions run (or run **implement locally**) pick up ready items.
4. Before merging anything, run **10-persona review of my changes** and read `review.md`.
5. Merge in GitHub. The required `factory-policy / policy-check` status must be green.
