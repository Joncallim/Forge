CREATE TABLE "repository_command_audits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"work_package_id" uuid,
	"agent_run_id" uuid,
	"artifact_id" uuid,
	"cwd" text NOT NULL,
	"command" text NOT NULL,
	"argv" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"risk_class" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone NOT NULL,
	"exit_code" integer NOT NULL,
	"output_summary" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "repository_command_audits" ADD CONSTRAINT "repository_command_audits_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repository_command_audits" ADD CONSTRAINT "repository_command_audits_work_package_id_work_packages_id_fk" FOREIGN KEY ("work_package_id") REFERENCES "public"."work_packages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repository_command_audits" ADD CONSTRAINT "repository_command_audits_agent_run_id_agent_runs_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repository_command_audits" ADD CONSTRAINT "repository_command_audits_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "repository_command_audits_task_id_idx" ON "repository_command_audits" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "repository_command_audits_work_package_id_idx" ON "repository_command_audits" USING btree ("work_package_id");--> statement-breakpoint
CREATE INDEX "repository_command_audits_agent_run_id_idx" ON "repository_command_audits" USING btree ("agent_run_id");--> statement-breakpoint
CREATE INDEX "repository_command_audits_artifact_id_idx" ON "repository_command_audits" USING btree ("artifact_id");--> statement-breakpoint
CREATE INDEX "repository_command_audits_started_at_idx" ON "repository_command_audits" USING btree ("started_at");