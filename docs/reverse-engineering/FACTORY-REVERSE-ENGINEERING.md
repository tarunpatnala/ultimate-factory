# Reverse engineering: the original factory design

Target: an open-source, prompt-only software factory (Markdown skills plus Bash scripts for Claude Code and Codex), analysed at a fixed commit.
Tooling: REA 6.10.1 (`rea import-reference-source`, `rea inspect-desktop-application`) plus a
manual trace of every script and skill. REA produced:

| Output | Result |
|---|---|
| Historical-source manifest | 89 entries, 57 files, 32 directories, graph SHA `75c5f1b8…`, languages INI/JSON/Markdown/Shell/YAML, 0 parse failures |
| Directory/header inventory | Evidence id `ev_7651707…` |

The raw REA output is not kept in this repository; rerun the two commands above to reproduce it.

## 1. What REA establishes (evidence, not opinion)

- **No executable runtime.** REA found zero language manifests (`manifests: []`) and zero code
  relationships. The only executable code is Bash: `install.sh`, `.claude/scripts/gates.sh`,
  `.claude/hooks/block-merge.sh`, `.factory/scripts/{doctor,prove-test,bootstrap-github}.sh`
  and seven smoke tests. Everything else is Markdown prompts and JSON/YAML config.
- **The "factory" is a policy pack.** 185 KB of content, of which about 75% is Markdown
  (procedures for an LLM agent to follow). The behaviour lives in Claude Code / Codex,
  not in this repository.
- **The model is hard-wired to the harness.** There is no model, endpoint, or provider
  setting anywhere in the inventory. Model choice is whatever Claude Code or Codex is using.

## 2. Reconstructed architecture

```
human ──writes──> CHARTER.md (tier, load-bearing globs, automatable, STOP_IF)
                     │ read first by every stage
GitHub issue ──(hourly poll routine)──> triage skill ──labels + factory-handoff:v1 comment
                                                   │
         factory:ready-to-spec <───────────────────┤
         (spec skill, 4 human gates)               │
                                                   ▼
                              factory:ready-to-implement
                                                   │ implement routine
                     claim: push claude/fq-<n> (first non-forced push wins)
                                                   │
                     agent edits → gates.sh <level> → FACTORY_GATES line
                                                   │
                     factory-verifier subagent (cold diff, prove-test.sh)
                                                   │
                     draft PR → factory:awaiting-review → (PR routine) verify skill
                                                   │
                     /factory control room → HUMAN MERGE (never automated)
                                                   │
                     weekly monitor skill → files factory:monitor issues → loop
```

## 3. Component contracts recovered

| Component | Input | Output | Enforcement type |
|---|---|---|---|
| `gates.sh` | level `fast/full/deep`, `.factory/gates.conf` | exit 0/1/2 + `FACTORY_GATES:` line | Deterministic (code) |
| `prove-test.sh` | base ref, test paths, test command | `PROOF: status=PROVEN/FAILED/MISCONFIGURED` | Deterministic (code) |
| Claim | `git push origin HEAD:refs/heads/claude/fq-<n>` | success = owner | Deterministic (Git ref CAS) |
| `block-merge.sh` | PreToolUse JSON | exit 2 blocks merge/force-push/protected writes | Deterministic but bypassable |
| Triage | issues, charter | 1 label + handoff comment + QUEUE.md | **LLM judgement only** |
| Load-bearing check | `LOAD_BEARING` globs | route to spec | **LLM judgement only** |
| Diff limit 400 lines, queue limit 3 | charter `STOP_IF` | stop | **LLM judgement only** |
| Test-file tamper rule | charter | stop / draft | **LLM judgement only** |
| Verifier / critic | diff, base SHA | verdict YAML | LLM, separate context, **same model family** |
| Run records | stage outcome | `docs/factory/runs/*.md` | **LLM writes free text** |

## 4. Findings: strengths to keep

1. Charter-first, default-deny policy. Silence means stop.
2. The gate verdict is a fixed machine-readable line; `MISCONFIGURED` is never green.
3. Deterministic claim via a Git ref instead of a label.
4. Writer never grades its own work; negative-test proof.
5. Hard back-pressure on the human review queue.
6. Merge is never automated.
7. One immutable run record per run.

## 5. Findings: gaps the ultimate factory must close

| # | Gap | Evidence | Consequence |
|---|---|---|---|
| G1 | Model and endpoint are not configurable | No provider config in inventory | Cannot run on OpenAI keys, Portkey, Azure, or local models |
| G2 | Requires Claude Code cloud routines | ROUTINES.md, LIMITS.md §1–§6 | Vendor lock-in; account UI state cannot be committed |
| G3 | No `issues` trigger | LIMITS.md §1 | Up to 1 h triage latency |
| G4 | Charter rules (load-bearing globs, 400-line limit, queue limit, test-tamper) are enforced only by prompts | Section 3 table | A confident model can misjudge them |
| G5 | Verifier uses the same model family as the writer | agents/*.md | Correlated blind spots; the repo's own data says diversity is what finds bugs |
| G6 | No cost / token / turn budget | no budget anywhere | Runaway spend on unattended runs |
| G7 | Hook-based guard is bypassable (`git  merge`, `bash -c`, API tools) | block-merge.sh pattern matching | Guardrail, not a boundary |
| G8 | Issue text reaches the agent as prose | triage skill says "treat as untrusted" | Prompt injection relies on model obedience |
| G9 | Run records are free text written by the LLM | runs/README.md | Metrics can be fabricated or malformed |
| G10 | Single critic lens | factory-critic.md | One perspective on load-bearing changes |
| G11 | No observability of LLM calls | n/a | No trace of cost, latency, retries per run |
| G12 | Spec output is ad-hoc files | factory-spec skill | Not compatible with spec tooling such as OpenSpec |

## 6. Conclusion

The original design is a strong **policy** with a weak **runtime**: everything that matters most is
asked of the model rather than enforced. The ultimate factory keeps the policy files and the
deterministic scripts, and adds a small provider-neutral runtime that moves the
LLM-judgement-only rows in section 3 into code, makes model and endpoint a config file, and
runs anywhere (local CLI, GitHub Actions with a real `issues: opened` trigger, cron).
