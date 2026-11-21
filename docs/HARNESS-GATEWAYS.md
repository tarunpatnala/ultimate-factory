# Using Claude Code or Codex through a gateway

`ufactory` is the provider-neutral runtime. If you prefer to keep driving the factory with
Claude Code or Codex (the skills under `.claude/` and `.agents/` still work), you can also route
those harnesses through Portkey or another gateway. This keeps model choice outside the vendor
app, but note the limits listed at the end.

## Claude Code through Portkey

Claude Code reads `ANTHROPIC_BASE_URL` and extra headers from `ANTHROPIC_CUSTOM_HEADERS`.

```bash
export ANTHROPIC_BASE_URL="https://api.portkey.ai"
export ANTHROPIC_CUSTOM_HEADERS=$'x-portkey-api-key: '"$PORTKEY_API_KEY"$'\nx-portkey-provider: anthropic'
export ANTHROPIC_AUTH_TOKEN="$ANTHROPIC_API_KEY"   # upstream key, or use a Portkey config instead of x-portkey-provider
claude
```

Check the current Portkey and Claude Code documentation for the exact header names your Portkey
setup expects (provider slug, config id or virtual key).

## Codex CLI through Portkey or any OpenAI-compatible gateway

Add a provider in `~/.codex/config.toml`:

```toml
model = "@openai/gpt-5.1"
model_provider = "portkey"

[model_providers.portkey]
name = "Portkey"
base_url = "https://api.portkey.ai/v1"
env_key = "PORTKEY_API_KEY"
env_http_headers = { "x-portkey-api-key" = "PORTKEY_API_KEY" }
```

## Limits of the gateway-only approach

| Concern | Harness + gateway | `ufactory` |
|---|---|---|
| Model / endpoint choice | yes | yes, per stage and per review persona |
| Charter rules enforced in code | no (prompts + hooks) | yes; plus `policy-check` for every harness |
| Unattended in plain GitHub Actions with only an API key | no | yes |
| Gate verdict authenticated with a nonce | no | yes |
| Token / USD budgets | gateway-side only | per run, in the run record |

Use both: keep the Claude/Codex skills for interactive work, run `ufactory` for unattended
stages, and make `factory-policy / policy-check` a required status check so every PR, whoever
wrote it, is held to the same charter.
