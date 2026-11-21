#!/usr/bin/env bash
# Shell tests for the installed template scripts (ported from the original template's test suite).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
while IFS= read -r script; do bash -n "$script"; done < <(find template test/shell -type f -name '*.sh' | sort)
python3 -m json.tool template/.claude/settings.json >/dev/null
python3 -m json.tool template/.codex/hooks.json >/dev/null
for t in test/shell/test-*.sh; do printf '\n==> %s\n' "$t"; bash "$t"; done
printf '\nAll shell tests passed.\n'
