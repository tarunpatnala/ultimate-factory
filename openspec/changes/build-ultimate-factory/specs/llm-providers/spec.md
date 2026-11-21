# Spec Delta

## Purpose
Call any configured OpenAI-compatible endpoint, including Portkey and Azure, reliably and within budget.

## ADDED Requirements

### Requirement: Request format
The system SHALL send Chat Completions requests (`POST <base_url>/chat/completions`) with `model`, `messages`, optional `tools`, and the output limit in the field named by `token_param` (default `max_completion_tokens`). `temperature` MUST be omitted when the provider's `capabilities.temperature` is false or the model setting leaves it unset.

#### Scenario: Reasoning model
- **WHEN** a role sets `reasoning_effort: high` and no temperature
- **THEN** the body includes `reasoning_effort` and no `temperature`

### Requirement: OpenAI authentication
For `openai` and `openai-compatible`, the system SHALL send `Authorization: Bearer <value of api_key_env>` when `api_key_env` is non-empty, plus `OpenAI-Organization` / `OpenAI-Project` when their env vars are configured.

#### Scenario: Local server without key
- **WHEN** `api_key_env` is empty for an `openai-compatible` provider
- **THEN** no Authorization header is sent

### Requirement: Portkey headers
For `portkey`, the system SHALL send `x-portkey-api-key`, `x-portkey-trace-id` equal to the run id, and `x-portkey-metadata` (JSON with `run_id`, `stage`, `role`, plus configured metadata). Routing precedence: `config` → `x-portkey-config`; else `virtual_key_env` → `x-portkey-virtual-key`; else `provider` → `x-portkey-provider` with `Authorization: Bearer <provider_api_key_env>` when set; else the model name MUST be a catalog reference beginning with `@`.

#### Scenario: Catalog model only
- **WHEN** a Portkey provider has no config, virtual key or provider and the model is `@openai-prod/gpt-5.1`
- **THEN** the request carries only `x-portkey-api-key` routing and the model string unchanged

#### Scenario: Unroutable Portkey request
- **WHEN** none of config, virtual key, provider is set and the model does not start with `@`
- **THEN** validation fails before any network call

### Requirement: Azure OpenAI
For `azure-openai`, the system SHALL send the `api-key` header. When `api_version` is set the URL MUST be `<base_url>/openai/deployments/<model>/chat/completions?api-version=<api_version>`; otherwise `<base_url>/openai/v1/chat/completions`.

#### Scenario: Deployment path
- **WHEN** `api_version: 2024-10-21` and model `gpt-4o-prod`
- **THEN** the request URL uses the deployments path with that api-version

### Requirement: Retries
The system SHALL retry on HTTP 408, 429, 500, 502, 503, 504 and network errors, up to `max_retries`, with exponential backoff (base 1 s, cap 30 s, full jitter) and MUST honour `Retry-After` (seconds or HTTP date, capped at 60 s). Other 4xx errors MUST NOT be retried.

#### Scenario: Rate limited
- **WHEN** the endpoint returns 429 with `Retry-After: 2` then 200
- **THEN** the call waits at least 2 s and succeeds on the second attempt

### Requirement: Usage and budgets
The system SHALL accumulate prompt and completion tokens per run from `usage`; when `usage` is absent it MUST estimate tokens as characters/4 and mark the run `usage_estimated: true`. Exceeding `budget.max_tokens_per_run`, `budget.max_turns` or `budget.max_usd_per_run` MUST stop the run with status `stopped` and reason `budget`.

#### Scenario: Token budget
- **WHEN** cumulative tokens exceed `max_tokens_per_run`
- **THEN** no further LLM call is made and the run record shows `status: stopped`, `stop_reason: budget`

### Requirement: Secret redaction
Logs, errors and run records MUST redact the values of `authorization`, `api-key`, `x-portkey-api-key`, `x-portkey-virtual-key` and every configured secret env value.

#### Scenario: Error body echo
- **WHEN** a provider error message contains the API key
- **THEN** the stored message shows `[REDACTED]`

### Requirement: Served model recorded
The system SHALL record the `model` field returned by the provider for every call.

#### Scenario: Gateway fallback
- **WHEN** Portkey falls back to a different model
- **THEN** the run record lists the served model, not only the requested one
