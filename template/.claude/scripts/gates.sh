#!/usr/bin/env bash
# Compatibility wrapper: the canonical gate script lives in .factory/scripts/gates.sh so every
# harness (Claude Code, Codex, ultimate-factory) runs the same verdict.
exec bash "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/.factory/scripts/gates.sh" "$@"
