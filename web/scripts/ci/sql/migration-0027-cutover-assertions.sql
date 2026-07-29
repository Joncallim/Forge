DO $assertions$
BEGIN
  IF NOT (SELECT attnotnull FROM pg_catalog.pg_attribute
          WHERE attrelid = 'public.projects'::pg_catalog.regclass AND attname = 'root_ref')
     OR EXISTS (SELECT 1 FROM public.projects WHERE root_ref IS NULL)
     OR NOT EXISTS (
       SELECT 1 FROM public.project_root_ref_reconciliation
       WHERE singleton AND state = 'complete'
     )
     OR NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_constraint
       WHERE conrelid = 'public.projects'::pg_catalog.regclass
         AND conname = 'projects_root_ref_not_null_proof'
         AND convalidated
     ) THEN
    RAISE EXCEPTION 'The strict 0027 root_ref cutover postconditions are incomplete';
  END IF;
  IF (SELECT state FROM public.forge_epic_172_enablement_state WHERE singleton_id = 'epic-172') <> 'disabled' THEN
    RAISE EXCEPTION 'The 0027 proof changed the existing Step 0 activation authority';
  END IF;
  IF NOT (SELECT attnotnull FROM pg_catalog.pg_attribute
          WHERE attrelid = 'public.sessions'::pg_catalog.regclass
            AND attname = 'credential_digest_v1')
     OR NOT (SELECT attnotnull FROM pg_catalog.pg_attribute
             WHERE attrelid = 'public.sessions'::pg_catalog.regclass
               AND attname = 'expires_at')
     OR EXISTS (
       SELECT 1 FROM public.sessions session
       WHERE session.credential_storage_version <> 2
          OR session.legacy_redis_purge_pending_at IS NOT NULL
          OR session.credential_digest_v1 = pg_catalog.sha256(
            pg_catalog.convert_to('forge:web-session:v1', 'UTF8')
            || pg_catalog.decode('00', 'hex')
            || pg_catalog.convert_to(session.id::text, 'UTF8')
          )
     )
     OR NOT EXISTS (
       SELECT 1 FROM public.session_credential_reconciliation
       WHERE singleton AND state = 'strict'
     ) THEN
    RAISE EXCEPTION 'The strict 0027 session credential cutover postconditions are incomplete';
  END IF;
END;
$assertions$;
