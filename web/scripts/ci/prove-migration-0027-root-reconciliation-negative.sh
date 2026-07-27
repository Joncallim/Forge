#!/usr/bin/env bash
set -euo pipefail
: "${FORGE_DATABASE_ADMIN_URL:?Set the disposable administrator URL.}"

actor='11111111-1111-4111-8111-111111111111'
task='27000000-0000-4000-8000-000000000730'
psql "$FORGE_DATABASE_ADMIN_URL" --set ON_ERROR_STOP=1 --command "ALTER ROLE forge_project_root_reconciler PASSWORD 'forge_project_root_reconciler_test';" >/dev/null
authority="${FORGE_DATABASE_ADMIN_URL#*://}"
url="postgresql://forge_project_root_reconciler:forge_project_root_reconciler_test@${authority#*@}"
while :; do
  rows="$(psql "$url" -At --set ON_ERROR_STOP=1 --command 'SELECT forge.materialize_project_root_ref_expansion_v1(100)')"
  [[ "$rows" =~ ^[0-9]+$ ]] || { echo 'root materialization returned an invalid row count' >&2; exit 1; }
  [[ "$rows" == 0 ]] && break
done
through="$(psql "$FORGE_DATABASE_ADMIN_URL" -At --set ON_ERROR_STOP=1 --command 'SELECT last_generation FROM public.project_root_change_journal_counter WHERE singleton')"
gen_project="$(psql "$FORGE_DATABASE_ADMIN_URL" -At --field-separator='|' --set ON_ERROR_STOP=1 --command 'SELECT generation, project_id FROM public.project_root_change_journal WHERE generation=1')"
generation="${gen_project%%|*}"; project="${gen_project#*|}"
[[ "$generation" == 1 && "$project" =~ ^[0-9a-f-]{36}$ && "$through" =~ ^[1-9][0-9]*$ ]] || { echo 'negative proof requires journal generation one and a positive watermark' >&2; exit 1; }
psql "$FORGE_DATABASE_ADMIN_URL" --set ON_ERROR_STOP=1 --command "INSERT INTO public.tasks(id,project_id,submitted_by,title,prompt,status) SELECT '${task}'::uuid, '${project}'::uuid, submitted_by, 'Root rollback proof', 'rollback only', 'running' FROM public.projects WHERE id='${project}'::uuid"
operation="$(psql "$url" -At --field-separator='|' --set ON_ERROR_STOP=1 --command "SELECT operation_id, state, last_processed_generation FROM forge.begin_project_root_reconciliation_v1(NULL,'${actor}'::uuid,${through}::bigint)")"
operation_id="${operation%%|*}"
[[ "$operation" == *'|running|0' && "$operation_id" =~ ^[0-9a-f-]{36}$ ]] || { echo 'negative proof did not create the exact live operation' >&2; exit 1; }

expect_failure() { local text="$1"; shift; local output; output="$(mktemp)"; if "$@" >"$output" 2>&1; then cat "$output"; unlink "$output"; exit 1; fi; grep -F -- "$text" "$output" >/dev/null || { cat "$output"; unlink "$output"; exit 1; }; unlink "$output"; }
expect_failure 'project-root operation identity cannot be hijacked' psql "$url" --set ON_ERROR_STOP=1 --command "SELECT * FROM forge.begin_project_root_reconciliation_v1('${operation_id}'::uuid,'22222222-2222-4222-8222-222222222222'::uuid,${through}::bigint)"
expect_failure 'query returned no rows' psql "$url" --set ON_ERROR_STOP=1 --command "SELECT forge.enter_project_root_reconciliation_generation_v1('33333333-3333-4333-8333-333333333333'::uuid,'${actor}'::uuid,1,'${project}'::uuid)"
expect_failure 'project-root write context is not claimable' psql "$url" --set ON_ERROR_STOP=1 --command "SELECT forge.enter_project_root_reconciliation_generation_v1('${operation_id}'::uuid,'${actor}'::uuid,2,'${project}'::uuid)"
expect_failure 'project-root authority lock has no active write context' psql "$url" --set ON_ERROR_STOP=1 --command "SELECT forge.lock_project_root_reconciliation_authority_v1('${operation_id}'::uuid,'${actor}'::uuid,1,'${project}'::uuid)"
expect_failure 'rollback sentinel' psql "$url" --set ON_ERROR_STOP=1 <<SQL
BEGIN;
SELECT forge.enter_project_root_reconciliation_generation_v1('${operation_id}'::uuid,'${actor}'::uuid,1,'${project}'::uuid);
UPDATE public.tasks SET status='approved', error_message=NULL WHERE id='${task}'::uuid AND status='running';
SELECT 1/0;
COMMIT;
SQL
psql "$FORGE_DATABASE_ADMIN_URL" --set ON_ERROR_STOP=1 --set operation_id="$operation_id" --set task_id="$task" --set generation=1 --file scripts/ci/sql/migration-0027-root-reconciliation-negative-assertions.sql
