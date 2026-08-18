BEGIN;

-- Keep role classification and mutation in one critical section. PostgreSQL's
-- ALTER ROLE and GRANT/REVOKE ROLE paths take conflicting table locks.
SET LOCAL application_name = 'forge-shared-app-privilege-reconciliation';
LOCK TABLE pg_catalog.pg_authid IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE pg_catalog.pg_auth_members IN SHARE ROW EXCLUSIVE MODE;

CREATE TEMPORARY TABLE forge_expected_protected_owner_inventory (
  relation_name name PRIMARY KEY,
  owner_name name NOT NULL
) ON COMMIT DROP;

-- canonical-protected-owner-map-begin
INSERT INTO forge_expected_protected_owner_inventory (relation_name, owner_name) VALUES
  ('forge_epic_172_enablement_state', 'forge_release_routines_owner'),
  ('forge_epic_172_enablement_transition_audits', 'forge_release_routines_owner'),
  ('forge_epic_172_release_evidence', 'forge_release_routines_owner'),
  ('forge_epic_172_release_evidence_consumptions', 'forge_release_routines_owner'),
  ('forge_epic_172_transition_authorizations', 'forge_release_routines_owner'),
  ('forge_release_signer_key_lifecycle_audits', 'forge_release_routines_owner'),
  ('forge_release_signer_keys', 'forge_release_routines_owner'),
  ('forge_epic_172_s3_release_state', 'forge_release_routines_owner'),
  ('work_package_local_projection_sources', 'forge_release_routines_owner'),
  ('work_package_local_projection_heads', 'forge_release_routines_owner'),
  ('verification_goal_registry_revisions', 'forge_s4_routines_owner'),
  ('verification_goal_registry_entries', 'forge_s4_routines_owner'),
  ('verification_goal_registry_heads', 'forge_s4_routines_owner'),
  ('verification_goal_policy_revisions', 'forge_s4_routines_owner'),
  ('verification_goal_policy_heads', 'forge_s4_routines_owner'),
  ('verification_goal_runs', 'forge_s4_routines_owner'),
  ('verification_goal_events', 'forge_s4_routines_owner'),
  ('verification_goal_repository_snapshots', 'forge_s4_routines_owner'),
  ('verification_goal_environment_snapshots', 'forge_s4_routines_owner'),
  ('verification_goal_schedule_bindings', 'forge_s4_routines_owner'),
  ('verification_goal_schedule_heads', 'forge_s4_routines_owner'),
  ('verification_goal_schedule_slots', 'forge_s4_routines_owner'),
  ('architect_plan_versions', 'forge_s4_routines_owner'),
  ('architect_plan_entries', 'forge_s4_routines_owner'),
  ('architect_plan_execution_references', 'forge_s4_routines_owner'),
  ('architect_plan_history_reads', 'forge_s4_routines_owner'),
  ('architect_clarification_answers', 'forge_s4_routines_owner'),
  ('architect_clarification_answer_writes', 'forge_s4_routines_owner'),
  ('protected_package_entry_registrations', 'forge_s4_routines_owner'),
  ('protected_entry_capability_bindings', 'forge_s4_routines_owner'),
  ('mcp_operator_review_versions', 'forge_s4_routines_owner'),
  ('mcp_operator_review_entries', 'forge_s4_routines_owner'),
  ('work_package_local_run_evidence', 'forge_s4_routines_owner'),
  ('filesystem_mcp_decision_nonce_claims', 'forge_s4_routines_owner'),
  ('project_root_ref_reconciliation', 'forge_s4_routines_owner'),
  ('project_root_change_journal_counter', 'forge_s4_routines_owner'),
  ('project_root_change_journal', 'forge_s4_routines_owner'),
  ('project_root_reconciliation_operations', 'forge_s4_routines_owner'),
  ('project_root_reconciliation_checkpoints', 'forge_s4_routines_owner'),
  ('project_root_reconciliation_outcomes', 'forge_s4_routines_owner'),
  ('project_root_reconciliation_write_contexts', 'forge_s4_routines_owner'),
  ('s4_completion_handoffs', 'forge_s4_routines_owner'),
  ('s4_protected_review_sources', 'forge_s4_routines_owner'),
  ('s4_protected_review_source_reads', 'forge_s4_routines_owner'),
  ('s4_max_attempt_finalizations', 'forge_s4_routines_owner'),
  ('filesystem_mcp_issuance_recovery_actions', 'forge_s4_routines_owner'),
  ('local_effect_recovery_actions', 'forge_s4_routines_owner'),
  ('local_projection_archive_operations', 'forge_s4_routines_owner'),
  ('local_projection_archive_operation_checkpoints', 'forge_s4_routines_owner');
-- canonical-protected-owner-map-end

DO $boundary$
DECLARE
  protected_count integer;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_roles role_row
    WHERE role_row.rolname = 'forge'
      AND role_row.rolcanlogin
      AND NOT role_row.rolsuper
      AND NOT role_row.rolcreatedb
      AND NOT role_row.rolcreaterole
      AND NOT role_row.rolreplication
      AND NOT role_row.rolbypassrls
  ) THEN
    RAISE EXCEPTION 'forge app role is not a safe or known legacy login';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_auth_members membership
    WHERE membership.roleid = 'forge'::pg_catalog.regrole
       OR membership.member = 'forge'::pg_catalog.regrole
  ) THEN
    RAISE EXCEPTION 'forge app role has membership edges';
  END IF;
  IF (
    SELECT count(*)
    FROM pg_catalog.pg_authid role_row
    WHERE role_row.rolname IN ('forge_release_routines_owner', 'forge_s4_routines_owner')
      AND NOT role_row.rolcanlogin
      AND NOT role_row.rolinherit
      AND NOT role_row.rolsuper
      AND NOT role_row.rolcreatedb
      AND NOT role_row.rolcreaterole
      AND NOT role_row.rolreplication
      AND NOT role_row.rolbypassrls
      AND role_row.rolconnlimit = -1
      AND role_row.rolpassword IS NULL
      AND role_row.rolvaliduntil IS NULL
  ) <> 2 OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_auth_members membership
    WHERE membership.roleid IN (
      'forge_release_routines_owner'::pg_catalog.regrole,
      'forge_s4_routines_owner'::pg_catalog.regrole
    ) OR membership.member IN (
      'forge_release_routines_owner'::pg_catalog.regrole,
      'forge_s4_routines_owner'::pg_catalog.regrole
    )
  ) THEN
    RAISE EXCEPTION 'protected owner roles are outside the exact safe boundary';
  END IF;
  IF (SELECT count(*) FROM forge_expected_protected_owner_inventory) <> 49 OR EXISTS (
    SELECT 1
    FROM forge_expected_protected_owner_inventory expected
    LEFT JOIN pg_catalog.pg_class relation
      ON relation.relnamespace = 'public'::pg_catalog.regnamespace
     AND relation.relname = expected.relation_name
     AND relation.relkind IN ('r', 'p')
    LEFT JOIN pg_catalog.pg_roles owner_role ON owner_role.oid = relation.relowner
    WHERE relation.oid IS NULL OR owner_role.rolname IS DISTINCT FROM expected.owner_name
  ) THEN
    RAISE EXCEPTION 'fixed protected owner inventory is incomplete or has ownership drift';
  END IF;
  SELECT count(*) INTO protected_count
  FROM pg_catalog.pg_class relation
  JOIN pg_catalog.pg_namespace namespace_row ON namespace_row.oid = relation.relnamespace
  JOIN pg_catalog.pg_roles owner_role ON owner_role.oid = relation.relowner
  WHERE namespace_row.nspname = 'public'
    AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
    AND owner_role.rolname IN ('forge_release_routines_owner', 'forge_s4_routines_owner');
  IF protected_count < 49 THEN
    RAISE EXCEPTION 'protected ownership boundary is incomplete';
  END IF;
END;
$boundary$;

ALTER ROLE forge NOINHERIT;

SELECT relation.oid, relation.relname
FROM pg_catalog.pg_class relation
JOIN pg_catalog.pg_namespace namespace_row ON namespace_row.oid = relation.relnamespace
JOIN pg_catalog.pg_roles owner_role ON owner_role.oid = relation.relowner
WHERE namespace_row.nspname = 'public'
  AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
  AND owner_role.rolname IN ('forge_release_routines_owner', 'forge_s4_routines_owner')
ORDER BY relation.oid
FOR UPDATE OF relation;

SELECT attribute.attrelid, attribute.attnum, attribute.attname
FROM pg_catalog.pg_attribute attribute
JOIN pg_catalog.pg_class relation ON relation.oid = attribute.attrelid
JOIN pg_catalog.pg_namespace namespace_row ON namespace_row.oid = relation.relnamespace
JOIN pg_catalog.pg_roles owner_role ON owner_role.oid = relation.relowner
WHERE namespace_row.nspname = 'public'
  AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
  AND owner_role.rolname IN ('forge_release_routines_owner', 'forge_s4_routines_owner')
  AND attribute.attnum > 0
  AND NOT attribute.attisdropped
ORDER BY attribute.attrelid, attribute.attnum
FOR UPDATE OF attribute;

GRANT USAGE, CREATE ON SCHEMA public TO forge;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO forge;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO forge;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO forge;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO forge;

-- Snapshots remain application-appended. Protected registry construction is
-- available only through its fixed SECURITY DEFINER routine.
REVOKE ALL PRIVILEGES ON TABLE
  public.verification_goal_snapshots,
  public.verification_goal_registry_revisions,
  public.verification_goal_registry_entries,
  public.verification_goal_registry_heads,
  public.verification_goal_policy_revisions,
  public.verification_goal_policy_heads,
  public.verification_goal_runs,
  public.verification_goal_events,
  public.verification_goal_repository_snapshots,
  public.verification_goal_environment_snapshots,
  public.verification_goal_schedule_bindings,
  public.verification_goal_schedule_heads,
  public.verification_goal_schedule_slots
FROM forge;
GRANT SELECT, INSERT ON TABLE public.verification_goal_snapshots TO forge;

DO $reconcile$
DECLARE
  protected_relation record;
  protected_columns text;
BEGIN
  FOR protected_relation IN
    SELECT namespace_row.nspname AS schema_name, relation.relname AS relation_name, relation.oid
    FROM pg_catalog.pg_class relation
    JOIN pg_catalog.pg_namespace namespace_row ON namespace_row.oid = relation.relnamespace
    JOIN pg_catalog.pg_roles owner_role ON owner_role.oid = relation.relowner
    WHERE namespace_row.nspname = 'public'
      AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
      AND owner_role.rolname IN ('forge_release_routines_owner', 'forge_s4_routines_owner')
    ORDER BY relation.oid
  LOOP
    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES ON TABLE %I.%I FROM forge',
      protected_relation.schema_name,
      protected_relation.relation_name
    );
    SELECT pg_catalog.string_agg(
      pg_catalog.format('%I', attribute.attname),
      ', ' ORDER BY attribute.attnum
    )
    INTO protected_columns
    FROM pg_catalog.pg_attribute attribute
    WHERE attribute.attrelid = protected_relation.oid
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped;
    IF protected_columns IS NOT NULL THEN
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES (%s) ON TABLE %I.%I FROM forge',
        protected_columns,
        protected_relation.schema_name,
        protected_relation.relation_name
      );
    END IF;
  END LOOP;
END;
$reconcile$;

GRANT SELECT ON TABLE
  public.work_package_local_projection_sources,
  public.work_package_local_projection_heads,
  public.verification_goal_registry_revisions,
  public.verification_goal_registry_entries,
  public.verification_goal_registry_heads,
  public.verification_goal_policy_revisions,
  public.verification_goal_policy_heads,
  public.verification_goal_runs,
  public.verification_goal_events,
  public.verification_goal_repository_snapshots,
  public.verification_goal_environment_snapshots,
  public.verification_goal_schedule_bindings,
  public.verification_goal_schedule_heads,
  public.verification_goal_schedule_slots
TO forge;
REVOKE ALL ON FUNCTION public.forge_commit_verification_goal_registry_revision_v1(
  uuid,uuid,uuid,uuid,timestamptz,text,uuid,bigint,bigint,timestamptz,text,jsonb
) FROM PUBLIC, forge;
GRANT EXECUTE ON FUNCTION public.forge_commit_verification_goal_registry_revision_v1(
  uuid,uuid,uuid,uuid,timestamptz,text,uuid,bigint,bigint,timestamptz,text,jsonb
) TO forge;
REVOKE ALL ON FUNCTION public.forge_commit_verification_goal_policy_revision_v1(
  uuid,uuid,uuid,bigint,boolean,boolean,bigint,bigint,bigint,integer,
  integer,integer,integer,bigint,bigint,text,uuid,text
) FROM PUBLIC, forge;
GRANT EXECUTE ON FUNCTION public.forge_commit_verification_goal_policy_revision_v1(
  uuid,uuid,uuid,bigint,boolean,boolean,bigint,bigint,bigint,integer,
  integer,integer,integer,bigint,bigint,text,uuid,text
) TO forge;
REVOKE ALL ON FUNCTION public.forge_claim_verification_goal_run_lease_v1(uuid, bigint, uuid, timestamptz)
  FROM PUBLIC, forge;
GRANT EXECUTE ON FUNCTION public.forge_claim_verification_goal_run_lease_v1(uuid, bigint, uuid, timestamptz)
  TO forge;
REVOKE ALL ON FUNCTION public.forge_begin_verification_goal_child_operation_v1(
  uuid,integer,text,integer,text,text,text,text,text,text,text,jsonb
) FROM PUBLIC, forge;
GRANT EXECUTE ON FUNCTION public.forge_begin_verification_goal_child_operation_v1(
  uuid,integer,text,integer,text,text,text,text,text,text,text,jsonb
) TO forge;
REVOKE ALL ON FUNCTION public.forge_terminalize_verification_goal_run_v1(
  uuid,text,text,uuid,text,text
) FROM PUBLIC, forge;
GRANT EXECUTE ON FUNCTION public.forge_terminalize_verification_goal_run_v1(
  uuid,text,text,uuid,text,text
) TO forge;

DO $verify$
DECLARE
  projection_name text;
BEGIN
  IF (SELECT count(*) FROM forge_expected_protected_owner_inventory) <> 49 OR EXISTS (
    SELECT 1
    FROM forge_expected_protected_owner_inventory expected
    LEFT JOIN pg_catalog.pg_class relation
      ON relation.relnamespace = 'public'::pg_catalog.regnamespace
     AND relation.relname = expected.relation_name
     AND relation.relkind IN ('r', 'p')
    LEFT JOIN pg_catalog.pg_roles owner_role ON owner_role.oid = relation.relowner
    WHERE relation.oid IS NULL OR owner_role.rolname IS DISTINCT FROM expected.owner_name
  ) THEN
    RAISE EXCEPTION 'fixed protected owner inventory changed during reconciliation';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_roles role_row
    WHERE role_row.rolname = 'forge'
      AND role_row.rolcanlogin
      AND NOT role_row.rolinherit
      AND NOT role_row.rolsuper
      AND NOT role_row.rolcreatedb
      AND NOT role_row.rolcreaterole
      AND NOT role_row.rolreplication
      AND NOT role_row.rolbypassrls
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_auth_members membership
    WHERE membership.roleid = 'forge'::pg_catalog.regrole
       OR membership.member = 'forge'::pg_catalog.regrole
  ) THEN
    RAISE EXCEPTION 'forge app role is outside the exact safe boundary';
  END IF;
  IF (
    SELECT count(*)
    FROM pg_catalog.pg_authid role_row
    WHERE role_row.rolname IN ('forge_release_routines_owner', 'forge_s4_routines_owner')
      AND NOT role_row.rolcanlogin
      AND NOT role_row.rolinherit
      AND NOT role_row.rolsuper
      AND NOT role_row.rolcreatedb
      AND NOT role_row.rolcreaterole
      AND NOT role_row.rolreplication
      AND NOT role_row.rolbypassrls
      AND role_row.rolconnlimit = -1
      AND role_row.rolpassword IS NULL
      AND role_row.rolvaliduntil IS NULL
  ) <> 2 OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_auth_members membership
    WHERE membership.roleid IN (
      'forge_release_routines_owner'::pg_catalog.regrole,
      'forge_s4_routines_owner'::pg_catalog.regrole
    ) OR membership.member IN (
      'forge_release_routines_owner'::pg_catalog.regrole,
      'forge_s4_routines_owner'::pg_catalog.regrole
    )
  ) THEN
    RAISE EXCEPTION 'protected owner roles changed during reconciliation';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc routine
    WHERE routine.oid = 'public.forge_commit_verification_goal_registry_revision_v1(uuid,uuid,uuid,uuid,timestamp with time zone,text,uuid,bigint,bigint,timestamp with time zone,text,jsonb)'::pg_catalog.regprocedure
      AND routine.proowner = 'forge_s4_routines_owner'::pg_catalog.regrole
      AND routine.prosecdef
      AND routine.proconfig = ARRAY['search_path=pg_catalog']
      AND pg_catalog.has_function_privilege('forge', routine.oid, 'EXECUTE')
      AND NOT EXISTS (
        SELECT 1
        FROM pg_catalog.aclexplode(
          COALESCE(routine.proacl, pg_catalog.acldefault('f', routine.proowner))
        ) privilege
        WHERE privilege.privilege_type = 'EXECUTE'
          AND privilege.grantee NOT IN (
            'forge'::pg_catalog.regrole,
            'forge_s4_routines_owner'::pg_catalog.regrole
          )
      )
  ) THEN
    RAISE EXCEPTION 'verification goal registry commit routine owner or execute boundary is invalid';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc routine
    WHERE routine.oid = 'public.forge_commit_verification_goal_policy_revision_v1(uuid,uuid,uuid,bigint,boolean,boolean,bigint,bigint,bigint,integer,integer,integer,integer,bigint,bigint,text,uuid,text)'::pg_catalog.regprocedure
      AND routine.proowner = 'forge_s4_routines_owner'::pg_catalog.regrole
      AND routine.prosecdef
      AND routine.proconfig = ARRAY['search_path=pg_catalog']
      AND pg_catalog.has_function_privilege('forge', routine.oid, 'EXECUTE')
      AND NOT EXISTS (
        SELECT 1
        FROM pg_catalog.aclexplode(
          COALESCE(routine.proacl, pg_catalog.acldefault('f', routine.proowner))
        ) privilege
        WHERE privilege.privilege_type = 'EXECUTE'
          AND privilege.grantee NOT IN (
            'forge'::pg_catalog.regrole,
            'forge_s4_routines_owner'::pg_catalog.regrole
          )
      )
  ) THEN
    RAISE EXCEPTION 'verification goal policy commit routine owner or execute boundary is invalid';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM unnest(ARRAY[
      'verification_goal_snapshots',
      'verification_goal_registry_revisions',
      'verification_goal_registry_entries',
      'verification_goal_registry_heads',
      'verification_goal_policy_revisions',
      'verification_goal_policy_heads',
      'verification_goal_runs',
      'verification_goal_events',
      'verification_goal_repository_snapshots',
      'verification_goal_environment_snapshots',
      'verification_goal_schedule_bindings',
      'verification_goal_schedule_heads',
      'verification_goal_schedule_slots'
    ]) registry_table
    CROSS JOIN unnest(ARRAY[
      'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'
    ]) registry_privilege
    WHERE pg_catalog.has_table_privilege(
      'forge',
      pg_catalog.format('public.%I', registry_table),
      registry_privilege
    ) IS DISTINCT FROM (
      registry_privilege = 'SELECT'
      OR (registry_table = 'verification_goal_snapshots' AND registry_privilege = 'INSERT')
    )
  ) THEN
    RAISE EXCEPTION 'forge verification goal registry privileges are outside the exact append-only matrix';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class relation
    JOIN pg_catalog.pg_namespace namespace_row ON namespace_row.oid = relation.relnamespace
    JOIN pg_catalog.pg_roles owner_role ON owner_role.oid = relation.relowner
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(relation.relacl, pg_catalog.acldefault('r', relation.relowner))
    ) privilege
    WHERE namespace_row.nspname = 'public'
      AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
      AND owner_role.rolname IN ('forge_release_routines_owner', 'forge_s4_routines_owner')
      AND privilege.grantee = 'forge'::pg_catalog.regrole
      AND (
        relation.relname NOT IN (
          'work_package_local_projection_sources',
          'work_package_local_projection_heads',
          'verification_goal_registry_revisions',
          'verification_goal_registry_entries',
          'verification_goal_registry_heads',
          'verification_goal_policy_revisions',
          'verification_goal_policy_heads',
          'verification_goal_runs',
          'verification_goal_events',
          'verification_goal_repository_snapshots',
          'verification_goal_environment_snapshots',
          'verification_goal_schedule_bindings',
          'verification_goal_schedule_heads',
          'verification_goal_schedule_slots'
        )
        OR privilege.privilege_type <> 'SELECT'
        OR privilege.is_grantable
        OR privilege.grantor <> relation.relowner
      )
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute attribute
    JOIN pg_catalog.pg_class relation ON relation.oid = attribute.attrelid
    JOIN pg_catalog.pg_namespace namespace_row ON namespace_row.oid = relation.relnamespace
    JOIN pg_catalog.pg_roles owner_role ON owner_role.oid = relation.relowner
    CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) privilege
    WHERE namespace_row.nspname = 'public'
      AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
      AND owner_role.rolname IN ('forge_release_routines_owner', 'forge_s4_routines_owner')
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND privilege.grantee = 'forge'::pg_catalog.regrole
  ) THEN
    RAISE EXCEPTION 'forge retained unexpected protected table or column authority';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class relation
    JOIN pg_catalog.pg_namespace namespace_row ON namespace_row.oid = relation.relnamespace
    JOIN pg_catalog.pg_roles owner_role ON owner_role.oid = relation.relowner
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(relation.relacl, pg_catalog.acldefault('r', relation.relowner))
    ) privilege
    WHERE namespace_row.nspname = 'public'
      AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
      AND owner_role.rolname IN ('forge_release_routines_owner', 'forge_s4_routines_owner')
      AND privilege.grantee = 0
      AND (
        relation.relname <> 'forge_epic_172_s3_release_state'
        OR privilege.privilege_type <> 'SELECT'
        OR privilege.is_grantable
        OR privilege.grantor <> relation.relowner
      )
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute attribute
    JOIN pg_catalog.pg_class relation ON relation.oid = attribute.attrelid
    JOIN pg_catalog.pg_namespace namespace_row ON namespace_row.oid = relation.relnamespace
    JOIN pg_catalog.pg_roles owner_role ON owner_role.oid = relation.relowner
    CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) privilege
    WHERE namespace_row.nspname = 'public'
      AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
      AND owner_role.rolname IN ('forge_release_routines_owner', 'forge_s4_routines_owner')
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND privilege.grantee = 0
  ) THEN
    RAISE EXCEPTION 'protected owner tables retained unexpected PUBLIC authority';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class relation
    JOIN pg_catalog.pg_namespace namespace_row ON namespace_row.oid = relation.relnamespace
    JOIN pg_catalog.pg_roles owner_role ON owner_role.oid = relation.relowner
    CROSS JOIN pg_catalog.pg_roles forge_role
    WHERE namespace_row.nspname = 'public'
      AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
      AND owner_role.rolname IN ('forge_release_routines_owner', 'forge_s4_routines_owner')
      AND forge_role.rolname = 'forge'
      AND (
        pg_catalog.has_table_privilege(forge_role.oid, relation.oid, 'INSERT')
        OR pg_catalog.has_table_privilege(forge_role.oid, relation.oid, 'UPDATE')
        OR pg_catalog.has_table_privilege(forge_role.oid, relation.oid, 'DELETE')
        OR pg_catalog.has_table_privilege(forge_role.oid, relation.oid, 'TRUNCATE')
        OR pg_catalog.has_table_privilege(forge_role.oid, relation.oid, 'REFERENCES')
        OR pg_catalog.has_table_privilege(forge_role.oid, relation.oid, 'TRIGGER')
        OR pg_catalog.has_any_column_privilege(forge_role.oid, relation.oid, 'INSERT')
        OR pg_catalog.has_any_column_privilege(forge_role.oid, relation.oid, 'UPDATE')
        OR pg_catalog.has_any_column_privilege(forge_role.oid, relation.oid, 'REFERENCES')
        OR (
          relation.relname NOT IN (
            'forge_epic_172_s3_release_state',
            'work_package_local_projection_sources',
            'work_package_local_projection_heads',
            'verification_goal_registry_revisions',
            'verification_goal_registry_entries',
            'verification_goal_registry_heads',
            'verification_goal_policy_revisions',
            'verification_goal_policy_heads',
            'verification_goal_runs',
            'verification_goal_events',
            'verification_goal_repository_snapshots',
            'verification_goal_environment_snapshots',
            'verification_goal_schedule_bindings',
            'verification_goal_schedule_heads',
            'verification_goal_schedule_slots'
          )
          AND (
            pg_catalog.has_table_privilege(forge_role.oid, relation.oid, 'SELECT')
            OR pg_catalog.has_any_column_privilege(forge_role.oid, relation.oid, 'SELECT')
          )
        )
      )
  ) THEN
    RAISE EXCEPTION 'forge retained effective protected table or column authority';
  END IF;
  FOREACH projection_name IN ARRAY ARRAY[
    'work_package_local_projection_sources',
    'work_package_local_projection_heads',
    'verification_goal_registry_revisions',
    'verification_goal_registry_entries',
    'verification_goal_registry_heads',
    'verification_goal_policy_revisions',
    'verification_goal_policy_heads',
    'verification_goal_runs',
    'verification_goal_events',
    'verification_goal_repository_snapshots',
    'verification_goal_environment_snapshots',
    'verification_goal_schedule_bindings',
    'verification_goal_schedule_heads',
    'verification_goal_schedule_slots'
  ]
  LOOP
    IF (
      SELECT count(*)
      FROM pg_catalog.pg_class relation
      JOIN pg_catalog.pg_namespace namespace_row ON namespace_row.oid = relation.relnamespace
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(relation.relacl, pg_catalog.acldefault('r', relation.relowner))
      ) privilege
      WHERE namespace_row.nspname = 'public'
        AND relation.relname = projection_name
        AND privilege.grantee = 'forge'::pg_catalog.regrole
        AND privilege.privilege_type = 'SELECT'
        AND NOT privilege.is_grantable
        AND privilege.grantor = relation.relowner
    ) <> 1 THEN
      RAISE EXCEPTION 'projection exception % does not have exact forge SELECT authority', projection_name;
    END IF;
  END LOOP;
END;
$verify$;

COMMIT;
