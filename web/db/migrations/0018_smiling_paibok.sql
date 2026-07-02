CREATE TABLE "task_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sequence" bigint GENERATED ALWAYS AS IDENTITY (sequence name "task_logs_sequence_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"task_id" uuid NOT NULL,
	"task_attempt_id" uuid,
	"agent_run_id" uuid,
	"work_package_id" uuid,
	"artifact_id" uuid,
	"approval_gate_id" uuid,
	"level" text DEFAULT 'info' NOT NULL,
	"event_type" text NOT NULL,
	"source" text DEFAULT 'system' NOT NULL,
	"title" text NOT NULL,
	"message" text NOT NULL,
	"front_matter" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "task_logs" ADD CONSTRAINT "task_logs_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_logs" ADD CONSTRAINT "task_logs_task_attempt_id_task_attempts_id_fk" FOREIGN KEY ("task_attempt_id") REFERENCES "public"."task_attempts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_logs" ADD CONSTRAINT "task_logs_agent_run_id_agent_runs_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_logs" ADD CONSTRAINT "task_logs_work_package_id_work_packages_id_fk" FOREIGN KEY ("work_package_id") REFERENCES "public"."work_packages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_logs" ADD CONSTRAINT "task_logs_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_logs" ADD CONSTRAINT "task_logs_approval_gate_id_approval_gates_id_fk" FOREIGN KEY ("approval_gate_id") REFERENCES "public"."approval_gates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "task_logs_task_id_occurred_at_idx" ON "task_logs" USING btree ("task_id","occurred_at","sequence");--> statement-breakpoint
CREATE INDEX "task_logs_task_id_level_idx" ON "task_logs" USING btree ("task_id","level");--> statement-breakpoint
CREATE INDEX "task_logs_task_id_event_type_idx" ON "task_logs" USING btree ("task_id","event_type");--> statement-breakpoint
CREATE INDEX "task_logs_level_idx" ON "task_logs" USING btree ("level");--> statement-breakpoint
CREATE INDEX "task_logs_event_type_idx" ON "task_logs" USING btree ("event_type");--> statement-breakpoint
CREATE INDEX "task_logs_agent_run_id_idx" ON "task_logs" USING btree ("agent_run_id");--> statement-breakpoint
CREATE INDEX "task_logs_task_attempt_id_idx" ON "task_logs" USING btree ("task_attempt_id");--> statement-breakpoint
CREATE INDEX "task_logs_work_package_id_idx" ON "task_logs" USING btree ("work_package_id");