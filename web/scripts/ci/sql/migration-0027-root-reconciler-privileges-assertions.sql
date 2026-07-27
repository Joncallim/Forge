\set ON_ERROR_STOP on
DO $proof$
DECLARE r pg_catalog.pg_roles%ROWTYPE;
BEGIN
  SELECT * INTO STRICT r FROM pg_catalog.pg_roles WHERE rolname='forge_project_root_reconciler';
  IF NOT r.rolcanlogin OR r.rolinherit OR r.rolsuper OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication OR r.rolbypassrls
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members WHERE member='forge_project_root_reconciler'::regrole OR roleid='forge_project_root_reconciler'::regrole) THEN
    RAISE EXCEPTION 'root reconciler role attributes or memberships exceed the closed contract';
  END IF;
  IF NOT has_table_privilege('forge_project_root_reconciler','public.projects','SELECT')
     OR NOT has_table_privilege('forge_project_root_reconciler','public.tasks','SELECT')
     OR NOT has_column_privilege('forge_project_root_reconciler','public.tasks','status','UPDATE')
     OR NOT has_column_privilege('forge_project_root_reconciler','public.work_packages','metadata','UPDATE')
     OR has_table_privilege('forge_project_root_reconciler','public.tasks','INSERT, DELETE, TRUNCATE, UPDATE')
     OR has_table_privilege('forge_project_root_reconciler','public.project_root_reconciliation_write_contexts','SELECT, INSERT, UPDATE, DELETE')
     OR has_function_privilege('forge_project_root_reconciler','forge.enter_project_root_reconciliation_generation_v1(uuid,uuid,bigint,uuid)','EXECUTE') IS NOT TRUE
     OR has_function_privilege('forge_project_root_reconciler','forge.lock_project_root_reconciliation_authority_v1(uuid,uuid,bigint,uuid)','EXECUTE') IS NOT TRUE
     OR has_function_privilege('forge_app_test','forge.enter_project_root_reconciliation_generation_v1(uuid,uuid,bigint,uuid)','EXECUTE')
  THEN RAISE EXCEPTION 'root reconciler catalog privileges do not match the closed runtime contract'; END IF;
END;
$proof$;
