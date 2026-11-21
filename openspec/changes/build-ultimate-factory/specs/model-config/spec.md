# Spec Delta

## Purpose
Define how the factory chooses a provider, endpoint and model for every stage from one config file, safely and predictably.

## ADDED Requirements

### Requirement: Config file discovery
The system SHALL load configuration from the path given by `--config`, else `UFACTORY_CONFIG`, else `factory.config.yaml` then `factory.config.yml` in the repository root. A missing file MUST produce a config error with exit code 2 naming the paths searched.

#### Scenario: Explicit path wins
- **WHEN** `--config ci.yaml` is passed and `factory.config.yaml` also exists
- **THEN** only `ci.yaml` is loaded

### Requirement: Provider types
The system SHALL accept provider entries of type `openai`, `portkey`, `azure-openai` and `openai-compatible`, each with `base_url`, `api_key_env`, optional `headers`, `timeout_ms` (default 120000), `max_retries` (default 4) and optional `capabilities` (`tools`, `json_mode`, `usage`, `temperature`, all default true).

#### Scenario: Unknown provider type
- **WHEN** a provider declares `type: anthropic-native`
- **THEN** validation fails with the path `providers.<name>.type` and the allowed values

### Requirement: Model resolution per role
The system SHALL resolve the model for role R as: `models.default`, overlaid by the active profile's `models.default`, overlaid by `models.roles.R`, overlaid by the active profile's `models.roles.R`. Roles are `triage`, `spec`, `implement`, `verify`, `critic`, `review`, `monitor`. Review personas MAY override further via `review.persona_models.<persona>`.

#### Scenario: Role override
- **WHEN** default is `openai/gpt-5.1` and `roles.verify` sets `provider: portkey, model: "@anthropic/claude-sonnet-4-5"`
- **THEN** verify calls go to Portkey with that model and all other roles use OpenAI

### Requirement: Profiles
The system SHALL select a profile from `--profile`, else `UFACTORY_PROFILE`, else `active_profile`. Selecting an undefined profile MUST fail validation.

#### Scenario: Switch to Portkey with one flag
- **WHEN** `--profile portkey` is passed
- **THEN** the portkey profile's models apply without editing the file

### Requirement: Environment interpolation
String values SHALL support `${VAR}` and `${VAR:-default}`. An unset variable without a default MUST resolve to an empty string and be reported by `doctor`.

#### Scenario: Default value
- **WHEN** a value is `${PORTKEY_CONFIG:-pc-default}` and the variable is unset
- **THEN** the value is `pc-default`

### Requirement: No inline secrets
Validation MUST fail when any key named `api_key`, `apikey`, `token`, `secret` or `password` holds a literal, when any string value matches a secret pattern (`sk-…`, `pk-…`, `Bearer …`, 32+ char hex or base64 runs) without coming from `${ENV}` interpolation, or when a `base_url` contains user-info credentials.

#### Scenario: Literal key rejected
- **WHEN** a provider sets `api_key: sk-abc123…`
- **THEN** validation fails and tells the user to use `api_key_env`
