SELECT pg_catalog.set_config('forge.fixture_migration_principal', :'migration_principal', false);

DO $assertions$
DECLARE
  migration_principal name := current_setting('forge.fixture_migration_principal')::name;
BEGIN
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

  IF pg_catalog.has_schema_privilege(migration_principal, 'forge', 'usage')
     OR pg_catalog.has_schema_privilege(migration_principal, 'forge', 'create')
     OR pg_catalog.pg_has_role(migration_principal, 'forge_s4_routines_owner', 'member')
     OR pg_catalog.has_function_privilege(
       migration_principal, 'public.forge_begin_epic_172_s4_owner_bootstrap_v1()', 'execute'
     )
     OR pg_catalog.has_function_privilege(
       migration_principal, 'public.forge_finalize_epic_172_s4_owner_bootstrap_v1()', 'execute'
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
      'forge_architect_plan_history_reader', 'forge_packet_issuer'
    ]) AND (NOT role.rolcanlogin OR role.rolinherit OR role.rolsuper OR role.rolcreatedb
      OR role.rolcreaterole OR role.rolreplication OR role.rolbypassrls)
  ) OR (SELECT count(*) FROM pg_catalog.pg_roles WHERE rolname = ANY (ARRAY[
      'forge_architect_plan_writer', 'forge_architect_plan_resolver',
      'forge_architect_plan_history_reader', 'forge_packet_issuer'
    ])) <> 4 THEN
    RAISE EXCEPTION 'A dedicated S4 login does not have the exact least-privilege attributes';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_auth_members membership
    WHERE membership.roleid = ANY (ARRAY[
      'forge_s4_routines_owner', 'forge_architect_plan_writer', 'forge_architect_plan_resolver',
      'forge_architect_plan_history_reader', 'forge_packet_issuer'
    ]::regrole[])
       OR membership.member = ANY (ARRAY[
      'forge_s4_routines_owner', 'forge_architect_plan_writer', 'forge_architect_plan_resolver',
      'forge_architect_plan_history_reader', 'forge_packet_issuer'
    ]::regrole[])
  ) THEN
    RAISE EXCEPTION 'A finalized S4 principal retains a membership edge';
  END IF;

  IF NOT pg_catalog.has_function_privilege(
       'forge_architect_plan_history_reader',
       'forge.read_architect_plan_history_v1(bytea,uuid,bigint)', 'execute'
     ) OR pg_catalog.has_table_privilege(
       'forge_architect_plan_history_reader', 'public.architect_plan_entries', 'select'
     ) THEN
    RAISE EXCEPTION 'The history reader boundary is not execute-only';
  END IF;
END;
$assertions$;
