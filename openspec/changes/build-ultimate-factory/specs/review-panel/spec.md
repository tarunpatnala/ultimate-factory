# Spec Delta

## Purpose
Review a change through many senior engineering perspectives and return one decision a human can act on quickly.

## ADDED Requirements

### Requirement: Built-in personas
The system SHALL ship at least 10 engineering personas: principal-architect, staff-backend, staff-frontend, security-engineer, sre-reliability, performance-engineer, qa-test-architect, devex-platform, data-engineer, ml-ai-engineer, plus optional api-design and accessibility. `review.personas` selects which run; fewer than `review.min_personas` (default 10) MUST be a config error.

#### Scenario: Default panel
- **WHEN** `ufactory review --diff main` runs with default config
- **THEN** 10 persona reviews are requested

### Requirement: Persona models
Each persona SHALL use role `review` unless `review.persona_models.<id>` overrides provider or model, allowing reviews to be spread across providers.

#### Scenario: Mixed providers
- **WHEN** security-engineer is mapped to a Portkey model
- **THEN** only that persona's call goes through Portkey

### Requirement: Structured persona output
Each persona SHALL return JSON `{verdict: approve|approve-with-nits|request-changes|block, score: 1-10, findings: [{severity: blocker|major|minor|nit, file?, line?, title, detail, fix}]}`; invalid output is retried once and then recorded as `error` for that persona.

#### Scenario: One persona fails
- **WHEN** one persona's provider returns 500 after retries
- **THEN** the panel completes with that persona marked `error` and the aggregate notes the gap

### Requirement: Aggregation
The aggregate verdict SHALL be `block` if any persona blocks; else `request-changes` if any persona requests changes or any blocker/major finding exists; else `approve-with-nits` if any nits/minors; else `approve`. If more than 30% of personas errored, the aggregate MUST be `incomplete`. Output: a verdict table, a deduplicated must-fix list (blocker and major), and nits collapsed. Exit code 1 for `block`, `request-changes` or `incomplete`.

#### Scenario: Majority approve with one block
- **WHEN** 9 personas approve and security blocks
- **THEN** the aggregate is block

### Requirement: Review targets
`review` SHALL accept `--diff <base>`, `--pr <n>` (posts one marker comment with `--apply`) or `--path <file-or-dir>` (whole-file review), and `--out <file>` to write the Markdown report.

#### Scenario: Review a document
- **WHEN** `--path docs/design/design_draft.md` is given
- **THEN** the file content is reviewed and the report written

### Requirement: Block quorum
The panel aggregate SHALL be `block` only when at least `review.block_quorum` (default 2, capped at the number of personas that answered) personas block; fewer blocks MUST yield `request-changes`, never an approval.

#### Scenario: Lone block among ten
- **WHEN** nine personas approve and one blocks with quorum 2
- **THEN** the aggregate is `request-changes`
