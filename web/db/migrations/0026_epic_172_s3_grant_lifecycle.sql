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
