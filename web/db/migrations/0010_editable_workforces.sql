CREATE TABLE "workforce_agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workforce_id" uuid NOT NULL,
	"agent_config_id" uuid NOT NULL,
	"role_label" text,
	"sequence" integer DEFAULT 1 NOT NULL,
	"is_required" boolean DEFAULT true NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workforces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"display_name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_configs" ADD COLUMN "display_name" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_configs" ADD COLUMN "description" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_configs" ADD COLUMN "is_system" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_configs" ADD COLUMN "is_active" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "workforce_agents" ADD CONSTRAINT "workforce_agents_workforce_id_workforces_id_fk" FOREIGN KEY ("workforce_id") REFERENCES "public"."workforces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workforce_agents" ADD CONSTRAINT "workforce_agents_agent_config_id_agent_configs_id_fk" FOREIGN KEY ("agent_config_id") REFERENCES "public"."agent_configs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workforce_agents_workforce_agent_idx" ON "workforce_agents" USING btree ("workforce_id","agent_config_id");--> statement-breakpoint
CREATE INDEX "workforce_agents_workforce_sequence_idx" ON "workforce_agents" USING btree ("workforce_id","sequence");--> statement-breakpoint
CREATE INDEX "workforce_agents_agent_config_id_idx" ON "workforce_agents" USING btree ("agent_config_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workforces_slug_idx" ON "workforces" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "workforces_is_active_idx" ON "workforces" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "workforces_is_default_idx" ON "workforces" USING btree ("is_default");--> statement-breakpoint
CREATE INDEX "agent_configs_is_active_idx" ON "agent_configs" USING btree ("is_active");