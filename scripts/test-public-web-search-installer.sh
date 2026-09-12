#!/usr/bin/env bash
# Exercise the public-web-search setting through the real setup, upgrade, and
# repair paths without starting services, installing packages, or making requests.
set -euo pipefail

SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SETUP="$SCRIPT_DIR/setup.sh"
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

write_test_commands() {
  local bin_dir="$1" log_file="$2"
  mkdir -p "$bin_dir"

  cat > "$bin_dir/docker" <<'EOF'
#!/usr/bin/env bash
printf 'docker %s\n' "$*" >> "$FORGE_PUBLIC_WEB_SEARCH_TEST_LOG"
exit 0
EOF
  cat > "$bin_dir/node" <<'EOF'
#!/usr/bin/env bash
printf 'node %s\n' "$*" >> "$FORGE_PUBLIC_WEB_SEARCH_TEST_LOG"
if [ "${1:-}" = '-p' ]; then
  printf '22\n'
fi
EOF
  cat > "$bin_dir/npm" <<'EOF'
#!/usr/bin/env bash
printf 'npm %s\n' "$*" >> "$FORGE_PUBLIC_WEB_SEARCH_TEST_LOG"
exit 0
EOF
  cat > "$bin_dir/pgrep" <<'EOF'
#!/usr/bin/env bash
# The proof must not depend on whether a developer has a local dev server.
exit 1
EOF
  chmod 700 "$bin_dir/docker" "$bin_dir/node" "$bin_dir/npm" "$bin_dir/pgrep"
  : > "$log_file"
}

run_setup_fresh() {
  local case_dir="$TEST_ROOT/setup-fresh"
  local workspace="$case_dir/workspace"
  local env_file="$workspace/config/forge.env"
  local fake_bin="$case_dir/bin"
  local command_log="$case_dir/commands.log"

  write_test_commands "$fake_bin" "$command_log"
  PATH="$fake_bin:$PATH" \
  FORGE_PUBLIC_WEB_SEARCH_TEST_LOG="$command_log" \
  FORGE_WORKSPACE_ROOT="$workspace" \
  FORGE_ENV_FILE="$env_file" \
  /bin/bash "$SETUP" > "$case_dir/setup.stdout"

  assert_setting "$env_file" '0'
  [ "$(stat -c '%a' "$env_file")" = 600 ] || fail 'setup did not keep the fresh environment file private'
  grep -Fqx 'docker compose version' "$command_log" || fail 'setup did not probe Docker Compose'
  grep -Fq 'docker compose --env-file' "$command_log" || fail 'setup did not run its Docker Compose startup path'
  grep -Fq 'npm install --loglevel=error --no-audit --no-fund' "$command_log" || fail 'setup did not run its web dependency path'
}

prepare_upgrade_checkout() {
  local checkout="$1"
  mkdir -p "$checkout/scripts" "$checkout/web"
  cp "$INSTALLER" "$checkout/scripts/install.sh"
  cp "$SCRIPT_DIR/../docker-compose.yml" "$checkout/docker-compose.yml"
  cp "$SCRIPT_DIR/../web/package.json" "$checkout/web/package.json"
  cp "$SCRIPT_DIR/../web/package-lock.json" "$checkout/web/package-lock.json"
  cp "$SCRIPT_DIR/../web/drizzle.config.ts" "$checkout/web/drizzle.config.ts"
}

run_upgrade() {
  local case_dir="$1" workspace="$2" env_file="$3"
  local checkout="$case_dir/checkout"
  local fake_bin="$case_dir/bin"
  local command_log="$case_dir/commands.log"

  prepare_upgrade_checkout "$checkout"
  write_test_commands "$fake_bin" "$command_log"
  PATH="$fake_bin:$PATH" \
  FORGE_PUBLIC_WEB_SEARCH_TEST_LOG="$command_log" \
  FORGE_OS_OVERRIDE=Darwin \
  FORGE_SERVICE_MODE=docker \
  FORGE_WORKSPACE_ROOT="$workspace" \
  FORGE_ENV_FILE="$env_file" \
  FORGE_INSTALL_STATE_DIR="$workspace/runtime/install" \
  FORGE_CLI_LINK_DIR="$case_dir/cli" \
  FORGE_NPM_INSTALL_TIMEOUT_SECONDS=10 \
  /bin/bash "$checkout/scripts/install.sh" --upgrade --skip-ollama > "$case_dir/upgrade.stdout"

  grep -Fqx 'docker info' "$command_log" || fail 'upgrade did not use its Docker service-attestation path'
  grep -Fq 'npm ci --no-audit --no-fund --progress=true' "$command_log" || fail 'upgrade did not run its dependency-sync path'
  grep -Fq 'npm run db:migrate --silent' "$command_log" || fail 'upgrade did not run its migration path'
  grep -Fq 'npm run db:seed-agents' "$command_log" || fail 'upgrade did not run its seed path'
  grep -Fq 'npm run doctor' "$command_log" || fail 'upgrade did not run its doctor path'
}

run_repair_mutation() {
  local case_dir="$1" workspace="$2" env_file="$3"
  local checkout="$case_dir/repair-checkout"
  local fake_bin="$case_dir/repair-bin"
  local command_log="$case_dir/repair-commands.log"
  local before="$case_dir/before-repair.env"

  mkdir -p "$checkout/scripts" "$checkout/web/.next" "$checkout/web/node_modules/.cache"
  cp "$REPAIR" "$checkout/scripts/repair.sh"
  printf '{"name":"repair-fixture"}\n' > "$checkout/web/package.json"
  printf 'generated cache\n' > "$checkout/web/.next/cache-marker"
  printf 'generated cache\n' > "$checkout/web/node_modules/.cache/cache-marker"
  for required in \
    flight-data-helpers.js \
    use-merged-ref.js \
    normalize-trailing-slash.js \
    app-next-turbopack.js \
    navigation-build-id.js
  do
    mkdir -p "$checkout/web/node_modules/next/dist/client"
    : > "$checkout/web/node_modules/next/dist/client/$required"
  done
  cp "$env_file" "$before"
  write_test_commands "$fake_bin" "$command_log"

  PATH="$fake_bin:$PATH" \
  FORGE_PUBLIC_WEB_SEARCH_TEST_LOG="$command_log" \
  FORGE_WORKSPACE_ROOT="$workspace" \
  FORGE_ENV_FILE="$env_file" \
  /bin/bash "$checkout/scripts/repair.sh" --skip-install --skip-migrate --skip-doctor > "$case_dir/repair.stdout"

  [ ! -e "$checkout/web/.next" ] || fail 'repair did not remove its generated Next.js cache'
  [ ! -e "$checkout/web/node_modules/.cache" ] || fail 'repair did not remove its generated dependency cache'
  cmp -s "$before" "$env_file" || fail 'repair rewrote the public-web-search setting'
  grep -Fq 'npm run clean:conflict-copies' "$command_log" || fail 'repair did not execute its cleanup command path'
}

run_case() {
  local name="$1" existing="$2" expected="$3"
  local case_dir="$TEST_ROOT/$name"
  local workspace="$case_dir/workspace"
  local env_file="$workspace/config/forge.env"

  mkdir -p "$(dirname "$env_file")"
  if [ -n "$existing" ]; then
    printf '%s\n' "$existing" > "$env_file"
  else
    rmdir "$(dirname "$env_file")"
  fi

  run_upgrade "$case_dir" "$workspace" "$env_file"
  assert_setting "$env_file" "$expected"

  if [ "$name" = explicit_one ]; then
    run_repair_mutation "$case_dir" "$workspace" "$env_file"
  fi
}

# setup.sh owns the first-run path, while install.sh --upgrade owns the normal
# repair/upgrade lifecycle. Both are executed in disposable directories with
# command stubs, so this proof covers their mutations without host side effects.
run_setup_fresh
run_case missing 'UNRELATED_SETTING=preserved' '0'
run_case malformed 'FORGE_AGENT_WEB_SEARCH=unexpected-value' 'unexpected-value'
run_case explicit_zero 'FORGE_AGENT_WEB_SEARCH=0' '0'
run_case explicit_one 'FORGE_AGENT_WEB_SEARCH=1' '1'

printf 'Public web search setup, upgrade, and repair setting contract passed.\n'
