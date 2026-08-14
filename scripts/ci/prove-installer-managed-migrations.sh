#!/usr/bin/env bash
# Hosted disposable-PostgreSQL proof for the installer-managed migration path.
set -Eeuo pipefail

: "${FORGE_INSTALLER_MANAGED_DATABASE_URL:?Set the disposable successful-upgrade database URL.}"
: "${FORGE_INSTALLER_MANAGED_FAILURE_DATABASE_URL:?Set the disposable S5-failure database URL.}"
: "${FORGE_INSTALLER_MANAGED_ADMIN_URL:?Set the successful-upgrade PostgreSQL administrator URL.}"
: "${FORGE_INSTALLER_MANAGED_FAILURE_ADMIN_URL:?Set the S5-failure PostgreSQL administrator URL.}"
: "${FORGE_INSTALLER_MANAGED_ADMIN_HOST:?Set the fixed disposable PostgreSQL admin host.}"
: "${FORGE_INSTALLER_MANAGED_ADMIN_USER:?Set the fixed disposable PostgreSQL admin user.}"
: "${FORGE_INSTALLER_MANAGED_ADMIN_PASSWORD:?Set the fixed disposable PostgreSQL admin password.}"
: "${FORGE_INSTALLER_MANAGED_ADMIN_DATABASE:?Set the successful-upgrade admin database name.}"
: "${FORGE_INSTALLER_MANAGED_FAILURE_ADMIN_DATABASE:?Set the S5-failure admin database name.}"

SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -P "$SCRIPT_DIR/../.." && pwd)"
INSTALLER="$REPO_ROOT/scripts/install.sh"
TEMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/forge-installer-managed-proof.XXXXXX")"
trap 'rm -rf "$TEMP_ROOT"' EXIT
source "$REPO_ROOT/scripts/ci/current-migration-ledger.sh"

prepare_0025_baseline() {
  local database_url="$1" admin_url="$2"
  echo 'Preparing exact migration-0025 disposable baseline.'
  (
    cd "$REPO_ROOT/web"
    DATABASE_URL="$database_url" FORGE_DATABASE_ADMIN_URL="$admin_url" \
      npm run protocol:bootstrap-epic-172-release-roles
    DATABASE_URL="$database_url" npx tsx scripts/ci/migrate-through-0025.ts
  )
}

run_real_managed_sequence() {
  local database_url="$1" admin_url="$2" env_file="$3"
  printf 'DATABASE_URL=%s\n' "$database_url" > "$env_file"
  (
    set --
    export DATABASE_URL="$database_url"
    export FORGE_DATABASE_ADMIN_URL="$admin_url"
    export FORGE_ENV_FILE="$env_file"
    export FORGE_INSTALL_LIBRARY=1
    source "$INSTALLER"
    MANAGED_LOCAL_ADMIN_MODE=current
    run_managed_local_migration_sequence
  )
}

assert_latest_and_clean() {
  local database_name="$1"
  PGPASSWORD="$FORGE_INSTALLER_MANAGED_ADMIN_PASSWORD" PGHOST="$FORGE_INSTALLER_MANAGED_ADMIN_HOST" PGUSER="$FORGE_INSTALLER_MANAGED_ADMIN_USER" PGDATABASE="$database_name" psql \
    --set ON_ERROR_STOP=1 \
    --set expected_migration_count="$FORGE_CURRENT_MIGRATION_COUNT" \
    --set expected_latest_migration_at="$FORGE_CURRENT_LATEST_MIGRATION_AT" <<'SQL'
SELECT pg_catalog.set_config('forge.proof_expected_migration_count', :'expected_migration_count', false);
SELECT pg_catalog.set_config('forge.proof_expected_latest_migration_at', :'expected_latest_migration_at', false);

DO $proof$
BEGIN
  IF (SELECT count(*) FROM drizzle.__drizzle_migrations)
       <> current_setting('forge.proof_expected_migration_count')::bigint
     OR (SELECT max(created_at) FROM drizzle.__drizzle_migrations)
       <> current_setting('forge.proof_expected_latest_migration_at')::bigint THEN
    RAISE EXCEPTION 'Managed installer did not apply the exact latest migration ledger';
  END IF;
  IF pg_catalog.to_regclass('public.forge_epic_172_s3_release_state') IS NULL THEN
    RAISE EXCEPTION 'Managed installer did not create the S3 release state';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_auth_members membership
    WHERE membership.roleid IN ('forge_release_routines_owner'::regrole, 'forge_s4_routines_owner'::regrole)
  ) THEN
    RAISE EXCEPTION 'Managed installer retained owner membership';
  END IF;
END;
$proof$;
SQL
}

assert_s5_cleanup() {
  local database_name="$1"
  PGPASSWORD="$FORGE_INSTALLER_MANAGED_ADMIN_PASSWORD" PGHOST="$FORGE_INSTALLER_MANAGED_ADMIN_HOST" PGUSER="$FORGE_INSTALLER_MANAGED_ADMIN_USER" PGDATABASE="$database_name" psql --set ON_ERROR_STOP=1 <<'SQL'
DO $proof$
DECLARE
  migration_login name := 'forge_migration_test';
BEGIN
  IF pg_catalog.has_function_privilege(
    migration_login,
    'public.forge_begin_epic_172_s4_owner_bootstrap_v1()'::regprocedure,
    'EXECUTE'
  ) OR pg_catalog.pg_has_role(migration_login, 'forge_s4_routines_owner', 'member')
    OR pg_catalog.has_schema_privilege(migration_login, 'forge', 'CREATE') THEN
    RAISE EXCEPTION 'S5 cleanup retained temporary migration authority';
  END IF;
END;
$proof$;
SQL
}

success_env="$TEMP_ROOT/success.env"
failure_env="$TEMP_ROOT/failure.env"

echo 'Proving the real installer-managed sequence from migration 0025 through latest.'
prepare_0025_baseline "$FORGE_INSTALLER_MANAGED_DATABASE_URL" "$FORGE_INSTALLER_MANAGED_ADMIN_URL"
run_real_managed_sequence "$FORGE_INSTALLER_MANAGED_DATABASE_URL" "$FORGE_INSTALLER_MANAGED_ADMIN_URL" "$success_env"
assert_latest_and_clean "$FORGE_INSTALLER_MANAGED_ADMIN_DATABASE"

echo 'Re-running the real installer-managed sequence to prove already-latest idempotency.'
run_real_managed_sequence "$FORGE_INSTALLER_MANAGED_DATABASE_URL" "$FORGE_INSTALLER_MANAGED_ADMIN_URL" "$success_env"
assert_latest_and_clean "$FORGE_INSTALLER_MANAGED_ADMIN_DATABASE"

echo 'Proving real S5 failure cleanup preserves the original migration failure.'
prepare_0025_baseline "$FORGE_INSTALLER_MANAGED_FAILURE_DATABASE_URL" "$FORGE_INSTALLER_MANAGED_FAILURE_ADMIN_URL"
set +e
FORGE_S5_FORCE_HANDOFF_FAILURE=1 \
  run_real_managed_sequence "$FORGE_INSTALLER_MANAGED_FAILURE_DATABASE_URL" "$FORGE_INSTALLER_MANAGED_FAILURE_ADMIN_URL" "$failure_env"
failure_status=$?
set -e
if [ "$failure_status" -eq 0 ]; then
  echo 'The induced S5 failure unexpectedly succeeded.' >&2
  exit 1
fi
assert_s5_cleanup "$FORGE_INSTALLER_MANAGED_FAILURE_ADMIN_DATABASE"

echo 'Installer-managed migration sequence, rerun, and S5 failure-cleanup proof passed.'
