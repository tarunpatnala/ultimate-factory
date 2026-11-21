# Spec Delta

## Purpose
Turn the human-owned charter into rules enforced in code on the real diff, for every harness.

## ADDED Requirements

### Requirement: Charter parsing fails closed
The system SHALL read only fenced blocks in `docs/factory/CHARTER.md` containing `CHARTER_STATUS`, `TIER`, `LOAD_BEARING`, `TESTS_ARE_LOAD_BEARING`, `GATES`, `STOP_IF` and `AUTOMATABLE`/`NEEDS_SPEC`/`NEVER_AUTOMATE`. Every writing stage MUST stop when the file is missing, a required key is missing, `TIER` is not one of `revival|greenfield|oss|client-production`, or `CHARTER_STATUS` is not `ready`.

#### Scenario: Incomplete charter
- **WHEN** `CHARTER_STATUS: incomplete`
- **THEN** triage, implement and monitor exit with code 4, and policy-check prints `status=MISCONFIGURED reason=charter-not-ready` and exits 2

### Requirement: Limits from STOP_IF
The system SHALL take limits from an explicit `LIMITS` block (`max_changed_lines`, `max_changed_files`, `max_awaiting_review`) when present; otherwise it SHALL extract them from `STOP_IF` (`exceed <N> changed lines`, `More than <N> items are already awaiting human review`) and `NEEDS_SPEC` (`more than <N> files`), defaulting to 400, 3 and 5 only when no entry mentions the limit. Prose that mentions a limit but cannot be parsed MUST make the charter invalid.

#### Scenario: Custom limit
- **WHEN** STOP_IF contains `The change would exceed 250 changed lines`
- **THEN** the line limit is 250

### Requirement: Tier effects
The system SHALL apply tier effects: `client-production` forces every PR to draft and minimum gate level `full`; `oss` forces draft when any non-doc file changes; `greenfield` and `revival` follow the charter defaults.

#### Scenario: Client production
- **WHEN** TIER is client-production and gates are green with an accepted verifier
- **THEN** the PR is still opened as draft

### Requirement: Path classification
The system SHALL classify paths with glob matching (`**` across directories, dotfiles included, case-insensitive) into: `protected` (charter, contract, gates config and scripts, `.claude/**`, `.agents/**`, `.codex/**`, `.factory/**`, `.github/**`, `AGENTS.md`, `CLAUDE.md`, `factory.config.*`, build manifests, lockfiles and test-runner configs, plus `agent.protected_extra`), `load_bearing` (charter `LOAD_BEARING`), `test` (test path globs) and `secret` (`.env*`, `*.pem`, `*.key`, `id_rsa*`, `.npmrc`, `.pypirc`, `credentials*`).

#### Scenario: Dotfile glob
- **WHEN** LOAD_BEARING contains `.github/workflows/**`
- **THEN** `.github/workflows/ci.yml` is load-bearing

### Requirement: Diff evaluation
The system SHALL evaluate the real diff between the base ref and the working tree, including untracked files, and report violations: `protected-path`, `load-bearing-path`, `test-modified` (an existing test file modified, deleted or renamed when `TESTS_ARE_LOAD_BEARING: true`), `too-many-lines` (added + deleted lines of text files; binary files count as 1 line each), `too-many-files`, `secret-file`.

#### Scenario: Test deleted
- **WHEN** the diff deletes `tests/test_auth.py`
- **THEN** the violation `test-modified` is reported

### Requirement: Harness-neutral policy check
`ufactory policy-check --base <ref>` SHALL print one line `FACTORY_POLICY: v=1 status=PASS|FAIL|MISCONFIGURED violations=<list|none> lines=<n> files=<n>` and exit 0, 1 or 2, needing no model configuration. `--human-approved-by <login>` (a validated GitHub login whose approving review of the head commit was verified by the workflow) SHALL override every violation except `secret-file`, and the approver is recorded in the output. A missing merge base MUST be MISCONFIGURED.

#### Scenario: PR from another harness
- **WHEN** a Codex-authored PR edits `src/auth/login.ts` listed as load-bearing
- **THEN** policy-check exits 1 with `violations=load-bearing-path`

### Requirement: Review-queue back-pressure
Before claiming work the system SHALL count open issues labeled `factory:awaiting-review` plus open pull requests whose head is `<branch_prefix>fq-<n>`, deduplicated by issue number, and MUST refuse to claim when the count is at or above the limit.

#### Scenario: Queue full
- **WHEN** 3 issues are awaiting review and the limit is 3
- **THEN** implement exits 0 with status `stopped`, reason `review-queue-full`, and claims nothing
