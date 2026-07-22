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
legacy_session_id='27000000-0000-4000-8000-000000000099'
legacy_now_ms="$(($(date +%s) * 1000))"
legacy_expiry_ms="$((legacy_now_ms + 600000))"
redis-cli -u "${REDIS_URL}" set "session:${legacy_session_id}" \
  "{\"userId\":\"27000000-0000-4000-8000-000000000001\",\"lastSeenAt\":${legacy_now_ms}}" \
  PXAT "${legacy_expiry_ms}" >/dev/null
observed_legacy_expiry_ms="$(redis-cli -u "${REDIS_URL}" pexpiretime "session:${legacy_session_id}")"
redis-cli -u "${REDIS_URL}" set 'session:orphan-migration-0027' \
  '{"userId":"orphan","lastSeenAt":0}' PX 600000 >/dev/null

echo 'Bootstrapping the exact S4 owner handoff and applying only pending 0027.'
npm run protocol:bootstrap-epic-172-s4-roles
npm run db:migrate
psql "${FORGE_DATABASE_ADMIN_URL}" --set ON_ERROR_STOP=1 \
  --set migration_principal="${migration_principal}" \
  --file scripts/ci/sql/migration-0027-expansion-assertions.sql

echo 'Reconciling the legacy Redis session with its exact absolute expiry.'
npm run session-credentials:reconcile
npm run session-credentials:reconcile -- --apply
# A second apply proves the crash/restart path is idempotent after the old key
# is gone but before strict constraints are installed.
npm run session-credentials:reconcile -- --apply
npm run session-credentials:reconcile -- --apply --finalize
database_expiry_ms="$(psql "${DATABASE_URL}" --no-align --tuples-only --command \
  "select floor(extract(epoch from expires_at) * 1000)::bigint from sessions where credential_digest_v1 = sha256(convert_to('forge:web-session:v1', 'UTF8') || decode('00', 'hex') || convert_to('${legacy_session_id}', 'UTF8'))")"
if [[ "${database_expiry_ms}" != "${observed_legacy_expiry_ms}" ]]; then
  echo 'The session reconciliation did not preserve Redis PEXPIRETIME exactly.' >&2
  exit 1
fi
if [[ "$(redis-cli -u "${REDIS_URL}" exists "session:${legacy_session_id}")" != '0' ]]; then
  echo 'The legacy raw-cookie Redis key survived reconciliation.' >&2
  exit 1
fi
if [[ "$(redis-cli -u "${REDIS_URL}" exists 'session:orphan-migration-0027')" != '0' ]]; then
  echo 'An orphan legacy Redis session key survived the strict zero scan.' >&2
  exit 1
fi

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
echo 'Populated PostgreSQL 0026 to 0027 upgrade, session/root reconciliation, and strict cutover proof passed.'
