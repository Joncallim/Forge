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
   '27000000-0000-4000-8000-000000000001', 'Corrupt 257 source', 'archive proof', 'approved'),
  ('27000000-0000-4000-8000-00000000a003', '27000000-0000-4000-8000-000000000010',
   '27000000-0000-4000-8000-000000000001', 'Cancelled 257 source', 'archive proof', 'approved');

INSERT INTO public.work_packages (
  id, task_id, assigned_role, title, summary, status, sequence
)
SELECT pg_catalog.gen_random_uuid(), source.task_id, 'backend',
  'Legacy package ' || package_number::text, 'archive proof', 'pending', package_number
FROM (VALUES
  ('27000000-0000-4000-8000-00000000a001'::uuid),
  ('27000000-0000-4000-8000-00000000a002'::uuid),
  ('27000000-0000-4000-8000-00000000a003'::uuid)
) source(task_id)
CROSS JOIN pg_catalog.generate_series(1, 257) package_number;

UPDATE public.tasks
SET local_projection_scope_state = 'archive_pending',
    local_projection_overlimit_package_count = 257
WHERE id IN (
  '27000000-0000-4000-8000-00000000a001',
  '27000000-0000-4000-8000-00000000a002',
  '27000000-0000-4000-8000-00000000a003'
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
   '27000000-0000-4000-8000-000000000001', 'Replacement two', 'archive proof', 'approved'),
  ('27000000-0000-4000-8000-00000000b003', '27000000-0000-4000-8000-000000000010',
   '27000000-0000-4000-8000-000000000001', 'Cancelled replacement', 'archive proof', 'approved');

INSERT INTO public.work_packages (
  id, task_id, assigned_role, title, summary, status, sequence
)
SELECT pg_catalog.gen_random_uuid(), replacement.task_id, 'backend',
  'Replacement package', 'archive proof', 'pending', 1
FROM (VALUES
  ('27000000-0000-4000-8000-00000000b001'::uuid),
  ('27000000-0000-4000-8000-00000000b002'::uuid),
  ('27000000-0000-4000-8000-00000000b003'::uuid)
) replacement(task_id);

SET SESSION AUTHORIZATION forge_local_projection_archiver;
DO $archive_assertions$
DECLARE
  source_snapshot jsonb;
  corrupt_snapshot jsonb;
  replacement_one_snapshot jsonb;
  replacement_two_snapshot jsonb;
  cancelled_source_snapshot jsonb;
  cancelled_replacement_snapshot jsonb;
  operation_id uuid;
  operation_fingerprint text;
  cancelled_operation_id uuid;
  cancelled_operation_fingerprint text;
  cancelled_snapshot jsonb;
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
  SELECT inspect.snapshot INTO STRICT cancelled_source_snapshot
  FROM forge.inspect_local_projection_overlimit_v2(
    '27000000-0000-4000-8000-00000000a003'
  ) inspect;
  SELECT inspect.snapshot INTO STRICT cancelled_replacement_snapshot
  FROM forge.inspect_local_projection_overlimit_v2(
    '27000000-0000-4000-8000-00000000b003'
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

  SELECT applied.operation_id, applied.operation_fingerprint
  INTO STRICT cancelled_operation_id, cancelled_operation_fingerprint
  FROM forge.apply_local_projection_overlimit_archive_v2(
    '27000000-0000-4000-8000-00000000a003',
    '27000000-0000-4000-8000-00000000b003',
    '27000000-0000-4000-8000-000000000001',
    cancelled_source_snapshot->>'taskFingerprint',
    cancelled_replacement_snapshot->>'taskFingerprint'
  ) applied;
  SELECT cancelled.snapshot INTO STRICT cancelled_snapshot
  FROM forge.cancel_local_projection_overlimit_archive_v2(
    cancelled_operation_id,
    '27000000-0000-4000-8000-000000000001',
    cancelled_operation_fingerprint
  ) cancelled;
  IF cancelled_snapshot->>'checkpoint' <> 'cancelled'
     OR cancelled_snapshot->'source'->>'scopeState' <> 'archive_pending'
     OR cancelled_snapshot->'replacement'->'replacement'->>'state' <> 'cancelled' THEN
    RAISE EXCEPTION 'Cancellation did not retain its evidence and terminal checkpoint';
  END IF;
END;
$archive_assertions$;
RESET SESSION AUTHORIZATION;

\ir migration-0027-recovery-assertions.sql

-- The live a001 -> b002 operation committed above in validated state. Treat
-- the boundary between each statement as the operator process crashing after
-- a durable checkpoint, then resume exclusively from retained identity.
SELECT operation.id AS resume_operation_id,
  operation.operation_fingerprint AS validated_fingerprint
FROM public.local_projection_archive_operations operation
WHERE operation.source_task_id = '27000000-0000-4000-8000-00000000a001'
  AND operation.replacement_task_id = '27000000-0000-4000-8000-00000000b002'
  AND operation.state = 'validated'
\gset archive_
SELECT pg_catalog.set_config(
  'forge.proof.archive_operation_id', :'archive_resume_operation_id', false
);
SELECT pg_catalog.set_config(
  'forge.proof.archive_validated_fingerprint', :'archive_validated_fingerprint', false
);

UPDATE public.work_packages package
SET status = 'awaiting_review'
WHERE package.id = (
  SELECT candidate.id
  FROM public.work_packages candidate
  WHERE candidate.task_id = '27000000-0000-4000-8000-00000000b002'
  ORDER BY candidate.id LIMIT 1
);

SET SESSION AUTHORIZATION forge_local_projection_archiver;
DO $archive_live_sibling_rejection$
BEGIN
  BEGIN
    PERFORM 1 FROM forge.resume_local_projection_overlimit_archive_v2(
      pg_catalog.current_setting('forge.proof.archive_operation_id')::uuid,
      '27000000-0000-4000-8000-000000000001',
      pg_catalog.current_setting('forge.proof.archive_validated_fingerprint')
    );
    RAISE EXCEPTION 'Archive resume accepted a sibling awaiting review';
  EXCEPTION WHEN serialization_failure THEN
    NULL;
  END;
END;
$archive_live_sibling_rejection$;
RESET SESSION AUTHORIZATION;

DO $archive_rejection_zero_mutation$
BEGIN
  IF (SELECT operation.state FROM public.local_projection_archive_operations operation
      WHERE operation.id = pg_catalog.current_setting(
        'forge.proof.archive_operation_id'
      )::uuid) <> 'validated'
     OR (SELECT operation.operation_fingerprint
         FROM public.local_projection_archive_operations operation
         WHERE operation.id = pg_catalog.current_setting(
           'forge.proof.archive_operation_id'
         )::uuid) <> pg_catalog.current_setting(
           'forge.proof.archive_validated_fingerprint'
         )
     OR (SELECT pg_catalog.count(*)
         FROM public.local_projection_archive_operation_checkpoints checkpoint
         WHERE checkpoint.operation_id = pg_catalog.current_setting(
           'forge.proof.archive_operation_id'
         )::uuid) <> 1 THEN
    RAISE EXCEPTION 'Rejected archive resume mutated operation evidence';
  END IF;
END;
$archive_rejection_zero_mutation$;
UPDATE public.work_packages package
SET status = 'pending'
WHERE package.task_id = '27000000-0000-4000-8000-00000000b002'
  AND package.status = 'awaiting_review';

SET SESSION AUTHORIZATION forge_local_projection_archiver;
SELECT resumed.operation_fingerprint AS quiesced_fingerprint
FROM forge.resume_local_projection_overlimit_archive_v2(
  :'archive_resume_operation_id'::uuid,
  '27000000-0000-4000-8000-000000000001',
  :'archive_validated_fingerprint'
) resumed
WHERE resumed.state = 'quiesced'
\gset archive_

SELECT resumed.operation_fingerprint AS archived_fingerprint
FROM forge.resume_local_projection_overlimit_archive_v2(
  :'archive_resume_operation_id'::uuid,
  '27000000-0000-4000-8000-000000000001',
  :'archive_quiesced_fingerprint'
) resumed
WHERE resumed.state = 'archived'
\gset archive_
SELECT pg_catalog.set_config(
  'forge.proof.archive_archived_fingerprint', :'archive_archived_fingerprint', false
);

DO $archive_final_assertions$
DECLARE
  v_replay record;
BEGIN
  SELECT * INTO STRICT v_replay
  FROM forge.resume_local_projection_overlimit_archive_v2(
    pg_catalog.current_setting('forge.proof.archive_operation_id')::uuid,
    '27000000-0000-4000-8000-000000000001',
    pg_catalog.current_setting('forge.proof.archive_archived_fingerprint')
  );
  IF v_replay.state <> 'archived'
     OR v_replay.snapshot->'source'->>'scopeState' <> 'legacy_archived'
     OR v_replay.snapshot->'replacement'->'replacement'->>'state' <> 'eligible' THEN
    RAISE EXCEPTION 'Crash-resume did not reach the exact retained archive state';
  END IF;
END;
$archive_final_assertions$;
RESET SESSION AUTHORIZATION;

DO $archive_retained_state_assertions$
BEGIN
  IF (SELECT pg_catalog.array_agg(checkpoint.state ORDER BY checkpoint.ordinal)
      FROM public.local_projection_archive_operation_checkpoints checkpoint
      WHERE checkpoint.operation_id = pg_catalog.current_setting(
        'forge.proof.archive_operation_id'
      )::uuid) IS DISTINCT FROM ARRAY['validated','quiesced','archived']::text[]
     OR NOT EXISTS (
       SELECT 1
       FROM public.local_projection_archive_operations operation
       JOIN public.local_projection_archive_operation_checkpoints checkpoint
         ON checkpoint.operation_id = operation.id
       WHERE operation.source_task_id = '27000000-0000-4000-8000-00000000a003'
         AND operation.state = 'cancelled'
       GROUP BY operation.id
       HAVING pg_catalog.array_agg(checkpoint.state ORDER BY checkpoint.ordinal)
         = ARRAY['validated','cancelled']::text[]
     ) THEN
    RAISE EXCEPTION 'Archive or cancellation checkpoints were not retained exactly';
  END IF;
END;
$archive_retained_state_assertions$;

-- Retained checkpoints are immutable even to the owning NOLOGIN routine role;
-- archive operation rows remain mutable only through the fixed-path CAS routines.
SET SESSION AUTHORIZATION forge_s4_routines_owner;
DO $archive_mutation_rejection$
BEGIN
  BEGIN
    UPDATE public.local_projection_archive_operation_checkpoints
    SET state = 'cancelled'
    WHERE operation_id = pg_catalog.current_setting(
      'forge.proof.archive_operation_id'
    )::uuid AND ordinal = 1;
    RAISE EXCEPTION 'Direct checkpoint mutation was accepted';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN
    NULL;
  END;
  BEGIN
    DELETE FROM public.local_projection_archive_operation_checkpoints
    WHERE operation_id = pg_catalog.current_setting(
      'forge.proof.archive_operation_id'
    )::uuid AND ordinal = 1;
    RAISE EXCEPTION 'Direct checkpoint deletion was accepted';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN
    NULL;
  END;
END;
$archive_mutation_rejection$;
RESET SESSION AUTHORIZATION;

-- Release-pinned maximum-cardinality aggregate budget: one 256-package task,
-- all 2,048 fixed heads, one warm-up, then 1,000 timed validations. Deliberate
-- lock wait is excluded because this session owns no competing locks.
INSERT INTO public.tasks (
  id, project_id, submitted_by, title, prompt, status
) VALUES (
  '27000000-0000-4000-8000-00000000c001',
  '27000000-0000-4000-8000-000000000010',
  '27000000-0000-4000-8000-000000000001',
  'Maximum projection benchmark', 'archive proof', 'approved'
);
INSERT INTO public.work_packages (
  id, task_id, assigned_role, title, summary, status, sequence
)
SELECT pg_catalog.gen_random_uuid(),
  '27000000-0000-4000-8000-00000000c001'::uuid,
  'backend', 'Benchmark package ' || ordinal::text,
  'archive proof', 'pending', ordinal
FROM pg_catalog.generate_series(1, 256) ordinal;

SET SESSION AUTHORIZATION forge_local_projection_archiver;
CREATE TEMP TABLE archive_validation_latencies_ms (latency_ms double precision NOT NULL);
DO $archive_performance_assertions$
DECLARE
  v_started timestamptz;
  v_p95 double precision;
  v_p99 double precision;
BEGIN
  PERFORM 1 FROM forge.inspect_local_projection_overlimit_v2(
    '27000000-0000-4000-8000-00000000c001'
  );
  FOR iteration IN 1..1000 LOOP
    v_started := pg_catalog.clock_timestamp();
    PERFORM 1 FROM forge.inspect_local_projection_overlimit_v2(
      '27000000-0000-4000-8000-00000000c001'
    );
    INSERT INTO archive_validation_latencies_ms (latency_ms)
    VALUES (
      extract(epoch FROM pg_catalog.clock_timestamp() - v_started)
        * 1000.0
    );
  END LOOP;
  SELECT
    pg_catalog.percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms),
    pg_catalog.percentile_cont(0.99) WITHIN GROUP (ORDER BY latency_ms)
  INTO STRICT v_p95, v_p99
  FROM archive_validation_latencies_ms;
  IF v_p95 > 40 OR v_p99 > 100 THEN
    RAISE EXCEPTION 'Maximum projection benchmark exceeded budget: p95=%ms p99=%ms',
      pg_catalog.round(v_p95::numeric, 3), pg_catalog.round(v_p99::numeric, 3);
  END IF;
  RAISE NOTICE 'Maximum projection benchmark passed: p95=%ms p99=%ms',
    pg_catalog.round(v_p95::numeric, 3), pg_catalog.round(v_p99::numeric, 3);
END;
$archive_performance_assertions$;
RESET SESSION AUTHORIZATION;
