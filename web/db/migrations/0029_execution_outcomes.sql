-- Canonical, idempotent execution-outcome ledger. Existing lifecycle tables
-- remain authoritative; nullable links allow a pre-run admission block.
CREATE TABLE "execution_outcomes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "task_id" uuid NOT NULL,
  "work_package_id" uuid,
  "agent_run_id" uuid,
  "task_attempt_id" uuid,
  "attempt_key" text NOT NULL,
  "schema_version" integer DEFAULT 1 NOT NULL,
  "transport_status" text NOT NULL,
  "result" text NOT NULL,
  "stop_reason_code" text,
  "stop_reason_summary" text,
  "retryable" boolean NOT NULL,
  "evidence_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "verifier_required" boolean DEFAULT false NOT NULL,
  "verification_status" text DEFAULT 'not_required' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "execution_outcomes_schema_version_check" CHECK ("schema_version" = 1),
  CONSTRAINT "execution_outcomes_transport_status_check" CHECK ("transport_status" IN ('ok', 'error')),
  CONSTRAINT "execution_outcomes_result_check" CHECK ("result" IN ('completed', 'partial', 'refused', 'blocked', 'needs_attention', 'failed', 'cancelled')),
  CONSTRAINT "execution_outcomes_stop_reason_code_check" CHECK ("stop_reason_code" IS NULL OR "stop_reason_code" IN ('provider_transport_failure', 'model_refusal', 'invalid_output', 'validation_failed', 'missing_capability', 'admission_denied', 'policy_blocked', 'security_blocked', 'missing_repository_context', 'timeout', 'context_limit', 'output_limit', 'retry_exhausted', 'human_cancelled', 'unknown')),
  CONSTRAINT "execution_outcomes_verification_status_check" CHECK ("verification_status" IN ('not_required', 'pending', 'passed', 'failed', 'inconclusive')),
  CONSTRAINT "execution_outcomes_verifier_consistency_check" CHECK (("verifier_required" AND "verification_status" IN ('pending', 'passed', 'failed', 'inconclusive')) OR (NOT "verifier_required" AND "verification_status" = 'not_required')),
  CONSTRAINT "execution_outcomes_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE restrict ON UPDATE no action,
  CONSTRAINT "execution_outcomes_work_package_id_work_packages_id_fk" FOREIGN KEY ("work_package_id") REFERENCES "public"."work_packages"("id") ON DELETE set null ON UPDATE no action,
  CONSTRAINT "execution_outcomes_agent_run_id_agent_runs_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action,
  CONSTRAINT "execution_outcomes_task_attempt_id_task_attempts_id_fk" FOREIGN KEY ("task_attempt_id") REFERENCES "public"."task_attempts"("id") ON DELETE set null ON UPDATE no action
);
-- `evidence_refs` is constrained to UUIDs by the application contract. A
-- PostgreSQL JSONB CHECK cannot safely validate each array element without
-- coupling this durable ledger to a brittle JSON expression.
--> statement-breakpoint
CREATE UNIQUE INDEX "execution_outcomes_task_attempt_key_idx" ON "execution_outcomes" USING btree ("task_id","attempt_key");
--> statement-breakpoint
CREATE INDEX "execution_outcomes_work_package_id_idx" ON "execution_outcomes" USING btree ("work_package_id");
--> statement-breakpoint
CREATE INDEX "execution_outcomes_agent_run_id_idx" ON "execution_outcomes" USING btree ("agent_run_id");
--> statement-breakpoint
CREATE INDEX "execution_outcomes_task_attempt_id_idx" ON "execution_outcomes" USING btree ("task_attempt_id");
