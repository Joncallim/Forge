-- Verification goal execution authority, evidence, and scheduling schema
-- (issue #187 Slice B).
--
-- This slice deliberately does not include the runner, root launcher, scheduler,
-- or API routes. It adds the protected policy/run/evidence/schedule surfaces
-- and expands the shared execution-subject ledgers for the future dual-subject
-- cutover. New protected tables follow the same S4-owner bootstrap/handoff
-- pattern as migrations 0033 and 0034.
--
-- The migration login owns the ordinary application tables and the shared
-- ledgers these new protected surfaces reference. Establish the exact
-- temporary REFERENCES grants before entering the protected-owner role so the
-- foreign keys below can be created; the mirror revoke near the end restores
-- the reconciled owner boundary.
GRANT REFERENCES ON TABLE
  public.projects,
  public.users,
  public.execution_outcomes,
  public.operation_runs,
  public.verification_goal_snapshots
TO forge_s4_routines_owner;
--> statement-breakpoint
SELECT public.forge_begin_epic_172_s4_owner_bootstrap_v1();
--> statement-breakpoint
SET ROLE forge_s4_routines_owner;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Project verification policy
-- ---------------------------------------------------------------------------
CREATE TABLE "verification_goal_policy_revisions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL,
  "revision_sequence" bigint NOT NULL,
  "policy_digest" text NOT NULL,
  "manual_enabled" boolean NOT NULL DEFAULT false,
  "scheduling_enabled" boolean NOT NULL DEFAULT false,
  "min_schedule_interval_seconds" bigint NOT NULL,
  "max_run_deadline_seconds" bigint NOT NULL,
  "max_queue_age_seconds" bigint NOT NULL,
  "max_operations_per_run" integer NOT NULL,
  "max_concurrent_runs" integer NOT NULL,
  "max_queued_runs" integer NOT NULL,
  "max_active_runs" integer NOT NULL,
  "start_budget_window_seconds" bigint NOT NULL,
  "max_starts_per_window" bigint NOT NULL,
  "actor_kind" text NOT NULL,
  "actor_user_id" uuid,
  "predecessor_revision_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "verification_goal_policy_revisions_project_id_fk"
    FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id")
    ON DELETE restrict ON UPDATE restrict,
  CONSTRAINT "verification_goal_policy_revisions_actor_user_id_fk"
    FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id")
    ON DELETE restrict ON UPDATE restrict,
  CONSTRAINT "verification_goal_policy_revisions_sequence_check"
    CHECK ("revision_sequence" > 0),
  CONSTRAINT "verification_goal_policy_revisions_policy_digest_check"
    CHECK ("policy_digest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "verification_goal_policy_revisions_actor_kind_check"
    CHECK ("actor_kind" IN ('migration_seed', 'system_default', 'human')),
  CONSTRAINT "verification_goal_policy_revisions_actor_shape_check"
    CHECK (
      ("actor_kind" IN ('migration_seed', 'system_default') AND "actor_user_id" IS NULL)
      OR ("actor_kind" = 'human' AND "actor_user_id" IS NOT NULL)
    ),
  CONSTRAINT "verification_goal_policy_revisions_positive_bounds_check"
    CHECK (
      "min_schedule_interval_seconds" > 0
      AND "max_run_deadline_seconds" > 0
      AND "max_queue_age_seconds" > 0
      AND "max_operations_per_run" > 0
      AND "max_concurrent_runs" > 0
      AND "max_queued_runs" > 0
      AND "max_active_runs" > 0
      AND "start_budget_window_seconds" > 0
      AND "max_starts_per_window" > 0
    )
);
--> statement-breakpoint
CREATE UNIQUE INDEX "verification_goal_policy_revisions_project_sequence_idx"
ON "verification_goal_policy_revisions" USING btree ("project_id", "revision_sequence");
--> statement-breakpoint
CREATE UNIQUE INDEX "verification_goal_policy_revisions_id_project_idx"
ON "verification_goal_policy_revisions" USING btree ("id", "project_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "verification_goal_policy_revisions_id_project_sequence_idx"
ON "verification_goal_policy_revisions" USING btree ("id", "project_id", "revision_sequence");
--> statement-breakpoint
ALTER TABLE "verification_goal_policy_revisions"
ADD CONSTRAINT "verification_goal_policy_revisions_predecessor_fk"
FOREIGN KEY ("predecessor_revision_id", "project_id")
REFERENCES "public"."verification_goal_policy_revisions"("id", "project_id")
ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint

CREATE TABLE "verification_goal_policy_heads" (
  "project_id" uuid PRIMARY KEY NOT NULL,
  "policy_revision_id" uuid NOT NULL,
  "revision_sequence" bigint NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "verification_goal_policy_heads_project_id_fk"
    FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id")
    ON DELETE restrict ON UPDATE restrict,
  CONSTRAINT "verification_goal_policy_heads_revision_project_sequence_fk"
    FOREIGN KEY ("policy_revision_id", "project_id", "revision_sequence")
    REFERENCES "public"."verification_goal_policy_revisions"("id", "project_id", "revision_sequence")
    ON DELETE restrict ON UPDATE restrict,
  CONSTRAINT "verification_goal_policy_heads_sequence_check"
    CHECK ("revision_sequence" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "verification_goal_policy_heads_revision_idx"
ON "verification_goal_policy_heads" USING btree ("policy_revision_id");
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Verification goal runs and events
-- ---------------------------------------------------------------------------
CREATE TABLE "verification_goal_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL,
  "registry_revision_id" uuid NOT NULL,
  "registry_entry_ordinal" integer NOT NULL,
  "snapshot_id" uuid NOT NULL,
  "goal_id" text NOT NULL,
  "definition_version" integer NOT NULL,
  "definition_digest" text NOT NULL,
  "source_path" text NOT NULL,
  "execution_binding_digest" text,
  "policy_revision_id" uuid NOT NULL,
  "policy_revision_sequence" bigint NOT NULL,
  "resolved_policy" jsonb NOT NULL,
  "resolved_policy_fingerprint" text NOT NULL,
  "trigger_kind" text NOT NULL,
  "requested_by_user_id" uuid,
  "manual_idempotency_key" uuid,
  "manual_request_fingerprint" text,
  "schedule_binding_id" uuid,
  "schedule_slot_id" uuid,
  "admission_expiry" timestamp with time zone NOT NULL,
  "authority_fingerprint" text NOT NULL,
  "status" text NOT NULL DEFAULT 'queued',
  "result" text,
  "terminal_code" text,
  "overall_outcome_id" uuid,
  "goal_evidence_set_digest" text,
  "goal_evidence_unit_fingerprint" text,
  "lease_generation" bigint,
  "lease_token" uuid,
  "lease_expires_at" timestamp with time zone,
  "started_at" timestamp with time zone,
  "finished_at" timestamp with time zone,
  "recovery_not_before" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "verification_goal_runs_project_id_fk"
    FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id")
    ON DELETE restrict ON UPDATE restrict,
  CONSTRAINT "verification_goal_runs_registry_entry_fk"
    FOREIGN KEY ("registry_revision_id", "registry_entry_ordinal")
    REFERENCES "public"."verification_goal_registry_entries"("registry_revision_id", "ordinal")
    ON DELETE restrict ON UPDATE restrict,
  CONSTRAINT "verification_goal_runs_snapshot_identity_fk"
    FOREIGN KEY (
      "snapshot_id", "project_id", "goal_id", "definition_version", "definition_digest"
    )
    REFERENCES "public"."verification_goal_snapshots"(
      "id", "project_id", "goal_id", "definition_version", "definition_digest"
    )
    ON DELETE restrict ON UPDATE restrict,
  CONSTRAINT "verification_goal_runs_policy_revision_fk"
    FOREIGN KEY ("policy_revision_id", "project_id", "policy_revision_sequence")
    REFERENCES "public"."verification_goal_policy_revisions"(
      "id", "project_id", "revision_sequence"
    )
    ON DELETE restrict ON UPDATE restrict,
  CONSTRAINT "verification_goal_runs_overall_outcome_fk"
    FOREIGN KEY ("overall_outcome_id") REFERENCES "public"."execution_outcomes"("id")
    ON DELETE restrict ON UPDATE restrict,
  CONSTRAINT "verification_goal_runs_requested_by_user_fk"
    FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id")
    ON DELETE restrict ON UPDATE restrict,
  CONSTRAINT "verification_goal_runs_status_check"
    CHECK ("status" IN ('queued', 'running', 'recovery_required', 'completed', 'expired')),
  CONSTRAINT "verification_goal_runs_result_check"
    CHECK ("result" IS NULL OR "result" IN ('passed', 'failed', 'inconclusive')),
  CONSTRAINT "verification_goal_runs_terminal_code_check"
    CHECK (
      "terminal_code" IS NULL
      OR "terminal_code" IN (
        'passed', 'functional_operation_failed', 'functional_verification_failed',
        'repository_dirty', 'repository_changed', 'root_changed',
        'registry_content_changed', 'registry_superseded', 'registry_authority_changed',
        'policy_changed', 'filesystem_authority_changed', 'operation_contract_changed',
        'required_verifier_unavailable', 'linked_worktree_unsupported',
        'unsupported_git_metadata_layout', 'unsupported_git_config',
        'partial_clone_unsupported', 'incomplete_object_store',
        'sparse_checkout_unsupported', 'split_index_unsupported',
        'grafts_unsupported', 'goal_definition_untracked', 'git_version_unsupported',
        'git_executable_untrusted', 'submodule_repository_unsupported',
        'unsupported_repository_identity', 'missing_required_evidence',
        'operation_infrastructure_failed', 'operation_evidence_failed',
        'execution_deadline_exceeded', 'lease_lost', 'system_execution_disabled',
        'internal_infrastructure_error', 'dispatch_expired'
      )
    ),
  CONSTRAINT "verification_goal_runs_trigger_kind_check"
    CHECK ("trigger_kind" IN ('manual', 'scheduled')),
  CONSTRAINT "verification_goal_runs_manual_shape_check"
    CHECK (
      ("trigger_kind" <> 'manual')
      OR (
        "requested_by_user_id" IS NOT NULL
        AND "manual_idempotency_key" IS NOT NULL
        AND "manual_request_fingerprint" IS NOT NULL
        AND "schedule_binding_id" IS NULL
        AND "schedule_slot_id" IS NULL
      )
    ),
  CONSTRAINT "verification_goal_runs_scheduled_shape_check"
    CHECK (
      ("trigger_kind" <> 'scheduled')
      OR (
        "requested_by_user_id" IS NULL
        AND "manual_idempotency_key" IS NULL
        AND "manual_request_fingerprint" IS NULL
        AND "schedule_binding_id" IS NOT NULL
        AND "schedule_slot_id" IS NOT NULL
      )
    ),
  CONSTRAINT "verification_goal_runs_queued_shape_check"
    CHECK (
      ("status" <> 'queued')
      OR (
        "started_at" IS NULL
        AND "result" IS NULL
        AND "terminal_code" IS NULL
        AND "overall_outcome_id" IS NULL
        AND "goal_evidence_set_digest" IS NULL
        AND "goal_evidence_unit_fingerprint" IS NULL
        AND "lease_generation" IS NULL
        AND "lease_token" IS NULL
        AND "lease_expires_at" IS NULL
        AND "finished_at" IS NULL
        AND "recovery_not_before" IS NULL
      )
    ),
  CONSTRAINT "verification_goal_runs_running_shape_check"
    CHECK (
      ("status" <> 'running')
      OR (
        "started_at" IS NOT NULL
        AND "result" IS NULL
        AND "terminal_code" IS NULL
        AND "overall_outcome_id" IS NULL
        AND "goal_evidence_set_digest" IS NULL
        AND "goal_evidence_unit_fingerprint" IS NULL
        AND "lease_generation" IS NOT NULL
        AND "lease_token" IS NOT NULL
        AND "lease_expires_at" IS NOT NULL
        AND "finished_at" IS NULL
        AND "recovery_not_before" IS NULL
      )
    ),
  CONSTRAINT "verification_goal_runs_recovery_shape_check"
    CHECK (
      ("status" <> 'recovery_required')
      OR (
        "started_at" IS NOT NULL
        AND "result" IS NULL
        AND "terminal_code" IS NULL
        AND "overall_outcome_id" IS NULL
        AND "goal_evidence_set_digest" IS NULL
        AND "goal_evidence_unit_fingerprint" IS NULL
        AND "lease_generation" IS NULL
        AND "lease_token" IS NULL
        AND "lease_expires_at" IS NULL
        AND "recovery_not_before" IS NOT NULL
      )
    ),
  CONSTRAINT "verification_goal_runs_completed_shape_check"
    CHECK (
      ("status" <> 'completed')
      OR (
        "started_at" IS NOT NULL
        AND "finished_at" IS NOT NULL
        AND "result" IS NOT NULL
        AND "terminal_code" IS NOT NULL
        AND "overall_outcome_id" IS NOT NULL
        AND "goal_evidence_set_digest" IS NOT NULL
        AND "goal_evidence_unit_fingerprint" IS NOT NULL
        AND "lease_generation" IS NULL
        AND "lease_token" IS NULL
        AND "lease_expires_at" IS NULL
      )
    ),
  CONSTRAINT "verification_goal_runs_expired_shape_check"
    CHECK (
      ("status" <> 'expired')
      OR (
        "started_at" IS NULL
        AND "finished_at" IS NOT NULL
        AND "result" IS NULL
        AND "terminal_code" = 'dispatch_expired'
        AND "overall_outcome_id" IS NULL
        AND "goal_evidence_set_digest" IS NULL
        AND "goal_evidence_unit_fingerprint" IS NULL
        AND "lease_generation" IS NULL
        AND "lease_token" IS NULL
        AND "lease_expires_at" IS NULL
      )
    )
);
--> statement-breakpoint
CREATE UNIQUE INDEX "verification_goal_runs_active_project_goal_idx"
ON "verification_goal_runs" USING btree ("project_id", "goal_id")
WHERE "status" IN ('queued', 'running', 'recovery_required');
--> statement-breakpoint
CREATE UNIQUE INDEX "verification_goal_runs_manual_idempotency_idx"
ON "verification_goal_runs" USING btree ("requested_by_user_id", "manual_idempotency_key")
WHERE "manual_idempotency_key" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "verification_goal_runs_project_status_created_idx"
ON "verification_goal_runs" USING btree ("project_id", "status", "created_at");
--> statement-breakpoint
CREATE INDEX "verification_goal_runs_project_goal_finished_idx"
ON "verification_goal_runs" USING btree ("project_id", "goal_id", "finished_at");
--> statement-breakpoint
CREATE INDEX "verification_goal_runs_project_created_idx"
ON "verification_goal_runs" USING btree ("project_id", "created_at");
--> statement-breakpoint
CREATE INDEX "verification_goal_runs_status_expiries_recovery_idx"
ON "verification_goal_runs" USING btree ("status", "lease_expires_at", "recovery_not_before");
--> statement-breakpoint
CREATE INDEX "verification_goal_runs_snapshot_history_idx"
ON "verification_goal_runs" USING btree ("snapshot_id", "created_at");
--> statement-breakpoint



-- ---------------------------------------------------------------------------
-- Immutable run evidence snapshots
-- ---------------------------------------------------------------------------
CREATE TABLE "verification_goal_repository_snapshots" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "verification_goal_run_id" uuid NOT NULL,
  "project_id" uuid NOT NULL,
  "project_submitted_by" uuid NOT NULL,
  "project_revision" timestamp with time zone NOT NULL,
  "root_binding_revision" bigint NOT NULL,
  "grant_decision_revision" bigint NOT NULL,
  "object_format" text,
  "head_oid" text,
  "strict_git_clean" boolean NOT NULL DEFAULT false,
  "git_metadata_fingerprint" text,
  "index_fingerprint" text,
  "config_fingerprint" text,
  "repository_snapshot_fingerprint" text NOT NULL,
  "captured_at" timestamp with time zone NOT NULL,
  CONSTRAINT "verification_goal_repository_snapshots_run_fk"
    FOREIGN KEY ("verification_goal_run_id") REFERENCES "public"."verification_goal_runs"("id")
    ON DELETE restrict ON UPDATE restrict,
  CONSTRAINT "verification_goal_repository_snapshots_project_id_fk"
    FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id")
    ON DELETE restrict ON UPDATE restrict,
  CONSTRAINT "verification_goal_repository_snapshots_submitted_by_fk"
    FOREIGN KEY ("project_submitted_by") REFERENCES "public"."users"("id")
    ON DELETE restrict ON UPDATE restrict,
  CONSTRAINT "verification_goal_repository_snapshots_object_format_check"
    CHECK ("object_format" IS NULL OR "object_format" IN ('sha1', 'sha256')),
  CONSTRAINT "verification_goal_repository_snapshots_head_oid_check"
    CHECK (
      "head_oid" IS NULL
      OR "head_oid" ~ '^[0-9a-f]{40}$'
      OR "head_oid" ~ '^[0-9a-f]{64}$'
    ),
  CONSTRAINT "verification_goal_repository_snapshots_fingerprints_check"
    CHECK (
      ("git_metadata_fingerprint" IS NULL OR "git_metadata_fingerprint" ~ '^[0-9a-f]{64}$')
      AND ("index_fingerprint" IS NULL OR "index_fingerprint" ~ '^[0-9a-f]{64}$')
      AND ("config_fingerprint" IS NULL OR "config_fingerprint" ~ '^[0-9a-f]{64}$')
      AND "repository_snapshot_fingerprint" ~ '^[0-9a-f]{64}$'
    )
);
--> statement-breakpoint
CREATE UNIQUE INDEX "verification_goal_repository_snapshots_run_idx"
ON "verification_goal_repository_snapshots" USING btree ("verification_goal_run_id");
--> statement-breakpoint
CREATE INDEX "verification_goal_repository_snapshots_project_captured_idx"
ON "verification_goal_repository_snapshots" USING btree ("project_id", "captured_at");
--> statement-breakpoint

CREATE TABLE "verification_goal_environment_snapshots" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "verification_goal_run_id" uuid NOT NULL,
  "project_id" uuid NOT NULL,
  "schema_version" integer NOT NULL,
  "runner_contract_version" integer NOT NULL,
  "forge_build_identity" text NOT NULL,
  "release_state_class" text NOT NULL,
  "root_launcher_contract_version" integer NOT NULL,
  "root_launcher_digest" text NOT NULL,
  "trusted_node_identity_digest" text NOT NULL,
  "trusted_node_version" text NOT NULL,
  "trusted_git_identity_digest" text NOT NULL,
  "trusted_git_version" text NOT NULL,
  "git_safety_profile_version" integer NOT NULL,
  "git_safety_profile_digest" text NOT NULL,
  "platform" text NOT NULL,
  "architecture" text NOT NULL,
  "operation_execution_binding_digest" text NOT NULL,
  "eligibility_version" integer NOT NULL,
  "eligibility_digest" text NOT NULL,
  "environment_fingerprint" text NOT NULL,
  "captured_at" timestamp with time zone NOT NULL,
  CONSTRAINT "verification_goal_environment_snapshots_run_fk"
    FOREIGN KEY ("verification_goal_run_id") REFERENCES "public"."verification_goal_runs"("id")
    ON DELETE restrict ON UPDATE restrict,
  CONSTRAINT "verification_goal_environment_snapshots_project_id_fk"
    FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id")
    ON DELETE restrict ON UPDATE restrict,
  CONSTRAINT "verification_goal_environment_snapshots_positive_versions_check"
    CHECK (
      "schema_version" > 0
      AND "runner_contract_version" > 0
      AND "root_launcher_contract_version" > 0
      AND "git_safety_profile_version" > 0
      AND "eligibility_version" > 0
    ),
  CONSTRAINT "verification_goal_environment_snapshots_digests_check"
    CHECK (
      "root_launcher_digest" ~ '^[0-9a-f]{64}$'
      AND "trusted_node_identity_digest" ~ '^[0-9a-f]{64}$'
      AND "trusted_git_identity_digest" ~ '^[0-9a-f]{64}$'
      AND "git_safety_profile_digest" ~ '^[0-9a-f]{64}$'
      AND "operation_execution_binding_digest" ~ '^[0-9a-f]{64}$'
      AND "eligibility_digest" ~ '^[0-9a-f]{64}$'
      AND "environment_fingerprint" ~ '^[0-9a-f]{64}$'
    )
);
--> statement-breakpoint
CREATE UNIQUE INDEX "verification_goal_environment_snapshots_run_idx"
ON "verification_goal_environment_snapshots" USING btree ("verification_goal_run_id");
--> statement-breakpoint
CREATE INDEX "verification_goal_environment_snapshots_project_captured_idx"
ON "verification_goal_environment_snapshots" USING btree ("project_id", "captured_at");
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Run events (defined after both snapshot surfaces they reference)
-- ---------------------------------------------------------------------------
CREATE TABLE "verification_goal_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "verification_goal_run_id" uuid NOT NULL,
  "event_sequence" integer NOT NULL,
  "phase" text NOT NULL,
  "status" text NOT NULL,
  "code" text,
  "operation_run_id" uuid,
  "repository_snapshot_id" uuid,
  "environment_snapshot_id" uuid,
  "evidence_ref" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "verification_goal_events_run_fk"
    FOREIGN KEY ("verification_goal_run_id") REFERENCES "public"."verification_goal_runs"("id")
    ON DELETE restrict ON UPDATE restrict,
  CONSTRAINT "verification_goal_events_operation_run_fk"
    FOREIGN KEY ("operation_run_id") REFERENCES "public"."operation_runs"("id")
    ON DELETE restrict ON UPDATE restrict,
  CONSTRAINT "verification_goal_events_repository_snapshot_fk"
    FOREIGN KEY ("repository_snapshot_id") REFERENCES "public"."verification_goal_repository_snapshots"("id")
    ON DELETE restrict ON UPDATE restrict,
  CONSTRAINT "verification_goal_events_environment_snapshot_fk"
    FOREIGN KEY ("environment_snapshot_id") REFERENCES "public"."verification_goal_environment_snapshots"("id")
    ON DELETE restrict ON UPDATE restrict,
  CONSTRAINT "verification_goal_events_phase_check"
    CHECK ("phase" IN (
      'admitted', 'claimed', 'repository_captured', 'environment_captured',
      'child_begun', 'child_completed', 'terminalized', 'expired', 'recovered'
    )),
  CONSTRAINT "verification_goal_events_status_check"
    CHECK ("status" IN ('ok', 'blocked', 'failed', 'inconclusive')),
  CONSTRAINT "verification_goal_events_code_check"
    CHECK ("code" IS NULL OR length("code") BETWEEN 1 AND 64)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "verification_goal_events_run_sequence_idx"
ON "verification_goal_events" USING btree ("verification_goal_run_id", "event_sequence");
--> statement-breakpoint
CREATE INDEX "verification_goal_events_run_created_idx"
ON "verification_goal_events" USING btree ("verification_goal_run_id", "created_at");
--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- Scheduling surfaces
-- ---------------------------------------------------------------------------
CREATE TABLE "verification_goal_schedule_bindings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL,
  "registry_revision_id" uuid NOT NULL,
  "registry_entry_ordinal" integer NOT NULL,
  "snapshot_id" uuid NOT NULL,
  "goal_id" text NOT NULL,
  "definition_version" integer NOT NULL,
  "definition_digest" text NOT NULL,
  "execution_binding_digest" text NOT NULL,
  "policy_revision_id" uuid NOT NULL,
  "policy_revision_sequence" bigint NOT NULL,
  "interval_seconds" bigint NOT NULL,
  "anchor_at" timestamp with time zone NOT NULL,
  "binding_fingerprint" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "verification_goal_schedule_bindings_project_id_fk"
    FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id")
    ON DELETE restrict ON UPDATE restrict,
  CONSTRAINT "verification_goal_schedule_bindings_registry_entry_fk"
    FOREIGN KEY ("registry_revision_id", "registry_entry_ordinal")
    REFERENCES "public"."verification_goal_registry_entries"("registry_revision_id", "ordinal")
    ON DELETE restrict ON UPDATE restrict,
  CONSTRAINT "verification_goal_schedule_bindings_snapshot_identity_fk"
    FOREIGN KEY (
      "snapshot_id", "project_id", "goal_id", "definition_version", "definition_digest"
    )
    REFERENCES "public"."verification_goal_snapshots"(
      "id", "project_id", "goal_id", "definition_version", "definition_digest"
    )
    ON DELETE restrict ON UPDATE restrict,
  CONSTRAINT "verification_goal_schedule_bindings_policy_revision_fk"
    FOREIGN KEY ("policy_revision_id", "project_id", "policy_revision_sequence")
    REFERENCES "public"."verification_goal_policy_revisions"(
      "id", "project_id", "revision_sequence"
    )
    ON DELETE restrict ON UPDATE restrict,
  CONSTRAINT "verification_goal_schedule_bindings_interval_check"
    CHECK ("interval_seconds" > 0),
  CONSTRAINT "verification_goal_schedule_bindings_fingerprint_check"
    CHECK (
      "binding_fingerprint" ~ '^[0-9a-f]{64}$'
      AND "execution_binding_digest" ~ '^[0-9a-f]{64}$'
      AND "definition_digest" ~ '^[0-9a-f]{64}$'
    )
);
--> statement-breakpoint
CREATE INDEX "verification_goal_schedule_bindings_project_created_idx"
ON "verification_goal_schedule_bindings" USING btree ("project_id", "created_at");
--> statement-breakpoint

CREATE TABLE "verification_goal_schedule_heads" (
  "project_id" uuid PRIMARY KEY NOT NULL,
  "schedule_binding_id" uuid,
  "binding_fingerprint" text,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "verification_goal_schedule_heads_project_id_fk"
    FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id")
    ON DELETE restrict ON UPDATE restrict,
  CONSTRAINT "verification_goal_schedule_heads_binding_fk"
    FOREIGN KEY ("schedule_binding_id") REFERENCES "public"."verification_goal_schedule_bindings"("id")
    ON DELETE restrict ON UPDATE restrict,
  CONSTRAINT "verification_goal_schedule_heads_shape_check"
    CHECK (
      ("schedule_binding_id" IS NULL AND "binding_fingerprint" IS NULL)
      OR (
        "schedule_binding_id" IS NOT NULL
        AND "binding_fingerprint" IS NOT NULL
        AND "binding_fingerprint" ~ '^[0-9a-f]{64}$'
      )
    )
);
--> statement-breakpoint

CREATE TABLE "verification_goal_schedule_slots" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "schedule_binding_id" uuid NOT NULL,
  "slot_sequence" bigint NOT NULL,
  "due_at" timestamp with time zone NOT NULL,
  "run_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "verification_goal_schedule_slots_binding_fk"
    FOREIGN KEY ("schedule_binding_id") REFERENCES "public"."verification_goal_schedule_bindings"("id")
    ON DELETE restrict ON UPDATE restrict,
  CONSTRAINT "verification_goal_schedule_slots_run_fk"
    FOREIGN KEY ("run_id") REFERENCES "public"."verification_goal_runs"("id")
    ON DELETE set null ON UPDATE restrict,
  CONSTRAINT "verification_goal_schedule_slots_sequence_check"
    CHECK ("slot_sequence" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "verification_goal_schedule_slots_binding_sequence_idx"
ON "verification_goal_schedule_slots" USING btree ("schedule_binding_id", "slot_sequence");
--> statement-breakpoint
CREATE INDEX "verification_goal_schedule_slots_due_idx"
ON "verification_goal_schedule_slots" USING btree ("due_at");
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Shared ledger expansion for dual execution subjects
-- ---------------------------------------------------------------------------
-- These ledgers are owned by the migration login, so temporarily leave the
-- protected-owner role for the exact ALTERs below. Their new foreign keys
-- point at the protected run surface, so the owner grants the migration login
-- the exact REFERENCES privilege first and revokes it immediately after.
GRANT REFERENCES ON TABLE public.verification_goal_runs TO SESSION_USER;
--> statement-breakpoint
RESET ROLE;
--> statement-breakpoint
ALTER TABLE "public"."execution_outcomes"
ADD COLUMN "verification_goal_run_id" uuid,
ADD COLUMN "failure_class" text;
--> statement-breakpoint
ALTER TABLE "public"."execution_outcomes"
ADD CONSTRAINT "execution_outcomes_verification_goal_run_fk"
FOREIGN KEY ("verification_goal_run_id") REFERENCES "public"."verification_goal_runs"("id")
ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE "public"."execution_outcomes"
ALTER COLUMN "task_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "public"."execution_outcomes"
DROP CONSTRAINT IF EXISTS "execution_outcomes_schema_version_check";
--> statement-breakpoint
ALTER TABLE "public"."execution_outcomes"
ADD CONSTRAINT "execution_outcomes_schema_version_check"
CHECK ("schema_version" IN (1, 2));
--> statement-breakpoint
ALTER TABLE "public"."execution_outcomes"
ADD CONSTRAINT "execution_outcomes_failure_class_check"
CHECK ("failure_class" IS NULL OR "failure_class" IN (
  'functional', 'policy', 'authority', 'infrastructure', 'evidence', 'cancelled'
));
--> statement-breakpoint
ALTER TABLE "public"."execution_outcomes"
ADD CONSTRAINT "execution_outcomes_subject_check"
CHECK (
  ("task_id" IS NOT NULL AND "verification_goal_run_id" IS NULL AND "schema_version" = 1)
  OR (
    "task_id" IS NULL
    AND "verification_goal_run_id" IS NOT NULL
    AND "schema_version" = 2
    AND "work_package_id" IS NULL
    AND "agent_run_id" IS NULL
    AND "task_attempt_id" IS NULL
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX "execution_outcomes_goal_attempt_key_idx"
ON "public"."execution_outcomes" USING btree ("verification_goal_run_id", "attempt_key")
WHERE "verification_goal_run_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "execution_outcomes_verification_goal_run_id_idx"
ON "public"."execution_outcomes" USING btree ("verification_goal_run_id");
--> statement-breakpoint

ALTER TABLE "public"."operation_runs"
ADD COLUMN "verification_goal_run_id" uuid,
ADD COLUMN "goal_operation_ordinal" integer;
--> statement-breakpoint
ALTER TABLE "public"."operation_runs"
ADD CONSTRAINT "operation_runs_verification_goal_run_fk"
FOREIGN KEY ("verification_goal_run_id") REFERENCES "public"."verification_goal_runs"("id")
ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE "public"."operation_runs"
ALTER COLUMN "task_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "public"."operation_runs"
ADD CONSTRAINT "operation_runs_goal_ordinal_unique"
UNIQUE ("verification_goal_run_id", "goal_operation_ordinal");
--> statement-breakpoint
ALTER TABLE "public"."operation_runs"
ADD CONSTRAINT "operation_runs_subject_check"
CHECK (
  ("task_id" IS NOT NULL AND "verification_goal_run_id" IS NULL AND "goal_operation_ordinal" IS NULL)
  OR (
    "task_id" IS NULL
    AND "verification_goal_run_id" IS NOT NULL
    AND "goal_operation_ordinal" IS NOT NULL
    AND "work_package_id" IS NULL
    AND "agent_run_id" IS NULL
    AND "task_attempt_id" IS NULL
  )
);
--> statement-breakpoint
CREATE INDEX "operation_runs_verification_goal_run_id_idx"
ON "public"."operation_runs" USING btree ("verification_goal_run_id");
--> statement-breakpoint

ALTER TABLE "public"."repository_command_audits"
ADD COLUMN "verification_goal_run_id" uuid,
ADD COLUMN "operation_run_id" uuid;
--> statement-breakpoint
ALTER TABLE "public"."repository_command_audits"
ADD CONSTRAINT "repository_command_audits_verification_goal_run_fk"
FOREIGN KEY ("verification_goal_run_id") REFERENCES "public"."verification_goal_runs"("id")
ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE "public"."repository_command_audits"
ADD CONSTRAINT "repository_command_audits_operation_run_fk"
FOREIGN KEY ("operation_run_id") REFERENCES "public"."operation_runs"("id")
ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE "public"."repository_command_audits"
ALTER COLUMN "task_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "public"."repository_command_audits"
ADD CONSTRAINT "repository_command_audits_subject_check"
CHECK (
  ("task_id" IS NOT NULL AND "verification_goal_run_id" IS NULL AND "operation_run_id" IS NULL)
  OR ("task_id" IS NULL AND "verification_goal_run_id" IS NOT NULL AND "operation_run_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE INDEX "repository_command_audits_verification_goal_run_id_idx"
ON "public"."repository_command_audits" USING btree ("verification_goal_run_id");
--> statement-breakpoint
CREATE INDEX "repository_command_audits_operation_run_id_idx"
ON "public"."repository_command_audits" USING btree ("operation_run_id");
--> statement-breakpoint

ALTER TABLE "public"."capability_attempts"
ADD COLUMN "verification_goal_run_id" uuid;
--> statement-breakpoint
ALTER TABLE "public"."capability_attempts"
ADD CONSTRAINT "capability_attempts_verification_goal_run_fk"
FOREIGN KEY ("verification_goal_run_id") REFERENCES "public"."verification_goal_runs"("id")
ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE "public"."capability_attempts"
ALTER COLUMN "task_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "public"."capability_attempts"
DROP CONSTRAINT IF EXISTS "capability_attempts_contract_version_check";
--> statement-breakpoint
ALTER TABLE "public"."capability_attempts"
ADD CONSTRAINT "capability_attempts_contract_version_check"
CHECK ("contract_version" IN (1, 2));
--> statement-breakpoint
ALTER TABLE "public"."capability_attempts"
ADD CONSTRAINT "capability_attempts_subject_check"
CHECK (
  ("task_id" IS NOT NULL AND "verification_goal_run_id" IS NULL AND "contract_version" = 1)
  OR (
    "task_id" IS NULL
    AND "verification_goal_run_id" IS NOT NULL
    AND "contract_version" = 2
    AND "work_package_id" IS NULL
    AND "agent_run_id" IS NULL
    AND "task_attempt_id" IS NULL
  )
);
--> statement-breakpoint
CREATE INDEX "capability_attempts_verification_goal_run_id_idx"
ON "public"."capability_attempts" USING btree ("verification_goal_run_id");
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Append-only / immutable evidence guards
-- ---------------------------------------------------------------------------
SET ROLE forge_s4_routines_owner;
--> statement-breakpoint
REVOKE REFERENCES ON TABLE public.verification_goal_runs FROM SESSION_USER;
--> statement-breakpoint
CREATE FUNCTION public.forge_guard_verification_goal_evidence_mutation_v1()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'verification goal evidence is append-only and cannot be deleted'
      USING ERRCODE = 'P1873';
  END IF;
  IF session_user <> 'forge' OR current_user <> 'forge_s4_routines_owner' THEN
    RAISE EXCEPTION 'verification goal evidence mutation is protected'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER "verification_goal_policy_revisions_append_only"
BEFORE UPDATE OR DELETE ON "verification_goal_policy_revisions"
FOR EACH ROW EXECUTE FUNCTION public.forge_guard_verification_goal_evidence_mutation_v1();
--> statement-breakpoint
CREATE TRIGGER "verification_goal_policy_heads_protected_write"
BEFORE UPDATE OR DELETE ON "verification_goal_policy_heads"
FOR EACH ROW EXECUTE FUNCTION public.forge_guard_verification_goal_evidence_mutation_v1();
--> statement-breakpoint
CREATE TRIGGER "verification_goal_runs_protected_write"
BEFORE UPDATE OR DELETE ON "verification_goal_runs"
FOR EACH ROW EXECUTE FUNCTION public.forge_guard_verification_goal_evidence_mutation_v1();
--> statement-breakpoint
CREATE TRIGGER "verification_goal_events_append_only"
BEFORE UPDATE OR DELETE ON "verification_goal_events"
FOR EACH ROW EXECUTE FUNCTION public.forge_guard_verification_goal_evidence_mutation_v1();
--> statement-breakpoint
CREATE TRIGGER "verification_goal_repository_snapshots_append_only"
BEFORE UPDATE OR DELETE ON "verification_goal_repository_snapshots"
FOR EACH ROW EXECUTE FUNCTION public.forge_guard_verification_goal_evidence_mutation_v1();
--> statement-breakpoint
CREATE TRIGGER "verification_goal_environment_snapshots_append_only"
BEFORE UPDATE OR DELETE ON "verification_goal_environment_snapshots"
FOR EACH ROW EXECUTE FUNCTION public.forge_guard_verification_goal_evidence_mutation_v1();
--> statement-breakpoint
CREATE TRIGGER "verification_goal_schedule_bindings_append_only"
BEFORE UPDATE OR DELETE ON "verification_goal_schedule_bindings"
FOR EACH ROW EXECUTE FUNCTION public.forge_guard_verification_goal_evidence_mutation_v1();
--> statement-breakpoint
CREATE TRIGGER "verification_goal_schedule_heads_protected_write"
BEFORE UPDATE OR DELETE ON "verification_goal_schedule_heads"
FOR EACH ROW EXECUTE FUNCTION public.forge_guard_verification_goal_evidence_mutation_v1();
--> statement-breakpoint
CREATE TRIGGER "verification_goal_schedule_slots_append_only"
BEFORE UPDATE OR DELETE ON "verification_goal_schedule_slots"
FOR EACH ROW EXECUTE FUNCTION public.forge_guard_verification_goal_evidence_mutation_v1();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Protected routines
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.forge_commit_verification_goal_policy_revision_v1(
  p_project_id uuid,
  p_actor_user_id uuid,
  p_expected_head_revision_id uuid,
  p_expected_head_sequence bigint,
  p_manual_enabled boolean,
  p_scheduling_enabled boolean,
  p_min_schedule_interval_seconds bigint,
  p_max_run_deadline_seconds bigint,
  p_max_queue_age_seconds bigint,
  p_max_operations_per_run integer,
  p_max_concurrent_runs integer,
  p_max_queued_runs integer,
  p_max_active_runs integer,
  p_start_budget_window_seconds bigint,
  p_max_starts_per_window bigint,
  p_actor_kind text,
  p_revision_actor_user_id uuid,
  p_policy_digest text
)
RETURNS TABLE (
  policy_revision_id uuid,
  revision_sequence bigint,
  head_state text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_head public.verification_goal_policy_heads%ROWTYPE;
  v_new_sequence bigint;
  v_new_revision_id uuid;
  v_affected integer;
BEGIN
  IF session_user <> 'forge' OR current_user <> 'forge_s4_routines_owner' THEN
    RAISE EXCEPTION 'verification goal policy commit requires the fixed Forge login'
      USING ERRCODE = '42501';
  END IF;
  IF p_actor_kind NOT IN ('migration_seed', 'system_default', 'human') THEN
    RAISE EXCEPTION 'verification goal policy actor kind is invalid'
      USING ERRCODE = '22023';
  END IF;
  IF (
    p_actor_kind IN ('migration_seed', 'system_default')
    AND p_revision_actor_user_id IS NOT NULL
  ) OR (
    p_actor_kind = 'human'
    AND p_revision_actor_user_id IS NULL
  ) THEN
    RAISE EXCEPTION 'verification goal policy actor shape is invalid'
      USING ERRCODE = '22023';
  END IF;
  IF p_min_schedule_interval_seconds <= 0
     OR p_max_run_deadline_seconds <= 0
     OR p_max_queue_age_seconds <= 0
     OR p_max_operations_per_run <= 0
     OR p_max_concurrent_runs <= 0
     OR p_max_queued_runs <= 0
     OR p_max_active_runs <= 0
     OR p_start_budget_window_seconds <= 0
     OR p_max_starts_per_window <= 0 THEN
    RAISE EXCEPTION 'verification goal policy bounds must be positive'
      USING ERRCODE = '22023';
  END IF;
  IF p_policy_digest !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'verification goal policy digest is invalid'
      USING ERRCODE = '22023';
  END IF;

  PERFORM 1 FROM public.projects
  WHERE id = p_project_id
  FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'verification goal policy project does not exist'
      USING ERRCODE = 'P1871';
  END IF;

  SELECT * INTO v_head
  FROM public.verification_goal_policy_heads
  WHERE project_id = p_project_id
  FOR UPDATE;

  IF v_head.policy_revision_id IS DISTINCT FROM p_expected_head_revision_id
     OR v_head.revision_sequence IS DISTINCT FROM p_expected_head_sequence THEN
    RAISE EXCEPTION 'verification goal policy head changed'
      USING ERRCODE = 'P1872';
  END IF;

  v_new_sequence := COALESCE(v_head.revision_sequence, 0::bigint) + 1;

  INSERT INTO public.verification_goal_policy_revisions (
    project_id, revision_sequence, policy_digest, manual_enabled, scheduling_enabled,
    min_schedule_interval_seconds, max_run_deadline_seconds, max_queue_age_seconds,
    max_operations_per_run, max_concurrent_runs, max_queued_runs, max_active_runs,
    start_budget_window_seconds, max_starts_per_window, actor_kind, actor_user_id,
    predecessor_revision_id
  ) VALUES (
    p_project_id, v_new_sequence, p_policy_digest, p_manual_enabled, p_scheduling_enabled,
    p_min_schedule_interval_seconds, p_max_run_deadline_seconds, p_max_queue_age_seconds,
    p_max_operations_per_run, p_max_concurrent_runs, p_max_queued_runs, p_max_active_runs,
    p_start_budget_window_seconds, p_max_starts_per_window, p_actor_kind, p_revision_actor_user_id,
    v_head.policy_revision_id
  ) RETURNING id INTO v_new_revision_id;

  IF v_head.project_id IS NULL THEN
    INSERT INTO public.verification_goal_policy_heads (
      project_id, policy_revision_id, revision_sequence
    ) VALUES (p_project_id, v_new_revision_id, v_new_sequence);
  ELSE
    UPDATE public.verification_goal_policy_heads
    SET policy_revision_id = v_new_revision_id,
        revision_sequence = v_new_sequence,
        updated_at = pg_catalog.clock_timestamp()
    WHERE project_id = p_project_id
      AND policy_revision_id = v_head.policy_revision_id
      AND revision_sequence = v_head.revision_sequence;
    GET DIAGNOSTICS v_affected = ROW_COUNT;
    IF v_affected <> 1 THEN
      RAISE EXCEPTION 'verification goal policy head changed before advance'
        USING ERRCODE = 'P1872';
    END IF;
  END IF;

  policy_revision_id := v_new_revision_id;
  revision_sequence := v_new_sequence;
  head_state := CASE WHEN v_head.project_id IS NULL THEN 'inserted' ELSE 'advanced' END;
  RETURN NEXT;
END;
$$;
--> statement-breakpoint

CREATE FUNCTION public.forge_claim_verification_goal_run_lease_v1(
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
    AND (lease_expires_at IS NULL OR lease_expires_at <= pg_catalog.clock_timestamp());
  GET DIAGNOSTICS v_affected = ROW_COUNT;
  IF v_affected <> 1 THEN
    RAISE EXCEPTION 'verification goal run lease claim failed'
      USING ERRCODE = 'P1872';
  END IF;
END;
$$;
--> statement-breakpoint

CREATE FUNCTION public.forge_begin_verification_goal_child_operation_v1(
  p_run_id uuid,
  p_ordinal integer,
  p_operation_id text,
  p_operation_version integer,
  p_capability text,
  p_idempotency_key text,
  p_definition_digest text,
  p_scope_fingerprint text,
  p_request_fingerprint text,
  p_inputs_fingerprint text,
  p_reason_fingerprint text,
  p_policy_decision jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_run public.verification_goal_runs%ROWTYPE;
  v_existing uuid;
  v_new_id uuid;
  v_earlier_count integer;
BEGIN
  IF session_user <> 'forge' OR current_user <> 'forge_s4_routines_owner' THEN
    RAISE EXCEPTION 'verification goal child begin requires the fixed Forge login'
      USING ERRCODE = '42501';
  END IF;
  IF p_ordinal < 0
     OR p_operation_version <= 0
     OR p_idempotency_key !~ '^[0-9a-f]{64}$'
     OR p_definition_digest !~ '^[0-9a-f]{64}$'
     OR p_scope_fingerprint !~ '^[0-9a-f]{64}$'
     OR p_request_fingerprint !~ '^[0-9a-f]{64}$'
     OR p_inputs_fingerprint !~ '^[0-9a-f]{64}$'
     OR p_reason_fingerprint !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'verification goal child operation parameters are invalid'
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
  FROM public.operation_runs
  WHERE verification_goal_run_id = p_run_id
    AND goal_operation_ordinal = p_ordinal;
  IF FOUND THEN
    RAISE EXCEPTION 'verification goal child operation already exists at ordinal %', p_ordinal
      USING ERRCODE = 'P1872';
  END IF;

  SELECT count(*) INTO v_earlier_count
  FROM public.operation_runs
  WHERE verification_goal_run_id = p_run_id
    AND goal_operation_ordinal < p_ordinal
    AND status = 'completed';
  IF v_earlier_count <> p_ordinal THEN
    RAISE EXCEPTION 'verification goal child operation prefix is incomplete'
      USING ERRCODE = 'P1873';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.operation_runs
    WHERE verification_goal_run_id = p_run_id
      AND goal_operation_ordinal > p_ordinal
  ) THEN
    RAISE EXCEPTION 'verification goal child operation cannot start after a later ordinal'
      USING ERRCODE = 'P1873';
  END IF;

  INSERT INTO public.operation_runs (
    task_id, verification_goal_run_id, project_id, work_package_id, agent_run_id,
    task_attempt_id, execution_outcome_id, definition_schema_version, operation_id,
    operation_version, capability, idempotency_key, definition_digest, scope_fingerprint,
    request_fingerprint, inputs_fingerprint, reason_fingerprint, policy_decision,
    status, verification_status, goal_operation_ordinal
  ) VALUES (
    NULL, p_run_id, v_run.project_id, NULL, NULL, NULL, NULL, 1, p_operation_id,
    p_operation_version, p_capability, p_idempotency_key, p_definition_digest,
    p_scope_fingerprint, p_request_fingerprint, p_inputs_fingerprint,
    p_reason_fingerprint, p_policy_decision, 'running', 'not_started', p_ordinal
  ) RETURNING id INTO v_new_id;

  RETURN v_new_id;
END;
$$;
--> statement-breakpoint

CREATE FUNCTION public.forge_terminalize_verification_goal_run_v1(
  p_run_id uuid,
  p_result text,
  p_terminal_code text,
  p_overall_outcome_id uuid,
  p_goal_evidence_set_digest text,
  p_goal_evidence_unit_fingerprint text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_run public.verification_goal_runs%ROWTYPE;
  v_child_count integer;
  v_completed_count integer;
  v_failed_count integer;
  v_affected integer;
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

  SELECT count(*), count(*) FILTER (WHERE status = 'completed'),
         count(*) FILTER (WHERE status = 'failed')
  INTO v_child_count, v_completed_count, v_failed_count
  FROM public.operation_runs
  WHERE verification_goal_run_id = p_run_id;

  IF p_result = 'passed' AND v_child_count <> v_completed_count THEN
    RAISE EXCEPTION 'verification goal passed terminalization requires all children to be completed'
      USING ERRCODE = 'P1873';
  END IF;
  IF p_result = 'failed' AND v_failed_count <> 1 THEN
    RAISE EXCEPTION 'verification goal failed terminalization requires exactly one functional failure'
      USING ERRCODE = 'P1873';
  END IF;
  IF p_result = 'inconclusive' AND v_child_count = 0 THEN
    RAISE EXCEPTION 'verification goal inconclusive terminalization requires at least one child'
      USING ERRCODE = 'P1873';
  END IF;

  UPDATE public.verification_goal_runs
  SET status = 'completed',
      result = p_result,
      terminal_code = p_terminal_code,
      overall_outcome_id = p_overall_outcome_id,
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
END;
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Ownership and ACL
-- ---------------------------------------------------------------------------
ALTER TABLE "verification_goal_policy_revisions" OWNER TO forge_s4_routines_owner;
ALTER TABLE "verification_goal_policy_heads" OWNER TO forge_s4_routines_owner;
ALTER TABLE "verification_goal_runs" OWNER TO forge_s4_routines_owner;
ALTER TABLE "verification_goal_events" OWNER TO forge_s4_routines_owner;
ALTER TABLE "verification_goal_repository_snapshots" OWNER TO forge_s4_routines_owner;
ALTER TABLE "verification_goal_environment_snapshots" OWNER TO forge_s4_routines_owner;
ALTER TABLE "verification_goal_schedule_bindings" OWNER TO forge_s4_routines_owner;
ALTER TABLE "verification_goal_schedule_heads" OWNER TO forge_s4_routines_owner;
ALTER TABLE "verification_goal_schedule_slots" OWNER TO forge_s4_routines_owner;
--> statement-breakpoint
ALTER FUNCTION public.forge_guard_verification_goal_evidence_mutation_v1() OWNER TO forge_s4_routines_owner;
ALTER FUNCTION public.forge_commit_verification_goal_policy_revision_v1(
  uuid, uuid, uuid, bigint, boolean, boolean, bigint, bigint, bigint, integer,
  integer, integer, integer, bigint, bigint, text, uuid, text
) OWNER TO forge_s4_routines_owner;
ALTER FUNCTION public.forge_claim_verification_goal_run_lease_v1(uuid, bigint, uuid, timestamptz)
  OWNER TO forge_s4_routines_owner;
ALTER FUNCTION public.forge_begin_verification_goal_child_operation_v1(
  uuid, integer, text, integer, text, text, text, text, text, text, text, jsonb
) OWNER TO forge_s4_routines_owner;
ALTER FUNCTION public.forge_terminalize_verification_goal_run_v1(
  uuid, text, text, uuid, text, text
) OWNER TO forge_s4_routines_owner;
--> statement-breakpoint

REVOKE ALL PRIVILEGES ON TABLE
  "verification_goal_policy_revisions",
  "verification_goal_policy_heads",
  "verification_goal_runs",
  "verification_goal_events",
  "verification_goal_repository_snapshots",
  "verification_goal_environment_snapshots",
  "verification_goal_schedule_bindings",
  "verification_goal_schedule_heads",
  "verification_goal_schedule_slots"
FROM PUBLIC, forge;
--> statement-breakpoint
GRANT SELECT ON TABLE
  "verification_goal_policy_revisions",
  "verification_goal_policy_heads",
  "verification_goal_runs",
  "verification_goal_events",
  "verification_goal_repository_snapshots",
  "verification_goal_environment_snapshots",
  "verification_goal_schedule_bindings",
  "verification_goal_schedule_heads",
  "verification_goal_schedule_slots"
TO forge;
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.forge_guard_verification_goal_evidence_mutation_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.forge_commit_verification_goal_policy_revision_v1(
  uuid, uuid, uuid, bigint, boolean, boolean, bigint, bigint, bigint, integer,
  integer, integer, integer, bigint, bigint, text, uuid, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.forge_claim_verification_goal_run_lease_v1(uuid, bigint, uuid, timestamptz)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.forge_begin_verification_goal_child_operation_v1(
  uuid, integer, text, integer, text, text, text, text, text, text, text, jsonb
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.forge_terminalize_verification_goal_run_v1(
  uuid, text, text, uuid, text, text
) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.forge_commit_verification_goal_policy_revision_v1(
  uuid, uuid, uuid, bigint, boolean, boolean, bigint, bigint, bigint, integer,
  integer, integer, integer, bigint, bigint, text, uuid, text
) TO forge;
GRANT EXECUTE ON FUNCTION public.forge_claim_verification_goal_run_lease_v1(uuid, bigint, uuid, timestamptz)
  TO forge;
GRANT EXECUTE ON FUNCTION public.forge_begin_verification_goal_child_operation_v1(
  uuid, integer, text, integer, text, text, text, text, text, text, text, jsonb
) TO forge;
GRANT EXECUTE ON FUNCTION public.forge_terminalize_verification_goal_run_v1(
  uuid, text, text, uuid, text, text
) TO forge;
--> statement-breakpoint

RESET ROLE;
--> statement-breakpoint
REVOKE REFERENCES ON TABLE
  public.projects,
  public.users,
  public.execution_outcomes,
  public.operation_runs,
  public.verification_goal_snapshots
FROM forge_s4_routines_owner;
--> statement-breakpoint
SELECT public.forge_finalize_epic_172_s4_owner_bootstrap_v1();
