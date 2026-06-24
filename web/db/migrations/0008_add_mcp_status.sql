CREATE TABLE "mcp_installations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mcp_id" text NOT NULL,
	"install_path" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"source" text DEFAULT 'catalog' NOT NULL,
	"metadata" jsonb,
	"installed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_mcp_status_checks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"mcp_id" text NOT NULL,
	"status" text NOT NULL,
	"install_state" text NOT NULL,
	"error" text,
	"details" jsonb,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "mcp_config" jsonb DEFAULT '{"profile":"default","requiredMcps":["filesystem","github"],"overrides":{}}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "project_mcp_status_checks" ADD CONSTRAINT "project_mcp_status_checks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_installations_mcp_id_idx" ON "mcp_installations" USING btree ("mcp_id");--> statement-breakpoint
CREATE INDEX "mcp_installations_enabled_idx" ON "mcp_installations" USING btree ("enabled");--> statement-breakpoint
CREATE UNIQUE INDEX "project_mcp_status_project_mcp_idx" ON "project_mcp_status_checks" USING btree ("project_id","mcp_id");--> statement-breakpoint
CREATE INDEX "project_mcp_status_project_id_idx" ON "project_mcp_status_checks" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "project_mcp_status_mcp_id_idx" ON "project_mcp_status_checks" USING btree ("mcp_id");--> statement-breakpoint
CREATE INDEX "project_mcp_status_checked_at_idx" ON "project_mcp_status_checks" USING btree ("checked_at");