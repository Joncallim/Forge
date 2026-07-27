\set ON_ERROR_STOP on
DO $proof$
BEGIN
  IF EXISTS (SELECT 1 FROM public.tasks WHERE id=:'task_id'::uuid AND status <> 'running')
     OR EXISTS (SELECT 1 FROM public.project_root_reconciliation_write_contexts WHERE operation_id=:'operation_id'::uuid AND generation=:'generation'::bigint)
     OR EXISTS (SELECT 1 FROM public.project_root_reconciliation_outcomes WHERE operation_id=:'operation_id'::uuid AND generation=:'generation'::bigint)
     OR NOT EXISTS (SELECT 1 FROM public.project_root_reconciliation_operations WHERE operation_id=:'operation_id'::uuid AND state='running' AND last_processed_generation=0)
     OR NOT EXISTS (SELECT 1 FROM public.project_root_reconciliation_checkpoints WHERE operation_id=:'operation_id'::uuid AND checkpoint_generation=0 AND last_processed_generation=0) THEN
    RAISE EXCEPTION 'negative context rollback advanced protected reconciliation state';
  END IF;
END;
$proof$;
