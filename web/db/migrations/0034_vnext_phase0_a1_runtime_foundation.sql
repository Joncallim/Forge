-- VNext Phase 0 / #334 Slice A1: additive generic-runtime authority foundation.
-- Existing Task/Project state remains authoritative until later slices perform
-- the explicitly fenced compatibility migration. No legacy rows are backfilled
-- or projected by this migration.
SELECT public.forge_begin_epic_172_s4_owner_bootstrap_v1();
--> statement-breakpoint
SET ROLE forge_s4_routines_owner;
--> statement-breakpoint
CREATE TABLE missions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_principal_type text NOT NULL,
  owner_principal_id uuid NOT NULL,
  desired_outcome_digest text NOT NULL,
  constraints_digest text NOT NULL,
  compatibility_pins jsonb NOT NULL,
  lifecycle_state text NOT NULL DEFAULT 'active',
  outcome text,
  state_revision bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  terminal_at timestamptz,
  CONSTRAINT missions_owner_type_chk CHECK (owner_principal_type IN ('user', 'service', 'workspace', 'operator')),
  CONSTRAINT missions_digest_chk CHECK (desired_outcome_digest ~ '^[0-9a-f]{64}$' AND constraints_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT missions_pins_chk CHECK (jsonb_typeof(compatibility_pins) = 'object'),
  CONSTRAINT missions_lifecycle_chk CHECK (lifecycle_state IN ('active', 'paused', 'terminal')),
  CONSTRAINT missions_outcome_chk CHECK (outcome IS NULL OR outcome IN ('succeeded', 'failed', 'cancelled')),
  CONSTRAINT missions_terminal_tuple_chk CHECK (
    (lifecycle_state = 'terminal' AND outcome IS NOT NULL AND terminal_at IS NOT NULL)
    OR (lifecycle_state <> 'terminal' AND outcome IS NULL AND terminal_at IS NULL)
  ),
  CONSTRAINT missions_revision_chk CHECK (state_revision >= 0)
);
--> statement-breakpoint
CREATE TABLE executions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mission_id uuid NOT NULL REFERENCES missions(id) ON DELETE RESTRICT,
  workflow_revision text NOT NULL,
  resource_bindings jsonb NOT NULL DEFAULT '[]'::jsonb,
  lifecycle_state text NOT NULL DEFAULT 'created',
  outcome text,
  blocker_reason_code text,
  state_revision bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  admitted_at timestamptz,
  queued_at timestamptz,
  leased_at timestamptz,
  running_at timestamptz,
  waiting_at timestamptz,
  terminal_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT executions_workflow_revision_chk CHECK (length(btrim(workflow_revision)) BETWEEN 1 AND 256),
  CONSTRAINT executions_resource_bindings_chk CHECK (jsonb_typeof(resource_bindings) = 'array'),
  CONSTRAINT executions_lifecycle_chk CHECK (lifecycle_state IN ('created', 'admitted', 'queued', 'leased', 'running', 'waiting', 'terminal')),
  CONSTRAINT executions_outcome_chk CHECK (outcome IS NULL OR outcome IN ('succeeded', 'failed', 'cancelled', 'rejected')),
  CONSTRAINT executions_reason_code_chk CHECK (blocker_reason_code IS NULL OR blocker_reason_code ~ '^vnext\\.[a-z][a-z0-9_]*(\\.[a-z][a-z0-9_]*)+$'),
  CONSTRAINT executions_terminal_tuple_chk CHECK (
    (lifecycle_state = 'terminal' AND outcome IS NOT NULL AND terminal_at IS NOT NULL)
    OR (lifecycle_state <> 'terminal' AND outcome IS NULL AND terminal_at IS NULL)
  ),
  CONSTRAINT executions_revision_chk CHECK (state_revision >= 0)
);
--> statement-breakpoint
CREATE TABLE task_mission_bindings (
  task_id uuid PRIMARY KEY REFERENCES tasks(id) ON DELETE RESTRICT,
  mission_id uuid NOT NULL UNIQUE REFERENCES missions(id) ON DELETE RESTRICT,
  current_execution_id uuid REFERENCES executions(id) ON DELETE RESTRICT,
  current_execution_generation bigint NOT NULL DEFAULT 0,
  binding_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT task_mission_bindings_generation_chk CHECK (current_execution_generation >= 0),
  CONSTRAINT task_mission_bindings_version_chk CHECK (binding_version = 1)
);
--> statement-breakpoint
CREATE TABLE runtime_transition_audits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_kind text NOT NULL,
  entity_id uuid NOT NULL,
  from_lifecycle_state text,
  to_lifecycle_state text NOT NULL,
  outcome text,
  resulting_revision bigint NOT NULL,
  actor_principal_type text NOT NULL,
  actor_principal_id uuid NOT NULL,
  reason_code text NOT NULL,
  evidence_digest text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT runtime_transition_audits_kind_chk CHECK (entity_kind IN ('mission', 'execution')),
  CONSTRAINT runtime_transition_audits_reason_chk CHECK (reason_code ~ '^vnext\\.[a-z][a-z0-9_]*(\\.[a-z][a-z0-9_]*)+$'),
  CONSTRAINT runtime_transition_audits_digest_chk CHECK (evidence_digest IS NULL OR evidence_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT runtime_transition_audits_revision_chk CHECK (resulting_revision >= 0),
  CONSTRAINT runtime_transition_audits_unique_revision UNIQUE (entity_kind, entity_id, resulting_revision)
);
--> statement-breakpoint
CREATE INDEX executions_mission_id_idx ON executions(mission_id, created_at);
CREATE INDEX runtime_transition_audits_entity_idx ON runtime_transition_audits(entity_kind, entity_id, resulting_revision);
--> statement-breakpoint
CREATE FUNCTION forge.guard_vnext_runtime_write_v1()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF session_user <> 'forge' OR current_user <> 'forge_s4_routines_owner' THEN
    RAISE EXCEPTION 'VNext runtime state is writable only through protected routines' USING ERRCODE = '42501';
  END IF;
  IF TG_OP IN ('UPDATE', 'DELETE') AND TG_TABLE_NAME = 'runtime_transition_audits' THEN
    RAISE EXCEPTION 'VNext runtime transition audit is append-only' USING ERRCODE = 'P3341';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER missions_protected_write BEFORE INSERT OR UPDATE OR DELETE ON missions FOR EACH ROW EXECUTE FUNCTION forge.guard_vnext_runtime_write_v1();
CREATE TRIGGER executions_protected_write BEFORE INSERT OR UPDATE OR DELETE ON executions FOR EACH ROW EXECUTE FUNCTION forge.guard_vnext_runtime_write_v1();
CREATE TRIGGER task_mission_bindings_protected_write BEFORE INSERT OR UPDATE OR DELETE ON task_mission_bindings FOR EACH ROW EXECUTE FUNCTION forge.guard_vnext_runtime_write_v1();
CREATE TRIGGER runtime_transition_audits_protected_write BEFORE INSERT OR UPDATE OR DELETE ON runtime_transition_audits FOR EACH ROW EXECUTE FUNCTION forge.guard_vnext_runtime_write_v1();
--> statement-breakpoint
CREATE FUNCTION forge.create_vnext_mission_v1(
  p_mission_id uuid, p_execution_id uuid, p_owner_principal_type text, p_owner_principal_id uuid,
  p_desired_outcome_digest text, p_constraints_digest text, p_compatibility_pins jsonb,
  p_workflow_revision text, p_resource_bindings jsonb, p_reason_code text
) RETURNS TABLE(mission_id uuid, execution_id uuid, occurred_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_now timestamptz := pg_catalog.clock_timestamp();
BEGIN
  IF session_user <> 'forge' THEN RAISE EXCEPTION 'VNext mission creation requires Forge application login' USING ERRCODE = '42501'; END IF;
  IF p_owner_principal_type NOT IN ('user', 'service', 'workspace', 'operator') OR p_owner_principal_id IS NULL
    OR p_desired_outcome_digest !~ '^[0-9a-f]{64}$' OR p_constraints_digest !~ '^[0-9a-f]{64}$'
    OR jsonb_typeof(p_compatibility_pins) <> 'object' OR jsonb_typeof(p_resource_bindings) <> 'array'
    OR length(btrim(p_workflow_revision)) NOT BETWEEN 1 AND 256
    OR p_reason_code !~ '^vnext\\.[a-z][a-z0-9_]*(\\.[a-z][a-z0-9_]*)+$' THEN
    RAISE EXCEPTION 'VNext mission creation arguments are invalid' USING ERRCODE = '22023';
  END IF;
  INSERT INTO missions (id, owner_principal_type, owner_principal_id, desired_outcome_digest, constraints_digest, compatibility_pins, created_at, updated_at)
  VALUES (p_mission_id, p_owner_principal_type, p_owner_principal_id, p_desired_outcome_digest, p_constraints_digest, p_compatibility_pins, v_now, v_now);
  INSERT INTO executions (id, mission_id, workflow_revision, resource_bindings, created_at, updated_at)
  VALUES (p_execution_id, p_mission_id, p_workflow_revision, p_resource_bindings, v_now, v_now);
  INSERT INTO runtime_transition_audits (entity_kind, entity_id, from_lifecycle_state, to_lifecycle_state, outcome, resulting_revision, actor_principal_type, actor_principal_id, reason_code, occurred_at)
  VALUES
    ('mission', p_mission_id, NULL, 'active', NULL, 0, p_owner_principal_type, p_owner_principal_id, p_reason_code, v_now),
    ('execution', p_execution_id, NULL, 'created', NULL, 0, p_owner_principal_type, p_owner_principal_id, p_reason_code, v_now);
  RETURN QUERY SELECT p_mission_id, p_execution_id, v_now;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION forge.transition_vnext_execution_v1(
  p_execution_id uuid, p_expected_revision bigint, p_to_lifecycle_state text, p_outcome text,
  p_blocker_reason_code text, p_actor_principal_type text, p_actor_principal_id uuid,
  p_reason_code text, p_evidence_digest text DEFAULT NULL
) RETURNS TABLE(resulting_revision bigint, occurred_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_from text; v_revision bigint; v_now timestamptz := pg_catalog.clock_timestamp();
BEGIN
  IF session_user <> 'forge' THEN RAISE EXCEPTION 'VNext execution transition requires Forge application login' USING ERRCODE = '42501'; END IF;
  IF p_expected_revision < 0 OR p_to_lifecycle_state NOT IN ('created','admitted','queued','leased','running','waiting','terminal')
    OR (p_to_lifecycle_state = 'terminal') <> (p_outcome IS NOT NULL)
    OR (p_outcome IS NOT NULL AND p_outcome NOT IN ('succeeded','failed','cancelled','rejected'))
    OR p_actor_principal_type NOT IN ('user','service','workspace','operator') OR p_actor_principal_id IS NULL
    OR p_reason_code !~ '^vnext\\.[a-z][a-z0-9_]*(\\.[a-z][a-z0-9_]*)+$'
    OR (p_blocker_reason_code IS NOT NULL AND p_blocker_reason_code !~ '^vnext\\.[a-z][a-z0-9_]*(\\.[a-z][a-z0-9_]*)+$')
    OR (p_evidence_digest IS NOT NULL AND p_evidence_digest !~ '^[0-9a-f]{64}$') THEN
    RAISE EXCEPTION 'VNext execution transition arguments are invalid' USING ERRCODE = '22023';
  END IF;
  SELECT lifecycle_state, state_revision INTO v_from, v_revision FROM executions WHERE id = p_execution_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'VNext execution does not exist' USING ERRCODE = 'P3342'; END IF;
  IF v_revision <> p_expected_revision THEN RAISE EXCEPTION 'VNext execution revision conflict' USING ERRCODE = 'P3343'; END IF;
  IF v_from = 'terminal' THEN RAISE EXCEPTION 'VNext execution terminal state is absorbing' USING ERRCODE = 'P3344'; END IF;
  UPDATE executions SET lifecycle_state = p_to_lifecycle_state, outcome = p_outcome, blocker_reason_code = p_blocker_reason_code,
    state_revision = state_revision + 1, updated_at = v_now, terminal_at = CASE WHEN p_to_lifecycle_state = 'terminal' THEN v_now ELSE NULL END
  WHERE id = p_execution_id;
  INSERT INTO runtime_transition_audits (entity_kind, entity_id, from_lifecycle_state, to_lifecycle_state, outcome, resulting_revision, actor_principal_type, actor_principal_id, reason_code, evidence_digest, occurred_at)
  VALUES ('execution', p_execution_id, v_from, p_to_lifecycle_state, p_outcome, v_revision + 1, p_actor_principal_type, p_actor_principal_id, p_reason_code, p_evidence_digest, v_now);
  RETURN QUERY SELECT v_revision + 1, v_now;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON TABLE missions, executions, task_mission_bindings, runtime_transition_audits FROM PUBLIC, forge;
REVOKE ALL ON FUNCTION forge.guard_vnext_runtime_write_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION forge.create_vnext_mission_v1(uuid,uuid,text,uuid,text,text,jsonb,text,jsonb,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION forge.transition_vnext_execution_v1(uuid,bigint,text,text,text,text,uuid,text,text) FROM PUBLIC;
GRANT SELECT ON TABLE missions, executions, task_mission_bindings, runtime_transition_audits TO forge;
GRANT EXECUTE ON FUNCTION forge.create_vnext_mission_v1(uuid,uuid,text,uuid,text,text,jsonb,text,jsonb,text) TO forge;
GRANT EXECUTE ON FUNCTION forge.transition_vnext_execution_v1(uuid,bigint,text,text,text,text,uuid,text,text) TO forge;
--> statement-breakpoint
RESET ROLE;
--> statement-breakpoint
SELECT public.forge_finalize_epic_172_s4_owner_bootstrap_v1();
