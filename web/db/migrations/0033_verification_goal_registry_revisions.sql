-- Authoritative verification-goal registry revisions (issue #187 Slice 1).
-- Only the fixed SECURITY DEFINER routine below may construct or advance this
-- protected history. Ordinary Forge code can read it but cannot write it.
-- The migration login owns the existing snapshot table, so establish its
-- exact grants before entering the temporary protected-owner role.
REVOKE ALL PRIVILEGES ON TABLE public.verification_goal_snapshots FROM PUBLIC, forge;
GRANT SELECT, INSERT ON TABLE public.verification_goal_snapshots TO forge;
GRANT SELECT ON TABLE public.verification_goal_snapshots TO forge_s4_routines_owner;
GRANT REFERENCES ON TABLE
  public.projects,
  public.users,
  public.verification_goal_snapshots
TO forge_s4_routines_owner;
--> statement-breakpoint
SELECT public.forge_begin_epic_172_s4_owner_bootstrap_v1();
--> statement-breakpoint
CREATE UNIQUE INDEX "verification_goal_snapshots_id_project_idx"
ON "verification_goal_snapshots" USING btree ("id", "project_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "verification_goal_snapshots_registry_entry_identity_idx"
ON "verification_goal_snapshots" USING btree (
  "id", "project_id", "goal_id", "definition_version", "definition_digest"
);
--> statement-breakpoint
SET ROLE forge_s4_routines_owner;
--> statement-breakpoint
CREATE TABLE "verification_goal_registry_revisions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL,
  "revision_sequence" bigint NOT NULL,
  "manifest_digest" text NOT NULL,
  "application_asserted_actor_user_id" uuid NOT NULL,
  "project_submitted_by" uuid NOT NULL,
  "project_archived_at" timestamp with time zone,
  "project_local_path" text NOT NULL,
  "root_ref" uuid NOT NULL,
  "root_binding_revision" bigint NOT NULL,
  "grant_decision_revision" bigint NOT NULL,
  "project_revision" timestamp with time zone NOT NULL,
  "predecessor_revision_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "verification_goal_registry_revisions_project_id_fk"
    FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id")
    ON DELETE restrict ON UPDATE restrict,
  CONSTRAINT "verification_goal_registry_revisions_asserted_actor_fk"
    FOREIGN KEY ("application_asserted_actor_user_id") REFERENCES "public"."users"("id")
    ON DELETE restrict ON UPDATE restrict,
  CONSTRAINT "verification_goal_registry_revisions_submitted_by_fk"
    FOREIGN KEY ("project_submitted_by") REFERENCES "public"."users"("id")
    ON DELETE restrict ON UPDATE restrict,
  CONSTRAINT "verification_goal_registry_revisions_sequence_check"
    CHECK ("revision_sequence" > 0),
  CONSTRAINT "verification_goal_registry_revisions_manifest_digest_check"
    CHECK ("manifest_digest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "verification_goal_registry_revisions_asserted_actor_check"
    CHECK ("application_asserted_actor_user_id" = "project_submitted_by"),
  CONSTRAINT "verification_goal_registry_revisions_archived_check"
    CHECK ("project_archived_at" IS NULL),
  CONSTRAINT "verification_goal_registry_revisions_local_path_check"
    CHECK (length("project_local_path") BETWEEN 1 AND 4096),
  CONSTRAINT "verification_goal_registry_revisions_authority_revision_check"
    CHECK ("root_binding_revision" >= 0 AND "grant_decision_revision" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "verification_goal_registry_revisions_project_sequence_idx"
ON "verification_goal_registry_revisions" USING btree ("project_id", "revision_sequence");
--> statement-breakpoint
CREATE UNIQUE INDEX "verification_goal_registry_revisions_id_project_idx"
ON "verification_goal_registry_revisions" USING btree ("id", "project_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "verification_goal_registry_revisions_id_project_sequence_idx"
ON "verification_goal_registry_revisions" USING btree ("id", "project_id", "revision_sequence");
--> statement-breakpoint
ALTER TABLE "verification_goal_registry_revisions"
ADD CONSTRAINT "verification_goal_registry_revisions_predecessor_fk"
FOREIGN KEY ("predecessor_revision_id", "project_id")
REFERENCES "public"."verification_goal_registry_revisions"("id", "project_id")
ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE "verification_goal_registry_revisions"
ADD CONSTRAINT "verification_goal_registry_revisions_transition_identity_unique"
UNIQUE NULLS NOT DISTINCT (
  "project_id", "predecessor_revision_id", "root_ref", "root_binding_revision",
  "grant_decision_revision", "project_revision", "manifest_digest"
);
--> statement-breakpoint
CREATE TABLE "verification_goal_registry_entries" (
  "registry_revision_id" uuid NOT NULL,
  "project_id" uuid NOT NULL,
  "ordinal" integer NOT NULL,
  "snapshot_id" uuid NOT NULL,
  "goal_id" text NOT NULL,
  "definition_version" integer NOT NULL,
  "definition_digest" text NOT NULL,
  "source_path" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "verification_goal_registry_entries_pk"
    PRIMARY KEY ("registry_revision_id", "ordinal"),
  CONSTRAINT "verification_goal_registry_entries_revision_project_fk"
    FOREIGN KEY ("registry_revision_id", "project_id")
    REFERENCES "public"."verification_goal_registry_revisions"("id", "project_id")
    ON DELETE restrict ON UPDATE restrict,
  CONSTRAINT "verification_goal_registry_entries_snapshot_project_fk"
    FOREIGN KEY (
      "snapshot_id", "project_id", "goal_id", "definition_version", "definition_digest"
    )
    REFERENCES "public"."verification_goal_snapshots"(
      "id", "project_id", "goal_id", "definition_version", "definition_digest"
    )
    ON DELETE restrict ON UPDATE restrict,
  CONSTRAINT "verification_goal_registry_entries_ordinal_check"
    CHECK ("ordinal" >= 0),
  CONSTRAINT "verification_goal_registry_entries_goal_id_check" CHECK (
    length("goal_id") BETWEEN 1 AND 64
    AND "goal_id" ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$'
  ),
  CONSTRAINT "verification_goal_registry_entries_definition_version_check"
    CHECK ("definition_version" BETWEEN 1 AND 1000000),
  CONSTRAINT "verification_goal_registry_entries_definition_digest_check"
    CHECK ("definition_digest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "verification_goal_registry_entries_source_path_check" CHECK (
    length("source_path") <= 256
    AND "source_path" ~ '^\.forge/verification-goals/[A-Za-z0-9][A-Za-z0-9._-]{0,126}\.json$'
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX "verification_goal_registry_entries_revision_goal_idx"
ON "verification_goal_registry_entries" USING btree ("registry_revision_id", "goal_id");
--> statement-breakpoint
CREATE INDEX "verification_goal_registry_entries_project_goal_idx"
ON "verification_goal_registry_entries" USING btree ("project_id", "goal_id");
--> statement-breakpoint
CREATE TABLE "verification_goal_registry_heads" (
  "project_id" uuid PRIMARY KEY NOT NULL,
  "registry_revision_id" uuid NOT NULL,
  "revision_sequence" bigint NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "verification_goal_registry_heads_project_id_fk"
    FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id")
    ON DELETE restrict ON UPDATE restrict,
  CONSTRAINT "verification_goal_registry_heads_revision_project_sequence_fk"
    FOREIGN KEY ("registry_revision_id", "project_id", "revision_sequence")
    REFERENCES "public"."verification_goal_registry_revisions"("id", "project_id", "revision_sequence")
    ON DELETE restrict ON UPDATE restrict,
  CONSTRAINT "verification_goal_registry_heads_sequence_check"
    CHECK ("revision_sequence" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "verification_goal_registry_heads_revision_idx"
ON "verification_goal_registry_heads" USING btree ("registry_revision_id");
--> statement-breakpoint
RESET ROLE;
--> statement-breakpoint
REVOKE REFERENCES ON TABLE
  public.projects,
  public.users,
  public.verification_goal_snapshots
FROM forge_s4_routines_owner;
--> statement-breakpoint
SET ROLE forge_s4_routines_owner;
--> statement-breakpoint
CREATE FUNCTION public.forge_guard_verification_goal_registry_revision_write_v1()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'verification goal registry history is immutable'
      USING ERRCODE = 'P1873';
  END IF;
  IF session_user <> 'forge' OR current_user <> 'forge_s4_routines_owner' THEN
    RAISE EXCEPTION 'verification goal registry revision construction is protected'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "verification_goal_registry_revisions_protected_write"
BEFORE INSERT OR UPDATE OR DELETE ON "verification_goal_registry_revisions"
FOR EACH ROW EXECUTE FUNCTION public.forge_guard_verification_goal_registry_revision_write_v1();
--> statement-breakpoint
CREATE FUNCTION public.forge_guard_verification_goal_registry_entry_write_v1()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'verification goal registry membership is immutable'
      USING ERRCODE = 'P1873';
  END IF;
  IF session_user <> 'forge' OR current_user <> 'forge_s4_routines_owner' THEN
    RAISE EXCEPTION 'verification goal registry membership construction is protected'
      USING ERRCODE = '42501';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.verification_goal_registry_heads head
    WHERE head.registry_revision_id = NEW.registry_revision_id
  ) OR EXISTS (
    SELECT 1 FROM public.verification_goal_registry_revisions successor
    WHERE successor.predecessor_revision_id = NEW.registry_revision_id
  ) THEN
    RAISE EXCEPTION 'verification goal registry membership is already sealed'
      USING ERRCODE = 'P1873';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "verification_goal_registry_entries_protected_write"
BEFORE INSERT OR UPDATE OR DELETE ON "verification_goal_registry_entries"
FOR EACH ROW EXECUTE FUNCTION public.forge_guard_verification_goal_registry_entry_write_v1();
--> statement-breakpoint
CREATE FUNCTION public.forge_guard_verification_goal_registry_head_write_v1()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_predecessor uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'verification goal registry heads cannot be deleted'
      USING ERRCODE = 'P1873';
  END IF;
  IF session_user <> 'forge' OR current_user <> 'forge_s4_routines_owner' THEN
    RAISE EXCEPTION 'verification goal registry head construction is protected'
      USING ERRCODE = '42501';
  END IF;
  SELECT revision.predecessor_revision_id
  INTO v_predecessor
  FROM public.verification_goal_registry_revisions revision
  WHERE revision.id = NEW.registry_revision_id
    AND revision.project_id = NEW.project_id
    AND revision.revision_sequence = NEW.revision_sequence;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'verification goal registry head does not identify a matching revision'
      USING ERRCODE = 'P1873';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.revision_sequence <> 1 OR v_predecessor IS NOT NULL THEN
      RAISE EXCEPTION 'verification goal registry initial head is invalid'
        USING ERRCODE = 'P1873';
    END IF;
  ELSIF NEW.project_id <> OLD.project_id
     OR NEW.revision_sequence <> OLD.revision_sequence + 1
     OR v_predecessor IS DISTINCT FROM OLD.registry_revision_id THEN
    RAISE EXCEPTION 'verification goal registry head must advance one linked sequence'
      USING ERRCODE = 'P1873';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "verification_goal_registry_heads_protected_write"
BEFORE INSERT OR UPDATE OR DELETE ON "verification_goal_registry_heads"
FOR EACH ROW EXECUTE FUNCTION public.forge_guard_verification_goal_registry_head_write_v1();
--> statement-breakpoint
CREATE FUNCTION public.forge_commit_verification_goal_registry_revision_v1(
  p_project_id uuid,
  p_application_asserted_actor_user_id uuid,
  p_expected_prior_revision_id uuid,
  p_expected_submitted_by uuid,
  p_expected_archived_at timestamptz,
  p_expected_local_path text,
  p_expected_root_ref uuid,
  p_expected_root_binding_revision bigint,
  p_expected_grant_decision_revision bigint,
  p_expected_project_revision timestamptz,
  p_manifest_digest text,
  p_entries jsonb
)
RETURNS TABLE (
  registry_revision_id uuid,
  revision_sequence bigint,
  head_state text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_project public.projects%ROWTYPE;
  v_head public.verification_goal_registry_heads%ROWTYPE;
  v_entry jsonb;
  v_stored_entry record;
  v_entry_count integer;
  v_ordinal integer := 0;
  v_snapshot_id uuid;
  v_goal_id text;
  v_definition_version integer;
  v_definition_digest text;
  v_source_path text;
  v_previous_goal_id text;
  v_payload bytea := pg_catalog.convert_to(
    'forge:verification-goal:registry-manifest:v1', 'UTF8'
  ) || pg_catalog.decode('00', 'hex');
  v_stored_payload bytea := pg_catalog.convert_to(
    'forge:verification-goal:registry-manifest:v1', 'UTF8'
  ) || pg_catalog.decode('00', 'hex');
  v_scalar text;
  v_computed_digest text;
  v_current_exact boolean := false;
  v_current_identity_matches boolean := false;
  v_new_revision_id uuid;
  v_new_sequence bigint;
  v_affected integer;
BEGIN
  IF session_user <> 'forge' OR current_user <> 'forge_s4_routines_owner' THEN
    RAISE EXCEPTION 'verification goal registry commit requires the fixed Forge login'
      USING ERRCODE = '42501';
  END IF;

  SELECT project.* INTO v_project
  FROM public.projects project
  WHERE project.id = p_project_id
  FOR NO KEY UPDATE;
  IF NOT FOUND
     OR v_project.submitted_by IS DISTINCT FROM p_expected_submitted_by
     OR v_project.submitted_by IS DISTINCT FROM p_application_asserted_actor_user_id
     OR v_project.archived_at IS DISTINCT FROM p_expected_archived_at
     OR v_project.archived_at IS NOT NULL
     OR v_project.local_path IS DISTINCT FROM p_expected_local_path
     OR v_project.root_ref IS DISTINCT FROM p_expected_root_ref
     OR v_project.root_binding_revision IS DISTINCT FROM p_expected_root_binding_revision
     OR v_project.grant_decision_revision IS DISTINCT FROM p_expected_grant_decision_revision
     OR v_project.updated_at IS DISTINCT FROM p_expected_project_revision THEN
    RAISE EXCEPTION 'verification goal project authority changed'
      USING ERRCODE = 'P1871';
  END IF;

  SELECT head.* INTO v_head
  FROM public.verification_goal_registry_heads head
  WHERE head.project_id = p_project_id
  FOR UPDATE;

  IF pg_catalog.jsonb_typeof(p_entries) <> 'array'
     OR pg_catalog.octet_length(p_entries::text) > 65536
     OR p_manifest_digest !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'verification goal registry commit payload is malformed'
      USING ERRCODE = '22023';
  END IF;
  v_entry_count := pg_catalog.jsonb_array_length(p_entries);
  IF v_entry_count > 64 THEN
    RAISE EXCEPTION 'verification goal registry entry count is invalid'
      USING ERRCODE = '22023';
  END IF;

  v_scalar := v_entry_count::text;
  v_payload := v_payload
    || pg_catalog.convert_to(pg_catalog.octet_length(pg_catalog.convert_to(v_scalar, 'UTF8'))::text || ':', 'UTF8')
    || pg_catalog.convert_to(v_scalar, 'UTF8');

  FOR v_entry IN
    SELECT item.value
    FROM pg_catalog.jsonb_array_elements(p_entries) WITH ORDINALITY AS item(value, ordinal)
    ORDER BY item.ordinal
  LOOP
    IF pg_catalog.jsonb_typeof(v_entry) <> 'object'
       OR (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(v_entry)) <> 5
       OR NOT (v_entry ?& ARRAY[
         'snapshotId', 'goalId', 'definitionVersion', 'definitionDigest', 'sourcePath'
       ])
       OR pg_catalog.jsonb_typeof(v_entry -> 'snapshotId') <> 'string'
       OR pg_catalog.jsonb_typeof(v_entry -> 'goalId') <> 'string'
       OR pg_catalog.jsonb_typeof(v_entry -> 'definitionVersion') <> 'number'
       OR pg_catalog.jsonb_typeof(v_entry -> 'definitionDigest') <> 'string'
       OR pg_catalog.jsonb_typeof(v_entry -> 'sourcePath') <> 'string'
       OR (v_entry ->> 'snapshotId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       OR (v_entry ->> 'goalId') !~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$'
       OR pg_catalog.length(v_entry ->> 'goalId') > 64
       OR (v_entry ->> 'definitionVersion') !~ '^[1-9][0-9]{0,6}$'
       OR (v_entry ->> 'definitionVersion')::bigint > 1000000
       OR (v_entry ->> 'definitionDigest') !~ '^[0-9a-f]{64}$'
       OR pg_catalog.length(v_entry ->> 'sourcePath') > 256
       OR (v_entry ->> 'sourcePath') !~ '^\.forge/verification-goals/[A-Za-z0-9][A-Za-z0-9._-]{0,126}\.json$' THEN
      RAISE EXCEPTION 'verification goal registry entry is malformed'
        USING ERRCODE = '22023';
    END IF;
    v_snapshot_id := (v_entry ->> 'snapshotId')::uuid;
    v_goal_id := v_entry ->> 'goalId';
    v_definition_version := (v_entry ->> 'definitionVersion')::integer;
    v_definition_digest := v_entry ->> 'definitionDigest';
    v_source_path := v_entry ->> 'sourcePath';
    IF v_previous_goal_id IS NOT NULL
       AND (v_previous_goal_id COLLATE "C") >= (v_goal_id COLLATE "C") THEN
      RAISE EXCEPTION 'verification goal registry entries are not strictly sorted'
        USING ERRCODE = '22023';
    END IF;
    v_previous_goal_id := v_goal_id;
    PERFORM 1
    FROM public.verification_goal_snapshots snapshot
    WHERE snapshot.id = v_snapshot_id
      AND snapshot.project_id = p_project_id
      AND snapshot.goal_id = v_goal_id
      AND snapshot.definition_version = v_definition_version
      AND snapshot.definition_digest = v_definition_digest;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'verification goal registry entry does not match a project snapshot'
        USING ERRCODE = '22023';
    END IF;
    FOREACH v_scalar IN ARRAY ARRAY[
      v_goal_id, v_definition_version::text, v_definition_digest, v_source_path
    ] LOOP
      v_payload := v_payload
        || pg_catalog.convert_to(pg_catalog.octet_length(pg_catalog.convert_to(v_scalar, 'UTF8'))::text || ':', 'UTF8')
        || pg_catalog.convert_to(v_scalar, 'UTF8');
    END LOOP;
  END LOOP;
  v_computed_digest := pg_catalog.encode(pg_catalog.sha256(v_payload), 'hex');
  IF v_computed_digest IS DISTINCT FROM p_manifest_digest THEN
    RAISE EXCEPTION 'verification goal registry manifest digest is invalid'
      USING ERRCODE = '22023';
  END IF;

  IF v_head.registry_revision_id IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1
      FROM public.verification_goal_registry_revisions revision
      WHERE revision.id = v_head.registry_revision_id
        AND revision.project_id = p_project_id
        AND revision.revision_sequence = v_head.revision_sequence
        AND revision.manifest_digest = p_manifest_digest
        AND revision.application_asserted_actor_user_id = p_application_asserted_actor_user_id
        AND revision.project_submitted_by = p_expected_submitted_by
        AND revision.project_archived_at IS NOT DISTINCT FROM p_expected_archived_at
        AND revision.project_local_path = p_expected_local_path
        AND revision.root_ref = p_expected_root_ref
        AND revision.root_binding_revision = p_expected_root_binding_revision
        AND revision.grant_decision_revision = p_expected_grant_decision_revision
        AND revision.project_revision = p_expected_project_revision
    ) INTO v_current_identity_matches;
    IF v_current_identity_matches THEN
      SELECT
        (SELECT pg_catalog.count(*) FROM public.verification_goal_registry_entries stored
          WHERE stored.registry_revision_id = v_head.registry_revision_id) = v_entry_count
        AND NOT EXISTS (
          SELECT 1
          FROM pg_catalog.jsonb_array_elements(p_entries) WITH ORDINALITY AS supplied(value, ordinal)
          LEFT JOIN public.verification_goal_registry_entries stored
            ON stored.registry_revision_id = v_head.registry_revision_id
           AND stored.ordinal = supplied.ordinal - 1
          WHERE stored.snapshot_id IS DISTINCT FROM (supplied.value ->> 'snapshotId')::uuid
             OR stored.goal_id IS DISTINCT FROM supplied.value ->> 'goalId'
             OR stored.definition_version IS DISTINCT FROM (supplied.value ->> 'definitionVersion')::integer
             OR stored.definition_digest IS DISTINCT FROM supplied.value ->> 'definitionDigest'
             OR stored.source_path IS DISTINCT FROM supplied.value ->> 'sourcePath'
        )
      INTO v_current_exact;
      IF NOT v_current_exact THEN
        RAISE EXCEPTION 'stored verification goal registry membership is inconsistent'
          USING ERRCODE = 'P1873';
      END IF;
    END IF;
  ELSIF EXISTS (
    SELECT 1 FROM public.verification_goal_registry_revisions revision
    WHERE revision.project_id = p_project_id
  ) THEN
    RAISE EXCEPTION 'verification goal registry history has no current head'
      USING ERRCODE = 'P1873';
  END IF;

  IF v_head.registry_revision_id IS DISTINCT FROM p_expected_prior_revision_id THEN
    IF v_current_exact THEN
      registry_revision_id := v_head.registry_revision_id;
      revision_sequence := v_head.revision_sequence;
      head_state := 'existing';
      RETURN NEXT;
      RETURN;
    END IF;
    RAISE EXCEPTION 'verification goal registry head changed'
      USING ERRCODE = 'P1872';
  END IF;
  IF v_current_exact THEN
    registry_revision_id := v_head.registry_revision_id;
    revision_sequence := v_head.revision_sequence;
    head_state := 'existing';
    RETURN NEXT;
    RETURN;
  END IF;

  v_new_sequence := COALESCE(v_head.revision_sequence, 0::bigint) + 1;
  INSERT INTO public.verification_goal_registry_revisions (
    project_id, revision_sequence, manifest_digest, application_asserted_actor_user_id,
    project_submitted_by, project_archived_at, project_local_path, root_ref,
    root_binding_revision, grant_decision_revision, project_revision,
    predecessor_revision_id
  ) VALUES (
    p_project_id, v_new_sequence, p_manifest_digest, p_application_asserted_actor_user_id,
    p_expected_submitted_by, p_expected_archived_at, p_expected_local_path,
    p_expected_root_ref, p_expected_root_binding_revision,
    p_expected_grant_decision_revision, p_expected_project_revision,
    v_head.registry_revision_id
  ) RETURNING id INTO v_new_revision_id;

  v_ordinal := 0;
  FOR v_entry IN
    SELECT item.value
    FROM pg_catalog.jsonb_array_elements(p_entries) WITH ORDINALITY AS item(value, ordinal)
    ORDER BY item.ordinal
  LOOP
    INSERT INTO public.verification_goal_registry_entries (
      registry_revision_id, project_id, ordinal, snapshot_id, goal_id,
      definition_version, definition_digest, source_path
    ) VALUES (
      v_new_revision_id, p_project_id, v_ordinal,
      (v_entry ->> 'snapshotId')::uuid, v_entry ->> 'goalId',
      (v_entry ->> 'definitionVersion')::integer,
      v_entry ->> 'definitionDigest', v_entry ->> 'sourcePath'
    );
    v_ordinal := v_ordinal + 1;
  END LOOP;

  IF (SELECT pg_catalog.count(*) FROM public.verification_goal_registry_entries stored
      WHERE stored.registry_revision_id = v_new_revision_id) <> v_entry_count THEN
    RAISE EXCEPTION 'stored verification goal registry membership count is inconsistent'
      USING ERRCODE = 'P1873';
  END IF;
  v_scalar := v_entry_count::text;
  v_stored_payload := v_stored_payload
    || pg_catalog.convert_to(pg_catalog.octet_length(pg_catalog.convert_to(v_scalar, 'UTF8'))::text || ':', 'UTF8')
    || pg_catalog.convert_to(v_scalar, 'UTF8');
  FOR v_stored_entry IN
    SELECT stored.goal_id, stored.definition_version,
      stored.definition_digest, stored.source_path
    FROM public.verification_goal_registry_entries stored
    WHERE stored.registry_revision_id = v_new_revision_id
    ORDER BY stored.ordinal
  LOOP
    FOREACH v_scalar IN ARRAY ARRAY[
      v_stored_entry.goal_id,
      v_stored_entry.definition_version::text,
      v_stored_entry.definition_digest,
      v_stored_entry.source_path
    ] LOOP
      v_stored_payload := v_stored_payload
        || pg_catalog.convert_to(pg_catalog.octet_length(pg_catalog.convert_to(v_scalar, 'UTF8'))::text || ':', 'UTF8')
        || pg_catalog.convert_to(v_scalar, 'UTF8');
    END LOOP;
  END LOOP;
  IF pg_catalog.encode(pg_catalog.sha256(v_stored_payload), 'hex') IS DISTINCT FROM p_manifest_digest THEN
    RAISE EXCEPTION 'stored verification goal registry manifest is inconsistent'
      USING ERRCODE = 'P1873';
  END IF;

  IF v_head.registry_revision_id IS NULL THEN
    INSERT INTO public.verification_goal_registry_heads (
      project_id, registry_revision_id, revision_sequence
    ) VALUES (p_project_id, v_new_revision_id, v_new_sequence);
  ELSE
    UPDATE public.verification_goal_registry_heads head
    SET registry_revision_id = v_new_revision_id,
        revision_sequence = v_new_sequence,
        updated_at = pg_catalog.clock_timestamp()
    WHERE head.project_id = p_project_id
      AND head.registry_revision_id = v_head.registry_revision_id
      AND head.revision_sequence = v_head.revision_sequence;
    GET DIAGNOSTICS v_affected = ROW_COUNT;
    IF v_affected <> 1 THEN
      RAISE EXCEPTION 'verification goal registry head changed before advance'
        USING ERRCODE = 'P1872';
    END IF;
  END IF;

  registry_revision_id := v_new_revision_id;
  revision_sequence := v_new_sequence;
  head_state := 'advanced';
  RETURN NEXT;
END;
$$;
--> statement-breakpoint
ALTER TABLE public.verification_goal_registry_revisions OWNER TO forge_s4_routines_owner;
ALTER TABLE public.verification_goal_registry_entries OWNER TO forge_s4_routines_owner;
ALTER TABLE public.verification_goal_registry_heads OWNER TO forge_s4_routines_owner;
ALTER FUNCTION public.forge_guard_verification_goal_registry_revision_write_v1()
  OWNER TO forge_s4_routines_owner;
ALTER FUNCTION public.forge_guard_verification_goal_registry_entry_write_v1()
  OWNER TO forge_s4_routines_owner;
ALTER FUNCTION public.forge_guard_verification_goal_registry_head_write_v1()
  OWNER TO forge_s4_routines_owner;
ALTER FUNCTION public.forge_commit_verification_goal_registry_revision_v1(
  uuid,uuid,uuid,uuid,timestamptz,text,uuid,bigint,bigint,timestamptz,text,jsonb
) OWNER TO forge_s4_routines_owner;
--> statement-breakpoint
SET ROLE forge_s4_routines_owner;
REVOKE ALL PRIVILEGES ON TABLE
  public.verification_goal_registry_revisions,
  public.verification_goal_registry_entries,
  public.verification_goal_registry_heads
FROM PUBLIC, forge;
GRANT SELECT ON TABLE
  public.verification_goal_registry_revisions,
  public.verification_goal_registry_entries,
  public.verification_goal_registry_heads
TO forge;
REVOKE ALL ON FUNCTION public.forge_guard_verification_goal_registry_revision_write_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.forge_guard_verification_goal_registry_entry_write_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.forge_guard_verification_goal_registry_head_write_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.forge_commit_verification_goal_registry_revision_v1(
  uuid,uuid,uuid,uuid,timestamptz,text,uuid,bigint,bigint,timestamptz,text,jsonb
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.forge_commit_verification_goal_registry_revision_v1(
  uuid,uuid,uuid,uuid,timestamptz,text,uuid,bigint,bigint,timestamptz,text,jsonb
) TO forge;
RESET ROLE;
--> statement-breakpoint
SELECT public.forge_finalize_epic_172_s4_owner_bootstrap_v1();
