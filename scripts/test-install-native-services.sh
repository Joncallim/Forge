#!/usr/bin/env bash
# Focused executable regression coverage for the Homebrew native-service path.
set -Eeuo pipefail

SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALLER="$SCRIPT_DIR/install.sh"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/forge-install-services.XXXXXX")"
trap 'rm -rf "$TEST_ROOT"' EXIT

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

assert_contains() {
  local expected="$1" file="$2"
  grep -Fq "$expected" "$file" >/dev/null || fail "expected '$expected' in $file"
}

assert_not_contains() {
  local unexpected="$1" file="$2"
  ! grep -Fq "$unexpected" "$file" || fail "did not expect '$unexpected' in $file"
}

run_case() {
  local name="$1" pg_initial="$2" redis_initial="$3" dry_run="$4" brew_failure="${5:-}"
  local case_dir="$TEST_ROOT/$name"
  mkdir -p "$case_dir/bin" "$case_dir/state"
  : > "$case_dir/calls"
  printf '%s\n' "$pg_initial" > "$case_dir/pg-state"
  printf '%s\n' "$redis_initial" > "$case_dir/redis-state"

  cat > "$case_dir/bin/pg_isready" <<'EOF'
#!/usr/bin/env bash
[ "$(cat "$FORGE_TEST_CASE_DIR/pg-state")" = ready ]
EOF
  cat > "$case_dir/bin/redis-cli" <<'EOF'
#!/usr/bin/env bash
if [ "$(cat "$FORGE_TEST_CASE_DIR/redis-state")" = ready ]; then
  printf 'PONG\n'
else
  printf 'NOT_READY\n'
fi
EOF
  cat > "$case_dir/bin/brew" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$FORGE_TEST_CASE_DIR/calls"
if [ "${FORGE_TEST_BREW_FAILURE:-}" = "$3" ]; then
  exit 1
fi
case "$3" in
  postgresql@16) printf 'ready\n' > "$FORGE_TEST_CASE_DIR/pg-state" ;;
  redis) printf 'ready\n' > "$FORGE_TEST_CASE_DIR/redis-state" ;;
esac
EOF
  chmod +x "$case_dir/bin/pg_isready" "$case_dir/bin/redis-cli" "$case_dir/bin/brew"

  set +e
  PATH="$case_dir/bin:$PATH" \
    FORGE_TEST_CASE_DIR="$case_dir" \
    FORGE_TEST_BREW_FAILURE="$brew_failure" \
    FORGE_DRY_RUN="$dry_run" \
    FORGE_INSTALL_STATE_DIR="$case_dir/state" \
    FORGE_INSTALL_TEST_HOOK=start-native-services \
    bash "$INSTALLER" > "$case_dir/stdout" 2> "$case_dir/stderr"
  RUN_STATUS=$?
  set -e
  CASE_DIR="$case_dir"
}

run_case ready-ready ready ready 0
[ "$RUN_STATUS" -eq 0 ] || fail 'ready-ready should succeed'
[ ! -s "$CASE_DIR/calls" ] || fail 'ready-ready should not call Homebrew'
assert_contains 'PostgreSQL is already ready on localhost:5432; skipping Homebrew service start.' "$CASE_DIR/stdout"
assert_contains 'Redis is already ready on localhost:6379; skipping Homebrew service start.' "$CASE_DIR/stdout"

run_case ready-unready ready unready 0
[ "$RUN_STATUS" -eq 0 ] || fail 'ready-unready should succeed'
assert_contains 'services start redis' "$CASE_DIR/calls"
assert_not_contains 'services start postgresql@16' "$CASE_DIR/calls"

run_case unready-ready unready ready 0
[ "$RUN_STATUS" -eq 0 ] || fail 'unready-ready should succeed'
assert_contains 'services start postgresql@16' "$CASE_DIR/calls"
assert_not_contains 'services start redis' "$CASE_DIR/calls"

run_case unready-unready unready unready 0
[ "$RUN_STATUS" -eq 0 ] || fail 'unready-unready should succeed'
assert_contains 'services start postgresql@16' "$CASE_DIR/calls"
assert_contains 'services start redis' "$CASE_DIR/calls"

run_case dry-run unready unready 1
[ "$RUN_STATUS" -eq 0 ] || fail 'dry-run should succeed'
[ ! -s "$CASE_DIR/calls" ] || fail 'dry-run should not execute Homebrew'
assert_contains '[dry-run] Start PostgreSQL' "$CASE_DIR/stdout"
assert_contains '[dry-run] Start Redis' "$CASE_DIR/stdout"
assert_contains '[dry-run] brew services start postgresql@16' "$CASE_DIR/stdout"
assert_contains '[dry-run] brew services start redis' "$CASE_DIR/stdout"

run_case postgres-start-failure unready ready 0 postgresql@16
[ "$RUN_STATUS" -ne 0 ] || fail 'failed PostgreSQL start should fail'
assert_contains 'Could not start PostgreSQL with Homebrew. Check the install log:' "$CASE_DIR/stderr"
assert_contains 'services start postgresql@16' "$CASE_DIR/calls"

printf 'PASS: native Homebrew readiness-first service coverage\n'
