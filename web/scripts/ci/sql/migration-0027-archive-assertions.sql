\set ON_ERROR_STOP on

-- Build the exact legacy shape produced by migration 0026: a typed 257-package
-- archive hold with no projection heads. A second source receives one partial
-- head so the archive routine must distinguish corruption from that exact
-- historical zero-head shape.
ALTER TABLE public.work_packages DISABLE TRIGGER trg_guard_projection_package_limit;
ALTER TABLE public.work_packages DISABLE TRIGGER trg_preallocate_projection_heads;

INSERT INTO public.tasks (
  id, project_id, submitted_by, title, prompt, status
) VALUES
  ('27000000-0000-4000-8000-00000000a001', '27000000-0000-4000-8000-000000000010',
   '27000000-0000-4000-8000-000000000001', 'Legacy 257 source', 'archive proof', 'approved'),
  ('27000000-0000-4000-8000-00000000a002', '27000000-0000-4000-8000-000000000010',
   '27000000-0000-4000-8000-000000000001', 'Corrupt 257 source', 'archive proof', 'approved');

INSERT INTO public.work_packages (
  id, task_id, assigned_role, title, summary, status, sequence
)
SELECT pg_catalog.gen_random_uuid(), source.task_id, 'backend',
  'Legacy package ' || package_number::text, 'archive proof', 'pending', package_number
FROM (VALUES
  ('27000000-0000-4000-8000-00000000a001'::uuid),
  ('27000000-0000-4000-8000-00000000a002'::uuid)
) source(task_id)
CROSS JOIN pg_catalog.generate_series(1, 257) package_number;

UPDATE public.tasks
SET local_projection_scope_state = 'archive_pending',
    local_projection_overlimit_package_count = 257
WHERE id IN (
  '27000000-0000-4000-8000-00000000a001',
  '27000000-0000-4000-8000-00000000a002'
);

INSERT INTO public.work_package_local_projection_heads (
  task_id, work_package_id, head_kind, head_index,
  head_fingerprint, compare_and_set_fingerprint
)
SELECT package.task_id, package.id, 'local_run', 0,
  'head:v1:' || package.task_id::text || ':' || package.id::text || ':local_run:0',
  'head:v1:' || package.task_id::text || ':' || package.id::text || ':local_run:0'
FROM public.work_packages package
WHERE package.task_id = '27000000-0000-4000-8000-00000000a002'
ORDER BY package.sequence
LIMIT 1;

ALTER TABLE public.work_packages ENABLE TRIGGER trg_preallocate_projection_heads;
ALTER TABLE public.work_packages ENABLE TRIGGER trg_guard_projection_package_limit;

INSERT INTO public.tasks (
  id, project_id, submitted_by, title, prompt, status
) VALUES
  ('27000000-0000-4000-8000-00000000b001', '27000000-0000-4000-8000-000000000010',
   '27000000-0000-4000-8000-000000000001', 'Replacement one', 'archive proof', 'approved'),
  ('27000000-0000-4000-8000-00000000b002', '27000000-0000-4000-8000-000000000010',
   '27000000-0000-4000-8000-000000000001', 'Replacement two', 'archive proof', 'approved');

INSERT INTO public.work_packages (
  id, task_id, assigned_role, title, summary, status, sequence
)
SELECT pg_catalog.gen_random_uuid(), replacement.task_id, 'backend',
  'Replacement package', 'archive proof', 'pending', 1
FROM (VALUES
  ('27000000-0000-4000-8000-00000000b001'::uuid),
  ('27000000-0000-4000-8000-00000000b002'::uuid)
) replacement(task_id);

SET SESSION AUTHORIZATION forge_local_projection_archiver;
DO $archive_assertions$
DECLARE
  source_snapshot jsonb;
  corrupt_snapshot jsonb;
  replacement_one_snapshot jsonb;
  replacement_two_snapshot jsonb;
  operation_id uuid;
  operation_fingerprint text;
  rolled_back_snapshot jsonb;
BEGIN
  SELECT inspect.snapshot INTO STRICT source_snapshot
  FROM forge.inspect_local_projection_overlimit_v2(
    '27000000-0000-4000-8000-00000000a001'
  ) inspect;
  SELECT inspect.snapshot INTO STRICT corrupt_snapshot
  FROM forge.inspect_local_projection_overlimit_v2(
    '27000000-0000-4000-8000-00000000a002'
  ) inspect;
  SELECT inspect.snapshot INTO STRICT replacement_one_snapshot
  FROM forge.inspect_local_projection_overlimit_v2(
    '27000000-0000-4000-8000-00000000b001'
  ) inspect;
  SELECT inspect.snapshot INTO STRICT replacement_two_snapshot
  FROM forge.inspect_local_projection_overlimit_v2(
    '27000000-0000-4000-8000-00000000b002'
  ) inspect;

  IF source_snapshot->>'scopeState' <> 'archive_pending'
     OR (source_snapshot->>'packageCount')::integer <> 257
     OR (source_snapshot->>'overlimitPackageCount')::integer <> 257
     OR source_snapshot->'projection'->>'integrityState' <> 'missing_heads'
     OR (source_snapshot->'projection'->>'actualHeadCount')::integer <> 0
     OR (source_snapshot->'projection'->>'distinctPackageCount')::integer <> 0 THEN
    RAISE EXCEPTION 'The exact migration-0026 zero-head source shape was not preserved';
  END IF;
  IF corrupt_snapshot->'projection'->>'integrityState' <> 'missing_heads'
     OR (corrupt_snapshot->'projection'->>'actualHeadCount')::integer <> 1 THEN
    RAISE EXCEPTION 'The partial-head corruption fixture was not observed exactly';
  END IF;
  IF replacement_one_snapshot->'projection'->>'integrityState' <> 'coherent'
     OR (replacement_one_snapshot->'projection'->>'actualHeadCount')::integer <> 8
     OR (replacement_one_snapshot->>'claimable')::boolean IS NOT TRUE
     OR replacement_one_snapshot->'replacement' <> 'null'::jsonb THEN
    RAISE EXCEPTION 'The unbound replacement is not coherent and claimable before apply';
  END IF;

  SELECT applied.operation_id, applied.operation_fingerprint
  INTO STRICT operation_id, operation_fingerprint
  FROM forge.apply_local_projection_overlimit_archive_v2(
    '27000000-0000-4000-8000-00000000a001',
    '27000000-0000-4000-8000-00000000b001',
    '27000000-0000-4000-8000-000000000001',
    source_snapshot->>'taskFingerprint',
    replacement_one_snapshot->>'taskFingerprint'
  ) applied;

  BEGIN
    PERFORM 1 FROM forge.apply_local_projection_overlimit_archive_v2(
      '27000000-0000-4000-8000-00000000a001',
      '27000000-0000-4000-8000-00000000b002',
      '27000000-0000-4000-8000-000000000001',
      source_snapshot->>'taskFingerprint',
      replacement_two_snapshot->>'taskFingerprint'
    );
    RAISE EXCEPTION 'A second replacement was accepted for a live source operation';
  EXCEPTION WHEN serialization_failure THEN
    NULL;
  END;

  SELECT rolled.snapshot INTO STRICT rolled_back_snapshot
  FROM forge.rollback_local_projection_overlimit_archive_v2(
    operation_id, '27000000-0000-4000-8000-000000000001', operation_fingerprint
  ) rolled;
  IF (rolled_back_snapshot->'replacement'->>'claimable')::boolean IS NOT TRUE
     OR rolled_back_snapshot->'replacement'->'replacement' <> 'null'::jsonb
     OR rolled_back_snapshot->'source'->>'scopeState' <> 'archive_pending' THEN
    RAISE EXCEPTION 'Rollback did not detach and restore the replacement claimability';
  END IF;

  SELECT inspect.snapshot INTO STRICT replacement_two_snapshot
  FROM forge.inspect_local_projection_overlimit_v2(
    '27000000-0000-4000-8000-00000000b002'
  ) inspect;
  PERFORM 1 FROM forge.apply_local_projection_overlimit_archive_v2(
    '27000000-0000-4000-8000-00000000a001',
    '27000000-0000-4000-8000-00000000b002',
    '27000000-0000-4000-8000-000000000001',
    source_snapshot->>'taskFingerprint',
    replacement_two_snapshot->>'taskFingerprint'
  );

  BEGIN
    PERFORM 1 FROM forge.apply_local_projection_overlimit_archive_v2(
      '27000000-0000-4000-8000-00000000a002',
      '27000000-0000-4000-8000-00000000b001',
      '27000000-0000-4000-8000-000000000001',
      corrupt_snapshot->>'taskFingerprint',
      (rolled_back_snapshot->'replacement'->>'taskFingerprint')
    );
    RAISE EXCEPTION 'A corrupt partial-head 257-package source was accepted';
  EXCEPTION WHEN serialization_failure THEN
    NULL;
  END;
END;
$archive_assertions$;
RESET SESSION AUTHORIZATION;
