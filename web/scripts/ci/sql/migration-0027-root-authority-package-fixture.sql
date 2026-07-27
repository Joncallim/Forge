\set ON_ERROR_STOP on

-- Admin-only fixture arrangement for ROOT-R2A. It depends on the exact
-- project authority seeded by migration-0027-root-authority-project-fixture.sql
-- and intentionally does not invoke reconciliation until R2A2.
DO $fixture$
BEGIN
  IF current_user = 'forge_project_root_reconciler' THEN
    RAISE EXCEPTION 'root authority package fixture must not run as the reconciler login';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public.projects project_row
    JOIN public.project_filesystem_grant_decisions decision_row
      ON decision_row.id = '27000000-0000-4000-8000-000000000702'::uuid
     AND decision_row.project_id = project_row.id
    JOIN public.project_filesystem_current_decision_pointers pointer_row
      ON pointer_row.project_id = project_row.id
     AND pointer_row.current_decision_id = decision_row.id
    WHERE project_row.id = '27000000-0000-4000-8000-000000000700'::uuid
      AND project_row.root_binding_revision = 1
      AND project_row.grant_decision_revision = 1
  ) THEN
    RAISE EXCEPTION 'root authority package fixture requires the exact R2A1a project authority';
  END IF;
END;
$fixture$;

INSERT INTO public.tasks (
  id, project_id, submitted_by, title, prompt, status, local_projection_scope_state
) VALUES
  (
    '27000000-0000-4000-8000-000000000710',
    '27000000-0000-4000-8000-000000000700',
    '27000000-0000-4000-8000-000000000001',
    'Root authority running convergence',
    'Fixture task for marker addition and replacement.',
    'running',
    'active'
  ),
  (
    '27000000-0000-4000-8000-000000000720',
    '27000000-0000-4000-8000-000000000700',
    '27000000-0000-4000-8000-000000000001',
    'Root authority legacy failed convergence',
    'Fixture task for marker removal and task recovery.',
    'failed',
    'active'
  );

INSERT INTO public.work_packages (
  id, task_id, assigned_role, title, summary, status, sequence,
  mcp_requirements, blocked_reason, metadata
) VALUES
  (
    '27000000-0000-4000-8000-000000000711',
    '27000000-0000-4000-8000-000000000710',
    'backend',
    'Root authority marker addition',
    'A ready package that later receives the canonical root hold.',
    'ready',
    1,
    '[{"mcpId":"filesystem","requirement":"required","assignedRole":"backend","fallback":{"action":"block","message":""},"capabilities":["filesystem.project.read","filesystem.project.search"]}]'::jsonb,
    NULL,
    '{"fixturePeer":{"case":"addition","retain":true},"mcpGrantPhases":{"filesystem":{"phase":"preexisting-add","revision":"1"}}}'::jsonb
  ),
  (
    '27000000-0000-4000-8000-000000000712',
    '27000000-0000-4000-8000-000000000710',
    'backend',
    'Root authority marker replacement',
    'A valid prior marker that later refreshes under the root change.',
    'blocked',
    2,
    '[{"mcpId":"filesystem","requirement":"required","assignedRole":"backend","fallback":{"action":"block","message":""},"capabilities":["filesystem.project.read","filesystem.project.search"]}]'::jsonb,
    'Filesystem context requires an operator decision before execution.',
    '{"fixturePeer":{"case":"replacement","retain":true},"mcpGrantPhases":{"filesystem":{"phase":"preexisting-replace","revision":"1"}},"mcpGrantBlock":{"schemaVersion":2,"kind":"filesystem_grant","source":"filesystem-grant-approval","taskDisposition":"operator_hold","autoRetryable":false,"terminalFailure":false,"requirementKeys":["requirement:root-replacement"],"requestedCapabilities":["filesystem.project.read"],"recoveryAction":"approve_project_filesystem_context","blockFingerprint":"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","blockedAt":"2026-07-28T00:00:01.000Z","holdKind":"approval_required","grantPhase":"none","grantConsumed":false,"grantDecisionRevision":null,"revocationReason":null}}'::jsonb
  ),
  (
    '27000000-0000-4000-8000-000000000721',
    '27000000-0000-4000-8000-000000000720',
    'qa',
    'Root authority marker removal',
    'A valid prior marker that later clears through recovery.',
    'blocked',
    1,
    -- A prior filesystem marker can only recover after the package no longer
    -- has a blocking filesystem requirement. A root repoint revokes every
    -- still-required filesystem capability and therefore refreshes its hold.
    '[]'::jsonb,
    'Filesystem context requires an operator decision before execution.',
    '{"fixturePeer":{"case":"removal","retain":true},"mcpGrantPhases":{"filesystem":{"phase":"preexisting-remove","revision":"1"}},"mcpGrantBlock":{"schemaVersion":2,"kind":"filesystem_grant","source":"filesystem-grant-approval","taskDisposition":"operator_hold","autoRetryable":false,"terminalFailure":false,"requirementKeys":["requirement:root-removal"],"requestedCapabilities":["filesystem.project.read"],"recoveryAction":"approve_project_filesystem_context","blockFingerprint":"sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","blockedAt":"2026-07-28T00:00:02.000Z","holdKind":"consumed_once","grantPhase":"approved","grantConsumed":true,"grantDecisionRevision":"1","revocationReason":null}}'::jsonb
  );

DO $assertions$
DECLARE
  expected_packages uuid[] := ARRAY[
    '27000000-0000-4000-8000-000000000711'::uuid,
    '27000000-0000-4000-8000-000000000712'::uuid,
    '27000000-0000-4000-8000-000000000721'::uuid
  ];
BEGIN
  IF (SELECT count(*) FROM public.tasks
      WHERE id = ANY (ARRAY[
        '27000000-0000-4000-8000-000000000710'::uuid,
        '27000000-0000-4000-8000-000000000720'::uuid
      ]) AND project_id = '27000000-0000-4000-8000-000000000700'::uuid
        AND local_projection_scope_state = 'active') <> 2
     OR NOT EXISTS (SELECT 1 FROM public.tasks WHERE id = '27000000-0000-4000-8000-000000000710'::uuid AND status = 'running')
     OR NOT EXISTS (SELECT 1 FROM public.tasks WHERE id = '27000000-0000-4000-8000-000000000720'::uuid AND status = 'failed')
     OR (SELECT count(*) FROM public.work_packages package_row
         JOIN public.tasks task_row ON task_row.id = package_row.task_id
         WHERE package_row.id = ANY (expected_packages)
           AND task_row.project_id = '27000000-0000-4000-8000-000000000700'::uuid) <> 3
  THEN
    RAISE EXCEPTION 'root authority package fixture has invalid task or project ownership';
  END IF;

  IF NOT EXISTS (
       SELECT 1 FROM public.work_packages
       WHERE id = '27000000-0000-4000-8000-000000000711'::uuid
         AND status = 'ready' AND NOT (metadata ? 'mcpGrantBlock')
     ) OR EXISTS (
       SELECT 1 FROM public.work_packages
       WHERE id = ANY (ARRAY[
         '27000000-0000-4000-8000-000000000712'::uuid,
         '27000000-0000-4000-8000-000000000721'::uuid
       ])
         AND (status <> 'blocked'
           OR public.forge_is_canonical_filesystem_grant_block_v2(metadata->'mcpGrantBlock') IS NOT TRUE)
     ) OR EXISTS (
       SELECT 1 FROM public.work_packages
       WHERE id = ANY (expected_packages)
         AND (metadata->'mcpGrantPhases' IS NULL OR metadata->'fixturePeer' IS NULL)
     ) OR NOT EXISTS (
       SELECT 1 FROM public.work_packages
       WHERE id = '27000000-0000-4000-8000-000000000711'::uuid
         AND metadata = '{"fixturePeer":{"case":"addition","retain":true},"mcpGrantPhases":{"filesystem":{"phase":"preexisting-add","revision":"1"}}}'::jsonb
     ) OR EXISTS (
       SELECT 1 FROM public.work_packages
       WHERE id IN (
         '27000000-0000-4000-8000-000000000712'::uuid,
         '27000000-0000-4000-8000-000000000721'::uuid
       )
         AND metadata - 'mcpGrantBlock' NOT IN (
           '{"fixturePeer":{"case":"replacement","retain":true},"mcpGrantPhases":{"filesystem":{"phase":"preexisting-replace","revision":"1"}}}'::jsonb,
           '{"fixturePeer":{"case":"removal","retain":true},"mcpGrantPhases":{"filesystem":{"phase":"preexisting-remove","revision":"1"}}}'::jsonb
         )
     ) OR (SELECT count(DISTINCT metadata->'mcpGrantBlock'->>'blockFingerprint')
           FROM public.work_packages
           WHERE id IN (
             '27000000-0000-4000-8000-000000000712'::uuid,
             '27000000-0000-4000-8000-000000000721'::uuid
           )) <> 2
     OR (SELECT count(DISTINCT metadata->'mcpGrantBlock'->>'blockedAt')
         FROM public.work_packages
         WHERE id IN (
           '27000000-0000-4000-8000-000000000712'::uuid,
           '27000000-0000-4000-8000-000000000721'::uuid
         )) <> 2
  THEN
    RAISE EXCEPTION 'root authority package fixture has invalid marker or baseline metadata';
  END IF;

  IF (SELECT count(*) FROM public.filesystem_mcp_current_decision_pointers pointer_row
      JOIN public.work_packages package_row ON package_row.id = pointer_row.work_package_id
      WHERE package_row.id = ANY (expected_packages)
        AND pointer_row.task_id = package_row.task_id
        AND pointer_row.current_decision_id IS NULL
        AND pointer_row.current_decision_task_id IS NULL
        AND pointer_row.current_decision_work_package_id IS NULL
        AND pointer_row.current_decision_revision IS NULL
        AND pointer_row.current_decision_fingerprint IS NULL
        AND pointer_row.pointer_version = 0
        AND pointer_row.pointer_fingerprint = 'empty:' || package_row.id::text) <> 3
     OR (SELECT count(*) FROM public.filesystem_mcp_current_decision_pointers
         WHERE work_package_id = ANY (expected_packages)) <> 3
  THEN
    RAISE EXCEPTION 'root authority package fixture has invalid or ambiguous package pointers';
  END IF;

  IF (SELECT count(*) FROM public.work_package_local_projection_heads head
      JOIN public.work_packages package_row ON package_row.id = head.work_package_id
      WHERE package_row.id = ANY (expected_packages)) <> 24
     OR (SELECT count(*) FROM public.work_package_local_projection_heads head
         JOIN public.work_packages package_row ON package_row.id = head.work_package_id
         WHERE package_row.id = ANY (expected_packages)
           AND head.head_kind = 'operator_hold'
           AND head.head_index = 5
           AND head.head_revision = 0
           AND head.current_source_id IS NULL
           AND head.compare_and_set_fingerprint = head.head_fingerprint
           AND head.head_fingerprint = 'head:v1:' || package_row.task_id::text || ':' || package_row.id::text || ':operator_hold:5') <> 3
     OR EXISTS (
       SELECT 1 FROM public.work_package_local_projection_sources
       WHERE work_package_id = ANY (expected_packages)
     )
  THEN
    RAISE EXCEPTION 'root authority package fixture has invalid projection heads or sources';
  END IF;
END;
$assertions$;
