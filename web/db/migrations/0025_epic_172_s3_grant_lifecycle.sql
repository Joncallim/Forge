-- Epic 172 / issue 178 (S3): monotonic filesystem decisions, immutable
-- decision history, a preallocated current-authority pointer, and the strict
-- nonterminal operator-hold marker. Step 0 owns migrations 0023 and 0024.

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
      ("decision_scope" = 'package' AND "task_id" IS NOT NULL AND "work_package_id" IS NOT NULL)
      OR
      ("decision_scope" = 'project' AND "task_id" IS NULL AND "work_package_id" IS NULL)
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

CREATE TABLE "filesystem_mcp_current_decision_pointers" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "task_id" uuid NOT NULL,
  "work_package_id" uuid NOT NULL,
  "current_decision_id" uuid,
  "current_decision_revision" bigint,
  "pointer_fingerprint" text NOT NULL,
  "pointer_version" bigint DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "filesystem_mcp_current_decision_pointers_task_fk"
    FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE cascade,
  CONSTRAINT "filesystem_mcp_current_decision_pointers_package_fk"
    FOREIGN KEY ("work_package_id") REFERENCES "work_packages"("id") ON DELETE cascade,
  CONSTRAINT "filesystem_mcp_current_decision_pointers_decision_fk"
    FOREIGN KEY ("current_decision_id") REFERENCES "filesystem_mcp_grant_approvals"("id") ON DELETE restrict,
  CONSTRAINT "filesystem_mcp_current_decision_pointers_version_check"
    CHECK ("pointer_version" >= 0),
  CONSTRAINT "filesystem_mcp_current_decision_pointers_revision_check"
    CHECK (
      ("current_decision_id" IS NULL AND "current_decision_revision" IS NULL AND "pointer_version" = 0)
      OR
      ("current_decision_id" IS NOT NULL AND "current_decision_revision" IS NULL)
      OR
      ("current_decision_id" IS NOT NULL AND "current_decision_revision" > 0 AND "pointer_version" > 0)
    )
);

CREATE UNIQUE INDEX "filesystem_mcp_current_decision_pointers_work_package_idx"
  ON "filesystem_mcp_current_decision_pointers" ("work_package_id");
CREATE INDEX "filesystem_mcp_current_decision_pointers_task_idx"
  ON "filesystem_mcp_current_decision_pointers" ("task_id");
CREATE UNIQUE INDEX "filesystem_mcp_current_decision_pointers_current_decision_idx"
  ON "filesystem_mcp_current_decision_pointers" ("current_decision_id")
  WHERE "current_decision_id" IS NOT NULL;

-- Existing mutable rows are retained as ambiguous legacy history. They become
-- the current pointer but receive no invented revision or root authority.
INSERT INTO "filesystem_mcp_current_decision_pointers" (
  "task_id", "work_package_id", "current_decision_id",
  "current_decision_revision", "pointer_fingerprint", "pointer_version"
)
SELECT
  wp."task_id",
  wp."id",
  approval."id",
  NULL,
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

-- SQL mirrors the closed TypeScript hold-state union. Version-1 markers remain
-- readable during the bounded migration window; every version-2 writer is
-- constrained to one of the four canonical arms.
ALTER TABLE "work_packages"
  ADD CONSTRAINT "work_packages_filesystem_grant_hold_v2_check"
  CHECK (
    NOT ("metadata" ? 'mcpGrantBlock')
    OR COALESCE("metadata"->'mcpGrantBlock'->>'schemaVersion', '') <> '2'
    OR (
      (
      jsonb_typeof("metadata"->'mcpGrantBlock') = 'object'
      AND ("metadata"->'mcpGrantBlock') - ARRAY[
        'schemaVersion','kind','source','taskDisposition','autoRetryable',
        'terminalFailure','requirementKeys','requestedCapabilities',
        'recoveryAction','blockFingerprint','blockedAt','holdKind',
        'grantPhase','grantConsumed','grantDecisionRevision','revocationReason'
      ] = '{}'::jsonb
      AND "metadata"->'mcpGrantBlock'->>'kind' = 'filesystem_grant'
      AND "metadata"->'mcpGrantBlock'->>'source' = 'filesystem-grant-approval'
      AND "metadata"->'mcpGrantBlock'->>'taskDisposition' = 'operator_hold'
      AND "metadata"->'mcpGrantBlock'->'autoRetryable' = 'false'::jsonb
      AND "metadata"->'mcpGrantBlock'->'terminalFailure' = 'false'::jsonb
      AND jsonb_typeof("metadata"->'mcpGrantBlock'->'requirementKeys') = 'array'
      AND jsonb_typeof("metadata"->'mcpGrantBlock'->'requestedCapabilities') = 'array'
      AND "metadata"->'mcpGrantBlock'->>'recoveryAction' = 'approve_project_filesystem_context'
      AND ("metadata"->'mcpGrantBlock'->>'blockFingerprint') ~ '^sha256:[0-9a-f]{64}$'
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
