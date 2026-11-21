#!/usr/bin/env bash
# .NET detection in gates.sh, with a stand-in dotnet binary so the test needs no SDK.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fixture="$(mktemp -d "${TMPDIR:-/tmp}/factory-gates-dotnet.XXXXXX")"
bin="$(mktemp -d "${TMPDIR:-/tmp}/factory-dotnet-bin.XXXXXX")"
trap 'rm -rf "$fixture" "$bin"' EXIT
git -C "$fixture" init -q
node "$ROOT/bin/ufactory.js" init "$fixture" >/dev/null
printf 'Microsoft Visual Studio Solution File, Format Version 12.00\n' > "$fixture/Shop.sln"
# A package.json for front-end tooling must not hide the solution.
printf '{"private": true}\n' > "$fixture/package.json"

# Fake dotnet: logs each call; "list package" reports a vulnerability when DOTNET_VULN=1.
cat > "$bin/dotnet" <<'EOF'
#!/usr/bin/env bash
echo "dotnet $*" >> "$DOTNET_LOG"
if [ "$1" = "list" ] && [ "${DOTNET_VULN:-0}" = "1" ]; then
  echo "Project 'Shop' has the following vulnerable packages"
  echo "   > Newtonsoft.Json   12.0.1   High"
fi
if [ "$1" = "test" ] && [ "${DOTNET_TEST_FAIL:-0}" = "1" ]; then exit 1; fi
exit 0
EOF
chmod +x "$bin/dotnet"
export PATH="$bin:$PATH" DOTNET_LOG="$bin/log"

out="$(cd "$fixture" && ./.factory/scripts/gates.sh full)"
printf '%s' "$out" | grep -q 'stack=dotnet'
printf '%s' "$out" | grep -q 'status=GREEN'
grep -q '^dotnet build' "$DOTNET_LOG"
grep -q '^dotnet format --verify-no-changes' "$DOTNET_LOG"
grep -q '^dotnet test' "$DOTNET_LOG"

set +e
red="$(cd "$fixture" && DOTNET_TEST_FAIL=1 ./.factory/scripts/gates.sh full 2>&1)"
red_status=$?
set -e
[ "$red_status" -eq 1 ]
printf '%s' "$red" | grep -q 'failing=test'

# deep: a vulnerable package fails the audit gate even though dotnet exits 0.
set +e
deep="$(cd "$fixture" && DOTNET_VULN=1 ./.factory/scripts/gates.sh deep 2>&1)"
set -e
printf '%s' "$deep" | grep -Eq 'failing=[a-z,]*audit'

echo "gates (.NET): ok"
