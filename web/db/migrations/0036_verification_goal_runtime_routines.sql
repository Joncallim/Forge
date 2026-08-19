-- Verification goal runtime routines, queue delivery, and scheduler authority
-- (issue #187 Slices C and E).
--
-- Migration 0035 added the protected execution surfaces. This migration adds
-- the protected business routines the worker, scheduler, dispatcher, and API
-- depend on so that goal-proof writes are always lease-fenced, capacity is
-- DB-enforced under the canonical lock order, and the ordinary application
-- login never mutates protected rows directly.
--
-- It also fixes the schedule-head pointer shape to the architecture contract:
-- one current binding per (project, goal), not one per project.
SELECT public.forge_begin_epic_172_s4_owner_bootstrap_v1();
--> statement-breakpoint
SET ROLE forge_s4_routines_owner;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Schedule heads: one current binding per (project, goal)
-- ---------------------------------------------------------------------------
ALTER TABLE "verification_goal_schedule_heads" DROP CONSTRAINT "verification_goal_schedule_heads_pkey";
--> statement-breakpoint
ALTER TABLE "verification_goal_schedule_heads" ADD COLUMN "goal_id" text NOT NULL;
--> statement-breakpoint
ALTER TABLE "verification_goal_schedule_heads"
ADD CONSTRAINT "verification_goal_schedule_heads_pkey" PRIMARY KEY ("project_id", "goal_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "verification_goal_schedule_bindings_id_project_goal_idx"
ON "verification_goal_schedule_bindings" USING btree ("id", "project_id", "goal_id");
--> statement-breakpoint
ALTER TABLE "verification_goal_schedule_heads"
ADD CONSTRAINT "verification_goal_schedule_heads_binding_identity_fk"
FOREIGN KEY ("schedule_binding_id", "project_id", "goal_id")
REFERENCES "public"."verification_goal_schedule_bindings"("id", "project_id", "goal_id")
ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE "verification_goal_runs"
ADD CONSTRAINT "verification_goal_runs_schedule_slot_fk"
FOREIGN KEY ("schedule_slot_id") REFERENCES "public"."verification_goal_schedule_slots"("id")
ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Redis delivery marker
-- ---------------------------------------------------------------------------
ALTER TABLE "verification_goal_runs" ADD COLUMN "redis_dispatched_at" timestamp with time zone;
--> statement-breakpoint
CREATE INDEX "verification_goal_runs_redis_dispatch_idx"
ON "verification_goal_runs" USING btree ("status", "redis_dispatched_at")
WHERE "status" = 'queued';
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Admission: capacity-checked, idempotent run creation
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.forge_admit_verification_goal_run_v1(
  p_project_id uuid,
  p_registry_revision_id uuid,
  p_registry_entry_ordinal integer,
  p_snapshot_id uuid,
  p_goal_id text,
  p_definition_version integer,
  p_definition_digest text,
  p_source_path text,
  p_execution_binding_digest text,
  p_policy_revision_id uuid,
  p_policy_revision_sequence bigint,
  p_resolved_policy jsonb,
  p_resolved_policy_fingerprint text,
  p_trigger_kind text,
  p_requested_by_user_id uuid,
  p_manual_idempotency_key uuid,
  p_manual_request_fingerprint text,
  p_schedule_binding_id uuid,
  p_schedule_slot_id uuid,
  p_admission_expiry timestamp with time zone,
  p_authority_fingerprint text
)
RETURNS TABLE (run_id uuid, state text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_policy public.verification_goal_policy_revisions%ROWTYPE;
  v_entry public.verification_goal_registry_entries%ROWTYPE;
  v_snapshot public.verification_goal_snapshots%ROWTYPE;
  v_queued integer;
  v_concurrent integer;
  v_active integer;
  v_recent_starts integer;
  v_existing public.verification_goal_runs%ROWTYPE;
  v_new_id uuid;
BEGIN
  IF session_user <> 'forge' OR current_user <> 'forge_s4_routines_owner' THEN
    RAISE EXCEPTION 'verification goal admission requires the fixed Forge login'
      USING ERRCODE = '42501';
  END IF;
  IF p_trigger_kind NOT IN ('manual', 'scheduled')
     OR p_resolved_policy_fingerprint !~ '^[0-9a-f]{64}$'
     OR p_authority_fingerprint !~ '^[0-9a-f]{64}$'
     OR p_definition_digest !~ '^[0-9a-f]{64}$'
     OR (p_execution_binding_digest IS NOT NULL
         AND p_execution_binding_digest !~ '^[0-9a-f]{64}$')
     OR p_admission_expiry <= pg_catalog.clock_timestamp()
     OR p_definition_version <= 0
     OR p_registry_entry_ordinal < 0 THEN
    RAISE EXCEPTION 'verification goal admission parameters are invalid'
      USING ERRCODE = '22023';
  END IF;
  IF (p_trigger_kind = 'manual'
      AND (p_requested_by_user_id IS NULL
           OR p_manual_idempotency_key IS NULL
           OR p_manual_request_fingerprint IS NULL
           OR p_schedule_binding_id IS NOT NULL
           OR p_schedule_slot_id IS NOT NULL))
     OR (p_trigger_kind = 'scheduled'
         AND (p_requested_by_user_id IS NOT NULL
              OR p_manual_idempotency_key IS NOT NULL
              OR p_manual_request_fingerprint IS NOT NULL
              OR p_schedule_binding_id IS NULL
              OR p_schedule_slot_id IS NULL)) THEN
    RAISE EXCEPTION 'verification goal admission trigger shape is invalid'
      USING ERRCODE = '22023';
  END IF;

  PERFORM 1 FROM public.projects
  WHERE id = p_project_id AND archived_at IS NULL
  FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'verification goal admission project is unavailable'
      USING ERRCODE = 'P1871';
  END IF;

  SELECT * INTO v_policy
  FROM public.verification_goal_policy_revisions
  WHERE id = p_policy_revision_id
    AND project_id = p_project_id
    AND revision_sequence = p_policy_revision_sequence
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'verification goal policy revision is not current'
      USING ERRCODE = 'P1872';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.verification_goal_policy_heads
    WHERE project_id = p_project_id
      AND policy_revision_id = p_policy_revision_id
  ) THEN
    RAISE EXCEPTION 'verification goal policy head changed'
      USING ERRCODE = 'P1872';
  END IF;
  IF (p_trigger_kind = 'manual' AND NOT v_policy.manual_enabled)
     OR (p_trigger_kind = 'scheduled' AND NOT v_policy.scheduling_enabled) THEN
    RAISE EXCEPTION 'verification goal execution is disabled by project policy'
      USING ERRCODE = 'P1873';
  END IF;

  SELECT * INTO v_entry
  FROM public.verification_goal_registry_entries
  WHERE registry_revision_id = p_registry_revision_id
    AND ordinal = p_registry_entry_ordinal
  FOR SHARE;
  IF NOT FOUND
     OR v_entry.project_id <> p_project_id
     OR v_entry.goal_id <> p_goal_id
     OR v_entry.snapshot_id <> p_snapshot_id
     OR v_entry.definition_version <> p_definition_version
     OR v_entry.definition_digest <> p_definition_digest
     OR v_entry.source_path <> p_source_path
     OR v_entry.execution_binding_digest IS DISTINCT FROM p_execution_binding_digest THEN
    RAISE EXCEPTION 'verification goal registry entry changed'
      USING ERRCODE = 'P1873';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.verification_goal_registry_heads
    WHERE project_id = p_project_id
      AND registry_revision_id = p_registry_revision_id
  ) THEN
    RAISE EXCEPTION 'verification goal registry head changed'
      USING ERRCODE = 'P1873';
  END IF;

  SELECT * INTO v_snapshot
  FROM public.verification_goal_snapshots
  WHERE id = p_snapshot_id
  FOR SHARE;
  IF NOT FOUND
     OR v_snapshot.canonical_definition->>'schemaVersion' <> '2'
     OR v_snapshot.canonical_definition->>'enabled' <> 'true'
     OR (p_trigger_kind = 'manual'
         AND v_snapshot.canonical_definition->'execution'->>'manual' <> 'true')
     OR (p_trigger_kind = 'scheduled'
         AND v_snapshot.canonical_definition->'execution'->'schedule'->>'kind'
             IS DISTINCT FROM 'interval') THEN
    RAISE EXCEPTION 'verification goal definition is not executable for this trigger'
      USING ERRCODE = 'P1873';
  END IF;

  SELECT count(*) INTO v_queued
  FROM public.verification_goal_runs
  WHERE project_id = p_project_id AND status = 'queued';
  SELECT count(*) INTO v_concurrent
  FROM public.verification_goal_runs
  WHERE project_id = p_project_id
    AND status = 'running'
    AND lease_expires_at > pg_catalog.clock_timestamp();
  SELECT count(*) INTO v_active
  FROM public.verification_goal_runs
  WHERE project_id = p_project_id
    AND status IN ('queued', 'running', 'recovery_required');
  SELECT count(*) INTO v_recent_starts
  FROM public.verification_goal_runs
  WHERE project_id = p_project_id
    AND created_at >= pg_catalog.clock_timestamp() - make_interval(
      secs => v_policy.start_budget_window_seconds::double precision
    );

  IF v_queued + 1 > v_policy.max_queued_runs THEN
    RAISE EXCEPTION 'verification goal queued capacity limit reached'
      USING ERRCODE = 'P1874';
  END IF;
  IF v_concurrent + 1 > v_policy.max_concurrent_runs THEN
    RAISE EXCEPTION 'verification goal concurrent capacity limit reached'
      USING ERRCODE = 'P1874';
  END IF;
  IF v_active + 1 > v_policy.max_active_runs THEN
    RAISE EXCEPTION 'verification goal active capacity limit reached'
      USING ERRCODE = 'P1874';
  END IF;
  IF v_recent_starts + 1 > v_policy.max_starts_per_window THEN
    RAISE EXCEPTION 'verification goal start budget limit reached'
      USING ERRCODE = 'P1874';
  END IF;

  IF p_trigger_kind = 'manual' THEN
    SELECT * INTO v_existing
    FROM public.verification_goal_runs
    WHERE requested_by_user_id = p_requested_by_user_id
      AND manual_idempotency_key = p_manual_idempotency_key
    FOR UPDATE;
    IF FOUND THEN
      IF v_existing.manual_request_fingerprint IS DISTINCT FROM p_manual_request_fingerprint THEN
        RAISE EXCEPTION 'verification goal manual idempotency key conflicts with a different request'
          USING ERRCODE = 'P1876';
      END IF;
      run_id := v_existing.id;
      state := 'existing';
      RETURN NEXT;
      RETURN;
    END IF;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.verification_goal_runs
    WHERE project_id = p_project_id
      AND goal_id = p_goal_id
      AND status IN ('queued', 'running', 'recovery_required')
  ) THEN
    RAISE EXCEPTION 'verification goal already has an active run'
      USING ERRCODE = 'P1874';
  END IF;

  INSERT INTO public.verification_goal_runs (
    project_id, registry_revision_id, registry_entry_ordinal, snapshot_id,
    goal_id, definition_version, definition_digest, source_path,
    execution_binding_digest, policy_revision_id, policy_revision_sequence,
    resolved_policy, resolved_policy_fingerprint, trigger_kind,
    requested_by_user_id, manual_idempotency_key, manual_request_fingerprint,
    schedule_binding_id, schedule_slot_id, admission_expiry,
    authority_fingerprint, status
  ) VALUES (
    p_project_id, p_registry_revision_id, p_registry_entry_ordinal, p_snapshot_id,
    p_goal_id, p_definition_version, p_definition_digest, p_source_path,
    p_execution_binding_digest, p_policy_revision_id, p_policy_revision_sequence,
    p_resolved_policy, p_resolved_policy_fingerprint, p_trigger_kind,
    p_requested_by_user_id, p_manual_idempotency_key, p_manual_request_fingerprint,
    p_schedule_binding_id, p_schedule_slot_id, p_admission_expiry,
    p_authority_fingerprint, 'queued'
  ) RETURNING id INTO v_new_id;

  INSERT INTO public.verification_goal_events (
    verification_goal_run_id, event_sequence, phase, status
  ) VALUES (v_new_id, 1, 'admitted', 'ok');

  run_id := v_new_id;
  state := 'created';
  RETURN NEXT;
END;
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Lease claim (replaces 0035 definition to append the claimed event)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.forge_claim_verification_goal_run_lease_v1(
  p_run_id uuid,
  p_lease_generation bigint,
  p_lease_token uuid,
  p_lease_expires_at timestamp with time zone
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_affected integer;
  v_next_sequence integer;
BEGIN
  IF session_user <> 'forge' OR current_user <> 'forge_s4_routines_owner' THEN
    RAISE EXCEPTION 'verification goal run lease claim requires the fixed Forge login'
      USING ERRCODE = '42501';
  END IF;
  IF p_lease_generation <= 0 OR p_lease_expires_at <= pg_catalog.clock_timestamp() THEN
    RAISE EXCEPTION 'verification goal run lease parameters are invalid'
      USING ERRCODE = '22023';
  END IF;

  UPDATE public.verification_goal_runs
  SET status = 'running',
      started_at = COALESCE(started_at, pg_catalog.clock_timestamp()),
      lease_generation = p_lease_generation,
      lease_token = p_lease_token,
      lease_expires_at = p_lease_expires_at
  WHERE id = p_run_id
    AND status IN ('queued', 'running')
    AND (status <> 'queued' OR admission_expiry > pg_catalog.clock_timestamp())
    AND (lease_expires_at IS NULL OR lease_expires_at <= pg_catalog.clock_timestamp());
  GET DIAGNOSTICS v_affected = ROW_COUNT;
  IF v_affected <> 1 THEN
    RAISE EXCEPTION 'verification goal run lease claim failed'
      USING ERRCODE = 'P1872';
  END IF;

  SELECT COALESCE(max(event_sequence), 0) + 1 INTO v_next_sequence
  FROM public.verification_goal_events
  WHERE verification_goal_run_id = p_run_id;

  INSERT INTO public.verification_goal_events (
    verification_goal_run_id, event_sequence, phase, status
  ) VALUES (p_run_id, v_next_sequence, 'claimed', 'ok');
END;
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Lease renewal: CAS on generation + token, never extends a fenced row
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.forge_renew_verification_goal_run_lease_v1(
  p_run_id uuid,
  p_lease_generation bigint,
  p_lease_token uuid,
  p_lease_expires_at timestamp with time zone
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_affected integer;
BEGIN
  IF session_user <> 'forge' OR current_user <> 'forge_s4_routines_owner' THEN
    RAISE EXCEPTION 'verification goal run lease renewal requires the fixed Forge login'
      USING ERRCODE = '42501';
  END IF;
  IF p_lease_generation <= 0 OR p_lease_expires_at <= pg_catalog.clock_timestamp() THEN
    RAISE EXCEPTION 'verification goal run lease renewal parameters are invalid'
      USING ERRCODE = '22023';
  END IF;

  UPDATE public.verification_goal_runs
  SET lease_expires_at = p_lease_expires_at
  WHERE id = p_run_id
    AND status = 'running'
    AND lease_generation = p_lease_generation
    AND lease_token = p_lease_token
    AND lease_expires_at > pg_catalog.clock_timestamp();
  GET DIAGNOSTICS v_affected = ROW_COUNT;
  IF v_affected = 1 THEN
    RETURN 'renewed';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.verification_goal_runs
    WHERE id = p_run_id AND status = 'running'
  ) THEN
    RETURN 'not_owner';
  END IF;
  RETURN 'not_running';
END;
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Recovery fence: an expired running lease can never be reclaimed
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.forge_fence_verification_goal_run_recovery_v1(
  p_run_id uuid
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_run public.verification_goal_runs%ROWTYPE;
  v_horizon_seconds bigint;
  v_affected integer;
  v_next_sequence integer;
BEGIN
  IF session_user <> 'forge' OR current_user <> 'forge_s4_routines_owner' THEN
    RAISE EXCEPTION 'verification goal recovery fencing requires the fixed Forge login'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_run
  FROM public.verification_goal_runs
  WHERE id = p_run_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 'missing';
  END IF;
  IF v_run.status <> 'running' THEN
    RETURN 'not_running';
  END IF;
  IF v_run.lease_expires_at IS NULL OR v_run.lease_expires_at > pg_catalog.clock_timestamp() THEN
    RETURN 'still_owned';
  END IF;

  v_horizon_seconds := GREATEST(
    30::bigint,
    COALESCE((v_run.resolved_policy->>'effectiveDeadlineSeconds')::bigint, 60)
  );

  UPDATE public.verification_goal_runs
  SET status = 'recovery_required',
      lease_generation = NULL,
      lease_token = NULL,
      lease_expires_at = NULL,
      recovery_not_before = pg_catalog.clock_timestamp() + make_interval(
        secs => (v_horizon_seconds + 5)::double precision
      )
  WHERE id = p_run_id
    AND status = 'running'
    AND lease_expires_at <= pg_catalog.clock_timestamp();
  GET DIAGNOSTICS v_affected = ROW_COUNT;
  IF v_affected <> 1 THEN
    RETURN 'still_owned';
  END IF;

  SELECT COALESCE(max(event_sequence), 0) + 1 INTO v_next_sequence
  FROM public.verification_goal_events
  WHERE verification_goal_run_id = p_run_id;

  INSERT INTO public.verification_goal_events (
    verification_goal_run_id, event_sequence, phase, status, code
  ) VALUES (p_run_id, v_next_sequence, 'recovered', 'blocked', 'lease_lost');

  RETURN 'fenced';
END;
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Recovery completion: preserve evidence, finish inconclusive, never infer
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.forge_complete_verification_goal_recovery_v1(
  p_run_id uuid,
  p_goal_evidence_set_digest text,
  p_goal_evidence_unit_fingerprint text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_run public.verification_goal_runs%ROWTYPE;
  v_outcome_id uuid;
  v_affected integer;
  v_next_sequence integer;
BEGIN
  IF session_user <> 'forge' OR current_user <> 'forge_s4_routines_owner' THEN
    RAISE EXCEPTION 'verification goal recovery completion requires the fixed Forge login'
      USING ERRCODE = '42501';
  END IF;
  IF p_goal_evidence_set_digest !~ '^[0-9a-f]{64}$'
     OR p_goal_evidence_unit_fingerprint !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'verification goal recovery parameters are invalid'
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_run
  FROM public.verification_goal_runs
  WHERE id = p_run_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'verification goal run does not exist'
      USING ERRCODE = 'P1873';
  END IF;
  IF v_run.status <> 'recovery_required'
     OR v_run.recovery_not_before > pg_catalog.clock_timestamp()
     OR v_run.lease_token IS NOT NULL THEN
    RAISE EXCEPTION 'verification goal run is not ready for recovery completion'
      USING ERRCODE = 'P1872';
  END IF;

  INSERT INTO public.execution_outcomes (
    task_id, verification_goal_run_id, attempt_key, schema_version,
    transport_status, result, failure_class, retryable, evidence_refs,
    verifier_required, verification_status
  ) VALUES (
    NULL, p_run_id, 'verification-goal-recovery', 2,
    'ok', 'needs_attention', 'infrastructure', false, '[]'::jsonb,
    false, 'not_required'
  ) RETURNING id INTO v_outcome_id;

  UPDATE public.verification_goal_runs
  SET status = 'completed',
      result = 'inconclusive',
      terminal_code = 'lease_lost',
      overall_outcome_id = v_outcome_id,
      goal_evidence_set_digest = p_goal_evidence_set_digest,
      goal_evidence_unit_fingerprint = p_goal_evidence_unit_fingerprint,
      finished_at = pg_catalog.clock_timestamp()
  WHERE id = p_run_id AND status = 'recovery_required';
  GET DIAGNOSTICS v_affected = ROW_COUNT;
  IF v_affected <> 1 THEN
    RAISE EXCEPTION 'verification goal recovery completion lost the state race'
      USING ERRCODE = 'P1872';
  END IF;

  SELECT COALESCE(max(event_sequence), 0) + 1 INTO v_next_sequence
  FROM public.verification_goal_events
  WHERE verification_goal_run_id = p_run_id;

  INSERT INTO public.verification_goal_events (
    verification_goal_run_id, event_sequence, phase, status, code,
    evidence_ref
  ) VALUES (p_run_id, v_next_sequence, 'recovered', 'inconclusive', 'lease_lost', v_outcome_id);

  RETURN v_outcome_id;
END;
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Child finalization: lease-fenced outcome + operation-run terminalization
-- ---------------------------------------------------------------------------
-- Goal children extend the operation-run verification status domain: a child
-- can complete with no separate verifier gate ('not_required') or with an
-- inconclusive verification. Task-subject rows keep the original v1 domain.
-- The shared operation ledger is owned by the migration login, so temporarily
-- leave the protected-owner role for the exact CHECK replacement below.
RESET ROLE;
--> statement-breakpoint
ALTER TABLE "operation_runs"
DROP CONSTRAINT "operation_runs_verification_status_check";
--> statement-breakpoint
ALTER TABLE "operation_runs"
ADD CONSTRAINT "operation_runs_verification_status_check"
CHECK ("verification_status" IN ('not_started', 'passed', 'failed', 'not_required', 'inconclusive'));
--> statement-breakpoint
SET ROLE forge_s4_routines_owner;
--> statement-breakpoint

CREATE FUNCTION public.forge_finalize_verification_goal_child_operation_v1(
  p_run_id uuid,
  p_operation_run_id uuid,
  p_transport_status text,
  p_result text,
  p_failure_class text,
  p_retryable boolean,
  p_verification_status text,
  p_outcome_fingerprint text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_run public.verification_goal_runs%ROWTYPE;
  v_child public.operation_runs%ROWTYPE;
  v_status text;
  v_outcome_id uuid;
  v_affected integer;
  v_next_sequence integer;
BEGIN
  IF session_user <> 'forge' OR current_user <> 'forge_s4_routines_owner' THEN
    RAISE EXCEPTION 'verification goal child finalization requires the fixed Forge login'
      USING ERRCODE = '42501';
  END IF;
  IF p_transport_status NOT IN ('ok', 'error')
     OR p_result NOT IN ('completed', 'failed', 'needs_attention', 'blocked', 'cancelled')
     OR p_verification_status NOT IN ('not_required', 'passed', 'failed', 'inconclusive')
     OR p_outcome_fingerprint !~ '^[0-9a-f]{64}$'
     OR p_failure_class IS NOT NULL AND p_failure_class NOT IN (
       'functional', 'policy', 'authority', 'infrastructure', 'evidence', 'cancelled'
     ) THEN
    RAISE EXCEPTION 'verification goal child finalization parameters are invalid'
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_run
  FROM public.verification_goal_runs
  WHERE id = p_run_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'verification goal run does not exist'
      USING ERRCODE = 'P1873';
  END IF;
  IF v_run.status <> 'running'
     OR v_run.lease_token IS NULL
     OR v_run.lease_expires_at <= pg_catalog.clock_timestamp() THEN
    RAISE EXCEPTION 'verification goal run is not leased'
      USING ERRCODE = 'P1872';
  END IF;

  SELECT * INTO v_child
  FROM public.operation_runs
  WHERE id = p_operation_run_id
  FOR UPDATE;
  IF NOT FOUND
     OR v_child.verification_goal_run_id <> p_run_id
     OR v_child.status <> 'running'
     OR v_child.execution_outcome_id IS NOT NULL THEN
    RAISE EXCEPTION 'verification goal child operation is not finalizable'
      USING ERRCODE = 'P1873';
  END IF;

  v_status := CASE
    WHEN p_result = 'completed' THEN 'completed'
    WHEN p_result = 'failed' THEN 'failed'
    ELSE 'blocked'
  END;

  INSERT INTO public.execution_outcomes (
    task_id, verification_goal_run_id, attempt_key, schema_version,
    transport_status, result, failure_class, retryable, evidence_refs,
    verifier_required, verification_status
  ) VALUES (
    NULL, p_run_id, 'goal-child:' || v_child.goal_operation_ordinal::text, 2,
    p_transport_status, p_result, p_failure_class, p_retryable, '[]'::jsonb,
    (p_verification_status <> 'not_required'), p_verification_status
  ) RETURNING id INTO v_outcome_id;

  UPDATE public.operation_runs
  SET status = v_status,
      execution_outcome_id = v_outcome_id,
      verification_status = p_verification_status,
      outcome_fingerprint = p_outcome_fingerprint,
      completed_at = pg_catalog.clock_timestamp()
  WHERE id = p_operation_run_id
    AND status = 'running'
    AND execution_outcome_id IS NULL;
  GET DIAGNOSTICS v_affected = ROW_COUNT;
  IF v_affected <> 1 THEN
    RAISE EXCEPTION 'verification goal child finalization lost the state race'
      USING ERRCODE = 'P1872';
  END IF;

  SELECT COALESCE(max(event_sequence), 0) + 1 INTO v_next_sequence
  FROM public.verification_goal_events
  WHERE verification_goal_run_id = p_run_id;

  INSERT INTO public.verification_goal_events (
    verification_goal_run_id, event_sequence, phase, status, operation_run_id,
    evidence_ref
  ) VALUES (
    p_run_id, v_next_sequence,
    'child_completed',
    CASE WHEN p_result = 'completed' THEN 'ok' ELSE 'inconclusive' END,
    p_operation_run_id, v_outcome_id
  );

  RETURN v_outcome_id;
END;
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Repository snapshot recording (lease-fenced, idempotent replay)
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.forge_record_verification_goal_repository_snapshot_v1(
  p_run_id uuid,
  p_project_submitted_by uuid,
  p_project_revision timestamp with time zone,
  p_root_binding_revision bigint,
  p_grant_decision_revision bigint,
  p_object_format text,
  p_head_oid text,
  p_strict_git_clean boolean,
  p_git_metadata_fingerprint text,
  p_index_fingerprint text,
  p_config_fingerprint text,
  p_repository_snapshot_fingerprint text
)
RETURNS TABLE (snapshot_id uuid, state text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_run public.verification_goal_runs%ROWTYPE;
  v_existing uuid;
  v_new_id uuid;
  v_next_sequence integer;
BEGIN
  IF session_user <> 'forge' OR current_user <> 'forge_s4_routines_owner' THEN
    RAISE EXCEPTION 'verification goal snapshot recording requires the fixed Forge login'
      USING ERRCODE = '42501';
  END IF;
  IF p_repository_snapshot_fingerprint !~ '^[0-9a-f]{64}$'
     OR p_root_binding_revision <= 0
     OR p_grant_decision_revision <= 0 THEN
    RAISE EXCEPTION 'verification goal repository snapshot parameters are invalid'
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_run
  FROM public.verification_goal_runs
  WHERE id = p_run_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'verification goal run does not exist'
      USING ERRCODE = 'P1873';
  END IF;
  IF v_run.status <> 'running'
     OR v_run.lease_token IS NULL
     OR v_run.lease_expires_at <= pg_catalog.clock_timestamp() THEN
    RAISE EXCEPTION 'verification goal run is not leased'
      USING ERRCODE = 'P1872';
  END IF;

  SELECT id INTO v_existing
  FROM public.verification_goal_repository_snapshots
  WHERE verification_goal_run_id = p_run_id;
  IF FOUND THEN
    snapshot_id := v_existing;
    state := 'existing';
    RETURN NEXT;
    RETURN;
  END IF;

  INSERT INTO public.verification_goal_repository_snapshots (
    verification_goal_run_id, project_id, project_submitted_by,
    project_revision, root_binding_revision, grant_decision_revision,
    object_format, head_oid, strict_git_clean, git_metadata_fingerprint,
    index_fingerprint, config_fingerprint, repository_snapshot_fingerprint,
    captured_at
  ) VALUES (
    p_run_id, v_run.project_id, p_project_submitted_by,
    p_project_revision, p_root_binding_revision, p_grant_decision_revision,
    p_object_format, p_head_oid, p_strict_git_clean, p_git_metadata_fingerprint,
    p_index_fingerprint, p_config_fingerprint, p_repository_snapshot_fingerprint,
    pg_catalog.clock_timestamp()
  ) RETURNING id INTO v_new_id;

  SELECT COALESCE(max(event_sequence), 0) + 1 INTO v_next_sequence
  FROM public.verification_goal_events
  WHERE verification_goal_run_id = p_run_id;

  INSERT INTO public.verification_goal_events (
    verification_goal_run_id, event_sequence, phase, status, repository_snapshot_id
  ) VALUES (p_run_id, v_next_sequence, 'repository_captured', 'ok', v_new_id);

  snapshot_id := v_new_id;
  state := 'created';
  RETURN NEXT;
END;
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Environment snapshot recording (lease-fenced, idempotent replay)
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.forge_record_verification_goal_environment_snapshot_v1(
  p_run_id uuid,
  p_schema_version integer,
  p_runner_contract_version integer,
  p_forge_build_identity text,
  p_release_state_class text,
  p_root_launcher_contract_version integer,
  p_root_launcher_digest text,
  p_trusted_node_identity_digest text,
  p_trusted_node_version text,
  p_trusted_git_identity_digest text,
  p_trusted_git_version text,
  p_git_safety_profile_version integer,
  p_git_safety_profile_digest text,
  p_platform text,
  p_architecture text,
  p_operation_execution_binding_digest text,
  p_eligibility_version integer,
  p_eligibility_digest text,
  p_environment_fingerprint text
)
RETURNS TABLE (snapshot_id uuid, state text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_run public.verification_goal_runs%ROWTYPE;
  v_existing uuid;
  v_new_id uuid;
  v_next_sequence integer;
BEGIN
  IF session_user <> 'forge' OR current_user <> 'forge_s4_routines_owner' THEN
    RAISE EXCEPTION 'verification goal snapshot recording requires the fixed Forge login'
      USING ERRCODE = '42501';
  END IF;
  IF p_environment_fingerprint !~ '^[0-9a-f]{64}$'
     OR p_root_launcher_digest !~ '^[0-9a-f]{64}$'
     OR p_trusted_node_identity_digest !~ '^[0-9a-f]{64}$'
     OR p_trusted_git_identity_digest !~ '^[0-9a-f]{64}$'
     OR p_git_safety_profile_digest !~ '^[0-9a-f]{64}$'
     OR p_operation_execution_binding_digest !~ '^[0-9a-f]{64}$'
     OR p_eligibility_digest !~ '^[0-9a-f]{64}$'
     OR p_schema_version <= 0
     OR p_runner_contract_version <= 0
     OR p_root_launcher_contract_version <= 0
     OR p_git_safety_profile_version <= 0
     OR p_eligibility_version <= 0 THEN
    RAISE EXCEPTION 'verification goal environment snapshot parameters are invalid'
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_run
  FROM public.verification_goal_runs
  WHERE id = p_run_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'verification goal run does not exist'
      USING ERRCODE = 'P1873';
  END IF;
  IF v_run.status <> 'running'
     OR v_run.lease_token IS NULL
     OR v_run.lease_expires_at <= pg_catalog.clock_timestamp() THEN
    RAISE EXCEPTION 'verification goal run is not leased'
      USING ERRCODE = 'P1872';
  END IF;

  SELECT id INTO v_existing
  FROM public.verification_goal_environment_snapshots
  WHERE verification_goal_run_id = p_run_id;
  IF FOUND THEN
    snapshot_id := v_existing;
    state := 'existing';
    RETURN NEXT;
    RETURN;
  END IF;

  INSERT INTO public.verification_goal_environment_snapshots (
    verification_goal_run_id, project_id, schema_version, runner_contract_version,
    forge_build_identity, release_state_class, root_launcher_contract_version,
    root_launcher_digest, trusted_node_identity_digest, trusted_node_version,
    trusted_git_identity_digest, trusted_git_version, git_safety_profile_version,
    git_safety_profile_digest, platform, architecture,
    operation_execution_binding_digest, eligibility_version, eligibility_digest,
    environment_fingerprint, captured_at
  ) VALUES (
    p_run_id, v_run.project_id, p_schema_version, p_runner_contract_version,
    p_forge_build_identity, p_release_state_class, p_root_launcher_contract_version,
    p_root_launcher_digest, p_trusted_node_identity_digest, p_trusted_node_version,
    p_trusted_git_identity_digest, p_trusted_git_version, p_git_safety_profile_version,
    p_git_safety_profile_digest, p_platform, p_architecture,
    p_operation_execution_binding_digest, p_eligibility_version, p_eligibility_digest,
    p_environment_fingerprint, pg_catalog.clock_timestamp()
  ) RETURNING id INTO v_new_id;

  SELECT COALESCE(max(event_sequence), 0) + 1 INTO v_next_sequence
  FROM public.verification_goal_events
  WHERE verification_goal_run_id = p_run_id;

  INSERT INTO public.verification_goal_events (
    verification_goal_run_id, event_sequence, phase, status, environment_snapshot_id
  ) VALUES (p_run_id, v_next_sequence, 'environment_captured', 'ok', v_new_id);

  snapshot_id := v_new_id;
  state := 'created';
  RETURN NEXT;
END;
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Queue expiry
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.forge_expire_verification_goal_run_v1(
  p_run_id uuid
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_run public.verification_goal_runs%ROWTYPE;
  v_affected integer;
  v_next_sequence integer;
BEGIN
  IF session_user <> 'forge' OR current_user <> 'forge_s4_routines_owner' THEN
    RAISE EXCEPTION 'verification goal expiry requires the fixed Forge login'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_run
  FROM public.verification_goal_runs
  WHERE id = p_run_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 'missing';
  END IF;
  IF v_run.status <> 'queued' THEN
    RETURN 'not_queued';
  END IF;
  IF v_run.admission_expiry > pg_catalog.clock_timestamp() THEN
    RETURN 'not_due';
  END IF;

  UPDATE public.verification_goal_runs
  SET status = 'expired',
      terminal_code = 'dispatch_expired',
      finished_at = pg_catalog.clock_timestamp()
  WHERE id = p_run_id AND status = 'queued';
  GET DIAGNOSTICS v_affected = ROW_COUNT;
  IF v_affected <> 1 THEN
    RETURN 'not_queued';
  END IF;

  SELECT COALESCE(max(event_sequence), 0) + 1 INTO v_next_sequence
  FROM public.verification_goal_events
  WHERE verification_goal_run_id = p_run_id;

  INSERT INTO public.verification_goal_events (
    verification_goal_run_id, event_sequence, phase, status, code
  ) VALUES (p_run_id, v_next_sequence, 'expired', 'blocked', 'dispatch_expired');

  RETURN 'expired';
END;
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Redis delivery marker (idempotent)
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.forge_mark_verification_goal_run_dispatched_v1(
  p_run_id uuid
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_affected integer;
BEGIN
  IF session_user <> 'forge' OR current_user <> 'forge_s4_routines_owner' THEN
    RAISE EXCEPTION 'verification goal dispatch marking requires the fixed Forge login'
      USING ERRCODE = '42501';
  END IF;

  UPDATE public.verification_goal_runs
  SET redis_dispatched_at = pg_catalog.clock_timestamp()
  WHERE id = p_run_id
    AND status = 'queued'
    AND redis_dispatched_at IS NULL;
  GET DIAGNOSTICS v_affected = ROW_COUNT;
  IF v_affected = 1 THEN
    RETURN 'dispatched';
  END IF;

  IF EXISTS (SELECT 1 FROM public.verification_goal_runs WHERE id = p_run_id) THEN
    RETURN 'already_marked';
  END IF;
  RETURN 'missing';
END;
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Terminalization v2: prefix validation + atomic overall outcome
-- ---------------------------------------------------------------------------
-- The unreleased 0035 terminalizer accepted a caller-supplied overall outcome
-- and did not validate the child prefix; it is replaced here by the atomic
-- v2 terminalizer so exactly one terminalization write path exists.
DROP FUNCTION public.forge_terminalize_verification_goal_run_v1(
  uuid, text, text, uuid, text, text
);
--> statement-breakpoint

CREATE FUNCTION public.forge_terminalize_verification_goal_run_v2(
  p_run_id uuid,
  p_result text,
  p_terminal_code text,
  p_goal_evidence_set_digest text,
  p_goal_evidence_unit_fingerprint text,
  p_failure_class text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_run public.verification_goal_runs%ROWTYPE;
  v_expected integer;
  v_completed_count integer;
  v_blocked_count integer;
  v_failed_count integer;
  v_child_count integer;
  v_last_status text;
  v_outcome_result text;
  v_outcome_id uuid;
  v_affected integer;
  v_next_sequence integer;
BEGIN
  IF session_user <> 'forge' OR current_user <> 'forge_s4_routines_owner' THEN
    RAISE EXCEPTION 'verification goal terminalization requires the fixed Forge login'
      USING ERRCODE = '42501';
  END IF;
  IF p_result NOT IN ('passed', 'failed', 'inconclusive')
     OR p_terminal_code IS NULL
     OR p_goal_evidence_set_digest !~ '^[0-9a-f]{64}$'
     OR p_goal_evidence_unit_fingerprint !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'verification goal terminalization parameters are invalid'
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_run
  FROM public.verification_goal_runs
  WHERE id = p_run_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'verification goal run does not exist'
      USING ERRCODE = 'P1873';
  END IF;
  IF v_run.status <> 'running'
     OR v_run.lease_token IS NULL
     OR v_run.lease_expires_at <= pg_catalog.clock_timestamp() THEN
    RAISE EXCEPTION 'verification goal run is not leased'
      USING ERRCODE = 'P1872';
  END IF;

  SELECT count(*),
         count(*) FILTER (WHERE status = 'completed'),
         count(*) FILTER (WHERE status = 'blocked'),
         count(*) FILTER (WHERE status = 'failed')
  INTO v_child_count, v_completed_count, v_blocked_count, v_failed_count
  FROM public.operation_runs
  WHERE verification_goal_run_id = p_run_id;

  v_expected := COALESCE(
    jsonb_array_length(v_run.resolved_policy->'canonicalOperationOrdinals'),
    0
  );

  SELECT status INTO v_last_status
  FROM public.operation_runs
  WHERE verification_goal_run_id = p_run_id
  ORDER BY goal_operation_ordinal DESC
  LIMIT 1;

  IF p_result = 'passed' THEN
    IF v_child_count <> v_expected OR v_completed_count <> v_expected THEN
      RAISE EXCEPTION 'verification goal passed terminalization requires every ordinal to be completed'
        USING ERRCODE = 'P1873';
    END IF;
    v_outcome_result := 'completed';
  ELSIF p_result = 'failed' THEN
    IF v_failed_count <> 1
       OR v_completed_count + 1 <> v_child_count
       OR v_last_status <> 'failed' THEN
      RAISE EXCEPTION 'verification goal failed terminalization requires one functional trailing failure'
        USING ERRCODE = 'P1873';
    END IF;
    v_outcome_result := 'failed';
  ELSE
    IF v_child_count = 0 THEN
      NULL;
    ELSIF v_completed_count = v_child_count
       OR (v_completed_count + 1 = v_child_count AND v_last_status = 'blocked') THEN
      NULL;
    ELSE
      RAISE EXCEPTION 'verification goal inconclusive terminalization requires a valid child prefix'
        USING ERRCODE = 'P1873';
    END IF;
    v_outcome_result := 'needs_attention';
  END IF;

  INSERT INTO public.execution_outcomes (
    task_id, verification_goal_run_id, attempt_key, schema_version,
    transport_status, result, failure_class, retryable, evidence_refs,
    verifier_required, verification_status
  ) VALUES (
    NULL, p_run_id, 'verification-goal-run', 2,
    'ok', v_outcome_result, p_failure_class, false, '[]'::jsonb,
    false, 'not_required'
  ) RETURNING id INTO v_outcome_id;

  UPDATE public.verification_goal_runs
  SET status = 'completed',
      result = p_result,
      terminal_code = p_terminal_code,
      overall_outcome_id = v_outcome_id,
      goal_evidence_set_digest = p_goal_evidence_set_digest,
      goal_evidence_unit_fingerprint = p_goal_evidence_unit_fingerprint,
      finished_at = pg_catalog.clock_timestamp(),
      lease_generation = NULL,
      lease_token = NULL,
      lease_expires_at = NULL
  WHERE id = p_run_id
    AND status = 'running'
    AND lease_token = v_run.lease_token;
  GET DIAGNOSTICS v_affected = ROW_COUNT;
  IF v_affected <> 1 THEN
    RAISE EXCEPTION 'verification goal run terminalization lost the lease race'
      USING ERRCODE = 'P1872';
  END IF;

  SELECT COALESCE(max(event_sequence), 0) + 1 INTO v_next_sequence
  FROM public.verification_goal_events
  WHERE verification_goal_run_id = p_run_id;

  INSERT INTO public.verification_goal_events (
    verification_goal_run_id, event_sequence, phase, status, code, evidence_ref
  ) VALUES (
    p_run_id, v_next_sequence, 'terminalized',
    CASE p_result WHEN 'passed' THEN 'ok' WHEN 'failed' THEN 'failed' ELSE 'inconclusive' END,
    p_terminal_code, v_outcome_id
  );

  RETURN v_outcome_id;
END;
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Schedule binding reconciliation
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.forge_reconcile_verification_goal_schedule_binding_v1(
  p_project_id uuid,
  p_goal_id text,
  p_binding_fingerprint text,
  p_registry_revision_id uuid,
  p_registry_entry_ordinal integer,
  p_snapshot_id uuid,
  p_definition_version integer,
  p_definition_digest text,
  p_execution_binding_digest text,
  p_policy_revision_id uuid,
  p_policy_revision_sequence bigint,
  p_interval_seconds bigint,
  p_anchor_at timestamp with time zone,
  p_enabled boolean
)
RETURNS TABLE (schedule_binding_id uuid, state text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_head public.verification_goal_schedule_heads%ROWTYPE;
  v_head_exists boolean;
  v_policy public.verification_goal_policy_revisions%ROWTYPE;
  v_entry public.verification_goal_registry_entries%ROWTYPE;
  v_snapshot public.verification_goal_snapshots%ROWTYPE;
  v_new_id uuid;
  v_affected integer;
BEGIN
  IF session_user <> 'forge' OR current_user <> 'forge_s4_routines_owner' THEN
    RAISE EXCEPTION 'verification goal schedule reconciliation requires the fixed Forge login'
      USING ERRCODE = '42501';
  END IF;

  PERFORM 1 FROM public.projects
  WHERE id = p_project_id AND archived_at IS NULL
  FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'verification goal schedule project is unavailable'
      USING ERRCODE = 'P1871';
  END IF;

  SELECT * INTO v_head
  FROM public.verification_goal_schedule_heads
  WHERE project_id = p_project_id AND goal_id = p_goal_id
  FOR UPDATE;
  v_head_exists := FOUND;

  IF NOT p_enabled THEN
    IF v_head_exists AND v_head.schedule_binding_id IS NOT NULL THEN
      UPDATE public.verification_goal_schedule_heads
      SET schedule_binding_id = NULL,
          binding_fingerprint = NULL,
          updated_at = pg_catalog.clock_timestamp()
      WHERE project_id = p_project_id
        AND goal_id = p_goal_id
        AND schedule_binding_id = v_head.schedule_binding_id;
      GET DIAGNOSTICS v_affected = ROW_COUNT;
      IF v_affected <> 1 THEN
        RAISE EXCEPTION 'verification goal schedule head changed'
          USING ERRCODE = 'P1872';
      END IF;
      schedule_binding_id := NULL;
      state := 'disabled';
      RETURN NEXT;
      RETURN;
    END IF;
    schedule_binding_id := NULL;
    state := 'disabled_unchanged';
    RETURN NEXT;
    RETURN;
  END IF;

  IF p_binding_fingerprint !~ '^[0-9a-f]{64}$'
     OR p_execution_binding_digest !~ '^[0-9a-f]{64}$'
     OR p_interval_seconds <= 0 THEN
    RAISE EXCEPTION 'verification goal schedule binding parameters are invalid'
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_policy
  FROM public.verification_goal_policy_revisions
  WHERE id = p_policy_revision_id
    AND project_id = p_project_id
    AND revision_sequence = p_policy_revision_sequence
  FOR SHARE;
  IF NOT FOUND
     OR NOT EXISTS (
       SELECT 1 FROM public.verification_goal_policy_heads
       WHERE project_id = p_project_id
         AND policy_revision_id = p_policy_revision_id
     )
     OR NOT v_policy.scheduling_enabled THEN
    RAISE EXCEPTION 'verification goal schedule policy is not current or enabled'
      USING ERRCODE = 'P1873';
  END IF;
  IF p_interval_seconds < v_policy.min_schedule_interval_seconds THEN
    RAISE EXCEPTION 'verification goal schedule interval is below the policy minimum'
      USING ERRCODE = 'P1873';
  END IF;

  SELECT * INTO v_entry
  FROM public.verification_goal_registry_entries
  WHERE registry_revision_id = p_registry_revision_id
    AND ordinal = p_registry_entry_ordinal
  FOR SHARE;
  IF NOT FOUND
     OR v_entry.project_id <> p_project_id
     OR v_entry.goal_id <> p_goal_id
     OR v_entry.snapshot_id <> p_snapshot_id
     OR v_entry.definition_version <> p_definition_version
     OR v_entry.definition_digest <> p_definition_digest
     OR v_entry.execution_binding_digest IS DISTINCT FROM p_execution_binding_digest
     OR NOT EXISTS (
       SELECT 1 FROM public.verification_goal_registry_heads
       WHERE project_id = p_project_id
         AND registry_revision_id = p_registry_revision_id
     ) THEN
    RAISE EXCEPTION 'verification goal schedule registry entry changed'
      USING ERRCODE = 'P1873';
  END IF;

  SELECT * INTO v_snapshot
  FROM public.verification_goal_snapshots
  WHERE id = p_snapshot_id
  FOR SHARE;
  IF NOT FOUND
     OR v_snapshot.canonical_definition->>'schemaVersion' <> '2'
     OR v_snapshot.canonical_definition->>'enabled' <> 'true'
     OR v_snapshot.canonical_definition->'execution'->'schedule'->>'kind'
        IS DISTINCT FROM 'interval'
     OR (v_snapshot.canonical_definition->'execution'->'schedule'->>'everySeconds')::bigint
        IS DISTINCT FROM p_interval_seconds THEN
    RAISE EXCEPTION 'verification goal schedule declaration changed'
      USING ERRCODE = 'P1873';
  END IF;

  IF v_head_exists AND v_head.schedule_binding_id IS NOT NULL
     AND v_head.binding_fingerprint = p_binding_fingerprint THEN
    schedule_binding_id := v_head.schedule_binding_id;
    state := 'unchanged';
    RETURN NEXT;
    RETURN;
  END IF;

  INSERT INTO public.verification_goal_schedule_bindings (
    project_id, registry_revision_id, registry_entry_ordinal, snapshot_id,
    goal_id, definition_version, definition_digest, execution_binding_digest,
    policy_revision_id, policy_revision_sequence, interval_seconds,
    anchor_at, binding_fingerprint
  ) VALUES (
    p_project_id, p_registry_revision_id, p_registry_entry_ordinal, p_snapshot_id,
    p_goal_id, p_definition_version, p_definition_digest, p_execution_binding_digest,
    p_policy_revision_id, p_policy_revision_sequence, p_interval_seconds,
    p_anchor_at, p_binding_fingerprint
  ) RETURNING id INTO v_new_id;

  IF v_head_exists THEN
    UPDATE public.verification_goal_schedule_heads
    SET schedule_binding_id = v_new_id,
        binding_fingerprint = p_binding_fingerprint,
        updated_at = pg_catalog.clock_timestamp()
    WHERE project_id = p_project_id
      AND goal_id = p_goal_id;
    GET DIAGNOSTICS v_affected = ROW_COUNT;
    IF v_affected <> 1 THEN
      RAISE EXCEPTION 'verification goal schedule head changed'
        USING ERRCODE = 'P1872';
    END IF;
  ELSE
    INSERT INTO public.verification_goal_schedule_heads (
      project_id, goal_id, schedule_binding_id, binding_fingerprint
    ) VALUES (p_project_id, p_goal_id, v_new_id, p_binding_fingerprint);
  END IF;

  schedule_binding_id := v_new_id;
  state := 'advanced';
  RETURN NEXT;
END;
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Schedule slot claim: current-slot-only, capacity-checked, race-free
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.forge_claim_verification_goal_schedule_slot_v1(
  p_schedule_binding_id uuid,
  p_slot_sequence bigint,
  p_due_at timestamp with time zone,
  p_resolved_policy jsonb,
  p_resolved_policy_fingerprint text,
  p_admission_expiry timestamp with time zone,
  p_authority_fingerprint text
)
RETURNS TABLE (run_id uuid, state text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_binding public.verification_goal_schedule_bindings%ROWTYPE;
  v_head public.verification_goal_schedule_heads%ROWTYPE;
  v_entry public.verification_goal_registry_entries%ROWTYPE;
  v_now timestamp with time zone;
  v_current_slot bigint;
  v_slot_id uuid;
  v_admitted public.verification_goal_runs.id%TYPE;
  v_state text;
BEGIN
  IF session_user <> 'forge' OR current_user <> 'forge_s4_routines_owner' THEN
    RAISE EXCEPTION 'verification goal schedule slot claim requires the fixed Forge login'
      USING ERRCODE = '42501';
  END IF;
  IF p_slot_sequence < 0
     OR p_resolved_policy_fingerprint !~ '^[0-9a-f]{64}$'
     OR p_authority_fingerprint !~ '^[0-9a-f]{64}$'
     OR p_admission_expiry <= pg_catalog.clock_timestamp() THEN
    RAISE EXCEPTION 'verification goal schedule slot parameters are invalid'
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_binding
  FROM public.verification_goal_schedule_bindings
  WHERE id = p_schedule_binding_id
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'verification goal schedule binding does not exist'
      USING ERRCODE = 'P1873';
  END IF;

  PERFORM 1 FROM public.projects
  WHERE id = v_binding.project_id AND archived_at IS NULL
  FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'verification goal schedule project is unavailable'
      USING ERRCODE = 'P1871';
  END IF;

  SELECT * INTO v_head
  FROM public.verification_goal_schedule_heads
  WHERE project_id = v_binding.project_id
    AND goal_id = v_binding.goal_id
  FOR UPDATE;
  IF NOT FOUND
     OR v_head.schedule_binding_id <> p_schedule_binding_id THEN
    RAISE EXCEPTION 'verification goal schedule binding is not current'
      USING ERRCODE = 'P1873';
  END IF;

  v_now := pg_catalog.clock_timestamp();
  v_current_slot := floor(
    pg_catalog.extract(epoch, v_now - v_binding.anchor_at) / v_binding.interval_seconds
  )::bigint;
  IF p_slot_sequence <> v_current_slot THEN
    state := 'not_current_slot';
    RETURN NEXT;
    RETURN;
  END IF;

  INSERT INTO public.verification_goal_schedule_slots (
    schedule_binding_id, slot_sequence, due_at
  ) VALUES (p_schedule_binding_id, p_slot_sequence, p_due_at)
  ON CONFLICT (schedule_binding_id, slot_sequence) DO NOTHING
  RETURNING id INTO v_slot_id;
  IF v_slot_id IS NULL THEN
    state := 'slot_taken';
    RETURN NEXT;
    RETURN;
  END IF;

  SELECT * INTO v_entry
  FROM public.verification_goal_registry_entries
  WHERE registry_revision_id = v_binding.registry_revision_id
    AND ordinal = v_binding.registry_entry_ordinal;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'verification goal schedule registry entry is missing'
      USING ERRCODE = 'P1873';
  END IF;

  BEGIN
    SELECT admission.run_id, admission.state
    INTO v_admitted, v_state
    FROM public.forge_admit_verification_goal_run_v1(
      v_binding.project_id,
      v_binding.registry_revision_id,
      v_binding.registry_entry_ordinal,
      v_binding.snapshot_id,
      v_binding.goal_id,
      v_binding.definition_version,
      v_binding.definition_digest,
      v_entry.source_path,
      v_binding.execution_binding_digest,
      v_binding.policy_revision_id,
      v_binding.policy_revision_sequence,
      p_resolved_policy,
      p_resolved_policy_fingerprint,
      'scheduled',
      NULL::uuid,
      NULL::uuid,
      NULL::text,
      p_schedule_binding_id,
      v_slot_id,
      p_admission_expiry,
      p_authority_fingerprint
    ) AS admission;
  EXCEPTION
    WHEN unique_violation THEN
      RAISE EXCEPTION 'verification goal schedule admission is not unique'
        USING ERRCODE = 'P1876';
    WHEN SQLSTATE 'P1874' THEN
      -- Capacity/active-run limits were reached: keep the claimed slot row as a
      -- permanent skip record so the missed interval is never replayed, and
      -- report the block without a run.
      state := 'capacity_blocked';
      RETURN NEXT;
      RETURN;
  END;

  UPDATE public.verification_goal_schedule_slots
  SET run_id = v_admitted
  WHERE id = v_slot_id AND run_id IS NULL;

  run_id := v_admitted;
  state := 'admitted';
  RETURN NEXT;
END;
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Ownership and ACL
-- ---------------------------------------------------------------------------
ALTER FUNCTION public.forge_admit_verification_goal_run_v1(
  uuid, uuid, integer, uuid, text, integer, text, text, text, uuid, bigint,
  jsonb, text, text, uuid, uuid, text, uuid, uuid, timestamptz, text
) OWNER TO forge_s4_routines_owner;
ALTER FUNCTION public.forge_claim_verification_goal_run_lease_v1(uuid, bigint, uuid, timestamptz)
  OWNER TO forge_s4_routines_owner;
ALTER FUNCTION public.forge_renew_verification_goal_run_lease_v1(uuid, bigint, uuid, timestamptz)
  OWNER TO forge_s4_routines_owner;
ALTER FUNCTION public.forge_fence_verification_goal_run_recovery_v1(uuid)
  OWNER TO forge_s4_routines_owner;
ALTER FUNCTION public.forge_complete_verification_goal_recovery_v1(uuid, text, text)
  OWNER TO forge_s4_routines_owner;
ALTER FUNCTION public.forge_finalize_verification_goal_child_operation_v1(
  uuid, uuid, text, text, text, boolean, text, text
) OWNER TO forge_s4_routines_owner;
ALTER FUNCTION public.forge_record_verification_goal_repository_snapshot_v1(
  uuid, uuid, timestamptz, bigint, bigint, text, text, boolean, text, text, text, text
) OWNER TO forge_s4_routines_owner;
ALTER FUNCTION public.forge_record_verification_goal_environment_snapshot_v1(
  uuid, integer, integer, text, text, integer, text, text, text, text, text,
  integer, text, text, text, text, integer, text, text
) OWNER TO forge_s4_routines_owner;
ALTER FUNCTION public.forge_expire_verification_goal_run_v1(uuid)
  OWNER TO forge_s4_routines_owner;
ALTER FUNCTION public.forge_mark_verification_goal_run_dispatched_v1(uuid)
  OWNER TO forge_s4_routines_owner;
ALTER FUNCTION public.forge_terminalize_verification_goal_run_v2(
  uuid, text, text, text, text, text
) OWNER TO forge_s4_routines_owner;
ALTER FUNCTION public.forge_reconcile_verification_goal_schedule_binding_v1(
  uuid, text, text, uuid, integer, uuid, integer, text, text, uuid, bigint,
  bigint, timestamptz, boolean
) OWNER TO forge_s4_routines_owner;
ALTER FUNCTION public.forge_claim_verification_goal_schedule_slot_v1(
  uuid, bigint, timestamptz, jsonb, text, timestamptz, text
) OWNER TO forge_s4_routines_owner;
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.forge_admit_verification_goal_run_v1(
  uuid, uuid, integer, uuid, text, integer, text, text, text, uuid, bigint,
  jsonb, text, text, uuid, uuid, text, uuid, uuid, timestamptz, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.forge_claim_verification_goal_run_lease_v1(uuid, bigint, uuid, timestamptz)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.forge_renew_verification_goal_run_lease_v1(uuid, bigint, uuid, timestamptz)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.forge_fence_verification_goal_run_recovery_v1(uuid)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.forge_complete_verification_goal_recovery_v1(uuid, text, text)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.forge_finalize_verification_goal_child_operation_v1(
  uuid, uuid, text, text, text, boolean, text, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.forge_record_verification_goal_repository_snapshot_v1(
  uuid, uuid, timestamptz, bigint, bigint, text, text, boolean, text, text, text, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.forge_record_verification_goal_environment_snapshot_v1(
  uuid, integer, integer, text, text, integer, text, text, text, text, text,
  integer, text, text, text, text, integer, text, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.forge_expire_verification_goal_run_v1(uuid)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.forge_mark_verification_goal_run_dispatched_v1(uuid)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.forge_terminalize_verification_goal_run_v2(
  uuid, text, text, text, text, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.forge_reconcile_verification_goal_schedule_binding_v1(
  uuid, text, text, uuid, integer, uuid, integer, text, text, uuid, bigint,
  bigint, timestamptz, boolean
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.forge_claim_verification_goal_schedule_slot_v1(
  uuid, bigint, timestamptz, jsonb, text, timestamptz, text
) FROM PUBLIC;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION public.forge_admit_verification_goal_run_v1(
  uuid, uuid, integer, uuid, text, integer, text, text, text, uuid, bigint,
  jsonb, text, text, uuid, uuid, text, uuid, uuid, timestamptz, text
) TO forge;
GRANT EXECUTE ON FUNCTION public.forge_claim_verification_goal_run_lease_v1(uuid, bigint, uuid, timestamptz)
  TO forge;
GRANT EXECUTE ON FUNCTION public.forge_renew_verification_goal_run_lease_v1(uuid, bigint, uuid, timestamptz)
  TO forge;
GRANT EXECUTE ON FUNCTION public.forge_fence_verification_goal_run_recovery_v1(uuid)
  TO forge;
GRANT EXECUTE ON FUNCTION public.forge_complete_verification_goal_recovery_v1(uuid, text, text)
  TO forge;
GRANT EXECUTE ON FUNCTION public.forge_finalize_verification_goal_child_operation_v1(
  uuid, uuid, text, text, text, boolean, text, text
) TO forge;
GRANT EXECUTE ON FUNCTION public.forge_record_verification_goal_repository_snapshot_v1(
  uuid, uuid, timestamptz, bigint, bigint, text, text, boolean, text, text, text, text
) TO forge;
GRANT EXECUTE ON FUNCTION public.forge_record_verification_goal_environment_snapshot_v1(
  uuid, integer, integer, text, text, integer, text, text, text, text, text,
  integer, text, text, text, text, integer, text, text
) TO forge;
GRANT EXECUTE ON FUNCTION public.forge_expire_verification_goal_run_v1(uuid)
  TO forge;
GRANT EXECUTE ON FUNCTION public.forge_mark_verification_goal_run_dispatched_v1(uuid)
  TO forge;
GRANT EXECUTE ON FUNCTION public.forge_terminalize_verification_goal_run_v2(
  uuid, text, text, text, text, text
) TO forge;
GRANT EXECUTE ON FUNCTION public.forge_reconcile_verification_goal_schedule_binding_v1(
  uuid, text, text, uuid, integer, uuid, integer, text, text, uuid, bigint,
  bigint, timestamptz, boolean
) TO forge;
GRANT EXECUTE ON FUNCTION public.forge_claim_verification_goal_schedule_slot_v1(
  uuid, bigint, timestamptz, jsonb, text, timestamptz, text
) TO forge;
--> statement-breakpoint

RESET ROLE;
--> statement-breakpoint
SELECT public.forge_finalize_epic_172_s4_owner_bootstrap_v1();
