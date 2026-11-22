# Spec Delta

## Purpose
Let the factory improve from its own runs while every change to its behaviour stays a human decision.

## ADDED Requirements

### Requirement: Learning signals in run records
Implement and verify SHALL record what went wrong during a run in the `learn_signals` front-matter list, using the prefixes `verifier:` (each `must_fix` of a rejection), `gate:` (each gate failing at finish), `slop:` (each AI-slop rule that refused finish) and `refusal:` (each policy refusal), one line each, without duplicates, at most 40 per run.

#### Scenario: Protected write attempt
- **WHEN** the agent tries to write a protected path and is refused
- **THEN** the run record lists `refusal:protected path`

### Requirement: PR outcome records
`ufactory tune` SHALL write one immutable record with `stage: outcome` per factory PR once its outcome is final, and MUST NOT write one for an open PR or one still inside `learning.outcome_window_days` after merge.

#### Scenario: Revert
- **WHEN** a factory PR's merge commit is reverted on the default branch
- **THEN** tune writes an outcome record with `outcome: reverted`, and a second tune run writes no further record for that PR

### Requirement: Outcome classification
The outcome SHALL be `closed-unmerged`, `escaped` (labelled `factory:escaped`), `reverted`, `fixed-after-merge` (a later commit whose subject says fix, bug, hotfix or regression changes a file of the merge within the window) or `merged-clean`.

#### Scenario: Fix to another file
- **WHEN** the only later fix commit changes a file the PR did not touch
- **THEN** the outcome is `merged-clean` once the window has passed

### Requirement: Deterministic proposals
`tune` SHALL derive proposals from records without a model call, give each a stable id, and MUST only quote record text as evidence.

#### Scenario: Below threshold
- **WHEN** an objection appears in fewer runs than `learning.min_occurrences`
- **THEN** no proposal is made for it

### Requirement: Proposal kinds
Proposals SHALL be `tighten` for every bad outcome (ranked first), `lesson` for a verifier objection, AI-slop rule or failed proof recurring in `learning.min_occurrences` runs, `lesson-not-working` or `gate` for an active lesson that keeps recurring or being cited, `check` for a recurring failed gate, `charter` for a recurring scope refusal, and `loosen-candidate` only after 10 `merged-clean` outcomes with no bad outcome.

#### Scenario: Revert blocks loosening
- **WHEN** the window holds 12 clean merges and one revert
- **THEN** there is a `tighten` proposal and no `loosen-candidate`

### Requirement: Proposals never apply themselves
With `--apply`, tune SHALL create or update one open issue marked `<!-- factory-tune:v1 -->` and labelled `factory:tune`. With `--open-pr` it SHALL push a new branch, built with git plumbing from the default branch tip, adding the proposed lessons to the Active section of the lessons file, and open it as a draft PR. Tune MUST NOT modify the charter, gates, lessons file or checkout in place.

#### Scenario: Draft PR
- **WHEN** `tune --apply --open-pr` runs with a lesson proposal
- **THEN** a `factory/tune-<date>` branch holds the lesson, the default branch's lessons file is unchanged, and HEAD and the working tree are untouched

### Requirement: Lessons reach the models, not the rules
Implement and the verifier SHALL include only the `## Active` section of `learning.lessons` (HTML comments removed, capped at `learning.max_lesson_chars`) in their system prompts, stating that a lesson never relaxes a rule; the verifier SHALL be asked to cite a broken lesson's id in `must_fix`. The lessons file MUST be a protected path.

#### Scenario: Model edits the lessons file
- **WHEN** the agent writes `docs/factory/LESSONS.md`
- **THEN** the write is refused, the file is unchanged, and lessons outside Active never appear in a prompt
