#!/usr/bin/env bash
set -euo pipefail

project_id='27000000-0000-4000-8000-000000000700'
new_root_ref='27000000-0000-4000-8000-000000000703'
actor_id='11111111-1111-4111-8111-111111111111'

usage() {
  echo 'Usage: prove-migration-0027-root-authority-reconciliation.sh --prepare|--assert' >&2
  exit 2
}

phase="${1:-}"
case "$phase" in
  --prepare|--assert) [[ $# -eq 1 ]] || usage ;;
  *) usage ;;
esac
: "${FORGE_DATABASE_ADMIN_URL:?Set the disposable administrator URL.}"

case "$phase" in
  --prepare)
    # These fixtures are deliberately arranged by the disposable administrator.
    # Preparation writes journal rows only; the upgrade orchestrator owns the
    # single post-drain reconciliation operation for every prepared fixture.
    psql "$FORGE_DATABASE_ADMIN_URL" --set ON_ERROR_STOP=1 \
      --file scripts/ci/sql/migration-0027-root-authority-project-fixture.sql
    psql "$FORGE_DATABASE_ADMIN_URL" --set ON_ERROR_STOP=1 \
      --file scripts/ci/sql/migration-0027-root-authority-package-fixture.sql
    psql "$FORGE_DATABASE_ADMIN_URL" --set ON_ERROR_STOP=1 --command \
      "UPDATE public.projects SET root_ref = '${new_root_ref}'::uuid WHERE id = '${project_id}'::uuid"
    authority_generation="$(psql "$FORGE_DATABASE_ADMIN_URL" --no-align --tuples-only --set ON_ERROR_STOP=1 --command \
      "SELECT generation FROM public.project_root_change_journal WHERE project_id = '${project_id}'::uuid AND outcome = 'root_update' ORDER BY generation DESC LIMIT 1")"
    if [[ ! "$authority_generation" =~ ^[1-9][0-9]*$ ]]; then
      echo 'The authority fixture did not create an exact root-update journal generation.' >&2
      exit 1
    fi
    ;;
  --assert)
    authority_generation="$(psql "$FORGE_DATABASE_ADMIN_URL" --no-align --tuples-only --set ON_ERROR_STOP=1 --command \
      "SELECT generation FROM public.project_root_change_journal WHERE project_id = '${project_id}'::uuid AND outcome = 'root_update' ORDER BY generation DESC LIMIT 1")"
    operation_row="$(psql "$FORGE_DATABASE_ADMIN_URL" --no-align --tuples-only --field-separator='|' --set ON_ERROR_STOP=1 --command \
      "SELECT operation_id, through_generation FROM public.project_root_reconciliation_operations WHERE actor_id = '${actor_id}'::uuid ORDER BY created_at DESC LIMIT 1")"
    operation_id="${operation_row%%|*}"
    through_generation="${operation_row#*|}"
    if [[ ! "$authority_generation" =~ ^[1-9][0-9]*$ ]] || [[ ! "$operation_id" =~ ^[0-9a-f-]{36}$ ]] || [[ ! "$through_generation" =~ ^[1-9][0-9]*$ ]] || (( authority_generation > through_generation )); then
      echo 'The completed reconciliation operation does not cover the authority root-update generation.' >&2
      exit 1
    fi
    psql "$FORGE_DATABASE_ADMIN_URL" --set ON_ERROR_STOP=1 \
      --set authority_generation="$authority_generation" \
      --set through_generation="$through_generation" \
      --set operation_id="$operation_id" \
      --set actor_id="$actor_id" \
      --file scripts/ci/sql/migration-0027-root-authority-reconciliation-assertions.sql
    ;;
  *) usage ;;
esac
