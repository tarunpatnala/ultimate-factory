# Proposal

## Why

The reverse-engineered original factory design (`docs/reverse-engineering/FACTORY-REVERSE-ENGINEERING.md`)
is a strong policy pack with no runtime. It only runs inside Claude Code routines or Codex, the
model and endpoint cannot be configured, and the charter rules that matter most (load-bearing
paths, diff limit, review-queue back-pressure, test tampering) are prompts that a model can
misjudge. Owners who pay for OpenAI directly or route through a Portkey gateway cannot run it
unattended. The EGM-reviewed design (`docs/design/design_draft.md`) fixes this.

## What Changes

- Add `ufactory`, a Node.js CLI that runs the factory stages (triage, spec, implement, verify,
  review, monitor, status) against any OpenAI-compatible endpoint.
- Add `factory.config.yaml` selecting provider (OpenAI, Portkey, Azure OpenAI, any
  OpenAI-compatible server) and model per stage, with profiles and secret-safe validation.
- Move charter enforcement into code: a policy engine and a harness-neutral
  `ufactory policy-check` status check.
- Add a sandboxed implement agent with path-checked tools and scrubbed-environment gate runs.
- Add a configurable 10-persona engineering review panel that aggregates into one verdict.
- Harden gate verdicts with a nonce and exit-code agreement.
- Ship an installable template (charter, contract, gates, Claude Code and Codex adapters,
  GitHub Actions workflows) via `ufactory init`.

## Capabilities

### New Capabilities
- `model-config`: loading, validating and resolving `factory.config.yaml` providers, models, roles and profiles.
- `llm-providers`: calling OpenAI, Portkey, Azure OpenAI and OpenAI-compatible endpoints with retries, budgets and usage accounting.
- `charter-policy`: parsing the charter and enforcing its rules on real diffs, including the `policy-check` command.
- `agent-sandbox`: the implement agent's tools, path guard, command allowlist and stop conditions.
- `gate-verdicts`: running gates and negative-test proof and accepting only authentic verdicts.
- `github-queue`: labels, handoff comments, deterministic claims, trusted-author filtering and idempotent writes.
- `factory-stages`: the observable contract of each CLI stage, dry-run versus apply, and exit codes.
- `review-panel`: multi-persona engineering review with per-persona models and an aggregated verdict.
- `run-records`: immutable, redacted, schema-valid run records.
- `factory-install`: installing the template into a target repository without overwriting.

### Modified Capabilities

None (new project).

## Impact

New repository content: `src/`, `bin/`, `template/`, `test/`, `factory.config.example.yaml`,
`.github/workflows/`, `README.md`. Runtime dependencies: `yaml`, `picomatch`. External tools
used at runtime: `git`, `gh`, `bash`.
