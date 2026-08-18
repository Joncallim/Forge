#!/usr/bin/env bash
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required.}"
: "${FORGE_DATABASE_ADMIN_URL:?FORGE_DATABASE_ADMIN_URL is required.}"

# Migration 0033 consumes and revokes its temporary S4 owner handoff before it
# commits. Migration 0034 is a separate protected stage and therefore must
# receive a fresh handoff rather than attempting to reuse 0033's authority.
# Each stage is independently failure-safe and the EXIT trap cleans up any
# handoff left open by an interrupted or failed stage.
stage_active=0

cleanup_active_stage() {
  if [[ "$stage_active" != '1' ]]; then
    return 0
  fi
  npx tsx scripts/bootstrap-epic-172-s5-recovery-owner.ts --cleanup
  stage_active=0
}

on_exit() {
  local original_status=$?
  local cleanup_status=0
  set +e
  if [[ "$stage_active" == '1' ]]; then
    npx tsx scripts/bootstrap-epic-172-s5-recovery-owner.ts --cleanup
    cleanup_status=$?
    stage_active=0
  fi
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
trap on_exit EXIT

begin_stage() {
  npx tsx scripts/bootstrap-epic-172-s5-recovery-owner.ts
  stage_active=1
}

run_stage() {
  begin_stage
  "$@"
  cleanup_active_stage
}

# Preserve the existing failure-injection contract: prove that a committed
# BEGIN before the first protected registry stage is still cleaned up exactly.
if [[ "${FORGE_REGISTRY_FORCE_HANDOFF_FAILURE:-0}" == '1' ]]; then
  begin_stage
  psql "$DATABASE_URL" --set ON_ERROR_STOP=1 \
    --command 'select public.forge_begin_epic_172_s4_owner_bootstrap_v1();'
  exit 1
fi

run_stage npx tsx scripts/ci/migrate-through-0033.ts
run_stage npx tsx scripts/ci/migrate-through-0034.ts
