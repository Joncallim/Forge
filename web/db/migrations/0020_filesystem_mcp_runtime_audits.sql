CREATE TABLE "filesystem_mcp_grant_approvals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "task_id" uuid NOT NULL,
  "work_package_id" uuid NOT NULL,
  "decided_by" uuid,
  "decision" text DEFAULT 'denied' NOT NULL,
  "capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "reason" text DEFAULT '' NOT NULL,
  "effective_grant" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "filesystem_mcp_grant_approvals"
  ADD CONSTRAINT "filesystem_mcp_grant_approvals_task_id_tasks_id_fk"
  FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "filesystem_mcp_grant_approvals"
  ADD CONSTRAINT "filesystem_mcp_grant_approvals_work_package_id_work_packages_id_fk"
  FOREIGN KEY ("work_package_id") REFERENCES "public"."work_packages"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "filesystem_mcp_grant_approvals"
  ADD CONSTRAINT "filesystem_mcp_grant_approvals_decided_by_users_id_fk"
  FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;

CREATE UNIQUE INDEX "filesystem_mcp_grant_approvals_work_package_id_idx"
  ON "filesystem_mcp_grant_approvals" USING btree ("work_package_id");
CREATE INDEX "filesystem_mcp_grant_approvals_task_id_idx"
  ON "filesystem_mcp_grant_approvals" USING btree ("task_id");
CREATE INDEX "filesystem_mcp_grant_approvals_decision_idx"
  ON "filesystem_mcp_grant_approvals" USING btree ("decision");

CREATE TABLE "filesystem_mcp_runtime_audits" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "task_id" uuid NOT NULL,
  "work_package_id" uuid,
  "agent_run_id" uuid,
  "grant_approval_id" uuid,
  "operation" text DEFAULT 'context_packet' NOT NULL,
  "status" text NOT NULL,
  "capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "requested_capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "root" text DEFAULT '' NOT NULL,
  "file_count" integer DEFAULT 0 NOT NULL,
  "byte_count" integer DEFAULT 0 NOT NULL,
  "omitted_count" integer DEFAULT 0 NOT NULL,
  "redaction_applied" boolean DEFAULT false NOT NULL,
  "redaction_summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "omitted_summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "reason" text DEFAULT '' NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "filesystem_mcp_runtime_audits"
  ADD CONSTRAINT "filesystem_mcp_runtime_audits_task_id_tasks_id_fk"
  FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "filesystem_mcp_runtime_audits"
  ADD CONSTRAINT "filesystem_mcp_runtime_audits_work_package_id_work_packages_id_fk"
  FOREIGN KEY ("work_package_id") REFERENCES "public"."work_packages"("id") ON DELETE set null ON UPDATE no action;

ALTER TABLE "filesystem_mcp_runtime_audits"
  ADD CONSTRAINT "filesystem_mcp_runtime_audits_agent_run_id_agent_runs_id_fk"
  FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;

ALTER TABLE "filesystem_mcp_runtime_audits"
  ADD CONSTRAINT "filesystem_mcp_runtime_audits_grant_approval_id_filesystem_mcp_grant_approvals_id_fk"
  FOREIGN KEY ("grant_approval_id") REFERENCES "public"."filesystem_mcp_grant_approvals"("id") ON DELETE set null ON UPDATE no action;

CREATE INDEX "filesystem_mcp_runtime_audits_task_id_idx"
  ON "filesystem_mcp_runtime_audits" USING btree ("task_id");
CREATE INDEX "filesystem_mcp_runtime_audits_work_package_id_idx"
  ON "filesystem_mcp_runtime_audits" USING btree ("work_package_id");
CREATE INDEX "filesystem_mcp_runtime_audits_agent_run_id_idx"
  ON "filesystem_mcp_runtime_audits" USING btree ("agent_run_id");
CREATE INDEX "filesystem_mcp_runtime_audits_grant_approval_id_idx"
  ON "filesystem_mcp_runtime_audits" USING btree ("grant_approval_id");
CREATE INDEX "filesystem_mcp_runtime_audits_status_idx"
  ON "filesystem_mcp_runtime_audits" USING btree ("status");
CREATE INDEX "filesystem_mcp_runtime_audits_created_at_idx"
  ON "filesystem_mcp_runtime_audits" USING btree ("created_at");
