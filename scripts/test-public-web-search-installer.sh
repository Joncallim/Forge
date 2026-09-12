#!/usr/bin/env bash
# Exercise the installer and repair lifecycle's public-web-search setting
# contract without starting services, installing packages, or making requests.
set -euo pipefail

SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALLER="$SCRIPT_DIR/install.sh"
REPAIR="$SCRIPT_DIR/repair.sh"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/forge-public-web-search-installer.XXXXXX")"
trap 'rm -rf "$TEST_ROOT"' EXIT

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

setting_value() {
  sed -n 's/^FORGE_AGENT_WEB_SEARCH=//p' "$1" | head -n1
}

assert_setting() {
  local file="$1" expected="$2" count
  count="$(grep -c '^FORGE_AGENT_WEB_SEARCH=' "$file" || true)"
  [ "$count" = 1 ] || fail "expected exactly one public-web-search setting in $file"
  [ "$(setting_value "$file")" = "$expected" ] \
    || fail "expected public-web-search setting $expected in $file"
}

run_upgrade_env_write() {
  local workspace="$1" env_file="$2"
  FORGE_INSTALL_LIBRARY=1 \
  FORGE_UPGRADE=1 \
  FORGE_WORKSPACE_ROOT="$workspace" \
  FORGE_ENV_FILE="$env_file" \
  FORGE_INSTALL_STATE_DIR="$workspace/runtime/install" \
  /bin/bash -c '
    source "$1"
    DB_PASSWORD=installer-test-password
    SESSION_SECRET=installer-test-session-secret
    write_env_file
  ' _ "$INSTALLER"
}

run_repair_read_only() {
  local workspace="$1" env_file="$2"
  FORGE_WORKSPACE_ROOT="$workspace" \
  FORGE_ENV_FILE="$env_file" \
  /bin/bash "$REPAIR" --dry-run --skip-install --skip-migrate --skip-doctor >/dev/null
}

run_case() {
  local name="$1" existing="$2" expected="$3"
  local workspace="$TEST_ROOT/$name/workspace"
  local env_file="$workspace/config/forge.env"
  local after_upgrade="$TEST_ROOT/$name/after-upgrade.env"

  mkdir -p "$(dirname "$env_file")"
  if [ -n "$existing" ]; then
    printf '%s\n' "$existing" > "$env_file"
  else
    rmdir "$(dirname "$env_file")"
  fi

  run_upgrade_env_write "$workspace" "$env_file"
  assert_setting "$env_file" "$expected"
  cp "$env_file" "$after_upgrade"

  run_repair_read_only "$workspace" "$env_file"
  cmp -s "$after_upgrade" "$env_file" \
    || fail "repair changed the public-web-search setting for $name"
}

# A new environment and an existing environment without the key both receive
# the secure default. Existing explicit and malformed values are not rewritten:
# the server-side parser fails malformed values closed at runtime.
run_case fresh '' '0'
run_case missing 'UNRELATED_SETTING=preserved' '0'
run_case malformed 'FORGE_AGENT_WEB_SEARCH=unexpected-value' 'unexpected-value'
run_case explicit_zero 'FORGE_AGENT_WEB_SEARCH=0' '0'
run_case explicit_one 'FORGE_AGENT_WEB_SEARCH=1' '1'

printf 'Public web search installer and repair setting contract passed.\n'
