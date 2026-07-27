#!/usr/bin/env bash
set -euo pipefail
: "${FORGE_DATABASE_ADMIN_URL:?Set the disposable administrator URL.}"

actor='11111111-1111-4111-8111-111111111111'
actor_b='44444444-4444-4444-8444-444444444444'
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
gen_project="$(psql "$FORGE_DATABASE_ADMIN_URL" -At --field-separator='|' --set ON_ERROR_STOP=1 --command 'SELECT generation, project_id, outcome FROM public.project_root_change_journal WHERE generation=1')"
generation="${gen_project%%|*}"
project_outcome="${gen_project#*|}"
project="${project_outcome%%|*}"
outcome="${project_outcome#*|}"
[[ "$generation" == 1 && "$project" =~ ^[0-9a-f-]{36}$ && "$outcome" =~ ^(insert|root_update|archive)$ && "$through" =~ ^[1-9][0-9]*$ ]] || { echo 'negative proof requires journal generation one and a positive watermark' >&2; exit 1; }
psql "$FORGE_DATABASE_ADMIN_URL" --set ON_ERROR_STOP=1 --command "INSERT INTO public.tasks(id,project_id,submitted_by,title,prompt,status) SELECT '${task}'::uuid, '${project}'::uuid, submitted_by, 'Root rollback proof', 'rollback only', 'running' FROM public.projects WHERE id='${project}'::uuid"
operation="$(psql "$url" -At --field-separator='|' --set ON_ERROR_STOP=1 --command "SELECT operation_id, state, last_processed_generation FROM forge.begin_project_root_reconciliation_v1(NULL,'${actor}'::uuid,${through}::bigint)")"
operation_id="${operation%%|*}"
[[ "$operation" == *'|running|0' && "$operation_id" =~ ^[0-9a-f-]{36}$ ]] || { echo 'negative proof did not create the exact live operation' >&2; exit 1; }

snapshot_reconciliation_state() {
  psql "$FORGE_DATABASE_ADMIN_URL" -At --set ON_ERROR_STOP=1 --command "
    WITH snapshots AS (
      SELECT 'operations' AS category, coalesce(jsonb_agg(to_jsonb(operation_row) ORDER BY operation_row.operation_id)::text, '[]') AS payload FROM public.project_root_reconciliation_operations operation_row
      UNION ALL SELECT 'checkpoints', coalesce(jsonb_agg(to_jsonb(checkpoint_row) ORDER BY checkpoint_row.operation_id, checkpoint_row.checkpoint_generation)::text, '[]') FROM public.project_root_reconciliation_checkpoints checkpoint_row
      UNION ALL SELECT 'outcomes', coalesce(jsonb_agg(to_jsonb(outcome_row) ORDER BY outcome_row.generation)::text, '[]') FROM public.project_root_reconciliation_outcomes outcome_row
      UNION ALL SELECT 'contexts', coalesce(jsonb_agg(to_jsonb(context_row) ORDER BY context_row.operation_id, context_row.generation)::text, '[]') FROM public.project_root_reconciliation_write_contexts context_row
      UNION ALL SELECT 'journal', coalesce(jsonb_agg(to_jsonb(journal_row) ORDER BY journal_row.generation)::text, '[]') FROM public.project_root_change_journal journal_row
      UNION ALL SELECT 'runtime_audits', coalesce(jsonb_agg(to_jsonb(audit_row) ORDER BY audit_row.id)::text, '[]') FROM public.filesystem_mcp_runtime_audits audit_row
      UNION ALL SELECT 'project_pointers', coalesce(jsonb_agg(to_jsonb(pointer_row) ORDER BY pointer_row.project_id)::text, '[]') FROM public.project_filesystem_current_decision_pointers pointer_row
      UNION ALL SELECT 'package_pointers', coalesce(jsonb_agg(to_jsonb(pointer_row) ORDER BY pointer_row.work_package_id)::text, '[]') FROM public.filesystem_mcp_current_decision_pointers pointer_row
      UNION ALL SELECT 'projection_heads', coalesce(jsonb_agg(to_jsonb(head_row) ORDER BY head_row.id)::text, '[]') FROM public.work_package_local_projection_heads head_row
      UNION ALL SELECT 'tasks', coalesce(jsonb_agg(to_jsonb(task_row) ORDER BY task_row.id)::text, '[]') FROM public.tasks task_row
      UNION ALL SELECT 'packages', coalesce(jsonb_agg(to_jsonb(package_row) ORDER BY package_row.id)::text, '[]') FROM public.work_packages package_row
    )
    SELECT md5(string_agg(category || ':' || payload, E'\\n' ORDER BY category)) FROM snapshots"
}

expect_isolated_rejection() {
  local phase="$1" expected_text="$2" actor_input="$3" generation_input="$4" project_input="$5" output status before after
  before="$(snapshot_reconciliation_state)"
  output="$(mktemp)"
  if psql "$url" --set ON_ERROR_STOP=1 --command "SELECT forge.enter_project_root_reconciliation_generation_v1('${operation_id}'::uuid,'${actor_input}'::uuid,${generation_input}::bigint,'${project_input}'::uuid)" >"$output" 2>&1; then
    echo "negative reconciliation proof ${phase} unexpectedly succeeded" >&2
    cat "$output" >&2
    unlink "$output"
    exit 1
  else
    status=$?
  fi
  if [[ "$status" != 1 ]] || ! grep -F -- "$expected_text" "$output" >/dev/null; then
    echo "negative reconciliation proof ${phase} received an unexpected psql status/error (status=${status})" >&2
    cat "$output" >&2
    unlink "$output"
    exit 1
  fi
  unlink "$output"
  after="$(snapshot_reconciliation_state)"
  [[ "$before" == "$after" && "$after" =~ ^[0-9a-f]{32}$ ]] || { echo "negative reconciliation proof ${phase} changed protected reconciliation state" >&2; exit 1; }
}

wrong_project="$(psql "$FORGE_DATABASE_ADMIN_URL" -At --set ON_ERROR_STOP=1 --command "SELECT project_id FROM public.project_root_change_journal WHERE project_id <> '${project}'::uuid ORDER BY generation LIMIT 1")"
[[ "$wrong_project" =~ ^[0-9a-f-]{36}$ && "$wrong_project" != "$project" ]] || { echo 'negative proof lacks a distinct journal project for project-binding isolation' >&2; exit 1; }
expect_isolated_rejection 'correct-next-generation wrong-project binding' 'project-root write context is not claimable' "$actor" "$generation" "$wrong_project"

wrong_generation_project="$(psql "$FORGE_DATABASE_ADMIN_URL" -At --field-separator='|' --set ON_ERROR_STOP=1 --command "SELECT generation, project_id FROM public.project_root_change_journal WHERE generation > ${generation} AND generation <= ${through} ORDER BY generation LIMIT 1")"
wrong_generation="${wrong_generation_project%%|*}"
wrong_generation_project_id="${wrong_generation_project#*|}"
[[ "$wrong_generation" =~ ^[1-9][0-9]*$ && "$wrong_generation" != "$generation" && "$wrong_generation_project_id" =~ ^[0-9a-f-]{36}$ ]] || { echo 'negative proof lacks a later journal generation for generation-sequence isolation' >&2; exit 1; }
expect_isolated_rejection 'wrong-generation correct-journal-project binding' 'project-root write context is not claimable' "$actor" "$wrong_generation" "$wrong_generation_project_id"

# Every entry input below is valid except the logical actor: actor B cannot
# claim actor A's operation or leave a context row behind.
expect_isolated_rejection 'valid-entry wrong-actor ownership' 'project-root write context is not claimable' "$actor_b" "$generation" "$project"

expect_composite_completion_context_rejection() {
  local phase='composite completion wrong-actor context identity' output status before after
  before="$(snapshot_reconciliation_state)"
  output="$(mktemp)"
  # The completion routine deliberately includes actor_id in its active-context
  # lookup before the later operation CAS. Returning the generic stale-context
  # error here avoids disclosing actor A's live context to actor B.
  if psql "$url" --set ON_ERROR_STOP=1 >"$output" 2>&1 <<SQL
BEGIN;
SELECT forge.enter_project_root_reconciliation_generation_v1('${operation_id}'::uuid,'${actor}'::uuid,${generation}::bigint,'${project}'::uuid);
SELECT * FROM forge.complete_project_root_reconciliation_generation_v1('${operation_id}'::uuid,'${actor_b}'::uuid,${generation}::bigint,'${project}'::uuid,'${outcome}');
COMMIT;
SQL
  then
    echo "negative reconciliation proof ${phase} unexpectedly succeeded" >&2
    cat "$output" >&2
    unlink "$output"
    exit 1
  else
    status=$?
  fi
  if [[ "$status" != 3 ]] || ! grep -F -- 'project-root write context is absent or stale' "$output" >/dev/null; then
    echo "negative reconciliation proof ${phase} received an unexpected psql status/error (status=${status})" >&2
    cat "$output" >&2
    unlink "$output"
    exit 1
  fi
  unlink "$output"
  after="$(snapshot_reconciliation_state)"
  [[ "$before" == "$after" && "$after" =~ ^[0-9a-f]{32}$ ]] || { echo "negative reconciliation proof ${phase} changed protected reconciliation state or left an orphan context" >&2; exit 1; }
}

expect_composite_completion_context_rejection

expect_failure() { local expected_status="$1" text="$2"; shift 2; local output status; output="$(mktemp)"; if "$@" >"$output" 2>&1; then echo "negative reconciliation proof expected psql failure: ${text}" >&2; cat "$output" >&2; unlink "$output"; exit 1; else status=$?; fi; [[ "$status" == "$expected_status" ]] || { echo "negative reconciliation proof expected psql exit ${expected_status} for ${text}, got ${status}" >&2; cat "$output" >&2; unlink "$output"; exit 1; }; grep -F -- "$text" "$output" >/dev/null || { echo "negative reconciliation proof received the wrong psql error for ${text}" >&2; cat "$output" >&2; unlink "$output"; exit 1; }; unlink "$output"; }
expect_failure 1 'project-root operation identity cannot be hijacked' psql "$url" --set ON_ERROR_STOP=1 --command "SELECT * FROM forge.begin_project_root_reconciliation_v1('${operation_id}'::uuid,'22222222-2222-4222-8222-222222222222'::uuid,${through}::bigint)"
expect_failure 1 'query returned no rows' psql "$url" --set ON_ERROR_STOP=1 --command "SELECT forge.enter_project_root_reconciliation_generation_v1('33333333-3333-4333-8333-333333333333'::uuid,'${actor}'::uuid,1,'${project}'::uuid)"
expect_failure 1 'project-root write context is not claimable' psql "$url" --set ON_ERROR_STOP=1 --command "SELECT forge.enter_project_root_reconciliation_generation_v1('${operation_id}'::uuid,'${actor}'::uuid,2,'${project}'::uuid)"
expect_failure 1 'project-root authority lock has no active write context' psql "$url" --set ON_ERROR_STOP=1 --command "SELECT forge.lock_project_root_reconciliation_authority_v1('${operation_id}'::uuid,'${actor}'::uuid,1,'${project}'::uuid)"
# psql must stop on this exact server error. The following admin psql command
# is a fresh session and proves the aborted transaction left no durable state.
expect_failure 3 'division by zero' psql "$url" --set ON_ERROR_STOP=1 <<SQL
BEGIN;
SELECT forge.enter_project_root_reconciliation_generation_v1('${operation_id}'::uuid,'${actor}'::uuid,1,'${project}'::uuid);
UPDATE public.tasks SET status='approved', error_message=NULL WHERE id='${task}'::uuid AND status='running';
SELECT 1/0;
COMMIT;
SQL
psql "$FORGE_DATABASE_ADMIN_URL" --set ON_ERROR_STOP=1 --set operation_id="$operation_id" --set task_id="$task" --set generation=1 --file scripts/ci/sql/migration-0027-root-reconciliation-negative-assertions.sql
