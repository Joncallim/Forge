CREATE TABLE "task_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"queue_name" text NOT NULL,
	"attempt_number" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"worker_id" text,
	"job_payload" jsonb,
	"error_message" text,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"next_retry_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "task_attempts" ADD CONSTRAINT "task_attempts_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "task_attempts_task_id_created_at_idx" ON "task_attempts" USING btree ("task_id","created_at");--> statement-breakpoint
CREATE INDEX "task_attempts_status_idx" ON "task_attempts" USING btree ("status");--> statement-breakpoint
CREATE INDEX "task_attempts_queue_name_idx" ON "task_attempts" USING btree ("queue_name");