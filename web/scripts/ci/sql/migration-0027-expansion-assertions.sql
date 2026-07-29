SELECT pg_catalog.set_config('forge.fixture_migration_principal', :'migration_principal', false);

DO $assertions$
DECLARE
  migration_principal name := current_setting('forge.fixture_migration_principal')::name;
  archive_routine oid;
  archive_routines oid[];
  protected_caller name;
BEGIN
  IF pg_catalog.to_regclass('public.epic_172_s4_protocol_state') IS NOT NULL THEN
    RAISE EXCEPTION '0027 created a competing S4 protocol authority';
  END IF;
  -- role.rolpassword IS NULL is verified by the administrator-only S4
  -- bootstrap; pg_roles intentionally masks it from this ordinary migration
  -- proof. This block verifies every attribute visible to the ordinary login.
  IF NOT EXISTS (
    SELECT 1 FROM drizzle.__drizzle_migrations
    WHERE created_at = 1784270400000
  ) OR (SELECT count(*) FROM drizzle.__drizzle_migrations) <> 28 THEN
    RAISE EXCEPTION 'The normal migrator did not record the exact ordered prefix through 0027';
  END IF;

  IF (SELECT attnotnull FROM pg_catalog.pg_attribute
      WHERE attrelid = 'public.projects'::pg_catalog.regclass AND attname = 'root_ref')
     OR pg_catalog.pg_get_expr(
       (SELECT adbin FROM pg_catalog.pg_attrdef
        WHERE adrelid = 'public.projects'::pg_catalog.regclass
          AND adnum = (SELECT attnum FROM pg_catalog.pg_attribute
                       WHERE attrelid = 'public.projects'::pg_catalog.regclass AND attname = 'root_ref')),
       'public.projects'::pg_catalog.regclass
     ) NOT LIKE '%gen_random_uuid%'
  THEN
    RAISE EXCEPTION '0027 did not preserve nullable expansion with the omitted-value default';
  END IF;

  IF (SELECT attnotnull FROM pg_catalog.pg_attribute
      WHERE attrelid = 'public.sessions'::pg_catalog.regclass
        AND attname = 'credential_digest_v1')
     OR (SELECT attnotnull FROM pg_catalog.pg_attribute
         WHERE attrelid = 'public.sessions'::pg_catalog.regclass
           AND attname = 'expires_at')
     OR NOT EXISTS (
       SELECT 1 FROM public.sessions
       WHERE id = '27000000-0000-4000-8000-000000000099'
         AND credential_storage_version = 0
         AND credential_digest_v1 IS NULL
         AND expires_at IS NULL
     )
     OR NOT EXISTS (
       SELECT 1 FROM public.session_credential_reconciliation
       WHERE singleton AND state = 'expansion'
     ) THEN
    RAISE EXCEPTION '0027 did not preserve the additive legacy-session expansion state';
  END IF;

  IF (SELECT count(*) FROM public.projects
      WHERE id IN ('27000000-0000-4000-8000-000000000010', '27000000-0000-4000-8000-000000000020')
        AND root_ref IS NULL) <> 2 THEN
    RAISE EXCEPTION '0027 rewrote or skipped a legacy fixture root_ref';
  END IF;

  UPDATE public.projects SET name = name || ' retained'
  WHERE id = '27000000-0000-4000-8000-000000000010';

  INSERT INTO public.projects (id, name, submitted_by)
  VALUES ('27000000-0000-4000-8000-000000000030', 'Omitted root', '27000000-0000-4000-8000-000000000001');
  INSERT INTO public.projects (id, name, submitted_by, root_ref)
  VALUES ('27000000-0000-4000-8000-000000000040', 'Explicit null root', '27000000-0000-4000-8000-000000000001', NULL);
  IF EXISTS (
    SELECT 1 FROM public.projects
    WHERE id IN ('27000000-0000-4000-8000-000000000030', '27000000-0000-4000-8000-000000000040')
      AND root_ref IS NULL
  ) THEN
    RAISE EXCEPTION 'The root_ref default or explicit-null insert bridge failed';
  END IF;

  UPDATE public.projects SET root_ref = pg_catalog.gen_random_uuid()
  WHERE id = '27000000-0000-4000-8000-000000000010';
  BEGIN
    UPDATE public.projects SET root_ref = NULL
    WHERE id = '27000000-0000-4000-8000-000000000010';
    RAISE EXCEPTION 'The root_ref re-null guard accepted a populated-to-null update';
  EXCEPTION WHEN not_null_violation THEN
    NULL;
  END;

  IF NOT pg_catalog.has_schema_privilege(migration_principal, 'forge', 'usage')
     OR pg_catalog.has_schema_privilege(migration_principal, 'forge', 'create')
     OR pg_catalog.pg_has_role(migration_principal, 'forge_s4_routines_owner', 'member')
     OR pg_catalog.has_function_privilege(
       migration_principal, 'public.forge_begin_epic_172_s4_owner_bootstrap_v1()', 'execute'
     )
     OR pg_catalog.has_function_privilege(
       migration_principal, 'public.forge_finalize_epic_172_s4_owner_bootstrap_v1()', 'execute'
     )
     OR NOT pg_catalog.has_function_privilege(
       migration_principal, 'forge.read_s4_runtime_mode_for_application_v1()', 'execute'
     ) THEN
    RAISE EXCEPTION '0027 left migration-scoped S4 authority behind';
  END IF;

  IF (SELECT rolcanlogin OR rolinherit OR rolsuper OR rolcreatedb OR rolcreaterole
             OR rolreplication OR rolbypassrls
      FROM pg_catalog.pg_roles WHERE rolname = 'forge_s4_routines_owner')
     OR pg_catalog.has_schema_privilege('forge_s4_routines_owner', 'forge', 'create')
     OR pg_catalog.has_schema_privilege('forge_s4_routines_owner', 'public', 'create') THEN
    RAISE EXCEPTION 'The finalized S4 NOLOGIN owner has an expanded attribute or schema privilege';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles role
    WHERE role.rolname = ANY (ARRAY[
      'forge_architect_plan_writer', 'forge_architect_plan_resolver',
      'forge_architect_plan_history_reader', 'forge_packet_issuer',
      'forge_review_source_resolver', 'forge_s4_recovery_operator',
      'forge_local_projection_archiver'
    ]) AND (NOT role.rolcanlogin OR role.rolinherit OR role.rolsuper OR role.rolcreatedb
      OR role.rolcreaterole OR role.rolreplication OR role.rolbypassrls)
  ) OR (SELECT count(*) FROM pg_catalog.pg_roles WHERE rolname = ANY (ARRAY[
      'forge_architect_plan_writer', 'forge_architect_plan_resolver',
      'forge_architect_plan_history_reader', 'forge_packet_issuer',
      'forge_review_source_resolver', 'forge_s4_recovery_operator',
      'forge_local_projection_archiver'
    ])) <> 7 THEN
    RAISE EXCEPTION 'A dedicated S4 login does not have the exact least-privilege attributes';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_auth_members membership
    WHERE membership.roleid = ANY (ARRAY[
      'forge_s4_routines_owner', 'forge_architect_plan_writer', 'forge_architect_plan_resolver',
      'forge_architect_plan_history_reader', 'forge_packet_issuer',
      'forge_review_source_resolver', 'forge_s4_recovery_operator',
      'forge_local_projection_archiver'
    ]::regrole[])
       OR membership.member = ANY (ARRAY[
      'forge_s4_routines_owner', 'forge_architect_plan_writer', 'forge_architect_plan_resolver',
      'forge_architect_plan_history_reader', 'forge_packet_issuer',
      'forge_review_source_resolver', 'forge_s4_recovery_operator',
      'forge_local_projection_archiver'
    ]::regrole[])
  ) THEN
    RAISE EXCEPTION 'A finalized S4 principal retains a membership edge';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_roles role
    WHERE role.rolname = 'forge_local_projection_archiver'
      AND role.rolcanlogin
      AND NOT role.rolinherit
      AND NOT role.rolsuper
      AND NOT role.rolcreatedb
      AND NOT role.rolcreaterole
      AND NOT role.rolreplication
      AND NOT role.rolbypassrls
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_db_role_setting setting
    WHERE setting.setrole = 'forge_local_projection_archiver'::pg_catalog.regrole
  ) THEN
    RAISE EXCEPTION 'The local-projection archiver login attributes, password, or role settings are expanded';
  END IF;

  IF NOT pg_catalog.has_schema_privilege('forge_local_projection_archiver', 'forge', 'usage')
     OR pg_catalog.has_schema_privilege('forge_local_projection_archiver', 'forge', 'create')
     OR pg_catalog.has_schema_privilege('forge_local_projection_archiver', 'public', 'create')
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_class relation
       JOIN pg_catalog.pg_namespace namespace_row ON namespace_row.oid = relation.relnamespace
       CROSS JOIN LATERAL pg_catalog.aclexplode(relation.relacl) acl
       WHERE namespace_row.nspname IN ('public', 'forge')
         AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
         AND acl.grantee = 'forge_local_projection_archiver'::pg_catalog.regrole
         AND acl.privilege_type = ANY (pg_catalog.string_to_array(
           'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER', ','
         ))
     ) OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_class sequence_row
       JOIN pg_catalog.pg_namespace namespace_row ON namespace_row.oid = sequence_row.relnamespace
       CROSS JOIN LATERAL pg_catalog.aclexplode(sequence_row.relacl) acl
       WHERE namespace_row.nspname IN ('public', 'forge')
         AND sequence_row.relkind = 'S'
         AND acl.grantee = 'forge_local_projection_archiver'::pg_catalog.regrole
         AND acl.privilege_type = ANY (pg_catalog.string_to_array('USAGE,SELECT,UPDATE', ','))
     ) THEN
    RAISE EXCEPTION 'The local-projection archiver has schema CREATE or direct relation access';
  END IF;

  archive_routines := ARRAY[
    pg_catalog.to_regprocedure('forge.inspect_local_projection_overlimit_v2(uuid)'),
    pg_catalog.to_regprocedure('forge.apply_local_projection_overlimit_archive_v2(uuid,uuid,uuid,text,text)'),
    pg_catalog.to_regprocedure('forge.resume_local_projection_overlimit_archive_v2(uuid,uuid,text)'),
    pg_catalog.to_regprocedure('forge.rollback_local_projection_overlimit_archive_v2(uuid,uuid,text)'),
    pg_catalog.to_regprocedure('forge.cancel_local_projection_overlimit_archive_v2(uuid,uuid,text)')
  ]::oid[];
  IF pg_catalog.array_position(archive_routines, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'One or more fixed local-projection archive routines are missing';
  END IF;

  FOREACH archive_routine IN ARRAY archive_routines LOOP
    IF NOT pg_catalog.has_function_privilege(
         'forge_local_projection_archiver', archive_routine, 'execute'
       ) OR EXISTS (
         SELECT 1
         FROM pg_catalog.pg_proc routine
         CROSS JOIN LATERAL pg_catalog.aclexplode(
           coalesce(routine.proacl, pg_catalog.acldefault('f', routine.proowner))
         ) acl
         WHERE routine.oid = archive_routine
           AND acl.grantee = 0
           AND acl.privilege_type = 'EXECUTE'
       ) THEN
      RAISE EXCEPTION 'An archive routine is not executable only through its fixed login';
    END IF;
    FOREACH protected_caller IN ARRAY ARRAY[
      'forge_architect_plan_writer',
      'forge_architect_plan_resolver',
      'forge_architect_plan_history_reader',
      'forge_packet_issuer',
      'forge_review_source_resolver',
      'forge_s4_recovery_operator'
    ]::name[] LOOP
      IF pg_catalog.has_function_privilege(protected_caller, archive_routine, 'execute') THEN
        RAISE EXCEPTION 'Protected S4 login % can execute a local-projection archive routine', protected_caller;
      END IF;
    END LOOP;
  END LOOP;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc routine
    JOIN pg_catalog.pg_namespace namespace_row ON namespace_row.oid = routine.pronamespace
    WHERE namespace_row.nspname = 'forge'
      AND routine.oid <> ALL (archive_routines)
      AND pg_catalog.has_function_privilege(
        'forge_local_projection_archiver', routine.oid, 'execute'
      )
  ) THEN
    RAISE EXCEPTION 'The local-projection archiver can execute a non-archive forge routine';
  END IF;

  IF NOT pg_catalog.has_function_privilege(
       'forge_architect_plan_history_reader',
       'forge.read_architect_plan_history_v1(bytea,uuid,bigint)', 'execute'
     ) OR pg_catalog.has_table_privilege(
       'forge_architect_plan_history_reader', 'public.architect_plan_entries', 'select'
     ) THEN
    RAISE EXCEPTION 'The history reader boundary is not execute-only';
  END IF;

  IF NOT pg_catalog.has_function_privilege(
       'forge_architect_plan_history_reader',
       'forge.append_mcp_operator_review_version_v1(bytea,uuid,bigint,integer,text,text,integer,integer,integer,text[],text[],text[],text[],text[],text[],text[],text[],boolean[])',
       'execute'
     ) OR NOT pg_catalog.has_function_privilege(
       'forge_architect_plan_history_reader',
       'forge.read_mcp_operator_review_history_v1(bytea,uuid,uuid,integer)',
       'execute'
     ) OR NOT pg_catalog.has_function_privilege(
       'forge_architect_plan_writer',
       'forge.register_package_plan_entries_v1(uuid,uuid,bigint,uuid[],text[],text[],integer[],text[],text[],text[])',
       'execute'
     ) OR NOT pg_catalog.has_function_privilege(
       'forge_architect_plan_history_reader',
       'forge.list_approved_package_plan_registrations_v1(bytea,uuid,bigint,integer,text)',
       'execute'
     ) OR NOT pg_catalog.has_function_privilege(
       'forge_packet_issuer', 'forge.bind_architect_plan_entry_v2(uuid,uuid)', 'execute'
     ) OR NOT pg_catalog.has_function_privilege(
       'forge_packet_issuer',
       'forge.finalize_s4_max_attempts_v1(uuid,uuid,timestamptz,integer)',
       'execute'
     ) THEN
    RAISE EXCEPTION 'A retained review, registration, binding, or finalization routine lacks its exact caller grant';
  END IF;

  IF NOT pg_catalog.has_table_privilege(
       'forge_s4_routines_owner', 'public.approval_gates', 'update'
     ) OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_trigger trigger_row
       WHERE trigger_row.tgrelid = 'public.approval_gates'::pg_catalog.regclass
         AND trigger_row.tgname = 'approval_gates_s4_review_head_guard'
         AND NOT trigger_row.tgisinternal
         AND (trigger_row.tgtype & 4) = 4
         AND (trigger_row.tgtype & 16) = 16
     ) THEN
    RAISE EXCEPTION 'The owner-managed protected review head write boundary is incomplete';
  END IF;

  IF pg_catalog.strpos(
       pg_catalog.pg_get_functiondef(
         'forge.append_mcp_operator_review_version_v1(bytea,uuid,bigint,integer,text,text,integer,integer,integer,text[],text[],text[],text[],text[],text[],text[],text[],boolean[])'::pg_catalog.regprocedure
       ), '''entryCount'''
     ) <> 0 THEN
    RAISE EXCEPTION 'The ordinary protected MCP review head exposes owner-only entry cardinality';
  END IF;
END;
$assertions$;
