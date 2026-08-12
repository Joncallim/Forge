-- Capability reliability ledger (ADR 0012, issue #186). Attempts are
-- immutable append-only evidence; adjudications record later evidence
-- (verification, human decisions, rollback, override, drift) separately so
-- earlier evidence is never rewritten. No column in either table is free
-- text: every text column is a closed enum, a 64-hex fingerprint, or the
-- bounded capability-key grammar, each enforced below. Evidence refs are
-- UUIDs only (ADR 0010) and are enforced at the database boundary too: rows
-- can never be updated or deleted, so an erroneous writer must not be able
-- to permanently place paths, transcripts, or credentials in the ledger.
-- The helper stays PUBLIC-executable on purpose: CHECK expressions are
-- evaluated with the inserting role's privileges, and the function exposes
-- nothing beyond a boolean over its own argument.
CREATE FUNCTION "forge_is_uuid_evidence_refs_v1"("value" jsonb) RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN pg_catalog.jsonb_typeof("value") <> 'array' THEN FALSE
    WHEN pg_catalog.jsonb_array_length("value") > 128 THEN FALSE
    ELSE COALESCE((
      SELECT bool_and(
        "element" IS NOT NULL
        AND "element" ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89a-bA-B][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
      )
      FROM pg_catalog.jsonb_array_elements_text("value") AS "element"
    ), TRUE)
  END
$$;
--> statement-breakpoint
CREATE TABLE "capability_attempts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "attempt_group_id" uuid NOT NULL,
  "project_id" uuid NOT NULL,
  "task_id" uuid NOT NULL,
  "work_package_id" uuid,
  "agent_run_id" uuid,
  "task_attempt_id" uuid,
  "execution_outcome_id" uuid NOT NULL,
  "operation_run_id" uuid,
  "contract_version" integer DEFAULT 1 NOT NULL,
  "capability_key" text NOT NULL,
  "classification_state" text NOT NULL,
  "capability_multiplicity" integer NOT NULL,
  "cohort_fingerprint" text NOT NULL,
  "scope_fingerprint" text NOT NULL,
  "runtime_fingerprint" text NOT NULL,
  "policy_fingerprint" text NOT NULL,
  "outcome_digest" text NOT NULL,
  "transport_status" text NOT NULL,
  "result" text NOT NULL,
  "stop_reason_code" text,
  "retryable" boolean NOT NULL,
  "attempt_number" integer DEFAULT 1 NOT NULL,
  "severity_class" text NOT NULL,
  "verifier_required" boolean NOT NULL,
  "verification_mode" text NOT NULL,
  "verification_status" text NOT NULL,
  "acceptance_criteria_total" integer DEFAULT 0 NOT NULL,
  "validation_command_total" integer DEFAULT 0 NOT NULL,
  "validation_command_failed" integer DEFAULT 0 NOT NULL,
  "evidence_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "observed_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "capability_attempts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action,
  CONSTRAINT "capability_attempts_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE restrict ON UPDATE no action,
  CONSTRAINT "capability_attempts_work_package_id_work_packages_id_fk" FOREIGN KEY ("work_package_id") REFERENCES "public"."work_packages"("id") ON DELETE set null ON UPDATE no action,
  CONSTRAINT "capability_attempts_agent_run_id_agent_runs_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action,
  CONSTRAINT "capability_attempts_task_attempt_id_task_attempts_id_fk" FOREIGN KEY ("task_attempt_id") REFERENCES "public"."task_attempts"("id") ON DELETE set null ON UPDATE no action,
  CONSTRAINT "capability_attempts_execution_outcome_id_execution_outcomes_id_fk" FOREIGN KEY ("execution_outcome_id") REFERENCES "public"."execution_outcomes"("id") ON DELETE restrict ON UPDATE no action,
  CONSTRAINT "capability_attempts_operation_run_id_operation_runs_id_fk" FOREIGN KEY ("operation_run_id") REFERENCES "public"."operation_runs"("id") ON DELETE set null ON UPDATE no action,
  CONSTRAINT "capability_attempts_contract_version_check" CHECK ("contract_version" = 1),
  CONSTRAINT "capability_attempts_capability_key_check" CHECK (
    length("capability_key") <= 120 AND
    "capability_key" ~ '^(workpackage:[a-z][a-z0-9-]{0,39}/[a-z][a-z0-9-]{0,39}|operation:[a-z][a-z0-9]*([._-][a-z0-9]+)+@[1-9][0-9]{0,3})$'
  ),
  CONSTRAINT "capability_attempts_classification_state_check" CHECK ("classification_state" IN ('classified', 'missing', 'overflow')),
  CONSTRAINT "capability_attempts_capability_multiplicity_check" CHECK ("capability_multiplicity" BETWEEN 1 AND 12),
  CONSTRAINT "capability_attempts_cohort_fingerprint_check" CHECK ("cohort_fingerprint" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "capability_attempts_scope_fingerprint_check" CHECK ("scope_fingerprint" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "capability_attempts_runtime_fingerprint_check" CHECK ("runtime_fingerprint" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "capability_attempts_policy_fingerprint_check" CHECK ("policy_fingerprint" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "capability_attempts_outcome_digest_check" CHECK ("outcome_digest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "capability_attempts_transport_status_check" CHECK ("transport_status" IN ('ok', 'error')),
  CONSTRAINT "capability_attempts_result_check" CHECK ("result" IN ('completed', 'partial', 'refused', 'blocked', 'needs_attention', 'failed', 'cancelled')),
  CONSTRAINT "capability_attempts_stop_reason_code_check" CHECK ("stop_reason_code" IS NULL OR "stop_reason_code" IN ('provider_transport_failure', 'model_refusal', 'invalid_output', 'validation_failed', 'missing_capability', 'admission_denied', 'policy_blocked', 'security_blocked', 'missing_repository_context', 'timeout', 'context_limit', 'output_limit', 'retry_exhausted', 'human_cancelled', 'unknown')),
  CONSTRAINT "capability_attempts_attempt_number_check" CHECK ("attempt_number" >= 1),
  CONSTRAINT "capability_attempts_severity_class_check" CHECK ("severity_class" IN ('normal', 'critical')),
  CONSTRAINT "capability_attempts_verification_mode_value_check" CHECK ("verification_mode" IN ('none', 'self_reported', 'human_review', 'deterministic_adapter', 'independent_agent')),
  CONSTRAINT "capability_attempts_verification_status_check" CHECK ("verification_status" IN ('not_required', 'pending', 'passed', 'failed', 'inconclusive')),
  CONSTRAINT "capability_attempts_acceptance_criteria_total_check" CHECK ("acceptance_criteria_total" >= 0),
  CONSTRAINT "capability_attempts_validation_command_total_check" CHECK ("validation_command_total" >= 0),
  CONSTRAINT "capability_attempts_validation_command_failed_check" CHECK ("validation_command_failed" >= 0 AND "validation_command_failed" <= "validation_command_total"),
  CONSTRAINT "capability_attempts_evidence_refs_check" CHECK ("forge_is_uuid_evidence_refs_v1"("evidence_refs")),
  CONSTRAINT "capability_attempts_verifier_consistency_check" CHECK (
    ("verifier_required" AND "verification_status" IN ('pending', 'passed', 'failed', 'inconclusive')) OR
    (NOT "verifier_required" AND "verification_status" = 'not_required')
  ),
  CONSTRAINT "capability_attempts_verification_mode_check" CHECK (
    ("verification_mode" = 'none') = (NOT "verifier_required")
  ),
  CONSTRAINT "capability_attempts_unclassified_check" CHECK (
    ("classification_state" = 'classified') OR "capability_key" LIKE 'workpackage:%/unclassified'
  ),
  CONSTRAINT "capability_attempts_operation_runtime_check" CHECK (
    "operation_run_id" IS NULL OR "verification_mode" IN ('none', 'deterministic_adapter')
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX "capability_attempts_outcome_capability_idx" ON "capability_attempts" USING btree ("execution_outcome_id", "capability_key");
--> statement-breakpoint
CREATE INDEX "capability_attempts_cohort_observed_at_idx" ON "capability_attempts" USING btree ("cohort_fingerprint", "observed_at" DESC);
--> statement-breakpoint
CREATE INDEX "capability_attempts_project_capability_idx" ON "capability_attempts" USING btree ("project_id", "capability_key");
--> statement-breakpoint
CREATE INDEX "capability_attempts_attempt_group_idx" ON "capability_attempts" USING btree ("attempt_group_id");
--> statement-breakpoint
CREATE INDEX "capability_attempts_execution_outcome_idx" ON "capability_attempts" USING btree ("execution_outcome_id");
--> statement-breakpoint
CREATE FUNCTION "forge_reject_capability_attempt_mutation_v1"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'capability attempts are append-only';
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.forge_reject_capability_attempt_mutation_v1() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "capability_attempts_append_only"
BEFORE UPDATE OR DELETE ON "capability_attempts"
FOR EACH ROW EXECUTE FUNCTION "forge_reject_capability_attempt_mutation_v1"();
--> statement-breakpoint
CREATE TABLE "capability_attempt_adjudications" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "capability_attempt_id" uuid NOT NULL,
  "sequence" integer NOT NULL,
  "kind" text NOT NULL,
  "verification_mode" text,
  "verification_result" text,
  "human_decision" text,
  "decided_by" uuid,
  "approval_gate_id" uuid,
  "observed_outcome_digest" text,
  "evidence_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "observed_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "capability_attempt_adjudications_attempt_id_fk" FOREIGN KEY ("capability_attempt_id") REFERENCES "public"."capability_attempts"("id") ON DELETE restrict ON UPDATE no action,
  CONSTRAINT "capability_attempt_adjudications_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action,
  CONSTRAINT "capability_attempt_adjudications_approval_gate_id_fk" FOREIGN KEY ("approval_gate_id") REFERENCES "public"."approval_gates"("id") ON DELETE set null ON UPDATE no action,
  CONSTRAINT "capability_attempt_adjudications_sequence_check" CHECK ("sequence" >= 0),
  CONSTRAINT "capability_attempt_adjudications_kind_check" CHECK ("kind" IN ('verification_recorded', 'human_decision', 'rollback_recorded', 'override_recorded', 'evidence_drift_detected')),
  CONSTRAINT "capability_attempt_adjudications_verification_mode_check" CHECK ("verification_mode" IS NULL OR "verification_mode" IN ('none', 'self_reported', 'human_review', 'deterministic_adapter', 'independent_agent')),
  CONSTRAINT "capability_attempt_adjudications_verification_result_check" CHECK ("verification_result" IS NULL OR "verification_result" IN ('passed', 'failed', 'inconclusive')),
  CONSTRAINT "capability_attempt_adjudications_human_decision_check" CHECK ("human_decision" IS NULL OR "human_decision" IN ('accepted', 'rejected', 'cancelled')),
  CONSTRAINT "capability_attempt_adjudications_observed_outcome_digest_check" CHECK ("observed_outcome_digest" IS NULL OR "observed_outcome_digest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "capability_attempt_adjudications_evidence_refs_check" CHECK ("forge_is_uuid_evidence_refs_v1"("evidence_refs")),
  CONSTRAINT "capability_attempt_adjudications_kind_shape_check" CHECK (
    ("kind" = 'verification_recorded'
      AND "verification_mode" IS NOT NULL AND "verification_result" IS NOT NULL
      AND "human_decision" IS NULL AND "observed_outcome_digest" IS NULL)
    OR ("kind" = 'human_decision'
      AND "human_decision" IS NOT NULL
      AND "verification_mode" IS NULL AND "verification_result" IS NULL
      AND "observed_outcome_digest" IS NULL)
    OR ("kind" IN ('rollback_recorded', 'override_recorded')
      AND "verification_mode" IS NULL AND "verification_result" IS NULL
      AND "human_decision" IS NULL AND "observed_outcome_digest" IS NULL)
    OR ("kind" = 'evidence_drift_detected'
      AND "observed_outcome_digest" IS NOT NULL
      AND "verification_mode" IS NULL AND "verification_result" IS NULL AND "human_decision" IS NULL)
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX "capability_attempt_adjudications_attempt_sequence_idx" ON "capability_attempt_adjudications" USING btree ("capability_attempt_id", "sequence");
--> statement-breakpoint
CREATE INDEX "capability_attempt_adjudications_attempt_observed_at_idx" ON "capability_attempt_adjudications" USING btree ("capability_attempt_id", "observed_at");
--> statement-breakpoint
CREATE FUNCTION "forge_guard_capability_adjudication_insert_v1"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_last_sequence integer;
BEGIN
  -- Serialize concurrent adjudication writers per attempt without granting
  -- the app role UPDATE on the parent row: SELECT ... FOR UPDATE would
  -- require the UPDATE privilege, but a transaction-scoped advisory lock
  -- keyed on the attempt id conflicts across sessions and needs no table
  -- privilege. The application allocates its sequence under the same lock;
  -- this re-check is the gapless guarantee for any writer.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(NEW.capability_attempt_id::text, 0)
  );
  SELECT max(sequence) INTO v_last_sequence
  FROM public.capability_attempt_adjudications
  WHERE capability_attempt_id = NEW.capability_attempt_id;
  IF NEW.sequence <> COALESCE(v_last_sequence + 1, 0) THEN
    RAISE EXCEPTION 'capability attempt adjudications must be appended in gapless sequence order';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.forge_guard_capability_adjudication_insert_v1() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "capability_attempt_adjudications_order_guard"
BEFORE INSERT ON "capability_attempt_adjudications"
FOR EACH ROW EXECUTE FUNCTION "forge_guard_capability_adjudication_insert_v1"();
--> statement-breakpoint
CREATE FUNCTION "forge_reject_capability_adjudication_mutation_v1"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'capability attempt adjudications are append-only';
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.forge_reject_capability_adjudication_mutation_v1() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "capability_attempt_adjudications_append_only"
BEFORE UPDATE OR DELETE ON "capability_attempt_adjudications"
FOR EACH ROW EXECUTE FUNCTION "forge_reject_capability_adjudication_mutation_v1"();
