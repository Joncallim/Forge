#!/usr/bin/env bash
set -euo pipefail

: "${FORGE_MIGRATION_0027_DATABASE_URL:?Set the disposable PostgreSQL 0027 upgrade database URL.}"
: "${FORGE_DATABASE_ADMIN_URL:?Set the short-lived PostgreSQL administrator URL.}"
export DATABASE_URL="${FORGE_MIGRATION_0027_DATABASE_URL}"
migration_principal="$(psql "${DATABASE_URL}" --no-align --tuples-only --command 'SELECT current_user')"

echo 'Applying the exact migration prefix through 0025 and installing the 0026 owner handoff.'
npm run protocol:bootstrap-epic-172-release-roles
npx tsx scripts/ci/migrate-through-0025.ts
npm run protocol:bootstrap-epic-172-s3-release-owner
npx tsx scripts/ci/migrate-through-0026.ts

echo 'Seeding populated 0026 projects before the S4 expansion.'
psql "${DATABASE_URL}" --set ON_ERROR_STOP=1 --file scripts/ci/sql/migration-0027-upgrade-fixture.sql

echo 'Bootstrapping the exact S4 owner handoff and applying only pending 0027.'
npm run protocol:bootstrap-epic-172-s4-roles
npm run db:migrate
psql "${FORGE_DATABASE_ADMIN_URL}" --set ON_ERROR_STOP=1 \
  --set migration_principal="${migration_principal}" \
  --file scripts/ci/sql/migration-0027-expansion-assertions.sql

bash scripts/ci/reconcile-migration-0027-root-refs.sh
bash scripts/ci/cutover-migration-0027-root-ref.sh --apply
psql "${FORGE_DATABASE_ADMIN_URL}" --set ON_ERROR_STOP=1 \
  --file scripts/ci/sql/migration-0027-cutover-assertions.sql

migration_count_before="$(psql "${DATABASE_URL}" --no-align --tuples-only --command 'SELECT count(*) FROM drizzle.__drizzle_migrations')"
npm run db:migrate
migration_count_after="$(psql "${DATABASE_URL}" --no-align --tuples-only --command 'SELECT count(*) FROM drizzle.__drizzle_migrations')"
if [[ "${migration_count_before}" != "${migration_count_after}" ]]; then
  echo 'The 0027 migrator rerun recorded an unexpected migration.' >&2
  exit 1
fi
echo 'Populated PostgreSQL 0026 to 0027 upgrade, reconciliation, and strict cutover proof passed.'
