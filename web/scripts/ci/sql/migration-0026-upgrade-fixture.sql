DO $fixture_preconditions$
DECLARE
  migration_role pg_catalog.pg_roles%ROWTYPE;
  latest_migration bigint;
BEGIN
  SELECT * INTO STRICT migration_role
  FROM pg_catalog.pg_roles
  WHERE rolname = current_user;

  IF migration_role.rolsuper
     OR migration_role.rolinherit
     OR migration_role.rolcreatedb
     OR migration_role.rolcreaterole
     OR migration_role.rolreplication
     OR migration_role.rolbypassrls THEN
    RAISE EXCEPTION 'The upgrade fixture must run as the ordinary NOINHERIT migration principal';
  END IF;
  IF (
    SELECT owner.rolname <> current_user
    FROM pg_catalog.pg_database database_row
    JOIN pg_catalog.pg_roles owner ON owner.oid = database_row.datdba
    WHERE database_row.datname = current_database()
  ) IS NOT FALSE THEN
    RAISE EXCEPTION 'The ordinary migration principal must own the disposable upgrade database';
  END IF;

  SELECT max(created_at) INTO STRICT latest_migration
  FROM drizzle.__drizzle_migrations;
  IF latest_migration <> 1784263200000 THEN
    RAISE EXCEPTION 'Expected the populated fixture database to stop at migration 0025, got %', latest_migration;
  END IF;
  IF pg_catalog.to_regclass('public.work_package_local_projection_heads') IS NOT NULL
     OR EXISTS (
       SELECT 1
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'tasks'
         AND column_name = 'local_projection_scope_state'
     ) THEN
    RAISE EXCEPTION 'Migration 0026 state exists before the upgrade fixture was seeded';
  END IF;
END;
$fixture_preconditions$;

INSERT INTO public.users (id, display_name, password_hash)
VALUES (
  '10000000-0000-4000-8000-000000000001',
  'Migration 0026 fixture operator',
  'fixture-not-a-real-password-hash'
);

INSERT INTO public.projects (id, name, submitted_by, local_path, mcp_config)
VALUES
  (
    '20000000-0000-4000-8000-000000000001',
    'Migration 0026 active fixture',
    '10000000-0000-4000-8000-000000000001',
    '/tmp/forge-migration-0026-active',
    '{"profile":"custom","requiredMcps":["filesystem"],"overrides":{},"grants":{"filesystem":{"mode":"always_allow","root":"/legacy/active"}}}'::jsonb
  ),
  (
    '20000000-0000-4000-8000-000000000002',
    'Migration 0026 over-limit fixture',
    '10000000-0000-4000-8000-000000000001',
    '/tmp/forge-migration-0026-over-limit',
    '{"profile":"custom","requiredMcps":["filesystem"],"overrides":{},"grants":{"filesystem":{"mode":"allow_once","root":"/legacy/over-limit"}}}'::jsonb
  );

INSERT INTO public.tasks (id, project_id, submitted_by, title, prompt, status)
VALUES
  (
    '30000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    'Active legacy task',
    'Retain active package state during the 0026 upgrade.',
    'running'
  ),
  (
    '30000000-0000-4000-8000-000000000002',
    '20000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000001',
    'Over-limit legacy task',
    'Classify 257 existing packages without inventing projection authority.',
    'awaiting_approval'
  );

INSERT INTO public.work_packages (
  id, task_id, assigned_role, title, summary, status, sequence,
  required_capabilities, mcp_requirements, blocked_reason, metadata
)
VALUES
  (
    '40000000-0000-4000-8000-000000000001',
    '30000000-0000-4000-8000-000000000001',
    'backend',
    'Legacy approved package',
    'Carries a mutable pre-S3 approval and an older marker-shaped payload.',
    'blocked',
    1,
    '{"filesystem":true}'::jsonb,
    '[{"mcpId":"filesystem","required":true,"capabilities":["filesystem.project.read"]}]'::jsonb,
    'Legacy filesystem approval hold',
    '{"fixture":"active-approved","mcpGrantBlock":{"schemaVersion":1,"kind":"filesystem_grant","source":"filesystem-grant-approval","freeform":"retained"}}'::jsonb
  ),
  (
    '40000000-0000-4000-8000-000000000002',
    '30000000-0000-4000-8000-000000000001',
    'qa',
    'Legacy package without approval',
    'Must receive an explicit empty pointer and exactly eight projection heads.',
    'ready',
    2,
    '{}'::jsonb,
    '[]'::jsonb,
    NULL,
    '{"fixture":"active-empty","unrelated":{"retained":true}}'::jsonb
  );

INSERT INTO public.work_packages (
  id, task_id, assigned_role, title, summary, status, sequence,
  required_capabilities, mcp_requirements, blocked_reason, metadata
)
SELECT
  ('41000000-0000-4000-8000-' || lpad(to_hex(package_number), 12, '0'))::uuid,
  '30000000-0000-4000-8000-000000000002'::uuid,
  'backend',
  'Legacy over-limit package ' || package_number,
  'Representative package retained outside the claimable projection scope.',
  CASE WHEN package_number = 1 THEN 'blocked' ELSE 'ready' END,
  package_number,
  CASE WHEN package_number = 1 THEN '{"filesystem":true}'::jsonb ELSE '{}'::jsonb END,
  CASE WHEN package_number = 1
    THEN '[{"mcpId":"filesystem","required":true,"capabilities":["filesystem.project.search"]}]'::jsonb
    ELSE '[]'::jsonb
  END,
  CASE WHEN package_number = 1 THEN 'Legacy over-limit hold' ELSE NULL END,
  CASE WHEN package_number = 1
    THEN '{"fixture":"over-limit-denied","mcpGrantBlock":{"schemaVersion":"legacy","reason":"operator review"}}'::jsonb
    ELSE jsonb_build_object('fixture', 'over-limit', 'sequence', package_number)
  END
FROM generate_series(1, 257) package_number;

INSERT INTO public.filesystem_mcp_grant_approvals (
  id, task_id, work_package_id, decided_by, decision, capabilities,
  reason, effective_grant, created_at, updated_at
)
VALUES
  (
    '50000000-0000-4000-8000-000000000001',
    '30000000-0000-4000-8000-000000000001',
    '40000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    'approved',
    '["filesystem.project.read"]'::jsonb,
    'Mutable legacy approval retained as non-authoritative history.',
    '{"mode":"always_allow","root":"/legacy/active","capabilities":["filesystem.project.read"]}'::jsonb,
    '2026-01-02T03:04:05Z',
    '2026-01-02T03:04:06Z'
  ),
  (
    '50000000-0000-4000-8000-000000000002',
    '30000000-0000-4000-8000-000000000002',
    '41000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    'denied',
    '["filesystem.project.search"]'::jsonb,
    'Over-limit legacy denial.',
    '{"mode":"denied","root":"/legacy/over-limit","capabilities":[]}'::jsonb,
    '2026-01-03T03:04:05Z',
    '2026-01-03T03:04:06Z'
  );
