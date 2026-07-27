#!/usr/bin/env bash
set -euo pipefail
: "${FORGE_DATABASE_ADMIN_URL:?Set the disposable administrator URL.}"
actor='11111111-1111-4111-8111-111111111111'; task='27000000-0000-4000-8000-000000000730'
authority="${FORGE_DATABASE_ADMIN_URL#*://}"
url="postgresql://forge_project_root_reconciler:forge_project_root_reconciler_test@${authority#*@}"
operation="$(psql "$FORGE_DATABASE_ADMIN_URL" -At --field-separator='|' --set ON_ERROR_STOP=1 --command "SELECT operation_id, last_project_id FROM public.project_root_reconciliation_operations WHERE actor_id='${actor}'::uuid ORDER BY created_at DESC LIMIT 1")"
operation_id="${operation%%|*}"
project="$(psql "$FORGE_DATABASE_ADMIN_URL" -At --set ON_ERROR_STOP=1 --command 'SELECT project_id FROM public.project_root_change_journal WHERE generation=1')"
[[ "$operation_id" =~ ^[0-9a-f-]{36}$ && "$project" =~ ^[0-9a-f-]{36}$ ]] || { echo 'stale context proof lacks the prepared operation' >&2; exit 1; }
expect_failure() { local expected_status="$1" text="$2"; shift 2; local out status; out="$(mktemp)"; if "$@" >"$out" 2>&1; then echo "stale reconciliation proof expected psql failure: ${text}" >&2; cat "$out" >&2; unlink "$out"; exit 1; else status=$?; fi; [[ "$status" == "$expected_status" ]] || { echo "stale reconciliation proof expected psql exit ${expected_status} for ${text}, got ${status}" >&2; cat "$out" >&2; unlink "$out"; exit 1; }; grep -F -- "$text" "$out" >/dev/null || { echo "stale reconciliation proof received the wrong psql error for ${text}" >&2; cat "$out" >&2; unlink "$out"; exit 1; }; unlink "$out"; }
# A valid context permits the fenced task transition only in this transaction;
# its deliberate abort makes the subsequent backend/session attempts stale.
expect_failure 3 'division by zero' psql "$url" --set ON_ERROR_STOP=1 <<SQL
BEGIN;
SELECT forge.enter_project_root_reconciliation_generation_v1('${operation_id}'::uuid,'${actor}'::uuid,1,'${project}'::uuid);
UPDATE public.tasks SET status='approved', error_message=NULL WHERE id='${task}'::uuid;
SELECT 1/0;
COMMIT;
SQL
expect_failure 1 'project-root task update has no active write context' psql "$url" --set ON_ERROR_STOP=1 --command "UPDATE public.tasks SET status='approved', error_message=NULL WHERE id='${task}'::uuid"
expect_failure 1 'project-root write context is absent or stale' psql "$url" --set ON_ERROR_STOP=1 --command "SELECT * FROM forge.complete_project_root_reconciliation_generation_v1('${operation_id}'::uuid,'${actor}'::uuid,1,'${project}'::uuid,'insert')"
expect_failure 1 'project-root task update has no active write context' psql "$url" --set ON_ERROR_STOP=1 --command "SELECT set_config('forge.project_root_context','forged',true); UPDATE public.tasks SET status='approved', error_message=NULL WHERE id='${task}'::uuid"
psql "$FORGE_DATABASE_ADMIN_URL" --set ON_ERROR_STOP=1 --set operation_id="$operation_id" --set task_id="$task" --set generation=1 --file scripts/ci/sql/migration-0027-root-reconciliation-negative-assertions.sql
