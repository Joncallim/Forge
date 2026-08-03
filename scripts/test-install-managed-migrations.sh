#!/usr/bin/env bash
# Focused executable coverage for managed-local migration orchestration.
set -Eeuo pipefail

SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALLER="$SCRIPT_DIR/install.sh"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/forge-managed-migrations.XXXXXX")"
trap 'rm -rf "$TEST_ROOT"' EXIT
TEST_SECRET='TEST_APP_DATABASE_URL_MUST_NOT_APPEAR'

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

assert_contains() {
  grep -Fq "$1" "$2" || fail "expected '$1' in $2"
}

assert_not_contains() {
  ! grep -Fq "$1" "$2" || fail "did not expect '$1' in $2"
}

assert_stages() {
  local file="$1"
  shift
  local expected actual
  expected="$(printf '%s\n' "$@")"
  actual="$(sed -n '2,$p' "$file")"
  [ "$actual" = "$expected" ] || fail "unexpected stages in $file: $actual"
}

run_managed_case() {
  local name="$1" admin_mode="$2" dry_run="${3:-0}" fail_stage="${4:-}"
  local case_dir="$TEST_ROOT/$name"
  mkdir -p "$case_dir/state"
  printf 'DATABASE_URL=postgresql://forge:%s@localhost:5432/forge\n' "$TEST_SECRET" > "$case_dir/forge.env"
  : > "$case_dir/stages"
  set +e
  FORGE_INSTALL_TEST_HOOK=managed-local-migrations \
    FORGE_INSTALL_TEST_ADMIN_MODE="$admin_mode" \
    FORGE_INSTALL_TEST_STAGE_LOG="$case_dir/stages" \
    FORGE_INSTALL_TEST_FAIL_STAGE="$fail_stage" \
    FORGE_DRY_RUN="$dry_run" \
    FORGE_ENV_FILE="$case_dir/forge.env" \
    FORGE_INSTALL_STATE_DIR="$case_dir/state" \
    /bin/bash "$INSTALLER" > "$case_dir/stdout" 2> "$case_dir/stderr"
  CASE_STATUS=$?
  set -e
  CASE_DIR="$case_dir"
}

expected_stages=(release migrate-0025 s3 migrate-0026 s4 migrate-0027 s5 latest)

for admin_mode in current sudo runuser; do
  run_managed_case "$admin_mode" "$admin_mode"
  [ "$CASE_STATUS" -eq 0 ] || fail "$admin_mode managed migration should succeed"
  assert_contains "admin:$admin_mode" "$CASE_DIR/stages"
  assert_stages "$CASE_DIR/stages" "${expected_stages[@]}"
done

run_managed_case idempotent-first current
[ "$CASE_STATUS" -eq 0 ] || fail 'first idempotent orchestration run should succeed'
run_managed_case idempotent-second current
[ "$CASE_STATUS" -eq 0 ] || fail 'second idempotent orchestration run should succeed'
assert_stages "$CASE_DIR/stages" "${expected_stages[@]}"

run_managed_case dry-run current 1
[ "$CASE_STATUS" -eq 0 ] || fail 'dry-run should succeed'
assert_contains '[dry-run] Bootstrap release roles, migrate through 0025' "$CASE_DIR/stdout"
[ "$(wc -l < "$CASE_DIR/stages" | tr -d '[:space:]')" = 1 ] || fail 'dry-run must not execute migration stages'

run_managed_case admin-unavailable unavailable
[ "$CASE_STATUS" -ne 0 ] || fail 'unavailable local admin must fail closed'
assert_contains 'Could not establish passwordless local PostgreSQL administrator access' "$CASE_DIR/stderr"

run_managed_case s5-failure current 0 s5
[ "$CASE_STATUS" -ne 0 ] || fail 'S5 migration failure must fail the orchestration'
assert_contains 's5-cleanup-attempted' "$CASE_DIR/stages"
assert_not_contains 'latest' "$CASE_DIR/stages"
assert_contains 'its cleanup wrapper preserves the original migration failure' "$CASE_DIR/stderr"

run_enabled_case() {
  local name="$1" service_mode="$2" database_url="$3"
  local case_dir="$TEST_ROOT/$name"
  mkdir -p "$case_dir/state"
  printf 'DATABASE_URL=%s\n' "$database_url" > "$case_dir/forge.env"
  FORGE_INSTALL_TEST_HOOK=managed-local-migrations-enabled \
    FORGE_INSTALL_TEST_SERVICE_MODE="$service_mode" \
    FORGE_ENV_FILE="$case_dir/forge.env" \
    FORGE_INSTALL_STATE_DIR="$case_dir/state" \
    /bin/bash "$INSTALLER" > "$case_dir/stdout" 2> "$case_dir/stderr"
  CASE_DIR="$case_dir"
}

run_enabled_case custom native "postgresql://custom:${TEST_SECRET}@example.invalid/forge"
assert_contains 'managed-local-migrations-bypassed' "$CASE_DIR/stdout"
run_enabled_case docker docker "postgresql://forge:${TEST_SECRET}@localhost:5432/forge"
assert_contains 'managed-local-migrations-bypassed' "$CASE_DIR/stdout"

run_runuser_environment_case() {
  local case_dir="$TEST_ROOT/runuser-environment"
  mkdir -p "$case_dir/bin" "$case_dir/state"
  printf 'DATABASE_URL=postgresql://forge:%s@localhost:5432/forge\n' "$TEST_SECRET" > "$case_dir/forge.env"
  cat > "$case_dir/bin/runuser" <<'EOF'
#!/bin/bash
marker_dir="$(dirname "$FORGE_ENV_FILE")"
if printenv | cut -d= -f1 | grep -Fx 'UNRELATED_SECRET_SENTINEL' >/dev/null; then
  printf 'unrelated-secret-leaked\n' > "$marker_dir/runuser-result"
  exit 1
fi
printenv | cut -d= -f1 | sort > "$marker_dir/runuser-environment-names"
printf 'clean\n' > "$marker_dir/runuser-result"
while [ "$1" != "--" ]; do shift; done
shift
exec "$@"
EOF
  cat > "$case_dir/bin/bash" <<'EOF'
#!/bin/bash
exit 0
EOF
  for command in node npm npx; do
    printf '#!/usr/bin/env bash\nexit 0\n' > "$case_dir/bin/$command"
  done
  chmod +x "$case_dir/bin/runuser" "$case_dir/bin/bash" "$case_dir/bin/node" "$case_dir/bin/npm" "$case_dir/bin/npx"
  cat > "$case_dir/driver.sh" <<'EOF'
#!/bin/bash
FORGE_INSTALL_LIBRARY=1 source "$INSTALLER"
test_toolchain_dir="$FORGE_TEST_TOOLCHAIN_DIR"
trusted_linux_tool() { printf '%s/%s\n' "$test_toolchain_dir" "$1"; }
OS_NAME=Linux
SERVICE_MODE=native
DRY_RUN=0
run_managed_local_migrations
EOF
  chmod +x "$case_dir/driver.sh"
  set +e
  INSTALLER="$INSTALLER" \
    FORGE_TEST_TOOLCHAIN_DIR="$case_dir/bin" \
    PATH="$case_dir/bin:$PATH" \
    UNRELATED_SECRET_SENTINEL='unrelated-value-must-not-reach-postgres' \
    FORGE_INSTALL_TEST_ADMIN_MODE=runuser \
    FORGE_ENV_FILE="$case_dir/forge.env" \
    FORGE_INSTALL_STATE_DIR="$case_dir/state" \
    /bin/bash "$case_dir/driver.sh" > "$case_dir/stdout" 2> "$case_dir/stderr"
  local driver_status=$?
  set -e
  if [ "$driver_status" -ne 0 ]; then
    sed -n '1,80p' "$case_dir/stderr" >&2
    fail 'runuser environment driver failed'
  fi
  CASE_DIR="$case_dir"
}

run_runuser_environment_case
assert_contains 'clean' "$CASE_DIR/runuser-result"
assert_not_contains 'UNRELATED_SECRET_SENTINEL' "$CASE_DIR/runuser-environment-names"
assert_contains 'DATABASE_URL' "$CASE_DIR/runuser-environment-names"
assert_contains 'FORGE_DATABASE_ADMIN_URL' "$CASE_DIR/runuser-environment-names"
assert_contains 'PGHOST' "$CASE_DIR/runuser-environment-names"
assert_contains 'PGUSER' "$CASE_DIR/runuser-environment-names"
assert_not_contains "$TEST_SECRET" "$CASE_DIR/runuser-environment-names"

run_shadow_refusal_case() {
  local case_dir="$TEST_ROOT/shadow-refusal"
  mkdir -p "$case_dir/bin"
  printf '#!/bin/bash\nprintf shadow-used > "$FORGE_SHADOW_MARKER"\nexit 0\n' > "$case_dir/bin/sudo"
  chmod +x "$case_dir/bin/sudo"
  INSTALLER="$INSTALLER" FORGE_SHADOW_MARKER="$case_dir/marker" PATH="$case_dir/bin:$PATH" /bin/bash -c '
    FORGE_INSTALL_LIBRARY=1 source "$INSTALLER"
    resolved="$(trusted_linux_tool sudo 2>/dev/null || true)"
    [ "$resolved" != "$PWD/bin/sudo" ]
  ' > "$case_dir/stdout" 2> "$case_dir/stderr"
  [ ! -e "$case_dir/marker" ] || fail 'caller PATH shadow reached the privileged sudo resolver'
}

run_shadow_refusal_case

if rg -F "$TEST_SECRET" "$TEST_ROOT" --glob '!forge.env' >/dev/null; then
  fail 'test sentinel leaked outside the local environment fixture'
fi

printf 'PASS: managed local migration orchestration coverage\n'
