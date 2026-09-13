#!/usr/bin/env bash
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required.}"
# A self-hosted Docker database owner can perform the bounded handoffs with its
# ordinary migration URL. Hosted deployments provide this documented short-lived
# administrator URL instead.
export FORGE_DATABASE_ADMIN_URL="${FORGE_DATABASE_ADMIN_URL:-$DATABASE_URL}"

cleanup() {
  local original_status=$?
  set +e
  npx tsx scripts/bootstrap-vnext-runtime-owner.ts --cleanup
  local cleanup_status=$?
  set -e
  if [[ $original_status -ne 0 ]]; then
    [[ $cleanup_status -eq 0 ]] || echo 'VNext runtime owner cleanup also failed; preserving the migration failure.' >&2
    exit "$original_status"
  fi
  [[ $cleanup_status -eq 0 ]] || { echo 'VNext runtime owner cleanup failed after migration.' >&2; exit "$cleanup_status"; }
}
trap cleanup EXIT

npm run protocol:bootstrap-epic-172-release-roles
npx tsx scripts/ci/migrate-through-0025.ts
npm run protocol:bootstrap-epic-172-s3-release-owner
npx tsx scripts/ci/migrate-through-0026.ts
npm run protocol:repair-epic-172-legacy-release
npm run protocol:bootstrap-epic-172-s4-roles
npx tsx scripts/ci/migrate-through-0027.ts
bash scripts/ci/apply-epic-172-s5-recovery-migration.sh
bash scripts/ci/apply-verification-goal-registry-migration.sh
npx tsx scripts/bootstrap-vnext-runtime-owner.ts
npx tsx scripts/ci/migrate-through-0034.ts
npx tsx db/migrate.ts
