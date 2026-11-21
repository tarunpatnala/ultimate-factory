# Spec Delta

## Purpose
Install the factory into any repository safely and repeatably.

## ADDED Requirements

### Requirement: Never overwrite
`ufactory init [path] [--dry-run] [--with-workflows] [--harness claude,codex]` SHALL copy template files that do not exist and report `create` or `skip (exists)` for each, never modifying existing files.

#### Scenario: Re-run
- **WHEN** init runs twice
- **THEN** the second run creates nothing and reports every file as skipped

### Requirement: Installed contents
The template SHALL include `factory.config.yaml`, `docs/factory/{CHARTER,CONTRACT,QUEUE,STATE,DECISIONS}.md`, `docs/factory/runs/README.md`, `.factory/gates.conf`, `.factory/scripts/{gates,prove-test,doctor,bootstrap-github}.sh`, Claude Code adapters under `.claude/` (skills, agents, commands, settings, hook) and Codex adapters under `.agents/` and `.codex/`, and with `--with-workflows` the GitHub Actions workflows `factory.yml` and `factory-policy.yml`.

#### Scenario: Claude adapters only
- **WHEN** `--harness claude` is given
- **THEN** `.agents/` and `.codex/` are not installed

### Requirement: Workflow safety
Installed workflows SHALL declare least-privilege `permissions`, use `concurrency` groups per stage, set job timeouts, check out without persisted credentials, install ultimate-factory only from the pinned `UFACTORY_PACKAGE` variable, never use `pull_request_target`, skip fork PRs for verify, verify new factory PRs inline after implement, and filter issue events by `author_association`.

#### Scenario: Fork PR
- **WHEN** a fork opens a PR
- **THEN** the verify job is skipped and policy-check still runs without secrets
