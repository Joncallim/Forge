-- Epic 172 / issue 178 (S3): monotonic filesystem decisions, immutable
-- decision history, a preallocated current-authority pointer, and the strict
-- nonterminal operator-hold marker. Step 0 owns migrations 0023 through 0025.

ALTER TABLE "projects"
  ADD COLUMN "grant_decision_revision" bigint DEFAULT 0 NOT NULL,
  ADD COLUMN "root_binding_revision" bigint DEFAULT 0 NOT NULL,
  ADD CONSTRAINT "projects_grant_decision_revision_nonnegative"
    CHECK ("grant_decision_revision" >= 0),
  ADD CONSTRAINT "projects_root_binding_revision_nonnegative"
    CHECK ("root_binding_revision" >= 0);

ALTER TABLE "filesystem_mcp_grant_approvals"
  ADD COLUMN "project_id" uuid,
  ADD COLUMN "decision_scope" text DEFAULT 'package' NOT NULL,
  ADD COLUMN "grant_decision_revision" bigint,
  ADD COLUMN "root_binding_revision" bigint,
  ADD COLUMN "grant_nonce" uuid,
  ADD COLUMN "pointer_fingerprint" text,
  ADD CONSTRAINT "filesystem_mcp_grant_approvals_revision_pair_check"
    CHECK (
      ("grant_decision_revision" IS NULL AND "root_binding_revision" IS NULL)
      OR
      ("grant_decision_revision" > 0 AND "root_binding_revision" > 0)
    ),
  ADD CONSTRAINT "filesystem_mcp_grant_approvals_nonce_decision_check"
    CHECK ("grant_nonce" IS NULL OR "decision" = 'approved'),
  ADD CONSTRAINT "filesystem_mcp_grant_approvals_scope_check"
    CHECK (
      "decision_scope" = 'package' AND "task_id" IS NOT NULL AND "work_package_id" IS NOT NULL
    );

UPDATE "filesystem_mcp_grant_approvals" approval
SET "project_id" = task."project_id"
FROM "tasks" task
WHERE task."id" = approval."task_id";

ALTER TABLE "filesystem_mcp_grant_approvals"
  ALTER COLUMN "project_id" SET NOT NULL,
  ALTER COLUMN "task_id" DROP NOT NULL,
  ALTER COLUMN "work_package_id" DROP NOT NULL,
  ADD CONSTRAINT "filesystem_mcp_grant_approvals_project_fk"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE restrict;

ALTER TABLE "filesystem_mcp_grant_approvals"
  DROP CONSTRAINT "filesystem_mcp_grant_approvals_task_id_tasks_id_fk",
  DROP CONSTRAINT "filesystem_mcp_grant_approvals_work_package_id_work_packages_id_fk",
  ADD CONSTRAINT "filesystem_mcp_grant_approvals_task_id_tasks_id_fk"
    FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE restrict,
  ADD CONSTRAINT "filesystem_mcp_grant_approvals_work_package_id_work_packages_id_fk"
    FOREIGN KEY ("work_package_id") REFERENCES "work_packages"("id") ON DELETE restrict;

DROP INDEX "filesystem_mcp_grant_approvals_work_package_id_idx";
CREATE INDEX "filesystem_mcp_grant_approvals_work_package_id_idx"
  ON "filesystem_mcp_grant_approvals" ("work_package_id");
CREATE INDEX "filesystem_mcp_grant_approvals_project_id_idx"
  ON "filesystem_mcp_grant_approvals" ("project_id");
CREATE UNIQUE INDEX "filesystem_mcp_grant_approvals_grant_nonce_idx"
  ON "filesystem_mcp_grant_approvals" ("grant_nonce")
  WHERE "grant_nonce" IS NOT NULL;
CREATE INDEX "filesystem_mcp_grant_approvals_revision_idx"
  ON "filesystem_mcp_grant_approvals" ("grant_decision_revision");
CREATE UNIQUE INDEX "filesystem_mcp_grant_approvals_pointer_parent_idx"
  ON "filesystem_mcp_grant_approvals" (
    "id", "task_id", "work_package_id", "grant_decision_revision", "pointer_fingerprint"
  );

CREATE TABLE "filesystem_mcp_current_decision_pointers" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "task_id" uuid NOT NULL,
  "work_package_id" uuid NOT NULL,
  "current_decision_id" uuid,
  "current_decision_task_id" uuid,
  "current_decision_work_package_id" uuid,
  "current_decision_revision" bigint,
  "current_decision_fingerprint" text,
  "pointer_fingerprint" text NOT NULL,
  "pointer_version" bigint DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "filesystem_mcp_current_decision_pointers_task_fk"
    FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE cascade,
  CONSTRAINT "filesystem_mcp_current_decision_pointers_package_fk"
    FOREIGN KEY ("work_package_id") REFERENCES "work_packages"("id") ON DELETE cascade,
  CONSTRAINT "filesystem_mcp_current_decision_pointers_parent_fk"
    FOREIGN KEY (
      "current_decision_id", "current_decision_task_id", "current_decision_work_package_id",
      "current_decision_revision", "current_decision_fingerprint"
    ) REFERENCES "filesystem_mcp_grant_approvals" (
      "id", "task_id", "work_package_id", "grant_decision_revision", "pointer_fingerprint"
    ) MATCH FULL ON UPDATE restrict ON DELETE restrict,
  CONSTRAINT "filesystem_mcp_current_decision_pointers_version_check"
    CHECK ("pointer_version" >= 0),
  CONSTRAINT "filesystem_mcp_current_decision_pointers_revision_check"
    CHECK (
      (
        "current_decision_id" IS NULL
        AND "current_decision_task_id" IS NULL
        AND "current_decision_work_package_id" IS NULL
        AND "current_decision_revision" IS NULL
        AND "current_decision_fingerprint" IS NULL
        AND (
          ("pointer_version" = 0 AND "pointer_fingerprint" = ('empty:' || "work_package_id"::text))
          OR (
            "pointer_version" = 1
            AND "pointer_fingerprint" ~ '^legacy:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          )
        )
      )
      OR
      (
        "current_decision_id" IS NOT NULL
        AND "current_decision_task_id" = "task_id"
        AND "current_decision_work_package_id" = "work_package_id"
        AND "current_decision_revision" > 0
        AND "current_decision_fingerprint" = "pointer_fingerprint"
        AND "current_decision_fingerprint" ~ '^sha256:[0-9a-f]{64}$'
        AND "pointer_version" > 0
      )
    )
);

CREATE UNIQUE INDEX "filesystem_mcp_current_decision_pointers_work_package_idx"
  ON "filesystem_mcp_current_decision_pointers" ("work_package_id");
CREATE INDEX "filesystem_mcp_current_decision_pointers_task_idx"
  ON "filesystem_mcp_current_decision_pointers" ("task_id");
CREATE UNIQUE INDEX "filesystem_mcp_current_decision_pointers_current_decision_idx"
  ON "filesystem_mcp_current_decision_pointers" ("current_decision_id")
  WHERE "current_decision_id" IS NOT NULL;

-- Existing mutable rows are retained as ambiguous legacy history. The pointer
-- records an explicit all-null adapter and receives no invented authority.
INSERT INTO "filesystem_mcp_current_decision_pointers" (
  "task_id", "work_package_id", "pointer_fingerprint", "pointer_version"
)
SELECT
  wp."task_id",
  wp."id",
  CASE WHEN approval."id" IS NULL
    THEN 'empty:' || wp."id"::text
    ELSE 'legacy:' || approval."id"::text
  END,
  CASE WHEN approval."id" IS NULL THEN 0 ELSE 1 END
FROM "work_packages" wp
LEFT JOIN "filesystem_mcp_grant_approvals" approval
  ON approval."work_package_id" = wp."id";

CREATE FUNCTION "forge_preallocate_filesystem_decision_pointer"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO "filesystem_mcp_current_decision_pointers" (
    "task_id", "work_package_id", "pointer_fingerprint"
  ) VALUES (
    NEW."task_id", NEW."id", 'empty:' || NEW."id"::text
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER "work_packages_preallocate_filesystem_decision_pointer"
AFTER INSERT ON "work_packages"
FOR EACH ROW EXECUTE FUNCTION "forge_preallocate_filesystem_decision_pointer"();

CREATE FUNCTION "forge_reject_filesystem_grant_history_mutation"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'filesystem grant decision history is append-only'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER "filesystem_mcp_grant_approvals_append_only"
BEFORE UPDATE OR DELETE ON "filesystem_mcp_grant_approvals"
FOR EACH ROW EXECUTE FUNCTION "forge_reject_filesystem_grant_history_mutation"();

CREATE FUNCTION "forge_is_canonical_filesystem_capability_set"(value jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT jsonb_typeof(value) = 'array'
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(value) AS item
      WHERE jsonb_typeof(item) <> 'string'
         OR item #>> '{}' NOT IN (
           'filesystem.project.list',
           'filesystem.project.read',
           'filesystem.project.search'
         )
    )
    AND value = COALESCE((
      SELECT jsonb_agg(capability ORDER BY capability)
      FROM (
        SELECT DISTINCT item #>> '{}' AS capability
        FROM jsonb_array_elements(value) AS item
      ) canonical
    ), '[]'::jsonb)
$$;

CREATE FUNCTION "forge_is_canonical_bounded_string_set"(
  value jsonb,
  max_items integer,
  max_length integer
)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
BEGIN
  IF jsonb_typeof(value) <> 'array' OR jsonb_array_length(value) > max_items THEN
    RETURN false;
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(value) AS item
    WHERE jsonb_typeof(item) <> 'string'
       OR length(item #>> '{}') = 0
       OR length(item #>> '{}') > max_length
  ) THEN
    RETURN false;
  END IF;
  RETURN value = COALESCE((
    SELECT jsonb_agg(item_value ORDER BY item_value)
    FROM (
      SELECT DISTINCT item #>> '{}' AS item_value
      FROM jsonb_array_elements(value) AS item
    ) canonical
  ), '[]'::jsonb);
END;
$$;

CREATE FUNCTION "forge_is_canonical_utc_timestamp"(value text)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
BEGIN
  IF value !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$' THEN
    RETURN false;
  END IF;
  RETURN to_char(value::timestamptz AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') = value;
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END;
$$;

CREATE TABLE "project_filesystem_grant_decisions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL,
  "decision" text NOT NULL,
  "capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "grant_decision_revision" bigint NOT NULL,
  "root_binding_revision" bigint NOT NULL,
  "decision_fingerprint" text NOT NULL,
  "decision_generation" bigint NOT NULL,
  "prior_decision_id" uuid,
  "prior_decision_project_id" uuid,
  "prior_decision_revision" bigint,
  "prior_root_binding_revision" bigint,
  "prior_decision_fingerprint" text,
  "prior_decision_generation" bigint,
  "revocation_reason" text,
  "reason" text DEFAULT '' NOT NULL,
  "decided_by" uuid NOT NULL,
  "decided_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "project_filesystem_grant_decisions_project_fk"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE restrict,
  CONSTRAINT "project_filesystem_grant_decisions_actor_fk"
    FOREIGN KEY ("decided_by") REFERENCES "users"("id") ON DELETE restrict,
  CONSTRAINT "project_filesystem_grant_decisions_revision_check"
    CHECK ("grant_decision_revision" > 0 AND "root_binding_revision" > 0 AND "decision_generation" > 0),
  CONSTRAINT "project_filesystem_grant_decisions_fingerprint_check"
    CHECK ("decision_fingerprint" ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT "project_filesystem_grant_decisions_capabilities_check"
    CHECK (forge_is_canonical_filesystem_capability_set("capabilities")),
  CONSTRAINT "project_filesystem_grant_decisions_prior_tuple_check"
    CHECK (
      (
        "prior_decision_id" IS NULL AND "prior_decision_project_id" IS NULL
        AND "prior_decision_revision" IS NULL
        AND "prior_root_binding_revision" IS NULL AND "prior_decision_fingerprint" IS NULL
        AND "prior_decision_generation" IS NULL AND "decision_generation" = 1
      ) OR (
        "prior_decision_id" IS NOT NULL AND "prior_decision_project_id" = "project_id"
        AND "prior_decision_revision" > 0
        AND "prior_root_binding_revision" > 0
        AND "prior_decision_fingerprint" ~ '^sha256:[0-9a-f]{64}$'
        AND "prior_decision_generation" > 0
        AND "decision_generation" = "prior_decision_generation" + 1
      )
    ),
  CONSTRAINT "project_filesystem_grant_decisions_state_check"
    CHECK (
      (
        "decision" = 'approved'
        AND "capabilities" ? 'filesystem.project.read'
        AND ("revocation_reason" IS NULL OR "revocation_reason" = 'project_grant_narrowed')
      ) OR (
        "decision" = 'revoked'
        AND "capabilities" = '[]'::jsonb
        AND "revocation_reason" IN ('project_grant_removed', 'project_root_repoint')
      )
    )
);

CREATE UNIQUE INDEX "project_filesystem_grant_decisions_project_revision_idx"
  ON "project_filesystem_grant_decisions" ("project_id", "grant_decision_revision");
CREATE UNIQUE INDEX "project_filesystem_grant_decisions_project_generation_idx"
  ON "project_filesystem_grant_decisions" ("project_id", "decision_generation");
CREATE UNIQUE INDEX "project_filesystem_grant_decisions_parent_tuple_idx"
  ON "project_filesystem_grant_decisions" (
    "id", "project_id", "grant_decision_revision", "root_binding_revision",
    "decision_fingerprint", "decision_generation"
  );

ALTER TABLE "project_filesystem_grant_decisions"
  ADD CONSTRAINT "project_filesystem_grant_decisions_prior_fk"
  FOREIGN KEY (
    "prior_decision_id", "prior_decision_project_id", "prior_decision_revision",
    "prior_root_binding_revision", "prior_decision_fingerprint", "prior_decision_generation"
  ) REFERENCES "project_filesystem_grant_decisions" (
    "id", "project_id", "grant_decision_revision", "root_binding_revision",
    "decision_fingerprint", "decision_generation"
  ) MATCH FULL ON UPDATE restrict ON DELETE restrict;

CREATE TABLE "project_filesystem_current_decision_pointers" (
  "project_id" uuid PRIMARY KEY NOT NULL,
  "current_decision_id" uuid,
  "current_decision_project_id" uuid,
  "current_decision_revision" bigint,
  "current_root_binding_revision" bigint,
  "current_decision_fingerprint" text,
  "current_decision_generation" bigint,
  "pointer_generation" bigint DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "project_filesystem_current_decision_pointers_project_fk"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE cascade,
  CONSTRAINT "project_filesystem_current_decision_pointers_parent_fk"
    FOREIGN KEY (
      "current_decision_id", "current_decision_project_id", "current_decision_revision",
      "current_root_binding_revision", "current_decision_fingerprint", "current_decision_generation"
    ) REFERENCES "project_filesystem_grant_decisions" (
      "id", "project_id", "grant_decision_revision", "root_binding_revision",
      "decision_fingerprint", "decision_generation"
    ) MATCH FULL ON UPDATE restrict ON DELETE restrict,
  CONSTRAINT "project_filesystem_current_decision_pointers_tuple_check"
    CHECK (
      (
        "current_decision_id" IS NULL AND "current_decision_revision" IS NULL
        AND "current_decision_project_id" IS NULL
        AND "current_root_binding_revision" IS NULL AND "current_decision_fingerprint" IS NULL
        AND "current_decision_generation" IS NULL
        AND "pointer_generation" = 0
      ) OR (
        "current_decision_id" IS NOT NULL AND "current_decision_revision" > 0
        AND "current_decision_project_id" = "project_id"
        AND "current_root_binding_revision" > 0
        AND "current_decision_fingerprint" ~ '^sha256:[0-9a-f]{64}$'
        AND "current_decision_generation" > 0
        AND "pointer_generation" = "current_decision_generation"
      )
    )
);

CREATE UNIQUE INDEX "project_filesystem_current_decision_pointers_decision_idx"
  ON "project_filesystem_current_decision_pointers" ("current_decision_id")
  WHERE "current_decision_id" IS NOT NULL;

INSERT INTO "project_filesystem_current_decision_pointers" ("project_id")
SELECT "id" FROM "projects";

CREATE FUNCTION "forge_preallocate_project_filesystem_decision_pointer"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO "project_filesystem_current_decision_pointers" ("project_id") VALUES (NEW."id");
  RETURN NEW;
END;
$$;

CREATE TRIGGER "projects_preallocate_filesystem_decision_pointer"
AFTER INSERT ON "projects"
FOR EACH ROW EXECUTE FUNCTION "forge_preallocate_project_filesystem_decision_pointer"();

CREATE FUNCTION "forge_reject_project_filesystem_decision_mutation"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'project filesystem grant decision history is append-only'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER "project_filesystem_grant_decisions_append_only"
BEFORE UPDATE OR DELETE ON "project_filesystem_grant_decisions"
FOR EACH ROW EXECUTE FUNCTION "forge_reject_project_filesystem_decision_mutation"();

-- SQL mirrors the closed TypeScript S3 hold-state union. Older marker-shaped
-- JSON remains retained as data but is not S3 recovery authority; every
-- version-2 writer is constrained to exact S3 keys, bounds, and blocked status.
ALTER TABLE "work_packages"
  ADD CONSTRAINT "work_packages_filesystem_grant_hold_v2_check"
  CHECK (
    NOT ("metadata" ? 'mcpGrantBlock')
    OR COALESCE("metadata"->'mcpGrantBlock'->>'schemaVersion', '') <> '2'
    OR (
      (
      jsonb_typeof("metadata"->'mcpGrantBlock') = 'object'
      AND "status" = 'blocked'
      AND ("metadata"->'mcpGrantBlock') ?& ARRAY[
        'schemaVersion','kind','source','taskDisposition','autoRetryable',
        'terminalFailure','requirementKeys','requestedCapabilities',
        'recoveryAction','blockFingerprint','blockedAt','holdKind',
        'grantPhase','grantConsumed','grantDecisionRevision','revocationReason'
      ]
      AND ("metadata"->'mcpGrantBlock') - ARRAY[
        'schemaVersion','kind','source','taskDisposition','autoRetryable',
        'terminalFailure','requirementKeys','requestedCapabilities',
        'recoveryAction','blockFingerprint','blockedAt','holdKind',
        'grantPhase','grantConsumed','grantDecisionRevision','revocationReason'
      ] = '{}'::jsonb
      AND "metadata"->'mcpGrantBlock'->'schemaVersion' = '2'::jsonb
      AND "metadata"->'mcpGrantBlock'->>'kind' = 'filesystem_grant'
      AND "metadata"->'mcpGrantBlock'->>'source' = 'filesystem-grant-approval'
      AND "metadata"->'mcpGrantBlock'->>'taskDisposition' = 'operator_hold'
      AND "metadata"->'mcpGrantBlock'->'autoRetryable' = 'false'::jsonb
      AND "metadata"->'mcpGrantBlock'->'terminalFailure' = 'false'::jsonb
      AND forge_is_canonical_bounded_string_set(
        "metadata"->'mcpGrantBlock'->'requirementKeys', 256, 240
      )
      AND forge_is_canonical_bounded_string_set(
        "metadata"->'mcpGrantBlock'->'requestedCapabilities', 3, 240
      )
      AND forge_is_canonical_filesystem_capability_set(
        "metadata"->'mcpGrantBlock'->'requestedCapabilities'
      )
      AND "metadata"->'mcpGrantBlock'->>'recoveryAction' = 'approve_project_filesystem_context'
      AND ("metadata"->'mcpGrantBlock'->>'blockFingerprint') ~ '^sha256:[0-9a-f]{64}$'
      AND forge_is_canonical_utc_timestamp("metadata"->'mcpGrantBlock'->>'blockedAt')
      AND (
        (
          "metadata"->'mcpGrantBlock'->>'holdKind' = 'approval_required'
          AND "metadata"->'mcpGrantBlock'->>'grantPhase' IN ('none','proposed','not_issued')
          AND "metadata"->'mcpGrantBlock'->'grantConsumed' = 'false'::jsonb
          AND "metadata"->'mcpGrantBlock'->'grantDecisionRevision' = 'null'::jsonb
          AND "metadata"->'mcpGrantBlock'->'revocationReason' = 'null'::jsonb
        ) OR (
          "metadata"->'mcpGrantBlock'->>'holdKind' = 'denied_required'
          AND "metadata"->'mcpGrantBlock'->>'grantPhase' = 'denied'
          AND "metadata"->'mcpGrantBlock'->'grantConsumed' = 'false'::jsonb
          AND (
            "metadata"->'mcpGrantBlock'->'grantDecisionRevision' = 'null'::jsonb
            OR ("metadata"->'mcpGrantBlock'->>'grantDecisionRevision') ~ '^[1-9][0-9]*$'
          )
          AND "metadata"->'mcpGrantBlock'->'revocationReason' = 'null'::jsonb
        ) OR (
          "metadata"->'mcpGrantBlock'->>'holdKind' = 'revoked_required'
          AND "metadata"->'mcpGrantBlock'->>'grantPhase' = 'revoked'
          AND "metadata"->'mcpGrantBlock'->'grantConsumed' = 'false'::jsonb
          AND ("metadata"->'mcpGrantBlock'->>'grantDecisionRevision') ~ '^[1-9][0-9]*$'
          AND "metadata"->'mcpGrantBlock'->>'revocationReason' IN (
            'project_grant_removed','project_grant_narrowed','project_root_repoint'
          )
        ) OR (
          "metadata"->'mcpGrantBlock'->>'holdKind' = 'consumed_once'
          AND "metadata"->'mcpGrantBlock'->>'grantPhase' = 'approved'
          AND "metadata"->'mcpGrantBlock'->'grantConsumed' = 'true'::jsonb
          AND ("metadata"->'mcpGrantBlock'->>'grantDecisionRevision') ~ '^[1-9][0-9]*$'
          AND "metadata"->'mcpGrantBlock'->'revocationReason' = 'null'::jsonb
        )
      )
      ) IS TRUE
    )
  );
--> statement-breakpoint
-- The release ledger is owned by a separate NOLOGIN role. The administrator-
-- installed helper grants this migration login a non-inheriting SET ROLE path
-- only for this versioned S3 section, including upgraded Step 0 databases.
SELECT public.forge_begin_epic_172_s3_owner_bootstrap_v1();
--> statement-breakpoint
SET LOCAL ROLE forge_release_routines_owner;
--> statement-breakpoint
CREATE TABLE public.forge_epic_172_s3_release_state (
  singleton_id text PRIMARY KEY,
  state text NOT NULL,
  state_fingerprint text NOT NULL,
  predecessor_receipt_id uuid,
  authorization_id uuid,
  evidence_receipt_id uuid,
  transition_identity_digest text,
  completed_at timestamptz,
  CONSTRAINT forge_epic_172_s3_release_state_singleton_chk
    CHECK (singleton_id = 's3_issue_178'),
  CONSTRAINT forge_epic_172_s3_release_state_state_chk
    CHECK (state IN ('pending', 'complete')),
  CONSTRAINT forge_epic_172_s3_release_state_fingerprint_chk
    CHECK (state_fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT forge_epic_172_s3_release_state_tuple_chk CHECK (
    (
      state = 'pending'
      AND state_fingerprint = '7a97eed28629c7d0d7c11a48d3509f1c479d614882dc61a7e2c1891f32c3a5dc'
      AND predecessor_receipt_id IS NULL
      AND authorization_id IS NULL
      AND evidence_receipt_id IS NULL
      AND transition_identity_digest IS NULL
      AND completed_at IS NULL
    ) OR (
      state = 'complete'
      AND predecessor_receipt_id IS NOT NULL
      AND authorization_id IS NOT NULL
      AND evidence_receipt_id IS NOT NULL
      AND evidence_receipt_id <> predecessor_receipt_id
      AND transition_identity_digest ~ '^[0-9a-f]{64}$'
      AND state_fingerprint = transition_identity_digest
      AND completed_at IS NOT NULL
    )
  ),
  CONSTRAINT forge_epic_172_s3_release_state_predecessor_receipt_id_forge_epic_172_release_evidence_id_fk
    FOREIGN KEY (predecessor_receipt_id)
    REFERENCES public.forge_epic_172_release_evidence(id)
    ON UPDATE restrict ON DELETE restrict,
  CONSTRAINT forge_epic_172_s3_release_state_authorization_id_forge_epic_172_transition_authorizations_id_fk
    FOREIGN KEY (authorization_id)
    REFERENCES public.forge_epic_172_transition_authorizations(id)
    ON UPDATE restrict ON DELETE restrict,
  CONSTRAINT forge_epic_172_s3_release_state_evidence_receipt_id_forge_epic_172_release_evidence_id_fk
    FOREIGN KEY (evidence_receipt_id)
    REFERENCES public.forge_epic_172_release_evidence(id)
    ON UPDATE restrict ON DELETE restrict
);
--> statement-breakpoint
INSERT INTO public.forge_epic_172_s3_release_state (
  singleton_id, state, state_fingerprint
) VALUES (
  's3_issue_178',
  'pending',
  '7a97eed28629c7d0d7c11a48d3509f1c479d614882dc61a7e2c1891f32c3a5dc'
);
--> statement-breakpoint
CREATE FUNCTION forge.guard_epic_172_s3_evidence_insert_v1()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.evidence_kind = 's3_issue_178'
     AND session_user <> 'forge_release_transition' THEN
    RAISE EXCEPTION 's3_issue_178 evidence requires the atomic dedicated S3 completion transaction'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER forge_epic_172_s3_evidence_atomic_insert
BEFORE INSERT ON public.forge_epic_172_release_evidence
FOR EACH ROW EXECUTE FUNCTION forge.guard_epic_172_s3_evidence_insert_v1();
--> statement-breakpoint
CREATE FUNCTION forge.guard_epic_172_s3_state_transition_v1()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Epic 172 S3 release state is durable' USING ERRCODE = '55000';
  END IF;
  IF session_user <> 'forge_release_transition'
     OR OLD.state <> 'pending'
     OR NEW.state <> 'complete'
     OR NEW.singleton_id <> OLD.singleton_id THEN
    RAISE EXCEPTION 'Epic 172 S3 release state permits only its dedicated one-way completion'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER forge_epic_172_s3_release_state_one_way
BEFORE UPDATE OR DELETE ON public.forge_epic_172_s3_release_state
FOR EACH ROW EXECUTE FUNCTION forge.guard_epic_172_s3_state_transition_v1();
--> statement-breakpoint
CREATE FUNCTION forge.lock_epic_172_s3_completion_v1(
  p_predecessor_receipt_id uuid,
  p_authorization_id uuid,
  p_output_signer_key_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_state text;
  v_locked_signers integer;
BEGIN
  IF session_user <> 'forge_release_transition' THEN
    RAISE EXCEPTION 'Epic 172 S3 verification locks require the dedicated transition login'
      USING ERRCODE = '42501';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('forge:epic-172:s3-completion:v1', 0)
  );
  SELECT state INTO STRICT v_state
  FROM public.forge_epic_172_s3_release_state
  WHERE singleton_id = 's3_issue_178'
  FOR UPDATE;
  IF v_state <> 'pending' THEN
    RAISE EXCEPTION 'Epic 172 S3 release state is already complete'
      USING ERRCODE = '55000';
  END IF;
  PERFORM 1
  FROM public.forge_epic_172_release_evidence
  WHERE id = p_predecessor_receipt_id
  FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'The exact Step 0 predecessor is not retained' USING ERRCODE = '23503';
  END IF;
  PERFORM 1
  FROM public.forge_epic_172_transition_authorizations
  WHERE id = p_authorization_id
  FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'The exact S3 transition authorization is not retained' USING ERRCODE = '23503';
  END IF;
  PERFORM 1
  FROM public.forge_release_signer_keys signer
  WHERE signer.id IN (
    p_output_signer_key_id,
    (SELECT evidence.signer_key_id FROM public.forge_epic_172_release_evidence evidence
      WHERE evidence.id = p_predecessor_receipt_id),
    (SELECT authorization_row.signer_key_id FROM public.forge_epic_172_transition_authorizations authorization_row
      WHERE authorization_row.id = p_authorization_id)
  )
  ORDER BY signer.id
  FOR UPDATE;
  GET DIAGNOSTICS v_locked_signers = ROW_COUNT;
  IF v_locked_signers <> (
    SELECT pg_catalog.count(DISTINCT signer_id)
    FROM pg_catalog.unnest(ARRAY[
      p_output_signer_key_id,
      (SELECT evidence.signer_key_id FROM public.forge_epic_172_release_evidence evidence
        WHERE evidence.id = p_predecessor_receipt_id),
      (SELECT authorization_row.signer_key_id FROM public.forge_epic_172_transition_authorizations authorization_row
        WHERE authorization_row.id = p_authorization_id)
    ]) signer_id
  ) THEN
    RAISE EXCEPTION 'An exact signer required by S3 completion is missing' USING ERRCODE = '23503';
  END IF;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION forge.complete_epic_172_s3_release_v1(
  p_authorization_id uuid,
  p_expected_state_fingerprint text,
  p_receipt_id uuid,
  p_owner_issue integer,
  p_owner_slice text,
  p_exact_builds jsonb,
  p_required_evidence jsonb,
  p_reviewed_sha text,
  p_epoch bigint,
  p_predecessor_receipt_ids jsonb,
  p_predecessor_set_digest text,
  p_transition_identity_digest text,
  p_signer_key_id uuid,
  p_signer_generation bigint,
  p_github_app_id text,
  p_controller_run_id text,
  p_controller_job_id text,
  p_envelope_digest text,
  p_detached_signature bytea,
  p_nonce uuid,
  p_issued_at timestamptz,
  p_envelope jsonb
)
RETURNS TABLE (receipt_id uuid, consumption_id uuid, completed_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_predecessor public.forge_epic_172_release_evidence%ROWTYPE;
  v_authorization public.forge_epic_172_transition_authorizations%ROWTYPE;
  v_predecessor_key public.forge_release_signer_keys%ROWTYPE;
  v_authorization_key public.forge_release_signer_keys%ROWTYPE;
  v_output_key public.forge_release_signer_keys%ROWTYPE;
  v_expected_evidence_names text[] := ARRAY[
    'step0_retention_bridge_receipt',
    'grant_decision_revision_contract_green',
    'operator_hold_and_reconciliation_contract_green',
    'canonical_lock_order_contract_green',
    'postgresql_s3_evidence_green'
  ];
  v_expected_envelope jsonb;
  v_consumption_id uuid;
  v_completed_at timestamptz;
BEGIN
  IF session_user <> 'forge_release_transition' THEN
    RAISE EXCEPTION 'Epic 172 S3 completion requires the dedicated transition login'
      USING ERRCODE = '42501';
  END IF;
  IF jsonb_typeof(p_predecessor_receipt_ids) <> 'array'
     OR jsonb_array_length(p_predecessor_receipt_ids) <> 1 THEN
    RAISE EXCEPTION 'S3 completion requires exactly one Step 0 predecessor'
      USING ERRCODE = '22023';
  END IF;
  PERFORM forge.lock_epic_172_s3_completion_v1(
    (p_predecessor_receipt_ids ->> 0)::uuid,
    p_authorization_id,
    p_signer_key_id
  );

  SELECT * INTO STRICT v_predecessor
  FROM public.forge_epic_172_release_evidence
  WHERE id = (p_predecessor_receipt_ids ->> 0)::uuid;
  SELECT * INTO STRICT v_authorization
  FROM public.forge_epic_172_transition_authorizations
  WHERE id = p_authorization_id;
  SELECT * INTO STRICT v_predecessor_key
  FROM public.forge_release_signer_keys WHERE id = v_predecessor.signer_key_id;
  SELECT * INTO STRICT v_authorization_key
  FROM public.forge_release_signer_keys WHERE id = v_authorization.signer_key_id;
  SELECT * INTO STRICT v_output_key
  FROM public.forge_release_signer_keys WHERE id = p_signer_key_id;

  IF v_predecessor.evidence_kind <> 'step0_retention_bridge'
     OR v_authorization.target_node <> 's3_issue_178'
     OR v_authorization.source_receipt_ids <> p_predecessor_receipt_ids
     OR v_authorization.source_receipt_set_digest <> p_predecessor_set_digest
     OR v_authorization.transition_identity_digest <> p_transition_identity_digest
     OR v_authorization.owner_issue <> 178
     OR v_authorization.owner_slice <> 's3'
     OR v_authorization.exact_builds <> p_exact_builds
     OR v_authorization.reviewed_sha <> p_reviewed_sha
     OR v_authorization.epoch IS NOT NULL
     OR v_authorization.operation <> 'record_s3_receipt'
     OR v_authorization.controller_run_id <> p_controller_run_id
     OR p_owner_issue <> 178
     OR p_owner_slice <> 's3'
     OR p_epoch IS NOT NULL
     OR jsonb_typeof(p_exact_builds) <> 'array'
     OR jsonb_array_length(p_exact_builds) <> 1
     OR (p_exact_builds ->> 0) NOT LIKE 'issue_178_s3@%'
     OR pg_catalog.length(p_exact_builds ->> 0) <= pg_catalog.length('issue_178_s3@') THEN
    RAISE EXCEPTION 'The S3 receipt, Step 0 predecessor, and authorization are not one exact transition'
      USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(p_required_evidence) <> 'array'
     OR jsonb_array_length(p_required_evidence) <> pg_catalog.cardinality(v_expected_evidence_names)
     OR EXISTS (
       SELECT 1
       FROM jsonb_array_elements(p_required_evidence) WITH ORDINALITY AS claim(value, ordinal)
       WHERE jsonb_typeof(claim.value) <> 'object'
          OR claim.value <> pg_catalog.jsonb_build_object(
            'name', claim.value -> 'name',
            'measurementDigest', claim.value -> 'measurementDigest'
          )
          OR claim.value ->> 'name' IS DISTINCT FROM v_expected_evidence_names[claim.ordinal::integer]
          OR (claim.value ->> 'measurementDigest' ~ '^[0-9a-f]{64}$') IS NOT TRUE
     ) THEN
    RAISE EXCEPTION 'The S3 required-evidence measurements do not match the exact manifest contract'
      USING ERRCODE = '22023';
  END IF;
  IF v_predecessor.signer_generation <> v_predecessor_key.generation
     OR v_predecessor.github_app_id <> v_predecessor_key.github_app_id
     OR v_predecessor.issued_at < v_predecessor_key.valid_from
     OR v_predecessor.issued_at >= v_predecessor_key.valid_until
     OR (v_predecessor_key.retirement_started_at IS NOT NULL
       AND v_predecessor.issued_at >= v_predecessor_key.retirement_started_at)
     OR v_authorization.signer_generation <> v_authorization_key.generation
     OR v_authorization.issued_at < v_authorization_key.valid_from
     OR v_authorization.issued_at >= v_authorization_key.valid_until
     OR (v_authorization_key.retirement_started_at IS NOT NULL
       AND v_authorization.issued_at >= v_authorization_key.retirement_started_at)
     OR v_now >= v_authorization.expires_at
     OR v_output_key.policy_id <> 'forge-epic-172-release-signing-v1'
     OR v_output_key.algorithm <> 'Ed25519'
     OR v_output_key.generation <> p_signer_generation
     OR v_output_key.github_app_id <> p_github_app_id
     OR v_output_key.status <> 'active'
     OR v_output_key.activated_at IS NULL
     OR p_issued_at < v_output_key.valid_from
     OR p_issued_at < v_output_key.activated_at
     OR p_issued_at >= v_output_key.valid_until
     OR p_issued_at > v_now
     OR v_now >= v_output_key.valid_until THEN
    RAISE EXCEPTION 'The S3 signer policy, retained signatures, or authorization lifetime is not valid'
      USING ERRCODE = '22023';
  END IF;

  v_expected_envelope := pg_catalog.jsonb_build_object(
    'envelopeVersion', 1,
    'receiptId', p_receipt_id::text,
    'manifestVersion', 1,
    'evidenceKind', 's3_issue_178',
    'owner', pg_catalog.jsonb_build_object('issue', p_owner_issue, 'slice', p_owner_slice),
    'exactBuilds', p_exact_builds,
    'requiredEvidence', p_required_evidence,
    'reviewedSha', p_reviewed_sha,
    'epoch', p_epoch,
    'predecessorReceiptIds', p_predecessor_receipt_ids,
    'predecessorSetDigest', p_predecessor_set_digest,
    'transitionIdentityDigest', p_transition_identity_digest,
    'signerKeyId', p_signer_key_id::text,
    'signerGeneration', p_signer_generation,
    'githubAppId', p_github_app_id,
    'controllerRunId', p_controller_run_id,
    'controllerJobId', p_controller_job_id,
    'nonce', p_nonce::text,
    'issuedAt', pg_catalog.to_char(p_issued_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  );
  IF p_envelope <> v_expected_envelope THEN
    RAISE EXCEPTION 'The signed S3 envelope does not match its verified typed fields'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.forge_epic_172_release_evidence_consumptions (
    receipt_id, transition_identity_digest, authorization_id, consumer_node,
    operation_id, actor, consumed_at
  ) VALUES (
    v_predecessor.id, v_predecessor.transition_identity_digest, p_authorization_id,
    's3_issue_178', v_authorization.operation_id, v_authorization.controller_login_id, v_now
  ) RETURNING id INTO v_consumption_id;

  INSERT INTO public.forge_epic_172_release_evidence (
    id, manifest_version, evidence_kind, owner_issue, owner_slice, exact_builds, required_evidence,
    reviewed_sha, epoch, predecessor_receipt_ids, predecessor_set_digest,
    transition_identity_digest, signer_key_id, signer_generation, github_app_id,
    controller_run_id, controller_job_id, signature_domain, envelope_version,
    envelope_digest, detached_signature, nonce, issued_at, recorded_at, envelope
  ) VALUES (
    p_receipt_id, 1, 's3_issue_178', p_owner_issue, p_owner_slice, p_exact_builds, p_required_evidence,
    p_reviewed_sha, p_epoch, p_predecessor_receipt_ids, p_predecessor_set_digest,
    p_transition_identity_digest, p_signer_key_id, p_signer_generation, p_github_app_id,
    p_controller_run_id, p_controller_job_id, 'forge:epic-172-release-evidence:v1', 1,
    p_envelope_digest, p_detached_signature, p_nonce, p_issued_at, v_now, p_envelope
  );

  UPDATE public.forge_epic_172_s3_release_state state_row
  SET
    state = 'complete',
    state_fingerprint = p_transition_identity_digest,
    predecessor_receipt_id = v_predecessor.id,
    authorization_id = p_authorization_id,
    evidence_receipt_id = p_receipt_id,
    transition_identity_digest = p_transition_identity_digest,
    completed_at = pg_catalog.clock_timestamp()
  WHERE state_row.singleton_id = 's3_issue_178'
    AND state_row.state = 'pending'
    AND state_row.state_fingerprint = p_expected_state_fingerprint
    AND pg_catalog.clock_timestamp() < v_authorization.expires_at
    AND EXISTS (
      SELECT 1
      FROM public.forge_epic_172_release_evidence_consumptions consumption
      WHERE consumption.id = v_consumption_id
        AND consumption.receipt_id = v_predecessor.id
        AND consumption.authorization_id = p_authorization_id
        AND consumption.consumer_node = 's3_issue_178'
    )
  RETURNING state_row.completed_at INTO v_completed_at;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'S3 authorization expired or the final state compare-and-set was lost'
      USING ERRCODE = '40001';
  END IF;
  RETURN QUERY SELECT p_receipt_id, v_consumption_id, v_completed_at;
END;
$$;
--> statement-breakpoint
-- Generic transitions remain available to later release nodes, but S3 cannot
-- consume its predecessor outside the dedicated three-write completion path.
CREATE OR REPLACE FUNCTION forge.consume_epic_172_release_evidence_v1(
  p_receipt_id uuid,
  p_authorization_id uuid,
  p_consumer_node text,
  p_transition_identity_digest text,
  p_operation_id text
)
RETURNS TABLE (consumption_id uuid, consumed_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_receipt public.forge_epic_172_release_evidence%ROWTYPE;
  v_authorization public.forge_epic_172_transition_authorizations%ROWTYPE;
  v_receipt_key public.forge_release_signer_keys%ROWTYPE;
  v_authorization_key public.forge_release_signer_keys%ROWTYPE;
BEGIN
  IF session_user <> 'forge_release_transition' THEN
    RAISE EXCEPTION 'Epic 172 evidence consumption requires the dedicated transition login'
      USING ERRCODE = '42501';
  END IF;
  IF p_consumer_node = 's3_issue_178' THEN
    RAISE EXCEPTION 's3_issue_178 requires the dedicated S3 completion transaction'
      USING ERRCODE = '42501';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('forge:epic-172:consumption:receipt:' || p_receipt_id::text, 0)
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('forge:epic-172:consumption:identity:' || p_transition_identity_digest || ':' || p_consumer_node, 0)
  );
  SELECT * INTO STRICT v_receipt
  FROM public.forge_epic_172_release_evidence
  WHERE id = p_receipt_id
  FOR KEY SHARE;
  SELECT * INTO STRICT v_authorization
  FROM public.forge_epic_172_transition_authorizations
  WHERE id = p_authorization_id
  FOR KEY SHARE;
  SELECT * INTO STRICT v_receipt_key
  FROM public.forge_release_signer_keys
  WHERE id = v_receipt.signer_key_id
  FOR UPDATE;
  IF v_authorization.signer_key_id = v_receipt.signer_key_id THEN
    v_authorization_key := v_receipt_key;
  ELSE
    SELECT * INTO STRICT v_authorization_key
    FROM public.forge_release_signer_keys
    WHERE id = v_authorization.signer_key_id
    FOR UPDATE;
  END IF;
  IF v_authorization.transition_identity_digest <> p_transition_identity_digest
     OR v_authorization.target_node <> p_consumer_node
     OR v_authorization.operation_id <> p_operation_id
     OR NOT v_authorization.source_receipt_ids @> pg_catalog.jsonb_build_array(p_receipt_id::text)
     OR v_authorization.controller_login_id = ''
     OR v_receipt.signer_generation <> v_receipt_key.generation
     OR v_authorization.signer_generation <> v_authorization_key.generation
     OR v_receipt.github_app_id <> v_receipt_key.github_app_id
     OR v_receipt.issued_at < v_receipt_key.valid_from
     OR v_receipt.issued_at >= v_receipt_key.valid_until
     OR (v_receipt_key.retirement_started_at IS NOT NULL AND v_receipt.issued_at >= v_receipt_key.retirement_started_at)
     OR v_authorization.issued_at < v_authorization_key.valid_from
     OR v_authorization.issued_at >= v_authorization_key.valid_until
     OR (v_authorization_key.retirement_started_at IS NOT NULL AND v_authorization.issued_at >= v_authorization_key.retirement_started_at)
     OR v_now >= v_authorization.expires_at THEN
    RAISE EXCEPTION 'Epic 172 receipt and authorization are not an exact live transition binding'
      USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  INSERT INTO public.forge_epic_172_release_evidence_consumptions (
    receipt_id, transition_identity_digest, authorization_id, consumer_node,
    operation_id, actor, consumed_at
  ) VALUES (
    p_receipt_id, v_receipt.transition_identity_digest, p_authorization_id,
    p_consumer_node, p_operation_id, v_authorization.controller_login_id, v_now
  )
  RETURNING id, forge_epic_172_release_evidence_consumptions.consumed_at;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION forge.guard_epic_172_s3_evidence_insert_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION forge.guard_epic_172_s3_state_transition_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION forge.lock_epic_172_s3_completion_v1(uuid,uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION forge.complete_epic_172_s3_release_v1(uuid,text,uuid,integer,text,jsonb,jsonb,text,bigint,jsonb,text,text,uuid,bigint,text,text,text,text,bytea,uuid,timestamptz,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION forge.consume_epic_172_release_evidence_v1(uuid,uuid,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION forge.lock_epic_172_s3_completion_v1(uuid,uuid,uuid)
  TO forge_release_transition;
GRANT EXECUTE ON FUNCTION forge.complete_epic_172_s3_release_v1(uuid,text,uuid,integer,text,jsonb,jsonb,text,bigint,jsonb,text,text,uuid,bigint,text,text,text,text,bytea,uuid,timestamptz,jsonb)
  TO forge_release_transition;
GRANT EXECUTE ON FUNCTION forge.consume_epic_172_release_evidence_v1(uuid,uuid,text,text,text)
  TO forge_release_transition;
--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- S3 local projection heads — 8 preallocated per package (max 256 packages)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.work_package_local_projection_heads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL
    REFERENCES public.tasks(id) ON DELETE RESTRICT,
  work_package_id uuid NOT NULL
    REFERENCES public.work_packages(id) ON DELETE RESTRICT,
  head_kind text NOT NULL,
  head_index bigint NOT NULL,
  head_fingerprint text NOT NULL,
  head_version bigint NOT NULL DEFAULT 0,
  state text NOT NULL DEFAULT 'preallocated',
  lease_token uuid,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT work_package_projection_head_kind_chk CHECK (
    head_kind IN (
      'filesystem_grant_decision',
      'execution_evidence',
      'claim_token',
      'lease_expiry',
      'recovery_marker',
      'integrity_hold',
      'terminal_state',
      'artifact_reference'
    )
  ),
  CONSTRAINT work_package_projection_head_state_chk CHECK (
    state IN ('preallocated', 'claimed', 'active', 'terminal', 'uncertain')
  ),
  CONSTRAINT work_package_projection_head_index_chk CHECK (
    head_index >= 0 AND head_index < 8
  ),
  CONSTRAINT work_package_projection_head_version_chk CHECK (
    head_version >= 0
  ),
  CONSTRAINT work_package_projection_head_fingerprint_chk CHECK (
    head_fingerprint ~ '^head:v1:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[a-z_]+:[0-7]$'
  ),
  CONSTRAINT work_package_projection_head_lease_chk CHECK (
    (state IN ('claimed', 'active') AND lease_token IS NOT NULL)
    OR (state NOT IN ('claimed', 'active') AND lease_token IS NULL)
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX work_package_local_projection_heads_package_kind_idx
  ON public.work_package_local_projection_heads(work_package_id, head_kind);
--> statement-breakpoint
CREATE INDEX work_package_local_projection_heads_kind_idx
  ON public.work_package_local_projection_heads(head_kind);
--> statement-breakpoint
CREATE INDEX work_package_local_projection_heads_state_idx
  ON public.work_package_local_projection_heads(state);
--> statement-breakpoint
CREATE INDEX work_package_local_projection_heads_task_id_idx
  ON public.work_package_local_projection_heads(task_id);
--> statement-breakpoint
CREATE UNIQUE INDEX work_package_local_projection_heads_fingerprint_idx
  ON public.work_package_local_projection_heads(head_fingerprint);
--> statement-breakpoint
CREATE UNIQUE INDEX work_package_local_projection_heads_lease_token_idx
  ON public.work_package_local_projection_heads(lease_token);
--> statement-breakpoint
-- Preallocation: on INSERT into work_packages, create 8 heads (fails above 256)
CREATE OR REPLACE FUNCTION forge.preallocate_local_projection_heads_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_package_count bigint;
BEGIN
  SELECT count(id) INTO STRICT v_package_count
  FROM public.work_packages
  WHERE task_id = NEW.task_id;
  IF v_package_count > 256 THEN
    RAISE EXCEPTION 'S3 package limit exceeded: at most 256 work packages allowed'
      USING ERRCODE = '54000';
  END IF;
  INSERT INTO public.work_package_local_projection_heads (
    task_id, work_package_id, head_kind, head_index, head_fingerprint
  ) VALUES
    (NEW.task_id, NEW.id, 'filesystem_grant_decision', 0,
     'head:v1:' || NEW.task_id::text || ':' || NEW.id::text || ':filesystem_grant_decision:0'),
    (NEW.task_id, NEW.id, 'execution_evidence',      1,
     'head:v1:' || NEW.task_id::text || ':' || NEW.id::text || ':execution_evidence:1'),
    (NEW.task_id, NEW.id, 'claim_token',             2,
     'head:v1:' || NEW.task_id::text || ':' || NEW.id::text || ':claim_token:2'),
    (NEW.task_id, NEW.id, 'lease_expiry',            3,
     'head:v1:' || NEW.task_id::text || ':' || NEW.id::text || ':lease_expiry:3'),
    (NEW.task_id, NEW.id, 'recovery_marker',         4,
     'head:v1:' || NEW.task_id::text || ':' || NEW.id::text || ':recovery_marker:4'),
    (NEW.task_id, NEW.id, 'integrity_hold',          5,
     'head:v1:' || NEW.task_id::text || ':' || NEW.id::text || ':integrity_hold:5'),
    (NEW.task_id, NEW.id, 'terminal_state',          6,
     'head:v1:' || NEW.task_id::text || ':' || NEW.id::text || ':terminal_state:6'),
    (NEW.task_id, NEW.id, 'artifact_reference',      7,
     'head:v1:' || NEW.task_id::text || ':' || NEW.id::text || ':artifact_reference:7');
  RETURN NEW;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION forge.preallocate_local_projection_heads_v1() FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE TRIGGER trg_preallocate_projection_heads
  AFTER INSERT ON public.work_packages
  FOR EACH ROW EXECUTE FUNCTION forge.preallocate_local_projection_heads_v1();
--> statement-breakpoint
-- Reject deletion or reassignment of projection heads
CREATE OR REPLACE FUNCTION forge.reject_projection_head_mutation_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Projection heads are immutable: deletion is forbidden'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.head_kind <> OLD.head_kind
     OR NEW.work_package_id <> OLD.work_package_id THEN
    RAISE EXCEPTION 'Projection head identity is immutable: cannot reassign head_kind or work_package_id'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.state = 'deleted' THEN
    RAISE EXCEPTION 'Cannot operate on a deleted projection head'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION forge.reject_projection_head_mutation_v1() FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE TRIGGER trg_reject_projection_head_mutation
  BEFORE UPDATE OR DELETE ON public.work_package_local_projection_heads
  FOR EACH ROW EXECUTE FUNCTION forge.reject_projection_head_mutation_v1();
--> statement-breakpoint
-- Backfill heads for existing packages (after the trigger is active)
DO $$
DECLARE
  v_pkg record;
  v_over_limit_task_id uuid;
BEGIN
  SELECT task_id INTO v_over_limit_task_id
  FROM public.work_packages
  GROUP BY task_id
  HAVING count(id) > 256
  ORDER BY task_id
  LIMIT 1;
  IF v_over_limit_task_id IS NOT NULL THEN
    RAISE EXCEPTION 'Cannot backfill: task % exceeds S3 limit of 256 packages', v_over_limit_task_id
      USING ERRCODE = '54000';
  END IF;
  FOR v_pkg IN SELECT id, task_id FROM public.work_packages LOOP
    INSERT INTO public.work_package_local_projection_heads (
      task_id, work_package_id, head_kind, head_index, head_fingerprint
    ) VALUES
      (v_pkg.task_id, v_pkg.id, 'filesystem_grant_decision', 0,
       'head:v1:' || v_pkg.task_id || ':' || v_pkg.id || ':filesystem_grant_decision:0'),
      (v_pkg.task_id, v_pkg.id, 'execution_evidence',      1,
       'head:v1:' || v_pkg.task_id || ':' || v_pkg.id || ':execution_evidence:1'),
      (v_pkg.task_id, v_pkg.id, 'claim_token',             2,
       'head:v1:' || v_pkg.task_id || ':' || v_pkg.id || ':claim_token:2'),
      (v_pkg.task_id, v_pkg.id, 'lease_expiry',            3,
       'head:v1:' || v_pkg.task_id || ':' || v_pkg.id || ':lease_expiry:3'),
      (v_pkg.task_id, v_pkg.id, 'recovery_marker',         4,
       'head:v1:' || v_pkg.task_id || ':' || v_pkg.id || ':recovery_marker:4'),
      (v_pkg.task_id, v_pkg.id, 'integrity_hold',          5,
       'head:v1:' || v_pkg.task_id || ':' || v_pkg.id || ':integrity_hold:5'),
      (v_pkg.task_id, v_pkg.id, 'terminal_state',          6,
       'head:v1:' || v_pkg.task_id || ':' || v_pkg.id || ':terminal_state:6'),
      (v_pkg.task_id, v_pkg.id, 'artifact_reference',      7,
       'head:v1:' || v_pkg.task_id || ':' || v_pkg.id || ':artifact_reference:7')
    ON CONFLICT (work_package_id, head_kind) DO NOTHING;
  END LOOP;
END;
$$;
--> statement-breakpoint
ALTER TABLE public.work_package_local_projection_heads
  OWNER TO forge_release_routines_owner;
--> statement-breakpoint
REVOKE ALL ON public.work_package_local_projection_heads FROM PUBLIC;
REVOKE ALL ON public.work_package_local_projection_heads
  FROM forge_release_evidence_writer, forge_release_transition;
--> statement-breakpoint
RESET ROLE;
--> statement-breakpoint
SELECT public.forge_finalize_epic_172_s3_owner_bootstrap_v1();
