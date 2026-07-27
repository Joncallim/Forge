\set ON_ERROR_STOP on
BEGIN;
CREATE TEMP TABLE root_negative_assertion_inputs (
  operation_id uuid NOT NULL,
  task_id uuid NOT NULL,
  generation bigint NOT NULL CHECK (generation > 0)
) ON COMMIT DROP;
INSERT INTO root_negative_assertion_inputs (operation_id, task_id, generation)
VALUES (:'operation_id'::uuid, :'task_id'::uuid, :'generation'::bigint);

DO $proof$
DECLARE v_operation_id uuid; v_task_id uuid; v_generation bigint;
BEGIN
  SELECT operation_id, task_id, generation INTO STRICT v_operation_id, v_task_id, v_generation
  FROM root_negative_assertion_inputs;
  IF EXISTS (SELECT 1 FROM public.tasks WHERE id=v_task_id AND status <> 'running')
     OR EXISTS (SELECT 1 FROM public.project_root_reconciliation_write_contexts WHERE operation_id=v_operation_id AND generation=v_generation)
     OR EXISTS (SELECT 1 FROM public.project_root_reconciliation_outcomes WHERE operation_id=v_operation_id AND generation=v_generation)
     OR NOT EXISTS (SELECT 1 FROM public.project_root_reconciliation_operations WHERE operation_id=v_operation_id AND state='running' AND last_processed_generation=0)
     OR NOT EXISTS (SELECT 1 FROM public.project_root_reconciliation_checkpoints WHERE operation_id=v_operation_id AND checkpoint_generation=0 AND last_processed_generation=0) THEN
    RAISE EXCEPTION 'negative context rollback advanced protected reconciliation state';
  END IF;
END;
$proof$;
COMMIT;
