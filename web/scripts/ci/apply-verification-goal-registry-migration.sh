#!/usr/bin/env bash
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required.}"
: "${FORGE_DATABASE_ADMIN_URL:?FORGE_DATABASE_ADMIN_URL is required.}"

# Migrations 0033 and 0034 use the same bounded BEGIN/FINALIZE protected-owner
# handoff as 0028. Always restore the exact boundary, including after a
# committed BEGIN or a failure between protected migrations.
cleanup() {
  local original_status=$?
  set +e
  npx tsx scripts/bootstrap-epic-172-s5-recovery-owner.ts --cleanup
  local cleanup_status=$?
  set -e
  if [[ $original_status -ne 0 ]]; then
    if [[ $cleanup_status -ne 0 ]]; then
      echo 'Registry owner handoff cleanup also failed; preserving the original migration failure.' >&2
    fi
    exit "$original_status"
  fi
  if [[ $cleanup_status -ne 0 ]]; then
    echo 'Registry owner handoff cleanup failed after migration.' >&2
    exit "$cleanup_status"
  fi
}
trap cleanup EXIT

npx tsx scripts/bootstrap-epic-172-s5-recovery-owner.ts
if [[ "${FORGE_REGISTRY_FORCE_HANDOFF_FAILURE:-0}" == '1' ]]; then
  psql "$DATABASE_URL" --set ON_ERROR_STOP=1 \
    --command 'select public.forge_begin_epic_172_s4_owner_bootstrap_v1();'
  exit 1
fi
npx tsx scripts/ci/migrate-through-0034.ts
