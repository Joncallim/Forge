-- Executable verification-goal registry bindings (issue #187 combined delivery).
-- Existing schema-v1 definitions and registry commits keep their historical
-- meaning. This migration expands storage for schema-v2 executable definitions
-- and adds a separate protected commit routine for manifest v2.

ALTER TABLE public.verification_goal_snapshots
DROP CONSTRAINT verification_goal_snapshots_canonical_definition_check;
--> statement-breakpoint
ALTER TABLE public.verification_goal_snapshots
ADD CONSTRAINT verification_goal_snapshots_canonical_definition_check CHECK (
  pg_catalog.jsonb_typeof(canonical_definition) = 'object'
  AND pg_catalog.octet_length(canonical_definition::text) <= 32768
  AND (
    (
      canonical_definition ?& ARRAY[
        'schemaVersion', 'goalId', 'definitionVersion', 'title', 'description',
        'capability', 'severity', 'enabled', 'operations'
      ]
      AND (canonical_definition - ARRAY[
        'schemaVersion', 'goalId', 'definitionVersion', 'title', 'description',
        'capability', 'severity', 'enabled', 'operations'
      ]) = '{}'::jsonb
      AND canonical_definition @> pg_catalog.jsonb_build_object(
        'schemaVersion', 1,
        'goalId', goal_id,
        'definitionVersion', definition_version
      )
    )
    OR
    (
      canonical_definition ?& ARRAY[
        'schemaVersion', 'goalId', 'definitionVersion', 'title', 'description',
        'capability', 'severity', 'enabled', 'operations', 'execution'
      ]
      AND (canonical_definition - ARRAY[
        'schemaVersion', 'goalId', 'definitionVersion', 'title', 'description',
        'capability', 'severity', 'enabled', 'operations', 'execution'
      ]) = '{}'::jsonb
      AND canonical_definition @> pg_catalog.jsonb_build_object(
        'schemaVersion', 2,
        'goalId', goal_id,
        'definitionVersion', definition_version
      )
      AND pg_catalog.jsonb_typeof(canonical_definition -> 'execution') = 'object'
      AND (canonical_definition -> 'execution') ?& ARRAY[
        'manual', 'schedule', 'deadlineSeconds', 'requiredEvidence'
      ]
      AND ((canonical_definition -> 'execution') - ARRAY[
        'manual', 'schedule', 'deadlineSeconds', 'requiredEvidence'
      ]) = '{}'::jsonb
      AND pg_catalog.jsonb_typeof(canonical_definition -> 'execution' -> 'manual') = 'boolean'
      AND pg_catalog.jsonb_typeof(canonical_definition -> 'execution' -> 'deadlineSeconds') = 'number'
      AND (canonical_definition -> 'execution' ->> 'deadlineSeconds') ~ '^[1-9][0-9]{0,3}$'
      AND (canonical_definition -> 'execution' ->> 'deadlineSeconds')::integer BETWEEN 1 AND 3600
      AND pg_catalog.jsonb_typeof(canonical_definition -> 'execution' -> 'requiredEvidence') = 'array'
      AND pg_catalog.jsonb_array_length(canonical_definition -> 'execution' -> 'requiredEvidence') <= 4
      AND (
        (canonical_definition -> 'execution' -> 'schedule') = 'null'::jsonb
        OR (
          pg_catalog.jsonb_typeof(canonical_definition -> 'execution' -> 'schedule') = 'object'
          AND (canonical_definition -> 'execution' -> 'schedule') ?& ARRAY['kind', 'everySeconds']
          AND ((canonical_definition -> 'execution' -> 'schedule') - ARRAY['kind', 'everySeconds']) = '{}'::jsonb
          AND canonical_definition -> 'execution' -> 'schedule' ->> 'kind' = 'interval'
          AND (canonical_definition -> 'execution' -> 'schedule' ->> 'everySeconds') ~ '^[1-9][0-9]{1,8}$'
          AND (canonical_definition -> 'execution' -> 'schedule' ->> 'everySeconds')::bigint BETWEEN 60 AND 31536000
        )
      )
    )
  )
  AND pg_catalog.jsonb_typeof(canonical_definition -> 'enabled') = 'boolean'
  AND (canonical_definition ->> 'severity') IN ('low', 'medium', 'high', 'critical')
  AND pg_catalog.jsonb_typeof(canonical_definition -> 'operations') = 'array'
  AND pg_catalog.jsonb_array_length(canonical_definition -> 'operations') BETWEEN 1 AND 16
);
--> statement-breakpoint

SELECT public.forge_begin_epic_172_s4_owner_bootstrap_v1();
--> statement-breakpoint
SET ROLE forge_s4_routines_owner;
--> statement-breakpoint
ALTER TABLE public.verification_goal_registry_revisions
ADD COLUMN manifest_schema_version integer NOT NULL DEFAULT 1;
--> statement-breakpoint
ALTER TABLE public.verification_goal_registry_revisions
ADD CONSTRAINT verification_goal_registry_revisions_manifest_schema_check
CHECK (manifest_schema_version IN (1, 2));
--> statement-breakpoint
ALTER TABLE public.verification_goal_registry_entries
ADD COLUMN entry_schema_version integer NOT NULL DEFAULT 1;
--> statement-breakpoint
ALTER TABLE public.verification_goal_registry_entries
ADD COLUMN execution_binding jsonb;
--> statement-breakpoint
ALTER TABLE public.verification_goal_registry_entries
ADD COLUMN execution_binding_digest text;
--> statement-breakpoint
ALTER TABLE public.verification_goal_registry_entries
ADD CONSTRAINT verification_goal_registry_entries_schema_binding_check CHECK (
  (
    entry_schema_version = 1
    AND execution_binding IS NULL
    AND execution_binding_digest IS NULL
  ) OR (
    entry_schema_version = 2
    AND pg_catalog.jsonb_typeof(execution_binding) = 'object'
    AND pg_catalog.octet_length(execution_binding::text) <= 32768
    AND execution_binding_digest ~ '^[0-9a-f]{64}$'
    AND execution_binding ->> 'executionBindingDigest' = execution_binding_digest
    AND execution_binding ->> 'schemaVersion' = '1'
    AND execution_binding ->> 'eligibilityPolicyVersion' = '1'
    AND pg_catalog.jsonb_typeof(execution_binding -> 'operations') = 'array'
    AND pg_catalog.jsonb_array_length(execution_binding -> 'operations') BETWEEN 1 AND 16
  )
);
--> statement-breakpoint

CREATE FUNCTION public.forge_commit_verification_goal_registry_revision_v2(
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
  p_manifest_schema_version integer,
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
  v_entry_schema_version integer;
  v_execution_binding jsonb;
  v_execution_binding_digest text;
  v_previous_goal_id text;
  v_payload bytea := pg_catalog.convert_to(
    'forge:verification-goal:registry-manifest:v2', 'UTF8'
  ) || pg_catalog.decode('00', 'hex');
  v_stored_payload bytea := pg_catalog.convert_to(
    'forge:verification-goal:registry-manifest:v2', 'UTF8'
  ) || pg_catalog.decode('00', 'hex');
  v_scalar text;
  v_computed_digest text;
  v_current_exact boolean := false;
  v_current_identity_matches boolean := false;
  v_new_revision_id uuid;
  v_new_sequence bigint;
  v_affected integer;
BEGIN
  IF p_manifest_schema_version = 1 THEN
    RETURN QUERY
    SELECT committed.registry_revision_id, committed.revision_sequence, committed.head_state
    FROM public.forge_commit_verification_goal_registry_revision_v1(
      p_project_id,
      p_application_asserted_actor_user_id,
      p_expected_prior_revision_id,
      p_expected_submitted_by,
      p_expected_archived_at,
      p_expected_local_path,
      p_expected_root_ref,
      p_expected_root_binding_revision,
      p_expected_grant_decision_revision,
      p_expected_project_revision,
      p_manifest_digest,
      p_entries
    ) committed;
    RETURN;
  END IF;

  IF p_manifest_schema_version <> 2 THEN
    RAISE EXCEPTION 'verification goal registry manifest version is unsupported'
      USING ERRCODE = '22023';
  END IF;
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
     OR pg_catalog.octet_length(p_entries::text) > 196608
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
       OR (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(v_entry)) <> 8
       OR NOT (v_entry ?& ARRAY[
         'snapshotId', 'goalId', 'definitionVersion', 'definitionDigest', 'sourcePath',
         'entrySchemaVersion', 'executionBinding', 'executionBindingDigest'
       ])
       OR pg_catalog.jsonb_typeof(v_entry -> 'snapshotId') <> 'string'
       OR pg_catalog.jsonb_typeof(v_entry -> 'goalId') <> 'string'
       OR pg_catalog.jsonb_typeof(v_entry -> 'definitionVersion') <> 'number'
       OR pg_catalog.jsonb_typeof(v_entry -> 'definitionDigest') <> 'string'
       OR pg_catalog.jsonb_typeof(v_entry -> 'sourcePath') <> 'string'
       OR pg_catalog.jsonb_typeof(v_entry -> 'entrySchemaVersion') <> 'number'
       OR (v_entry ->> 'snapshotId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       OR (v_entry ->> 'goalId') !~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$'
       OR pg_catalog.length(v_entry ->> 'goalId') > 64
       OR (v_entry ->> 'definitionVersion') !~ '^[1-9][0-9]{0,6}$'
       OR (v_entry ->> 'definitionVersion')::bigint > 1000000
       OR (v_entry ->> 'definitionDigest') !~ '^[0-9a-f]{64}$'
       OR pg_catalog.length(v_entry ->> 'sourcePath') > 256
       OR (v_entry ->> 'sourcePath') !~ '^\.forge/verification-goals/[A-Za-z0-9][A-Za-z0-9._-]{0,126}\.json$'
       OR (v_entry ->> 'entrySchemaVersion') NOT IN ('1', '2') THEN
      RAISE EXCEPTION 'verification goal registry entry is malformed'
        USING ERRCODE = '22023';
    END IF;

    v_snapshot_id := (v_entry ->> 'snapshotId')::uuid;
    v_goal_id := v_entry ->> 'goalId';
    v_definition_version := (v_entry ->> 'definitionVersion')::integer;
    v_definition_digest := v_entry ->> 'definitionDigest';
    v_source_path := v_entry ->> 'sourcePath';
    v_entry_schema_version := (v_entry ->> 'entrySchemaVersion')::integer;
    v_execution_binding := v_entry -> 'executionBinding';
    v_execution_binding_digest := NULLIF(v_entry ->> 'executionBindingDigest', '');

    IF v_entry_schema_version = 1 THEN
      IF v_execution_binding <> 'null'::jsonb OR v_execution_binding_digest IS NOT NULL THEN
        RAISE EXCEPTION 'definition-only verification goal cannot carry an execution binding'
          USING ERRCODE = '22023';
      END IF;
      v_execution_binding := NULL;
    ELSE
      IF pg_catalog.jsonb_typeof(v_execution_binding) <> 'object'
         OR pg_catalog.octet_length(v_execution_binding::text) > 32768
         OR v_execution_binding_digest !~ '^[0-9a-f]{64}$'
         OR v_execution_binding ->> 'executionBindingDigest' IS DISTINCT FROM v_execution_binding_digest
         OR v_execution_binding ->> 'schemaVersion' IS DISTINCT FROM '1'
         OR v_execution_binding ->> 'eligibilityPolicyVersion' IS DISTINCT FROM '1'
         OR pg_catalog.jsonb_typeof(v_execution_binding -> 'operations') <> 'array'
         OR pg_catalog.jsonb_array_length(v_execution_binding -> 'operations') NOT BETWEEN 1 AND 16 THEN
        RAISE EXCEPTION 'executable verification goal binding is malformed'
          USING ERRCODE = '22023';
      END IF;
    END IF;

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
      AND snapshot.definition_digest = v_definition_digest
      AND snapshot.canonical_definition ->> 'schemaVersion' = v_entry_schema_version::text;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'verification goal registry entry does not match a project snapshot'
        USING ERRCODE = '22023';
    END IF;

    FOREACH v_scalar IN ARRAY ARRAY[
      v_goal_id,
      v_definition_version::text,
      v_definition_digest,
      v_source_path,
      v_entry_schema_version::text,
      COALESCE(v_execution_binding_digest, '')
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
        AND revision.manifest_schema_version = 2
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
             OR stored.entry_schema_version IS DISTINCT FROM (supplied.value ->> 'entrySchemaVersion')::integer
             OR stored.execution_binding IS DISTINCT FROM NULLIF(supplied.value -> 'executionBinding', 'null'::jsonb)
             OR stored.execution_binding_digest IS DISTINCT FROM NULLIF(supplied.value ->> 'executionBindingDigest', '')
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
    project_id, revision_sequence, manifest_schema_version, manifest_digest,
    application_asserted_actor_user_id, project_submitted_by, project_archived_at,
    project_local_path, root_ref, root_binding_revision, grant_decision_revision,
    project_revision, predecessor_revision_id
  ) VALUES (
    p_project_id, v_new_sequence, 2, p_manifest_digest,
    p_application_asserted_actor_user_id, p_expected_submitted_by,
    p_expected_archived_at, p_expected_local_path, p_expected_root_ref,
    p_expected_root_binding_revision, p_expected_grant_decision_revision,
    p_expected_project_revision, v_head.registry_revision_id
  ) RETURNING id INTO v_new_revision_id;

  v_ordinal := 0;
  FOR v_entry IN
    SELECT item.value
    FROM pg_catalog.jsonb_array_elements(p_entries) WITH ORDINALITY AS item(value, ordinal)
    ORDER BY item.ordinal
  LOOP
    INSERT INTO public.verification_goal_registry_entries (
      registry_revision_id, project_id, ordinal, snapshot_id, goal_id,
      definition_version, definition_digest, source_path, entry_schema_version,
      execution_binding, execution_binding_digest
    ) VALUES (
      v_new_revision_id, p_project_id, v_ordinal,
      (v_entry ->> 'snapshotId')::uuid, v_entry ->> 'goalId',
      (v_entry ->> 'definitionVersion')::integer,
      v_entry ->> 'definitionDigest', v_entry ->> 'sourcePath',
      (v_entry ->> 'entrySchemaVersion')::integer,
      NULLIF(v_entry -> 'executionBinding', 'null'::jsonb),
      NULLIF(v_entry ->> 'executionBindingDigest', '')
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
    SELECT stored.goal_id, stored.definition_version, stored.definition_digest,
      stored.source_path, stored.entry_schema_version, stored.execution_binding_digest
    FROM public.verification_goal_registry_entries stored
    WHERE stored.registry_revision_id = v_new_revision_id
    ORDER BY stored.ordinal
  LOOP
    FOREACH v_scalar IN ARRAY ARRAY[
      v_stored_entry.goal_id,
      v_stored_entry.definition_version::text,
      v_stored_entry.definition_digest,
      v_stored_entry.source_path,
      v_stored_entry.entry_schema_version::text,
      COALESCE(v_stored_entry.execution_binding_digest, '')
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

ALTER FUNCTION public.forge_commit_verification_goal_registry_revision_v2(
  uuid,uuid,uuid,uuid,timestamptz,text,uuid,bigint,bigint,timestamptz,integer,text,jsonb
) OWNER TO forge_s4_routines_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.forge_commit_verification_goal_registry_revision_v2(
  uuid,uuid,uuid,uuid,timestamptz,text,uuid,bigint,bigint,timestamptz,integer,text,jsonb
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.forge_commit_verification_goal_registry_revision_v2(
  uuid,uuid,uuid,uuid,timestamptz,text,uuid,bigint,bigint,timestamptz,integer,text,jsonb
) TO forge;
--> statement-breakpoint
RESET ROLE;
--> statement-breakpoint
SELECT public.forge_finalize_epic_172_s4_owner_bootstrap_v1();
