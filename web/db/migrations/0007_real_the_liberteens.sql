CREATE TABLE "provider_health_checks" (
	"provider_config_id" uuid PRIMARY KEY NOT NULL,
	"reachable" boolean DEFAULT false NOT NULL,
	"env_var_present" boolean DEFAULT false NOT NULL,
	"latency_ms" integer,
	"error" text,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "task_questions" ADD COLUMN "suggestions" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "provider_health_checks" ADD CONSTRAINT "provider_health_checks_provider_config_id_provider_configs_id_fk" FOREIGN KEY ("provider_config_id") REFERENCES "public"."provider_configs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "provider_health_checks_checked_at_idx" ON "provider_health_checks" USING btree ("checked_at");