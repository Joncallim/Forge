-- Epic 172 / issue 179 (remaining S4): protected Architect history, bounded
-- executable references, and the disabled-by-default packet-issuance claim.
--
-- This migration is additive. S4 producers remain disabled until the signed
-- runtime activation graph enables the matching S4/S5 build and protocol epoch.

SELECT public.forge_begin_epic_172_s4_owner_bootstrap_v1();
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles
    WHERE rolname = 'forge_s4_routines_owner'
      AND NOT rolcanlogin AND NOT rolinherit AND NOT rolsuper
  ) THEN
    RAISE EXCEPTION 'forge_s4_routines_owner must be bootstrapped as NOLOGIN NOINHERIT before migration'
      USING ERRCODE = '42501';
  END IF;
  IF NOT pg_catalog.pg_has_role(current_user, 'forge_s4_routines_owner', 'MEMBER') THEN
    RAISE EXCEPTION 'migration role must be temporarily authorized to transfer S4 objects'
      USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles
    WHERE rolname = 'forge_architect_plan_writer' AND rolcanlogin AND NOT rolinherit AND NOT rolsuper
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles
    WHERE rolname = 'forge_architect_plan_resolver' AND rolcanlogin AND NOT rolinherit AND NOT rolsuper
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles
    WHERE rolname = 'forge_packet_issuer' AND rolcanlogin AND NOT rolinherit AND NOT rolsuper
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles
    WHERE rolname = 'forge_architect_plan_history_reader' AND rolcanlogin AND NOT rolinherit AND NOT rolsuper
  ) THEN
    RAISE EXCEPTION 'dedicated S4 logins must be bootstrapped before migration'
      USING ERRCODE = '42501';
  END IF;
END;
$$;
--> statement-breakpoint
-- Session credential expansion. Existing rows remain legacy rows until the
-- Redis-backed reconciliation command captures their exact absolute expiry.
-- The migration must not invent a new lifetime or erase the old Redis key.
ALTER TABLE public.sessions
  ADD COLUMN IF NOT EXISTS credential_digest_v1 bytea,
  ADD COLUMN IF NOT EXISTS expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS credential_storage_version integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS legacy_redis_purge_pending_at timestamptz,
  ADD COLUMN IF NOT EXISTS legacy_redis_invalidated_at timestamptz;
--> statement-breakpoint
CREATE TABLE public.session_credential_reconciliation (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  state text NOT NULL DEFAULT 'expansion'
    CHECK (state IN ('expansion','draining','strict')),
  rows_migrated bigint NOT NULL DEFAULT 0 CHECK (rows_migrated >= 0),
  rows_revoked bigint NOT NULL DEFAULT 0 CHECK (rows_revoked >= 0),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp()
);
INSERT INTO public.session_credential_reconciliation (singleton) VALUES (true);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION forge.guard_session_credential_cutover_v1()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_state text;
BEGIN
  SELECT reconciliation.state INTO STRICT v_state
  FROM public.session_credential_reconciliation reconciliation
  WHERE reconciliation.singleton
  FOR KEY SHARE;

  IF TG_OP = 'INSERT' AND NEW.credential_storage_version < 2
     AND v_state <> 'expansion' THEN
    RAISE EXCEPTION 'Legacy-compatible session creation is closed for credential drain'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'UPDATE'
     AND NEW.credential_storage_version < OLD.credential_storage_version THEN
    RAISE EXCEPTION 'Session credential storage version cannot move backward'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.credential_storage_version = 0 AND (
       NEW.credential_digest_v1 IS NOT NULL OR NEW.expires_at IS NOT NULL
     ) THEN
    RAISE EXCEPTION 'An unreconciled legacy session cannot claim database credential authority'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.credential_storage_version = 1 AND (
       NEW.credential_digest_v1 IS NULL OR NEW.expires_at IS NULL
       OR NEW.credential_digest_v1 <> pg_catalog.sha256(
         pg_catalog.convert_to('forge:web-session:v1', 'UTF8')
         || pg_catalog.decode('00', 'hex')
         || pg_catalog.convert_to(NEW.id::text, 'UTF8')
       )
     ) THEN
    RAISE EXCEPTION 'A dual-format session must bind its raw ID to the exact digest and expiry'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.credential_storage_version = 2 AND (
       NEW.credential_digest_v1 IS NULL OR NEW.expires_at IS NULL
       OR NEW.legacy_redis_purge_pending_at IS NOT NULL
     ) THEN
    RAISE EXCEPTION 'A digest-only session must have complete database authority and no pending legacy key'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER sessions_credential_cutover_guard_v1
  BEFORE INSERT OR UPDATE OF id, credential_digest_v1, expires_at,
    credential_storage_version, legacy_redis_purge_pending_at
  ON public.sessions
  FOR EACH ROW EXECUTE FUNCTION forge.guard_session_credential_cutover_v1();
--> statement-breakpoint
ALTER TABLE public.sessions
  ADD CONSTRAINT sessions_credential_digest_v1_length_chk
  CHECK (
    credential_digest_v1 IS NULL
    OR pg_catalog.octet_length(credential_digest_v1) = 32
  ) NOT VALID,
  ADD CONSTRAINT sessions_credential_storage_version_chk
  CHECK (credential_storage_version IN (0,1,2)) NOT VALID;
--> statement-breakpoint
CREATE UNIQUE INDEX sessions_credential_digest_v1_idx
  ON public.sessions (credential_digest_v1)
  WHERE credential_digest_v1 IS NOT NULL;
--> statement-breakpoint
CREATE SCHEMA IF NOT EXISTS forge;
--> statement-breakpoint
-- Expand first without a default or table rewrite. Existing 0026 rows remain
-- nullable until the separately invoked reconciliation command processes them.
ALTER TABLE public.projects
  ADD COLUMN root_ref uuid;
--> statement-breakpoint
-- Omitted values are safe for new writers. The insert bridge also handles an
-- explicitly supplied NULL during the mixed-version window.
ALTER TABLE public.projects
  ALTER COLUMN root_ref SET DEFAULT pg_catalog.gen_random_uuid();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION forge.fill_project_root_ref_on_insert_v1()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.root_ref IS NULL THEN
    NEW.root_ref := pg_catalog.gen_random_uuid();
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER projects_root_ref_insert_bridge_v1
  BEFORE INSERT ON public.projects
  FOR EACH ROW EXECUTE FUNCTION forge.fill_project_root_ref_on_insert_v1();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION forge.guard_project_root_ref_renull_v1()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF OLD.root_ref IS NOT NULL AND NEW.root_ref IS NULL THEN
    RAISE EXCEPTION 'A populated project root reference cannot be cleared'
      USING ERRCODE = '23502';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER projects_root_ref_renull_guard_v1
  BEFORE UPDATE OF root_ref ON public.projects
  FOR EACH ROW EXECUTE FUNCTION forge.guard_project_root_ref_renull_v1();
--> statement-breakpoint
CREATE UNIQUE INDEX projects_root_ref_idx ON public.projects (root_ref);
--> statement-breakpoint
CREATE TABLE public.project_root_ref_reconciliation (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  last_project_id uuid,
  rows_updated bigint NOT NULL DEFAULT 0 CHECK (rows_updated >= 0),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','running','complete')),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp()
);
INSERT INTO public.project_root_ref_reconciliation (singleton) VALUES (true);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION forge.reconcile_project_root_refs_v1(p_batch_size integer)
RETURNS TABLE (batch_rows integer, remaining_nulls bigint, reconciliation_state text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_checkpoint public.project_root_ref_reconciliation%ROWTYPE;
  v_rows integer;
  v_remaining bigint;
  v_last_id uuid;
BEGIN
  IF p_batch_size NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'root-reference batch size must be between 1 and 1000'
      USING ERRCODE = '22023';
  END IF;

  SELECT checkpoint.* INTO STRICT v_checkpoint
  FROM public.project_root_ref_reconciliation checkpoint
  WHERE checkpoint.singleton
  FOR UPDATE;

  WITH candidates AS (
    SELECT project.id
    FROM public.projects project
    WHERE project.root_ref IS NULL
      AND (v_checkpoint.last_project_id IS NULL OR project.id > v_checkpoint.last_project_id)
    ORDER BY project.id
    LIMIT p_batch_size
    FOR UPDATE
  ), populated AS (
    UPDATE public.projects project
    SET root_ref = pg_catalog.gen_random_uuid()
    FROM candidates
    WHERE project.id = candidates.id
      AND project.root_ref IS NULL
    RETURNING project.id
  )
  SELECT pg_catalog.count(*)::integer,
    (pg_catalog.array_agg(id ORDER BY id DESC))[1]
  INTO v_rows, v_last_id
  FROM populated;

  SELECT pg_catalog.count(*) INTO v_remaining
  FROM public.projects project
  WHERE project.root_ref IS NULL;

  UPDATE public.project_root_ref_reconciliation checkpoint
  SET last_project_id = CASE
        WHEN v_remaining = 0 THEN checkpoint.last_project_id
        WHEN v_rows > 0 THEN v_last_id
        ELSE NULL
      END,
      rows_updated = checkpoint.rows_updated + v_rows,
      state = CASE WHEN v_remaining = 0 THEN 'complete' ELSE 'running' END,
      updated_at = pg_catalog.clock_timestamp()
  WHERE checkpoint.singleton;

  RETURN QUERY SELECT v_rows, v_remaining,
    CASE WHEN v_remaining = 0 THEN 'complete'::text ELSE 'running'::text END;
END;
$$;
--> statement-breakpoint
CREATE TABLE public.architect_plan_versions (
  task_id uuid NOT NULL,
  plan_artifact_id uuid NOT NULL,
  plan_version bigint NOT NULL,
  digest_key_id text NOT NULL,
  entry_count integer NOT NULL,
  entry_set_digest text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  PRIMARY KEY (task_id, plan_version),
  UNIQUE (plan_artifact_id, plan_version),
  CONSTRAINT architect_plan_versions_task_fk
    FOREIGN KEY (task_id) REFERENCES public.tasks(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT architect_plan_versions_artifact_fk
    FOREIGN KEY (plan_artifact_id) REFERENCES public.artifacts(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT architect_plan_versions_version_chk CHECK (plan_version > 0),
  CONSTRAINT architect_plan_versions_key_chk CHECK (digest_key_id ~ '^[a-z0-9._-]{1,64}$'),
  CONSTRAINT architect_plan_versions_count_chk CHECK (entry_count BETWEEN 1 AND 256),
  CONSTRAINT architect_plan_versions_digest_chk CHECK (entry_set_digest ~ '^hmac-sha256:[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE public.architect_plan_entries (
  task_id uuid NOT NULL,
  plan_artifact_id uuid NOT NULL,
  plan_version bigint NOT NULL,
  entry_id text NOT NULL,
  entry_kind text NOT NULL,
  agent text,
  requirement_key text,
  binding_fingerprint text,
  content text NOT NULL,
  content_digest text NOT NULL,
  digest_key_id text NOT NULL,
  projection_eligible boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  PRIMARY KEY (task_id, plan_version, entry_id),
  CONSTRAINT architect_plan_entries_version_fk
    FOREIGN KEY (task_id, plan_version)
    REFERENCES public.architect_plan_versions(task_id, plan_version)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT architect_plan_entries_artifact_version_fk
    FOREIGN KEY (plan_artifact_id, plan_version)
    REFERENCES public.architect_plan_versions(plan_artifact_id, plan_version)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT architect_plan_entries_id_chk CHECK (
    pg_catalog.length(entry_id) BETWEEN 1 AND 256 AND entry_id ~ '^[a-z0-9._:-]+$'
  ),
  CONSTRAINT architect_plan_entries_kind_chk CHECK (entry_kind IN ('plan_body','requirement','overlay','subtask','legacy_full_plan')),
  CONSTRAINT architect_plan_entries_agent_chk CHECK (agent IS NULL OR agent ~ '^[a-z0-9._-]{1,64}$'),
  CONSTRAINT architect_plan_entries_requirement_chk CHECK (requirement_key IS NULL OR requirement_key ~ '^[a-z0-9._-]{1,64}$'),
  CONSTRAINT architect_plan_entries_binding_chk CHECK (binding_fingerprint IS NULL OR binding_fingerprint ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT architect_plan_entries_content_chk CHECK (pg_catalog.octet_length(content) BETWEEN 1 AND 65536),
  CONSTRAINT architect_plan_entries_digest_chk CHECK (content_digest ~ '^hmac-sha256:[0-9a-f]{64}$'),
  CONSTRAINT architect_plan_entries_key_chk CHECK (digest_key_id ~ '^[a-z0-9._-]{1,64}$'),
  CONSTRAINT architect_plan_entries_legacy_chk CHECK (entry_kind <> 'legacy_full_plan' OR NOT projection_eligible)
);
--> statement-breakpoint
CREATE TABLE public.architect_plan_execution_references (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  purpose text NOT NULL DEFAULT 'package_specialist',
  task_id uuid NOT NULL,
  work_package_id uuid,
  agent_run_id uuid NOT NULL,
  plan_artifact_id uuid NOT NULL,
  plan_version bigint NOT NULL,
  entry_id text NOT NULL,
  agent text NOT NULL,
  requirement_key text,
  binding_fingerprint text,
  content_digest text NOT NULL,
  digest_key_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  resolved_at timestamptz,
  CONSTRAINT architect_plan_execution_references_task_fk
    FOREIGN KEY (task_id) REFERENCES public.tasks(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT architect_plan_execution_references_package_fk
    FOREIGN KEY (work_package_id) REFERENCES public.work_packages(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT architect_plan_execution_references_run_fk
    FOREIGN KEY (agent_run_id) REFERENCES public.agent_runs(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT architect_plan_execution_references_entry_fk
    FOREIGN KEY (task_id, plan_version, entry_id)
    REFERENCES public.architect_plan_entries(task_id, plan_version, entry_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT architect_plan_execution_references_id_chk CHECK (
    pg_catalog.length(entry_id) BETWEEN 1 AND 256 AND entry_id ~ '^[a-z0-9._:-]+$'
  ),
  CONSTRAINT architect_plan_execution_references_agent_chk CHECK (agent ~ '^[a-z0-9._-]{1,64}$'),
  CONSTRAINT architect_plan_execution_references_requirement_chk CHECK (requirement_key IS NULL OR requirement_key ~ '^[a-z0-9._-]{1,64}$'),
  CONSTRAINT architect_plan_execution_references_binding_chk CHECK (binding_fingerprint IS NULL OR binding_fingerprint ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT architect_plan_execution_references_digest_chk CHECK (content_digest ~ '^hmac-sha256:[0-9a-f]{64}$'),
  CONSTRAINT architect_plan_execution_references_key_chk CHECK (digest_key_id ~ '^[a-z0-9._-]{1,64}$'),
  CONSTRAINT architect_plan_execution_references_purpose_chk CHECK (
    purpose IN ('package_specialist', 'architect_replan')
  ),
  CONSTRAINT architect_plan_execution_references_purpose_shape_chk CHECK (
    (purpose = 'package_specialist' AND work_package_id IS NOT NULL)
    OR (
      purpose = 'architect_replan'
      AND work_package_id IS NULL
      AND agent = 'architect'
      AND entry_id = 'plan_body:000000'
      AND requirement_key IS NULL
      AND binding_fingerprint IS NULL
    )
  ),
  UNIQUE (agent_run_id, entry_id)
);
--> statement-breakpoint
CREATE INDEX architect_plan_execution_references_package_idx
  ON public.architect_plan_execution_references (work_package_id, agent_run_id);
--> statement-breakpoint
CREATE TABLE public.architect_plan_history_reads (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  request_id uuid NOT NULL UNIQUE,
  user_id uuid NOT NULL,
  task_id uuid NOT NULL,
  plan_version bigint NOT NULL,
  returned_entry_count integer NOT NULL,
  entry_set_digest text NOT NULL,
  read_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  CONSTRAINT architect_plan_history_reads_user_fk
    FOREIGN KEY (user_id) REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT architect_plan_history_reads_version_fk
    FOREIGN KEY (task_id, plan_version)
    REFERENCES public.architect_plan_versions(task_id, plan_version)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT architect_plan_history_reads_count_chk CHECK (returned_entry_count BETWEEN 0 AND 256),
  CONSTRAINT architect_plan_history_reads_digest_chk CHECK (entry_set_digest ~ '^hmac-sha256:[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION forge.reject_s4_retained_mutation_v1()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'S4 protected history is append-only' USING ERRCODE = '55000';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER architect_plan_versions_append_only
  BEFORE UPDATE OR DELETE ON public.architect_plan_versions
  FOR EACH ROW EXECUTE FUNCTION forge.reject_s4_retained_mutation_v1();
CREATE TRIGGER architect_plan_entries_append_only
  BEFORE UPDATE OR DELETE ON public.architect_plan_entries
  FOR EACH ROW EXECUTE FUNCTION forge.reject_s4_retained_mutation_v1();
CREATE TRIGGER architect_plan_history_reads_append_only
  BEFORE UPDATE OR DELETE ON public.architect_plan_history_reads
  FOR EACH ROW EXECUTE FUNCTION forge.reject_s4_retained_mutation_v1();
--> statement-breakpoint
-- This is a predicate over the sole Step 0 enablement authority, not a second
-- state machine. Missing/malformed rows fail closed. Provisional state must
-- still hold its database-time lease; active state has no lease requirement.
CREATE OR REPLACE FUNCTION forge.s4_protected_paths_enabled_v1()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT COALESCE((
    SELECT
      state.epoch = 2
      AND state.reviewed_sha ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'
      AND (
        SELECT pg_catalog.count(*) = 3
          AND pg_catalog.count(DISTINCT build.value) = 3
          AND pg_catalog.count(*) FILTER (
            WHERE build.value ~ '^issue_179_s4@[^@[:space:]]+$'
          ) = 1
          AND pg_catalog.count(*) FILTER (
            WHERE build.value ~ '^issue_180_s5@[^@[:space:]]+$'
          ) = 1
          AND pg_catalog.count(*) FILTER (
            WHERE build.value ~ '^issue_181_s6@[^@[:space:]]+$'
          ) = 1
        FROM pg_catalog.jsonb_array_elements_text(
          CASE
            WHEN pg_catalog.jsonb_typeof(state.exact_builds) = 'array'
              THEN state.exact_builds
            ELSE '[]'::jsonb
          END
        ) build(value)
      )
      AND (
        state.state = 'active'
        OR (
          state.state = 'provisional'
          AND pg_catalog.clock_timestamp() < state.expires_at
          AND pg_catalog.clock_timestamp() < state.lease_expires_at
        )
      )
    FROM forge.read_epic_172_enablement_state_v1() state
  ), false)
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION forge.guard_architect_plan_public_artifact_v1()
RETURNS trigger
LANGUAGE plpgsql
-- Ordinary application inserts invoke this trigger without EXECUTE on the
-- protected predicate. Keep this S4-owned bridge security-definer and pinned.
SECURITY DEFINER
SET search_path = pg_catalog, forge
AS $$
BEGIN
  IF TG_OP = 'INSERT' AND EXISTS (
    SELECT 1 FROM public.agent_runs run
    WHERE run.id = NEW.agent_run_id AND run.agent_type = 'architect'
  ) THEN
    IF forge.s4_protected_paths_enabled_v1() THEN
      IF session_user <> 'forge_architect_plan_writer'
         OR current_user <> 'forge_s4_routines_owner'
         OR NEW.artifact_type <> 'adr_text'
         OR NEW.content <> 'Architect plan available in protected history' THEN
        RAISE EXCEPTION 'Architect artifacts require the protected plan writer'
          USING ERRCODE = '42501';
      END IF;
    ELSIF EXISTS (
      SELECT 1 FROM forge.read_epic_172_enablement_state_v1() state
      WHERE state.state = 'disabled'
    ) THEN
      IF session_user = 'forge_architect_plan_writer'
         OR NEW.artifact_type <> 'adr_text' THEN
        RAISE EXCEPTION 'Protected Architect history is disabled; only legacy adr_text planning is available'
          USING ERRCODE = '55000';
      END IF;
    ELSE
      RAISE EXCEPTION 'Architect plan storage is blocked by incomplete Epic 172 enablement authority'
        USING ERRCODE = '55000';
    END IF;
  ELSIF TG_OP = 'UPDATE' AND EXISTS (
    SELECT 1 FROM public.architect_plan_versions version
    WHERE version.plan_artifact_id = OLD.id
  ) AND (
    NEW.agent_run_id IS DISTINCT FROM OLD.agent_run_id
    OR NEW.artifact_type IS DISTINCT FROM OLD.artifact_type
    OR NEW.content IS DISTINCT FROM 'Architect plan available in protected history'
  ) THEN
    RAISE EXCEPTION 'Protected Architect artifact identity and public header are immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER artifacts_architect_plan_public_guard
  BEFORE INSERT OR UPDATE ON public.artifacts
  FOR EACH ROW EXECUTE FUNCTION forge.guard_architect_plan_public_artifact_v1();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION forge.read_architect_plan_history_v1(
  p_session_credential bytea,
  p_task_id uuid,
  p_plan_version bigint
)
RETURNS TABLE (
  entry_id text,
  entry_kind text,
  agent text,
  requirement_key text,
  binding_fingerprint text,
  content text,
  content_digest text,
  digest_key_id text,
  projection_eligible boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, forge
AS $$
DECLARE
  v_credential_text text;
  v_credential_digest bytea;
  v_session public.sessions%ROWTYPE;
  v_version public.architect_plan_versions%ROWTYPE;
  v_request_id uuid := pg_catalog.gen_random_uuid();
BEGIN
  IF session_user <> 'forge_architect_plan_history_reader' THEN
    RAISE EXCEPTION 'Architect plan history requires the dedicated reader login'
      USING ERRCODE = '42501';
  END IF;
  IF NOT forge.s4_protected_paths_enabled_v1() THEN
    RAISE EXCEPTION 'Protected Architect history is not enabled by the Step 0 authority'
      USING ERRCODE = '55000';
  END IF;
  IF pg_catalog.octet_length(p_session_credential) <> 36 THEN
    RAISE EXCEPTION 'Session credential is malformed' USING ERRCODE = '22023';
  END IF;
  v_credential_text := pg_catalog.convert_from(p_session_credential, 'UTF8');
  IF v_credential_text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR pg_catalog.convert_to(v_credential_text, 'UTF8') <> p_session_credential THEN
    RAISE EXCEPTION 'Session credential is malformed' USING ERRCODE = '22023';
  END IF;

  v_credential_digest := pg_catalog.sha256(
    pg_catalog.decode('666f7267653a7765622d73657373696f6e3a763100', 'hex') || p_session_credential
  );
  SELECT session_row.* INTO STRICT v_session
  FROM public.sessions session_row
  WHERE session_row.credential_digest_v1 = v_credential_digest
  FOR UPDATE;
  IF v_session.revoked_at IS NOT NULL
     OR v_session.expires_at IS NULL
     OR pg_catalog.clock_timestamp() >= v_session.expires_at THEN
    RAISE EXCEPTION 'Session credential is revoked or expired' USING ERRCODE = '28000';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.tasks task
    WHERE task.id = p_task_id AND task.submitted_by = v_session.user_id
    FOR KEY SHARE
  ) THEN
    RAISE EXCEPTION 'Task history is not accessible to this session' USING ERRCODE = '42501';
  END IF;
  SELECT version_row.* INTO STRICT v_version
  FROM public.architect_plan_versions version_row
  WHERE version_row.task_id = p_task_id
    AND version_row.plan_version = p_plan_version;

  INSERT INTO public.architect_plan_history_reads (
    request_id, user_id, task_id, plan_version, returned_entry_count, entry_set_digest
  ) VALUES (
    v_request_id, v_session.user_id, p_task_id, p_plan_version,
    v_version.entry_count, v_version.entry_set_digest
  );

  -- Re-check against database time immediately before any protected history is
  -- returned. The first check does not authorize a response that crossed its
  -- expiry boundary while the plan and audit rows were being prepared.
  PERFORM 1 FROM public.sessions session_row
  WHERE session_row.id = v_session.id
    AND session_row.credential_digest_v1 = v_credential_digest
    AND session_row.revoked_at IS NULL
    AND session_row.expires_at IS NOT NULL
    AND pg_catalog.clock_timestamp() < session_row.expires_at
  FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Session credential expired before history delivery'
      USING ERRCODE = '28000';
  END IF;

  RETURN QUERY
  SELECT plan_entry.entry_id, plan_entry.entry_kind, plan_entry.agent,
    plan_entry.requirement_key, plan_entry.binding_fingerprint,
    plan_entry.content, plan_entry.content_digest, plan_entry.digest_key_id,
    plan_entry.projection_eligible
  FROM public.architect_plan_entries plan_entry
  WHERE plan_entry.task_id = p_task_id
    AND plan_entry.plan_version = p_plan_version
  ORDER BY plan_entry.entry_id
  LIMIT 256;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION forge.resolve_architect_plan_entry_v1(p_reference_id uuid)
RETURNS TABLE (
  purpose text,
  task_id uuid,
  plan_artifact_id uuid,
  plan_version bigint,
  entry_id text,
  entry_kind text,
  agent text,
  requirement_key text,
  binding_fingerprint text,
  content text,
  content_digest text,
  digest_key_id text,
  projection_eligible boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF session_user <> 'forge_architect_plan_resolver' THEN
    RAISE EXCEPTION 'Architect plan resolution requires the dedicated resolver login'
      USING ERRCODE = '42501';
  END IF;
  IF NOT forge.s4_protected_paths_enabled_v1() THEN
    RAISE EXCEPTION 'Protected Architect plan resolution is not enabled by the Step 0 authority'
      USING ERRCODE = '55000';
  END IF;

  RETURN QUERY
  WITH locked_reference AS (
    SELECT reference.*
    FROM public.architect_plan_execution_references reference
    WHERE reference.id = p_reference_id
      AND reference.resolved_at IS NULL
    FOR UPDATE
  ), authorized AS (
    SELECT reference.id, reference.purpose, reference.task_id,
      reference.plan_artifact_id, reference.plan_version,
      entry.entry_id, entry.entry_kind, entry.agent,
      entry.requirement_key, entry.binding_fingerprint, entry.content,
      entry.content_digest, entry.digest_key_id, entry.projection_eligible
    FROM locked_reference reference
    JOIN public.agent_runs run
      ON run.id = reference.agent_run_id
     AND run.task_id = reference.task_id
     AND run.status = 'running'
    LEFT JOIN public.work_packages package
      ON package.id = reference.work_package_id
     AND package.task_id = reference.task_id
    JOIN public.architect_plan_entries entry
      ON entry.task_id = reference.task_id
     AND entry.plan_artifact_id = reference.plan_artifact_id
     AND entry.plan_version = reference.plan_version
     AND entry.entry_id = reference.entry_id
     AND entry.requirement_key IS NOT DISTINCT FROM reference.requirement_key
     AND entry.binding_fingerprint IS NOT DISTINCT FROM reference.binding_fingerprint
     AND entry.content_digest = reference.content_digest
     AND entry.digest_key_id = reference.digest_key_id
    WHERE (
      reference.purpose = 'package_specialist'
      AND reference.work_package_id IS NOT NULL
      AND run.work_package_id = reference.work_package_id
      AND package.assigned_role = reference.agent
      AND entry.agent IS NOT DISTINCT FROM reference.agent
      AND entry.projection_eligible
    ) OR (
      reference.purpose = 'architect_replan'
      AND reference.work_package_id IS NULL
      AND run.work_package_id IS NULL
      AND run.agent_type = 'architect'
      AND reference.agent = 'architect'
      AND entry.entry_kind = 'plan_body'
      AND entry.entry_id = 'plan_body:000000'
      AND entry.agent IS NULL
      AND entry.requirement_key IS NULL
      AND entry.binding_fingerprint IS NULL
      AND NOT entry.projection_eligible
    )
  ), marked AS (
    UPDATE public.architect_plan_execution_references reference
    SET resolved_at = pg_catalog.clock_timestamp()
    FROM authorized
    WHERE reference.id = authorized.id
    RETURNING authorized.*
  )
  SELECT marked.purpose, marked.task_id, marked.plan_artifact_id,
    marked.plan_version, marked.entry_id, marked.entry_kind, marked.agent,
    marked.requirement_key, marked.binding_fingerprint, marked.content,
    marked.content_digest, marked.digest_key_id, marked.projection_eligible
  FROM marked;
END;
$$;
--> statement-breakpoint
CREATE TABLE public.work_package_local_run_evidence (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  task_id uuid NOT NULL,
  work_package_id uuid NOT NULL,
  agent_run_id uuid NOT NULL UNIQUE,
  claim_token uuid NOT NULL UNIQUE,
  claim_generation bigint NOT NULL DEFAULT 1,
  last_heartbeat_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  lease_expires_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'claimed',
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  terminal jsonb,
  completion_artifact_id uuid REFERENCES public.artifacts(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  terminal_at timestamptz,
  CONSTRAINT work_package_local_run_evidence_task_fk
    FOREIGN KEY (task_id) REFERENCES public.tasks(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT work_package_local_run_evidence_package_fk
    FOREIGN KEY (work_package_id) REFERENCES public.work_packages(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT work_package_local_run_evidence_run_fk
    FOREIGN KEY (agent_run_id) REFERENCES public.agent_runs(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT work_package_local_run_evidence_state_chk CHECK (state IN ('claimed','terminal','uncertain')),
  CONSTRAINT work_package_local_run_evidence_generation_chk CHECK (claim_generation > 0),
  CONSTRAINT work_package_local_run_evidence_lease_chk CHECK (lease_expires_at > last_heartbeat_at),
  CONSTRAINT work_package_local_run_evidence_terminal_chk CHECK (
    (state = 'claimed' AND terminal IS NULL AND terminal_at IS NULL)
    OR (state IN ('terminal','uncertain') AND terminal IS NOT NULL AND terminal_at IS NOT NULL)
  ),
  CONSTRAINT work_package_local_run_evidence_identity_key
    UNIQUE (id, task_id, work_package_id, agent_run_id)
);
--> statement-breakpoint
CREATE TABLE public.filesystem_mcp_decision_nonce_claims (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  grant_approval_id uuid NOT NULL,
  grant_decision_nonce uuid NOT NULL UNIQUE,
  runtime_audit_id uuid NOT NULL UNIQUE,
  claimed_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  CONSTRAINT filesystem_mcp_decision_nonce_claims_approval_fk
    FOREIGN KEY (grant_approval_id) REFERENCES public.filesystem_mcp_grant_approvals(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT filesystem_mcp_decision_nonce_claims_audit_fk
    FOREIGN KEY (runtime_audit_id) REFERENCES public.filesystem_mcp_runtime_audits(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
);
--> statement-breakpoint
ALTER TABLE public.filesystem_mcp_runtime_audits
  ADD COLUMN protocol_version integer,
  ADD COLUMN local_run_evidence_id uuid,
  ADD COLUMN claim_token uuid,
  ADD COLUMN claim_generation bigint,
  ADD COLUMN last_heartbeat_at timestamptz,
  ADD COLUMN lease_expires_at timestamptz,
  ADD COLUMN authorization_snapshot jsonb,
  ADD COLUMN authorization_source text,
  ADD COLUMN grant_mode text,
  ADD COLUMN grant_decision_revision bigint,
  ADD COLUMN grant_decision_nonce uuid,
  ADD COLUMN authorization_root_binding_revision bigint,
  ADD COLUMN project_decision_id uuid,
  ADD COLUMN completion_artifact_id uuid,
  ADD COLUMN assembly jsonb,
  ADD COLUMN delivery jsonb,
  ADD COLUMN terminal jsonb,
  ADD COLUMN terminal_at timestamptz;
--> statement-breakpoint
ALTER TABLE public.filesystem_mcp_grant_approvals
  ADD CONSTRAINT filesystem_mcp_grant_approvals_packet_identity_key
    UNIQUE (id, task_id, work_package_id, grant_decision_revision, grant_nonce);
--> statement-breakpoint
ALTER TABLE public.filesystem_mcp_runtime_audits
  ADD CONSTRAINT filesystem_mcp_runtime_audits_local_evidence_fk
    FOREIGN KEY (local_run_evidence_id) REFERENCES public.work_package_local_run_evidence(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  ADD CONSTRAINT filesystem_mcp_runtime_audits_project_decision_fk
    FOREIGN KEY (project_decision_id) REFERENCES public.project_filesystem_grant_decisions(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  ADD CONSTRAINT filesystem_mcp_runtime_audits_completion_artifact_fk
    FOREIGN KEY (completion_artifact_id) REFERENCES public.artifacts(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  ADD CONSTRAINT filesystem_mcp_runtime_audits_local_identity_fk
    FOREIGN KEY (local_run_evidence_id, task_id, work_package_id, agent_run_id)
    REFERENCES public.work_package_local_run_evidence(id, task_id, work_package_id, agent_run_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  ADD CONSTRAINT filesystem_mcp_runtime_audits_package_authority_fk
    FOREIGN KEY (
      grant_approval_id, task_id, work_package_id,
      grant_decision_revision, grant_decision_nonce
    ) REFERENCES public.filesystem_mcp_grant_approvals(
      id, task_id, work_package_id, grant_decision_revision, grant_nonce
    ) MATCH SIMPLE ON UPDATE RESTRICT ON DELETE RESTRICT,
  ADD CONSTRAINT filesystem_mcp_runtime_audits_protocol_v2_chk CHECK (
    protocol_version IS DISTINCT FROM 2 OR (
      task_id IS NOT NULL AND work_package_id IS NOT NULL AND agent_run_id IS NOT NULL
      AND local_run_evidence_id IS NOT NULL AND claim_token IS NOT NULL
      AND claim_generation > 0 AND last_heartbeat_at IS NOT NULL
      AND lease_expires_at > last_heartbeat_at AND authorization_snapshot IS NOT NULL
      AND grant_decision_revision > 0 AND authorization_root_binding_revision > 0
      AND root = '' AND reason = '' AND metadata = '{}'::jsonb
      AND (
        authorization_source = 'package_allow_once' AND grant_mode = 'allow_once'
        AND grant_approval_id IS NOT NULL AND project_decision_id IS NULL
        AND grant_decision_nonce IS NOT NULL
        OR
        authorization_source = 'project_always_allow' AND grant_mode = 'always_allow'
        AND grant_approval_id IS NULL AND project_decision_id IS NOT NULL
        AND grant_decision_nonce IS NULL
      )
    )
  );
--> statement-breakpoint
CREATE UNIQUE INDEX filesystem_mcp_runtime_audits_v2_run_idx
  ON public.filesystem_mcp_runtime_audits (agent_run_id, operation)
  WHERE protocol_version = 2;
CREATE UNIQUE INDEX filesystem_mcp_runtime_audits_v2_claim_token_idx
  ON public.filesystem_mcp_runtime_audits (claim_token)
  WHERE protocol_version = 2;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION forge.validate_packet_authorization_snapshot_v2(
  p_snapshot jsonb,
  p_source text,
  p_mode text,
  p_approval_id uuid,
  p_revision bigint,
  p_nonce uuid,
  p_root_revision bigint
)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog
AS $$
DECLARE
  v_approved text[];
  v_required text[];
BEGIN
  IF p_snapshot IS NULL OR pg_catalog.jsonb_typeof(p_snapshot) <> 'object'
     OR (SELECT pg_catalog.count(*) <> 12 FROM pg_catalog.jsonb_object_keys(p_snapshot))
     OR p_snapshot - ARRAY[
      'schemaVersion','source','grantMode','grantApprovalId','grantDecisionRevision',
      'grantDecisionNonce','rootBindingRevision','approvedCapabilities',
      'requiredCapabilities','decidedByUserId','decidedAt','coverageFingerprint'
     ] <> '{}'::jsonb
     OR pg_catalog.jsonb_typeof(p_snapshot->'approvedCapabilities') <> 'array'
     OR pg_catalog.jsonb_typeof(p_snapshot->'requiredCapabilities') <> 'array' THEN
    RETURN false;
  END IF;

  SELECT pg_catalog.array_agg(value ORDER BY ordinality)
  INTO v_approved
  FROM pg_catalog.jsonb_array_elements_text(p_snapshot->'approvedCapabilities')
    WITH ORDINALITY AS item(value, ordinality);
  SELECT pg_catalog.array_agg(value ORDER BY ordinality)
  INTO v_required
  FROM pg_catalog.jsonb_array_elements_text(p_snapshot->'requiredCapabilities')
    WITH ORDINALITY AS item(value, ordinality);

  RETURN COALESCE(
    p_revision > 0
    AND p_root_revision > 0
    AND pg_catalog.cardinality(v_approved) BETWEEN 1 AND 3
    AND pg_catalog.cardinality(v_required) BETWEEN 1 AND 3
    AND v_approved = ARRAY(SELECT DISTINCT cap FROM pg_catalog.unnest(v_approved) cap ORDER BY cap)
    AND v_required = ARRAY(SELECT DISTINCT cap FROM pg_catalog.unnest(v_required) cap ORDER BY cap)
    AND v_approved <@ ARRAY['filesystem.project.list','filesystem.project.read','filesystem.project.search']::text[]
    AND v_required <@ v_approved
    AND p_snapshot->'schemaVersion' = '2'::jsonb
    AND p_snapshot->>'source' = p_source
    AND p_snapshot->>'grantMode' = p_mode
    AND p_snapshot->>'grantDecisionRevision' = p_revision::text
    AND p_snapshot->>'rootBindingRevision' = p_root_revision::text
    AND p_snapshot->>'decidedByUserId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND p_snapshot->>'decidedAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
    AND p_snapshot->>'coverageFingerprint' ~ '^sha256:[0-9a-f]{64}$'
    AND (
      p_source = 'package_allow_once'
      AND p_mode = 'allow_once'
      AND p_approval_id IS NOT NULL AND p_nonce IS NOT NULL
      AND p_snapshot->>'grantApprovalId' = p_approval_id::text
      AND p_snapshot->>'grantDecisionNonce' = p_nonce::text
      OR
      p_source = 'project_always_allow'
      AND p_mode = 'always_allow'
      AND p_approval_id IS NULL AND p_nonce IS NULL
      AND p_snapshot->'grantApprovalId' = 'null'::jsonb
      AND p_snapshot->'grantDecisionNonce' = 'null'::jsonb
    ),
    false
  );
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END;
$$;
--> statement-breakpoint
ALTER TABLE public.filesystem_mcp_runtime_audits
  ADD CONSTRAINT filesystem_mcp_runtime_audits_snapshot_v2_chk CHECK (
    protocol_version IS DISTINCT FROM 2 OR
    forge.validate_packet_authorization_snapshot_v2(
      authorization_snapshot, authorization_source, grant_mode,
      grant_approval_id, grant_decision_revision, grant_decision_nonce,
      authorization_root_binding_revision
    )
  );
--> statement-breakpoint
CREATE OR REPLACE FUNCTION forge.guard_packet_authorization_v2()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.protocol_version = 2
       AND (session_user <> 'forge_packet_issuer'
            OR current_user <> 'forge_s4_routines_owner') THEN
      RAISE EXCEPTION 'protocol-v2 packet evidence requires the fixed-path writer'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.protocol_version = 2 AND (
    NEW.protocol_version IS DISTINCT FROM OLD.protocol_version
    OR NEW.task_id IS DISTINCT FROM OLD.task_id
    OR NEW.work_package_id IS DISTINCT FROM OLD.work_package_id
    OR NEW.agent_run_id IS DISTINCT FROM OLD.agent_run_id
    OR NEW.local_run_evidence_id IS DISTINCT FROM OLD.local_run_evidence_id
    OR NEW.claim_token IS DISTINCT FROM OLD.claim_token
    OR NEW.authorization_snapshot IS DISTINCT FROM OLD.authorization_snapshot
    OR NEW.authorization_source IS DISTINCT FROM OLD.authorization_source
    OR NEW.grant_mode IS DISTINCT FROM OLD.grant_mode
    OR NEW.grant_approval_id IS DISTINCT FROM OLD.grant_approval_id
    OR NEW.project_decision_id IS DISTINCT FROM OLD.project_decision_id
    OR NEW.grant_decision_revision IS DISTINCT FROM OLD.grant_decision_revision
    OR NEW.grant_decision_nonce IS DISTINCT FROM OLD.grant_decision_nonce
    OR NEW.authorization_root_binding_revision IS DISTINCT FROM OLD.authorization_root_binding_revision
    OR NEW.capabilities IS DISTINCT FROM OLD.capabilities
    OR NEW.requested_capabilities IS DISTINCT FROM OLD.requested_capabilities
  ) THEN
    RAISE EXCEPTION 'protocol-v2 packet authorization is immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER filesystem_mcp_runtime_audits_protocol_v2_guard
BEFORE INSERT OR UPDATE ON public.filesystem_mcp_runtime_audits
FOR EACH ROW EXECUTE FUNCTION forge.guard_packet_authorization_v2();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION forge.s4_execution_lease_live_v1(
  p_metadata jsonb,
  p_agent_run_id uuid,
  p_now timestamptz
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog
AS $$
DECLARE
  v_lease jsonb := p_metadata->'executionLease';
  v_heartbeat timestamptz;
  v_stale_after numeric;
BEGIN
  IF pg_catalog.jsonb_typeof(v_lease) <> 'object'
     OR (SELECT pg_catalog.count(*) <> 6 FROM pg_catalog.jsonb_object_keys(v_lease))
     OR v_lease->>'runId' <> p_agent_run_id::text
     OR v_lease->>'source' <> 'work-package-handoff'
     OR v_lease->>'attemptNumber' !~ '^[1-9][0-9]*$'
     OR v_lease->>'staleAfterSeconds' !~ '^[1-9][0-9]*(\.[0-9]+)?$' THEN
    RETURN false;
  END IF;
  v_heartbeat := (v_lease->>'heartbeatAt')::timestamptz;
  v_stale_after := (v_lease->>'staleAfterSeconds')::numeric;
  RETURN v_stale_after BETWEEN 1 AND 3600
    AND (v_lease->>'acquiredAt')::timestamptz <= v_heartbeat
    AND v_heartbeat + pg_catalog.make_interval(secs => v_stale_after::double precision) > p_now;
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION forge.s4_runtime_mode_v1()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, forge
AS $$
BEGIN
  IF session_user <> 'forge_packet_issuer'
     OR current_user <> 'forge_s4_routines_owner' THEN
    RAISE EXCEPTION 'S4 runtime-mode reads require the fixed-path issuer'
      USING ERRCODE = '42501';
  END IF;
  IF forge.s4_protected_paths_enabled_v1() THEN
    RETURN 'protected';
  END IF;
  IF EXISTS (
    SELECT 1 FROM forge.read_epic_172_enablement_state_v1() state
    WHERE state.state = 'disabled'
  ) THEN
    RETURN 'legacy';
  END IF;
  RAISE EXCEPTION 'S4 runtime mode is blocked by incomplete Step 0 authority'
    USING ERRCODE = '55000';
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION forge.create_local_run_evidence_v1(
  p_agent_run_id uuid,
  p_claim_token uuid,
  p_lease_seconds integer
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, forge
AS $$
DECLARE
  v_task_id uuid;
  v_package_id uuid;
  v_project_id uuid;
  v_evidence_id uuid := pg_catalog.gen_random_uuid();
BEGIN
  IF session_user <> 'forge_packet_issuer'
     OR current_user <> 'forge_s4_routines_owner' THEN
    RAISE EXCEPTION 'local run evidence requires the dedicated issuer login'
      USING ERRCODE = '42501';
  END IF;
  IF p_lease_seconds NOT BETWEEN 1 AND 45 THEN
    RAISE EXCEPTION 'local evidence lease must be between 1 and 45 seconds'
      USING ERRCODE = '22023';
  END IF;
  IF NOT forge.s4_protected_paths_enabled_v1() THEN
    RAISE EXCEPTION 'S4 packet producers are disabled by the Step 0 authority' USING ERRCODE = '55000';
  END IF;

  SELECT run.task_id, run.work_package_id, task.project_id
  INTO STRICT v_task_id, v_package_id, v_project_id
  FROM public.agent_runs run
  JOIN public.work_packages package ON package.id = run.work_package_id
  JOIN public.tasks task ON task.id = package.task_id AND task.id = run.task_id
  WHERE run.id = p_agent_run_id;

  PERFORM 1 FROM public.projects project WHERE project.id = v_project_id FOR UPDATE;
  PERFORM 1 FROM public.tasks task
  WHERE task.id = v_task_id AND task.project_id = v_project_id AND task.status = 'running'
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'packet task is not running' USING ERRCODE = '40001';
  END IF;
  PERFORM 1 FROM public.work_packages package
  WHERE package.task_id = v_task_id ORDER BY package.id FOR UPDATE;
  PERFORM 1 FROM public.work_packages package
  WHERE package.id = v_package_id AND package.task_id = v_task_id AND package.status = 'running';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'packet work package is not running' USING ERRCODE = '40001';
  END IF;
  PERFORM 1 FROM public.agent_runs run
  WHERE run.id = p_agent_run_id AND run.task_id = v_task_id
    AND run.work_package_id = v_package_id AND run.status = 'running'
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'packet agent run is not running' USING ERRCODE = '40001';
  END IF;
  PERFORM 1 FROM public.work_packages package
  WHERE package.id = v_package_id
    AND forge.s4_execution_lease_live_v1(
      package.metadata, p_agent_run_id, pg_catalog.clock_timestamp()
    );
  IF NOT FOUND THEN
    RAISE EXCEPTION 'S3 execution lease is absent, malformed, or expired'
      USING ERRCODE = '40001';
  END IF;

  INSERT INTO public.work_package_local_run_evidence (
    id, task_id, work_package_id, agent_run_id, claim_token,
    claim_generation, last_heartbeat_at, lease_expires_at
  ) VALUES (
    v_evidence_id, v_task_id, v_package_id, p_agent_run_id, p_claim_token,
    1, pg_catalog.clock_timestamp(),
    pg_catalog.clock_timestamp() + pg_catalog.make_interval(secs => p_lease_seconds)
  );
  RETURN v_evidence_id;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION forge.insert_packet_authorization_snapshot_v2(
  p_agent_run_id uuid,
  p_local_run_evidence_id uuid,
  p_decision_id uuid,
  p_local_claim_token uuid,
  p_packet_claim_token uuid,
  p_lease_seconds integer,
  p_required_capabilities text[]
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_run public.agent_runs%ROWTYPE;
  v_package public.work_packages%ROWTYPE;
  v_task public.tasks%ROWTYPE;
  v_project public.projects%ROWTYPE;
  v_decision public.filesystem_mcp_grant_approvals%ROWTYPE;
  v_pointer public.filesystem_mcp_current_decision_pointers%ROWTYPE;
  v_local public.work_package_local_run_evidence%ROWTYPE;
  v_source text;
  v_mode text;
  v_project_decision public.project_filesystem_grant_decisions%ROWTYPE;
  v_grant_approval_id uuid;
  v_project_decision_id uuid;
  v_grant_nonce uuid;
  v_grant_revision bigint;
  v_root_revision bigint;
  v_decided_by uuid;
  v_decided_at timestamptz;
  v_coverage_fingerprint text;
  v_approved text[];
  v_required text[];
  v_snapshot jsonb;
  v_audit_id uuid := pg_catalog.gen_random_uuid();
BEGIN
  IF session_user <> 'forge_packet_issuer'
     OR current_user <> 'forge_s4_routines_owner' THEN
    RAISE EXCEPTION 'packet issuance requires the dedicated issuer login' USING ERRCODE = '42501';
  END IF;
  IF p_lease_seconds NOT BETWEEN 1 AND 45 THEN
    RAISE EXCEPTION 'packet lease must be between 1 and 45 seconds' USING ERRCODE = '22023';
  END IF;
  IF NOT forge.s4_protected_paths_enabled_v1() THEN
    RAISE EXCEPTION 'S4 packet producers are disabled by the Step 0 authority' USING ERRCODE = '55000';
  END IF;

  SELECT run.* INTO STRICT v_run FROM public.agent_runs run WHERE run.id = p_agent_run_id;
  SELECT package.* INTO STRICT v_package FROM public.work_packages package WHERE package.id = v_run.work_package_id;
  SELECT task.* INTO STRICT v_task FROM public.tasks task WHERE task.id = v_package.task_id;
  IF v_run.task_id <> v_task.id THEN
    RAISE EXCEPTION 'agent run does not belong to its package task' USING ERRCODE = '40001';
  END IF;
  SELECT project.* INTO STRICT v_project FROM public.projects project WHERE project.id = v_task.project_id FOR UPDATE;
  SELECT task.* INTO STRICT v_task FROM public.tasks task
  WHERE task.id = v_task.id AND task.project_id = v_project.id AND task.status = 'running'
  FOR UPDATE;
  PERFORM 1 FROM public.work_packages package WHERE package.task_id = v_task.id ORDER BY package.id FOR UPDATE;
  SELECT package.* INTO STRICT v_package FROM public.work_packages package
  WHERE package.id = v_package.id AND package.task_id = v_task.id AND package.status = 'running';
  SELECT run.* INTO STRICT v_run FROM public.agent_runs run
  WHERE run.id = p_agent_run_id AND run.task_id = v_task.id
    AND run.work_package_id = v_package.id AND run.status = 'running'
  FOR UPDATE;

  SELECT decision.* INTO v_decision
  FROM public.filesystem_mcp_grant_approvals decision
  WHERE decision.id = p_decision_id
  FOR UPDATE;
  IF FOUND THEN
    IF v_decision.decision <> 'approved'
       OR v_decision.decision_scope <> 'package'
       OR v_decision.grant_decision_revision IS NULL
       OR v_decision.root_binding_revision IS NULL
       OR v_decision.root_binding_revision <> v_project.root_binding_revision
       OR v_decision.decided_by IS NULL THEN
      RAISE EXCEPTION 'packet authorization is stale or incomplete' USING ERRCODE = '40001';
    END IF;
    SELECT pointer.* INTO STRICT v_pointer
    FROM public.filesystem_mcp_current_decision_pointers pointer
    WHERE pointer.work_package_id = v_package.id
    FOR UPDATE;
    IF v_decision.project_id <> v_project.id
       OR v_decision.task_id <> v_task.id OR v_decision.work_package_id <> v_package.id
       OR v_decision.grant_nonce IS NULL
       OR v_pointer.current_decision_id <> v_decision.id
       OR v_pointer.current_decision_revision <> v_decision.grant_decision_revision
       OR v_pointer.pointer_fingerprint <> v_decision.pointer_fingerprint THEN
      RAISE EXCEPTION 'allow-once decision is not the current package authority' USING ERRCODE = '40001';
    END IF;
    SELECT ARRAY(
      SELECT pg_catalog.jsonb_array_elements_text(v_decision.capabilities) ORDER BY 1
    ) INTO v_approved;
    v_source := 'package_allow_once';
    v_mode := 'allow_once';
    v_grant_approval_id := v_decision.id;
    v_project_decision_id := NULL;
    v_grant_nonce := v_decision.grant_nonce;
    v_grant_revision := v_decision.grant_decision_revision;
    v_root_revision := v_decision.root_binding_revision;
    v_decided_by := v_decision.decided_by;
    v_decided_at := v_decision.created_at;
    v_coverage_fingerprint := v_decision.pointer_fingerprint;
  ELSE
    -- S3 supplies the append-only project decision table and project-owned
    -- current pointer. The project-level always-allow grant is resolved from
    -- the immutable decision history, not from the mutable mcp_config blob.
    SELECT pd.* INTO v_project_decision
    FROM public.project_filesystem_current_decision_pointers pp
    JOIN public.project_filesystem_grant_decisions pd
      ON pd.id = pp.current_decision_id
      AND pd.project_id = pp.current_decision_project_id
      AND pd.grant_decision_revision = pp.current_decision_revision
      AND pd.root_binding_revision = pp.current_root_binding_revision
      AND pd.decision_fingerprint = pp.current_decision_fingerprint
      AND pd.decision_generation = pp.current_decision_generation
    WHERE pp.project_id = v_project.id
      AND pd.id = p_decision_id
    FOR UPDATE OF pp, pd;
    IF NOT FOUND
       OR v_project_decision.project_id <> v_project.id
       OR v_project_decision.decision <> 'approved'
       OR v_project_decision.root_binding_revision <> v_project.root_binding_revision THEN
      RAISE EXCEPTION 'project always-allow grant is not currently approved'
        USING ERRCODE = '55000';
    END IF;
    SELECT ARRAY(
      SELECT pg_catalog.jsonb_array_elements_text(v_project_decision.capabilities) ORDER BY 1
    ) INTO v_approved;
    v_source := 'project_always_allow';
    v_mode := 'always_allow';
    v_grant_approval_id := NULL;
    v_project_decision_id := v_project_decision.id;
    v_grant_nonce := NULL;
    v_grant_revision := v_project_decision.grant_decision_revision;
    v_root_revision := v_project_decision.root_binding_revision;
    v_decided_by := v_project_decision.decided_by;
    v_decided_at := v_project_decision.decided_at;
    v_coverage_fingerprint := v_project_decision.decision_fingerprint;
  END IF;

  SELECT ARRAY(SELECT cap FROM pg_catalog.unnest(p_required_capabilities) cap ORDER BY cap) INTO v_required;
  IF pg_catalog.cardinality(v_required) NOT BETWEEN 1 AND 3
     OR v_required IS DISTINCT FROM ARRAY(SELECT DISTINCT cap FROM pg_catalog.unnest(v_required) cap ORDER BY cap)
     OR v_required <@ ARRAY['filesystem.project.list','filesystem.project.read','filesystem.project.search']::text[] IS NOT TRUE
     OR v_required <@ v_approved IS NOT TRUE THEN
    RAISE EXCEPTION 'packet capability coverage is invalid' USING ERRCODE = '22023';
  END IF;

  SELECT evidence.* INTO STRICT v_local
  FROM public.work_package_local_run_evidence evidence
  WHERE evidence.id = p_local_run_evidence_id
    AND evidence.agent_run_id = v_run.id
    AND evidence.task_id = v_task.id
    AND evidence.work_package_id = v_package.id
    AND evidence.claim_token = p_local_claim_token
    AND evidence.claim_generation = 1
    AND evidence.state = 'claimed'
    AND pg_catalog.clock_timestamp() < evidence.lease_expires_at
  FOR UPDATE;

  v_snapshot := pg_catalog.jsonb_build_object(
    'schemaVersion', 2,
    'source', v_source,
    'grantMode', v_mode,
    'grantApprovalId', CASE WHEN v_grant_approval_id IS NOT NULL THEN pg_catalog.to_jsonb(v_grant_approval_id::text) ELSE 'null'::jsonb END,
    'grantDecisionRevision', v_grant_revision::text,
    'grantDecisionNonce', CASE WHEN v_grant_nonce IS NOT NULL THEN pg_catalog.to_jsonb(v_grant_nonce::text) ELSE 'null'::jsonb END,
    'rootBindingRevision', v_root_revision::text,
    'approvedCapabilities', pg_catalog.to_jsonb(v_approved),
    'requiredCapabilities', pg_catalog.to_jsonb(v_required),
    'decidedByUserId', v_decided_by::text,
    'decidedAt', pg_catalog.to_char(v_decided_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'coverageFingerprint', v_coverage_fingerprint
  );

  INSERT INTO public.filesystem_mcp_runtime_audits (
    id, task_id, work_package_id, agent_run_id, local_run_evidence_id,
    grant_approval_id, project_decision_id, operation, status, capabilities,
    requested_capabilities, root, file_count, byte_count, omitted_count,
    redaction_applied, redaction_summary, omitted_summary, reason, metadata,
    protocol_version, claim_token, claim_generation, last_heartbeat_at,
    lease_expires_at, authorization_snapshot,
    authorization_source, grant_mode, grant_decision_revision,
    grant_decision_nonce, authorization_root_binding_revision
  ) VALUES (
    v_audit_id, v_task.id, v_package.id, v_run.id, v_local.id,
    v_grant_approval_id, v_project_decision_id,
    'context_packet', 'claiming', pg_catalog.to_jsonb(v_approved), pg_catalog.to_jsonb(v_required),
    '', 0, 0, 0, false, '{}'::jsonb, '{}'::jsonb, '', '{}'::jsonb,
    2, p_packet_claim_token, 1, pg_catalog.clock_timestamp(),
    LEAST(v_local.lease_expires_at, pg_catalog.clock_timestamp() + pg_catalog.make_interval(secs => p_lease_seconds)),
    v_snapshot, v_source, v_mode, v_grant_revision,
    v_grant_nonce, v_root_revision
  );

  IF v_source = 'package_allow_once' THEN
    INSERT INTO public.filesystem_mcp_decision_nonce_claims (
      grant_approval_id, grant_decision_nonce, runtime_audit_id
    ) VALUES (v_grant_approval_id, v_grant_nonce, v_audit_id);
  END IF;
  RETURN v_audit_id;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION forge.claim_local_lifecycle_v2(
  p_agent_run_id uuid,
  p_local_claim_token uuid,
  p_local_lease_seconds integer
)
RETURNS TABLE (
  local_run_evidence_id uuid,
  local_claim_generation bigint,
  local_lease_expires_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, forge
AS $$
BEGIN
  IF session_user <> 'forge_packet_issuer'
     OR current_user <> 'forge_s4_routines_owner' THEN
    RAISE EXCEPTION 'local lifecycle claim requires the fixed-path issuer'
      USING ERRCODE = '42501';
  END IF;
  local_run_evidence_id := forge.create_local_run_evidence_v1(
    p_agent_run_id, p_local_claim_token, p_local_lease_seconds
  );
  SELECT evidence.claim_generation, evidence.lease_expires_at
  INTO STRICT local_claim_generation, local_lease_expires_at
  FROM public.work_package_local_run_evidence evidence
  WHERE evidence.id = local_run_evidence_id;
  RETURN NEXT;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION forge.claim_packet_lifecycle_v2(
  p_agent_run_id uuid,
  p_decision_id uuid,
  p_local_claim_token uuid,
  p_packet_claim_token uuid,
  p_local_lease_seconds integer,
  p_packet_lease_seconds integer,
  p_required_capabilities text[]
)
RETURNS TABLE (
  local_run_evidence_id uuid,
  runtime_audit_id uuid,
  local_claim_generation bigint,
  packet_claim_generation bigint,
  local_lease_expires_at timestamptz,
  packet_lease_expires_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, forge
AS $$
DECLARE
  v_project_id uuid;
  v_task_id uuid;
  v_package_id uuid;
BEGIN
  IF session_user <> 'forge_packet_issuer'
     OR current_user <> 'forge_s4_routines_owner' THEN
    RAISE EXCEPTION 'packet lifecycle claim requires the fixed-path issuer'
      USING ERRCODE = '42501';
  END IF;
  IF NOT forge.s4_protected_paths_enabled_v1() THEN
    RAISE EXCEPTION 'S4 packet producers are disabled by the Step 0 authority'
      USING ERRCODE = '55000';
  END IF;

  SELECT task.project_id, run.task_id, run.work_package_id
  INTO STRICT v_project_id, v_task_id, v_package_id
  FROM public.agent_runs run
  JOIN public.tasks task ON task.id = run.task_id
  WHERE run.id = p_agent_run_id;

  PERFORM 1 FROM public.projects project WHERE project.id = v_project_id FOR UPDATE;
  PERFORM 1 FROM public.tasks task
  WHERE task.id = v_task_id AND task.project_id = v_project_id FOR UPDATE;
  PERFORM 1 FROM public.work_packages package
  WHERE package.task_id = v_task_id ORDER BY package.id FOR UPDATE;

  PERFORM 1 FROM public.filesystem_mcp_grant_approvals decision
  WHERE decision.id = p_decision_id FOR UPDATE;
  IF FOUND THEN
    PERFORM 1 FROM public.filesystem_mcp_current_decision_pointers pointer
    WHERE pointer.work_package_id = v_package_id FOR UPDATE;
  ELSE
    PERFORM 1
    FROM public.project_filesystem_current_decision_pointers pointer
    JOIN public.project_filesystem_grant_decisions decision
      ON decision.id = pointer.current_decision_id
    WHERE pointer.project_id = v_project_id AND decision.id = p_decision_id
    FOR UPDATE OF pointer, decision;
  END IF;

  local_run_evidence_id := forge.create_local_run_evidence_v1(
    p_agent_run_id, p_local_claim_token, p_local_lease_seconds
  );
  runtime_audit_id := forge.insert_packet_authorization_snapshot_v2(
    p_agent_run_id, local_run_evidence_id, p_decision_id,
    p_local_claim_token, p_packet_claim_token, p_packet_lease_seconds,
    p_required_capabilities
  );
  SELECT evidence.claim_generation, evidence.lease_expires_at
  INTO STRICT local_claim_generation, local_lease_expires_at
  FROM public.work_package_local_run_evidence evidence
  WHERE evidence.id = local_run_evidence_id;
  SELECT audit.claim_generation, audit.lease_expires_at
  INTO STRICT packet_claim_generation, packet_lease_expires_at
  FROM public.filesystem_mcp_runtime_audits audit
  WHERE audit.id = runtime_audit_id;
  RETURN NEXT;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION forge.claim_work_package_lifecycle_v2(
  p_mode text,
  p_task_id uuid,
  p_work_package_id uuid,
  p_expected_package_updated_at timestamptz,
  p_agent_run_id uuid,
  p_agent_type text,
  p_harness_id uuid,
  p_attempt_number integer,
  p_provider_config_id uuid,
  p_model_id_used text,
  p_stage text,
  p_execution_stale_seconds integer,
  p_decision_id uuid,
  p_local_claim_token uuid,
  p_packet_claim_token uuid,
  p_local_lease_seconds integer,
  p_packet_lease_seconds integer,
  p_required_capabilities text[]
)
RETURNS TABLE (
  agent_run_id uuid,
  local_run_evidence_id uuid,
  runtime_audit_id uuid,
  local_claim_generation bigint,
  packet_claim_generation bigint,
  local_lease_expires_at timestamptz,
  packet_lease_expires_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, forge
AS $$
DECLARE
  v_project_id uuid;
  v_package public.work_packages%ROWTYPE;
  v_now timestamptz := pg_catalog.clock_timestamp();
BEGIN
  IF session_user <> 'forge_packet_issuer'
     OR current_user <> 'forge_s4_routines_owner' THEN
    RAISE EXCEPTION 'work-package lifecycle claim requires the fixed-path issuer'
      USING ERRCODE = '42501';
  END IF;
  IF NOT forge.s4_protected_paths_enabled_v1() THEN
    RAISE EXCEPTION 'S4 work-package claims are disabled by the Step 0 authority'
      USING ERRCODE = '55000';
  END IF;
  IF p_mode NOT IN ('root_free_handoff', 'local_only', 'packet')
     OR p_attempt_number <= 0
     OR p_execution_stale_seconds NOT BETWEEN 1 AND 3600
     OR pg_catalog.length(pg_catalog.btrim(p_agent_type)) NOT BETWEEN 1 AND 100
     OR pg_catalog.length(pg_catalog.btrim(p_model_id_used)) NOT BETWEEN 1 AND 500
     OR (p_mode = 'root_free_handoff' AND (
       p_decision_id IS NOT NULL OR p_local_claim_token IS NOT NULL
       OR p_packet_claim_token IS NOT NULL
     ))
     OR (p_mode = 'local_only' AND (
       p_local_claim_token IS NULL OR p_decision_id IS NOT NULL
       OR p_packet_claim_token IS NOT NULL
     ))
     OR (p_mode = 'packet' AND (
       p_local_claim_token IS NULL OR p_packet_claim_token IS NULL
       OR p_decision_id IS NULL
     )) THEN
    RAISE EXCEPTION 'work-package lifecycle claim shape is invalid'
      USING ERRCODE = '22023';
  END IF;

  SELECT task.project_id
  INTO STRICT v_project_id
  FROM public.work_packages package
  JOIN public.tasks task ON task.id = package.task_id
  WHERE package.id = p_work_package_id AND package.task_id = p_task_id;
  PERFORM 1 FROM public.projects project
  WHERE project.id = v_project_id AND project.archived_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'work-package project is unavailable' USING ERRCODE = '40001';
  END IF;
  PERFORM 1 FROM public.tasks task
  WHERE task.id = p_task_id AND task.project_id = v_project_id
    AND task.status = 'running' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'work-package task is not running' USING ERRCODE = '40001';
  END IF;
  PERFORM 1 FROM public.work_packages package
  WHERE package.task_id = p_task_id ORDER BY package.id FOR UPDATE;
  SELECT package.* INTO STRICT v_package
  FROM public.work_packages package
  WHERE package.id = p_work_package_id AND package.task_id = p_task_id;
  IF v_package.status <> 'ready'
     OR v_package.updated_at IS DISTINCT FROM p_expected_package_updated_at
     OR v_package.assigned_role <> p_agent_type
     OR EXISTS (
       SELECT 1 FROM public.work_packages sibling
       WHERE sibling.task_id = p_task_id AND sibling.id <> p_work_package_id
         AND (
           sibling.status IN ('running', 'awaiting_review')
           OR sibling.metadata ? 'executionLease'
         )
     )
     OR v_package.metadata ? 'executionLease' THEN
    RAISE EXCEPTION 'work-package claim lost its ready/sibling compare-and-set'
      USING ERRCODE = '40001';
  END IF;

  IF p_mode = 'packet' THEN
    PERFORM 1 FROM public.filesystem_mcp_grant_approvals decision
    WHERE decision.id = p_decision_id FOR UPDATE;
    IF FOUND THEN
      PERFORM 1 FROM public.filesystem_mcp_current_decision_pointers pointer
      WHERE pointer.work_package_id = p_work_package_id FOR UPDATE;
    ELSE
      PERFORM 1
      FROM public.project_filesystem_current_decision_pointers pointer
      JOIN public.project_filesystem_grant_decisions decision
        ON decision.id = pointer.current_decision_id
      WHERE pointer.project_id = v_project_id AND decision.id = p_decision_id
      FOR UPDATE OF pointer, decision;
    END IF;
  END IF;

  INSERT INTO public.agent_runs (
    id, task_id, work_package_id, harness_id, agent_type, stage,
    attempt_number, provider_config_id, model_id_used, status, started_at
  ) VALUES (
    p_agent_run_id, p_task_id, p_work_package_id, p_harness_id, p_agent_type,
    p_stage, p_attempt_number, p_provider_config_id, p_model_id_used,
    'running', v_now
  );
  UPDATE public.work_packages package
  SET status = 'running', blocked_reason = NULL, updated_at = v_now,
      metadata = pg_catalog.jsonb_set(
        COALESCE(package.metadata, '{}'::jsonb), '{executionLease}',
        pg_catalog.jsonb_build_object(
          'acquiredAt', pg_catalog.to_char(
            v_now AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
          ),
          'attemptNumber', p_attempt_number,
          'heartbeatAt', pg_catalog.to_char(
            v_now AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
          ),
          'runId', p_agent_run_id::text,
          'source', 'work-package-handoff',
          'staleAfterSeconds', p_execution_stale_seconds
        ), true
      )
  WHERE package.id = p_work_package_id AND package.status = 'ready';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'work-package execution lease compare-and-set failed'
      USING ERRCODE = '40001';
  END IF;

  agent_run_id := p_agent_run_id;
  IF p_mode = 'root_free_handoff' THEN
    RETURN NEXT;
    RETURN;
  END IF;
  local_run_evidence_id := forge.create_local_run_evidence_v1(
    p_agent_run_id, p_local_claim_token, p_local_lease_seconds
  );
  SELECT evidence.claim_generation, evidence.lease_expires_at
  INTO STRICT local_claim_generation, local_lease_expires_at
  FROM public.work_package_local_run_evidence evidence
  WHERE evidence.id = local_run_evidence_id;
  IF p_mode = 'packet' THEN
    runtime_audit_id := forge.insert_packet_authorization_snapshot_v2(
      p_agent_run_id, local_run_evidence_id, p_decision_id,
      p_local_claim_token, p_packet_claim_token, p_packet_lease_seconds,
      p_required_capabilities
    );
    SELECT audit.claim_generation, audit.lease_expires_at
    INTO STRICT packet_claim_generation, packet_lease_expires_at
    FROM public.filesystem_mcp_runtime_audits audit
    WHERE audit.id = runtime_audit_id;
  END IF;
  RETURN NEXT;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION forge.lock_live_packet_lifecycle_v2(
  p_runtime_audit_id uuid,
  p_local_claim_token uuid,
  p_local_claim_generation bigint,
  p_packet_claim_token uuid,
  p_packet_claim_generation bigint
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, forge
AS $$
DECLARE
  v_audit public.filesystem_mcp_runtime_audits%ROWTYPE;
  v_project_id uuid;
  v_now timestamptz := pg_catalog.clock_timestamp();
BEGIN
  IF session_user <> 'forge_packet_issuer'
     OR current_user <> 'forge_s4_routines_owner' THEN
    RAISE EXCEPTION 'packet lifecycle ownership requires the fixed-path issuer'
      USING ERRCODE = '42501';
  END IF;
  IF NOT forge.s4_protected_paths_enabled_v1() THEN
    RAISE EXCEPTION 'S4 packet lifecycle is disabled by the Step 0 authority'
      USING ERRCODE = '55000';
  END IF;

  SELECT audit.* INTO STRICT v_audit
  FROM public.filesystem_mcp_runtime_audits audit
  WHERE audit.id = p_runtime_audit_id AND audit.protocol_version = 2;
  SELECT task.project_id INTO STRICT v_project_id
  FROM public.tasks task WHERE task.id = v_audit.task_id;
  PERFORM 1 FROM public.projects project WHERE project.id = v_project_id FOR UPDATE;
  PERFORM 1 FROM public.tasks task
  WHERE task.id = v_audit.task_id AND task.project_id = v_project_id FOR UPDATE;
  PERFORM 1 FROM public.work_packages package
  WHERE package.task_id = v_audit.task_id ORDER BY package.id FOR UPDATE;
  PERFORM 1 FROM public.agent_runs run
  WHERE run.id = v_audit.agent_run_id AND run.task_id = v_audit.task_id
    AND run.work_package_id = v_audit.work_package_id AND run.status = 'running'
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'packet agent run is not live' USING ERRCODE = '40001';
  END IF;
  PERFORM 1 FROM public.work_packages package
  WHERE package.id = v_audit.work_package_id AND package.status = 'running'
    AND forge.s4_execution_lease_live_v1(package.metadata, v_audit.agent_run_id, v_now);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'S3 execution lease is absent, malformed, or expired'
      USING ERRCODE = '40001';
  END IF;
  PERFORM 1 FROM public.work_package_local_run_evidence evidence
  WHERE evidence.id = v_audit.local_run_evidence_id
    AND evidence.agent_run_id = v_audit.agent_run_id
    AND evidence.claim_token = p_local_claim_token
    AND evidence.claim_generation = p_local_claim_generation
    AND evidence.state = 'claimed'
    AND evidence.lease_expires_at > v_now
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'local evidence ownership is absent, stale, or expired'
      USING ERRCODE = '40001';
  END IF;
  PERFORM 1 FROM public.filesystem_mcp_runtime_audits audit
  WHERE audit.id = p_runtime_audit_id
    AND audit.status = 'claiming'
    AND audit.claim_token = p_packet_claim_token
    AND audit.claim_generation = p_packet_claim_generation
    AND audit.lease_expires_at > v_now
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'packet ownership is absent, stale, or expired'
      USING ERRCODE = '40001';
  END IF;
  RETURN v_audit.agent_run_id;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION forge.lock_live_local_lifecycle_v2(
  p_local_run_evidence_id uuid,
  p_local_claim_token uuid,
  p_local_claim_generation bigint
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, forge
AS $$
DECLARE
  v_local public.work_package_local_run_evidence%ROWTYPE;
  v_project_id uuid;
  v_now timestamptz := pg_catalog.clock_timestamp();
BEGIN
  IF session_user <> 'forge_packet_issuer'
     OR current_user <> 'forge_s4_routines_owner' THEN
    RAISE EXCEPTION 'local lifecycle ownership requires the fixed-path issuer'
      USING ERRCODE = '42501';
  END IF;
  IF NOT forge.s4_protected_paths_enabled_v1() THEN
    RAISE EXCEPTION 'S4 local lifecycle is disabled by the Step 0 authority'
      USING ERRCODE = '55000';
  END IF;
  SELECT evidence.* INTO STRICT v_local
  FROM public.work_package_local_run_evidence evidence
  WHERE evidence.id = p_local_run_evidence_id;
  SELECT task.project_id INTO STRICT v_project_id
  FROM public.tasks task WHERE task.id = v_local.task_id;
  PERFORM 1 FROM public.projects project WHERE project.id = v_project_id FOR UPDATE;
  PERFORM 1 FROM public.tasks task
  WHERE task.id = v_local.task_id AND task.project_id = v_project_id FOR UPDATE;
  PERFORM 1 FROM public.work_packages package
  WHERE package.task_id = v_local.task_id ORDER BY package.id FOR UPDATE;
  PERFORM 1 FROM public.agent_runs run
  WHERE run.id = v_local.agent_run_id AND run.task_id = v_local.task_id
    AND run.work_package_id = v_local.work_package_id AND run.status = 'running'
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'local agent run is not live' USING ERRCODE = '40001';
  END IF;
  PERFORM 1 FROM public.work_packages package
  WHERE package.id = v_local.work_package_id AND package.status = 'running'
    AND forge.s4_execution_lease_live_v1(package.metadata, v_local.agent_run_id, v_now);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'S3 execution lease is absent, malformed, or expired'
      USING ERRCODE = '40001';
  END IF;
  PERFORM 1 FROM public.work_package_local_run_evidence evidence
  WHERE evidence.id = p_local_run_evidence_id
    AND evidence.claim_token = p_local_claim_token
    AND evidence.claim_generation = p_local_claim_generation
    AND evidence.state = 'claimed' AND evidence.lease_expires_at > v_now
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'local evidence ownership is absent, stale, or expired'
      USING ERRCODE = '40001';
  END IF;
  RETURN v_local.agent_run_id;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION forge.heartbeat_local_lifecycle_v2(
  p_local_run_evidence_id uuid,
  p_local_claim_token uuid,
  p_local_claim_generation bigint,
  p_local_lease_seconds integer
)
RETURNS timestamptz
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, forge
AS $$
DECLARE
  v_agent_run_id uuid;
  v_package_id uuid;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_expires_at timestamptz;
BEGIN
  IF p_local_lease_seconds NOT BETWEEN 1 AND 45 THEN
    RAISE EXCEPTION 'local lease duration must be between 1 and 45 seconds'
      USING ERRCODE = '22023';
  END IF;
  v_agent_run_id := forge.lock_live_local_lifecycle_v2(
    p_local_run_evidence_id, p_local_claim_token, p_local_claim_generation
  );
  SELECT evidence.work_package_id INTO STRICT v_package_id
  FROM public.work_package_local_run_evidence evidence
  WHERE evidence.id = p_local_run_evidence_id;
  UPDATE public.work_packages package
  SET metadata = pg_catalog.jsonb_set(
    package.metadata, '{executionLease,heartbeatAt}',
    pg_catalog.to_jsonb(pg_catalog.to_char(v_now AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
    false
  )
  WHERE package.id = v_package_id
    AND package.metadata->'executionLease'->>'runId' = v_agent_run_id::text;
  UPDATE public.work_package_local_run_evidence evidence
  SET last_heartbeat_at = v_now,
      lease_expires_at = v_now + pg_catalog.make_interval(secs => p_local_lease_seconds)
  WHERE evidence.id = p_local_run_evidence_id
    AND evidence.claim_token = p_local_claim_token
    AND evidence.claim_generation = p_local_claim_generation
    AND evidence.state = 'claimed' AND evidence.lease_expires_at > v_now
  RETURNING evidence.lease_expires_at INTO v_expires_at;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'local lifecycle expired during heartbeat' USING ERRCODE = '40001';
  END IF;
  RETURN v_expires_at;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION forge.heartbeat_packet_lifecycle_v2(
  p_runtime_audit_id uuid,
  p_local_claim_token uuid,
  p_local_claim_generation bigint,
  p_packet_claim_token uuid,
  p_packet_claim_generation bigint,
  p_local_lease_seconds integer,
  p_packet_lease_seconds integer
)
RETURNS TABLE (local_lease_expires_at timestamptz, packet_lease_expires_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, forge
AS $$
DECLARE
  v_agent_run_id uuid;
  v_package_id uuid;
  v_local_id uuid;
  v_now timestamptz := pg_catalog.clock_timestamp();
BEGIN
  IF p_local_lease_seconds NOT BETWEEN 1 AND 45
     OR p_packet_lease_seconds NOT BETWEEN 1 AND 45 THEN
    RAISE EXCEPTION 'S4 lease duration must be between 1 and 45 seconds'
      USING ERRCODE = '22023';
  END IF;
  v_agent_run_id := forge.lock_live_packet_lifecycle_v2(
    p_runtime_audit_id, p_local_claim_token, p_local_claim_generation,
    p_packet_claim_token, p_packet_claim_generation
  );
  SELECT audit.work_package_id, audit.local_run_evidence_id
  INTO STRICT v_package_id, v_local_id
  FROM public.filesystem_mcp_runtime_audits audit WHERE audit.id = p_runtime_audit_id;

  UPDATE public.work_packages package
  SET metadata = pg_catalog.jsonb_set(
    package.metadata, '{executionLease,heartbeatAt}',
    pg_catalog.to_jsonb(pg_catalog.to_char(v_now AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
    false
  )
  WHERE package.id = v_package_id
    AND package.metadata->'executionLease'->>'runId' = v_agent_run_id::text;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'execution ownership changed during heartbeat' USING ERRCODE = '40001';
  END IF;

  UPDATE public.work_package_local_run_evidence evidence
  SET last_heartbeat_at = v_now,
      lease_expires_at = v_now + pg_catalog.make_interval(secs => p_local_lease_seconds)
  WHERE evidence.id = v_local_id
    AND evidence.claim_token = p_local_claim_token
    AND evidence.claim_generation = p_local_claim_generation
    AND evidence.state = 'claimed'
    AND evidence.lease_expires_at > v_now
  RETURNING evidence.lease_expires_at INTO local_lease_expires_at;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'local evidence lease expired during heartbeat' USING ERRCODE = '40001';
  END IF;

  UPDATE public.filesystem_mcp_runtime_audits audit
  SET last_heartbeat_at = v_now,
      lease_expires_at = LEAST(
        local_lease_expires_at,
        v_now + pg_catalog.make_interval(secs => p_packet_lease_seconds)
      )
  WHERE audit.id = p_runtime_audit_id
    AND audit.claim_token = p_packet_claim_token
    AND audit.claim_generation = p_packet_claim_generation
    AND audit.status = 'claiming'
    AND audit.lease_expires_at > v_now
  RETURNING audit.lease_expires_at INTO packet_lease_expires_at;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'packet lease expired during heartbeat' USING ERRCODE = '40001';
  END IF;
  RETURN NEXT;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION forge.begin_packet_assembly_v2(
  p_runtime_audit_id uuid,
  p_local_claim_token uuid,
  p_local_claim_generation bigint,
  p_packet_claim_token uuid,
  p_packet_claim_generation bigint,
  p_assembly_attempt_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, forge
AS $$
BEGIN
  PERFORM forge.lock_live_packet_lifecycle_v2(
    p_runtime_audit_id, p_local_claim_token, p_local_claim_generation,
    p_packet_claim_token, p_packet_claim_generation
  );
  UPDATE public.filesystem_mcp_runtime_audits audit
  SET assembly = pg_catalog.jsonb_build_object(
    'state', 'assembling',
    'assemblyAttemptId', p_assembly_attempt_id::text,
    'intentAt', pg_catalog.to_char(
      pg_catalog.clock_timestamp() AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    )
  )
  WHERE audit.id = p_runtime_audit_id AND audit.status = 'claiming'
    AND audit.assembly IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'packet assembly intent is stale or already recorded'
      USING ERRCODE = '40001';
  END IF;
  RETURN true;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION forge.complete_packet_assembly_v2(
  p_runtime_audit_id uuid,
  p_local_claim_token uuid,
  p_local_claim_generation bigint,
  p_packet_claim_token uuid,
  p_packet_claim_generation bigint,
  p_assembly_attempt_id uuid,
  p_root_ref text,
  p_included_count integer,
  p_byte_count integer,
  p_omitted_count integer,
  p_redaction_summary jsonb
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, forge
AS $$
BEGIN
  IF p_root_ref !~ '^[A-Za-z0-9_-]{1,80}$'
     OR p_included_count NOT BETWEEN 0 AND 50
     OR p_byte_count NOT BETWEEN 0 AND 163840
     OR p_omitted_count NOT BETWEEN 0 AND 5000
     OR pg_catalog.jsonb_typeof(p_redaction_summary) <> 'object' THEN
    RAISE EXCEPTION 'packet assembly result is outside the bounded schema'
      USING ERRCODE = '22023';
  END IF;
  PERFORM forge.lock_live_packet_lifecycle_v2(
    p_runtime_audit_id, p_local_claim_token, p_local_claim_generation,
    p_packet_claim_token, p_packet_claim_generation
  );
  UPDATE public.filesystem_mcp_runtime_audits audit
  SET assembly = pg_catalog.jsonb_build_object(
    'state', 'assembled', 'rootRef', p_root_ref,
    'includedCount', p_included_count, 'byteCount', p_byte_count,
    'omittedCount', p_omitted_count, 'redactionSummary', p_redaction_summary
  )
  WHERE audit.id = p_runtime_audit_id AND audit.status = 'claiming'
    AND audit.assembly->>'state' = 'assembling'
    AND audit.assembly->>'assemblyAttemptId' = p_assembly_attempt_id::text;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'packet assembly result does not own the recorded intent'
      USING ERRCODE = '40001';
  END IF;
  RETURN true;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION forge.begin_packet_delivery_v2(
  p_runtime_audit_id uuid,
  p_local_claim_token uuid,
  p_local_claim_generation bigint,
  p_packet_claim_token uuid,
  p_packet_claim_generation bigint,
  p_submission_attempt_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, forge
AS $$
BEGIN
  PERFORM forge.lock_live_packet_lifecycle_v2(
    p_runtime_audit_id, p_local_claim_token, p_local_claim_generation,
    p_packet_claim_token, p_packet_claim_generation
  );
  UPDATE public.filesystem_mcp_runtime_audits audit
  SET delivery = pg_catalog.jsonb_build_object(
    'state', 'submitting',
    'submissionAttemptId', p_submission_attempt_id::text,
    'intentAt', pg_catalog.to_char(
      pg_catalog.clock_timestamp() AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    )
  )
  WHERE audit.id = p_runtime_audit_id AND audit.status = 'claiming'
    AND audit.assembly->>'state' = 'assembled' AND audit.delivery IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'packet delivery intent requires one completed assembly'
      USING ERRCODE = '40001';
  END IF;
  RETURN true;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION forge.complete_packet_delivery_v2(
  p_runtime_audit_id uuid,
  p_local_claim_token uuid,
  p_local_claim_generation bigint,
  p_packet_claim_token uuid,
  p_packet_claim_generation bigint,
  p_submission_attempt_id uuid,
  p_outcome text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, forge
AS $$
DECLARE
  v_delivery jsonb;
BEGIN
  IF p_outcome NOT IN ('submission_failed', 'submitted', 'submission_uncertain') THEN
    RAISE EXCEPTION 'packet delivery outcome is invalid' USING ERRCODE = '22023';
  END IF;
  PERFORM forge.lock_live_packet_lifecycle_v2(
    p_runtime_audit_id, p_local_claim_token, p_local_claim_generation,
    p_packet_claim_token, p_packet_claim_generation
  );
  v_delivery := CASE p_outcome
    WHEN 'submitted' THEN pg_catalog.jsonb_build_object(
      'state', 'submitted',
      'submittedAt', pg_catalog.to_char(
        pg_catalog.clock_timestamp() AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      )
    )
    ELSE pg_catalog.jsonb_build_object('state', p_outcome)
  END;
  UPDATE public.filesystem_mcp_runtime_audits audit
  SET delivery = v_delivery
  WHERE audit.id = p_runtime_audit_id AND audit.status = 'claiming'
    AND audit.delivery->>'state' = 'submitting'
    AND audit.delivery->>'submissionAttemptId' = p_submission_attempt_id::text;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'packet delivery result does not own the recorded intent'
      USING ERRCODE = '40001';
  END IF;
  RETURN true;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION forge.finalize_local_success_v2(
  p_local_run_evidence_id uuid,
  p_local_claim_token uuid,
  p_local_claim_generation bigint,
  p_artifact_type text,
  p_artifact_content text,
  p_artifact_metadata jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, forge
AS $$
DECLARE
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_agent_run_id uuid;
  v_artifact_id uuid;
BEGIN
  IF pg_catalog.length(pg_catalog.btrim(p_artifact_type)) NOT BETWEEN 1 AND 100
     OR pg_catalog.length(p_artifact_content) > 1048576
     OR p_artifact_metadata IS NOT NULL
        AND pg_catalog.jsonb_typeof(p_artifact_metadata) <> 'object' THEN
    RAISE EXCEPTION 'completion artifact is outside the bounded schema'
      USING ERRCODE = '22023';
  END IF;
  v_agent_run_id := forge.lock_live_local_lifecycle_v2(
    p_local_run_evidence_id, p_local_claim_token, p_local_claim_generation
  );
  INSERT INTO public.artifacts (agent_run_id, artifact_type, content, metadata)
  VALUES (v_agent_run_id, p_artifact_type, p_artifact_content, p_artifact_metadata)
  RETURNING id INTO v_artifact_id;
  UPDATE public.work_package_local_run_evidence evidence
  SET state = 'terminal', terminal = '{"status":"succeeded"}'::jsonb,
      completion_artifact_id = v_artifact_id, terminal_at = v_now
  WHERE evidence.id = p_local_run_evidence_id AND evidence.state = 'claimed';
  UPDATE public.agent_runs run
  SET status = 'completed', completed_at = v_now, error_message = NULL
  WHERE run.id = v_agent_run_id AND run.status = 'running';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'local success lost its running agent run'
      USING ERRCODE = '40001';
  END IF;
  RETURN v_artifact_id;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION forge.finalize_local_failure_v2(
  p_local_run_evidence_id uuid,
  p_local_claim_token uuid,
  p_local_claim_generation bigint,
  p_failure_code text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, forge
AS $$
DECLARE
  v_agent_run_id uuid;
  v_package_id uuid;
  v_now timestamptz := pg_catalog.clock_timestamp();
BEGIN
  IF p_failure_code NOT IN (
    'local_execution_failed', 'local_invocation_uncertain',
    'external_repository_change_requires_review', 'worker_stopped'
  ) THEN
    RAISE EXCEPTION 'local failure is outside the closed terminal vocabulary'
      USING ERRCODE = '22023';
  END IF;
  v_agent_run_id := forge.lock_live_local_lifecycle_v2(
    p_local_run_evidence_id, p_local_claim_token, p_local_claim_generation
  );
  SELECT evidence.work_package_id INTO STRICT v_package_id
  FROM public.work_package_local_run_evidence evidence
  WHERE evidence.id = p_local_run_evidence_id;
  UPDATE public.work_package_local_run_evidence evidence
  SET state = CASE WHEN p_failure_code = 'local_invocation_uncertain'
    THEN 'uncertain' ELSE 'terminal' END,
      terminal = pg_catalog.jsonb_build_object(
        'status', 'failed', 'failureCode', p_failure_code
      ),
      terminal_at = v_now
  WHERE evidence.id = p_local_run_evidence_id AND evidence.state = 'claimed';
  UPDATE public.agent_runs run
  SET status = 'failed', completed_at = v_now,
      error_message = 'Protected local execution failed: ' || p_failure_code
  WHERE run.id = v_agent_run_id AND run.status = 'running';
  UPDATE public.work_packages package
  SET status = 'blocked', metadata = pg_catalog.jsonb_set(
    package.metadata - 'executionLease', '{local_effect_recovery}',
    pg_catalog.jsonb_build_object(
      'schemaVersion', 2, 'kind', 'local_lifecycle',
      'localRunEvidenceId', p_local_run_evidence_id::text,
      'failureCode', p_failure_code, 'autoRetryable', false
    ), true
  )
  WHERE package.id = v_package_id AND package.status = 'running'
    AND package.metadata->'executionLease'->>'runId' = v_agent_run_id::text;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'local failure lost its execution lease during finalization'
      USING ERRCODE = '40001';
  END IF;
  RETURN true;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION forge.finalize_packet_success_v2(
  p_runtime_audit_id uuid,
  p_local_claim_token uuid,
  p_local_claim_generation bigint,
  p_packet_claim_token uuid,
  p_packet_claim_generation bigint,
  p_artifact_type text,
  p_artifact_content text,
  p_artifact_metadata jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, forge
AS $$
DECLARE
  v_audit public.filesystem_mcp_runtime_audits%ROWTYPE;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_artifact_id uuid;
BEGIN
  IF pg_catalog.length(pg_catalog.btrim(p_artifact_type)) NOT BETWEEN 1 AND 100
     OR pg_catalog.length(p_artifact_content) > 1048576
     OR p_artifact_metadata IS NOT NULL
        AND pg_catalog.jsonb_typeof(p_artifact_metadata) <> 'object' THEN
    RAISE EXCEPTION 'completion artifact is outside the bounded schema'
      USING ERRCODE = '22023';
  END IF;
  PERFORM forge.lock_live_packet_lifecycle_v2(
    p_runtime_audit_id, p_local_claim_token, p_local_claim_generation,
    p_packet_claim_token, p_packet_claim_generation
  );
  SELECT audit.* INTO STRICT v_audit
  FROM public.filesystem_mcp_runtime_audits audit WHERE audit.id = p_runtime_audit_id;
  IF v_audit.assembly->>'state' <> 'assembled'
     OR v_audit.delivery->>'state' <> 'submitted' THEN
    RAISE EXCEPTION 'packet success requires assembled and submitted evidence'
      USING ERRCODE = '55000';
  END IF;
  INSERT INTO public.artifacts (agent_run_id, artifact_type, content, metadata)
  VALUES (v_audit.agent_run_id, p_artifact_type, p_artifact_content, p_artifact_metadata)
  RETURNING id INTO v_artifact_id;
  UPDATE public.filesystem_mcp_runtime_audits audit
  SET status = 'succeeded', terminal = '{"status":"succeeded"}'::jsonb,
      completion_artifact_id = v_artifact_id, terminal_at = v_now
  WHERE audit.id = p_runtime_audit_id AND audit.status = 'claiming';
  UPDATE public.work_package_local_run_evidence evidence
  SET state = 'terminal', terminal = '{"status":"succeeded"}'::jsonb,
      completion_artifact_id = v_artifact_id, terminal_at = v_now
  WHERE evidence.id = v_audit.local_run_evidence_id
    AND evidence.claim_token = p_local_claim_token
    AND evidence.claim_generation = p_local_claim_generation
    AND evidence.state = 'claimed';
  UPDATE public.agent_runs run
  SET status = 'completed', completed_at = v_now, error_message = NULL
  WHERE run.id = v_audit.agent_run_id AND run.status = 'running';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'packet success lost its running agent run'
      USING ERRCODE = '40001';
  END IF;
  RETURN v_artifact_id;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION forge.finalize_packet_failure_v2(
  p_runtime_audit_id uuid,
  p_local_claim_token uuid,
  p_local_claim_generation bigint,
  p_packet_claim_token uuid,
  p_packet_claim_generation bigint,
  p_failure_code text,
  p_failure_stage text DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, forge
AS $$
DECLARE
  v_audit public.filesystem_mcp_runtime_audits%ROWTYPE;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_terminal jsonb;
  v_marker jsonb;
  v_disposition text;
  v_delivery_state text;
  v_coverage text;
BEGIN
  IF p_failure_code NOT IN (
    'authorization_changed', 'execution_lease_expired',
    'local_evidence_lease_expired', 'issuance_lease_expired',
    'worker_stopped', 'preflight_failed', 'assembly_failed',
    'submission_rejected', 'submission_uncertain', 'provider_response_invalid',
    'external_repository_change_requires_review', 'post_submission_execution_failed'
  ) OR (
    p_failure_code = 'post_submission_execution_failed'
    AND p_failure_stage NOT IN (
      'sandbox_apply', 'validation', 'host_apply', 'repository_evidence',
      'completion_preparation'
    )
  ) OR (p_failure_code <> 'post_submission_execution_failed' AND p_failure_stage IS NOT NULL) THEN
    RAISE EXCEPTION 'packet failure is outside the closed terminal vocabulary'
      USING ERRCODE = '22023';
  END IF;
  PERFORM forge.lock_live_packet_lifecycle_v2(
    p_runtime_audit_id, p_local_claim_token, p_local_claim_generation,
    p_packet_claim_token, p_packet_claim_generation
  );
  SELECT audit.* INTO STRICT v_audit
  FROM public.filesystem_mcp_runtime_audits audit WHERE audit.id = p_runtime_audit_id;

  IF v_audit.assembly IS NULL THEN
    v_audit.assembly := pg_catalog.jsonb_build_object(
      'state', 'not_assembled',
      'failureStage', CASE
        WHEN p_failure_code IN (
          'authorization_changed', 'execution_lease_expired',
          'local_evidence_lease_expired', 'issuance_lease_expired'
        ) THEN 'claim' ELSE 'preflight' END
    );
  ELSIF v_audit.assembly->>'state' = 'assembling' THEN
    v_audit.assembly := pg_catalog.jsonb_build_object(
      'state', 'assembly_unconfirmed', 'failureStage', 'assembly',
      'assemblyAttemptId', v_audit.assembly->>'assemblyAttemptId'
    );
  END IF;
  IF v_audit.delivery IS NULL THEN
    v_audit.delivery := '{"state":"not_exposed"}'::jsonb;
  ELSIF v_audit.delivery->>'state' = 'submitting' THEN
    v_audit.delivery := '{"state":"submission_uncertain"}'::jsonb;
    p_failure_code := 'submission_uncertain';
    p_failure_stage := NULL;
  END IF;
  v_terminal := pg_catalog.jsonb_build_object('status', 'failed', 'failureCode', p_failure_code);
  IF p_failure_stage IS NOT NULL THEN
    v_terminal := v_terminal || pg_catalog.jsonb_build_object('failureStage', p_failure_stage);
  END IF;
  v_delivery_state := v_audit.delivery->>'state';
  v_coverage := v_audit.authorization_snapshot->>'coverageFingerprint';
  v_disposition := CASE
    WHEN v_audit.grant_mode = 'allow_once'
      AND v_delivery_state IN ('not_exposed', 'submission_failed') THEN 'reapprove_allow_once'
    WHEN v_audit.grant_mode = 'allow_once' THEN 'review_then_reapprove_allow_once'
    WHEN v_delivery_state IN ('not_exposed', 'submission_failed') THEN 'retry_execution'
    ELSE 'review_submission'
  END;
  v_marker := pg_catalog.jsonb_build_object(
    'schemaVersion', 2, 'kind', 'packet_issuance',
    'priorAgentRunId', v_audit.agent_run_id::text,
    'priorRuntimeAuditId', v_audit.id::text,
    'recoveryFailure', v_terminal, 'deliveryState', v_delivery_state,
    'grantMode', v_audit.grant_mode, 'disposition', v_disposition,
    'acknowledgedAt', NULL, 'acknowledgedByUserId', NULL,
    'combinedRepositoryReviewFingerprint', v_coverage,
    'markerFingerprint', v_coverage, 'policyFingerprint', v_coverage,
    'coverageFingerprint', v_coverage, 'autoRetryable', false
  );

  UPDATE public.filesystem_mcp_runtime_audits audit
  SET status = 'failed', assembly = v_audit.assembly, delivery = v_audit.delivery,
      terminal = v_terminal, terminal_at = v_now
  WHERE audit.id = p_runtime_audit_id AND audit.status = 'claiming';
  UPDATE public.work_package_local_run_evidence evidence
  SET state = 'terminal', terminal = v_terminal, terminal_at = v_now
  WHERE evidence.id = v_audit.local_run_evidence_id
    AND evidence.claim_token = p_local_claim_token
    AND evidence.claim_generation = p_local_claim_generation
    AND evidence.state = 'claimed';
  UPDATE public.agent_runs run
  SET status = 'failed', completed_at = v_now,
      error_message = 'Protected packet execution failed: ' || p_failure_code
  WHERE run.id = v_audit.agent_run_id AND run.status = 'running';
  UPDATE public.work_packages package
  SET status = 'blocked', metadata = pg_catalog.jsonb_set(
    package.metadata - 'executionLease', '{packet_issuance}', v_marker, true
  )
  WHERE package.id = v_audit.work_package_id AND package.status = 'running'
    AND package.metadata->'executionLease'->>'runId' = v_audit.agent_run_id::text;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'packet failure lost its execution lease during finalization'
      USING ERRCODE = '40001';
  END IF;
  RETURN true;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION forge.recover_stale_local_lifecycle_v2(
  p_local_run_evidence_id uuid
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, forge
AS $$
DECLARE
  v_local public.work_package_local_run_evidence%ROWTYPE;
  v_package public.work_packages%ROWTYPE;
  v_project_id uuid;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_failure_code text;
  v_terminal jsonb;
BEGIN
  IF session_user <> 'forge_packet_issuer'
     OR current_user <> 'forge_s4_routines_owner' THEN
    RAISE EXCEPTION 'local recovery requires the fixed-path issuer'
      USING ERRCODE = '42501';
  END IF;
  IF NOT forge.s4_protected_paths_enabled_v1() THEN
    RAISE EXCEPTION 'S4 local recovery is disabled by the Step 0 authority'
      USING ERRCODE = '55000';
  END IF;
  SELECT evidence.* INTO STRICT v_local
  FROM public.work_package_local_run_evidence evidence
  WHERE evidence.id = p_local_run_evidence_id;
  IF EXISTS (
    SELECT 1 FROM public.filesystem_mcp_runtime_audits audit
    WHERE audit.protocol_version = 2 AND audit.local_run_evidence_id = v_local.id
  ) THEN
    RAISE EXCEPTION 'packet-linked local evidence must delegate to packet recovery'
      USING ERRCODE = '55000';
  END IF;
  SELECT task.project_id INTO STRICT v_project_id
  FROM public.tasks task WHERE task.id = v_local.task_id;
  PERFORM 1 FROM public.projects project WHERE project.id = v_project_id FOR UPDATE;
  PERFORM 1 FROM public.tasks task
  WHERE task.id = v_local.task_id AND task.project_id = v_project_id FOR UPDATE;
  PERFORM 1 FROM public.work_packages package
  WHERE package.task_id = v_local.task_id ORDER BY package.id FOR UPDATE;
  PERFORM 1 FROM public.agent_runs run
  WHERE run.id = v_local.agent_run_id FOR UPDATE;
  SELECT evidence.* INTO STRICT v_local
  FROM public.work_package_local_run_evidence evidence
  WHERE evidence.id = p_local_run_evidence_id FOR UPDATE;
  SELECT package.* INTO STRICT v_package
  FROM public.work_packages package WHERE package.id = v_local.work_package_id;

  IF v_local.state = 'claimed' THEN
    IF forge.s4_execution_lease_live_v1(v_package.metadata, v_local.agent_run_id, v_now)
       AND v_local.lease_expires_at > v_now THEN
      RETURN 'not_stale';
    END IF;
    v_failure_code := CASE
      WHEN NOT forge.s4_execution_lease_live_v1(
        v_package.metadata, v_local.agent_run_id, v_now
      ) THEN 'execution_lease_expired'
      ELSE 'local_evidence_lease_expired'
    END;
    v_terminal := pg_catalog.jsonb_build_object(
      'status', 'failed', 'failureCode', v_failure_code
    );
    UPDATE public.work_package_local_run_evidence evidence
    SET state = 'uncertain', terminal = v_terminal, terminal_at = v_now
    WHERE evidence.id = v_local.id AND evidence.state = 'claimed';
    v_local.terminal := v_terminal;
  ELSIF v_local.terminal IS NULL THEN
    RAISE EXCEPTION 'terminal local evidence is incomplete' USING ERRCODE = '55000';
  END IF;

  IF v_local.terminal->>'status' = 'succeeded' THEN
    IF EXISTS (
      SELECT 1 FROM public.agent_runs run
      JOIN public.work_packages package ON package.id = run.work_package_id
      WHERE run.id = v_local.agent_run_id
        AND (run.status = 'running' OR package.status = 'running')
    ) THEN
      RETURN 'terminal_success_pending_handoff';
    END IF;
    RETURN 'repaired_terminal_success';
  END IF;
  UPDATE public.agent_runs run
  SET status = 'failed', completed_at = COALESCE(run.completed_at, v_now),
      error_message = 'Protected local execution failed: ' || (v_local.terminal->>'failureCode')
  WHERE run.id = v_local.agent_run_id AND run.status = 'running';
  UPDATE public.work_packages package
  SET status = 'blocked', metadata = pg_catalog.jsonb_set(
    package.metadata - 'executionLease', '{local_effect_recovery}',
    pg_catalog.jsonb_build_object(
      'schemaVersion', 2, 'kind', 'local_lifecycle',
      'localRunEvidenceId', v_local.id::text,
      'failureCode', v_local.terminal->>'failureCode', 'autoRetryable', false
    ), true
  )
  WHERE package.id = v_local.work_package_id AND package.status = 'running'
    AND (
      package.metadata->'executionLease'->>'runId' = v_local.agent_run_id::text
      OR NOT package.metadata ? 'executionLease'
    );
  RETURN CASE WHEN v_local.state = 'claimed'
    THEN 'recovered_stale_failure' ELSE 'repaired_terminal_failure' END;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION forge.recover_stale_packet_lifecycle_v2(
  p_runtime_audit_id uuid
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, forge
AS $$
DECLARE
  v_audit public.filesystem_mcp_runtime_audits%ROWTYPE;
  v_local public.work_package_local_run_evidence%ROWTYPE;
  v_project_id uuid;
  v_package public.work_packages%ROWTYPE;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_failure_code text;
  v_terminal jsonb;
  v_marker jsonb;
  v_delivery_state text;
  v_disposition text;
  v_coverage text;
BEGIN
  IF session_user <> 'forge_packet_issuer'
     OR current_user <> 'forge_s4_routines_owner' THEN
    RAISE EXCEPTION 'packet recovery requires the fixed-path issuer'
      USING ERRCODE = '42501';
  END IF;
  IF NOT forge.s4_protected_paths_enabled_v1() THEN
    RAISE EXCEPTION 'S4 packet recovery is disabled by the Step 0 authority'
      USING ERRCODE = '55000';
  END IF;
  SELECT audit.* INTO STRICT v_audit
  FROM public.filesystem_mcp_runtime_audits audit
  WHERE audit.id = p_runtime_audit_id AND audit.protocol_version = 2;
  SELECT task.project_id INTO STRICT v_project_id
  FROM public.tasks task WHERE task.id = v_audit.task_id;

  PERFORM 1 FROM public.projects project WHERE project.id = v_project_id FOR UPDATE;
  PERFORM 1 FROM public.tasks task
  WHERE task.id = v_audit.task_id AND task.project_id = v_project_id FOR UPDATE;
  PERFORM 1 FROM public.work_packages package
  WHERE package.task_id = v_audit.task_id ORDER BY package.id FOR UPDATE;
  PERFORM 1 FROM public.agent_runs run
  WHERE run.id = v_audit.agent_run_id AND run.task_id = v_audit.task_id
    AND run.work_package_id = v_audit.work_package_id FOR UPDATE;
  SELECT evidence.* INTO STRICT v_local
  FROM public.work_package_local_run_evidence evidence
  WHERE evidence.id = v_audit.local_run_evidence_id
    AND evidence.agent_run_id = v_audit.agent_run_id
  FOR UPDATE;
  SELECT audit.* INTO STRICT v_audit
  FROM public.filesystem_mcp_runtime_audits audit
  WHERE audit.id = p_runtime_audit_id FOR UPDATE;
  SELECT package.* INTO STRICT v_package
  FROM public.work_packages package WHERE package.id = v_audit.work_package_id;

  IF v_audit.status IN ('succeeded', 'failed') THEN
    IF v_audit.terminal IS NULL OR v_audit.terminal_at IS NULL THEN
      RAISE EXCEPTION 'terminal packet audit is incomplete' USING ERRCODE = '55000';
    END IF;
    IF v_local.state = 'claimed' THEN
      UPDATE public.work_package_local_run_evidence evidence
      SET state = CASE WHEN v_audit.status = 'succeeded' THEN 'terminal' ELSE 'uncertain' END,
          terminal = v_audit.terminal,
          terminal_at = v_now
      WHERE evidence.id = v_local.id AND evidence.state = 'claimed';
    END IF;
    IF v_audit.status = 'succeeded' THEN
      IF v_audit.terminal <> '{"status":"succeeded"}'::jsonb
         OR v_audit.assembly->>'state' <> 'assembled'
         OR v_audit.delivery->>'state' <> 'submitted' THEN
        RAISE EXCEPTION 'terminal success evidence is incoherent' USING ERRCODE = '55000';
      END IF;
      IF EXISTS (
        SELECT 1 FROM public.agent_runs run
        JOIN public.work_packages package ON package.id = run.work_package_id
        WHERE run.id = v_audit.agent_run_id
          AND (run.status = 'running' OR package.status = 'running')
      ) THEN
        RETURN 'terminal_success_pending_handoff';
      END IF;
      RETURN 'repaired_terminal_success';
    END IF;
    v_terminal := v_audit.terminal;
  ELSE
    IF v_audit.status <> 'claiming' THEN
      RAISE EXCEPTION 'packet audit is outside the recoverable lifecycle'
        USING ERRCODE = '55000';
    END IF;
    IF forge.s4_execution_lease_live_v1(v_package.metadata, v_audit.agent_run_id, v_now)
       AND v_local.state = 'claimed' AND v_local.lease_expires_at > v_now
       AND v_audit.lease_expires_at > v_now THEN
      RETURN 'not_stale';
    END IF;
    v_failure_code := CASE
      WHEN NOT forge.s4_execution_lease_live_v1(
        v_package.metadata, v_audit.agent_run_id, v_now
      ) THEN 'execution_lease_expired'
      WHEN v_local.state <> 'claimed' OR v_local.lease_expires_at <= v_now
        THEN 'local_evidence_lease_expired'
      WHEN v_audit.lease_expires_at <= v_now THEN 'issuance_lease_expired'
      ELSE 'worker_stopped'
    END;
    IF v_audit.assembly IS NULL THEN
      v_audit.assembly := pg_catalog.jsonb_build_object(
        'state', 'not_assembled', 'failureStage', 'claim'
      );
    ELSIF v_audit.assembly->>'state' = 'assembling' THEN
      v_audit.assembly := pg_catalog.jsonb_build_object(
        'state', 'assembly_unconfirmed', 'failureStage', 'assembly',
        'assemblyAttemptId', v_audit.assembly->>'assemblyAttemptId'
      );
    END IF;
    IF v_audit.delivery IS NULL THEN
      v_audit.delivery := '{"state":"not_exposed"}'::jsonb;
    ELSIF v_audit.delivery->>'state' = 'submitting' THEN
      v_audit.delivery := '{"state":"submission_uncertain"}'::jsonb;
      v_failure_code := 'submission_uncertain';
    END IF;
    v_terminal := pg_catalog.jsonb_build_object(
      'status', 'failed', 'failureCode', v_failure_code
    );
    UPDATE public.filesystem_mcp_runtime_audits audit
    SET status = 'failed', assembly = v_audit.assembly, delivery = v_audit.delivery,
        terminal = v_terminal, terminal_at = v_now
    WHERE audit.id = p_runtime_audit_id AND audit.status = 'claiming';
    UPDATE public.work_package_local_run_evidence evidence
    SET state = 'uncertain', terminal = v_terminal, terminal_at = v_now
    WHERE evidence.id = v_local.id AND evidence.state = 'claimed';
  END IF;

  v_delivery_state := v_audit.delivery->>'state';
  v_coverage := v_audit.authorization_snapshot->>'coverageFingerprint';
  v_disposition := CASE
    WHEN v_audit.grant_mode = 'allow_once'
      AND v_delivery_state IN ('not_exposed', 'submission_failed') THEN 'reapprove_allow_once'
    WHEN v_audit.grant_mode = 'allow_once' THEN 'review_then_reapprove_allow_once'
    WHEN v_delivery_state IN ('not_exposed', 'submission_failed') THEN 'retry_execution'
    ELSE 'review_submission'
  END;
  v_marker := pg_catalog.jsonb_build_object(
    'schemaVersion', 2, 'kind', 'packet_issuance',
    'priorAgentRunId', v_audit.agent_run_id::text,
    'priorRuntimeAuditId', v_audit.id::text,
    'recoveryFailure', v_terminal, 'deliveryState', v_delivery_state,
    'grantMode', v_audit.grant_mode, 'disposition', v_disposition,
    'acknowledgedAt', NULL, 'acknowledgedByUserId', NULL,
    'combinedRepositoryReviewFingerprint', v_coverage,
    'markerFingerprint', v_coverage, 'policyFingerprint', v_coverage,
    'coverageFingerprint', v_coverage, 'autoRetryable', false
  );
  UPDATE public.agent_runs run
  SET status = 'failed', completed_at = COALESCE(run.completed_at, v_now),
      error_message = 'Protected packet execution failed: ' || (v_terminal->>'failureCode')
  WHERE run.id = v_audit.agent_run_id AND run.status = 'running';
  UPDATE public.work_packages package
  SET status = 'blocked', metadata = pg_catalog.jsonb_set(
    package.metadata - 'executionLease', '{packet_issuance}', v_marker, true
  )
  WHERE package.id = v_audit.work_package_id AND package.status = 'running'
    AND (
      package.metadata->'executionLease'->>'runId' = v_audit.agent_run_id::text
      OR NOT package.metadata ? 'executionLease'
    );
  RETURN CASE WHEN v_audit.status = 'failed'
    THEN 'repaired_terminal_failure' ELSE 'recovered_stale_failure' END;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION forge.recover_linked_s4_lifecycle_v2(p_agent_run_id uuid)
RETURNS TABLE (result text, completion_artifact_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, forge
AS $$
DECLARE
  v_audit_id uuid;
  v_local_id uuid;
BEGIN
  IF session_user <> 'forge_packet_issuer'
     OR current_user <> 'forge_s4_routines_owner' THEN
    RAISE EXCEPTION 'linked-v2 cleanup requires the fixed-path issuer'
      USING ERRCODE = '42501';
  END IF;
  SELECT evidence.id INTO v_local_id
  FROM public.work_package_local_run_evidence evidence
  WHERE evidence.agent_run_id = p_agent_run_id;
  IF v_local_id IS NULL THEN
    result := 'not_linked_v2';
    RETURN NEXT;
    RETURN;
  END IF;
  SELECT audit.id INTO v_audit_id
  FROM public.filesystem_mcp_runtime_audits audit
  WHERE audit.protocol_version = 2 AND audit.local_run_evidence_id = v_local_id
    AND audit.operation = 'context_packet';
  IF v_audit_id IS NULL THEN
    result := forge.recover_stale_local_lifecycle_v2(v_local_id);
  ELSE
    result := forge.recover_stale_packet_lifecycle_v2(v_audit_id);
  END IF;
  SELECT evidence.completion_artifact_id INTO completion_artifact_id
  FROM public.work_package_local_run_evidence evidence
  WHERE evidence.id = v_local_id;
  RETURN NEXT;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION forge.cas_packet_reapproval_v2(
  p_task_id uuid,
  p_work_package_id uuid,
  p_prior_runtime_audit_id uuid,
  p_expected_marker_fingerprint text,
  p_new_decision_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, forge
AS $$
DECLARE
  v_project_id uuid;
  v_prior public.filesystem_mcp_runtime_audits%ROWTYPE;
  v_decision public.filesystem_mcp_grant_approvals%ROWTYPE;
  v_pointer public.filesystem_mcp_current_decision_pointers%ROWTYPE;
BEGIN
  IF session_user <> 'forge_packet_issuer'
     OR current_user <> 'forge_s4_routines_owner' THEN
    RAISE EXCEPTION 'packet reapproval requires the fixed-path issuer'
      USING ERRCODE = '42501';
  END IF;
  IF p_expected_marker_fingerprint !~ '^sha256:[0-9a-f]{64}$'
     OR NOT forge.s4_protected_paths_enabled_v1() THEN
    RAISE EXCEPTION 'packet reapproval input or Step 0 authority is invalid'
      USING ERRCODE = '55000';
  END IF;
  SELECT task.project_id INTO STRICT v_project_id
  FROM public.tasks task WHERE task.id = p_task_id;
  PERFORM 1 FROM public.projects project WHERE project.id = v_project_id FOR UPDATE;
  PERFORM 1 FROM public.tasks task
  WHERE task.id = p_task_id AND task.project_id = v_project_id FOR UPDATE;
  PERFORM 1 FROM public.work_packages package
  WHERE package.task_id = p_task_id ORDER BY package.id FOR UPDATE;
  SELECT decision.* INTO STRICT v_decision
  FROM public.filesystem_mcp_grant_approvals decision
  WHERE decision.id = p_new_decision_id FOR UPDATE;
  SELECT pointer.* INTO STRICT v_pointer
  FROM public.filesystem_mcp_current_decision_pointers pointer
  WHERE pointer.work_package_id = p_work_package_id FOR UPDATE;
  SELECT audit.* INTO STRICT v_prior
  FROM public.filesystem_mcp_runtime_audits audit
  WHERE audit.id = p_prior_runtime_audit_id
    AND audit.task_id = p_task_id AND audit.work_package_id = p_work_package_id
    AND audit.protocol_version = 2 AND audit.status = 'failed'
  FOR UPDATE;
  IF v_prior.grant_mode <> 'allow_once'
     OR v_decision.project_id <> v_project_id
     OR v_decision.task_id <> p_task_id
     OR v_decision.work_package_id <> p_work_package_id
     OR v_decision.decision_scope <> 'package'
     OR v_decision.decision <> 'approved'
     OR v_decision.grant_nonce IS NULL
     OR v_decision.grant_decision_revision <= v_prior.grant_decision_revision
     OR v_pointer.current_decision_id <> v_decision.id
     OR v_pointer.current_decision_revision <> v_decision.grant_decision_revision
     OR v_pointer.current_decision_fingerprint <> v_decision.pointer_fingerprint
     OR EXISTS (
       SELECT 1 FROM public.filesystem_mcp_decision_nonce_claims claim
       WHERE claim.grant_decision_nonce = v_decision.grant_nonce
     ) THEN
    RAISE EXCEPTION 'fresh allow-once reapproval is not the exact current authority'
      USING ERRCODE = '40001';
  END IF;
  UPDATE public.work_packages package
  SET status = 'ready', metadata = package.metadata - 'packet_issuance'
  WHERE package.id = p_work_package_id AND package.task_id = p_task_id
    AND package.status = 'blocked'
    AND package.metadata->'packet_issuance'->>'priorRuntimeAuditId' = p_prior_runtime_audit_id::text
    AND package.metadata->'packet_issuance'->>'markerFingerprint' = p_expected_marker_fingerprint;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'packet recovery marker changed before reapproval compare-and-set'
      USING ERRCODE = '40001';
  END IF;
  RETURN true;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION forge.insert_architect_plan_version_v1(
  p_agent_run_id uuid,
  p_plan_artifact_id uuid,
  p_plan_version bigint,
  p_digest_key_id text,
  p_entry_set_digest text,
  p_entry_ids text[],
  p_entry_kinds text[],
  p_agents text[],
  p_requirement_keys text[],
  p_binding_fingerprints text[],
  p_contents text[],
  p_content_digests text[],
  p_projection_eligible text[]
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_task_id uuid;
  v_count integer := pg_catalog.cardinality(p_entry_ids);
  v_expected_version bigint;
  v_ordinal integer;
BEGIN
  IF session_user <> 'forge_architect_plan_writer' THEN
    RAISE EXCEPTION 'Architect plan writes require the dedicated writer login' USING ERRCODE = '42501';
  END IF;
  IF NOT forge.s4_protected_paths_enabled_v1() THEN
    RAISE EXCEPTION 'Protected Architect plan writes are not enabled by the Step 0 authority'
      USING ERRCODE = '55000';
  END IF;
  IF v_count NOT BETWEEN 1 AND 256
     OR ARRAY[
       pg_catalog.cardinality(p_entry_kinds), pg_catalog.cardinality(p_agents),
       pg_catalog.cardinality(p_requirement_keys), pg_catalog.cardinality(p_binding_fingerprints),
       pg_catalog.cardinality(p_contents), pg_catalog.cardinality(p_content_digests),
       pg_catalog.cardinality(p_projection_eligible)
     ] <> pg_catalog.array_fill(v_count, ARRAY[7]) THEN
    RAISE EXCEPTION 'Architect plan entry arrays must have one bounded shared length' USING ERRCODE = '22023';
  END IF;

  SELECT run.task_id INTO STRICT v_task_id
  FROM public.agent_runs run
  WHERE run.id = p_agent_run_id AND run.agent_type = 'architect'
  FOR UPDATE;
  PERFORM 1 FROM public.tasks task WHERE task.id = v_task_id FOR UPDATE;
  SELECT COALESCE(MAX(version.plan_version), 0) + 1 INTO v_expected_version
  FROM public.architect_plan_versions version WHERE version.task_id = v_task_id;
  IF p_plan_version <> v_expected_version THEN
    RAISE EXCEPTION 'Architect plan version must be the next task-scoped BIGINT' USING ERRCODE = '40001';
  END IF;

  INSERT INTO public.artifacts (id, agent_run_id, artifact_type, content, metadata)
  VALUES (
    p_plan_artifact_id, p_agent_run_id, 'adr_text',
    'Architect plan available in protected history',
    pg_catalog.jsonb_build_object(
      'schemaVersion', 1, 'stage', 'architect_plan', 'historyAvailable', true
    )
  );
  INSERT INTO public.architect_plan_versions (
    task_id, plan_artifact_id, plan_version, digest_key_id, entry_count, entry_set_digest
  ) VALUES (v_task_id, p_plan_artifact_id, p_plan_version, p_digest_key_id, v_count, p_entry_set_digest);

  FOR v_ordinal IN 1..v_count LOOP
    INSERT INTO public.architect_plan_entries (
      task_id, plan_artifact_id, plan_version, entry_id, entry_kind, agent,
      requirement_key, binding_fingerprint, content, content_digest,
      digest_key_id, projection_eligible
    ) VALUES (
      v_task_id, p_plan_artifact_id, p_plan_version, p_entry_ids[v_ordinal],
      p_entry_kinds[v_ordinal], p_agents[v_ordinal], p_requirement_keys[v_ordinal],
      p_binding_fingerprints[v_ordinal], p_contents[v_ordinal],
      p_content_digests[v_ordinal], p_digest_key_id,
      CASE p_projection_eligible[v_ordinal]
        WHEN 'true' THEN true
        WHEN 'false' THEN false
        ELSE NULL
      END
    );
  END LOOP;
  RETURN p_plan_artifact_id;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION forge.bind_architect_plan_entry_v1(
  p_task_id uuid,
  p_work_package_id uuid,
  p_agent_run_id uuid,
  p_plan_artifact_id uuid,
  p_plan_version bigint,
  p_entry_id text,
  p_content_digest text,
  p_digest_key_id text,
  p_requirement_key text,
  p_binding_fingerprint text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_reference_id uuid := pg_catalog.gen_random_uuid();
  v_agent text;
BEGIN
  IF session_user <> 'forge_packet_issuer' THEN
    RAISE EXCEPTION 'Architect plan binding requires the dedicated package issuer login' USING ERRCODE = '42501';
  END IF;
  IF NOT forge.s4_protected_paths_enabled_v1() THEN
    RAISE EXCEPTION 'Protected Architect plan binding is not enabled by the Step 0 authority'
      USING ERRCODE = '55000';
  END IF;
  SELECT package.assigned_role INTO STRICT v_agent
  FROM public.work_packages package
  JOIN public.agent_runs run
    ON run.id = p_agent_run_id
   AND run.task_id = package.task_id
   AND run.work_package_id = package.id
   AND run.status = 'running'
  WHERE package.id = p_work_package_id AND package.task_id = p_task_id
  FOR UPDATE OF package;
  PERFORM 1 FROM public.architect_plan_entries entry
  WHERE entry.task_id = p_task_id
    AND entry.plan_artifact_id = p_plan_artifact_id
    AND entry.plan_version = p_plan_version
    AND entry.entry_id = p_entry_id
    AND entry.agent = v_agent
    AND entry.content_digest = p_content_digest
    AND entry.digest_key_id = p_digest_key_id
    AND entry.requirement_key IS NOT DISTINCT FROM p_requirement_key
    AND entry.binding_fingerprint IS NOT DISTINCT FROM p_binding_fingerprint
    AND entry.projection_eligible;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Architect plan reference is stale, cross-task, or ineligible' USING ERRCODE = '40001';
  END IF;
  INSERT INTO public.architect_plan_execution_references (
    id, purpose, task_id, work_package_id, agent_run_id, plan_artifact_id, plan_version,
    entry_id, agent, requirement_key, binding_fingerprint, content_digest, digest_key_id
  ) VALUES (
    v_reference_id, 'package_specialist', p_task_id, p_work_package_id, p_agent_run_id,
    p_plan_artifact_id, p_plan_version, p_entry_id, v_agent, p_requirement_key,
    p_binding_fingerprint, p_content_digest, p_digest_key_id
  );
  RETURN v_reference_id;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION forge.bind_architect_replan_entry_v1(
  p_task_id uuid,
  p_agent_run_id uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_reference_id uuid := pg_catalog.gen_random_uuid();
  v_plan_artifact_id uuid;
  v_plan_version bigint;
  v_content_digest text;
  v_digest_key_id text;
BEGIN
  IF session_user <> 'forge_architect_plan_writer' THEN
    RAISE EXCEPTION 'Architect replan binding requires the protected plan writer login'
      USING ERRCODE = '42501';
  END IF;
  IF NOT forge.s4_protected_paths_enabled_v1() THEN
    RAISE EXCEPTION 'Architect replan binding is not enabled by the Step 0 authority'
      USING ERRCODE = '55000';
  END IF;

  PERFORM 1 FROM public.tasks task
  WHERE task.id = p_task_id
  FOR UPDATE;
  PERFORM 1 FROM public.agent_runs run
  WHERE run.id = p_agent_run_id
    AND run.task_id = p_task_id
    AND run.work_package_id IS NULL
    AND run.agent_type = 'architect'
    AND run.status = 'running'
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Architect replan run is stale, cross-task, or not running'
      USING ERRCODE = '40001';
  END IF;

  SELECT
    entry.plan_artifact_id,
    entry.plan_version,
    entry.content_digest,
    entry.digest_key_id
  INTO
    v_plan_artifact_id,
    v_plan_version,
    v_content_digest,
    v_digest_key_id
  FROM public.architect_plan_entries entry
  JOIN public.architect_plan_versions version
    ON version.task_id = entry.task_id
   AND version.plan_artifact_id = entry.plan_artifact_id
   AND version.plan_version = entry.plan_version
  JOIN public.artifacts artifact ON artifact.id = version.plan_artifact_id
  JOIN public.agent_runs source_run
    ON source_run.id = artifact.agent_run_id
   AND source_run.task_id = entry.task_id
   AND source_run.agent_type = 'architect'
   AND source_run.status = 'completed'
  WHERE entry.task_id = p_task_id
    AND entry.entry_id = 'plan_body:000000'
    AND entry.entry_kind = 'plan_body'
    AND entry.agent IS NULL
    AND entry.requirement_key IS NULL
    AND entry.binding_fingerprint IS NULL
    AND NOT entry.projection_eligible
    AND source_run.id <> p_agent_run_id
    AND NOT EXISTS (
      SELECT 1 FROM public.architect_plan_versions newer
      WHERE newer.task_id = p_task_id
        AND newer.plan_version > entry.plan_version
    )
  ORDER BY entry.plan_version DESC
  LIMIT 1
  FOR KEY SHARE OF entry, version, artifact, source_run;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Architect replan source is not the exact latest protected plan body'
      USING ERRCODE = '40001';
  END IF;

  INSERT INTO public.architect_plan_execution_references (
    id, purpose, task_id, work_package_id, agent_run_id, plan_artifact_id,
    plan_version, entry_id, agent, requirement_key, binding_fingerprint,
    content_digest, digest_key_id
  ) VALUES (
    v_reference_id, 'architect_replan', p_task_id, NULL, p_agent_run_id,
    v_plan_artifact_id, v_plan_version, 'plan_body:000000', 'architect', NULL, NULL,
    v_content_digest, v_digest_key_id
  );
  RETURN v_reference_id;
END;
$$;
--> statement-breakpoint
-- The NOLOGIN owner receives only the existing-table privileges required by
-- the fixed-path functions above. Interactive and application logins receive
-- no equivalent table access.
GRANT SELECT ON public.tasks, public.projects, public.work_packages,
  public.agent_runs, public.artifacts, public.filesystem_mcp_grant_approvals,
  public.filesystem_mcp_current_decision_pointers,
  public.project_filesystem_grant_decisions,
  public.project_filesystem_current_decision_pointers,
  public.filesystem_mcp_runtime_audits TO forge_s4_routines_owner;
GRANT SELECT, UPDATE ON public.sessions TO forge_s4_routines_owner;
GRANT UPDATE ON public.filesystem_mcp_runtime_audits TO forge_s4_routines_owner;
GRANT UPDATE ON public.tasks, public.projects, public.work_packages,
  public.agent_runs, public.filesystem_mcp_grant_approvals,
  public.filesystem_mcp_current_decision_pointers,
  public.project_filesystem_grant_decisions,
  public.project_filesystem_current_decision_pointers TO forge_s4_routines_owner;
GRANT INSERT ON public.agent_runs, public.artifacts, public.filesystem_mcp_runtime_audits
  TO forge_s4_routines_owner;
--> statement-breakpoint
REVOKE ALL ON public.architect_plan_versions, public.architect_plan_entries,
  public.architect_plan_execution_references, public.architect_plan_history_reads,
  public.work_package_local_run_evidence,
  public.filesystem_mcp_decision_nonce_claims,
  public.project_root_ref_reconciliation FROM PUBLIC;
REVOKE ALL ON FUNCTION forge.fill_project_root_ref_on_insert_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION forge.guard_project_root_ref_renull_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION forge.reconcile_project_root_refs_v1(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION forge.s4_protected_paths_enabled_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION forge.reject_s4_retained_mutation_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION forge.guard_architect_plan_public_artifact_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION forge.read_architect_plan_history_v1(bytea,uuid,bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION forge.resolve_architect_plan_entry_v1(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION forge.create_local_run_evidence_v1(uuid,uuid,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION forge.insert_packet_authorization_snapshot_v2(uuid,uuid,uuid,uuid,uuid,integer,text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION forge.validate_packet_authorization_snapshot_v2(jsonb,text,text,uuid,bigint,uuid,bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION forge.guard_packet_authorization_v2() FROM PUBLIC;
REVOKE ALL ON FUNCTION forge.s4_execution_lease_live_v1(jsonb,uuid,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION forge.s4_runtime_mode_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION forge.claim_local_lifecycle_v2(uuid,uuid,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION forge.claim_packet_lifecycle_v2(uuid,uuid,uuid,uuid,integer,integer,text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION forge.claim_work_package_lifecycle_v2(text,uuid,uuid,timestamptz,uuid,text,uuid,integer,uuid,text,text,integer,uuid,uuid,uuid,integer,integer,text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION forge.lock_live_packet_lifecycle_v2(uuid,uuid,bigint,uuid,bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION forge.lock_live_local_lifecycle_v2(uuid,uuid,bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION forge.heartbeat_local_lifecycle_v2(uuid,uuid,bigint,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION forge.heartbeat_packet_lifecycle_v2(uuid,uuid,bigint,uuid,bigint,integer,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION forge.begin_packet_assembly_v2(uuid,uuid,bigint,uuid,bigint,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION forge.complete_packet_assembly_v2(uuid,uuid,bigint,uuid,bigint,uuid,text,integer,integer,integer,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION forge.begin_packet_delivery_v2(uuid,uuid,bigint,uuid,bigint,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION forge.complete_packet_delivery_v2(uuid,uuid,bigint,uuid,bigint,uuid,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION forge.finalize_local_success_v2(uuid,uuid,bigint,text,text,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION forge.finalize_local_failure_v2(uuid,uuid,bigint,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION forge.finalize_packet_success_v2(uuid,uuid,bigint,uuid,bigint,text,text,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION forge.finalize_packet_failure_v2(uuid,uuid,bigint,uuid,bigint,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION forge.recover_stale_local_lifecycle_v2(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION forge.recover_stale_packet_lifecycle_v2(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION forge.recover_linked_s4_lifecycle_v2(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION forge.cas_packet_reapproval_v2(uuid,uuid,uuid,text,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION forge.insert_architect_plan_version_v1(uuid,uuid,bigint,text,text,text[],text[],text[],text[],text[],text[],text[],text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION forge.bind_architect_plan_entry_v1(uuid,uuid,uuid,uuid,bigint,text,text,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION forge.bind_architect_replan_entry_v1(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION forge.insert_architect_plan_version_v1(uuid,uuid,bigint,text,text,text[],text[],text[],text[],text[],text[],text[],text[]) TO forge_architect_plan_writer;
GRANT EXECUTE ON FUNCTION forge.read_architect_plan_history_v1(bytea,uuid,bigint) TO forge_architect_plan_history_reader;
GRANT EXECUTE ON FUNCTION forge.resolve_architect_plan_entry_v1(uuid) TO forge_architect_plan_resolver;
GRANT EXECUTE ON FUNCTION forge.s4_runtime_mode_v1() TO forge_packet_issuer;
GRANT EXECUTE ON FUNCTION forge.claim_work_package_lifecycle_v2(text,uuid,uuid,timestamptz,uuid,text,uuid,integer,uuid,text,text,integer,uuid,uuid,uuid,integer,integer,text[]) TO forge_packet_issuer;
GRANT EXECUTE ON FUNCTION forge.heartbeat_local_lifecycle_v2(uuid,uuid,bigint,integer) TO forge_packet_issuer;
GRANT EXECUTE ON FUNCTION forge.heartbeat_packet_lifecycle_v2(uuid,uuid,bigint,uuid,bigint,integer,integer) TO forge_packet_issuer;
GRANT EXECUTE ON FUNCTION forge.begin_packet_assembly_v2(uuid,uuid,bigint,uuid,bigint,uuid) TO forge_packet_issuer;
GRANT EXECUTE ON FUNCTION forge.complete_packet_assembly_v2(uuid,uuid,bigint,uuid,bigint,uuid,text,integer,integer,integer,jsonb) TO forge_packet_issuer;
GRANT EXECUTE ON FUNCTION forge.begin_packet_delivery_v2(uuid,uuid,bigint,uuid,bigint,uuid) TO forge_packet_issuer;
GRANT EXECUTE ON FUNCTION forge.complete_packet_delivery_v2(uuid,uuid,bigint,uuid,bigint,uuid,text) TO forge_packet_issuer;
GRANT EXECUTE ON FUNCTION forge.finalize_local_success_v2(uuid,uuid,bigint,text,text,jsonb) TO forge_packet_issuer;
GRANT EXECUTE ON FUNCTION forge.finalize_local_failure_v2(uuid,uuid,bigint,text) TO forge_packet_issuer;
GRANT EXECUTE ON FUNCTION forge.finalize_packet_success_v2(uuid,uuid,bigint,uuid,bigint,text,text,jsonb) TO forge_packet_issuer;
GRANT EXECUTE ON FUNCTION forge.finalize_packet_failure_v2(uuid,uuid,bigint,uuid,bigint,text,text) TO forge_packet_issuer;
GRANT EXECUTE ON FUNCTION forge.recover_linked_s4_lifecycle_v2(uuid) TO forge_packet_issuer;
GRANT EXECUTE ON FUNCTION forge.cas_packet_reapproval_v2(uuid,uuid,uuid,text,uuid) TO forge_packet_issuer;
GRANT EXECUTE ON FUNCTION forge.bind_architect_plan_entry_v1(uuid,uuid,uuid,uuid,bigint,text,text,text,text,text) TO forge_packet_issuer;
GRANT EXECUTE ON FUNCTION forge.bind_architect_replan_entry_v1(uuid,uuid) TO forge_architect_plan_writer;
--> statement-breakpoint
-- The bootstrap fence temporarily gives the incoming owner CREATE on the two
-- containing schemas because PostgreSQL requires it for SET OWNER. The
-- finalizer revokes both grants before it verifies the permanent boundary.
ALTER TABLE public.architect_plan_versions OWNER TO forge_s4_routines_owner;
ALTER TABLE public.architect_plan_entries OWNER TO forge_s4_routines_owner;
ALTER TABLE public.architect_plan_execution_references OWNER TO forge_s4_routines_owner;
ALTER TABLE public.architect_plan_history_reads OWNER TO forge_s4_routines_owner;
ALTER TABLE public.work_package_local_run_evidence OWNER TO forge_s4_routines_owner;
ALTER TABLE public.filesystem_mcp_decision_nonce_claims OWNER TO forge_s4_routines_owner;
ALTER TABLE public.project_root_ref_reconciliation OWNER TO forge_s4_routines_owner;
ALTER FUNCTION forge.fill_project_root_ref_on_insert_v1() OWNER TO forge_s4_routines_owner;
ALTER FUNCTION forge.guard_project_root_ref_renull_v1() OWNER TO forge_s4_routines_owner;
ALTER FUNCTION forge.reconcile_project_root_refs_v1(integer) OWNER TO forge_s4_routines_owner;
ALTER FUNCTION forge.s4_protected_paths_enabled_v1() OWNER TO forge_s4_routines_owner;
ALTER FUNCTION forge.reject_s4_retained_mutation_v1() OWNER TO forge_s4_routines_owner;
ALTER FUNCTION forge.guard_architect_plan_public_artifact_v1() OWNER TO forge_s4_routines_owner;
ALTER FUNCTION forge.read_architect_plan_history_v1(bytea,uuid,bigint) OWNER TO forge_s4_routines_owner;
ALTER FUNCTION forge.resolve_architect_plan_entry_v1(uuid) OWNER TO forge_s4_routines_owner;
ALTER FUNCTION forge.create_local_run_evidence_v1(uuid,uuid,integer) OWNER TO forge_s4_routines_owner;
ALTER FUNCTION forge.validate_packet_authorization_snapshot_v2(jsonb,text,text,uuid,bigint,uuid,bigint) OWNER TO forge_s4_routines_owner;
ALTER FUNCTION forge.insert_packet_authorization_snapshot_v2(uuid,uuid,uuid,uuid,uuid,integer,text[]) OWNER TO forge_s4_routines_owner;
ALTER FUNCTION forge.guard_packet_authorization_v2() OWNER TO forge_s4_routines_owner;
ALTER FUNCTION forge.s4_execution_lease_live_v1(jsonb,uuid,timestamptz) OWNER TO forge_s4_routines_owner;
ALTER FUNCTION forge.s4_runtime_mode_v1() OWNER TO forge_s4_routines_owner;
ALTER FUNCTION forge.claim_local_lifecycle_v2(uuid,uuid,integer) OWNER TO forge_s4_routines_owner;
ALTER FUNCTION forge.claim_packet_lifecycle_v2(uuid,uuid,uuid,uuid,integer,integer,text[]) OWNER TO forge_s4_routines_owner;
ALTER FUNCTION forge.claim_work_package_lifecycle_v2(text,uuid,uuid,timestamptz,uuid,text,uuid,integer,uuid,text,text,integer,uuid,uuid,uuid,integer,integer,text[]) OWNER TO forge_s4_routines_owner;
ALTER FUNCTION forge.lock_live_packet_lifecycle_v2(uuid,uuid,bigint,uuid,bigint) OWNER TO forge_s4_routines_owner;
ALTER FUNCTION forge.lock_live_local_lifecycle_v2(uuid,uuid,bigint) OWNER TO forge_s4_routines_owner;
ALTER FUNCTION forge.heartbeat_local_lifecycle_v2(uuid,uuid,bigint,integer) OWNER TO forge_s4_routines_owner;
ALTER FUNCTION forge.heartbeat_packet_lifecycle_v2(uuid,uuid,bigint,uuid,bigint,integer,integer) OWNER TO forge_s4_routines_owner;
ALTER FUNCTION forge.begin_packet_assembly_v2(uuid,uuid,bigint,uuid,bigint,uuid) OWNER TO forge_s4_routines_owner;
ALTER FUNCTION forge.complete_packet_assembly_v2(uuid,uuid,bigint,uuid,bigint,uuid,text,integer,integer,integer,jsonb) OWNER TO forge_s4_routines_owner;
ALTER FUNCTION forge.begin_packet_delivery_v2(uuid,uuid,bigint,uuid,bigint,uuid) OWNER TO forge_s4_routines_owner;
ALTER FUNCTION forge.complete_packet_delivery_v2(uuid,uuid,bigint,uuid,bigint,uuid,text) OWNER TO forge_s4_routines_owner;
ALTER FUNCTION forge.finalize_local_success_v2(uuid,uuid,bigint,text,text,jsonb) OWNER TO forge_s4_routines_owner;
ALTER FUNCTION forge.finalize_local_failure_v2(uuid,uuid,bigint,text) OWNER TO forge_s4_routines_owner;
ALTER FUNCTION forge.finalize_packet_success_v2(uuid,uuid,bigint,uuid,bigint,text,text,jsonb) OWNER TO forge_s4_routines_owner;
ALTER FUNCTION forge.finalize_packet_failure_v2(uuid,uuid,bigint,uuid,bigint,text,text) OWNER TO forge_s4_routines_owner;
ALTER FUNCTION forge.recover_stale_local_lifecycle_v2(uuid) OWNER TO forge_s4_routines_owner;
ALTER FUNCTION forge.recover_stale_packet_lifecycle_v2(uuid) OWNER TO forge_s4_routines_owner;
ALTER FUNCTION forge.recover_linked_s4_lifecycle_v2(uuid) OWNER TO forge_s4_routines_owner;
ALTER FUNCTION forge.cas_packet_reapproval_v2(uuid,uuid,uuid,text,uuid) OWNER TO forge_s4_routines_owner;
ALTER FUNCTION forge.insert_architect_plan_version_v1(uuid,uuid,bigint,text,text,text[],text[],text[],text[],text[],text[],text[],text[]) OWNER TO forge_s4_routines_owner;
ALTER FUNCTION forge.bind_architect_plan_entry_v1(uuid,uuid,uuid,uuid,bigint,text,text,text,text,text) OWNER TO forge_s4_routines_owner;
ALTER FUNCTION forge.bind_architect_replan_entry_v1(uuid,uuid) OWNER TO forge_s4_routines_owner;
--> statement-breakpoint
SELECT public.forge_finalize_epic_172_s4_owner_bootstrap_v1();
