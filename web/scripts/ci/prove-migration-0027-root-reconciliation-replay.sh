#!/usr/bin/env bash
set -euo pipefail
: "${FORGE_DATABASE_ADMIN_URL:?Set the disposable administrator URL.}"

actor='11111111-1111-4111-8111-111111111111'
operation="$(psql "$FORGE_DATABASE_ADMIN_URL" -At --field-separator='|' --set ON_ERROR_STOP=1 --command "SELECT operation_id, through_generation FROM public.project_root_reconciliation_operations WHERE actor_id='${actor}'::uuid ORDER BY created_at DESC LIMIT 1")"
operation_id="${operation%%|*}"
through="${operation#*|}"
[[ "$operation_id" =~ ^[0-9a-f-]{36}$ && "$through" =~ ^[1-9][0-9]*$ ]] || { echo 'Completed root reconciliation operation is unavailable for replay proof.' >&2; exit 1; }

snapshot() {
  psql "$FORGE_DATABASE_ADMIN_URL" -At --set ON_ERROR_STOP=1 --command "
    WITH protected_rows AS (
      SELECT 'operation:' || to_jsonb(o)::text AS line FROM public.project_root_reconciliation_operations o WHERE o.operation_id='${operation_id}'::uuid
      UNION ALL SELECT 'checkpoint:' || to_jsonb(c)::text FROM public.project_root_reconciliation_checkpoints c WHERE c.operation_id='${operation_id}'::uuid
      UNION ALL SELECT 'context:' || to_jsonb(c)::text FROM public.project_root_reconciliation_write_contexts c WHERE c.operation_id='${operation_id}'::uuid
      UNION ALL SELECT 'outcome:' || to_jsonb(o)::text FROM public.project_root_reconciliation_outcomes o WHERE o.operation_id='${operation_id}'::uuid
      UNION ALL SELECT 'head:' || to_jsonb(h)::text FROM public.work_package_local_projection_heads h JOIN public.tasks t ON t.id=h.task_id WHERE t.project_id='27000000-0000-4000-8000-000000000700'::uuid
      UNION ALL SELECT 'pointer:' || to_jsonb(p)::text FROM public.project_filesystem_current_decision_pointers p WHERE p.project_id='27000000-0000-4000-8000-000000000700'::uuid
      UNION ALL SELECT 'package-pointer:' || to_jsonb(p)::text FROM public.filesystem_mcp_current_decision_pointers p JOIN public.tasks t ON t.id=p.task_id WHERE t.project_id='27000000-0000-4000-8000-000000000700'::uuid
      UNION ALL SELECT 'task:' || to_jsonb(t)::text FROM public.tasks t WHERE t.project_id='27000000-0000-4000-8000-000000000700'::uuid
      UNION ALL SELECT 'package:' || to_jsonb(p)::text FROM public.work_packages p JOIN public.tasks t ON t.id=p.task_id WHERE t.project_id='27000000-0000-4000-8000-000000000700'::uuid
    ) SELECT count(*)::text || '|' || md5(coalesce(string_agg(line, E'\\n' ORDER BY line), '')) FROM protected_rows"
}

before="$(snapshot)"
authority="${FORGE_DATABASE_ADMIN_URL#*://}"
url="postgresql://forge_project_root_reconciler:forge_project_root_reconciler_test@${authority#*@}"
output="$(FORGE_PROJECT_ROOT_RECONCILER_DATABASE_URL="$url" npx tsx scripts/reconcile-project-root-expansion.ts --through "$through" --actor "$actor" --apply)"
grep -F -- '"mode":"complete-replay"' <<<"$output" >/dev/null || { echo "Unexpected root reconciliation replay result: $output" >&2; exit 1; }
after="$(snapshot)"
if [[ "$after" != "$before" ]]; then
  echo 'Completed root reconciliation replay mutated protected state.' >&2
  exit 1
fi
