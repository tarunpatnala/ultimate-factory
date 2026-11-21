# Spec Delta

## Purpose
Leave immutable, machine-readable evidence of every run without leaking secrets.

## ADDED Requirements

### Requirement: One file per run
Every stage run SHALL write `<runs_dir>/<run_id>.md` where `run_id` is `YYYY-MM-DDTHHMMSSZ-<stage>-<issue|pr|none>-<4 hex>`, never overwriting an existing file, including when the run fails.

#### Scenario: Crash mid-run
- **WHEN** a provider error ends implement
- **THEN** a record exists with `status: infrastructure-failed`

### Requirement: Front matter written by code
The front matter SHALL contain `run_id, stage, started_at, finished_at, status (succeeded|stopped|rejected|infrastructure-failed|dry-run), stop_reason, issue, pull_request, gate_level, gate_status, proof_status, verifier, critic, human_required, policy_violations, tokens_prompt, tokens_completion, usage_estimated, cost_usd, llm_calls, models_requested, models_served, profile, factory_version`.

#### Scenario: Parsable
- **WHEN** a record is parsed as YAML front matter
- **THEN** all keys above are present

### Requirement: Redaction
Records MUST pass through the secret redactor and MUST NOT contain issue bodies, full transcripts or file contents.

#### Scenario: Key in error
- **WHEN** an error message includes an API key value
- **THEN** the record contains `[REDACTED]`

### Requirement: Durable records branch
`ufactory records push` SHALL add local run records missing from the `factory-records` branch as one new commit built with git plumbing, without changing HEAD, the index or the working tree, and MUST retry on a rejected non-forced push. `ufactory records pull` SHALL copy records from the last N days that are missing locally.

#### Scenario: Two jobs push concurrently
- **WHEN** two checkouts each push one new record
- **THEN** the branch contains both records and neither checkout's HEAD changed

### Requirement: Daily spend cap
When `budget.max_usd_per_day` is set, implement SHALL stop with `daily-spend-cap` before claiming when the `cost_usd` of records started in the last 24 hours reaches the cap.

#### Scenario: Older runs excluded
- **WHEN** records cost $1.50 (1 h ago), $2 (23 h ago) and $100 (27 h ago)
- **THEN** the spend counted is $3.50
