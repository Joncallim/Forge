#!/usr/bin/env bash
# Hosted disposable-PostgreSQL proof for the shared Docker/TCP controller.
set -Eeuo pipefail

: "${FORGE_INSTALLER_MANAGED_APP_URL:?Set the disposable application database URL.}"
: "${FORGE_INSTALLER_MANAGED_ADMIN_URL:?Set the successful-upgrade PostgreSQL administrator URL.}"
: "${FORGE_INSTALLER_MANAGED_ADMIN_HOST:?Set the fixed disposable PostgreSQL admin host.}"
: "${FORGE_INSTALLER_MANAGED_ADMIN_USER:?Set the fixed disposable PostgreSQL admin user.}"
: "${FORGE_INSTALLER_MANAGED_ADMIN_PASSWORD:?Set the fixed disposable PostgreSQL admin password.}"
: "${FORGE_INSTALLER_MANAGED_ADMIN_DATABASE:?Set the successful-upgrade admin database name.}"
: "${FORGE_RUNTIME_API_DATABASE_PASSWORD:?Set the disposable runtime API password.}"

SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -P "$SCRIPT_DIR/../.." && pwd)"
source "$REPO_ROOT/scripts/ci/current-migration-ledger.sh"

NODE_BIN="${FORGE_PROOF_NODE_BIN:-$(command -v node)}"
TSX_CLI="${FORGE_PROOF_TSX_CLI:-$(cd "$REPO_ROOT/web" && "$NODE_BIN" -p "require.resolve('tsx/cli')" 2>/dev/null)}"
[[ "$NODE_BIN" = /* && -x "$NODE_BIN" && "$TSX_CLI" = /* && -r "$TSX_CLI" ]] || {
  echo 'The Docker controller proof requires absolute readable Node and tsx paths.' >&2
  exit 1
}
if [ "$EUID" -ne 0 ]; then
  export FORGE_PROOF_NODE_BIN="$NODE_BIN" FORGE_PROOF_TSX_CLI="$TSX_CLI"
  exec /usr/bin/sudo -n \
    --preserve-env=FORGE_INSTALLER_MANAGED_APP_URL,FORGE_INSTALLER_MANAGED_ADMIN_URL,FORGE_INSTALLER_MANAGED_ADMIN_HOST,FORGE_INSTALLER_MANAGED_ADMIN_USER,FORGE_INSTALLER_MANAGED_ADMIN_PASSWORD,FORGE_INSTALLER_MANAGED_ADMIN_DATABASE,FORGE_RUNTIME_API_DATABASE_PASSWORD,FORGE_PROOF_NODE_BIN,FORGE_PROOF_TSX_CLI \
    /bin/bash "$SCRIPT_DIR/prove-installer-managed-migrations.sh"
fi

run_shared_docker_controller() {
  (
    cd "$REPO_ROOT/web"
    DATABASE_URL="$FORGE_INSTALLER_MANAGED_APP_URL" \
      FORGE_DATABASE_ADMIN_URL="$FORGE_INSTALLER_MANAGED_ADMIN_URL" \
      FORGE_MANAGED_DOCKER_MIGRATIONS=1 \
      "$NODE_BIN" "$TSX_CLI" scripts/managed-docker-migration-controller.ts --run
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
    RAISE EXCEPTION 'Shared Docker controller did not apply the exact latest migration ledger';
  END IF;
  IF pg_catalog.to_regclass('public.forge_epic_172_s3_release_state') IS NULL THEN
    RAISE EXCEPTION 'Shared Docker controller did not create the S3 release state';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_auth_members membership
    WHERE membership.roleid IN ('forge_release_routines_owner'::regrole, 'forge_s4_routines_owner'::regrole)
  ) THEN
    RAISE EXCEPTION 'Shared Docker controller retained owner membership';
  END IF;
END;
$proof$;
SQL
}

echo 'Proving the shared Docker/TCP controller from an empty disposable database through latest.'
run_shared_docker_controller
assert_latest_and_clean "$FORGE_INSTALLER_MANAGED_ADMIN_DATABASE"

echo 'Re-running the shared Docker/TCP controller to prove already-latest idempotency.'
run_shared_docker_controller
assert_latest_and_clean "$FORGE_INSTALLER_MANAGED_ADMIN_DATABASE"

echo 'Shared Docker/TCP controller sequence and idempotent rerun passed; native installer and wrapper-failure proofs run in their dedicated planes.'
