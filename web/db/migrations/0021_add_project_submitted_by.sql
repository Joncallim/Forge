ALTER TABLE "projects" ADD COLUMN "submitted_by" uuid;--> statement-breakpoint
UPDATE "projects"
SET "submitted_by" = (
  SELECT "id"
  FROM "users"
  ORDER BY "created_at" ASC, "id" ASC
  LIMIT 1
)
WHERE "submitted_by" IS NULL
  AND 1 = (SELECT count(*) FROM "users");--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_submitted_by_users_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
