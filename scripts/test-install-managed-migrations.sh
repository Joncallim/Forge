#!/usr/bin/env bash
# Focused executable coverage for managed-local migration orchestration.
set -Eeuo pipefail

SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALLER="$SCRIPT_DIR/install.sh"
REPAIR="$SCRIPT_DIR/repair.sh"
PRIVILEGE_SQL="$SCRIPT_DIR/reconcile-forge-app-privileges.sql"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/forge-managed-migrations.XXXXXX")"
trap 'rm -rf "$TEST_ROOT"' EXIT
TEST_SECRET='TEST_APP_DATABASE_URL_MUST_NOT_APPEAR'

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

assert_contains() {
  grep -Fq -- "$1" "$2" || fail "expected '$1' in $2"
}

assert_not_contains() {
  ! grep -Fq -- "$1" "$2" || fail "did not expect '$1' in $2"
}

assert_stages() {
  local file="$1"
  shift
  local expected actual
  expected="$(printf '%s\n' "$@")"
  actual="$(sed -n '2,$p' "$file")"
  [ "$actual" = "$expected" ] || fail "unexpected stages in $file: $actual"
}

grant_function="$TEST_ROOT/grant-forge-privileges"
sed -n '/^grant_forge_privileges() {/,/^}/p' "$INSTALLER" > "$grant_function"
assert_contains "trap 'on_error" "$INSTALLER"
assert_contains '--set ON_ERROR_STOP=1' "$grant_function"
assert_contains 'trap - ERR' "$grant_function"
assert_contains '--file "$FORGE_PRIVILEGE_SQL"' "$grant_function"
assert_contains "Re-run 'forge upgrade'" "$grant_function"
assert_not_contains "Re-run 'forge repair'" "$grant_function"
assert_contains '--file "$FORGE_PRIVILEGE_SQL"' "$REPAIR"
assert_contains "Re-run 'forge repair'" "$REPAIR"
assert_contains 'Would reconcile local forge app privileges in database' "$REPAIR"
assert_contains 'postgresql://forge:*@localhost:5432/forge|postgres://forge:*@localhost:5432/forge' "$REPAIR"
assert_contains 'FORGE_REPAIR_TEST_DATABASE_NAME is required for the privilege reconciliation test hook.' "$REPAIR"
assert_contains 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO forge;' "$PRIVILEGE_SQL"
assert_contains 'GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO forge;' "$PRIVILEGE_SQL"
assert_contains "owner_role.rolname IN ('forge_release_routines_owner', 'forge_s4_routines_owner')" "$PRIVILEGE_SQL"
assert_contains 'FOR UPDATE OF relation;' "$PRIVILEGE_SQL"
assert_contains 'FOR UPDATE OF attribute;' "$PRIVILEGE_SQL"
assert_contains "'REVOKE ALL PRIVILEGES ON TABLE %I.%I FROM forge'" "$PRIVILEGE_SQL"
assert_contains "'REVOKE ALL PRIVILEGES (%s) ON TABLE %I.%I FROM forge'" "$PRIVILEGE_SQL"
assert_contains 'public.work_package_local_projection_sources,' "$PRIVILEGE_SQL"
assert_contains 'public.work_package_local_projection_heads' "$PRIVILEGE_SQL"
assert_contains "RAISE EXCEPTION 'forge retained unexpected protected table or column authority'" "$PRIVILEGE_SQL"
assert_contains "RAISE EXCEPTION 'forge retained effective protected table or column authority'" "$PRIVILEGE_SQL"
assert_contains "RAISE EXCEPTION 'protected owner tables retained unexpected PUBLIC authority'" "$PRIVILEGE_SQL"
assert_contains 'pg_catalog.has_table_privilege(forge_role.oid, relation.oid' "$PRIVILEGE_SQL"
assert_contains 'pg_catalog.has_any_column_privilege(forge_role.oid, relation.oid' "$PRIVILEGE_SQL"
assert_contains "RAISE EXCEPTION 'fixed protected owner inventory is incomplete or has ownership drift'" "$PRIVILEGE_SQL"
assert_contains "RAISE EXCEPTION 'forge app role is not a safe or known legacy login'" "$PRIVILEGE_SQL"
assert_contains 'ALTER ROLE forge NOINHERIT;' "$PRIVILEGE_SQL"
assert_not_contains 'public.forge_epic_172_enablement_state,' "$PRIVILEGE_SQL"
assert_not_contains 'projection_count' "$PRIVILEGE_SQL"
broad_grant_sources="$(grep -lF 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO forge;' \
  "$INSTALLER" "$REPAIR" "$PRIVILEGE_SQL" || true)"
[ "$broad_grant_sources" = "$PRIVILEGE_SQL" ] \
  || fail 'the shared reconciliation SQL must be the only broad table-GRANT source'
privilege_sql="$(tr '\n' ' ' < "$PRIVILEGE_SQL")"
case "$privilege_sql" in
  *'BEGIN;'*'fixed protected owner inventory is incomplete or has ownership drift'*'ALTER ROLE forge NOINHERIT;'*'FOR UPDATE OF relation;'*'FOR UPDATE OF attribute;'*'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO forge;'*'REVOKE ALL PRIVILEGES ON TABLE'*'GRANT SELECT ON TABLE'*'COMMIT;'*) ;;
  *) fail 'forge app grants and owner-driven protected reconciliation must share one ordered transaction' ;;
esac

sql_owner_map="$TEST_ROOT/sql-owner-map"
ts_owner_map="$TEST_ROOT/ts-owner-map"
sed -n '/canonical-protected-owner-map-begin/,/canonical-protected-owner-map-end/p' "$PRIVILEGE_SQL" \
  | sed -n "s/^  ('\([^']*\)', '\([^']*\)').*/\1|\2/p" | sort > "$sql_owner_map"
sed -n '/canonical-protected-owner-map-begin/,/canonical-protected-owner-map-end/p' \
  "$SCRIPT_DIR/../web/scripts/repair-epic-172-legacy-release.ts" \
  | sed -n "s/^  { name: '\([^']*\)', owner: \([^,]*\),.*/\1|\2/p" \
  | sed 's/|releaseOwner$/|forge_release_routines_owner/; s/|s4Owner$/|forge_s4_routines_owner/' \
  | sort > "$ts_owner_map"
[ "$(wc -l < "$sql_owner_map" | tr -d '[:space:]')" = 37 ] \
  || fail 'shared SQL must define the exact 37-table protected owner map'
cmp -s "$sql_owner_map" "$ts_owner_map" \
  || fail 'shared SQL and legacy normalizer protected owner maps drifted'

provision_function="$TEST_ROOT/provision-database"
sed -n '/^provision_database() {/,/^}/p' "$INSTALLER" > "$provision_function"
assert_contains 'CREATE ROLE forge LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD' "$provision_function"
assert_contains 'ALTER ROLE forge LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD' "$provision_function"
assert_contains "FROM pg_catalog.pg_auth_members WHERE roleid = 'forge'::pg_catalog.regrole OR member = 'forge'::pg_catalog.regrole" "$provision_function"
assert_contains 'Role forge has membership edges.' "$provision_function"
assert_contains 'Role forge is outside the safe or known legacy app-role boundary' "$provision_function"
provision_function_sql="$(tr '\n' ' ' < "$provision_function")"
case "$provision_function_sql" in
  *'pg_catalog.pg_auth_members'*'role_normalizable='*'ALTER ROLE forge LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD'*) ;;
  *) fail 'existing forge membership and role-shape refusal must precede role hardening' ;;
esac

psql_status_case="$TEST_ROOT/psql-status"
mkdir -p "$psql_status_case/bin"
cat > "$psql_status_case/bin/psql" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$FORGE_TEST_PSQL_CALLS"
case "$*" in
  *'-tAc SELECT 1'*) exit 0 ;;
  *) exit 73 ;;
esac
EOF
chmod +x "$psql_status_case/bin/psql"
: > "$psql_status_case/calls"
set +e
PATH="$psql_status_case/bin:$PATH" \
  FORGE_TEST_PSQL_CALLS="$psql_status_case/calls" \
  FORGE_INSTALL_STATE_DIR="$psql_status_case/grant-state" \
  FORGE_WORKSPACE_ROOT="$psql_status_case/grant-workspace" \
  FORGE_ENV_FILE="$psql_status_case/grant.env" \
  bash -c '
    export FORGE_INSTALL_LIBRARY=1
    source "$1"
    SERVICE_MODE=native
    MANAGE_LOCAL_DB=1
    DRY_RUN=0
    if psql_admin -c "SELECT wrapper_failure"; then
      printf "unexpected psql_admin success\n"
      exit 65
    else
      printf "psql-admin-status=%s\n" "$?"
    fi
    grant_forge_privileges
    printf "grant-return=%s\n" "$?"
  ' _ "$INSTALLER" > "$psql_status_case/grant-stdout" 2> "$psql_status_case/grant-stderr"
grant_status=$?
set -e
[ "$grant_status" -eq 0 ] || fail 'grant refresh psql failure must remain non-fatal'
assert_contains 'psql-admin-status=73' "$psql_status_case/grant-stdout"
assert_contains 'grant-return=0' "$psql_status_case/grant-stdout"
assert_contains 'Could not transactionally refresh forge app privileges (non-fatal).' "$psql_status_case/grant-stdout"
assert_contains "Re-run 'forge upgrade'" "$psql_status_case/grant-stdout"
assert_not_contains 'Ensured the forge role can read and write ordinary forge tables' "$psql_status_case/grant-stdout"
assert_not_contains 'unexpected psql_admin success' "$psql_status_case/grant-stdout"

set +e
PATH="$psql_status_case/bin:$PATH" \
  FORGE_TEST_PSQL_CALLS="$psql_status_case/calls" \
  FORGE_INSTALL_STATE_DIR="$psql_status_case/fatal-state" \
  FORGE_WORKSPACE_ROOT="$psql_status_case/fatal-workspace" \
  FORGE_ENV_FILE="$psql_status_case/fatal.env" \
  bash -c 'export FORGE_INSTALL_LIBRARY=1; source "$1"; psql_admin -c "SELECT fatal_wrapper_failure"; printf "unexpected continuation\n"' \
  _ "$INSTALLER" > "$psql_status_case/fatal-stdout" 2> "$psql_status_case/fatal-stderr"
fatal_psql_status=$?
set -e
[ "$fatal_psql_status" -ne 0 ] || fail 'ordinary psql_admin failures must remain fatal'
assert_contains 'Installer failed near line' "$psql_status_case/fatal-stderr"
assert_not_contains 'unexpected continuation' "$psql_status_case/fatal-stdout"

global_err_case="$TEST_ROOT/global-err-trap"
mkdir -p "$global_err_case"
set +e
FORGE_INSTALL_LIBRARY=1 \
  FORGE_INSTALL_STATE_DIR="$global_err_case/state" \
  FORGE_WORKSPACE_ROOT="$global_err_case/workspace" \
  FORGE_ENV_FILE="$global_err_case/forge.env" \
  bash -c 'source "$1"; false; printf "unexpected continuation\n"' _ "$INSTALLER" \
  > "$global_err_case/stdout" 2> "$global_err_case/stderr"
global_err_status=$?
set -e
[ "$global_err_status" -ne 0 ] || fail 'ordinary sourced-installer errors must remain fatal'
assert_contains 'Installer failed near line' "$global_err_case/stderr"
assert_not_contains 'unexpected continuation' "$global_err_case/stdout"

run_repair_process_case() {
  local name="$1" database_url="$2"
  shift 2
  local case_dir="$TEST_ROOT/repair-process-$name"
  local repo_dir="$case_dir/repo"
  mkdir -p \
    "$repo_dir/scripts" \
    "$repo_dir/web/node_modules/next/dist/client" \
    "$case_dir/bin" \
    "$case_dir/home" \
    "$case_dir/workspace"
  cp "$REPAIR" "$repo_dir/scripts/repair.sh"
  cp "$PRIVILEGE_SQL" "$repo_dir/scripts/reconcile-forge-app-privileges.sql"
  printf '{}\n' > "$repo_dir/web/package.json"
  for required_file in \
    flight-data-helpers.js \
    use-merged-ref.js \
    normalize-trailing-slash.js \
    app-next-turbopack.js \
    navigation-build-id.js
  do
    : > "$repo_dir/web/node_modules/next/dist/client/$required_file"
  done
  if [ "$database_url" = '__UNSET__' ]; then
    : > "$case_dir/forge.env"
  else
    printf 'DATABASE_URL=%s\n' "$database_url" > "$case_dir/forge.env"
  fi
  printf 'untouched\n' > "$case_dir/sentinel"
  : > "$case_dir/psql-calls"
  : > "$case_dir/reconciler-calls"
  : > "$case_dir/npm-calls"
  cat > "$case_dir/bin/psql" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$FORGE_REPAIR_TEST_PSQL_CALLS"
printf 'touched\n' > "$FORGE_REPAIR_TEST_SENTINEL"
previous=''
for argument in "$@"; do
  if [ "$previous" = '--file' ]; then
    case "$argument" in
      */reconcile-forge-app-privileges.sql)
        printf 'reconcile\n' >> "$FORGE_REPAIR_TEST_RECONCILER_CALLS"
        ;;
    esac
  fi
  previous="$argument"
done
exit 0
EOF
  cat > "$case_dir/bin/npm" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$FORGE_REPAIR_TEST_NPM_CALLS"
exit 0
EOF
  cat > "$case_dir/bin/pgrep" <<'EOF'
#!/usr/bin/env bash
exit 1
EOF
  chmod +x "$case_dir/bin/psql" "$case_dir/bin/npm" "$case_dir/bin/pgrep"

  set +e
  env -u DATABASE_URL \
    PATH="$case_dir/bin:$PATH" \
    HOME="$case_dir/home" \
    FORGE_WORKSPACE_ROOT="$case_dir/workspace" \
    FORGE_ENV_FILE="$case_dir/forge.env" \
    FORGE_REPAIR_TEST_DATABASE_NAME='must_not_leak_into_normal_routing' \
    FORGE_REPAIR_TEST_PSQL_CALLS="$case_dir/psql-calls" \
    FORGE_REPAIR_TEST_RECONCILER_CALLS="$case_dir/reconciler-calls" \
    FORGE_REPAIR_TEST_NPM_CALLS="$case_dir/npm-calls" \
    FORGE_REPAIR_TEST_SENTINEL="$case_dir/sentinel" \
    /bin/bash "$repo_dir/scripts/repair.sh" --skip-install --skip-doctor "$@" \
    > "$case_dir/stdout" 2> "$case_dir/stderr"
  CASE_STATUS=$?
  set -e
  CASE_DIR="$case_dir"
}

managed_repair_url="postgresql://forge:${TEST_SECRET}@localhost:5432/forge"

run_repair_process_case dry-run "$managed_repair_url" --dry-run
[ "$CASE_STATUS" -eq 0 ] || fail 'full-process repair dry-run should succeed'
assert_contains 'Would reconcile local forge app privileges in database forge.' "$CASE_DIR/stdout"
[ ! -s "$CASE_DIR/psql-calls" ] || fail 'repair dry-run must not invoke psql'
[ "$(<"$CASE_DIR/sentinel")" = untouched ] || fail 'repair dry-run touched the database sentinel'

run_repair_process_case remote "postgresql://forge:${TEST_SECRET}@remote.invalid:5432/forge"
[ "$CASE_STATUS" -eq 0 ] || fail 'full-process remote repair should succeed with fake migration runner'
assert_contains 'Skipping local forge privilege reconciliation for a custom DATABASE_URL.' "$CASE_DIR/stdout"
[ ! -s "$CASE_DIR/psql-calls" ] || fail 'remote DATABASE_URL must not invoke local psql'
[ "$(<"$CASE_DIR/sentinel")" = untouched ] || fail 'remote DATABASE_URL touched the local database sentinel'

run_repair_process_case no-database-url __UNSET__
[ "$CASE_STATUS" -eq 0 ] || fail 'full-process repair without DATABASE_URL should succeed'
assert_contains 'Skipping local forge privilege reconciliation because DATABASE_URL is not set.' "$CASE_DIR/stdout"
[ ! -s "$CASE_DIR/psql-calls" ] || fail 'absent DATABASE_URL must not invoke local psql'
[ "$(<"$CASE_DIR/sentinel")" = untouched ] || fail 'absent DATABASE_URL touched the local database sentinel'

run_repair_process_case managed "$managed_repair_url"
[ "$CASE_STATUS" -eq 0 ] || fail 'full-process managed local repair should succeed'
[ "$(wc -l < "$CASE_DIR/reconciler-calls" | tr -d '[:space:]')" = 1 ] \
  || fail 'managed local repair must invoke the shared reconciler exactly once'
assert_contains '-d postgres -d forge --set ON_ERROR_STOP=1 --file' "$CASE_DIR/psql-calls"
assert_not_contains 'must_not_leak_into_normal_routing' "$CASE_DIR/psql-calls"

run_repair_process_case skip-migrate "$managed_repair_url" --skip-migrate
[ "$CASE_STATUS" -eq 0 ] || fail 'full-process --skip-migrate repair should succeed'
[ ! -s "$CASE_DIR/psql-calls" ] || fail '--skip-migrate must not invoke psql reconciliation'
[ "$(<"$CASE_DIR/sentinel")" = untouched ] || fail '--skip-migrate touched the database sentinel'

repair_hook_case="$TEST_ROOT/repair-hook"
mkdir -p "$repair_hook_case/bin"
cp "$TEST_ROOT/repair-process-managed/bin/psql" "$repair_hook_case/bin/psql"
: > "$repair_hook_case/psql-calls"
: > "$repair_hook_case/reconciler-calls"
printf 'untouched\n' > "$repair_hook_case/sentinel"
set +e
PATH="$repair_hook_case/bin:$PATH" \
  FORGE_REPAIR_TEST_HOOK=reconcile-forge-privileges \
  FORGE_REPAIR_TEST_PSQL_CALLS="$repair_hook_case/psql-calls" \
  FORGE_REPAIR_TEST_RECONCILER_CALLS="$repair_hook_case/reconciler-calls" \
  FORGE_REPAIR_TEST_SENTINEL="$repair_hook_case/sentinel" \
  /bin/bash "$REPAIR" --dry-run > "$repair_hook_case/missing-target-stdout" 2> "$repair_hook_case/missing-target-stderr"
missing_hook_target_status=$?
set -e
[ "$missing_hook_target_status" -ne 0 ] || fail 'repair test hook must require an explicit target'
assert_contains 'FORGE_REPAIR_TEST_DATABASE_NAME is required' "$repair_hook_case/missing-target-stderr"
[ ! -s "$repair_hook_case/psql-calls" ] || fail 'targetless repair test hook must not invoke psql'

PATH="$repair_hook_case/bin:$PATH" \
  FORGE_REPAIR_TEST_HOOK=reconcile-forge-privileges \
  FORGE_REPAIR_TEST_DATABASE_NAME=explicit_disposable_target \
  FORGE_REPAIR_TEST_PSQL_CALLS="$repair_hook_case/psql-calls" \
  FORGE_REPAIR_TEST_RECONCILER_CALLS="$repair_hook_case/reconciler-calls" \
  FORGE_REPAIR_TEST_SENTINEL="$repair_hook_case/sentinel" \
  /bin/bash "$REPAIR" --dry-run > "$repair_hook_case/dry-run-stdout" 2> "$repair_hook_case/dry-run-stderr"
assert_contains 'Would reconcile local forge app privileges in database explicit_disposable_target.' "$repair_hook_case/dry-run-stdout"
[ ! -s "$repair_hook_case/psql-calls" ] || fail 'dry-run repair test hook must not invoke psql'
[ "$(<"$repair_hook_case/sentinel")" = untouched ] || fail 'dry-run repair test hook touched the database sentinel'

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

expected_stages=(release migrate-0025 s3 migrate-0026 legacy-repair s4 migrate-0027 s5 latest)

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

run_managed_case legacy-repair-failure current 0 legacy-repair
[ "$CASE_STATUS" -ne 0 ] || fail 'legacy repair failure must fail the orchestration'
assert_not_contains s4 "$CASE_DIR/stages"
assert_contains 'repairing the exact known legacy release catalog drift' "$CASE_DIR/stderr"

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
marker_dir="${FORGE_ENV_FILE%/*}"
if [ -n "${UNRELATED_SECRET_SENTINEL+x}" ]; then
  printf 'unrelated-secret-leaked\n' > "$marker_dir/runuser-result"
  exit 1
fi
compgen -e > "$marker_dir/runuser-environment-names"
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
  local command
  for command in dirname node npm npx bash sudo runuser; do
    printf '#!/bin/bash\nprintf shadow-used > "$FORGE_SHADOW_MARKER"\nexit 0\n' > "$case_dir/bin/$command"
  done
  chmod +x "$case_dir/bin"/*
  set +e
  INSTALLER="$INSTALLER" FORGE_SHADOW_MARKER="$case_dir/marker" FORGE_SHADOW_DIRECTORY="$case_dir/bin" PATH="$case_dir/bin:$PATH" /bin/bash -c '
    FORGE_INSTALL_LIBRARY=1 source "$INSTALLER"
    OS_NAME=Linux
    prepare_trusted_linux_migration_toolchain
    [ ":$MANAGED_LOCAL_PATH:" != *":$FORGE_SHADOW_DIRECTORY:"* ]
  ' > "$case_dir/stdout" 2> "$case_dir/stderr"
  local shadow_status=$?
  set -e
  if [ "$shadow_status" -eq 0 ]; then
    assert_not_contains "$case_dir/bin" "$case_dir/stdout"
  fi
  [ ! -e "$case_dir/marker" ] || fail 'caller PATH shadow reached the privileged sudo resolver'
}

run_shadow_refusal_case

run_library_argument_case() {
  local case_dir="$TEST_ROOT/library-arguments"
  mkdir -p "$case_dir"
  INSTALLER="$INSTALLER" /bin/bash -c '
    set -- postgresql://argument-must-not-reach-installer
    FORGE_INSTALL_LIBRARY=1 source "$INSTALLER"
    [ "$#" -eq 1 ]
    (
      set --
      FORGE_INSTALL_LIBRARY=1 source "$INSTALLER"
      [ "$#" -eq 0 ]
      declare -F run_managed_local_migration_sequence >/dev/null
    )
  ' > "$case_dir/stdout" 2> "$case_dir/stderr" || fail 'library source did not ignore caller positional arguments'
}

run_library_argument_case

run_trusted_candidate_toc_tou_case() {
  local case_dir="$TEST_ROOT/trusted-candidate-toc-tou"
  mkdir -p "$case_dir"
  : > "$case_dir/target-one"
  : > "$case_dir/target-two"
  chmod +x "$case_dir/target-one" "$case_dir/target-two"
  ln -s "$case_dir/target-one" "$case_dir/candidate"
  INSTALLER="$INSTALLER" \
    FORGE_TOC_TOU_CANDIDATE="$case_dir/candidate" \
    FORGE_TOC_TOU_TARGET_ONE="$case_dir/target-one" \
    FORGE_TOC_TOU_TARGET_TWO="$case_dir/target-two" \
    FORGE_TOC_TOU_COUNT="$case_dir/canonicalizer-count" \
    /bin/bash -c '
      FORGE_INSTALL_LIBRARY=1 source "$INSTALLER"
      trusted_linux_path_chain() { return 0; }
      canonicalize_trusted_linux_candidate() {
        printf x >> "$FORGE_TOC_TOU_COUNT"
        if [ "$(<"$FORGE_TOC_TOU_COUNT")" = x ]; then
          printf "%s\\n" "$FORGE_TOC_TOU_TARGET_ONE"
        else
          printf "%s\\n" "$FORGE_TOC_TOU_TARGET_TWO"
        fi
      }
      resolved="$(trusted_linux_candidate "$FORGE_TOC_TOU_CANDIDATE")"
      [ "$resolved" = "$FORGE_TOC_TOU_TARGET_ONE" ]
      [ "$(<"$FORGE_TOC_TOU_COUNT")" = x ]
      trusted_linux_path_chain() {
        [ "$1" = "$FORGE_TOC_TOU_CANDIDATE" ] && [ -L "$1" ] && return 1
        return 0
      }
      rm -f "$FORGE_TOC_TOU_COUNT"
      ! trusted_linux_candidate "$FORGE_TOC_TOU_CANDIDATE"
      [ ! -e "$FORGE_TOC_TOU_COUNT" ]
    ' > "$case_dir/stdout" 2> "$case_dir/stderr" || fail 'trusted candidate canonicalization was not single-resolution and fail-closed'
}

run_trusted_candidate_toc_tou_case

if rg -F "$TEST_SECRET" "$TEST_ROOT" --glob '!forge.env' >/dev/null; then
  fail 'test sentinel leaked outside the local environment fixture'
fi

printf 'PASS: managed local migration orchestration coverage\n'
