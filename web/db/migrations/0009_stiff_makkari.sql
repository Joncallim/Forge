CREATE TABLE "agent_harnesses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"role" text NOT NULL,
	"display_name" text NOT NULL,
	"category" text DEFAULT 'general' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"system_prompt" text DEFAULT '' NOT NULL,
	"tool_policy" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"reference_paths" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"output_schema" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"validation_checks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"default_provider_config_id" uuid,
	"is_active" boolean DEFAULT true NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "approval_gates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"work_package_id" uuid,
	"gate_type" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"source_agent_run_id" uuid,
	"source_artifact_id" uuid,
	"title" text NOT NULL,
	"instructions" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vcs_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"work_package_id" uuid,
	"agent_run_id" uuid,
	"change_type" text DEFAULT 'branch' NOT NULL,
	"status" text DEFAULT 'planned' NOT NULL,
	"repository" text,
	"branch_name" text,
	"base_branch" text,
	"commit_sha" text,
	"pull_request_url" text,
	"diff_summary" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "work_package_dependencies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"work_package_id" uuid NOT NULL,
	"depends_on_work_package_id" uuid NOT NULL,
	"dependency_type" text DEFAULT 'finish_to_start' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "work_packages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"harness_id" uuid,
	"assigned_role" text NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"sequence" integer NOT NULL,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"required_capabilities" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"acceptance_criteria" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"mcp_requirements" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"blocked_reason" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "work_package_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "harness_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "stage" text;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "attempt_number" integer;--> statement-breakpoint
ALTER TABLE "agent_harnesses" ADD CONSTRAINT "agent_harnesses_default_provider_config_id_provider_configs_id_fk" FOREIGN KEY ("default_provider_config_id") REFERENCES "public"."provider_configs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_gates" ADD CONSTRAINT "approval_gates_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_gates" ADD CONSTRAINT "approval_gates_work_package_id_work_packages_id_fk" FOREIGN KEY ("work_package_id") REFERENCES "public"."work_packages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_gates" ADD CONSTRAINT "approval_gates_source_agent_run_id_agent_runs_id_fk" FOREIGN KEY ("source_agent_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_gates" ADD CONSTRAINT "approval_gates_source_artifact_id_artifacts_id_fk" FOREIGN KEY ("source_artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_gates" ADD CONSTRAINT "approval_gates_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vcs_changes" ADD CONSTRAINT "vcs_changes_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vcs_changes" ADD CONSTRAINT "vcs_changes_work_package_id_work_packages_id_fk" FOREIGN KEY ("work_package_id") REFERENCES "public"."work_packages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vcs_changes" ADD CONSTRAINT "vcs_changes_agent_run_id_agent_runs_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_package_dependencies" ADD CONSTRAINT "work_package_dependencies_work_package_id_work_packages_id_fk" FOREIGN KEY ("work_package_id") REFERENCES "public"."work_packages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_package_dependencies" ADD CONSTRAINT "work_package_dependencies_depends_on_work_package_id_work_packages_id_fk" FOREIGN KEY ("depends_on_work_package_id") REFERENCES "public"."work_packages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_packages" ADD CONSTRAINT "work_packages_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_packages" ADD CONSTRAINT "work_packages_harness_id_agent_harnesses_id_fk" FOREIGN KEY ("harness_id") REFERENCES "public"."agent_harnesses"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_harnesses_slug_idx" ON "agent_harnesses" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "agent_harnesses_role_idx" ON "agent_harnesses" USING btree ("role");--> statement-breakpoint
CREATE INDEX "agent_harnesses_category_idx" ON "agent_harnesses" USING btree ("category");--> statement-breakpoint
CREATE INDEX "agent_harnesses_is_active_idx" ON "agent_harnesses" USING btree ("is_active");--> statement-breakpoint
CREATE UNIQUE INDEX "approval_gates_task_gate_artifact_idx" ON "approval_gates" USING btree ("task_id","gate_type","source_artifact_id");--> statement-breakpoint
CREATE INDEX "approval_gates_task_id_status_idx" ON "approval_gates" USING btree ("task_id","status");--> statement-breakpoint
CREATE INDEX "approval_gates_work_package_id_idx" ON "approval_gates" USING btree ("work_package_id");--> statement-breakpoint
CREATE INDEX "approval_gates_source_agent_run_id_idx" ON "approval_gates" USING btree ("source_agent_run_id");--> statement-breakpoint
CREATE INDEX "vcs_changes_task_id_status_idx" ON "vcs_changes" USING btree ("task_id","status");--> statement-breakpoint
CREATE INDEX "vcs_changes_work_package_id_idx" ON "vcs_changes" USING btree ("work_package_id");--> statement-breakpoint
CREATE INDEX "vcs_changes_agent_run_id_idx" ON "vcs_changes" USING btree ("agent_run_id");--> statement-breakpoint
CREATE INDEX "vcs_changes_pull_request_url_idx" ON "vcs_changes" USING btree ("pull_request_url");--> statement-breakpoint
CREATE UNIQUE INDEX "work_package_dependencies_unique_idx" ON "work_package_dependencies" USING btree ("work_package_id","depends_on_work_package_id");--> statement-breakpoint
CREATE INDEX "work_package_dependencies_work_package_id_idx" ON "work_package_dependencies" USING btree ("work_package_id");--> statement-breakpoint
CREATE INDEX "work_package_dependencies_depends_on_idx" ON "work_package_dependencies" USING btree ("depends_on_work_package_id");--> statement-breakpoint
CREATE UNIQUE INDEX "work_packages_task_sequence_idx" ON "work_packages" USING btree ("task_id","sequence");--> statement-breakpoint
CREATE INDEX "work_packages_task_id_status_idx" ON "work_packages" USING btree ("task_id","status");--> statement-breakpoint
CREATE INDEX "work_packages_harness_id_idx" ON "work_packages" USING btree ("harness_id");--> statement-breakpoint
CREATE INDEX "work_packages_assigned_role_idx" ON "work_packages" USING btree ("assigned_role");--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_work_package_id_work_packages_id_fk" FOREIGN KEY ("work_package_id") REFERENCES "public"."work_packages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_harness_id_agent_harnesses_id_fk" FOREIGN KEY ("harness_id") REFERENCES "public"."agent_harnesses"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_runs_work_package_id_idx" ON "agent_runs" USING btree ("work_package_id");--> statement-breakpoint
CREATE INDEX "agent_runs_harness_id_idx" ON "agent_runs" USING btree ("harness_id");--> statement-breakpoint
CREATE INDEX "agent_runs_stage_idx" ON "agent_runs" USING btree ("stage");