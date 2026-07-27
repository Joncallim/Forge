\set ON_ERROR_STOP on

DO $assertions$
DECLARE
  v_project_id uuid := '27000000-0000-4000-8000-000000000700'::uuid;
  v_task_running uuid := '27000000-0000-4000-8000-000000000710'::uuid;
  v_task_failed uuid := '27000000-0000-4000-8000-000000000720'::uuid;
  v_add uuid := '27000000-0000-4000-8000-000000000711'::uuid;
  v_refresh uuid := '27000000-0000-4000-8000-000000000712'::uuid;
  v_recover uuid := '27000000-0000-4000-8000-000000000721'::uuid;
  v_actor uuid := :'actor_id'::uuid;
  v_authority_generation bigint := :'authority_generation'::bigint;
  v_through_generation bigint := :'through_generation'::bigint;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.project_root_change_journal journal_row
    WHERE journal_row.generation = v_authority_generation
      AND journal_row.project_id = v_project_id
      AND journal_row.outcome = 'root_update'
  ) THEN
    RAISE EXCEPTION 'root authority proof lost its exact root-update journal generation';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.project_root_reconciliation_operations operation_row
    JOIN public.project_root_reconciliation_outcomes outcome_row
      ON outcome_row.operation_id = operation_row.operation_id
     AND outcome_row.generation = v_authority_generation
     AND outcome_row.actor_id = v_actor
     AND outcome_row.project_id = v_project_id
     AND outcome_row.outcome = 'root_update'
    JOIN public.project_root_reconciliation_write_contexts context_row
      ON context_row.operation_id = operation_row.operation_id
     AND context_row.generation = v_authority_generation
     AND context_row.actor_id = v_actor
     AND context_row.project_id = v_project_id
     AND context_row.completed_at IS NOT NULL
    WHERE operation_row.actor_id = v_actor
      AND operation_row.through_generation = v_through_generation
      AND operation_row.last_processed_generation = v_through_generation
      AND operation_row.cumulative_count = v_through_generation
      AND operation_row.state = 'complete'
      AND operation_row.completed_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'root authority generation was not completed by the dedicated operation/context lifecycle';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.work_packages package_row
    WHERE package_row.id = v_add
      AND (
        package_row.status <> 'blocked'
        OR package_row.blocked_reason <> 'Filesystem context requires an operator decision before execution.'
        OR public.forge_is_canonical_filesystem_grant_block_v2(package_row.metadata->'mcpGrantBlock') IS NOT TRUE
        OR package_row.metadata - 'mcpGrantBlock' IS DISTINCT FROM
          '{"fixturePeer":{"case":"addition","retain":true},"mcpGrantPhases":{"filesystem":{"phase":"preexisting-add","revision":"1"}}}'::jsonb
        OR package_row.metadata->'mcpGrantBlock'->'requestedCapabilities' <> '["filesystem.project.read","filesystem.project.search"]'::jsonb
      )
  ) OR EXISTS (
    SELECT 1 FROM public.work_packages package_row
    WHERE package_row.id = v_refresh
      AND (
        package_row.status <> 'blocked'
        OR package_row.blocked_reason <> 'Filesystem context requires an operator decision before execution.'
        OR public.forge_is_canonical_filesystem_grant_block_v2(package_row.metadata->'mcpGrantBlock') IS NOT TRUE
        OR package_row.metadata - 'mcpGrantBlock' IS DISTINCT FROM
          '{"fixturePeer":{"case":"replacement","retain":true},"mcpGrantPhases":{"filesystem":{"phase":"preexisting-replace","revision":"1"}}}'::jsonb
        OR package_row.metadata->'mcpGrantBlock'->'requestedCapabilities' <> '["filesystem.project.read","filesystem.project.search"]'::jsonb
      )
  ) OR EXISTS (
    SELECT 1 FROM public.work_packages package_row
    WHERE package_row.id = v_recover
      AND (
        package_row.status <> 'ready'
        OR package_row.blocked_reason IS NOT NULL
        OR package_row.metadata ? 'mcpGrantBlock'
        OR package_row.metadata IS DISTINCT FROM
          '{"fixturePeer":{"case":"removal","retain":true},"mcpGrantPhases":{"filesystem":{"phase":"preexisting-remove","revision":"1"}}}'::jsonb
      )
  ) THEN
    RAISE EXCEPTION 'root authority package marker, phase, or peer metadata convergence is not canonical';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.tasks task_row
    WHERE (task_row.id = v_task_running OR task_row.id = v_task_failed)
      AND (task_row.status <> 'approved' OR task_row.error_message IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'root authority task convergence did not recover running and failed tasks';
  END IF;

  IF (SELECT count(*) FROM public.work_package_local_projection_heads head
      JOIN public.work_package_local_projection_sources source_row
        ON source_row.id = head.current_source_id
       AND source_row.task_id = head.current_source_task_id
       AND source_row.work_package_id = head.current_source_work_package_id
       AND source_row.source_kind = head.current_source_kind
       AND source_row.source_revision = head.current_source_revision
       AND source_row.source_fingerprint = head.current_source_fingerprint
      WHERE head.work_package_id IN (v_add, v_refresh, v_recover)
        AND head.head_kind = 'operator_hold'
        AND head.head_revision = 1
        AND head.current_source_kind = 'operator_hold'
        AND head.current_source_revision = 1
        AND head.current_source_fingerprint ~ '^sha256:[0-9a-f]{64}$'
        AND head.compare_and_set_fingerprint ~ '^sha256:[0-9a-f]{64}$'
        AND source_row.contribution->>'transition' = CASE head.work_package_id
          WHEN v_add THEN 'hold' WHEN v_refresh THEN 'refresh' WHEN v_recover THEN 'recovery' END
        AND source_row.contribution->>'operatorHold' = CASE head.work_package_id
          WHEN v_recover THEN 'false' ELSE 'true' END
    ) <> 3 THEN
    RAISE EXCEPTION 'root authority projection-head compare-and-set effects are incomplete';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.project_filesystem_current_decision_pointers pointer_row
    WHERE pointer_row.project_id = v_project_id
      AND pointer_row.current_decision_id = '27000000-0000-4000-8000-000000000702'::uuid
      AND pointer_row.current_decision_project_id = v_project_id
      AND pointer_row.current_decision_revision = 1
      AND pointer_row.current_root_binding_revision = 1
      AND pointer_row.current_decision_fingerprint =
        'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
      AND pointer_row.pointer_generation = 1
  ) OR (SELECT count(*) FROM public.project_filesystem_grant_decisions WHERE project_id = v_project_id) <> 1
    OR EXISTS (
      SELECT 1 FROM public.filesystem_mcp_current_decision_pointers pointer_row
      WHERE pointer_row.work_package_id IN (v_add, v_refresh, v_recover)
        AND (pointer_row.current_decision_id IS NOT NULL OR pointer_row.pointer_version <> 0)
    ) THEN
    RAISE EXCEPTION 'root authority reconciliation mutated protected decision or pointer authority directly';
  END IF;
END;
$assertions$;
