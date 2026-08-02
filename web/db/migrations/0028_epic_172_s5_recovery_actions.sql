-- Correct the local recovery disposition/action compare-and-set for databases
-- that already recorded the original 0027 migration. Keep 0027 immutable: its
-- journal entry may already be present in deployed databases.
--> statement-breakpoint
-- The original migration finalizes its temporary owner edge. Reopen that
-- narrowly scoped, migration-login-only edge so PostgreSQL permits replacing
-- the protected routine, then close it again below.
SELECT public.forge_begin_epic_172_s4_owner_bootstrap_v1();
--> statement-breakpoint
SET ROLE forge_s4_routines_owner;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION forge.apply_local_effect_recovery_action_v2(
  p_task_id uuid,
  p_work_package_id uuid,
  p_local_run_evidence_id uuid,
  p_action text,
  p_expected_marker_fingerprint text,
  p_actor_user_id uuid
)
RETURNS TABLE (
  action_id uuid,
  result text,
  result_marker_fingerprint text,
  package_status text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, forge
AS $$
DECLARE
  v_project_id uuid;
  v_project public.projects%ROWTYPE;
  v_task public.tasks%ROWTYPE;
  v_package public.work_packages%ROWTYPE;
  v_evidence public.work_package_local_run_evidence%ROWTYPE;
  v_marker jsonb;
  v_next_marker jsonb;
  v_evidence_fingerprint text;
  v_action_id uuid;
  v_result text;
  v_status text;
  v_package_count integer;
  v_projection_head_count integer;
  v_now timestamptz := pg_catalog.clock_timestamp();
BEGIN
  IF session_user <> 'forge_s4_recovery_operator'
     OR current_user <> 'forge_s4_routines_owner' THEN
    RAISE EXCEPTION 'local recovery action requires the fixed recovery login'
      USING ERRCODE = '42501';
  END IF;
  IF p_action NOT IN (
    'review_local_changes','acknowledge_possible_local_invocation',
    'retry_local_execution','decline_local_retry'
  ) OR p_expected_marker_fingerprint !~ '^sha256:[0-9a-f]{64}$'
     OR NOT forge.s4_protected_paths_enabled_v1() THEN
    RAISE EXCEPTION 'local recovery action input or authority is invalid'
      USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  SELECT action.id, action.result, action.result_marker_fingerprint,
    action.package_status
  FROM public.local_effect_recovery_actions action
  WHERE action.task_id = p_task_id
    AND action.work_package_id = p_work_package_id
    AND action.local_run_evidence_id = p_local_run_evidence_id
    AND action.action = p_action
    AND action.expected_marker_fingerprint = p_expected_marker_fingerprint
    AND action.actor_user_id = p_actor_user_id;
  IF FOUND THEN RETURN; END IF;

  SELECT task.project_id INTO STRICT v_project_id
  FROM public.tasks task WHERE task.id = p_task_id;
  SELECT project.* INTO v_project
  FROM public.projects project
  WHERE project.id = v_project_id AND project.archived_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'local recovery project is unavailable'
      USING ERRCODE = '40001';
  END IF;
  SELECT task.* INTO v_task
  FROM public.tasks task
  WHERE task.id = p_task_id AND task.project_id = v_project_id
    AND task.status = 'approved'
    AND task.local_projection_scope_state = 'active'
    AND task.local_projection_overlimit_package_count IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'local recovery requires an approved active task'
      USING ERRCODE = '40001';
  END IF;
  PERFORM 1 FROM public.work_packages package
  WHERE package.task_id = p_task_id ORDER BY package.id FOR UPDATE;
  GET DIAGNOSTICS v_package_count = ROW_COUNT;
  IF v_package_count NOT BETWEEN 1 AND 256 THEN
    RAISE EXCEPTION 'local recovery is outside the bounded projection scope'
      USING ERRCODE = 'P1726';
  END IF;
  -- Recovery and normal claims share task -> sibling package -> projection-head
  -- lock order. Recovery therefore validates one complete task projection,
  -- never a mixture of sibling states from different transitions.
  PERFORM 1 FROM public.work_package_local_projection_heads head
  WHERE head.task_id = p_task_id ORDER BY head.id FOR UPDATE;
  GET DIAGNOSTICS v_projection_head_count = ROW_COUNT;
  IF v_projection_head_count <> v_package_count * 8
     OR EXISTS (
       SELECT 1
       FROM public.work_package_local_projection_heads head
       WHERE head.task_id = p_task_id
       GROUP BY head.work_package_id
       HAVING pg_catalog.count(*) <> 8
          OR pg_catalog.count(DISTINCT head.head_kind) <> 8
          OR pg_catalog.min(head.head_index) <> 0
          OR pg_catalog.max(head.head_index) <> 7
     ) THEN
    RAISE EXCEPTION 'local recovery projection is incomplete or divergent'
      USING ERRCODE = 'P1726';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.work_packages sibling
    WHERE sibling.task_id = p_task_id
      AND (
        sibling.status IN ('running','awaiting_review')
        OR sibling.metadata ? 'packet_integrity_hold'
        OR sibling.metadata ? 'local_effect_integrity_hold'
        OR (
          sibling.id <> p_work_package_id
          AND (
            sibling.metadata ? 'local_effect_recovery'
            OR sibling.metadata ? 'packet_issuance'
          )
        )
      )
  ) OR EXISTS (
    SELECT 1
    FROM public.work_packages sibling
    JOIN public.agent_runs run
      ON run.work_package_id = sibling.id
     AND run.id::text = sibling.metadata->'executionLease'->>'runId'
    WHERE sibling.task_id = p_task_id
      AND forge.s4_execution_lease_live_v1(sibling.metadata, run.id, v_now)
  ) OR EXISTS (
    SELECT 1
    FROM public.work_package_local_run_evidence evidence
    WHERE evidence.task_id = p_task_id AND evidence.state = 'claimed'
  ) OR EXISTS (
    SELECT 1
    FROM public.filesystem_mcp_runtime_audits audit
    WHERE audit.task_id = p_task_id
      AND audit.protocol_version = 2 AND audit.status = 'claiming'
  ) THEN
    RAISE EXCEPTION 'local recovery requires quiescent siblings and evidence'
      USING ERRCODE = '40001';
  END IF;
  SELECT evidence.* INTO STRICT v_evidence
  FROM public.work_package_local_run_evidence evidence
  WHERE evidence.id = p_local_run_evidence_id
    AND evidence.task_id = p_task_id
    AND evidence.work_package_id = p_work_package_id
    AND evidence.state IN ('terminal','uncertain')
  FOR UPDATE;
  -- The recovery marker is public, mutable projection state.  Rebuild the
  -- evidence identity only after locking the canonical evidence row; never
  -- authorize recovery from the marker's copied fingerprint.
  IF v_evidence.terminal IS NULL
     OR v_evidence.terminal->>'status' <> 'failed'
     OR v_evidence.terminal->>'failureCode' NOT IN (
       'local_execution_failed', 'local_invocation_uncertain',
       'external_repository_change_requires_review', 'worker_stopped'
     ) THEN
    RAISE EXCEPTION 'local recovery requires complete non-success terminal evidence'
      USING ERRCODE = '40001';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.filesystem_mcp_runtime_audits audit
    WHERE audit.protocol_version = 2
      AND audit.local_run_evidence_id = v_evidence.id
  ) THEN
    RAISE EXCEPTION 'packet-linked local evidence must use packet recovery'
      USING ERRCODE = '40001';
  END IF;
  v_evidence_fingerprint := 'sha256:' || pg_catalog.encode(pg_catalog.sha256(
    pg_catalog.convert_to(
      'forge:local-run-evidence:v1:' || v_evidence.id::text || ':' || v_evidence.terminal::text,
      'UTF8'
    )
  ), 'hex');
  SELECT package.* INTO STRICT v_package
  FROM public.work_packages package
  WHERE package.id = p_work_package_id AND package.status = 'blocked';
  v_marker := v_package.metadata->'local_effect_recovery';
  IF v_marker IS NULL
     OR v_package.metadata ? 'packet_issuance'
     OR v_package.metadata ? 'packet_integrity_hold'
     OR v_package.metadata ? 'local_effect_integrity_hold'
     OR v_marker->>'localRunEvidenceId' <> p_local_run_evidence_id::text
     OR v_marker->>'evidenceFingerprint' <> v_evidence_fingerprint
     -- The supplied value is a public-marker CAS token only. It must match the
     -- current projection but is never used as the authoritative evidence ID.
     OR p_expected_marker_fingerprint <> v_evidence_fingerprint
     OR (
       p_action = 'review_local_changes'
       AND v_marker->>'disposition' <> 'review_local_changes'
     )
     OR (
       p_action = 'acknowledge_possible_local_invocation'
       AND v_marker->>'disposition' <> 'acknowledge_possible_local_invocation'
     )
     OR (
       p_action = 'retry_local_execution'
       AND v_marker->>'disposition' <> 'retry_local_execution'
     )
     OR (
       p_action = 'decline_local_retry'
       AND v_marker->>'disposition' NOT IN (
         'acknowledge_possible_local_invocation', 'retry_local_execution'
       )
     ) THEN
    RAISE EXCEPTION 'local recovery marker changed before action compare-and-set'
      USING ERRCODE = '40001';
  END IF;

  v_next_marker := NULL;
  IF p_action = 'review_local_changes' THEN
    v_next_marker := (v_marker - 'nextDisposition')
      || pg_catalog.jsonb_build_object(
        'disposition', v_marker->>'nextDisposition', 'reviewState', 'reviewed'
      );
    v_result := 'reviewed';
    v_status := 'blocked';
  ELSIF p_action = 'acknowledge_possible_local_invocation' THEN
    v_next_marker := v_marker || pg_catalog.jsonb_build_object(
      'disposition', 'retry_local_execution',
      'acknowledgedAt', pg_catalog.to_char(
        pg_catalog.clock_timestamp() AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      ),
      'acknowledgedByUserId', p_actor_user_id::text
    );
    v_result := 'acknowledged';
    v_status := 'blocked';
  ELSIF p_action = 'retry_local_execution' THEN
    v_result := 'ready';
    v_status := 'ready';
  ELSE
    v_result := 'cancelled';
    v_status := 'cancelled';
  END IF;
  v_action_id := pg_catalog.gen_random_uuid();
  INSERT INTO public.local_effect_recovery_actions (
    id, task_id, work_package_id, local_run_evidence_id, action,
    expected_marker_fingerprint, actor_user_id, result,
    result_marker_fingerprint, package_status
  ) VALUES (
    v_action_id, p_task_id, p_work_package_id, p_local_run_evidence_id,
    p_action, p_expected_marker_fingerprint, p_actor_user_id, v_result,
    CASE WHEN v_next_marker IS NULL THEN NULL
      ELSE v_next_marker->>'evidenceFingerprint' END,
    v_status
  );
  UPDATE public.work_packages package
  SET status = v_status,
      metadata = CASE WHEN v_next_marker IS NULL
        THEN package.metadata - 'local_effect_recovery'
        ELSE pg_catalog.jsonb_set(
          package.metadata, '{local_effect_recovery}', v_next_marker, true
        ) END,
      updated_at = pg_catalog.clock_timestamp()
  WHERE package.id = p_work_package_id
    AND package.status = 'blocked'
    AND package.metadata->'local_effect_recovery' = v_marker;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'local recovery action lost its marker compare-and-set'
      USING ERRCODE = '40001';
  END IF;
  action_id := v_action_id;
  result := v_result;
  result_marker_fingerprint := CASE WHEN v_next_marker IS NULL THEN NULL
    ELSE v_next_marker->>'evidenceFingerprint' END;
  package_status := v_status;
  RETURN NEXT;
END;
$$;
--> statement-breakpoint
RESET ROLE;
--> statement-breakpoint
SELECT public.forge_finalize_epic_172_s4_owner_bootstrap_v1();
