# Spec Delta

## Purpose
Use GitHub issues, labels and Git refs as the durable, concurrency-safe work queue.

## ADDED Requirements

### Requirement: Labels
The system SHALL use state labels `factory:ready-to-implement`, `factory:ready-to-spec`, `factory:needs-info`, `factory:wait-to-implement`, `factory:in-progress`, `factory:awaiting-review`, provenance label `factory:monitor` and PR labels `factory:verified`, `factory:rejected`. An issue MUST carry at most one state label after any factory write.

#### Scenario: Relabel preserves provenance
- **WHEN** triage moves an issue with `factory:monitor` and `factory:needs-info` to ready-to-implement
- **THEN** it ends with `factory:monitor` and `factory:ready-to-implement` only

### Requirement: Handoff comment codec
The handoff SHALL be one comment starting `<!-- factory-handoff:v1 -->` followed by `key: value` lines with keys `disposition`, `done_when`, `files_expected`, `load_bearing`, `gate_level`, `confidence`, `triaged_at`, `question`, `blocker`. Unknown keys are ignored; a handoff missing `done_when`, `files_expected` or `gate_level` for `ready-to-implement`, or with an invalid `gate_level`, MUST be treated as malformed. Re-triage MUST edit the existing handoff comment written by the factory instead of adding another.

#### Scenario: Malformed handoff
- **WHEN** a ready issue's handoff lacks `done_when`
- **THEN** implement moves it to `factory:needs-info` with a reason comment and does not claim it

### Requirement: Deterministic claim
Implement SHALL claim issue N by creating branch `<branch_prefix>fq-N` from the default branch, adding an empty commit `factory: claim FQ-N (<run_id>) at <UTC>` and pushing without force to `refs/heads/<branch_prefix>fq-N`. A rejected push MUST end the run with status `stopped`, reason `already-claimed`, with no label change.

#### Scenario: Race
- **WHEN** two runs push the claim for the same issue
- **THEN** exactly one proceeds and the other stops with `already-claimed`

### Requirement: Claim release
When a run stops after claiming and before pushing any non-claim commit, it SHALL delete the remote claim branch it created (only if its tip is the run's claim commit), restore the issue state label appropriate to the reason, and post one reason comment.

#### Scenario: Budget stop
- **WHEN** implement stops on budget before pushing code
- **THEN** the claim branch is deleted, the issue is `factory:needs-info`, and a comment names the reason

### Requirement: Trusted authors
Triage SHALL only process issues whose `author_association` is in `github.trusted_associations` (default `OWNER`, `MEMBER`, `COLLABORATOR`); others are skipped and counted in the run record.

#### Scenario: Outsider issue
- **WHEN** a `NONE` association user opens an issue
- **THEN** triage makes no LLM call for it and records it as skipped-untrusted

### Requirement: Dry run by default
Every stage that writes to GitHub SHALL print the planned writes and make none unless `--apply` is passed.

#### Scenario: Default triage
- **WHEN** `ufactory triage` runs without `--apply`
- **THEN** no labels, comments, branches or PRs are created

### Requirement: Signed handoffs
When the env var named by `github.handoff_key_env` is set, triage and spec publish SHALL append the issue number and an HMAC-SHA256 of the handoff fields; implement and verify MUST reject handoffs that are unsigned, altered, or signed for another issue.

#### Scenario: Altered handoff
- **WHEN** a signed handoff's `files_expected` is edited
- **THEN** implement stops with `malformed-handoff` and "signature does not match"

### Requirement: Label ownership
Triage SHALL NOT replace `factory:in-progress` or `factory:awaiting-review`: it skips the write when one is present and removes its own label when one appears during its write. The claim holder SHALL read labels back after writing and remove any other state label. `monitor` SHALL report issues with more than one state label.

#### Scenario: Claim lands during triage
- **WHEN** an implement run adds `factory:in-progress` between triage's read and write
- **THEN** the issue ends with only `factory:in-progress`
