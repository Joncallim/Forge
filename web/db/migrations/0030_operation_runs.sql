-- Bounded deterministic operation ledger. Model-supplied inputs are never
-- persisted; only domain-separated SHA-256 fingerprints cross this boundary.
CREATE TABLE "operation_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "task_id" uuid NOT NULL,
  "project_id" uuid NOT NULL,
  "work_package_id" uuid,
  "agent_run_id" uuid,
  "task_attempt_id" uuid,
  "execution_outcome_id" uuid,
  "definition_schema_version" integer DEFAULT 1 NOT NULL,
  "operation_id" text NOT NULL,
  "operation_version" integer NOT NULL,
  "capability" text NOT NULL,
  "idempotency_key" text NOT NULL,
  "definition_digest" text NOT NULL,
  "scope_fingerprint" text NOT NULL,
  "request_fingerprint" text NOT NULL,
  "inputs_fingerprint" text NOT NULL,
  "reason_fingerprint" text NOT NULL,
  "policy_decision" jsonb NOT NULL,
  "status" text DEFAULT 'running' NOT NULL,
  "verification_status" text DEFAULT 'not_started' NOT NULL,
  "output_fingerprint" text,
  "outcome_fingerprint" text,
  "started_at" timestamp with time zone DEFAULT now() NOT NULL,
  "completed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "operation_runs_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE restrict ON UPDATE no action,
  CONSTRAINT "operation_runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action,
  CONSTRAINT "operation_runs_work_package_id_work_packages_id_fk" FOREIGN KEY ("work_package_id") REFERENCES "public"."work_packages"("id") ON DELETE set null ON UPDATE no action,
  CONSTRAINT "operation_runs_agent_run_id_agent_runs_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action,
  CONSTRAINT "operation_runs_task_attempt_id_task_attempts_id_fk" FOREIGN KEY ("task_attempt_id") REFERENCES "public"."task_attempts"("id") ON DELETE set null ON UPDATE no action,
  CONSTRAINT "operation_runs_execution_outcome_id_execution_outcomes_id_fk" FOREIGN KEY ("execution_outcome_id") REFERENCES "public"."execution_outcomes"("id") ON DELETE restrict ON UPDATE no action,
  CONSTRAINT "operation_runs_definition_schema_check" CHECK ("definition_schema_version" = 1),
  CONSTRAINT "operation_runs_operation_version_check" CHECK ("operation_version" > 0),
  CONSTRAINT "operation_runs_status_check" CHECK ("status" IN ('running', 'completed', 'blocked', 'failed')),
  CONSTRAINT "operation_runs_verification_status_check" CHECK ("verification_status" IN ('not_started', 'passed', 'failed')),
  CONSTRAINT "operation_runs_fingerprints_check" CHECK (
    "idempotency_key" ~ '^[0-9a-f]{64}$' AND
    "definition_digest" ~ '^[0-9a-f]{64}$' AND
    "scope_fingerprint" ~ '^[0-9a-f]{64}$' AND
    "request_fingerprint" ~ '^[0-9a-f]{64}$' AND
    "inputs_fingerprint" ~ '^[0-9a-f]{64}$' AND
    "reason_fingerprint" ~ '^[0-9a-f]{64}$' AND
    ("output_fingerprint" IS NULL OR "output_fingerprint" ~ '^[0-9a-f]{64}$') AND
    ("outcome_fingerprint" IS NULL OR "outcome_fingerprint" ~ '^[0-9a-f]{64}$')
  ),
  CONSTRAINT "operation_runs_terminal_shape_check" CHECK (
    ("status" = 'running' AND "completed_at" IS NULL AND "execution_outcome_id" IS NULL AND "outcome_fingerprint" IS NULL) OR
    ("status" <> 'running' AND "completed_at" IS NOT NULL AND "execution_outcome_id" IS NOT NULL AND "outcome_fingerprint" IS NOT NULL)
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX "operation_runs_task_idempotency_key_idx" ON "operation_runs" USING btree ("task_id", "idempotency_key");
--> statement-breakpoint
CREATE INDEX "operation_runs_project_id_created_at_idx" ON "operation_runs" USING btree ("project_id", "created_at");
--> statement-breakpoint
CREATE INDEX "operation_runs_operation_version_idx" ON "operation_runs" USING btree ("operation_id", "operation_version");
--> statement-breakpoint
CREATE INDEX "operation_runs_execution_outcome_id_idx" ON "operation_runs" USING btree ("execution_outcome_id");
--> statement-breakpoint
CREATE TABLE "operation_run_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "operation_run_id" uuid NOT NULL,
  "sequence" integer NOT NULL,
  "phase" text NOT NULL,
  "status" text NOT NULL,
  "detail_code" text NOT NULL,
  "detail_fingerprint" text NOT NULL,
  "evidence_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "operation_run_events_operation_run_id_operation_runs_id_fk" FOREIGN KEY ("operation_run_id") REFERENCES "public"."operation_runs"("id") ON DELETE restrict ON UPDATE no action,
  CONSTRAINT "operation_run_events_status_check" CHECK ("status" IN ('passed', 'blocked', 'failed')),
  CONSTRAINT "operation_run_events_detail_fingerprint_check" CHECK ("detail_fingerprint" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "operation_run_events_evidence_refs_check" CHECK (jsonb_typeof("evidence_refs") = 'array'),
  CONSTRAINT "operation_run_events_phase_sequence_check" CHECK (
    ("phase" = 'request_validation' AND "sequence" = 0) OR
    ("phase" = 'policy' AND "sequence" = 1) OR
    ("phase" = 'preflight' AND "sequence" = 2) OR
    ("phase" = 'execution' AND "sequence" = 3) OR
    ("phase" = 'verification' AND "sequence" = 4) OR
    ("phase" = 'outcome' AND "sequence" = 5)
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX "operation_run_events_run_sequence_idx" ON "operation_run_events" USING btree ("operation_run_id", "sequence");
--> statement-breakpoint
CREATE INDEX "operation_run_events_run_created_at_idx" ON "operation_run_events" USING btree ("operation_run_id", "created_at");
--> statement-breakpoint
CREATE FUNCTION "forge_guard_operation_event_insert_v1"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_run_status text;
  v_last_sequence integer;
  v_last_status text;
BEGIN
  SELECT status INTO STRICT v_run_status
  FROM public.operation_runs
  WHERE id = NEW.operation_run_id
  FOR UPDATE;
  IF v_run_status <> 'running' THEN
    RAISE EXCEPTION 'terminal operation runs cannot receive events';
  END IF;
  SELECT sequence, status INTO v_last_sequence, v_last_status
  FROM public.operation_run_events
  WHERE operation_run_id = NEW.operation_run_id
  ORDER BY sequence DESC
  LIMIT 1;
  IF (v_last_sequence IS NULL AND NEW.sequence <> 0)
     OR (v_last_sequence = 0 AND (v_last_status <> 'passed' OR NEW.sequence <> 1))
     OR (v_last_sequence = 1 AND (
       (v_last_status = 'passed' AND NEW.sequence <> 2)
       OR (v_last_status <> 'passed' AND NEW.sequence <> 5)
     ))
     OR (v_last_sequence = 2 AND (
       (v_last_status = 'passed' AND NEW.sequence <> 3)
       OR (v_last_status <> 'passed' AND NEW.sequence <> 5)
     ))
     OR (v_last_sequence = 3 AND (
       (v_last_status = 'passed' AND NEW.sequence <> 4)
       OR (v_last_status <> 'passed' AND NEW.sequence <> 5)
     ))
     OR (v_last_sequence = 4 AND NEW.sequence <> 5)
     OR v_last_sequence = 5 THEN
    RAISE EXCEPTION 'operation run events must be appended in phase order';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.forge_guard_operation_event_insert_v1() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "operation_run_events_order_guard"
BEFORE INSERT ON "operation_run_events"
FOR EACH ROW EXECUTE FUNCTION "forge_guard_operation_event_insert_v1"();
--> statement-breakpoint
CREATE FUNCTION "forge_guard_operation_run_history_v1"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'operation run history is append-only';
  END IF;
  IF OLD.status <> 'running' THEN
    RAISE EXCEPTION 'terminal operation runs are immutable';
  END IF;
  IF NEW.status = 'running'
     OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.task_id IS DISTINCT FROM OLD.task_id
     OR NEW.project_id IS DISTINCT FROM OLD.project_id
     OR NEW.work_package_id IS DISTINCT FROM OLD.work_package_id
     OR NEW.agent_run_id IS DISTINCT FROM OLD.agent_run_id
     OR NEW.task_attempt_id IS DISTINCT FROM OLD.task_attempt_id
     OR NEW.definition_schema_version IS DISTINCT FROM OLD.definition_schema_version
     OR NEW.operation_id IS DISTINCT FROM OLD.operation_id
     OR NEW.operation_version IS DISTINCT FROM OLD.operation_version
     OR NEW.capability IS DISTINCT FROM OLD.capability
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.definition_digest IS DISTINCT FROM OLD.definition_digest
     OR NEW.scope_fingerprint IS DISTINCT FROM OLD.scope_fingerprint
     OR NEW.request_fingerprint IS DISTINCT FROM OLD.request_fingerprint
     OR NEW.inputs_fingerprint IS DISTINCT FROM OLD.inputs_fingerprint
     OR NEW.reason_fingerprint IS DISTINCT FROM OLD.reason_fingerprint
     OR NEW.policy_decision IS DISTINCT FROM OLD.policy_decision
     OR NEW.started_at IS DISTINCT FROM OLD.started_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'operation run identity is immutable';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.forge_guard_operation_run_history_v1() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "operation_runs_history_guard"
BEFORE UPDATE OR DELETE ON "operation_runs"
FOR EACH ROW EXECUTE FUNCTION "forge_guard_operation_run_history_v1"();
--> statement-breakpoint
CREATE FUNCTION "forge_reject_operation_event_mutation_v1"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'operation run events are append-only';
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.forge_reject_operation_event_mutation_v1() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "operation_run_events_append_only"
BEFORE UPDATE OR DELETE ON "operation_run_events"
FOR EACH ROW EXECUTE FUNCTION "forge_reject_operation_event_mutation_v1"();
