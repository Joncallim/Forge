#!/usr/bin/env bash
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required.}"
: "${FORGE_DATABASE_ADMIN_URL:?FORGE_DATABASE_ADMIN_URL is required.}"

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

npx tsx scripts/bootstrap-vnext-runtime-owner.ts
npx tsx db/migrate.ts
