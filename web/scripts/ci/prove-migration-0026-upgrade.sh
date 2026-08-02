#!/usr/bin/env bash
set -euo pipefail

: "${FORGE_MIGRATION_0026_DATABASE_URL:?Set the disposable PostgreSQL upgrade database URL.}"
: "${FORGE_DATABASE_ADMIN_URL:?Set the short-lived PostgreSQL administrator URL.}"

export DATABASE_URL="${FORGE_MIGRATION_0026_DATABASE_URL}"
migration_principal="$(psql "${DATABASE_URL}" --no-align --tuples-only --command 'SELECT current_user')"

assert_upgrade_state() {
  psql "${FORGE_DATABASE_ADMIN_URL}" \
    --set ON_ERROR_STOP=1 \
    --set migration_principal="${migration_principal}" \
    --file scripts/ci/sql/migration-0026-upgrade-assertions.sql
}

echo 'Bootstrapping the 0025 release owner boundary in the disposable upgrade database.'
npm run protocol:bootstrap-epic-172-release-roles
npx tsx scripts/ci/migrate-through-0025.ts

echo 'Seeding representative legacy tasks, packages, grants, and metadata at 0025.'
psql "${DATABASE_URL}" \
  --set ON_ERROR_STOP=1 \
  --file scripts/ci/sql/migration-0026-upgrade-fixture.sql

echo 'Bootstrapping the versioned 0026 owner handoff and applying the normal migrator.'
npm run protocol:bootstrap-epic-172-s3-release-owner
npx tsx scripts/ci/migrate-through-0026.ts
assert_upgrade_state
migration_count_before_rerun="$(
  psql "${DATABASE_URL}" --no-align --tuples-only \
    --command 'SELECT count(*) FROM drizzle.__drizzle_migrations'
)"

echo 'Re-running the normal migrator to prove upgrade idempotency.'
npx tsx scripts/ci/migrate-through-0026.ts
assert_upgrade_state
migration_count_after_rerun="$(
  psql "${DATABASE_URL}" --no-align --tuples-only \
    --command 'SELECT count(*) FROM drizzle.__drizzle_migrations'
)"
if [[ "${migration_count_after_rerun}" != "${migration_count_before_rerun}" ]]; then
  echo 'The idempotent migrator rerun unexpectedly recorded another migration.' >&2
  exit 1
fi

echo 'Populated PostgreSQL migration 0025 to 0026 upgrade proof passed.'
