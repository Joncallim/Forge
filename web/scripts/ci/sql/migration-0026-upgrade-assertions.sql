SELECT pg_catalog.set_config(
  'forge.fixture_migration_principal',
  :'migration_principal',
  false
);

DO $upgrade_assertions$
DECLARE
  migration_principal name := current_setting('forge.fixture_migration_principal')::name;
  expected_head_kinds text[] := ARRAY[
    'local_run', 'local_recovery', 'packet_recovery', 'repository_review',
    'host_apply_review', 'operator_hold', 'integrity', 'terminal_disposition'
  ];
  expected_head_indexes bigint[] := ARRAY[0, 1, 2, 3, 4, 5, 6, 7];
  projection_table text;
  projection_function regprocedure;
BEGIN
  IF (
    SELECT count(*) FILTER (WHERE created_at <= 1784266800000) <> 27
      OR count(*) FILTER (WHERE created_at = 1784266800000) <> 1
    FROM drizzle.__drizzle_migrations
  ) THEN
    RAISE EXCEPTION 'The normal migrator did not record the exact migration prefix through 0026';
  END IF;

  IF (
    SELECT jsonb_object_agg(id::text, jsonb_build_object(
      'state', local_projection_scope_state,
      'count', local_projection_overlimit_package_count
    ) ORDER BY id)
    FROM public.tasks
    WHERE id IN (
      '30000000-0000-4000-8000-000000000001',
      '30000000-0000-4000-8000-000000000002'
    )
  ) IS DISTINCT FROM '{
    "30000000-0000-4000-8000-000000000001":{"state":"active","count":null},
    "30000000-0000-4000-8000-000000000002":{"state":"archive_pending","count":257}
  }'::jsonb THEN
    RAISE EXCEPTION 'Legacy task projection-scope classification is incorrect';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.projects
    WHERE id IN (
      '20000000-0000-4000-8000-000000000001',
      '20000000-0000-4000-8000-000000000002'
    )
      AND (grant_decision_revision <> 0 OR root_binding_revision <> 0)
  ) OR (
    SELECT mcp_config
    FROM public.projects
    WHERE id = '20000000-0000-4000-8000-000000000001'
  ) IS DISTINCT FROM '{"profile":"custom","requiredMcps":["filesystem"],"overrides":{},"grants":{"filesystem":{"mode":"always_allow","root":"/legacy/active"}}}'::jsonb THEN
    RAISE EXCEPTION 'The upgrade changed legacy project grant metadata or invented a decision revision';
  END IF;

  IF (
    SELECT count(*) = 2
      AND bool_and(approval.project_id = task.project_id)
      AND bool_and(approval.decision_scope = 'package')
      AND bool_and(approval.grant_decision_revision IS NULL)
      AND bool_and(approval.root_binding_revision IS NULL)
      AND bool_and(approval.grant_nonce IS NULL)
      AND bool_and(approval.pointer_fingerprint IS NULL)
    FROM public.filesystem_mcp_grant_approvals approval
    JOIN public.tasks task ON task.id = approval.task_id
    WHERE approval.id IN (
      '50000000-0000-4000-8000-000000000001',
      '50000000-0000-4000-8000-000000000002'
    )
  ) IS NOT TRUE THEN
    RAISE EXCEPTION 'Legacy filesystem approvals were not backfilled as ambiguous package history';
  END IF;
  IF (
    SELECT effective_grant
    FROM public.filesystem_mcp_grant_approvals
    WHERE id = '50000000-0000-4000-8000-000000000001'
  ) IS DISTINCT FROM '{"mode":"always_allow","root":"/legacy/active","capabilities":["filesystem.project.read"]}'::jsonb THEN
    RAISE EXCEPTION 'The legacy effective grant payload was changed during the upgrade';
  END IF;

  IF (
    SELECT count(*)
    FROM public.filesystem_mcp_current_decision_pointers
  ) <> 259 OR EXISTS (
    SELECT 1
    FROM public.filesystem_mcp_current_decision_pointers pointer
    LEFT JOIN public.filesystem_mcp_grant_approvals approval
      ON approval.work_package_id = pointer.work_package_id
    WHERE pointer.current_decision_id IS NOT NULL
       OR pointer.current_decision_task_id IS NOT NULL
       OR pointer.current_decision_work_package_id IS NOT NULL
       OR pointer.current_decision_revision IS NOT NULL
       OR pointer.current_decision_fingerprint IS NOT NULL
       OR (
         approval.id IS NULL
         AND (
           pointer.pointer_version <> 0
           OR pointer.pointer_fingerprint <> 'empty:' || pointer.work_package_id::text
         )
       )
       OR (
         approval.id IS NOT NULL
         AND (
           pointer.pointer_version <> 1
           OR pointer.pointer_fingerprint <> 'legacy:' || approval.id::text
         )
       )
  ) THEN
    RAISE EXCEPTION 'Package decision pointers invented authority or lost an empty/legacy adapter';
  END IF;

  IF (
    SELECT count(*)
    FROM public.project_filesystem_current_decision_pointers
  ) <> 2 OR EXISTS (
    SELECT 1
    FROM public.project_filesystem_current_decision_pointers
    WHERE current_decision_id IS NOT NULL
       OR current_decision_project_id IS NOT NULL
       OR current_decision_revision IS NOT NULL
       OR current_root_binding_revision IS NOT NULL
       OR current_decision_fingerprint IS NOT NULL
       OR current_decision_generation IS NOT NULL
       OR pointer_generation <> 0
  ) THEN
    RAISE EXCEPTION 'Project decision pointers invented authority for legacy mcp_config grants';
  END IF;

  IF (
    SELECT count(*)
    FROM public.work_package_local_projection_heads
  ) <> 16 OR EXISTS (
    SELECT 1
    FROM public.work_packages package
    JOIN public.tasks task ON task.id = package.task_id
    LEFT JOIN public.work_package_local_projection_heads head
      ON head.work_package_id = package.id
    WHERE task.local_projection_scope_state = 'active'
    GROUP BY package.id
    HAVING count(head.id) <> 8
       OR array_agg(head.head_kind ORDER BY head.head_index) <> expected_head_kinds
       OR array_agg(head.head_index ORDER BY head.head_index) <> expected_head_indexes
  ) OR EXISTS (
    SELECT 1
    FROM public.work_package_local_projection_heads head
    JOIN public.tasks task ON task.id = head.task_id
    WHERE task.local_projection_scope_state <> 'active'
  ) OR EXISTS (
    SELECT 1
    FROM public.work_package_local_projection_heads
    WHERE head_revision <> 0
       OR current_source_id IS NOT NULL
       OR current_source_task_id IS NOT NULL
       OR current_source_work_package_id IS NOT NULL
       OR current_source_kind IS NOT NULL
       OR current_source_revision IS NOT NULL
       OR current_source_fingerprint IS NOT NULL
       OR contribution <> '{}'::jsonb
       OR compare_and_set_fingerprint <> head_fingerprint
       OR head_fingerprint <> (
         'head:v1:' || task_id::text || ':' || work_package_id::text || ':'
         || head_kind || ':' || head_index::text
       )
  ) OR EXISTS (SELECT 1 FROM public.work_package_local_projection_sources) THEN
    RAISE EXCEPTION 'The migration did not create exactly eight empty heads only for active legacy packages';
  END IF;

  IF (
    SELECT metadata
    FROM public.work_packages
    WHERE id = '40000000-0000-4000-8000-000000000001'
  ) IS DISTINCT FROM '{"fixture":"active-approved","mcpGrantBlock":{"schemaVersion":1,"kind":"filesystem_grant","source":"filesystem-grant-approval","freeform":"retained"}}'::jsonb OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.work_packages'::regclass
      AND conname = 'work_packages_filesystem_grant_hold_v2_check'
      AND convalidated
  ) THEN
    RAISE EXCEPTION 'The legacy marker was not retained under a validated version-2 marker constraint';
  END IF;

  BEGIN
    UPDATE public.work_packages
    SET status = 'blocked', metadata = jsonb_build_object(
      'mcpGrantBlock', jsonb_build_object('schemaVersion', 2, 'kind', 'filesystem_grant')
    )
    WHERE id = '40000000-0000-4000-8000-000000000002';
    RAISE EXCEPTION 'The version-2 marker constraint accepted a partial marker';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;

  FOREACH projection_table IN ARRAY ARRAY[
    'work_package_local_projection_sources',
    'work_package_local_projection_heads'
  ] LOOP
    IF (
      SELECT tableowner <> 'forge_release_routines_owner'
      FROM pg_catalog.pg_tables
      WHERE schemaname = 'public' AND tablename = projection_table
    ) IS NOT FALSE OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class table_row,
        LATERAL pg_catalog.aclexplode(
          coalesce(table_row.relacl, pg_catalog.acldefault('r', table_row.relowner))
        ) acl
      WHERE table_row.oid = ('public.' || projection_table)::regclass
        AND acl.grantee <> table_row.relowner
    ) OR pg_catalog.has_table_privilege(migration_principal, 'public.' || projection_table, 'SELECT')
      OR pg_catalog.has_table_privilege(migration_principal, 'public.' || projection_table, 'INSERT')
      OR pg_catalog.has_table_privilege(migration_principal, 'public.' || projection_table, 'UPDATE')
      OR pg_catalog.has_table_privilege(migration_principal, 'public.' || projection_table, 'DELETE') THEN
      RAISE EXCEPTION 'Projection table % is outside its exact owner/ACL boundary', projection_table;
    END IF;
  END LOOP;

  FOREACH projection_function IN ARRAY ARRAY[
    'forge.guard_local_projection_package_limit_v1()'::regprocedure,
    'forge.preallocate_local_projection_heads_v1()'::regprocedure,
    'forge.reject_projection_source_mutation_v1()'::regprocedure,
    'forge.reject_projection_head_mutation_v1()'::regprocedure,
    'forge.advance_local_projection_head_v1(uuid,uuid,text,uuid,bigint,text,jsonb,bigint,text,text)'::regprocedure
  ] LOOP
    IF (
      SELECT proowner <> 'forge_release_routines_owner'::regrole
        OR NOT prosecdef
        OR proconfig <> ARRAY['search_path=""']
      FROM pg_catalog.pg_proc
      WHERE oid = projection_function
    ) IS NOT FALSE OR pg_catalog.has_function_privilege('public', projection_function, 'EXECUTE') THEN
      RAISE EXCEPTION 'Projection function % is outside its exact owner/ACL boundary', projection_function;
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_auth_members membership
    WHERE membership.roleid = 'forge_release_routines_owner'::regrole
       OR membership.member = 'forge_release_routines_owner'::regrole
  ) OR pg_catalog.has_function_privilege(
    migration_principal,
    'public.forge_begin_epic_172_s3_owner_bootstrap_v1()'::regprocedure,
    'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    migration_principal,
    'public.forge_finalize_epic_172_s3_owner_bootstrap_v1()'::regprocedure,
    'EXECUTE'
  ) OR NOT pg_catalog.has_column_privilege(
    'forge_release_routines_owner', 'public.tasks', 'local_projection_scope_state', 'SELECT'
  ) OR NOT pg_catalog.has_column_privilege(
    'forge_release_routines_owner', 'public.work_packages', 'task_id', 'SELECT'
  ) OR pg_catalog.has_table_privilege(
    'forge_release_routines_owner', 'public.tasks', 'SELECT'
  ) OR pg_catalog.has_table_privilege(
    'forge_release_routines_owner', 'public.work_packages', 'SELECT'
  ) THEN
    RAISE EXCEPTION 'The versioned S3 owner handoff left an expanded migration or source-table ACL';
  END IF;

  IF (
    SELECT row_to_json(state_row)::jsonb
    FROM (
      SELECT singleton_id, state, state_fingerprint, predecessor_receipt_id,
        authorization_id, evidence_receipt_id, transition_identity_digest, completed_at
      FROM public.forge_epic_172_s3_release_state
    ) state_row
  ) IS DISTINCT FROM '{
    "singleton_id":"s3_issue_178",
    "state":"pending",
    "state_fingerprint":"7a97eed28629c7d0d7c11a48d3509f1c479d614882dc61a7e2c1891f32c3a5dc",
    "predecessor_receipt_id":null,
    "authorization_id":null,
    "evidence_receipt_id":null,
    "transition_identity_digest":null,
    "completed_at":null
  }'::jsonb THEN
    RAISE EXCEPTION 'The S3 release marker is not the exact pending singleton';
  END IF;
END;
$upgrade_assertions$;
