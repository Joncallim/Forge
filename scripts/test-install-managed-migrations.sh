#!/usr/bin/env bash
# Focused executable coverage for managed-local migration orchestration.
set -Eeuo pipefail

SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALLER="$SCRIPT_DIR/install.sh"
REPAIR="$SCRIPT_DIR/repair.sh"
PRIVILEGE_SQL="$SCRIPT_DIR/reconcile-forge-app-privileges.sql"
LEGACY_REPAIR_PROOF="$SCRIPT_DIR/../web/scripts/ci/prove-installer-legacy-migration-repair.sh"
S5_MIGRATION_WRAPPER="$SCRIPT_DIR/../web/scripts/ci/apply-epic-172-s5-recovery-migration.sh"
REGISTRY_MIGRATION_WRAPPER="$SCRIPT_DIR/../web/scripts/ci/apply-verification-goal-registry-migration.sh"
PROTECTED_OWNER_BOOTSTRAP="$SCRIPT_DIR/../web/scripts/bootstrap-epic-172-s5-recovery-owner.ts"
MIGRATE_THROUGH_0028="$SCRIPT_DIR/../web/scripts/ci/migrate-through-0028.ts"
MIGRATE_THROUGH_0033="$SCRIPT_DIR/../web/scripts/ci/migrate-through-0033.ts"
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
psql_admin_function="$TEST_ROOT/psql-admin"
sed -n '/^psql_admin() {/,/^}/p' "$INSTALLER" > "$psql_admin_function"
assert_contains "trap 'on_error" "$INSTALLER"
assert_contains '--set ON_ERROR_STOP=1' "$grant_function"
assert_contains 'trap - ERR' "$grant_function"
assert_contains '--file "$FORGE_PRIVILEGE_SQL"' "$grant_function"
assert_contains "Re-run 'forge upgrade'" "$grant_function"
assert_not_contains "Re-run 'forge repair'" "$grant_function"
assert_contains 'resolve_managed_local_admin' "$psql_admin_function"
assert_contains '"${MANAGED_LOCAL_PSQL_ADMIN[@]}" "$@"' "$psql_admin_function"
assert_not_contains 'psql -d postgres' "$psql_admin_function"
assert_not_contains 'sudo -u postgres psql' "$psql_admin_function"
assert_contains '--file "$FORGE_PRIVILEGE_SQL"' "$REPAIR"
assert_contains "Re-run 'forge repair'" "$REPAIR"
assert_contains 'Would reconcile local forge app privileges in database' "$REPAIR"
assert_contains 'native_forge_database_password()' "$INSTALLER"
assert_contains 'native_forge_database_password()' "$REPAIR"
assert_contains 'MANAGED_LOCAL_ADMIN_RESOLUTION=unresolved' "$INSTALLER"
assert_contains 'MANAGED_LOCAL_PSQL_ADMIN=(' "$INSTALLER"
assert_contains '"$psql_bin" -X -h "$socket_dir" -p "$port" -U "$current_user" -d postgres' "$INSTALLER"
assert_contains 'clear_postgres_routing_environment' "$INSTALLER"
assert_contains 'PGHOST|PGPORT|PGUSER' "$INSTALLER"
assert_contains 'installed_service_mode_is_native()' "$REPAIR"
assert_contains 'REPAIR_PSQL_ADMIN_RESOLUTION=unresolved' "$REPAIR"
assert_contains '-u PGHOST -u PGHOSTADDR -u PGPORT -u PGDATABASE -u PGUSER' "$REPAIR"
assert_contains 'WHERE rolname = CURRENT_USER AND rolsuper' "$REPAIR"
assert_not_contains 'command -v psql' "$REPAIR"
assert_not_contains 'command -v sudo' "$REPAIR"
assert_not_contains 'command -v runuser' "$REPAIR"
assert_contains 'repair_trusted_linux_path_chain' "$REPAIR"
assert_contains 'repair_trusted_darwin_psql' "$REPAIR"
assert_contains 'repair_library_test_route_enabled' "$REPAIR"
assert_not_contains 'FORGE_REPAIR_TEST_HOOK' "$REPAIR"
assert_not_contains 'FORGE_REPAIR_PRODUCTION_NATIVE_ROUTE' "$REPAIR"
assert_not_contains 'postgresql://forge:*@localhost:5432/forge|postgres://forge:*@localhost:5432/forge' "$INSTALLER"
assert_not_contains 'postgresql://forge:*@localhost:5432/forge|postgres://forge:*@localhost:5432/forge' "$REPAIR"
assert_contains 'new TextDecoder("utf-8", { fatal: true })' "$INSTALLER"
assert_contains 'new TextDecoder("utf-8", { fatal: true })' "$REPAIR"
assert_contains 'readFileSync(0)' "$INSTALLER"
assert_contains 'readFileSync(0)' "$REPAIR"
installer_main="$TEST_ROOT/installer-main"
sed -n '/^bold "Forge installer"/,$p' "$INSTALLER" > "$installer_main"
installer_main_text="$(tr '\n' ' ' < "$installer_main")"
case "$installer_main_text" in
  *'resolve_service_mode'*'print_preflight_summary'*'if [ "$CHECK_ONLY" = "1" ]'*'acquire_install_lock'*'start_attest_and_commit_service_mode'*) ;;
  *) fail 'service mode must resolve before check and transition only under the install lock' ;;
esac
assert_not_contains 'record_current_manifest_value' "$installer_main"
service_transition_function="$TEST_ROOT/service-transition"
sed -n '/^start_attest_and_commit_service_mode() {/,/^}/p' "$INSTALLER" > "$service_transition_function"
service_transition_text="$(tr '\n' ' ' < "$service_transition_function")"
case "$service_transition_text" in
  *'start_docker_services'*'commit_service_mode'*'install_native_services'*'start_native_services'*'provision_database'*'commit_service_mode'*) ;;
  *) fail 'service mode must commit only after the selected controlled attestation boundary' ;;
esac
assert_contains 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO forge;' "$PRIVILEGE_SQL"
assert_contains 'GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO forge;' "$PRIVILEGE_SQL"
assert_contains 'public.verification_goal_registry_revisions,' "$PRIVILEGE_SQL"
assert_contains 'public.verification_goal_registry_entries,' "$PRIVILEGE_SQL"
assert_contains 'public.verification_goal_registry_heads' "$PRIVILEGE_SQL"
assert_contains "RAISE EXCEPTION 'forge verification goal registry privileges are outside the exact append-only matrix'" "$PRIVILEGE_SQL"
assert_contains "RAISE EXCEPTION 'verification goal registry commit routine owner or execute boundary is invalid'" "$PRIVILEGE_SQL"
assert_contains "RAISE EXCEPTION 'protected owner roles are outside the exact safe boundary'" "$PRIVILEGE_SQL"
assert_contains "RAISE EXCEPTION 'protected owner roles changed during reconciliation'" "$PRIVILEGE_SQL"
assert_contains 'role_row.rolpassword IS NULL' "$PRIVILEGE_SQL"
assert_contains "membership.member IN (" "$PRIVILEGE_SQL"
assert_contains "routine.proconfig = ARRAY['search_path=pg_catalog']" "$PRIVILEGE_SQL"
assert_contains 'GRANT EXECUTE ON FUNCTION public.forge_commit_verification_goal_registry_revision_v1(' "$PRIVILEGE_SQL"
registry_current_read_scope_count="$(grep -c "scope: 'current-read-only'" \
  "$SCRIPT_DIR/../web/scripts/repair-epic-172-legacy-release.ts")"
[ "$registry_current_read_scope_count" = 3 ] \
  || fail 'legacy repair must classify the three registry tables in the current-only read scope'
assert_contains 'const currentReadOnlyProtectedTables = protectedInstallerRelations' \
  "$SCRIPT_DIR/../web/scripts/repair-epic-172-legacy-release.ts"
assert_contains '...currentReadOnlyProtectedTables,' \
  "$SCRIPT_DIR/../web/scripts/repair-epic-172-legacy-release.ts"
assert_contains 'if (protectedDirectReadTables.has(relation.name))' \
  "$SCRIPT_DIR/../web/scripts/repair-epic-172-legacy-release.ts"
assert_contains 'snapshot managed-latest-once' "$LEGACY_REPAIR_PROOF"
assert_contains 'snapshot managed-latest-twice' "$LEGACY_REPAIR_PROOF"
assert_contains "assert_unchanged managed-latest-once managed-latest-twice 'Managed latest rerun'" \
  "$LEGACY_REPAIR_PROOF"
assert_contains 'assert_protected_forge_acl_count 5' "$LEGACY_REPAIR_PROOF"
assert_contains "direct_read_tables constant text[] := ARRAY[" "$LEGACY_REPAIR_PROOF"
for direct_read_table in \
  work_package_local_projection_sources \
  work_package_local_projection_heads \
  verification_goal_registry_revisions \
  verification_goal_registry_entries \
  verification_goal_registry_heads; do
  assert_contains "'$direct_read_table'" "$LEGACY_REPAIR_PROOF"
done
assert_contains 'relation.relname <> ALL(direct_read_tables)' "$LEGACY_REPAIR_PROOF"
assert_contains 'FOREACH direct_read_table IN ARRAY direct_read_tables' "$LEGACY_REPAIR_PROOF"
assert_not_contains "relation.relname NOT IN ('work_package_local_projection_sources', 'work_package_local_projection_heads')" "$LEGACY_REPAIR_PROOF"
assert_contains 'npx tsx scripts/ci/migrate-through-0028.ts' "$S5_MIGRATION_WRAPPER"
assert_not_contains 'npm run db:migrate' "$S5_MIGRATION_WRAPPER"
assert_contains 'FORGE_REGISTRY_FORCE_HANDOFF_FAILURE' "$REGISTRY_MIGRATION_WRAPPER"
assert_contains 'npx tsx scripts/ci/migrate-through-0033.ts' "$REGISTRY_MIGRATION_WRAPPER"
assert_contains "const PREDECESSOR_MIGRATION = '0027_epic_172_s4_packet_context'" "$MIGRATE_THROUGH_0028"
assert_contains "const TARGET_MIGRATION = '0028_epic_172_s5_recovery_actions'" "$MIGRATE_THROUGH_0028"
assert_contains "const PREDECESSOR_MIGRATION = '0032_verification_goal_snapshots'" "$MIGRATE_THROUGH_0033"
assert_contains "const TARGET_MIGRATION = '0033_verification_goal_registry_revisions'" "$MIGRATE_THROUGH_0033"
assert_contains 'routine.oid = any(array[${BEGIN}::regprocedure, ${FINALIZE}::regprocedure])' "$PROTECTED_OWNER_BOOTSTRAP"
assert_contains "revoke create on schema public, forge from forge_s4_routines_owner" "$PROTECTED_OWNER_BOOTSTRAP"
assert_contains "grant usage on schema forge to forge_s4_routines_owner" "$PROTECTED_OWNER_BOOTSTRAP"
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
  *'BEGIN;'*'LOCK TABLE pg_catalog.pg_authid IN SHARE ROW EXCLUSIVE MODE;'*'LOCK TABLE pg_catalog.pg_auth_members IN SHARE ROW EXCLUSIVE MODE;'*'fixed protected owner inventory is incomplete or has ownership drift'*'ALTER ROLE forge NOINHERIT;'*'FOR UPDATE OF relation;'*'FOR UPDATE OF attribute;'*'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO forge;'*'REVOKE ALL PRIVILEGES ON TABLE'*'GRANT SELECT ON TABLE'*'COMMIT;'*) ;;
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
[ "$(wc -l < "$sql_owner_map" | tr -d '[:space:]')" = 40 ] \
  || fail 'shared SQL must define the exact 40-table protected owner map'
cmp -s "$sql_owner_map" "$ts_owner_map" \
  || fail 'shared SQL and legacy normalizer protected owner maps drifted'

manifest_case="$TEST_ROOT/current-service-mode-manifest"
mkdir -p "$manifest_case/state"
printf 'unrelated=preserved\nservice_mode=stale\nanother=value\nservice_mode=older\n' \
  > "$manifest_case/state/install-manifest"
cp "$manifest_case/state/install-manifest" "$manifest_case/check-before"
set +e
FORGE_CHECK_ONLY=1 \
  FORGE_SERVICE_MODE=native \
  FORGE_OS_OVERRIDE=Darwin \
  FORGE_PACKAGE_MANAGER_OVERRIDE=brew \
  FORGE_INSTALL_STATE_DIR="$manifest_case/state" \
  FORGE_WORKSPACE_ROOT="$manifest_case/workspace" \
  FORGE_ENV_FILE="$manifest_case/forge.env" \
  /bin/bash "$INSTALLER" --check > "$manifest_case/check-stdout" 2> "$manifest_case/check-stderr"
set -e
cmp -s "$manifest_case/check-before" "$manifest_case/state/install-manifest" \
  || fail '--check changed the install manifest'

cp "$manifest_case/state/install-manifest" "$manifest_case/failure-before"
set +e
FORGE_INSTALL_LIBRARY=1 \
  FORGE_SERVICE_MODE=docker \
  FORGE_INSTALL_STATE_DIR="$manifest_case/state" \
  FORGE_WORKSPACE_ROOT="$manifest_case/workspace" \
  FORGE_ENV_FILE="$manifest_case/forge.env" \
  /bin/bash -c '
    source "$1"
    resolve_service_mode
    acquire_install_lock
    die "Induced failure before the service transition completed."
  ' _ "$INSTALLER" > "$manifest_case/failure-stdout" 2> "$manifest_case/failure-stderr"
transition_failure_status=$?
set -e
[ "$transition_failure_status" -ne 0 ] || fail 'induced pre-transition failure unexpectedly succeeded'
cmp -s "$manifest_case/failure-before" "$manifest_case/state/install-manifest" \
  || fail 'pre-transition failure changed the prior installed service mode'

run_service_mode_transition() {
  FORGE_INSTALL_LIBRARY=1 \
    FORGE_SERVICE_MODE="$1" \
    FORGE_INSTALL_STATE_DIR="$manifest_case/state" \
    FORGE_WORKSPACE_ROOT="$manifest_case/workspace" \
    FORGE_ENV_FILE="$manifest_case/forge.env" \
    /bin/bash -c '
      source "$1"
      resolve_service_mode
      acquire_install_lock
      commit_service_mode
    ' _ "$INSTALLER" > "$manifest_case/$1-stdout" 2> "$manifest_case/$1-stderr"
}
run_service_mode_transition native

ready_file="$manifest_case/lock-ready"
gate_file="$manifest_case/lock-gate"
FORGE_INSTALL_LIBRARY=1 \
  FORGE_INSTALL_TEST_LOCK_READY="$ready_file" \
  FORGE_INSTALL_TEST_LOCK_GATE="$gate_file" \
  FORGE_SERVICE_MODE=docker \
  FORGE_INSTALL_STATE_DIR="$manifest_case/state" \
  FORGE_WORKSPACE_ROOT="$manifest_case/workspace" \
  FORGE_ENV_FILE="$manifest_case/forge.env" \
  /bin/bash -c '
    source "$1"
    resolve_service_mode
    acquire_install_lock
    : > "$FORGE_INSTALL_TEST_LOCK_READY"
    while [ ! -e "$FORGE_INSTALL_TEST_LOCK_GATE" ]; do sleep 0.05; done
    commit_service_mode
  ' _ "$INSTALLER" > "$manifest_case/concurrent-first-stdout" 2> "$manifest_case/concurrent-first-stderr" &
first_transition_pid=$!
for attempt in $(seq 1 100); do
  [ -e "$ready_file" ] && break
  [ "$attempt" -lt 100 ] || fail 'first service-mode transition did not acquire its lock'
  sleep 0.05
done
set +e
FORGE_INSTALL_LIBRARY=1 \
  FORGE_SERVICE_MODE=native \
  FORGE_INSTALL_STATE_DIR="$manifest_case/state" \
  FORGE_WORKSPACE_ROOT="$manifest_case/workspace" \
  FORGE_ENV_FILE="$manifest_case/forge.env" \
  /bin/bash -c '
    source "$1"
    resolve_service_mode
    acquire_install_lock
    commit_service_mode
  ' _ "$INSTALLER" > "$manifest_case/concurrent-second-stdout" 2> "$manifest_case/concurrent-second-stderr"
second_transition_status=$?
set -e
[ "$second_transition_status" -ne 0 ] || fail 'concurrent service-mode transition bypassed the install lock'
assert_contains 'service_mode=native' "$manifest_case/state/install-manifest"
: > "$gate_file"
wait "$first_transition_pid"
assert_contains 'service_mode=docker' "$manifest_case/state/install-manifest"
run_service_mode_transition native
[ "$(grep -c '^service_mode=' "$manifest_case/state/install-manifest")" = 1 ] \
  || fail 'service mode writer must keep exactly one current manifest value'
assert_contains 'service_mode=native' "$manifest_case/state/install-manifest"
assert_contains 'unrelated=preserved' "$manifest_case/state/install-manifest"
assert_contains 'another=value' "$manifest_case/state/install-manifest"

run_service_mode_transition docker
FORGE_INSTALL_LIBRARY=1 \
  FORGE_SERVICE_MODE=auto \
  FORGE_INSTALL_STATE_DIR="$manifest_case/state" \
  FORGE_WORKSPACE_ROOT="$manifest_case/workspace" \
  FORGE_ENV_FILE="$manifest_case/forge.env" \
  /bin/bash -c '
    source "$1"
    resolve_service_mode
    [ "$SERVICE_MODE" = docker ]
  ' _ "$INSTALLER"
assert_contains 'service_mode=docker' "$manifest_case/state/install-manifest"

cp "$manifest_case/state/install-manifest" "$manifest_case/unrelated-listener-before"
set +e
FORGE_INSTALL_LIBRARY=1 \
  FORGE_SERVICE_MODE=native \
  FORGE_INSTALL_STATE_DIR="$manifest_case/state" \
  FORGE_WORKSPACE_ROOT="$manifest_case/workspace" \
  FORGE_ENV_FILE="$manifest_case/forge.env" \
  /bin/bash -c '
    source "$1"
    resolve_service_mode
    acquire_install_lock
    install_native_services() { return 0; }
    start_native_services() { return 0; }
    provision_database() { return 73; }
    start_attest_and_commit_service_mode
  ' _ "$INSTALLER" > "$manifest_case/unrelated-listener-stdout" 2> "$manifest_case/unrelated-listener-stderr"
unrelated_listener_status=$?
set -e
[ "$unrelated_listener_status" -ne 0 ] \
  || fail 'failed native provisioning did not preserve its attestation failure'
cmp -s "$manifest_case/unrelated-listener-before" "$manifest_case/state/install-manifest" \
  || fail 'an unrelated ready PostgreSQL listener changed the recorded docker mode'

run_service_mode_transition native
[ "$(grep -c '^service_mode=' "$manifest_case/state/install-manifest")" = 1 ] \
  || fail 'explicit docker-to-native transition did not retain one terminal service mode'
assert_contains 'service_mode=native' "$manifest_case/state/install-manifest"

credential_case="$TEST_ROOT/native-url-credential"
mkdir -p "$credential_case/state"
for credential_surface in "$INSTALLER" "$REPAIR"; do
  if [ "$credential_surface" = "$INSTALLER" ]; then
    credential_library_variable=FORGE_INSTALL_LIBRARY
  else
    credential_library_variable=FORGE_REPAIR_LIBRARY
  fi
  env "$credential_library_variable=1" \
    FORGE_INSTALL_STATE_DIR="$credential_case/state" \
    FORGE_WORKSPACE_ROOT="$credential_case/workspace" \
    FORGE_ENV_FILE="$credential_case/forge.env" \
    /bin/bash -c '
      source "$1"
      [ "$(native_forge_database_password "postgresql://forge:p%40ss%3Aword!@localhost:5432/forge")" = "p@ss:word!" ]
      [ "$(native_forge_database_password "postgres://forge:p%2540literal@localhost:5432/forge")" = "p%40literal" ]
      [ "$(native_forge_database_password "postgresql://forge:caf%C3%A9%F0%9F%94%92@localhost:5432/forge")" = "café🔒" ]
      [ "$(native_forge_database_password "postgresql://forge:plain:literal!@localhost:5432/forge")" = "plain:literal!" ]
      for invalid in bad%2 bad%00value bad%1Fvalue bad%7Fvalue bad%FF bad%C0%80 bad%E2%28%A1 bad%E2%82 bad%ED%A0%80 bad%F4%90%80%80; do
        ! native_forge_database_password "postgresql://forge:${invalid}@localhost:5432/forge" >/dev/null
      done
      ! native_forge_database_password "postgresql://forge:raw@ambiguous@localhost:5432/forge" >/dev/null
      ! native_forge_database_password "postgresql://forge:p%40ss@remote.invalid:5432/forge" >/dev/null
      ! native_forge_database_password "postgresql://forge:p%40ss@localhost:5432/forge?sslmode=disable" >/dev/null
    ' _ "$credential_surface"
done
FORGE_INSTALL_LIBRARY=1 \
  FORGE_INSTALL_STATE_DIR="$credential_case/state" \
  FORGE_WORKSPACE_ROOT="$credential_case/workspace" \
  FORGE_ENV_FILE="$credential_case/forge.env" \
  /bin/bash -c '
    source "$1"
    [ "$(printf %s "backslash\\quote'\''" | database_password_utf8_hex)" = "6261636b736c6173685c71756f746527" ]
  ' _ "$INSTALLER"

hostile_path_case="$TEST_ROOT/repair-hostile-linux-path"
mkdir -p "$hostile_path_case/shadow" "$hostile_path_case/trusted" "$hostile_path_case/socket"
for tool in psql sudo runuser id; do
  cat > "$hostile_path_case/shadow/$tool" <<'EOF'
#!/usr/bin/env bash
printf 'shadow-executed:%s\n' "${0##*/}" >> "$FORGE_HOSTILE_PATH_MARKER"
exit 99
EOF
done
cat > "$hostile_path_case/trusted/psql" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$FORGE_HOSTILE_TRUSTED_CALLS"
printf '1\n'
exit 0
EOF
cat > "$hostile_path_case/trusted/id" <<'EOF'
#!/usr/bin/env bash
[ "${1:-}" = postgres ]
EOF
cat > "$hostile_path_case/trusted/sudo" <<'EOF'
#!/usr/bin/env bash
[ "${1:-}" = -n ] && [ "${2:-}" = -u ] && [ "${3:-}" = postgres ] || exit 96
shift 3
export FORGE_HOSTILE_ELEVATED=1
exec "$@"
EOF
cat > "$hostile_path_case/trusted/runuser" <<'EOF'
#!/usr/bin/env bash
exit 98
EOF
chmod 555 "$hostile_path_case/shadow/"* "$hostile_path_case/trusted/"*
: > "$hostile_path_case/shadow-marker"
: > "$hostile_path_case/trusted-calls"
PATH="$hostile_path_case/shadow:/usr/bin:/bin" \
  FORGE_REPAIR_LIBRARY=1 \
  FORGE_REPAIR_TEST_ROUTE=current \
  FORGE_REPAIR_TEST_OS_NAME=Linux \
  FORGE_REPAIR_TEST_PSQL_SOCKET="$hostile_path_case/socket" \
  FORGE_REPAIR_TEST_PSQL_PORT=5432 \
  FORGE_HOSTILE_PATH_MARKER="$hostile_path_case/shadow-marker" \
  FORGE_HOSTILE_TRUSTED_CALLS="$hostile_path_case/trusted-calls" \
  FORGE_HOSTILE_TRUSTED_DIR="$hostile_path_case/trusted" \
  /bin/bash -c '
    source "$1"
    repair_trusted_linux_tool() {
      case "$1" in
        psql|sudo|runuser|id) printf "%s/%s\n" "$FORGE_HOSTILE_TRUSTED_DIR" "$1" ;;
        *) return 1 ;;
      esac
    }
    resolve_repair_psql_admin
    case "${REPAIR_PSQL_ADMIN[*]}" in
      *"$FORGE_HOSTILE_TRUSTED_DIR/psql"*) ;;
      *) exit 95 ;;
    esac
    case "${REPAIR_PSQL_ADMIN[*]}" in
      *"$FORGE_HOSTILE_TRUSTED_DIR/sudo"*|*"$FORGE_HOSTILE_TRUSTED_DIR/runuser"*) exit 94 ;;
    esac
  ' _ "$REPAIR"
[ ! -s "$hostile_path_case/shadow-marker" ] \
  || fail 'repair Linux fallback executed a hostile PATH shadow'
[ "$(wc -l < "$hostile_path_case/trusted-calls" | tr -d '[:space:]')" = 1 ] \
  || fail 'repair Linux trusted psql should run once as the current user'

test_hook_boundary_case="$TEST_ROOT/test-hook-privilege-boundary"
mkdir -p "$test_hook_boundary_case/installer-writable" "$test_hook_boundary_case/repair-writable" \
  "$test_hook_boundary_case/elevators" "$test_hook_boundary_case/socket"
cat > "$test_hook_boundary_case/installer-writable/psql" <<'EOF'
#!/usr/bin/env bash
printf 'direct\n' >> "$FORGE_HOOK_DIRECT_CALLS"
/bin/mv "$FORGE_HOOK_REPLACEMENT" "$0"
printf '1\n'
exit 74
EOF
cat > "$test_hook_boundary_case/repair-writable/psql" <<'EOF'
#!/usr/bin/env bash
printf 'direct\n' >> "$FORGE_HOOK_DIRECT_CALLS"
/bin/mv "$FORGE_HOOK_REPLACEMENT" "$0"
printf '1\n'
exit 74
EOF
for replacement in installer repair; do
  cat > "$test_hook_boundary_case/$replacement-replacement" <<'EOF'
#!/usr/bin/env bash
printf 'replacement-executed\n' >> "$FORGE_HOOK_ELEVATED_MARKER"
printf '1\n'
exit 74
EOF
done
cat > "$test_hook_boundary_case/elevators/sudo" <<'EOF'
#!/usr/bin/env bash
printf 'sudo-invoked\n' >> "$FORGE_HOOK_ELEVATOR_MARKER"
exit 97
EOF
cat > "$test_hook_boundary_case/elevators/runuser" <<'EOF'
#!/usr/bin/env bash
printf 'runuser-invoked\n' >> "$FORGE_HOOK_ELEVATOR_MARKER"
exit 98
EOF
cat > "$test_hook_boundary_case/elevators/id" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod 555 "$test_hook_boundary_case/installer-writable/psql" \
  "$test_hook_boundary_case/repair-writable/psql" \
  "$test_hook_boundary_case/installer-replacement" \
  "$test_hook_boundary_case/repair-replacement" \
  "$test_hook_boundary_case/elevators/"*

for surface in installer repair; do
  : > "$test_hook_boundary_case/$surface-direct"
  : > "$test_hook_boundary_case/$surface-elevators"
  : > "$test_hook_boundary_case/$surface-elevated"
  if [ "$surface" = installer ]; then
    PATH="$test_hook_boundary_case/installer-writable:/usr/bin:/bin" \
      FORGE_INSTALL_LIBRARY=1 \
      FORGE_INSTALL_TEST_ADMIN_MODE=current \
      FORGE_INSTALL_TEST_PSQL_SOCKET="$test_hook_boundary_case/socket" \
      FORGE_INSTALL_TEST_PSQL_PORT=5432 \
      FORGE_INSTALL_STATE_DIR="$test_hook_boundary_case/installer-state" \
      FORGE_WORKSPACE_ROOT="$test_hook_boundary_case/installer-workspace" \
      FORGE_ENV_FILE="$test_hook_boundary_case/installer.env" \
      FORGE_HOOK_DIRECT_CALLS="$test_hook_boundary_case/installer-direct" \
      FORGE_HOOK_REPLACEMENT="$test_hook_boundary_case/installer-replacement" \
      FORGE_HOOK_ELEVATOR_MARKER="$test_hook_boundary_case/installer-elevators" \
      FORGE_HOOK_ELEVATED_MARKER="$test_hook_boundary_case/installer-elevated" \
      FORGE_HOOK_ELEVATOR_DIR="$test_hook_boundary_case/elevators" \
      /bin/bash -c '
        source "$1"
        trap - ERR
        OS_NAME=Linux
        managed_local_postgres_user_exists() { return 0; }
        trusted_linux_tool() {
          printf "%s\n" "$1" >> "$FORGE_HOOK_ELEVATOR_MARKER"
          printf "%s/%s\n" "$FORGE_HOOK_ELEVATOR_DIR" "$1"
        }
        ! resolve_managed_local_admin
      ' _ "$INSTALLER"
  else
    FORGE_REPAIR_LIBRARY=1 \
      FORGE_REPAIR_TEST_ROUTE=current \
      FORGE_REPAIR_TEST_OS_NAME=Linux \
      FORGE_REPAIR_TEST_PSQL_BIN="$test_hook_boundary_case/repair-writable/psql" \
      FORGE_REPAIR_TEST_PSQL_SOCKET="$test_hook_boundary_case/socket" \
      FORGE_REPAIR_TEST_PSQL_PORT=5432 \
      FORGE_HOOK_DIRECT_CALLS="$test_hook_boundary_case/repair-direct" \
      FORGE_HOOK_REPLACEMENT="$test_hook_boundary_case/repair-replacement" \
      FORGE_HOOK_ELEVATOR_MARKER="$test_hook_boundary_case/repair-elevators" \
      FORGE_HOOK_ELEVATED_MARKER="$test_hook_boundary_case/repair-elevated" \
      FORGE_HOOK_ELEVATOR_DIR="$test_hook_boundary_case/elevators" \
      /bin/bash -c '
        source "$1"
        repair_trusted_linux_tool() {
          printf "%s\n" "$1" >> "$FORGE_HOOK_ELEVATOR_MARKER"
          printf "%s/%s\n" "$FORGE_HOOK_ELEVATOR_DIR" "$1"
        }
        ! resolve_repair_psql_admin
      ' _ "$REPAIR"
  fi
  [ "$(wc -l < "$test_hook_boundary_case/$surface-direct" | tr -d '[:space:]')" = 1 ] \
    || fail "$surface test psql did not run exactly once as the current user"
  [ ! -s "$test_hook_boundary_case/$surface-elevators" ] \
    || fail "$surface test psql failure reached sudo, runuser, id, or trusted-tool resolution"
  [ ! -s "$test_hook_boundary_case/$surface-elevated" ] \
    || fail "$surface writable-parent replacement executed after the current-user probe"
done

cat > "$test_hook_boundary_case/trusted-psql" <<'EOF'
#!/usr/bin/env bash
printf 'direct\n' >> "$FORGE_HOOK_DIRECT_CALLS"
exit 74
EOF
chmod 555 "$test_hook_boundary_case/trusted-psql"
: > "$test_hook_boundary_case/repair-trusted-direct"
: > "$test_hook_boundary_case/repair-trusted-lookups"
FORGE_REPAIR_LIBRARY=1 \
  FORGE_REPAIR_TEST_ROUTE=current \
  FORGE_REPAIR_TEST_OS_NAME=Linux \
  FORGE_REPAIR_TEST_PSQL_SOCKET="$test_hook_boundary_case/socket" \
  FORGE_REPAIR_TEST_PSQL_PORT=5432 \
  FORGE_HOOK_DIRECT_CALLS="$test_hook_boundary_case/repair-trusted-direct" \
  FORGE_HOOK_ELEVATOR_MARKER="$test_hook_boundary_case/repair-trusted-lookups" \
  FORGE_HOOK_TRUSTED_PSQL="$test_hook_boundary_case/trusted-psql" \
  /bin/bash -c '
    source "$1"
    repair_trusted_linux_tool() {
      printf "%s\n" "$1" >> "$FORGE_HOOK_ELEVATOR_MARKER"
      [ "$1" = psql ] || exit 93
      printf "%s\n" "$FORGE_HOOK_TRUSTED_PSQL"
    }
    ! resolve_repair_psql_admin
  ' _ "$REPAIR"
[ "$(wc -l < "$test_hook_boundary_case/repair-trusted-direct" | tr -d '[:space:]')" = 1 ] \
  || fail 'repair test route without a custom psql did not run one current-user probe'
[ "$(<"$test_hook_boundary_case/repair-trusted-lookups")" = psql ] \
  || fail 'repair test route without a custom psql reached id, sudo, or runuser resolution'

provision_function="$TEST_ROOT/provision-database"
sed -n '/^provision_database() {/,/^}/p' "$INSTALLER" > "$provision_function"
assert_contains 'CREATE ROLE forge LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD' "$provision_function"
assert_contains 'ALTER ROLE forge LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD' "$provision_function"
assert_contains 'LOCK TABLE pg_catalog.pg_authid IN SHARE ROW EXCLUSIVE MODE;' "$provision_function"
assert_contains 'LOCK TABLE pg_catalog.pg_auth_members IN SHARE ROW EXCLUSIVE MODE;' "$provision_function"
assert_contains "pg_catalog.convert_from(pg_catalog.decode('\$db_password_hex', 'hex'), 'UTF8')" "$provision_function"
assert_not_contains 'sql_escape_literal' "$provision_function"
assert_not_contains "VALUES ('\$db_password" "$provision_function"
assert_contains "membership.roleid = 'forge'::pg_catalog.regrole" "$provision_function"
assert_contains 'Role forge has membership edges.' "$provision_function"
assert_contains 'Role forge is outside the safe or known legacy app-role boundary' "$provision_function"
provision_function_sql="$(tr '\n' ' ' < "$provision_function")"
case "$provision_function_sql" in
  *'LOCK TABLE pg_catalog.pg_authid IN SHARE ROW EXCLUSIVE MODE;'*'LOCK TABLE pg_catalog.pg_auth_members IN SHARE ROW EXCLUSIVE MODE;'*'IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles'*'pg_catalog.pg_auth_members'*'ALTER ROLE forge LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD'*'Role forge did not reach the exact safe native app-role boundary.'*'COMMIT;'*) ;;
  *) fail 'existing forge membership and role-shape refusal must precede role hardening' ;;
esac

psql_status_case="$TEST_ROOT/psql-status"
mkdir -p "$psql_status_case/bin"
cat > "$psql_status_case/bin/psql" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$FORGE_TEST_PSQL_CALLS"
case "$*" in
  *'WHERE rolname = CURRENT_USER AND rolsuper'*) printf '1\n'; exit "${FORGE_TEST_PROBE_EXIT:-0}" ;;
  *) exit 73 ;;
esac
EOF
chmod +x "$psql_status_case/bin/psql"
: > "$psql_status_case/calls"
set +e
PATH="$psql_status_case/bin:$PATH" \
  FORGE_TEST_PSQL_CALLS="$psql_status_case/calls" \
  FORGE_INSTALL_TEST_ADMIN_MODE=current \
  FORGE_INSTALL_TEST_PSQL_SOCKET="$psql_status_case" \
  FORGE_INSTALL_TEST_PSQL_PORT=5432 \
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

: > "$psql_status_case/nonzero-probe-calls"
set +e
PATH="$psql_status_case/bin:$PATH" \
  FORGE_TEST_PSQL_CALLS="$psql_status_case/nonzero-probe-calls" \
  FORGE_TEST_PROBE_EXIT=74 \
  FORGE_INSTALL_TEST_ADMIN_MODE=current \
  FORGE_INSTALL_TEST_PSQL_SOCKET="$psql_status_case" \
  FORGE_INSTALL_TEST_PSQL_PORT=5432 \
  FORGE_INSTALL_STATE_DIR="$psql_status_case/nonzero-state" \
  FORGE_WORKSPACE_ROOT="$psql_status_case/nonzero-workspace" \
  FORGE_ENV_FILE="$psql_status_case/nonzero.env" \
  bash -c '
    export FORGE_INSTALL_LIBRARY=1
    source "$1"
    if resolve_managed_local_admin; then
      printf "unexpected admin acceptance\n"
      exit 65
    fi
  ' _ "$INSTALLER" > "$psql_status_case/nonzero-stdout" 2> "$psql_status_case/nonzero-stderr"
nonzero_probe_status=$?
set -e
[ "$nonzero_probe_status" -eq 0 ] || fail 'installer must reject print-1/nonzero administrator probe cleanly'
[ "$(wc -l < "$psql_status_case/nonzero-probe-calls" | tr -d '[:space:]')" = 1 ] \
  || fail 'installer print-1/nonzero probe must stop before mutation'
assert_not_contains 'unexpected admin acceptance' "$psql_status_case/nonzero-stdout"

set +e
PATH="$psql_status_case/bin:$PATH" \
  FORGE_TEST_PSQL_CALLS="$psql_status_case/calls" \
  FORGE_INSTALL_TEST_ADMIN_MODE=current \
  FORGE_INSTALL_TEST_PSQL_SOCKET="$psql_status_case" \
  FORGE_INSTALL_TEST_PSQL_PORT=5432 \
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
  local name="$1" database_url="$2" manifest_fixture="$3"
  shift 3
  local repair_dry_run=0 repair_skip_migrate=0 option
  for option in "$@"; do
    case "$option" in
      --dry-run) repair_dry_run=1 ;;
      --skip-migrate) repair_skip_migrate=1 ;;
    esac
  done
  local case_dir="$TEST_ROOT/repair-process-$name"
  local repo_dir="$case_dir/repo"
  mkdir -p \
    "$repo_dir/scripts" \
    "$repo_dir/web/node_modules/next/dist/client" \
    "$case_dir/bin" \
    "$case_dir/home" \
    "$case_dir/workspace/runtime/install"
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
  case "$manifest_fixture" in
    native)
      printf 'service_mode=native\n' > "$case_dir/workspace/runtime/install/install-manifest"
      ;;
    docker)
      printf 'service_mode=docker\n' > "$case_dir/workspace/runtime/install/install-manifest"
      ;;
    missing)
      ;;
    malformed)
      printf 'service_mode\n' > "$case_dir/workspace/runtime/install/install-manifest"
      ;;
    native-then-docker)
      printf 'service_mode=native\nservice_mode=docker\n' > "$case_dir/workspace/runtime/install/install-manifest"
      ;;
    docker-then-native)
      printf 'service_mode=docker\nservice_mode=native\n' > "$case_dir/workspace/runtime/install/install-manifest"
      ;;
    *)
      fail "unknown repair manifest fixture: $manifest_fixture"
      ;;
  esac
  printf 'untouched\n' > "$case_dir/sentinel"
  : > "$case_dir/psql-calls"
  : > "$case_dir/reconciler-calls"
  : > "$case_dir/migration-stages"
  : > "$case_dir/npm-calls"
cat > "$case_dir/bin/psql" <<'EOF'
#!/usr/bin/env bash
for variable in PGHOST PGHOSTADDR PGPORT PGDATABASE PGUSER PGPASSWORD PGPASSFILE PGSERVICE PGSERVICEFILE PGOPTIONS; do
  if [ -n "${!variable+x}" ]; then
    printf 'ambient-%s-leaked\n' "$variable" >> "$FORGE_REPAIR_TEST_PSQL_CALLS"
    exit 97
  fi
done
printf '%s\n' "$*" >> "$FORGE_REPAIR_TEST_PSQL_CALLS"
printf 'touched\n' > "$FORGE_REPAIR_TEST_SENTINEL"
[ "$1" = '-X' ] && [ "$2" = '-h' ] && [ "$3" = "$FORGE_REPAIR_TEST_EXPECTED_SOCKET" ] \
  && [ "$4" = '-p' ] && [ "$5" = '5432' ] && [ "$6" = '-d' ] || exit 96
database_name="$7"
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
if [ "$database_name" = postgres ]; then
  case "$*" in
    *'WHERE rolname = CURRENT_USER AND rolsuper'*) printf '1\n'; exit "${FORGE_REPAIR_TEST_PROBE_EXIT:-0}" ;;
    *) exit 95 ;;
  esac
fi
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
  chmod 555 "$case_dir/bin/psql"
  chmod +x "$case_dir/bin/npm" "$case_dir/bin/pgrep"

  set +e
  env -u DATABASE_URL \
    PATH="$case_dir/bin:$PATH" \
    HOME="$case_dir/home" \
    FORGE_REPAIR_LIBRARY=1 \
    FORGE_REPAIR_TEST_ROUTE=current \
    FORGE_WORKSPACE_ROOT="$case_dir/workspace" \
    FORGE_ENV_FILE="$case_dir/forge.env" \
    FORGE_REPAIR_TEST_DATABASE_NAME='must_not_leak_into_library_routing' \
    FORGE_REPAIR_TEST_PSQL_CALLS="$case_dir/psql-calls" \
    FORGE_REPAIR_TEST_RECONCILER_CALLS="$case_dir/reconciler-calls" \
    FORGE_REPAIR_TEST_NPM_CALLS="$case_dir/npm-calls" \
    FORGE_REPAIR_TEST_SENTINEL="$case_dir/sentinel" \
    FORGE_REPAIR_TEST_EXPECTED_SOCKET="$REPAIR_EXPECTED_SOCKET" \
    FORGE_REPAIR_TEST_PROBE_EXIT="${REPAIR_CASE_PROBE_EXIT:-0}" \
    FORGE_REPAIR_TEST_PSQL_BIN="$case_dir/bin/psql" \
    FORGE_REPAIR_TEST_PSQL_SOCKET="$REPAIR_EXPECTED_SOCKET" \
    FORGE_REPAIR_TEST_PSQL_PORT=5432 \
    FORGE_REPAIR_CASE_DRY_RUN="$repair_dry_run" \
    FORGE_REPAIR_CASE_SKIP_MIGRATE="$repair_skip_migrate" \
    PGHOST=remote.invalid \
    PGHOSTADDR=203.0.113.7 \
    PGPORT=6543 \
    PGUSER=ambient_user \
    PGDATABASE=ambient_database \
    PGPASSWORD=ambient_password \
    PGPASSFILE="$case_dir/ambient.pgpass" \
    PGSERVICE=ambient_service \
    PGSERVICEFILE="$case_dir/ambient-service.conf" \
    PGOPTIONS='-c search_path=ambient' \
    /bin/bash -c '
      source "$1"
      WORKSPACE_ROOT="$FORGE_WORKSPACE_ROOT"
      ENV_FILE="$FORGE_ENV_FILE"
      DRY_RUN="$FORGE_REPAIR_CASE_DRY_RUN"
      SKIP_MIGRATE="$FORGE_REPAIR_CASE_SKIP_MIGRATE"
      export_env_file "$ENV_FILE"
      reconcile_local_forge_privileges_if_managed
    ' _ "$repo_dir/scripts/repair.sh" \
    > "$case_dir/stdout" 2> "$case_dir/stderr"
  CASE_STATUS=$?
  set -e
  CASE_DIR="$case_dir"
}

managed_repair_url="postgresql://forge:${TEST_SECRET}@localhost:5432/forge"
case "$(uname -s)" in
  Darwin) REPAIR_EXPECTED_SOCKET=/tmp ;;
  Linux) REPAIR_EXPECTED_SOCKET=/var/run/postgresql ;;
  *) fail 'unsupported repair process-test operating system' ;;
esac

run_repair_process_case dry-run "$managed_repair_url" native --dry-run
[ "$CASE_STATUS" -eq 0 ] || fail 'full-process repair dry-run should succeed'
assert_contains 'Would reconcile local forge app privileges in database forge.' "$CASE_DIR/stdout"
[ ! -s "$CASE_DIR/psql-calls" ] || fail 'repair dry-run must not invoke psql'
[ "$(<"$CASE_DIR/sentinel")" = untouched ] || fail 'repair dry-run touched the database sentinel'

invalid_routing_urls=(
  "postgresql://forge:pw@remote.invalid:5432/custom?application_name=@localhost:5432/forge"
  "postgresql://forge:${TEST_SECRET}@localhost.evil:5432/forge"
  "postgresql://forge:${TEST_SECRET}@remote.invalid:5432/forge"
  "postgresql://forge:${TEST_SECRET}@localhost:5432/custom"
  "postgresql://forge:${TEST_SECRET}@localhost:5432/forge?sslmode=disable"
  "postgresql://forge:${TEST_SECRET}@localhost:5432/forge#fragment"
  "postgresql://other:${TEST_SECRET}@localhost:5432/forge"
  "postgresql://forge:${TEST_SECRET}@localhost:6543/forge"
  "postgresql://forge:bad%2@localhost:5432/forge"
  "postgresql://forge:bad%00value@localhost:5432/forge"
  "postgresql://forge:bad%FF@localhost:5432/forge"
  "postgresql://forge:bad%C0%80@localhost:5432/forge"
  "postgresql://forge:bad%E2%28%A1@localhost:5432/forge"
  "postgresql://forge:bad%E2%82@localhost:5432/forge"
  "postgresql://forge:bad%ED%A0%80@localhost:5432/forge"
  "postgresql://forge:bad%F4%90%80%80@localhost:5432/forge"
  "postgresql://forge:@localhost:5432/forge"
  'not-a-database-url'
)
for invalid_index in "${!invalid_routing_urls[@]}"; do
  run_repair_process_case "nonlocal-$invalid_index" "${invalid_routing_urls[$invalid_index]}" native
  [ "$CASE_STATUS" -eq 0 ] || fail "full-process nonlocal repair case $invalid_index should succeed"
  assert_contains 'Skipping local forge privilege reconciliation for a custom DATABASE_URL.' "$CASE_DIR/stdout"
  [ ! -s "$CASE_DIR/psql-calls" ] || fail "nonlocal DATABASE_URL case $invalid_index invoked local psql"
  [ "$(<"$CASE_DIR/sentinel")" = untouched ] || fail "nonlocal DATABASE_URL case $invalid_index touched the local database sentinel"
done

run_repair_process_case no-database-url __UNSET__ native
[ "$CASE_STATUS" -eq 0 ] || fail 'full-process repair without DATABASE_URL should succeed'
assert_contains 'Skipping local forge privilege reconciliation because DATABASE_URL is not set.' "$CASE_DIR/stdout"
[ ! -s "$CASE_DIR/psql-calls" ] || fail 'absent DATABASE_URL must not invoke local psql'
[ "$(<"$CASE_DIR/sentinel")" = untouched ] || fail 'absent DATABASE_URL touched the local database sentinel'

run_repair_process_case managed "$managed_repair_url" native
[ "$CASE_STATUS" -eq 0 ] || fail 'full-process managed local repair should succeed'
[ "$(wc -l < "$CASE_DIR/reconciler-calls" | tr -d '[:space:]')" = 1 ] \
  || fail 'managed local repair must invoke the shared reconciler exactly once'
assert_not_contains 'must_not_leak_into_library_routing' "$CASE_DIR/psql-calls"
assert_contains "-X -h $REPAIR_EXPECTED_SOCKET -p 5432 -d postgres" "$CASE_DIR/psql-calls"
assert_contains "-X -h $REPAIR_EXPECTED_SOCKET -p 5432 -d forge" "$CASE_DIR/psql-calls"
assert_not_contains 'ambient-' "$CASE_DIR/psql-calls"

REPAIR_CASE_PROBE_EXIT=74
run_repair_process_case probe-print-one-nonzero "$managed_repair_url" native
unset REPAIR_CASE_PROBE_EXIT
[ "$CASE_STATUS" -eq 0 ] || fail 'repair print-1/nonzero administrator probe should remain non-fatal'
[ ! -s "$CASE_DIR/reconciler-calls" ] \
  || fail 'repair print-1/nonzero administrator probe must reject before mutation'
assert_contains 'Could not establish controlled native PostgreSQL administrator access' "$CASE_DIR/stderr"

run_repair_process_case managed-postgres 'postgres://forge:p%40ss%3Aword!@localhost:5432/forge' native
[ "$CASE_STATUS" -eq 0 ] || fail 'full-process postgres native repair should succeed'
[ "$(wc -l < "$CASE_DIR/reconciler-calls" | tr -d '[:space:]')" = 1 ] \
  || fail 'postgres native repair must invoke the shared reconciler exactly once'

for manifest_fixture in docker missing malformed native-then-docker; do
  run_repair_process_case "manifest-$manifest_fixture" "$managed_repair_url" "$manifest_fixture"
  [ "$CASE_STATUS" -eq 0 ] || fail "repair manifest case $manifest_fixture should succeed"
  assert_contains 'install manifest does not end in service_mode=native' "$CASE_DIR/stdout"
  [ ! -s "$CASE_DIR/psql-calls" ] || fail "repair manifest case $manifest_fixture invoked psql"
  [ "$(<"$CASE_DIR/sentinel")" = untouched ] || fail "repair manifest case $manifest_fixture touched the database sentinel"
done

run_repair_process_case manifest-last-native "$managed_repair_url" docker-then-native
[ "$CASE_STATUS" -eq 0 ] || fail 'last native manifest entry should enable local reconciliation'
[ "$(wc -l < "$CASE_DIR/reconciler-calls" | tr -d '[:space:]')" = 1 ] \
  || fail 'last native manifest entry must invoke the shared reconciler exactly once'

run_repair_process_case skip-migrate "$managed_repair_url" native --skip-migrate
[ "$CASE_STATUS" -eq 0 ] || fail 'full-process --skip-migrate repair should succeed'
[ ! -s "$CASE_DIR/psql-calls" ] || fail '--skip-migrate must not invoke psql reconciliation'
[ "$(<"$CASE_DIR/sentinel")" = untouched ] || fail '--skip-migrate touched the database sentinel'

for bypass_case in manifest-docker nonlocal-2; do
  bypass_root="$TEST_ROOT/repair-process-$bypass_case"
  : > "$bypass_root/psql-calls"
  printf 'untouched\n' > "$bypass_root/sentinel"
  env -u DATABASE_URL \
    PATH="$bypass_root/bin:$PATH" \
    HOME="$bypass_root/home" \
    FORGE_WORKSPACE_ROOT="$bypass_root/workspace" \
    FORGE_ENV_FILE="$bypass_root/forge.env" \
    FORGE_REPAIR_LIBRARY=1 \
    FORGE_REPAIR_TEST_ROUTE=current \
    FORGE_REPAIR_TEST_PSQL_BIN="$bypass_root/bin/psql" \
    FORGE_REPAIR_TEST_PSQL_SOCKET="$REPAIR_EXPECTED_SOCKET" \
    FORGE_REPAIR_TEST_PSQL_PORT=5432 \
    FORGE_REPAIR_TEST_DATABASE_NAME=forged_bypass_target \
    FORGE_REPAIR_TEST_PSQL_CALLS="$bypass_root/psql-calls" \
    FORGE_REPAIR_TEST_RECONCILER_CALLS="$bypass_root/reconciler-calls" \
    FORGE_REPAIR_TEST_NPM_CALLS="$bypass_root/npm-calls" \
    FORGE_REPAIR_TEST_SENTINEL="$bypass_root/sentinel" \
    FORGE_REPAIR_TEST_EXPECTED_SOCKET="$REPAIR_EXPECTED_SOCKET" \
    /bin/bash "$bypass_root/repo/scripts/repair.sh" --skip-install --skip-doctor \
      > "$bypass_root/executable-stdout" 2> "$bypass_root/executable-stderr"
  [ ! -s "$bypass_root/psql-calls" ] \
    || fail "normal executable repair let test routing bypass $bypass_case gates"
  [ "$(<"$bypass_root/sentinel")" = untouched ] \
    || fail "normal executable repair test routing mutated $bypass_case"
done

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

expected_stages=(release migrate-0025 s3 migrate-0026 legacy-repair s4 migrate-0027 s5 registry latest)

run_managed_case current current
[ "$CASE_STATUS" -eq 0 ] || fail 'current-user managed migration should succeed'
assert_contains 'admin:current' "$CASE_DIR/stages"
assert_stages "$CASE_DIR/stages" "${expected_stages[@]}"

for forbidden_test_mode in sudo runuser; do
  run_managed_case "forbidden-$forbidden_test_mode" "$forbidden_test_mode"
  [ "$CASE_STATUS" -ne 0 ] || fail "$forbidden_test_mode test administration mode was not rejected"
  assert_contains 'supports only current-user administration' "$CASE_DIR/stderr"
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

run_managed_case registry-failure current 0 registry
[ "$CASE_STATUS" -ne 0 ] || fail 'registry migration failure must fail the orchestration'
assert_contains 'registry-cleanup-attempted' "$CASE_DIR/stages"
assert_not_contains 'latest' "$CASE_DIR/stages"
assert_contains 'verification-goal registry; its cleanup wrapper preserves the original migration failure' "$CASE_DIR/stderr"

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

for invalid_index in "${!invalid_routing_urls[@]}"; do
  run_enabled_case "installer-nonlocal-$invalid_index" native "${invalid_routing_urls[$invalid_index]}"
  assert_contains 'managed-local-migrations-bypassed' "$CASE_DIR/stdout"
done
run_enabled_case installer-valid-postgresql native "$managed_repair_url"
assert_contains 'managed-local-migrations-enabled' "$CASE_DIR/stdout"
run_enabled_case installer-valid-postgres native 'postgres://forge:p%40ss%3Aword!@localhost:5432/forge'
assert_contains 'managed-local-migrations-enabled' "$CASE_DIR/stdout"
run_enabled_case docker docker "postgresql://forge:${TEST_SECRET}@localhost:5432/forge"
assert_contains 'managed-local-migrations-bypassed' "$CASE_DIR/stdout"

run_installer_privilege_routing_case() {
  local name="$1" database_url="$2" service_mode="${3:-native}"
  local case_dir="$TEST_ROOT/installer-routing-$name"
  mkdir -p "$case_dir/bin" "$case_dir/socket" "$case_dir/state" "$case_dir/workspace"
  printf 'DATABASE_URL=%s\n' "$database_url" > "$case_dir/forge.env"
  printf 'untouched\n' > "$case_dir/sentinel"
  : > "$case_dir/psql-calls"
  : > "$case_dir/reconciler-calls"
cat > "$case_dir/bin/psql" <<'EOF'
#!/usr/bin/env bash
for variable in PGHOST PGHOSTADDR PGPORT PGDATABASE PGUSER PGPASSWORD PGPASSFILE PGSERVICE PGSERVICEFILE PGOPTIONS; do
  if [ -n "${!variable+x}" ]; then
    printf 'ambient-%s-leaked\n' "$variable" >> "$FORGE_INSTALL_ROUTING_PSQL_CALLS"
    exit 97
  fi
done
printf '%s\n' "$*" >> "$FORGE_INSTALL_ROUTING_PSQL_CALLS"
[ "$1" = '-X' ] && [ "$2" = '-h' ] && [ "$3" = "$FORGE_INSTALL_ROUTING_EXPECTED_SOCKET" ] \
  && [ "$4" = '-p' ] && [ "$5" = '5432' ] && [ "$6" = '-U' ] \
  && [ "$7" = "$FORGE_INSTALL_ROUTING_EXPECTED_USER" ] \
  && [ "$8" = '-d' ] && [ "$9" = postgres ] || exit 96
printf 'touched\n' > "$FORGE_INSTALL_ROUTING_SENTINEL"
case "$*" in
  *'-Atq --set ON_ERROR_STOP=1'*)
    provision_sql="$(cat)"
    case "$provision_sql" in
      *'LOCK TABLE pg_catalog.pg_authid IN SHARE ROW EXCLUSIVE MODE;'*'LOCK TABLE pg_catalog.pg_auth_members IN SHARE ROW EXCLUSIVE MODE;'*"pg_catalog.convert_from(pg_catalog.decode('726f7574696e672d746573742d70617373776f7264', 'hex'), 'UTF8')"*'COMMIT;'*) ;;
      *) exit 94 ;;
    esac
    printf 'existing\n'
    exit 0
    ;;
esac
previous=''
for argument in "$@"; do
  if [ "$previous" = '--file' ]; then
    case "$argument" in
      */reconcile-forge-app-privileges.sql)
        printf 'reconcile\n' >> "$FORGE_INSTALL_ROUTING_RECONCILER_CALLS"
        ;;
    esac
  fi
  previous="$argument"
done
case "$*" in
  *'WHERE rolname = CURRENT_USER AND rolsuper'*) printf '1\n' ;;
  *"FROM pg_roles WHERE rolname='forge'"*) printf '1\n' ;;
  *'SELECT count(*) FROM pg_catalog.pg_auth_members'*) printf '0\n' ;;
  *"role_row.rolname = 'forge'"*) printf '1\n' ;;
  *"FROM pg_database WHERE datname='forge'"*) printf '1\n' ;;
esac
exit 0
EOF
  chmod +x "$case_dir/bin/psql"
  set +e
  PATH="$case_dir/bin:$PATH" \
    FORGE_INSTALL_LIBRARY=1 \
    FORGE_ENV_FILE="$case_dir/forge.env" \
    FORGE_INSTALL_STATE_DIR="$case_dir/state" \
    FORGE_WORKSPACE_ROOT="$case_dir/workspace" \
    FORGE_INSTALL_ROUTING_PSQL_CALLS="$case_dir/psql-calls" \
    FORGE_INSTALL_ROUTING_RECONCILER_CALLS="$case_dir/reconciler-calls" \
    FORGE_INSTALL_ROUTING_STAGE_LOG="$case_dir/migration-stages" \
    FORGE_INSTALL_ROUTING_SENTINEL="$case_dir/sentinel" \
    FORGE_INSTALL_ROUTING_EXPECTED_SOCKET="$case_dir/socket" \
    FORGE_INSTALL_ROUTING_EXPECTED_USER="$(/usr/bin/id -un)" \
    FORGE_INSTALL_TEST_ADMIN_MODE=current \
    FORGE_INSTALL_TEST_PSQL_SOCKET="$case_dir/socket" \
    FORGE_INSTALL_TEST_PSQL_PORT=5432 \
    FORGE_INSTALL_ROUTING_SERVICE_MODE="$service_mode" \
    PGHOST=remote.invalid \
    PGHOSTADDR=203.0.113.7 \
    PGPORT=6543 \
    PGUSER=ambient_user \
    PGDATABASE=ambient_database \
    PGPASSWORD=ambient_password \
    PGPASSFILE="$case_dir/ambient.pgpass" \
    PGSERVICE=ambient_service \
    PGSERVICEFILE="$case_dir/ambient-service.conf" \
    PGOPTIONS='-c search_path=ambient' \
    /bin/bash -c '
      source "$1"
      SERVICE_MODE="$FORGE_INSTALL_ROUTING_SERVICE_MODE"
      DRY_RUN=0
      DB_PASSWORD="routing-test-password"
      provision_database
      if [ "$SERVICE_MODE" = native ] && [ "$MANAGE_LOCAL_DB" = 1 ]; then
        calls_before="$(wc -l < "$FORGE_INSTALL_ROUTING_PSQL_CALLS" | tr -d "[:space:]")"
        prefix_before="${MANAGED_LOCAL_PSQL_ADMIN[*]}"
        resolve_managed_local_admin
        calls_after_first="$(wc -l < "$FORGE_INSTALL_ROUTING_PSQL_CALLS" | tr -d "[:space:]")"
        [ "$calls_after_first" = "$calls_before" ]
        [ "${MANAGED_LOCAL_PSQL_ADMIN[*]}" = "$prefix_before" ]
        resolve_managed_local_admin
        calls_after_second="$(wc -l < "$FORGE_INSTALL_ROUTING_PSQL_CALLS" | tr -d "[:space:]")"
        [ "$calls_after_second" = "$calls_after_first" ]
        [ "${MANAGED_LOCAL_PSQL_ADMIN[*]}" = "$prefix_before" ]
        FORGE_INSTALL_TEST_HOOK=managed-local-migrations
        FORGE_INSTALL_TEST_STAGE_LOG="$FORGE_INSTALL_ROUTING_STAGE_LOG"
        printf "admin:cached\n" >> "$FORGE_INSTALL_TEST_STAGE_LOG"
        run_managed_local_migrations
        FORGE_INSTALL_TEST_HOOK=""
      fi
      grant_forge_privileges
    ' _ "$INSTALLER" > "$case_dir/stdout" 2> "$case_dir/stderr"
  CASE_STATUS=$?
  set -e
  CASE_DIR="$case_dir"
}

for invalid_index in "${!invalid_routing_urls[@]}"; do
  run_installer_privilege_routing_case "nonlocal-$invalid_index" "${invalid_routing_urls[$invalid_index]}"
  [ "$CASE_STATUS" -eq 0 ] || fail "installer nonlocal routing case $invalid_index should succeed"
  [ ! -s "$CASE_DIR/psql-calls" ] || fail "installer nonlocal routing case $invalid_index invoked psql"
  [ "$(<"$CASE_DIR/sentinel")" = untouched ] || fail "installer nonlocal routing case $invalid_index touched the psql sentinel"
done

run_installer_privilege_routing_case valid-postgresql "$managed_repair_url"
[ "$CASE_STATUS" -eq 0 ] || sed -n '1,120p' "$CASE_DIR/stderr" >&2
[ "$CASE_STATUS" -eq 0 ] || fail 'installer postgresql native routing should succeed'
[ "$(wc -l < "$CASE_DIR/reconciler-calls" | tr -d '[:space:]')" = 1 ] \
  || { sed -n '1,120p' "$CASE_DIR/stderr" >&2; sed -n '1,120p' "$CASE_DIR/psql-calls" >&2; }
[ "$(wc -l < "$CASE_DIR/reconciler-calls" | tr -d '[:space:]')" = 1 ] \
  || fail 'installer postgresql native routing must invoke the shared reconciler once'
assert_contains "-X -h $CASE_DIR/socket -p 5432 -U $(/usr/bin/id -un) -d postgres" "$CASE_DIR/psql-calls"
assert_contains '-d forge --set ON_ERROR_STOP=1 --file' "$CASE_DIR/psql-calls"
assert_not_contains 'ambient-' "$CASE_DIR/psql-calls"
assert_not_contains "$TEST_SECRET" "$CASE_DIR/psql-calls"
assert_stages "$CASE_DIR/migration-stages" "${expected_stages[@]}"
run_installer_privilege_routing_case valid-postgres 'postgres://forge:p%40ss%3Aword!@localhost:5432/forge'
[ "$CASE_STATUS" -eq 0 ] || fail 'installer postgres native routing should succeed'
[ "$(wc -l < "$CASE_DIR/reconciler-calls" | tr -d '[:space:]')" = 1 ] \
  || fail 'installer postgres native routing must invoke the shared reconciler once'

run_installer_privilege_routing_case docker-native-url "$managed_repair_url" docker
[ "$CASE_STATUS" -eq 0 ] || fail 'installer docker routing case should succeed'
[ ! -s "$CASE_DIR/psql-calls" ] || fail 'docker service mode invoked native psql administration'
[ "$(<"$CASE_DIR/sentinel")" = untouched ] || fail 'docker service mode touched the native psql sentinel'

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
MANAGED_LOCAL_ADMIN_RESOLUTION=resolved
MANAGED_LOCAL_ADMIN_MODE=runuser
MANAGED_LOCAL_ADMIN_USER=postgres
run_managed_local_migrations
EOF
  chmod +x "$case_dir/driver.sh"
  set +e
  INSTALLER="$INSTALLER" \
    FORGE_TEST_TOOLCHAIN_DIR="$case_dir/bin" \
    PATH="$case_dir/bin:$PATH" \
    UNRELATED_SECRET_SENTINEL='unrelated-value-must-not-reach-postgres' \
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
