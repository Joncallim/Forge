\set ON_ERROR_STOP on

CREATE TEMP TABLE root_reconciler_expected_privileges (
  category text NOT NULL,
  entry text NOT NULL,
  PRIMARY KEY (category, entry)
);
CREATE TEMP TABLE root_reconciler_actual_privileges (
  category text NOT NULL,
  entry text NOT NULL,
  PRIMARY KEY (category, entry)
);
CREATE TEMP TABLE root_reconciler_privilege_categories (
  category text PRIMARY KEY
);

INSERT INTO root_reconciler_privilege_categories (category) VALUES
  ('relation'),
  ('column_select'),
  ('column_insert'),
  ('column_update'),
  ('column_references'),
  ('grant_option_relation'),
  ('grant_option_column'),
  ('grant_option_routine'),
  ('grant_option_schema'),
  ('grant_option_database'),
  ('grant_option_sequence'),
  ('routine'),
  ('schema'),
  ('database'),
  ('sequence'),
  ('ownership'),
  ('membership');

INSERT INTO root_reconciler_expected_privileges (category, entry) VALUES
  ('relation', 'public.projects:SELECT'),
  ('relation', 'public.tasks:SELECT'),
  ('relation', 'public.work_packages:SELECT'),
  ('relation', 'public.filesystem_mcp_grant_approvals:SELECT'),
  ('relation', 'public.filesystem_mcp_current_decision_pointers:SELECT'),
  ('relation', 'public.project_filesystem_grant_decisions:SELECT'),
  ('relation', 'public.project_filesystem_current_decision_pointers:SELECT'),
  ('relation', 'public.work_package_local_projection_heads:SELECT'),
  ('relation', 'public.forge_epic_172_s3_release_state:SELECT'),
  ('column_update', 'public.tasks.status'),
  ('column_update', 'public.tasks.error_message'),
  ('column_update', 'public.tasks.updated_at'),
  ('column_update', 'public.work_packages.status'),
  ('column_update', 'public.work_packages.blocked_reason'),
  ('column_update', 'public.work_packages.metadata'),
  ('column_update', 'public.work_packages.updated_at'),
  ('routine', 'forge.advance_local_projection_head_v1(uuid,uuid,text,uuid,bigint,text,jsonb,bigint,text,text)'),
  ('routine', 'forge.begin_project_root_reconciliation_v1(uuid,uuid,bigint)'),
  ('routine', 'forge.claim_project_root_reconciliation_batch_v1(uuid,uuid,integer)'),
  ('routine', 'forge.complete_project_root_reconciliation_generation_v1(uuid,uuid,bigint,uuid,text)'),
  ('routine', 'forge.enter_project_root_reconciliation_generation_v1(uuid,uuid,bigint,uuid)'),
  ('routine', 'forge.lock_project_root_reconciliation_authority_v1(uuid,uuid,bigint,uuid)'),
  ('routine', 'forge.materialize_project_root_ref_expansion_v1(integer)'),
  -- These four functions are pure, immutable input validators. PUBLIC
  -- execution is intentional and does not read or mutate reconciliation state.
  ('routine', 'public.forge_is_canonical_bounded_string_set(jsonb,integer,integer)'),
  ('routine', 'public.forge_is_canonical_filesystem_capability_set(jsonb)'),
  ('routine', 'public.forge_is_canonical_filesystem_grant_block_v2(jsonb)'),
  ('routine', 'public.forge_is_canonical_utc_timestamp(text)'),
  ('schema', 'public:USAGE'),
  ('schema', 'forge:USAGE'),
  ('database', 'CONNECT'),
  ('database', 'TEMPORARY');

INSERT INTO root_reconciler_actual_privileges (category, entry)
SELECT 'relation', namespace_row.nspname || '.' || relation.relname || ':' || privilege.privilege
FROM pg_catalog.pg_class relation
JOIN pg_catalog.pg_namespace namespace_row ON namespace_row.oid = relation.relnamespace
CROSS JOIN (
  SELECT privilege
  FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']::text[]) AS supported(privilege)
  UNION ALL
  -- MAINTAIN is a PostgreSQL 17 relation privilege; PostgreSQL 16 rejects it.
  SELECT 'MAINTAIN'
  WHERE pg_catalog.current_setting('server_version_num')::integer >= 170000
) AS privilege
WHERE namespace_row.nspname IN ('public', 'forge')
  AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
  AND pg_catalog.has_table_privilege('forge_project_root_reconciler', relation.oid, privilege.privilege);
-- The scan intentionally includes protected relations such as
-- public.project_root_reconciliation_write_contexts: absent from the allowlist
-- means every effective direct relation privilege is rejected.

-- Record only column-specific effective grants. A table-level privilege of the
-- same class applies to every column and is already represented above.
INSERT INTO root_reconciler_actual_privileges (category, entry)
SELECT 'column_' || lower(privilege.privilege), namespace_row.nspname || '.' || relation.relname || '.' || attribute_row.attname
FROM pg_catalog.pg_class relation
JOIN pg_catalog.pg_namespace namespace_row ON namespace_row.oid = relation.relnamespace
JOIN pg_catalog.pg_attribute attribute_row ON attribute_row.attrelid = relation.oid
CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('REFERENCES')) AS privilege(privilege)
WHERE namespace_row.nspname IN ('public', 'forge')
  AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
  AND attribute_row.attnum > 0
  AND NOT attribute_row.attisdropped
  AND pg_catalog.has_column_privilege('forge_project_root_reconciler', relation.oid, attribute_row.attnum, privilege.privilege)
  AND NOT pg_catalog.has_table_privilege('forge_project_root_reconciler', relation.oid, privilege.privilege);

-- Grant options are delegation authority. ACL rows identify their source; the
-- role has no memberships and owns no application objects (checked below), so
-- direct/PUBLIC ACL rows are the complete effective grant-option surface.
INSERT INTO root_reconciler_actual_privileges (category, entry)
SELECT 'grant_option_relation',
  namespace_row.nspname || '.' || relation.relname || ':' || acl_row.privilege_type ||
  ':grantor=' || pg_catalog.pg_get_userbyid(acl_row.grantor) ||
  ':grantee=' || CASE WHEN acl_row.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(acl_row.grantee) END
FROM pg_catalog.pg_class relation
JOIN pg_catalog.pg_namespace namespace_row ON namespace_row.oid = relation.relnamespace
CROSS JOIN LATERAL pg_catalog.aclexplode(coalesce(relation.relacl, pg_catalog.acldefault('r', relation.relowner)))
  AS acl_row(grantor, grantee, privilege_type, is_grantable)
WHERE namespace_row.nspname IN ('public', 'forge')
  AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
  AND acl_row.grantee IN (0, 'forge_project_root_reconciler'::regrole)
  AND acl_row.is_grantable
  AND (
    acl_row.privilege_type IN ('SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER')
    OR (acl_row.privilege_type = 'MAINTAIN'
      AND pg_catalog.current_setting('server_version_num')::integer >= 170000)
  );

INSERT INTO root_reconciler_actual_privileges (category, entry)
SELECT 'grant_option_column',
  namespace_row.nspname || '.' || relation.relname || '.' || attribute_row.attname || ':' || acl_row.privilege_type ||
  ':grantor=' || pg_catalog.pg_get_userbyid(acl_row.grantor) ||
  ':grantee=' || CASE WHEN acl_row.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(acl_row.grantee) END
FROM pg_catalog.pg_class relation
JOIN pg_catalog.pg_namespace namespace_row ON namespace_row.oid = relation.relnamespace
JOIN pg_catalog.pg_attribute attribute_row ON attribute_row.attrelid = relation.oid
CROSS JOIN LATERAL pg_catalog.aclexplode(coalesce(attribute_row.attacl, pg_catalog.acldefault('c', relation.relowner)))
  AS acl_row(grantor, grantee, privilege_type, is_grantable)
WHERE namespace_row.nspname IN ('public', 'forge')
  AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
  AND attribute_row.attnum > 0
  AND NOT attribute_row.attisdropped
  AND acl_row.grantee IN (0, 'forge_project_root_reconciler'::regrole)
  AND acl_row.is_grantable
  AND acl_row.privilege_type IN ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES');

INSERT INTO root_reconciler_actual_privileges (category, entry)
SELECT 'grant_option_routine',
  namespace_row.nspname || '.' || routine.proname || '(' || replace(pg_catalog.oidvectortypes(routine.proargtypes), ', ', ',') || '):EXECUTE' ||
  ':grantor=' || pg_catalog.pg_get_userbyid(acl_row.grantor) ||
  ':grantee=' || CASE WHEN acl_row.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(acl_row.grantee) END
FROM pg_catalog.pg_proc routine
JOIN pg_catalog.pg_namespace namespace_row ON namespace_row.oid = routine.pronamespace
CROSS JOIN LATERAL pg_catalog.aclexplode(coalesce(routine.proacl, pg_catalog.acldefault('f', routine.proowner)))
  AS acl_row(grantor, grantee, privilege_type, is_grantable)
WHERE namespace_row.nspname IN ('public', 'forge')
  AND routine.prokind IN ('f', 'p')
  AND acl_row.grantee IN (0, 'forge_project_root_reconciler'::regrole)
  AND acl_row.is_grantable
  AND acl_row.privilege_type = 'EXECUTE';

INSERT INTO root_reconciler_actual_privileges (category, entry)
SELECT 'grant_option_schema',
  namespace_row.nspname || ':' || acl_row.privilege_type ||
  ':grantor=' || pg_catalog.pg_get_userbyid(acl_row.grantor) ||
  ':grantee=' || CASE WHEN acl_row.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(acl_row.grantee) END
FROM pg_catalog.pg_namespace namespace_row
CROSS JOIN LATERAL pg_catalog.aclexplode(coalesce(namespace_row.nspacl, pg_catalog.acldefault('n', namespace_row.nspowner)))
  AS acl_row(grantor, grantee, privilege_type, is_grantable)
WHERE namespace_row.nspname IN ('public', 'forge')
  AND acl_row.grantee IN (0, 'forge_project_root_reconciler'::regrole)
  AND acl_row.is_grantable
  AND acl_row.privilege_type IN ('USAGE', 'CREATE');

INSERT INTO root_reconciler_actual_privileges (category, entry)
SELECT 'grant_option_database',
  database_row.datname || ':' || acl_row.privilege_type ||
  ':grantor=' || pg_catalog.pg_get_userbyid(acl_row.grantor) ||
  ':grantee=' || CASE WHEN acl_row.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(acl_row.grantee) END
FROM pg_catalog.pg_database database_row
CROSS JOIN LATERAL pg_catalog.aclexplode(coalesce(database_row.datacl, pg_catalog.acldefault('d', database_row.datdba)))
  AS acl_row(grantor, grantee, privilege_type, is_grantable)
WHERE database_row.datname = pg_catalog.current_database()
  AND acl_row.grantee IN (0, 'forge_project_root_reconciler'::regrole)
  AND acl_row.is_grantable
  AND acl_row.privilege_type IN ('CONNECT', 'CREATE', 'TEMPORARY');

INSERT INTO root_reconciler_actual_privileges (category, entry)
SELECT 'grant_option_sequence',
  namespace_row.nspname || '.' || sequence_row.relname || ':' || acl_row.privilege_type ||
  ':grantor=' || pg_catalog.pg_get_userbyid(acl_row.grantor) ||
  ':grantee=' || CASE WHEN acl_row.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(acl_row.grantee) END
FROM pg_catalog.pg_class sequence_row
JOIN pg_catalog.pg_namespace namespace_row ON namespace_row.oid = sequence_row.relnamespace
CROSS JOIN LATERAL pg_catalog.aclexplode(coalesce(sequence_row.relacl, pg_catalog.acldefault('s', sequence_row.relowner)))
  AS acl_row(grantor, grantee, privilege_type, is_grantable)
WHERE namespace_row.nspname IN ('public', 'forge')
  AND sequence_row.relkind = 'S'
  AND acl_row.grantee IN (0, 'forge_project_root_reconciler'::regrole)
  AND acl_row.is_grantable
  AND acl_row.privilege_type IN ('USAGE', 'SELECT', 'UPDATE');

INSERT INTO root_reconciler_actual_privileges (category, entry)
SELECT 'routine', namespace_row.nspname || '.' || routine.proname || '(' || replace(pg_catalog.oidvectortypes(routine.proargtypes), ', ', ',') || ')'
FROM pg_catalog.pg_proc routine
JOIN pg_catalog.pg_namespace namespace_row ON namespace_row.oid = routine.pronamespace
WHERE namespace_row.nspname IN ('public', 'forge')
  AND routine.prokind IN ('f', 'p')
  AND pg_catalog.has_function_privilege('forge_project_root_reconciler', routine.oid, 'EXECUTE');

INSERT INTO root_reconciler_actual_privileges (category, entry)
SELECT 'schema', namespace_row.nspname || ':' || privilege.privilege
FROM pg_catalog.pg_namespace namespace_row
CROSS JOIN (VALUES ('USAGE'), ('CREATE')) AS privilege(privilege)
WHERE namespace_row.nspname IN ('public', 'forge')
  AND pg_catalog.has_schema_privilege('forge_project_root_reconciler', namespace_row.oid, privilege.privilege);

INSERT INTO root_reconciler_actual_privileges (category, entry)
SELECT 'database', privilege.privilege
FROM pg_catalog.pg_database database_row
CROSS JOIN (VALUES ('CONNECT'), ('TEMPORARY'), ('CREATE')) AS privilege(privilege)
WHERE database_row.datname = pg_catalog.current_database()
  AND pg_catalog.has_database_privilege('forge_project_root_reconciler', database_row.oid, privilege.privilege);

INSERT INTO root_reconciler_actual_privileges (category, entry)
SELECT 'sequence', namespace_row.nspname || '.' || sequence_row.relname || ':' || privilege.privilege
FROM pg_catalog.pg_class sequence_row
JOIN pg_catalog.pg_namespace namespace_row ON namespace_row.oid = sequence_row.relnamespace
CROSS JOIN (VALUES ('USAGE'), ('SELECT'), ('UPDATE')) AS privilege(privilege)
WHERE namespace_row.nspname IN ('public', 'forge')
  AND sequence_row.relkind = 'S'
  AND pg_catalog.has_sequence_privilege('forge_project_root_reconciler', sequence_row.oid, privilege.privilege);

INSERT INTO root_reconciler_actual_privileges (category, entry)
SELECT 'ownership', 'database:' || database_row.datname
FROM pg_catalog.pg_database database_row
WHERE database_row.datname = pg_catalog.current_database()
  AND database_row.datdba = 'forge_project_root_reconciler'::regrole
UNION ALL
SELECT 'ownership', 'schema:' || namespace_row.nspname
FROM pg_catalog.pg_namespace namespace_row
WHERE namespace_row.nspname IN ('public', 'forge')
  AND namespace_row.nspowner = 'forge_project_root_reconciler'::regrole
UNION ALL
SELECT 'ownership', 'relation:' || namespace_row.nspname || '.' || relation.relname
FROM pg_catalog.pg_class relation
JOIN pg_catalog.pg_namespace namespace_row ON namespace_row.oid = relation.relnamespace
WHERE namespace_row.nspname IN ('public', 'forge')
  AND relation.relowner = 'forge_project_root_reconciler'::regrole
UNION ALL
SELECT 'ownership', 'routine:' || namespace_row.nspname || '.' || routine.proname || '(' || replace(pg_catalog.pg_get_function_identity_arguments(routine.oid), ', ', ',') || ')'
FROM pg_catalog.pg_proc routine
JOIN pg_catalog.pg_namespace namespace_row ON namespace_row.oid = routine.pronamespace
WHERE namespace_row.nspname IN ('public', 'forge')
  AND routine.proowner = 'forge_project_root_reconciler'::regrole;

INSERT INTO root_reconciler_actual_privileges (category, entry)
SELECT 'membership', granted.rolname || '<-' || member.rolname || ':admin=' || membership.admin_option || ':inherit=' || membership.inherit_option || ':set=' || membership.set_option
FROM pg_catalog.pg_auth_members membership
JOIN pg_catalog.pg_roles granted ON granted.oid = membership.roleid
JOIN pg_catalog.pg_roles member ON member.oid = membership.member
WHERE membership.member = 'forge_project_root_reconciler'::regrole
   OR membership.roleid = 'forge_project_root_reconciler'::regrole;

DO $proof$
DECLARE
  role_row pg_catalog.pg_roles%ROWTYPE;
  diff jsonb;
BEGIN
  SELECT * INTO STRICT role_row
  FROM pg_catalog.pg_roles
  WHERE rolname = 'forge_project_root_reconciler';
  IF NOT role_row.rolcanlogin OR role_row.rolinherit OR role_row.rolsuper OR role_row.rolcreaterole
     OR role_row.rolcreatedb OR role_row.rolreplication OR role_row.rolbypassrls THEN
    RAISE EXCEPTION 'root reconciler role attributes exceed the closed contract: %',
      jsonb_build_object('canlogin', role_row.rolcanlogin, 'inherit', role_row.rolinherit,
        'superuser', role_row.rolsuper, 'createrole', role_row.rolcreaterole,
        'createdb', role_row.rolcreatedb, 'replication', role_row.rolreplication,
        'bypassrls', role_row.rolbypassrls);
  END IF;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'category', category,
    'missing', missing,
    'unexpected', unexpected
  ) ORDER BY category), '[]'::jsonb)
  INTO diff
  FROM (
    SELECT categories.category,
      coalesce((SELECT jsonb_agg(entry ORDER BY entry) FROM (
        SELECT expected.entry
        FROM root_reconciler_expected_privileges expected
        WHERE expected.category = categories.category
        EXCEPT
        SELECT actual.entry
        FROM root_reconciler_actual_privileges actual
        WHERE actual.category = categories.category
      ) missing_rows), '[]'::jsonb) AS missing,
      coalesce((SELECT jsonb_agg(entry ORDER BY entry) FROM (
        SELECT actual.entry
        FROM root_reconciler_actual_privileges actual
        WHERE actual.category = categories.category
        EXCEPT
        SELECT expected.entry
        FROM root_reconciler_expected_privileges expected
        WHERE expected.category = categories.category
      ) unexpected_rows), '[]'::jsonb) AS unexpected
    FROM (
      SELECT category FROM root_reconciler_privilege_categories
      UNION
      SELECT category FROM root_reconciler_expected_privileges
      UNION
      SELECT category FROM root_reconciler_actual_privileges
    ) categories
  ) category_diffs
  WHERE missing <> '[]'::jsonb OR unexpected <> '[]'::jsonb;

  IF diff <> '[]'::jsonb THEN
    RAISE EXCEPTION 'root reconciler effective privilege allowlist mismatch: %', diff;
  END IF;
END;
$proof$;

DROP TABLE root_reconciler_actual_privileges;
DROP TABLE root_reconciler_expected_privileges;
DROP TABLE root_reconciler_privilege_categories;
