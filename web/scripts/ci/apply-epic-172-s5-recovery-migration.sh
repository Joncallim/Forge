#!/usr/bin/env bash
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required.}"
: "${FORGE_DATABASE_ADMIN_URL:?FORGE_DATABASE_ADMIN_URL is required.}"

# The 0028 migration deliberately opens the temporary S4 owner edge. Always
# close it, including when the migrator fails after opening that edge. Preserve
# the migration failure as the command result; cleanup failure is itself fatal
# only when migration succeeded.
cleanup() {
  local original_status=$?
  set +e
  npx tsx scripts/bootstrap-epic-172-s5-recovery-owner.ts --cleanup
  local cleanup_status=$?
  set -e
  if [[ $original_status -ne 0 ]]; then
    if [[ $cleanup_status -ne 0 ]]; then
      echo 'S5 owner handoff cleanup also failed; preserving the original migration failure.' >&2
    fi
    exit "$original_status"
  fi
  if [[ $cleanup_status -ne 0 ]]; then
    echo 'S5 owner handoff cleanup failed after migration.' >&2
    exit "$cleanup_status"
  fi
}
trap cleanup EXIT

npx tsx scripts/bootstrap-epic-172-s5-recovery-owner.ts
if [[ "${FORGE_S5_FORCE_HANDOFF_FAILURE:-0}" == '1' ]]; then
  # CI-only controlled failure after the exact begin call. The EXIT trap is the
  # same normal migration wrapper used by all successful paths.
  psql "$DATABASE_URL" --set ON_ERROR_STOP=1 \
    --command 'select public.forge_begin_epic_172_s4_owner_bootstrap_v1();'
  exit 1
fi
npm run db:migrate
