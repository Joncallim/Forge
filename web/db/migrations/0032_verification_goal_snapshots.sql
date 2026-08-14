-- Verification goal definition registry (ADR 0013, issue #187 first slice).
-- These rows are immutable definition snapshots only. They do not say that a
-- goal ran, passed, failed, or produced evidence. Repository source remains
-- under the fixed `.forge/verification-goals/` project path.
CREATE TABLE "verification_goal_snapshots" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL,
  "goal_id" text NOT NULL,
  "definition_version" integer NOT NULL,
  "canonical_definition" jsonb NOT NULL,
  "definition_digest" text NOT NULL,
  "source_path" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "verification_goal_snapshots_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action,
  CONSTRAINT "verification_goal_snapshots_goal_id_check" CHECK (
    length("goal_id") BETWEEN 1 AND 64
    AND "goal_id" ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$'
  ),
  CONSTRAINT "verification_goal_snapshots_definition_version_check" CHECK (
    "definition_version" BETWEEN 1 AND 1000000
  ),
  CONSTRAINT "verification_goal_snapshots_definition_digest_check" CHECK (
    "definition_digest" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "verification_goal_snapshots_source_path_check" CHECK (
    length("source_path") <= 256
    AND "source_path" ~ '^\.forge/verification-goals/[A-Za-z0-9][A-Za-z0-9._-]{0,126}\.json$'
  ),
  CONSTRAINT "verification_goal_snapshots_canonical_definition_check" CHECK (
    pg_catalog.jsonb_typeof("canonical_definition") = 'object'
    AND pg_catalog.octet_length("canonical_definition"::text) <= 32768
    AND "canonical_definition" ?& ARRAY[
      'schemaVersion', 'goalId', 'definitionVersion', 'title', 'description',
      'capability', 'severity', 'enabled', 'operations'
    ]
    AND ("canonical_definition" - ARRAY[
      'schemaVersion', 'goalId', 'definitionVersion', 'title', 'description',
      'capability', 'severity', 'enabled', 'operations'
    ]) = '{}'::jsonb
    AND "canonical_definition" @> pg_catalog.jsonb_build_object(
      'schemaVersion', 1,
      'goalId', "goal_id",
      'definitionVersion', "definition_version"
    )
    AND pg_catalog.jsonb_typeof("canonical_definition" -> 'enabled') = 'boolean'
    AND ("canonical_definition" ->> 'severity') IN ('low', 'medium', 'high', 'critical')
    AND pg_catalog.jsonb_typeof("canonical_definition" -> 'operations') = 'array'
    AND pg_catalog.jsonb_array_length("canonical_definition" -> 'operations') BETWEEN 1 AND 16
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX "verification_goal_snapshots_project_goal_version_idx"
ON "verification_goal_snapshots" USING btree ("project_id", "goal_id", "definition_version");
--> statement-breakpoint
CREATE INDEX "verification_goal_snapshots_project_goal_created_at_idx"
ON "verification_goal_snapshots" USING btree ("project_id", "goal_id", "created_at");
--> statement-breakpoint
CREATE FUNCTION "forge_reject_verification_goal_snapshot_mutation_v1"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'verification goal snapshots are append-only';
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.forge_reject_verification_goal_snapshot_mutation_v1() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "verification_goal_snapshots_append_only"
BEFORE UPDATE OR DELETE ON "verification_goal_snapshots"
FOR EACH ROW EXECUTE FUNCTION "forge_reject_verification_goal_snapshot_mutation_v1"();
