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
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles
    WHERE rolname = 'forge_review_source_resolver' AND rolcanlogin AND NOT rolinherit AND NOT rolsuper
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles
    WHERE rolname = 'forge_s4_recovery_operator' AND rolcanlogin AND NOT rolinherit AND NOT rolsuper
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles
    WHERE rolname = 'forge_local_projection_archiver' AND rolcanlogin AND NOT rolinherit AND NOT rolsuper
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
ALTER TABLE public.agent_runs
  ADD COLUMN provider_type_used text,
  ADD COLUMN provider_is_local_used boolean,
  ADD COLUMN provider_config_updated_at_used timestamptz,
  ADD COLUMN acp_execution_mode text NOT NULL DEFAULT 'not_applicable',
  ADD CONSTRAINT agent_runs_acp_execution_mode_chk CHECK (
    acp_execution_mode IN ('not_applicable', 'unconfined_host_process')
  ),
  ADD CONSTRAINT agent_runs_provider_snapshot_shape_chk CHECK (
    (provider_config_id IS NULL
      AND provider_type_used IS NULL
      AND provider_is_local_used IS NULL
      AND provider_config_updated_at_used IS NULL
      AND acp_execution_mode = 'not_applicable')
    OR
    (provider_config_id IS NOT NULL
      AND provider_type_used IS NOT NULL
      AND provider_is_local_used IS NOT NULL
      AND provider_config_updated_at_used IS NOT NULL
      AND ((provider_type_used = 'acp' AND acp_execution_mode = 'unconfined_host_process')
        OR (provider_type_used <> 'acp' AND acp_execution_mode = 'not_applicable')))
  ) NOT VALID;
--> statement-breakpoint
UPDATE public.agent_runs run
SET provider_type_used = provider.provider_type,
    provider_is_local_used = provider.is_local,
    provider_config_updated_at_used = provider.updated_at,
    acp_execution_mode = CASE WHEN provider.provider_type = 'acp'
      THEN 'unconfined_host_process' ELSE 'not_applicable' END
FROM public.provider_configs provider
WHERE provider.id = run.provider_config_id;
--> statement-breakpoint
ALTER TABLE public.approval_gates
  ADD COLUMN protected_review_revision integer,
  ADD COLUMN protected_review_set_digest text,
  ADD COLUMN protected_review_item_count integer,
  ADD COLUMN protected_review_approved_count integer,
  ADD COLUMN protected_review_denied_count integer,
  ADD COLUMN protected_review_blocker_codes text[],
  ADD CONSTRAINT approval_gates_protected_review_head_chk CHECK (
    (
      protected_review_revision IS NULL
      AND protected_review_set_digest IS NULL
      AND protected_review_item_count IS NULL
      AND protected_review_approved_count IS NULL
      AND protected_review_denied_count IS NULL
      AND protected_review_blocker_codes IS NULL
    ) OR (
      protected_review_revision > 0
      AND protected_review_set_digest ~ '^hmac-sha256:[0-9a-f]{64}$'
      AND protected_review_item_count BETWEEN 1 AND 256
      AND protected_review_approved_count BETWEEN 0 AND protected_review_item_count
      AND protected_review_denied_count BETWEEN 0 AND protected_review_item_count
      AND protected_review_approved_count + protected_review_denied_count
        <= protected_review_item_count
      AND pg_catalog.cardinality(protected_review_blocker_codes) <= 64
    )
  );
--> statement-breakpoint
CREATE OR REPLACE FUNCTION forge.guard_s4_approval_gate_review_head_v1()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF current_user <> 'forge_s4_routines_owner'
       AND COALESCE(
         NEW.protected_review_revision IS NOT NULL
         OR NEW.protected_review_set_digest IS NOT NULL
         OR NEW.protected_review_item_count IS NOT NULL
         OR NEW.protected_review_approved_count IS NOT NULL
         OR NEW.protected_review_denied_count IS NOT NULL
         OR NEW.protected_review_blocker_codes IS NOT NULL,
         false
       ) THEN
      RAISE EXCEPTION 'The protected operator-review head is owner-managed'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  IF (
    NEW.protected_review_revision,
    NEW.protected_review_set_digest,
    NEW.protected_review_item_count,
    NEW.protected_review_approved_count,
    NEW.protected_review_denied_count,
    NEW.protected_review_blocker_codes
  ) IS DISTINCT FROM (
    OLD.protected_review_revision,
    OLD.protected_review_set_digest,
    OLD.protected_review_item_count,
    OLD.protected_review_approved_count,
    OLD.protected_review_denied_count,
    OLD.protected_review_blocker_codes
  ) AND current_user <> 'forge_s4_routines_owner' THEN
    RAISE EXCEPTION 'The protected operator-review head is owner-managed'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER approval_gates_s4_review_head_guard
  BEFORE INSERT OR UPDATE ON public.approval_gates
  FOR EACH ROW EXECUTE FUNCTION forge.guard_s4_approval_gate_review_head_v1();
--> statement-breakpoint
ALTER TABLE public.tasks
  DROP CONSTRAINT tasks_local_projection_overlimit_check,
  ADD COLUMN local_projection_source_task_id uuid,
  ADD COLUMN local_projection_replacement_state text,
  ADD COLUMN local_projection_replacement_version bigint,
  ADD COLUMN local_projection_replacement_fingerprint text,
  ADD CONSTRAINT tasks_local_projection_source_task_fk
    FOREIGN KEY (local_projection_source_task_id) REFERENCES public.tasks(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  ADD CONSTRAINT tasks_local_projection_replacement_state_chk CHECK (
    local_projection_replacement_state IS NULL
    OR local_projection_replacement_state IN ('pending','eligible','cancelled')
  ),
  ADD CONSTRAINT tasks_local_projection_replacement_shape_chk CHECK (
    (local_projection_source_task_id IS NULL
      AND local_projection_replacement_state IS NULL
      AND local_projection_replacement_version IS NULL
      AND local_projection_replacement_fingerprint IS NULL)
    OR
    (local_projection_source_task_id IS NOT NULL
      AND local_projection_replacement_state IS NOT NULL
      AND local_projection_replacement_version > 0
      AND local_projection_replacement_fingerprint ~ '^sha256:[0-9a-f]{64}$')
  ),
  ADD CONSTRAINT tasks_local_projection_overlimit_check CHECK (
    (local_projection_scope_state = 'active'
      AND (local_projection_overlimit_package_count IS NULL
        OR local_projection_overlimit_package_count > 256))
    OR
    (local_projection_scope_state IN ('archive_pending','legacy_archived')
      AND local_projection_overlimit_package_count > 256)
  );
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
REVOKE ALL ON FUNCTION forge.guard_session_credential_cutover_v1() FROM PUBLIC;
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
  structural_set_digest text NOT NULL,
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
  CONSTRAINT architect_plan_versions_digest_chk CHECK (
    entry_set_digest ~ '^hmac-sha256:[0-9a-f]{64}$'
    AND structural_set_digest ~ '^hmac-sha256:[0-9a-f]{64}$'
  )
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
  CONSTRAINT architect_plan_entries_kind_chk CHECK (entry_kind IN (
    'plan_body','requirement','routing','overlay','subtask',
    'clarification_question','clarification_answer','legacy_full_plan'
  )),
  CONSTRAINT architect_plan_entries_agent_chk CHECK (agent IS NULL OR agent ~ '^[a-z0-9._-]{1,64}$'),
  CONSTRAINT architect_plan_entries_requirement_chk CHECK (requirement_key IS NULL OR requirement_key ~ '^[a-z0-9._-]{1,64}$'),
  CONSTRAINT architect_plan_entries_binding_chk CHECK (binding_fingerprint IS NULL OR binding_fingerprint ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT architect_plan_entries_content_chk CHECK (pg_catalog.octet_length(content) BETWEEN 1 AND 65536),
  CONSTRAINT architect_plan_entries_digest_chk CHECK (content_digest ~ '^hmac-sha256:[0-9a-f]{64}$'),
  CONSTRAINT architect_plan_entries_key_chk CHECK (digest_key_id ~ '^[a-z0-9._-]{1,64}$'),
  CONSTRAINT architect_plan_entries_legacy_chk CHECK (entry_kind <> 'legacy_full_plan' OR NOT projection_eligible),
  CONSTRAINT architect_plan_entries_plan_body_chk CHECK (
    entry_kind <> 'plan_body' OR (
      entry_id = 'plan_body:000000' AND agent IS NULL
      AND requirement_key IS NULL AND binding_fingerprint IS NULL
      AND NOT projection_eligible
    )
  ),
  CONSTRAINT architect_plan_entries_requirement_shape_chk CHECK (
    entry_kind <> 'requirement' OR (
      requirement_key IS NOT NULL AND entry_id = 'requirement:' || requirement_key
      AND agent IS NULL AND binding_fingerprint IS NULL AND NOT projection_eligible
    )
  ),
  CONSTRAINT architect_plan_entries_clarification_chk CHECK (
    entry_kind NOT IN ('clarification_question','clarification_answer') OR (
      entry_id ~ ('^' || entry_kind ||
        ':[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
      AND agent IS NULL AND requirement_key IS NULL
      AND binding_fingerprint IS NULL AND NOT projection_eligible
    )
  ),
  CONSTRAINT architect_plan_entries_routing_chk CHECK (
    entry_kind <> 'routing' OR (
      agent IS NOT NULL AND requirement_key IS NOT NULL
      AND binding_fingerprint IS NOT NULL AND NOT projection_eligible
      AND entry_id = 'routing:' || requirement_key || ':' || agent
    )
  )
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
    )
  ),
  UNIQUE (agent_run_id, entry_id)
);
--> statement-breakpoint
CREATE INDEX architect_plan_execution_references_package_idx
  ON public.architect_plan_execution_references (work_package_id, agent_run_id);
--> statement-breakpoint
CREATE TABLE public.protected_package_entry_registrations (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES public.tasks(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  work_package_id uuid NOT NULL REFERENCES public.work_packages(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  source_kind text NOT NULL CHECK (source_kind IN ('architect_plan','operator_review')),
  source_id uuid NOT NULL,
  source_version bigint NOT NULL CHECK (source_version > 0),
  entry_id text NOT NULL CHECK (
    pg_catalog.length(entry_id) BETWEEN 1 AND 256 AND entry_id ~ '^[a-z0-9._:-]+$'
  ),
  entry_kind text NOT NULL CHECK (entry_kind IN ('requirement','routing','overlay','subtask','decision')),
  binding_set_digest text NOT NULL CHECK (binding_set_digest ~ '^hmac-sha256:[0-9a-f]{64}$'),
  content_digest text NOT NULL CHECK (content_digest ~ '^hmac-sha256:[0-9a-f]{64}$'),
  digest_key_id text NOT NULL CHECK (digest_key_id ~ '^[a-z0-9._-]{1,64}$'),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  UNIQUE (task_id, work_package_id, source_kind, source_id, source_version, entry_id)
);
--> statement-breakpoint
CREATE TABLE public.protected_entry_capability_bindings (
  source_kind text NOT NULL CHECK (source_kind IN ('architect_plan','operator_review')),
  source_id uuid NOT NULL,
  source_version bigint NOT NULL CHECK (source_version > 0),
  entry_id text NOT NULL CHECK (
    pg_catalog.length(entry_id) BETWEEN 1 AND 256 AND entry_id ~ '^[a-z0-9._:-]+$'
  ),
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 0 AND 255),
  capability text NOT NULL CHECK (
    pg_catalog.length(capability) BETWEEN 1 AND 240
    AND capability = pg_catalog.lower(pg_catalog.btrim(capability))
    AND capability ~ '^[a-z0-9._:-]+$'
  ),
  requirement_key text NOT NULL CHECK (requirement_key ~ '^[a-z0-9._-]{1,64}$'),
  routing_fingerprint text NOT NULL CHECK (routing_fingerprint ~ '^sha256:[0-9a-f]{64}$'),
  PRIMARY KEY (source_kind, source_id, source_version, entry_id, ordinal),
  UNIQUE (source_kind, source_id, source_version, entry_id, capability, requirement_key)
);
--> statement-breakpoint
CREATE TABLE public.mcp_operator_review_versions (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES public.tasks(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  approval_gate_id uuid NOT NULL REFERENCES public.approval_gates(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  source_artifact_id uuid NOT NULL,
  source_plan_version bigint NOT NULL CHECK (source_plan_version > 0),
  revision integer NOT NULL CHECK (revision > 0),
  previous_review_set_digest text CHECK (
    previous_review_set_digest IS NULL
    OR previous_review_set_digest ~ '^hmac-sha256:[0-9a-f]{64}$'
  ),
  review_set_digest text NOT NULL CHECK (review_set_digest ~ '^hmac-sha256:[0-9a-f]{64}$'),
  item_count integer NOT NULL CHECK (item_count BETWEEN 1 AND 256),
  entry_count integer NOT NULL CHECK (entry_count BETWEEN 1 AND 256),
  approved_count integer NOT NULL CHECK (approved_count >= 0),
  denied_count integer NOT NULL CHECK (denied_count >= 0),
  blocker_codes text[] NOT NULL DEFAULT ARRAY[]::text[],
  created_by_user_id uuid NOT NULL REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  CONSTRAINT mcp_operator_review_versions_source_fk
    FOREIGN KEY (source_artifact_id, source_plan_version)
    REFERENCES public.architect_plan_versions(plan_artifact_id, plan_version)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT mcp_operator_review_versions_counts_chk CHECK (
    approved_count <= item_count AND denied_count <= item_count
      AND approved_count + denied_count = item_count
  ),
  CONSTRAINT mcp_operator_review_versions_blockers_chk CHECK (
    pg_catalog.cardinality(blocker_codes) <= 64
  ),
  UNIQUE (approval_gate_id, revision),
  UNIQUE (approval_gate_id, review_set_digest)
);
--> statement-breakpoint
CREATE TABLE public.mcp_operator_review_entries (
  review_version_id uuid NOT NULL REFERENCES public.mcp_operator_review_versions(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  entry_id text NOT NULL CHECK (
    pg_catalog.length(entry_id) BETWEEN 1 AND 256 AND entry_id ~ '^[a-z0-9._:-]+$'
  ),
  entry_kind text NOT NULL CHECK (entry_kind IN ('decision','overlay')),
  agent text NOT NULL CHECK (agent ~ '^[a-z0-9._-]{1,64}$'),
  requirement_key text NOT NULL CHECK (requirement_key ~ '^[a-z0-9._-]{1,64}$'),
  content text NOT NULL CHECK (pg_catalog.octet_length(content) BETWEEN 1 AND 65536),
  content_digest text NOT NULL CHECK (content_digest ~ '^hmac-sha256:[0-9a-f]{64}$'),
  digest_key_id text NOT NULL CHECK (digest_key_id ~ '^[a-z0-9._-]{1,64}$'),
  projection_eligible boolean NOT NULL,
  PRIMARY KEY (review_version_id, entry_id)
);
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
CREATE TRIGGER protected_package_entry_registrations_append_only
  BEFORE UPDATE OR DELETE ON public.protected_package_entry_registrations
  FOR EACH ROW EXECUTE FUNCTION forge.reject_s4_retained_mutation_v1();
CREATE TRIGGER protected_entry_capability_bindings_append_only
  BEFORE UPDATE OR DELETE ON public.protected_entry_capability_bindings
  FOR EACH ROW EXECUTE FUNCTION forge.reject_s4_retained_mutation_v1();
CREATE TRIGGER mcp_operator_review_versions_append_only
  BEFORE UPDATE OR DELETE ON public.mcp_operator_review_versions
  FOR EACH ROW EXECUTE FUNCTION forge.reject_s4_retained_mutation_v1();
CREATE TRIGGER mcp_operator_review_entries_append_only
  BEFORE UPDATE OR DELETE ON public.mcp_operator_review_entries
  FOR EACH ROW EXECUTE FUNCTION forge.reject_s4_retained_mutation_v1();
CREATE TRIGGER architect_plan_history_reads_append_only
  BEFORE UPDATE OR DELETE ON public.architect_plan_history_reads
  FOR EACH ROW EXECUTE FUNCTION forge.reject_s4_retained_mutation_v1();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION forge.append_mcp_operator_review_version_v1(
  p_session_credential bytea,
  p_approval_gate_id uuid,
  p_source_plan_version bigint,
  p_revision integer,
  p_previous_review_set_digest text,
  p_review_set_digest text,
  p_item_count integer,
  p_approved_count integer,
  p_denied_count integer,
  p_blocker_codes text[],
  p_entry_ids text[],
  p_entry_kinds text[],
  p_agents text[],
  p_requirement_keys text[],
  p_contents text[],
  p_content_digests text[],
  p_digest_key_ids text[],
  p_projection_eligible boolean[]
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, forge
AS $$
DECLARE
  v_credential_text text;
  v_credential_digest bytea;
  v_session public.sessions%ROWTYPE;
  v_gate public.approval_gates%ROWTYPE;
  v_review_version_id uuid := pg_catalog.gen_random_uuid();
  v_expected_revision integer;
  v_expected_previous_digest text;
  v_entry_count integer := pg_catalog.cardinality(p_entry_ids);
BEGIN
  IF session_user <> 'forge_architect_plan_history_reader'
     OR current_user <> 'forge_s4_routines_owner' THEN
    RAISE EXCEPTION 'MCP operator review append requires the credential-bound history principal'
      USING ERRCODE = '42501';
  END IF;
  IF NOT forge.s4_protected_paths_enabled_v1() THEN
    RAISE EXCEPTION 'Protected MCP operator reviews are not enabled by the Step 0 authority'
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
    AND session_row.revoked_at IS NULL
    AND session_row.expires_at IS NOT NULL
    AND pg_catalog.clock_timestamp() < session_row.expires_at
  FOR UPDATE;

  SELECT gate.* INTO STRICT v_gate
  FROM public.approval_gates gate
  JOIN public.tasks task
    ON task.id = gate.task_id AND task.submitted_by = v_session.user_id
  WHERE gate.id = p_approval_gate_id
    AND gate.gate_type = 'plan_approval'
    AND gate.status IN ('pending','needs_rework')
    AND gate.source_artifact_id IS NOT NULL
  FOR UPDATE OF gate;
  PERFORM 1
  FROM public.architect_plan_versions version
  WHERE version.task_id = v_gate.task_id
    AND version.plan_artifact_id = v_gate.source_artifact_id
    AND version.plan_version = p_source_plan_version
    AND NOT EXISTS (
      SELECT 1 FROM public.architect_plan_versions newer
      WHERE newer.task_id = v_gate.task_id
        AND newer.plan_version > version.plan_version
    )
  FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MCP operator review source is not the exact latest protected plan'
      USING ERRCODE = '40001';
  END IF;

  v_expected_revision := COALESCE(v_gate.protected_review_revision, 0) + 1;
  v_expected_previous_digest := v_gate.protected_review_set_digest;
  IF p_revision <> v_expected_revision
     OR p_previous_review_set_digest IS DISTINCT FROM v_expected_previous_digest
     OR p_review_set_digest !~ '^hmac-sha256:[0-9a-f]{64}$'
     OR p_item_count NOT BETWEEN 1 AND 256
     OR p_approved_count NOT BETWEEN 0 AND p_item_count
     OR p_denied_count NOT BETWEEN 0 AND p_item_count
     OR p_approved_count + p_denied_count <> p_item_count
     OR v_entry_count NOT BETWEEN p_item_count AND 256
     OR pg_catalog.cardinality(p_entry_kinds) <> v_entry_count
     OR pg_catalog.cardinality(p_agents) <> v_entry_count
     OR pg_catalog.cardinality(p_requirement_keys) <> v_entry_count
     OR pg_catalog.cardinality(p_contents) <> v_entry_count
     OR pg_catalog.cardinality(p_content_digests) <> v_entry_count
     OR pg_catalog.cardinality(p_digest_key_ids) <> v_entry_count
     OR pg_catalog.cardinality(p_projection_eligible) <> v_entry_count
     OR pg_catalog.cardinality(p_blocker_codes) > 64
     OR p_blocker_codes <> COALESCE((
       SELECT pg_catalog.array_agg(DISTINCT code ORDER BY code)
       FROM pg_catalog.unnest(p_blocker_codes) code
     ), ARRAY[]::text[])
     OR EXISTS (
       SELECT 1 FROM pg_catalog.unnest(p_blocker_codes) code
       WHERE code !~ '^[a-z0-9._:-]{1,100}$'
     ) THEN
    RAISE EXCEPTION 'MCP operator review version or array shape is invalid'
      USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.generate_subscripts(p_entry_ids, 1) ordinal
    WHERE p_entry_ids[ordinal] !~ '^[a-z0-9._:-]{1,256}$'
      OR p_entry_kinds[ordinal] NOT IN ('decision','overlay')
      OR p_agents[ordinal] !~ '^[a-z0-9._-]{1,64}$'
      OR p_requirement_keys[ordinal] !~ '^[a-z0-9._-]{1,64}$'
      OR pg_catalog.octet_length(p_contents[ordinal]) NOT BETWEEN 1 AND 65536
      OR p_content_digests[ordinal] !~ '^hmac-sha256:[0-9a-f]{64}$'
      OR p_digest_key_ids[ordinal] !~ '^[a-z0-9._-]{1,64}$'
  ) OR (
    SELECT pg_catalog.count(DISTINCT entry_id) FROM pg_catalog.unnest(p_entry_ids) entry_id
  ) <> v_entry_count OR (
    SELECT pg_catalog.count(*) FROM pg_catalog.unnest(p_entry_kinds) entry_kind
    WHERE entry_kind = 'decision'
  ) <> p_item_count OR EXISTS (
    SELECT 1
    FROM pg_catalog.generate_subscripts(p_entry_ids, 1) overlay_ordinal
    WHERE p_entry_kinds[overlay_ordinal] = 'overlay'
      AND NOT EXISTS (
        SELECT 1
        FROM pg_catalog.generate_subscripts(p_entry_ids, 1) decision_ordinal
        WHERE p_entry_kinds[decision_ordinal] = 'decision'
          AND p_agents[decision_ordinal] = p_agents[overlay_ordinal]
          AND p_requirement_keys[decision_ordinal] = p_requirement_keys[overlay_ordinal]
      )
  ) THEN
    RAISE EXCEPTION 'MCP operator review entry is invalid or duplicated'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.mcp_operator_review_versions (
    id, task_id, approval_gate_id, source_artifact_id, source_plan_version,
    revision, previous_review_set_digest, review_set_digest, item_count, entry_count,
    approved_count, denied_count, blocker_codes, created_by_user_id
  ) VALUES (
    v_review_version_id, v_gate.task_id, v_gate.id, v_gate.source_artifact_id,
    p_source_plan_version, p_revision, p_previous_review_set_digest,
    p_review_set_digest, p_item_count, v_entry_count, p_approved_count, p_denied_count,
    p_blocker_codes, v_session.user_id
  );
  INSERT INTO public.mcp_operator_review_entries (
    review_version_id, entry_id, entry_kind, agent, requirement_key,
    content, content_digest, digest_key_id, projection_eligible
  )
  SELECT v_review_version_id, p_entry_ids[ordinal], p_entry_kinds[ordinal],
    p_agents[ordinal], p_requirement_keys[ordinal], p_contents[ordinal],
    p_content_digests[ordinal], p_digest_key_ids[ordinal],
    p_projection_eligible[ordinal]
  FROM pg_catalog.generate_subscripts(p_entry_ids, 1) ordinal
  ORDER BY p_entry_ids[ordinal];
  UPDATE public.approval_gates gate
  SET protected_review_revision = p_revision,
      protected_review_set_digest = p_review_set_digest,
      protected_review_item_count = p_item_count,
      protected_review_approved_count = p_approved_count,
      protected_review_denied_count = p_denied_count,
      protected_review_blocker_codes = p_blocker_codes,
      metadata = pg_catalog.jsonb_set(
        COALESCE(gate.metadata, '{}'::jsonb) - ARRAY[
          'mcpOperatorReviews','mcpOperatorReview',
          'protectedMcpOperatorReviews','protectedMcpOperatorReview'
        ], '{protectedMcpReview}',
        pg_catalog.jsonb_build_object(
          'schemaVersion', 2,
          'sourceArtifactId', v_gate.source_artifact_id::text,
          'sourcePlanVersion', p_source_plan_version::text,
          'revision', p_revision,
          'reviewSetDigest', p_review_set_digest,
          'itemCount', p_item_count,
          'approvedCount', p_approved_count,
          'deniedCount', p_denied_count,
          'blockerCodes', p_blocker_codes
        ), true
      ),
      updated_at = pg_catalog.clock_timestamp()
  WHERE gate.id = v_gate.id
    AND gate.protected_review_revision IS NOT DISTINCT FROM v_gate.protected_review_revision
    AND gate.protected_review_set_digest IS NOT DISTINCT FROM v_gate.protected_review_set_digest;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MCP operator review gate head lost its compare-and-set'
      USING ERRCODE = '40001';
  END IF;
  RETURN v_review_version_id;
END;
$$;
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
CREATE OR REPLACE FUNCTION forge.read_mcp_operator_review_history_v1(
  p_session_credential bytea,
  p_task_id uuid,
  p_approval_gate_id uuid,
  p_revision integer
)
RETURNS TABLE (
  review_version_id uuid,
  review_set_digest text,
  entry_id text,
  entry_kind text,
  agent text,
  requirement_key text,
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
  v_version public.mcp_operator_review_versions%ROWTYPE;
BEGIN
  IF session_user <> 'forge_architect_plan_history_reader'
     OR current_user <> 'forge_s4_routines_owner' THEN
    RAISE EXCEPTION 'MCP operator review history requires the credential-bound history principal'
      USING ERRCODE = '42501';
  END IF;
  IF NOT forge.s4_protected_paths_enabled_v1() THEN
    RAISE EXCEPTION 'Protected MCP operator review history is not enabled'
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
    AND session_row.revoked_at IS NULL
    AND session_row.expires_at IS NOT NULL
    AND pg_catalog.clock_timestamp() < session_row.expires_at
  FOR UPDATE;
  PERFORM 1 FROM public.tasks task
  WHERE task.id = p_task_id AND task.submitted_by = v_session.user_id
  FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MCP operator review history is not accessible to this session'
      USING ERRCODE = '42501';
  END IF;
  SELECT version.* INTO STRICT v_version
  FROM public.mcp_operator_review_versions version
  WHERE version.task_id = p_task_id
    AND version.approval_gate_id = p_approval_gate_id
    AND version.revision = p_revision;
  INSERT INTO public.architect_plan_history_reads (
    request_id, user_id, task_id, plan_version, returned_entry_count, entry_set_digest
  ) VALUES (
    pg_catalog.gen_random_uuid(), v_session.user_id, p_task_id,
    v_version.source_plan_version, v_version.entry_count, v_version.review_set_digest
  );
  PERFORM 1 FROM public.sessions session_row
  WHERE session_row.id = v_session.id
    AND session_row.credential_digest_v1 = v_credential_digest
    AND session_row.revoked_at IS NULL
    AND session_row.expires_at IS NOT NULL
    AND pg_catalog.clock_timestamp() < session_row.expires_at
  FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Session credential expired before MCP review history delivery'
      USING ERRCODE = '28000';
  END IF;
  RETURN QUERY
  SELECT v_version.id, v_version.review_set_digest, entry.entry_id,
    entry.entry_kind, entry.agent, entry.requirement_key, entry.content,
    entry.content_digest, entry.digest_key_id, entry.projection_eligible
  FROM public.mcp_operator_review_entries entry
  WHERE entry.review_version_id = v_version.id
  ORDER BY entry.entry_id
  LIMIT 256;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION forge.list_approved_package_plan_registrations_v1(
  p_session_credential bytea,
  p_approval_gate_id uuid,
  p_source_plan_version bigint,
  p_expected_review_revision integer,
  p_expected_review_set_digest text
)
RETURNS TABLE (work_package_id uuid, registration_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, forge
AS $$
DECLARE
  v_credential_text text;
  v_credential_digest bytea;
  v_session public.sessions%ROWTYPE;
  v_gate public.approval_gates%ROWTYPE;
  v_review_version_id uuid;
BEGIN
  IF session_user <> 'forge_architect_plan_history_reader'
     OR current_user <> 'forge_s4_routines_owner' THEN
    RAISE EXCEPTION 'approved package registration projection requires the credential-bound history principal'
      USING ERRCODE = '42501';
  END IF;
  IF NOT forge.s4_protected_paths_enabled_v1() THEN
    RAISE EXCEPTION 'Approved package registration projection is not enabled by the Step 0 authority'
      USING ERRCODE = '55000';
  END IF;
  IF pg_catalog.octet_length(p_session_credential) <> 36
     OR p_source_plan_version <= 0
     OR p_expected_review_revision <= 0
     OR p_expected_review_set_digest !~ '^hmac-sha256:[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'approved package registration projection input is invalid'
      USING ERRCODE = '22023';
  END IF;
  v_credential_text := pg_catalog.convert_from(p_session_credential, 'UTF8');
  IF v_credential_text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR pg_catalog.convert_to(v_credential_text, 'UTF8') <> p_session_credential THEN
    RAISE EXCEPTION 'Session credential is malformed' USING ERRCODE = '22023';
  END IF;
  v_credential_digest := pg_catalog.sha256(
    pg_catalog.decode('666f7267653a7765622d73657373696f6e3a763100', 'hex')
      || p_session_credential
  );
  SELECT session_row.* INTO STRICT v_session
  FROM public.sessions session_row
  WHERE session_row.credential_digest_v1 = v_credential_digest
    AND session_row.revoked_at IS NULL
    AND session_row.expires_at IS NOT NULL
    AND pg_catalog.clock_timestamp() < session_row.expires_at
  FOR UPDATE;

  SELECT gate.* INTO STRICT v_gate
  FROM public.approval_gates gate
  JOIN public.tasks task
    ON task.id = gate.task_id AND task.submitted_by = v_session.user_id
  WHERE gate.id = p_approval_gate_id
    AND gate.gate_type = 'plan_approval'
    AND gate.status IN ('pending','needs_rework')
    AND gate.source_artifact_id IS NOT NULL
    AND gate.protected_review_revision = p_expected_review_revision
    AND gate.protected_review_set_digest = p_expected_review_set_digest
  FOR UPDATE OF gate;

  SELECT review.id INTO STRICT v_review_version_id
  FROM public.mcp_operator_review_versions review
  WHERE review.approval_gate_id = v_gate.id
    AND review.task_id = v_gate.task_id
    AND review.source_artifact_id = v_gate.source_artifact_id
    AND review.source_plan_version = p_source_plan_version
    AND review.revision = v_gate.protected_review_revision
    AND review.review_set_digest = v_gate.protected_review_set_digest
    AND review.item_count = v_gate.protected_review_item_count
    AND review.approved_count = v_gate.protected_review_approved_count
    AND review.denied_count = v_gate.protected_review_denied_count
    AND review.blocker_codes = v_gate.protected_review_blocker_codes
  FOR KEY SHARE;
  PERFORM 1
  FROM public.architect_plan_versions version
  WHERE version.task_id = v_gate.task_id
    AND version.plan_artifact_id = v_gate.source_artifact_id
    AND version.plan_version = p_source_plan_version
    AND NOT EXISTS (
      SELECT 1 FROM public.architect_plan_versions newer
      WHERE newer.task_id = v_gate.task_id
        AND newer.plan_version > version.plan_version
    )
  FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'approved package registration projection source is stale'
      USING ERRCODE = '40001';
  END IF;

  PERFORM 1 FROM public.sessions session_row
  WHERE session_row.id = v_session.id
    AND session_row.credential_digest_v1 = v_credential_digest
    AND session_row.revoked_at IS NULL
    AND session_row.expires_at IS NOT NULL
    AND pg_catalog.clock_timestamp() < session_row.expires_at
  FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Session credential expired before registration projection delivery'
      USING ERRCODE = '28000';
  END IF;

  RETURN QUERY
  SELECT registration.work_package_id, registration.id
  FROM public.protected_package_entry_registrations registration
  JOIN public.work_packages package
    ON package.id = registration.work_package_id
   AND package.task_id = registration.task_id
  JOIN public.architect_plan_entries entry
    ON entry.task_id = registration.task_id
   AND entry.plan_artifact_id = registration.source_id
   AND entry.plan_version = registration.source_version
   AND entry.entry_id = registration.entry_id
   AND entry.entry_kind = registration.entry_kind
   AND entry.content_digest = registration.content_digest
   AND entry.digest_key_id = registration.digest_key_id
   AND entry.projection_eligible
  WHERE registration.task_id = v_gate.task_id
    AND registration.source_kind = 'architect_plan'
    AND registration.source_id = v_gate.source_artifact_id
    AND registration.source_version = p_source_plan_version
    AND NOT EXISTS (
      SELECT 1
      FROM (
        SELECT entry.requirement_key AS requirement_key
        WHERE entry.requirement_key IS NOT NULL
        UNION
        SELECT binding.requirement_key
        FROM public.protected_entry_capability_bindings binding
        WHERE binding.source_kind = registration.source_kind
          AND binding.source_id = registration.source_id
          AND binding.source_version = registration.source_version
          AND binding.entry_id = registration.entry_id
      ) required_key
      WHERE (
        SELECT pg_catalog.count(*)
        FROM public.mcp_operator_review_entries decision
        WHERE decision.review_version_id = v_review_version_id
          AND decision.entry_kind = 'decision'
          AND decision.requirement_key = required_key.requirement_key
      ) <> 1
      OR (
        SELECT pg_catalog.count(*)
        FROM public.mcp_operator_review_entries decision
        WHERE decision.review_version_id = v_review_version_id
          AND decision.entry_kind = 'decision'
          AND decision.requirement_key = required_key.requirement_key
          AND decision.projection_eligible
          AND CASE
            WHEN pg_catalog.pg_input_is_valid(decision.content, 'pg_catalog.jsonb') THEN
              decision.content::pg_catalog.jsonb->'schemaVersion' = '2'::pg_catalog.jsonb
              AND decision.content::pg_catalog.jsonb->>'requirementKey'
                = required_key.requirement_key
              AND decision.content::pg_catalog.jsonb->>'decision' = 'approved'
            ELSE false
          END
      ) <> 1
    )
  ORDER BY registration.work_package_id, registration.id;
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
      AND entry.entry_kind IN (
        'plan_body','requirement','routing','overlay','subtask',
        'clarification_question','clarification_answer'
      )
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
CREATE TABLE public.s4_completion_handoffs (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES public.tasks(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  work_package_id uuid NOT NULL REFERENCES public.work_packages(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  agent_run_id uuid NOT NULL UNIQUE REFERENCES public.agent_runs(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  local_run_evidence_id uuid NOT NULL UNIQUE REFERENCES public.work_package_local_run_evidence(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  runtime_audit_id uuid UNIQUE REFERENCES public.filesystem_mcp_runtime_audits(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  completion_artifact_id uuid NOT NULL UNIQUE REFERENCES public.artifacts(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','materialized')),
  required_gate_types text[],
  reconciliation_claim_token uuid,
  reconciliation_claimed_by text,
  reconciliation_claim_generation bigint NOT NULL DEFAULT 0,
  reconciliation_lease_expires_at timestamptz,
  reconcile_attempt_count integer NOT NULL DEFAULT 0,
  next_reconcile_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  materialized_at timestamptz,
  CONSTRAINT s4_completion_handoffs_state_chk CHECK (
    (state = 'pending' AND required_gate_types IS NULL AND materialized_at IS NULL)
    OR (state = 'materialized' AND required_gate_types IS NOT NULL AND materialized_at IS NOT NULL)
  ),
  CONSTRAINT s4_completion_handoffs_reconciliation_claim_chk CHECK (
    reconciliation_claim_generation >= 0
    AND reconcile_attempt_count >= 0
    AND (
      (reconciliation_claim_token IS NULL AND reconciliation_claimed_by IS NULL
        AND reconciliation_lease_expires_at IS NULL)
      OR (state = 'pending' AND reconciliation_claim_token IS NOT NULL
        AND pg_catalog.length(reconciliation_claimed_by) BETWEEN 1 AND 128
        AND reconciliation_claim_generation > 0
        AND reconciliation_lease_expires_at IS NOT NULL)
    )
  ),
  CONSTRAINT s4_completion_handoffs_identity_key
    UNIQUE (id, task_id, work_package_id, agent_run_id)
);
--> statement-breakpoint
CREATE TABLE public.s4_protected_review_sources (
  source_artifact_id uuid PRIMARY KEY REFERENCES public.artifacts(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  task_id uuid NOT NULL REFERENCES public.tasks(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  work_package_id uuid NOT NULL REFERENCES public.work_packages(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  source_agent_run_id uuid NOT NULL UNIQUE REFERENCES public.agent_runs(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  content text NOT NULL CHECK (pg_catalog.octet_length(content) BETWEEN 0 AND 1048576),
  metadata jsonb,
  content_fingerprint text NOT NULL UNIQUE CHECK (content_fingerprint ~ '^sha256:[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  CONSTRAINT s4_protected_review_sources_metadata_chk CHECK (
    metadata IS NULL OR pg_catalog.jsonb_typeof(metadata) = 'object'
  )
);
--> statement-breakpoint
CREATE TABLE public.s4_protected_review_source_reads (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  approval_gate_id uuid NOT NULL REFERENCES public.approval_gates(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  source_artifact_id uuid NOT NULL REFERENCES public.s4_protected_review_sources(source_artifact_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  source_agent_run_id uuid NOT NULL REFERENCES public.agent_runs(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  content_fingerprint text NOT NULL CHECK (content_fingerprint ~ '^sha256:[0-9a-f]{64}$'),
  read_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp()
);
--> statement-breakpoint
CREATE TABLE public.filesystem_mcp_issuance_recovery_actions (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES public.tasks(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  work_package_id uuid NOT NULL REFERENCES public.work_packages(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  prior_runtime_audit_id uuid NOT NULL REFERENCES public.filesystem_mcp_runtime_audits(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  action text NOT NULL CHECK (action IN (
    'acknowledge_possible_submission','retry_execution',
    'decline_packet_recovery','resolve_after_allow_once_reapproval'
  )),
  expected_marker_fingerprint text NOT NULL CHECK (expected_marker_fingerprint ~ '^sha256:[0-9a-f]{64}$'),
  actor_user_id uuid NOT NULL REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  authorizing_decision_id uuid REFERENCES public.filesystem_mcp_grant_approvals(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  authorizing_project_decision_id uuid REFERENCES public.project_filesystem_grant_decisions(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  result text NOT NULL CHECK (result IN ('acknowledged','ready','cancelled','reapproved')),
  result_marker_fingerprint text CHECK (result_marker_fingerprint IS NULL OR result_marker_fingerprint ~ '^sha256:[0-9a-f]{64}$'),
  package_status text NOT NULL CHECK (package_status IN ('ready','blocked','cancelled')),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  CONSTRAINT filesystem_mcp_issuance_recovery_authorizer_chk CHECK (
    (action = 'retry_execution'
      AND authorizing_decision_id IS NULL
      AND authorizing_project_decision_id IS NOT NULL)
    OR (action = 'resolve_after_allow_once_reapproval'
      AND authorizing_decision_id IS NOT NULL
      AND authorizing_project_decision_id IS NULL)
    OR (action IN ('acknowledge_possible_submission','decline_packet_recovery')
      AND authorizing_decision_id IS NULL
      AND authorizing_project_decision_id IS NULL)
  ),
  UNIQUE (prior_runtime_audit_id, action, expected_marker_fingerprint, actor_user_id)
);
--> statement-breakpoint
CREATE TABLE public.local_effect_recovery_actions (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES public.tasks(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  work_package_id uuid NOT NULL REFERENCES public.work_packages(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  local_run_evidence_id uuid NOT NULL REFERENCES public.work_package_local_run_evidence(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  action text NOT NULL CHECK (action IN (
    'review_local_changes','acknowledge_possible_local_invocation',
    'retry_local_execution','decline_local_retry'
  )),
  expected_marker_fingerprint text NOT NULL CHECK (expected_marker_fingerprint ~ '^sha256:[0-9a-f]{64}$'),
  actor_user_id uuid NOT NULL REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  result text NOT NULL,
  result_marker_fingerprint text CHECK (result_marker_fingerprint IS NULL OR result_marker_fingerprint ~ '^sha256:[0-9a-f]{64}$'),
  package_status text NOT NULL CHECK (package_status IN ('ready','blocked','cancelled')),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  UNIQUE (local_run_evidence_id, action, expected_marker_fingerprint, actor_user_id)
);
--> statement-breakpoint
CREATE TABLE public.s4_max_attempt_finalizations (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES public.tasks(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  work_package_id uuid NOT NULL UNIQUE REFERENCES public.work_packages(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  transition_code text NOT NULL CHECK (transition_code = 'max_implementation_attempts_exceeded'),
  max_attempts integer NOT NULL CHECK (max_attempts = 3),
  next_attempt_number integer NOT NULL CHECK (next_attempt_number > max_attempts),
  expected_package_updated_at timestamptz NOT NULL,
  package_updated_at timestamptz NOT NULL,
  task_disposition text NOT NULL CHECK (task_disposition = 'failed'),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp()
);
CREATE TRIGGER s4_max_attempt_finalizations_append_only
  BEFORE UPDATE OR DELETE ON public.s4_max_attempt_finalizations
  FOR EACH ROW EXECUTE FUNCTION forge.reject_s4_retained_mutation_v1();
--> statement-breakpoint
CREATE TABLE public.local_projection_archive_operations (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  source_task_id uuid NOT NULL REFERENCES public.tasks(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  replacement_task_id uuid NOT NULL REFERENCES public.tasks(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  actor_user_id uuid NOT NULL REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  state text NOT NULL CHECK (state IN ('validated','quiesced','archived','rolled_back','cancelled')),
  source_scope_version bigint NOT NULL CHECK (source_scope_version > 0),
  replacement_version bigint NOT NULL CHECK (replacement_version > 0),
  source_fingerprint text NOT NULL CHECK (source_fingerprint ~ '^sha256:[0-9a-f]{64}$'),
  replacement_fingerprint text NOT NULL CHECK (replacement_fingerprint ~ '^sha256:[0-9a-f]{64}$'),
  operation_fingerprint text NOT NULL UNIQUE CHECK (operation_fingerprint ~ '^sha256:[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  completed_at timestamptz
);
--> statement-breakpoint
CREATE UNIQUE INDEX local_projection_archive_operations_live_source_unique
  ON public.local_projection_archive_operations (source_task_id)
  WHERE state IN ('validated','quiesced','archived');
CREATE UNIQUE INDEX local_projection_archive_operations_live_replacement_unique
  ON public.local_projection_archive_operations (replacement_task_id)
  WHERE state IN ('validated','quiesced','archived');
--> statement-breakpoint
CREATE TABLE public.local_projection_archive_operation_checkpoints (
  operation_id uuid NOT NULL REFERENCES public.local_projection_archive_operations(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 1 AND 5),
  state text NOT NULL CHECK (state IN ('validated','quiesced','archived','rolled_back','cancelled')),
  operation_fingerprint text NOT NULL CHECK (operation_fingerprint ~ '^sha256:[0-9a-f]{64}$'),
  actor_user_id uuid NOT NULL REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  recorded_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  PRIMARY KEY (operation_id, ordinal),
  UNIQUE (operation_id, state)
);
--> statement-breakpoint
CREATE TRIGGER filesystem_mcp_issuance_recovery_actions_append_only
  BEFORE UPDATE OR DELETE ON public.filesystem_mcp_issuance_recovery_actions
  FOR EACH ROW EXECUTE FUNCTION forge.reject_s4_retained_mutation_v1();
CREATE TRIGGER local_effect_recovery_actions_append_only
  BEFORE UPDATE OR DELETE ON public.local_effect_recovery_actions
  FOR EACH ROW EXECUTE FUNCTION forge.reject_s4_retained_mutation_v1();
CREATE TRIGGER s4_protected_review_source_reads_append_only
  BEFORE UPDATE OR DELETE ON public.s4_protected_review_source_reads
  FOR EACH ROW EXECUTE FUNCTION forge.reject_s4_retained_mutation_v1();
CREATE TRIGGER local_projection_archive_checkpoints_append_only
  BEFORE UPDATE OR DELETE ON public.local_projection_archive_operation_checkpoints
  FOR EACH ROW EXECUTE FUNCTION forge.reject_s4_retained_mutation_v1();
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
-- Startup must consult database authority before constructing any protected
-- issuer client. This coarse reader is the only S4 routine granted to the
-- ordinary application login and returns no protected row identity.
CREATE OR REPLACE FUNCTION forge.read_s4_runtime_mode_for_application_v1()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, forge
AS $$
BEGIN
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
CREATE OR REPLACE FUNCTION forge.packet_recovery_marker_token_v2(p_value text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT CASE WHEN p_value IS NULL THEN '-1:'
    ELSE pg_catalog.octet_length(pg_catalog.convert_to(p_value, 'UTF8'))::text || ':' || p_value
  END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION forge.packet_recovery_marker_fingerprint_v2(p_marker jsonb)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = pg_catalog, forge
AS $$
  SELECT 'sha256:' || pg_catalog.encode(pg_catalog.sha256(
    pg_catalog.convert_to('forge:packet-recovery-marker:v2', 'UTF8')
    || pg_catalog.decode('00', 'hex')
    || pg_catalog.convert_to(pg_catalog.concat_ws('|',
      forge.packet_recovery_marker_token_v2(p_marker->>'schemaVersion'),
      forge.packet_recovery_marker_token_v2(p_marker->>'kind'),
      forge.packet_recovery_marker_token_v2(p_marker->>'priorAgentRunId'),
      forge.packet_recovery_marker_token_v2(p_marker->>'priorRuntimeAuditId'),
      forge.packet_recovery_marker_token_v2(p_marker->'recoveryFailure'->>'status'),
      forge.packet_recovery_marker_token_v2(p_marker->'recoveryFailure'->>'failureCode'),
      forge.packet_recovery_marker_token_v2(p_marker->'recoveryFailure'->>'failureStage'),
      forge.packet_recovery_marker_token_v2(p_marker->>'deliveryState'),
      forge.packet_recovery_marker_token_v2(p_marker->>'grantMode'),
      forge.packet_recovery_marker_token_v2(p_marker->>'disposition'),
      forge.packet_recovery_marker_token_v2(p_marker->>'nextDisposition'),
      forge.packet_recovery_marker_token_v2(p_marker->>'acknowledgedAt'),
      forge.packet_recovery_marker_token_v2(p_marker->>'acknowledgedByUserId'),
      forge.packet_recovery_marker_token_v2(p_marker->>'combinedRepositoryReviewFingerprint'),
      forge.packet_recovery_marker_token_v2(p_marker->>'policyFingerprint'),
      forge.packet_recovery_marker_token_v2(p_marker->>'coverageFingerprint'),
      forge.packet_recovery_marker_token_v2(p_marker->>'autoRetryable')
    ), 'UTF8')
  ), 'hex')
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
  p_expected_provider_updated_at timestamptz,
  p_acp_execution_mode text,
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
  v_provider public.provider_configs%ROWTYPE;
  v_package_count integer;
  v_projection_head_count integer;
  v_expected_attempt integer;
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
     OR p_acp_execution_mode NOT IN ('not_applicable', 'unconfined_host_process')
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
    AND task.status = 'running'
    AND task.local_projection_scope_state = 'active'
    AND task.local_projection_overlimit_package_count IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'work-package task is not running' USING ERRCODE = '40001';
  END IF;
  PERFORM 1 FROM public.work_packages package
  WHERE package.task_id = p_task_id ORDER BY package.id FOR UPDATE;
  GET DIAGNOSTICS v_package_count = ROW_COUNT;
  IF v_package_count < 1 OR v_package_count > 256 THEN
    RAISE EXCEPTION 'work-package claim is outside the bounded projection scope'
      USING ERRCODE = 'P1726';
  END IF;
  -- The fixed heads are the complete current-authority projection input. Lock
  -- them after sibling packages, in the shared canonical order, and reject a
  -- missing/duplicate/misindexed set before creating a run.
  PERFORM 1 FROM public.work_package_local_projection_heads head
  WHERE head.task_id = p_task_id ORDER BY head.id FOR UPDATE;
  GET DIAGNOSTICS v_projection_head_count = ROW_COUNT;
  IF v_projection_head_count <> v_package_count * 8
     OR EXISTS (
       SELECT 1
       FROM public.work_package_local_projection_heads head
       WHERE head.task_id = p_task_id
       GROUP BY head.work_package_id
       HAVING pg_catalog.count(*) <> 8
          OR pg_catalog.count(DISTINCT head.head_kind) <> 8
          OR pg_catalog.min(head.head_index) <> 0
          OR pg_catalog.max(head.head_index) <> 7
     ) THEN
    RAISE EXCEPTION 'work-package projection head aggregate is incomplete or divergent'
      USING ERRCODE = 'P1726';
  END IF;
  IF p_provider_config_id IS NULL THEN
    IF p_expected_provider_updated_at IS NOT NULL
       OR p_acp_execution_mode <> 'not_applicable' THEN
      RAISE EXCEPTION 'provider-free claims cannot carry a provider snapshot'
        USING ERRCODE = '22023';
    END IF;
  ELSE
    SELECT provider.* INTO STRICT v_provider
    FROM public.provider_configs provider
    WHERE provider.id = p_provider_config_id
      AND provider.updated_at = p_expected_provider_updated_at
      AND provider.is_active
    FOR UPDATE;
    IF (v_provider.provider_type = 'acp'
          AND p_acp_execution_mode <> 'unconfined_host_process')
       OR (v_provider.provider_type <> 'acp'
          AND p_acp_execution_mode <> 'not_applicable') THEN
      RAISE EXCEPTION 'provider snapshot and ACP execution mode disagree'
        USING ERRCODE = '22023';
    END IF;
  END IF;
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

  SELECT COALESCE(pg_catalog.max(run.attempt_number), 0) + 1
  INTO v_expected_attempt
  FROM public.agent_runs run
  WHERE run.task_id = p_task_id
    AND run.work_package_id = p_work_package_id
    AND run.stage = p_stage
    AND run.attempt_number IS NOT NULL;
  IF v_expected_attempt <> p_attempt_number THEN
    RAISE EXCEPTION 'work-package attempt number is not the next retained attempt'
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
    attempt_number, provider_config_id, model_id_used,
    provider_type_used, provider_is_local_used,
    provider_config_updated_at_used, acp_execution_mode,
    status, started_at
  ) VALUES (
    p_agent_run_id, p_task_id, p_work_package_id, p_harness_id, p_agent_type,
    p_stage, p_attempt_number, p_provider_config_id, p_model_id_used,
    CASE WHEN p_provider_config_id IS NULL THEN NULL ELSE v_provider.provider_type END,
    CASE WHEN p_provider_config_id IS NULL THEN NULL ELSE v_provider.is_local END,
    CASE WHEN p_provider_config_id IS NULL THEN NULL ELSE v_provider.updated_at END,
    p_acp_execution_mode,
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
  v_task_id uuid;
  v_work_package_id uuid;
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
  VALUES (
    v_agent_run_id, p_artifact_type,
    'Protected review source available through its approval gate.',
    pg_catalog.jsonb_build_object('schemaVersion', 1, 'protectedReviewSource', true)
  )
  RETURNING id INTO v_artifact_id;
  SELECT evidence.task_id, evidence.work_package_id
  INTO STRICT v_task_id, v_work_package_id
  FROM public.work_package_local_run_evidence evidence
  WHERE evidence.id = p_local_run_evidence_id;
  INSERT INTO public.s4_protected_review_sources (
    source_artifact_id, task_id, work_package_id, source_agent_run_id,
    content, metadata, content_fingerprint
  ) VALUES (
    v_artifact_id, v_task_id, v_work_package_id, v_agent_run_id,
    p_artifact_content, p_artifact_metadata,
    'sha256:' || pg_catalog.encode(pg_catalog.sha256(
      pg_catalog.convert_to('forge:protected-review-source:v1:' || v_agent_run_id::text || ':' ||
        p_artifact_content || ':' || COALESCE(p_artifact_metadata::text, 'null'), 'UTF8')
    ), 'hex')
  );
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
  INSERT INTO public.s4_completion_handoffs (
    task_id, work_package_id, agent_run_id, local_run_evidence_id,
    completion_artifact_id
  ) VALUES (
    v_task_id, v_work_package_id, v_agent_run_id,
    p_local_run_evidence_id, v_artifact_id
  );
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
  v_terminal jsonb;
  v_marker jsonb;
  v_evidence_fingerprint text;
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
  v_terminal := pg_catalog.jsonb_build_object(
    'status', 'failed', 'failureCode', p_failure_code
  );
  v_evidence_fingerprint := 'sha256:' || pg_catalog.encode(pg_catalog.sha256(
    pg_catalog.convert_to(
      'forge:local-run-evidence:v1:' || p_local_run_evidence_id::text || ':' || v_terminal::text,
      'UTF8'
    )
  ), 'hex');
  v_marker := pg_catalog.jsonb_build_object(
    'schemaVersion', 1, 'kind', 'local_effect_recovery',
    'source', 'local-run-evidence', 'priorAgentRunId', v_agent_run_id::text,
    'localRunEvidenceId', p_local_run_evidence_id::text,
    'evidenceFingerprint', v_evidence_fingerprint,
    'taskDisposition', 'operator_hold', 'autoRetryable', false,
    'reason', CASE p_failure_code
      WHEN 'local_invocation_uncertain' THEN 'local_invocation_uncertain'
      WHEN 'external_repository_change_requires_review' THEN 'repository_change_requires_review'
      ELSE 'local_execution_interrupted' END,
    'disposition', CASE p_failure_code
      WHEN 'local_invocation_uncertain' THEN 'acknowledge_possible_local_invocation'
      WHEN 'external_repository_change_requires_review' THEN 'review_local_changes'
      ELSE 'retry_local_execution' END,
    'reviewState', CASE p_failure_code
      WHEN 'external_repository_change_requires_review' THEN 'review_required'
      ELSE 'not_applicable' END
  );
  IF p_failure_code = 'local_invocation_uncertain' THEN
    v_marker := v_marker || pg_catalog.jsonb_build_object(
      'invocationAttemptId', p_local_run_evidence_id::text,
      'acknowledgedAt', NULL, 'acknowledgedByUserId', NULL
    );
  ELSIF p_failure_code = 'external_repository_change_requires_review' THEN
    v_marker := v_marker || pg_catalog.jsonb_build_object(
      'nextDisposition', 'retry_local_execution'
    );
  END IF;
  UPDATE public.work_package_local_run_evidence evidence
  SET state = CASE WHEN p_failure_code = 'local_invocation_uncertain'
    THEN 'uncertain' ELSE 'terminal' END,
      terminal = v_terminal,
      terminal_at = v_now
  WHERE evidence.id = p_local_run_evidence_id AND evidence.state = 'claimed';
  UPDATE public.agent_runs run
  SET status = 'failed', completed_at = v_now,
      error_message = 'Protected local execution failed: ' || p_failure_code
  WHERE run.id = v_agent_run_id AND run.status = 'running';
  UPDATE public.work_packages package
  SET status = 'blocked', metadata = pg_catalog.jsonb_set(
    package.metadata - 'executionLease', '{local_effect_recovery}', v_marker, true
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
  VALUES (
    v_audit.agent_run_id, p_artifact_type,
    'Protected review source available through its approval gate.',
    pg_catalog.jsonb_build_object('schemaVersion', 1, 'protectedReviewSource', true)
  )
  RETURNING id INTO v_artifact_id;
  INSERT INTO public.s4_protected_review_sources (
    source_artifact_id, task_id, work_package_id, source_agent_run_id,
    content, metadata, content_fingerprint
  ) VALUES (
    v_artifact_id, v_audit.task_id, v_audit.work_package_id, v_audit.agent_run_id,
    p_artifact_content, p_artifact_metadata,
    'sha256:' || pg_catalog.encode(pg_catalog.sha256(
      pg_catalog.convert_to('forge:protected-review-source:v1:' || v_audit.agent_run_id::text || ':' ||
        p_artifact_content || ':' || COALESCE(p_artifact_metadata::text, 'null'), 'UTF8')
    ), 'hex')
  );
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
  INSERT INTO public.s4_completion_handoffs (
    task_id, work_package_id, agent_run_id, local_run_evidence_id,
    runtime_audit_id, completion_artifact_id
  ) VALUES (
    v_audit.task_id, v_audit.work_package_id, v_audit.agent_run_id,
    v_audit.local_run_evidence_id, v_audit.id, v_artifact_id
  );
  RETURN v_artifact_id;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION forge.materialize_s4_completion_handoff_v1(
  p_agent_run_id uuid,
  p_required_gate_types text[]
)
RETURNS TABLE (package_status text, source_artifact_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, forge
AS $$
DECLARE
  v_handoff public.s4_completion_handoffs%ROWTYPE;
  v_package public.work_packages%ROWTYPE;
  v_project_id uuid;
  v_gate_type text;
  v_now timestamptz := pg_catalog.clock_timestamp();
BEGIN
  IF session_user <> 'forge_packet_issuer'
     OR current_user <> 'forge_s4_routines_owner' THEN
    RAISE EXCEPTION 'completion handoff requires the fixed-path issuer'
      USING ERRCODE = '42501';
  END IF;
  IF p_required_gate_types IS NULL
     OR NOT p_required_gate_types <@ ARRAY['qa_review','reviewer_review','security_review']::text[]
     OR pg_catalog.cardinality(p_required_gate_types) > 3
     OR p_required_gate_types <> COALESCE((
       SELECT pg_catalog.array_agg(DISTINCT gate ORDER BY gate)
       FROM pg_catalog.unnest(p_required_gate_types) gate
     ), ARRAY[]::text[]) THEN
    RAISE EXCEPTION 'completion handoff gate set is invalid'
      USING ERRCODE = '22023';
  END IF;

  SELECT handoff.* INTO STRICT v_handoff
  FROM public.s4_completion_handoffs handoff
  WHERE handoff.agent_run_id = p_agent_run_id;
  SELECT task.project_id INTO STRICT v_project_id
  FROM public.tasks task WHERE task.id = v_handoff.task_id;
  PERFORM 1 FROM public.projects project
  WHERE project.id = v_project_id AND project.archived_at IS NULL FOR UPDATE;
  PERFORM 1 FROM public.tasks task
  WHERE task.id = v_handoff.task_id AND task.project_id = v_project_id FOR UPDATE;
  PERFORM 1 FROM public.work_packages package
  WHERE package.task_id = v_handoff.task_id ORDER BY package.id FOR UPDATE;
  PERFORM 1 FROM public.agent_runs run
  WHERE run.id = p_agent_run_id AND run.status = 'completed' FOR UPDATE;
  PERFORM 1 FROM public.work_package_local_run_evidence evidence
  WHERE evidence.id = v_handoff.local_run_evidence_id
    AND evidence.terminal = '{"status":"succeeded"}'::jsonb
    AND evidence.completion_artifact_id = v_handoff.completion_artifact_id
  FOR UPDATE;
  IF v_handoff.runtime_audit_id IS NOT NULL THEN
    PERFORM 1 FROM public.filesystem_mcp_runtime_audits audit
    WHERE audit.id = v_handoff.runtime_audit_id
      AND audit.status = 'succeeded'
      AND audit.terminal = '{"status":"succeeded"}'::jsonb
      AND audit.completion_artifact_id = v_handoff.completion_artifact_id
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'completion handoff packet evidence is incoherent'
        USING ERRCODE = '55000';
    END IF;
  END IF;
  SELECT handoff.* INTO STRICT v_handoff
  FROM public.s4_completion_handoffs handoff
  WHERE handoff.agent_run_id = p_agent_run_id FOR UPDATE;
  SELECT package.* INTO STRICT v_package
  FROM public.work_packages package
  WHERE package.id = v_handoff.work_package_id;

  IF v_handoff.state = 'materialized' THEN
    IF v_handoff.required_gate_types <> p_required_gate_types THEN
      RAISE EXCEPTION 'completion handoff replay changed the gate set'
        USING ERRCODE = '40001';
    END IF;
    package_status := v_package.status;
    source_artifact_id := v_handoff.completion_artifact_id;
    RETURN NEXT;
    RETURN;
  END IF;
  IF v_handoff.reconciliation_claim_token IS NOT NULL THEN
    RAISE EXCEPTION 'completion handoff has an active reconciliation claim'
      USING ERRCODE = '40001';
  END IF;
  IF (v_package.review_requirement = 'qa_only'
        AND NOT p_required_gate_types @> ARRAY['qa_review']::text[])
     OR (v_package.review_requirement = 'reviewer_only'
        AND NOT p_required_gate_types @> ARRAY['reviewer_review']::text[])
     OR (v_package.review_requirement = 'both'
        AND NOT p_required_gate_types @> ARRAY['qa_review','reviewer_review']::text[])
     OR v_package.review_requirement NOT IN ('none','qa_only','reviewer_only','both') THEN
    RAISE EXCEPTION 'completion handoff omitted a package-required review gate'
      USING ERRCODE = '55000';
  END IF;
  IF v_package.status <> 'running'
     OR v_package.metadata->'executionLease'->>'runId' <> p_agent_run_id::text THEN
    RAISE EXCEPTION 'completion handoff no longer owns the package lease'
      USING ERRCODE = '40001';
  END IF;

  FOREACH v_gate_type IN ARRAY p_required_gate_types LOOP
    INSERT INTO public.approval_gates (
      task_id, work_package_id, gate_type, status, source_agent_run_id,
      source_artifact_id, title, instructions, metadata
    ) VALUES (
      v_handoff.task_id, v_handoff.work_package_id, v_gate_type, 'pending',
      p_agent_run_id, v_handoff.completion_artifact_id,
      CASE v_gate_type
        WHEN 'qa_review' THEN 'QA review: ' || v_package.title
        WHEN 'reviewer_review' THEN 'Reviewer review: ' || v_package.title
        ELSE 'Security review: ' || v_package.title
      END,
      CASE v_gate_type
        WHEN 'qa_review' THEN 'QA must verify the output for "' || v_package.title || '" before reviewer approval.'
        WHEN 'reviewer_review' THEN 'Reviewer must approve the output for "' || v_package.title || '" after QA completion.'
        ELSE 'Security review must inspect high-risk implementation output from "' || v_package.title || '" and record structured findings or explicit no-findings evidence.'
      END,
      pg_catalog.jsonb_build_object(
        'schemaVersion', 1,
        'requiredRole', CASE v_gate_type
          WHEN 'qa_review' THEN 'qa'
          WHEN 'reviewer_review' THEN 'reviewer'
          ELSE 'security'
        END,
        'source', 'review-gates',
        'sourcePackageId', v_handoff.work_package_id::text,
        'sourceRunId', p_agent_run_id::text
      )
    );
  END LOOP;

  UPDATE public.work_packages package
  SET status = CASE WHEN pg_catalog.cardinality(p_required_gate_types) = 0
      THEN 'completed' ELSE 'awaiting_review' END,
      blocked_reason = NULL,
      metadata = package.metadata - 'executionLease',
      updated_at = v_now
  WHERE package.id = v_handoff.work_package_id
    AND package.status = 'running'
    AND package.metadata->'executionLease'->>'runId' = p_agent_run_id::text;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'completion handoff lost its package lease'
      USING ERRCODE = '40001';
  END IF;
  UPDATE public.s4_completion_handoffs handoff
  SET state = 'materialized', required_gate_types = p_required_gate_types,
      materialized_at = v_now,
      reconciliation_claim_token = NULL,
      reconciliation_claimed_by = NULL,
      reconciliation_lease_expires_at = NULL
  WHERE handoff.id = v_handoff.id AND handoff.state = 'pending'
    AND handoff.reconciliation_claim_token IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'completion handoff lost its materialization compare-and-set'
      USING ERRCODE = '40001';
  END IF;

  package_status := CASE WHEN pg_catalog.cardinality(p_required_gate_types) = 0
    THEN 'completed' ELSE 'awaiting_review' END;
  source_artifact_id := v_handoff.completion_artifact_id;
  RETURN NEXT;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION forge.discover_s4_completion_handoff_v1(
  p_work_package_id uuid
)
RETURNS TABLE (
  agent_run_id uuid,
  local_run_evidence_id uuid,
  runtime_audit_id uuid,
  source_artifact_id uuid,
  handoff_state text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, forge
AS $$
BEGIN
  IF session_user <> 'forge_packet_issuer'
     OR current_user <> 'forge_s4_routines_owner' THEN
    RAISE EXCEPTION 'completion discovery requires the fixed-path issuer'
      USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT handoff.agent_run_id, handoff.local_run_evidence_id,
    handoff.runtime_audit_id, handoff.completion_artifact_id, handoff.state
  FROM public.s4_completion_handoffs handoff
  JOIN public.agent_runs run ON run.id = handoff.agent_run_id
  JOIN public.work_packages package ON package.id = handoff.work_package_id
  WHERE handoff.work_package_id = p_work_package_id
    AND handoff.state = 'pending'
    AND run.status = 'completed'
    AND package.status = 'running'
    AND package.metadata->'executionLease'->>'runId' = handoff.agent_run_id::text
  ORDER BY handoff.created_at, handoff.id
  LIMIT 2;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION forge.list_pending_s4_completion_handoffs_v1(
  p_limit integer,
  p_after_created_at timestamptz,
  p_after_id uuid
)
RETURNS TABLE (
  handoff_id uuid,
  agent_run_id uuid,
  work_package_id uuid,
  task_id uuid,
  local_run_evidence_id uuid,
  runtime_audit_id uuid,
  source_artifact_id uuid,
  handoff_state text,
  review_requirement text,
  created_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, forge
AS $$
BEGIN
  IF session_user <> 'forge_packet_issuer'
     OR current_user <> 'forge_s4_routines_owner' THEN
    RAISE EXCEPTION 'completion handoff listing requires the fixed-path issuer'
      USING ERRCODE = '42501';
  END IF;
  IF NOT forge.s4_protected_paths_enabled_v1() THEN
    RAISE EXCEPTION 'S4 completion handoff listing is disabled by the Step 0 authority'
      USING ERRCODE = '55000';
  END IF;
  IF p_limit NOT BETWEEN 1 AND 100
     OR (p_after_created_at IS NULL) <> (p_after_id IS NULL) THEN
    RAISE EXCEPTION 'completion handoff list limit or cursor is invalid'
      USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  SELECT handoff.id, handoff.agent_run_id, handoff.work_package_id,
    handoff.task_id, handoff.local_run_evidence_id, handoff.runtime_audit_id,
    handoff.completion_artifact_id, handoff.state, package.review_requirement,
    handoff.created_at
  FROM public.s4_completion_handoffs handoff
  JOIN public.agent_runs run
    ON run.id = handoff.agent_run_id
   AND run.task_id = handoff.task_id
   AND run.work_package_id = handoff.work_package_id
  JOIN public.work_packages package
    ON package.id = handoff.work_package_id
   AND package.task_id = handoff.task_id
  WHERE handoff.state = 'pending'
    AND run.status = 'completed'
    AND package.status = 'running'
    AND package.metadata->'executionLease'->>'runId' = handoff.agent_run_id::text
    AND (
      p_after_created_at IS NULL
      OR (handoff.created_at, handoff.id) > (p_after_created_at, p_after_id)
    )
  ORDER BY handoff.created_at, handoff.id
  LIMIT p_limit;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION forge.claim_pending_s4_completion_handoffs_v1(
  p_worker_id text,
  p_claim_token uuid,
  p_lease_seconds integer,
  p_limit integer
)
RETURNS TABLE (
  handoff_id uuid,
  agent_run_id uuid,
  work_package_id uuid,
  task_id uuid,
  local_run_evidence_id uuid,
  runtime_audit_id uuid,
  source_artifact_id uuid,
  handoff_state text,
  review_requirement text,
  created_at timestamptz,
  claim_generation bigint,
  lease_expires_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, forge
AS $$
DECLARE
  v_now timestamptz := pg_catalog.clock_timestamp();
BEGIN
  IF session_user <> 'forge_packet_issuer'
     OR current_user <> 'forge_s4_routines_owner' THEN
    RAISE EXCEPTION 'completion handoff claim requires the fixed-path issuer'
      USING ERRCODE = '42501';
  END IF;
  IF NOT forge.s4_protected_paths_enabled_v1() THEN
    RAISE EXCEPTION 'S4 completion handoff claims are disabled by the Step 0 authority'
      USING ERRCODE = '55000';
  END IF;
  IF pg_catalog.length(p_worker_id) NOT BETWEEN 1 AND 128
     OR p_worker_id !~ '^[A-Za-z0-9._:-]+$'
     OR p_claim_token IS NULL
     OR p_lease_seconds NOT BETWEEN 1 AND 300
     OR p_limit NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'completion handoff claim input is invalid'
      USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  WITH candidates AS (
    SELECT handoff.id
    FROM public.s4_completion_handoffs handoff
    JOIN public.agent_runs run
      ON run.id = handoff.agent_run_id AND run.status = 'completed'
    JOIN public.work_packages package
      ON package.id = handoff.work_package_id
     AND package.task_id = handoff.task_id
    WHERE handoff.state = 'pending'
      AND package.status = 'running'
      AND package.metadata->'executionLease'->>'runId' = handoff.agent_run_id::text
      AND (
        handoff.reconciliation_claim_token IS NULL
        OR handoff.reconciliation_lease_expires_at <= v_now
      )
      AND handoff.next_reconcile_at <= v_now
    ORDER BY handoff.created_at, handoff.id
    FOR UPDATE OF handoff SKIP LOCKED
    LIMIT p_limit
  ), claimed AS (
    UPDATE public.s4_completion_handoffs handoff
    SET reconciliation_claim_token = p_claim_token,
        reconciliation_claimed_by = p_worker_id,
        reconciliation_claim_generation = handoff.reconciliation_claim_generation + 1,
        reconciliation_lease_expires_at = v_now + pg_catalog.make_interval(secs => p_lease_seconds),
        reconcile_attempt_count = handoff.reconcile_attempt_count + 1,
        next_reconcile_at = v_now + pg_catalog.make_interval(
          secs => p_lease_seconds + LEAST(
            300, pg_catalog.power(2, LEAST(handoff.reconcile_attempt_count, 8))::integer
          )
        )
    FROM candidates
    WHERE handoff.id = candidates.id
    RETURNING handoff.*
  )
  SELECT claimed.id, claimed.agent_run_id, claimed.work_package_id,
    claimed.task_id, claimed.local_run_evidence_id, claimed.runtime_audit_id,
    claimed.completion_artifact_id, claimed.state, package.review_requirement,
    claimed.created_at, claimed.reconciliation_claim_generation,
    claimed.reconciliation_lease_expires_at
  FROM claimed
  JOIN public.work_packages package ON package.id = claimed.work_package_id
  ORDER BY claimed.created_at, claimed.id;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION forge.materialize_claimed_s4_completion_handoff_v1(
  p_agent_run_id uuid,
  p_required_gate_types text[],
  p_worker_id text,
  p_claim_token uuid,
  p_claim_generation bigint
)
RETURNS TABLE (package_status text, source_artifact_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, forge
AS $$
DECLARE
  v_now timestamptz := pg_catalog.clock_timestamp();
BEGIN
  IF session_user <> 'forge_packet_issuer'
     OR current_user <> 'forge_s4_routines_owner' THEN
    RAISE EXCEPTION 'claimed completion materialization requires the fixed-path issuer'
      USING ERRCODE = '42501';
  END IF;
  UPDATE public.s4_completion_handoffs handoff
  SET reconciliation_claim_token = NULL,
      reconciliation_claimed_by = NULL,
      reconciliation_lease_expires_at = NULL
  WHERE handoff.agent_run_id = p_agent_run_id
    AND handoff.state = 'pending'
    AND handoff.reconciliation_claimed_by = p_worker_id
    AND handoff.reconciliation_claim_token = p_claim_token
    AND handoff.reconciliation_claim_generation = p_claim_generation
    AND handoff.reconciliation_lease_expires_at > v_now;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'completion handoff reconciliation lease is stale or not owned'
      USING ERRCODE = '40001';
  END IF;
  RETURN QUERY
  SELECT materialized.package_status, materialized.source_artifact_id
  FROM forge.materialize_s4_completion_handoff_v1(
    p_agent_run_id, p_required_gate_types
  ) materialized;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION forge.finalize_s4_max_attempts_v1(
  p_task_id uuid,
  p_work_package_id uuid,
  p_expected_package_updated_at timestamptz,
  p_max_attempts integer
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, forge
AS $$
DECLARE
  v_project_id uuid;
  v_task public.tasks%ROWTYPE;
  v_package public.work_packages%ROWTYPE;
  v_package_count integer;
  v_projection_head_count integer;
  v_expected_attempt integer;
  v_now timestamptz := pg_catalog.clock_timestamp();
BEGIN
  IF session_user <> 'forge_packet_issuer'
     OR current_user <> 'forge_s4_routines_owner' THEN
    RAISE EXCEPTION 'max-attempt finalization requires the fixed-path issuer'
      USING ERRCODE = '42501';
  END IF;
  IF NOT forge.s4_protected_paths_enabled_v1() THEN
    RAISE EXCEPTION 'S4 max-attempt finalization is disabled by the Step 0 authority'
      USING ERRCODE = '55000';
  END IF;
  IF p_expected_package_updated_at IS NULL
     OR p_max_attempts <> 3 THEN
    RAISE EXCEPTION 'max-attempt finalization input is invalid'
      USING ERRCODE = '22023';
  END IF;

  SELECT task.project_id INTO STRICT v_project_id
  FROM public.work_packages package
  JOIN public.tasks task ON task.id = package.task_id
  WHERE package.id = p_work_package_id AND package.task_id = p_task_id;
  PERFORM 1 FROM public.projects project
  WHERE project.id = v_project_id AND project.archived_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'max-attempt project is unavailable' USING ERRCODE = '40001';
  END IF;
  SELECT task.* INTO STRICT v_task FROM public.tasks task
  WHERE task.id = p_task_id AND task.project_id = v_project_id FOR UPDATE;
  IF EXISTS (
    SELECT 1 FROM public.s4_max_attempt_finalizations finalization
    WHERE finalization.work_package_id = p_work_package_id
  ) THEN
    RETURN false;
  END IF;
  IF v_task.status <> 'running'
     OR v_task.local_projection_scope_state <> 'active'
     OR v_task.local_projection_overlimit_package_count IS NOT NULL THEN
    RAISE EXCEPTION 'max-attempt task is outside the active protected scope'
      USING ERRCODE = '40001';
  END IF;
  PERFORM 1 FROM public.work_packages package
  WHERE package.task_id = p_task_id ORDER BY package.id FOR UPDATE;
  GET DIAGNOSTICS v_package_count = ROW_COUNT;
  IF v_package_count < 1 OR v_package_count > 256 THEN
    RAISE EXCEPTION 'max-attempt finalization is outside the bounded projection scope'
      USING ERRCODE = 'P1726';
  END IF;
  PERFORM 1 FROM public.work_package_local_projection_heads head
  WHERE head.task_id = p_task_id ORDER BY head.id FOR UPDATE;
  GET DIAGNOSTICS v_projection_head_count = ROW_COUNT;
  IF v_projection_head_count <> v_package_count * 8
     OR EXISTS (
       SELECT 1
       FROM public.work_package_local_projection_heads head
       WHERE head.task_id = p_task_id
       GROUP BY head.work_package_id
       HAVING pg_catalog.count(*) <> 8
          OR pg_catalog.count(DISTINCT head.head_kind) <> 8
          OR pg_catalog.min(head.head_index) <> 0
          OR pg_catalog.max(head.head_index) <> 7
     ) THEN
    RAISE EXCEPTION 'max-attempt projection aggregate is incomplete or divergent'
      USING ERRCODE = 'P1726';
  END IF;

  SELECT package.* INTO STRICT v_package
  FROM public.work_packages package
  WHERE package.id = p_work_package_id AND package.task_id = p_task_id;
  IF v_package.status <> 'ready'
     OR v_package.updated_at IS DISTINCT FROM p_expected_package_updated_at THEN
    RETURN false;
  END IF;
  SELECT COALESCE(pg_catalog.max(run.attempt_number), 0) + 1
  INTO v_expected_attempt
  FROM public.agent_runs run
  WHERE run.task_id = p_task_id
    AND run.work_package_id = p_work_package_id
    AND run.stage = 'implementation'
    AND run.attempt_number IS NOT NULL;
  IF v_expected_attempt <= p_max_attempts THEN
    RAISE EXCEPTION 'max-attempt threshold has not been reached in retained run history'
      USING ERRCODE = '40001';
  END IF;

  UPDATE public.work_packages package
  SET status = 'failed', blocked_reason = 'Maximum implementation attempts exceeded.',
      metadata = pg_catalog.jsonb_set(
        package.metadata, '{executionAttempts}',
        pg_catalog.jsonb_build_object(
          'schemaVersion', 2,
          'code', 'max_implementation_attempts_exceeded',
          'maxAttempts', p_max_attempts,
          'nextAttemptNumber', v_expected_attempt,
          'status', 'failed'
        ), true
      ),
      updated_at = v_now
  WHERE package.id = p_work_package_id
    AND package.task_id = p_task_id
    AND package.status = 'ready'
    AND package.updated_at = p_expected_package_updated_at;
  IF NOT FOUND THEN RETURN false; END IF;
  UPDATE public.tasks task
  SET status = 'failed', error_message = 'Maximum implementation attempts exceeded.',
      completed_at = v_now, updated_at = v_now
  WHERE task.id = p_task_id AND task.status = 'running';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'max-attempt task lost its terminal disposition compare-and-set'
      USING ERRCODE = '40001';
  END IF;
  INSERT INTO public.s4_max_attempt_finalizations (
    task_id, work_package_id, transition_code, max_attempts,
    next_attempt_number, expected_package_updated_at, package_updated_at,
    task_disposition
  ) VALUES (
    p_task_id, p_work_package_id, 'max_implementation_attempts_exceeded',
    p_max_attempts, v_expected_attempt, p_expected_package_updated_at,
    v_now, 'failed'
  );
  RETURN true;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION forge.resolve_s4_review_source_v1(
  p_approval_gate_id uuid
)
RETURNS TABLE (
  source_artifact_id uuid,
  source_agent_run_id uuid,
  content text,
  metadata jsonb,
  content_fingerprint text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, forge
AS $$
BEGIN
  IF session_user <> 'forge_review_source_resolver'
     OR current_user <> 'forge_s4_routines_owner' THEN
    RAISE EXCEPTION 'protected review source requires the fixed-path resolver'
      USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  WITH authorized AS (
    SELECT source.*
    FROM public.approval_gates gate
    JOIN public.s4_protected_review_sources source
      ON source.source_artifact_id = gate.source_artifact_id
     AND source.source_agent_run_id = gate.source_agent_run_id
     AND source.task_id = gate.task_id
     AND source.work_package_id = gate.work_package_id
    WHERE gate.id = p_approval_gate_id
      AND gate.status IN ('pending','needs_rework')
      AND gate.gate_type IN ('qa_review','reviewer_review','security_review')
    FOR UPDATE OF gate
  ), recorded AS (
    INSERT INTO public.s4_protected_review_source_reads (
      approval_gate_id, source_artifact_id, source_agent_run_id,
      content_fingerprint
    )
    SELECT p_approval_gate_id, authorized.source_artifact_id,
      authorized.source_agent_run_id, authorized.content_fingerprint
    FROM authorized
    RETURNING source_artifact_id
  )
  SELECT authorized.source_artifact_id, authorized.source_agent_run_id,
    authorized.content, authorized.metadata, authorized.content_fingerprint
  FROM authorized JOIN recorded USING (source_artifact_id);
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
  v_policy text;
  v_repository_review text;
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
  v_policy := 'sha256:' || pg_catalog.encode(pg_catalog.sha256(
    pg_catalog.convert_to(
      'forge:packet-policy:v2:' || (v_audit.authorization_snapshot->'requiredCapabilities')::text,
      'UTF8'
    )
  ), 'hex');
  v_repository_review := 'sha256:' || pg_catalog.encode(pg_catalog.sha256(
    pg_catalog.convert_to(
      'forge:packet-repository-review:none:v2:' || v_audit.id::text,
      'UTF8'
    )
  ), 'hex');
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
    'combinedRepositoryReviewFingerprint', v_repository_review,
    'policyFingerprint', v_policy,
    'coverageFingerprint', v_coverage, 'autoRetryable', false
  );
  v_marker := pg_catalog.jsonb_set(
    v_marker, '{markerFingerprint}',
    pg_catalog.to_jsonb(forge.packet_recovery_marker_fingerprint_v2(v_marker)), true
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
  v_marker jsonb;
  v_evidence_fingerprint text;
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
  v_evidence_fingerprint := 'sha256:' || pg_catalog.encode(pg_catalog.sha256(
    pg_catalog.convert_to(
      'forge:local-run-evidence:v1:' || v_local.id::text || ':' || v_local.terminal::text,
      'UTF8'
    )
  ), 'hex');
  v_marker := pg_catalog.jsonb_build_object(
    'schemaVersion', 1, 'kind', 'local_effect_recovery',
    'source', 'local-run-evidence', 'priorAgentRunId', v_local.agent_run_id::text,
    'localRunEvidenceId', v_local.id::text,
    'evidenceFingerprint', v_evidence_fingerprint,
    'taskDisposition', 'operator_hold', 'autoRetryable', false,
    'reason', 'local_invocation_uncertain',
    'disposition', 'acknowledge_possible_local_invocation',
    'reviewState', 'not_applicable',
    'invocationAttemptId', v_local.id::text,
    'acknowledgedAt', NULL, 'acknowledgedByUserId', NULL
  );
  UPDATE public.work_packages package
  SET status = 'blocked', metadata = pg_catalog.jsonb_set(
    package.metadata - 'executionLease', '{local_effect_recovery}',
    v_marker, true
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
  v_policy text;
  v_repository_review text;
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
  v_policy := 'sha256:' || pg_catalog.encode(pg_catalog.sha256(
    pg_catalog.convert_to(
      'forge:packet-policy:v2:' || (v_audit.authorization_snapshot->'requiredCapabilities')::text,
      'UTF8'
    )
  ), 'hex');
  v_repository_review := 'sha256:' || pg_catalog.encode(pg_catalog.sha256(
    pg_catalog.convert_to(
      'forge:packet-repository-review:none:v2:' || v_audit.id::text,
      'UTF8'
    )
  ), 'hex');
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
    'combinedRepositoryReviewFingerprint', v_repository_review,
    'policyFingerprint', v_policy,
    'coverageFingerprint', v_coverage, 'autoRetryable', false
  );
  v_marker := pg_catalog.jsonb_set(
    v_marker, '{markerFingerprint}',
    pg_catalog.to_jsonb(forge.packet_recovery_marker_fingerprint_v2(v_marker)), true
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
  v_marker jsonb;
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
  -- Exact retry is immutable-ledger first. It remains replayable after the
  -- marker was correctly cleared by the original transaction.
  IF EXISTS (
    SELECT 1 FROM public.filesystem_mcp_issuance_recovery_actions action
    WHERE action.prior_runtime_audit_id = p_prior_runtime_audit_id
      AND action.action = 'resolve_after_allow_once_reapproval'
      AND action.expected_marker_fingerprint = p_expected_marker_fingerprint
      AND action.authorizing_decision_id = p_new_decision_id
      AND action.result = 'reapproved'
  ) THEN
    RETURN true;
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
     OR v_decision.decided_by IS NULL
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
  SELECT package.metadata->'packet_issuance' INTO v_marker
  FROM public.work_packages package
  WHERE package.id = p_work_package_id;
  IF v_marker IS NULL
     OR v_marker->>'markerFingerprint' <> p_expected_marker_fingerprint
     OR forge.packet_recovery_marker_fingerprint_v2(v_marker - 'markerFingerprint')
        <> p_expected_marker_fingerprint THEN
    RAISE EXCEPTION 'packet recovery marker fingerprint is not canonical'
      USING ERRCODE = '40001';
  END IF;
  INSERT INTO public.filesystem_mcp_issuance_recovery_actions (
    task_id, work_package_id, prior_runtime_audit_id, action,
    expected_marker_fingerprint, actor_user_id, authorizing_decision_id,
    result, result_marker_fingerprint, package_status
  ) VALUES (
    p_task_id, p_work_package_id, p_prior_runtime_audit_id,
    'resolve_after_allow_once_reapproval', p_expected_marker_fingerprint,
    v_decision.decided_by, p_new_decision_id, 'reapproved', NULL, 'ready'
  );
  UPDATE public.work_packages package
  SET status = 'ready', metadata = package.metadata - 'packet_issuance'
  WHERE package.id = p_work_package_id AND package.task_id = p_task_id
    AND package.status = 'blocked'
    AND package.metadata->'packet_issuance'->>'priorRuntimeAuditId' = p_prior_runtime_audit_id::text
    AND package.metadata->'packet_issuance'->>'markerFingerprint' = p_expected_marker_fingerprint
    AND forge.packet_recovery_marker_fingerprint_v2(
      package.metadata->'packet_issuance' - 'markerFingerprint'
    ) = p_expected_marker_fingerprint;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'packet recovery marker changed before reapproval compare-and-set'
      USING ERRCODE = '40001';
  END IF;
  RETURN true;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION forge.apply_local_effect_recovery_action_v2(
  p_task_id uuid,
  p_work_package_id uuid,
  p_local_run_evidence_id uuid,
  p_action text,
  p_expected_marker_fingerprint text,
  p_actor_user_id uuid
)
RETURNS TABLE (
  action_id uuid,
  result text,
  result_marker_fingerprint text,
  package_status text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, forge
AS $$
DECLARE
  v_project_id uuid;
  v_project public.projects%ROWTYPE;
  v_task public.tasks%ROWTYPE;
  v_package public.work_packages%ROWTYPE;
  v_evidence public.work_package_local_run_evidence%ROWTYPE;
  v_marker jsonb;
  v_next_marker jsonb;
  v_evidence_fingerprint text;
  v_action_id uuid;
  v_result text;
  v_status text;
  v_package_count integer;
  v_projection_head_count integer;
  v_now timestamptz := pg_catalog.clock_timestamp();
BEGIN
  IF session_user <> 'forge_s4_recovery_operator'
     OR current_user <> 'forge_s4_routines_owner' THEN
    RAISE EXCEPTION 'local recovery action requires the fixed recovery login'
      USING ERRCODE = '42501';
  END IF;
  IF p_action NOT IN (
    'review_local_changes','acknowledge_possible_local_invocation',
    'retry_local_execution','decline_local_retry'
  ) OR p_expected_marker_fingerprint !~ '^sha256:[0-9a-f]{64}$'
     OR NOT forge.s4_protected_paths_enabled_v1() THEN
    RAISE EXCEPTION 'local recovery action input or authority is invalid'
      USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  SELECT action.id, action.result, action.result_marker_fingerprint,
    action.package_status
  FROM public.local_effect_recovery_actions action
  WHERE action.task_id = p_task_id
    AND action.work_package_id = p_work_package_id
    AND action.local_run_evidence_id = p_local_run_evidence_id
    AND action.action = p_action
    AND action.expected_marker_fingerprint = p_expected_marker_fingerprint
    AND action.actor_user_id = p_actor_user_id;
  IF FOUND THEN RETURN; END IF;

  SELECT task.project_id INTO STRICT v_project_id
  FROM public.tasks task WHERE task.id = p_task_id;
  SELECT project.* INTO v_project
  FROM public.projects project
  WHERE project.id = v_project_id AND project.archived_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'local recovery project is unavailable'
      USING ERRCODE = '40001';
  END IF;
  SELECT task.* INTO v_task
  FROM public.tasks task
  WHERE task.id = p_task_id AND task.project_id = v_project_id
    AND task.status = 'approved'
    AND task.local_projection_scope_state = 'active'
    AND task.local_projection_overlimit_package_count IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'local recovery requires an approved active task'
      USING ERRCODE = '40001';
  END IF;
  PERFORM 1 FROM public.work_packages package
  WHERE package.task_id = p_task_id ORDER BY package.id FOR UPDATE;
  GET DIAGNOSTICS v_package_count = ROW_COUNT;
  IF v_package_count NOT BETWEEN 1 AND 256 THEN
    RAISE EXCEPTION 'local recovery is outside the bounded projection scope'
      USING ERRCODE = 'P1726';
  END IF;
  -- Recovery and normal claims share task -> sibling package -> projection-head
  -- lock order. Recovery therefore validates one complete task projection,
  -- never a mixture of sibling states from different transitions.
  PERFORM 1 FROM public.work_package_local_projection_heads head
  WHERE head.task_id = p_task_id ORDER BY head.id FOR UPDATE;
  GET DIAGNOSTICS v_projection_head_count = ROW_COUNT;
  IF v_projection_head_count <> v_package_count * 8
     OR EXISTS (
       SELECT 1
       FROM public.work_package_local_projection_heads head
       WHERE head.task_id = p_task_id
       GROUP BY head.work_package_id
       HAVING pg_catalog.count(*) <> 8
          OR pg_catalog.count(DISTINCT head.head_kind) <> 8
          OR pg_catalog.min(head.head_index) <> 0
          OR pg_catalog.max(head.head_index) <> 7
     ) THEN
    RAISE EXCEPTION 'local recovery projection is incomplete or divergent'
      USING ERRCODE = 'P1726';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.work_packages sibling
    WHERE sibling.task_id = p_task_id
      AND (
        sibling.status IN ('running','awaiting_review')
        OR sibling.metadata ? 'packet_integrity_hold'
        OR sibling.metadata ? 'local_effect_integrity_hold'
        OR (
          sibling.id <> p_work_package_id
          AND (
            sibling.metadata ? 'local_effect_recovery'
            OR sibling.metadata ? 'packet_issuance'
          )
        )
      )
  ) OR EXISTS (
    SELECT 1
    FROM public.work_packages sibling
    JOIN public.agent_runs run
      ON run.work_package_id = sibling.id
     AND run.id::text = sibling.metadata->'executionLease'->>'runId'
    WHERE sibling.task_id = p_task_id
      AND forge.s4_execution_lease_live_v1(sibling.metadata, run.id, v_now)
  ) OR EXISTS (
    SELECT 1
    FROM public.work_package_local_run_evidence evidence
    WHERE evidence.task_id = p_task_id AND evidence.state = 'claimed'
  ) OR EXISTS (
    SELECT 1
    FROM public.filesystem_mcp_runtime_audits audit
    WHERE audit.task_id = p_task_id
      AND audit.protocol_version = 2 AND audit.status = 'claiming'
  ) THEN
    RAISE EXCEPTION 'local recovery requires quiescent siblings and evidence'
      USING ERRCODE = '40001';
  END IF;
  SELECT evidence.* INTO STRICT v_evidence
  FROM public.work_package_local_run_evidence evidence
  WHERE evidence.id = p_local_run_evidence_id
    AND evidence.task_id = p_task_id
    AND evidence.work_package_id = p_work_package_id
    AND evidence.state IN ('terminal','uncertain')
  FOR UPDATE;
  -- The recovery marker is public, mutable projection state.  Rebuild the
  -- evidence identity only after locking the canonical evidence row; never
  -- authorize recovery from the marker's copied fingerprint.
  IF v_evidence.terminal IS NULL
     OR v_evidence.terminal->>'status' <> 'failed'
     OR v_evidence.terminal->>'failureCode' NOT IN (
       'local_execution_failed', 'local_invocation_uncertain',
       'external_repository_change_requires_review', 'worker_stopped'
     ) THEN
    RAISE EXCEPTION 'local recovery requires complete non-success terminal evidence'
      USING ERRCODE = '40001';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.filesystem_mcp_runtime_audits audit
    WHERE audit.protocol_version = 2
      AND audit.local_run_evidence_id = v_evidence.id
  ) THEN
    RAISE EXCEPTION 'packet-linked local evidence must use packet recovery'
      USING ERRCODE = '40001';
  END IF;
  v_evidence_fingerprint := 'sha256:' || pg_catalog.encode(pg_catalog.sha256(
    pg_catalog.convert_to(
      'forge:local-run-evidence:v1:' || v_evidence.id::text || ':' || v_evidence.terminal::text,
      'UTF8'
    )
  ), 'hex');
  SELECT package.* INTO STRICT v_package
  FROM public.work_packages package
  WHERE package.id = p_work_package_id AND package.status = 'blocked';
  v_marker := v_package.metadata->'local_effect_recovery';
  IF v_marker IS NULL
     OR v_package.metadata ? 'packet_issuance'
     OR v_package.metadata ? 'packet_integrity_hold'
     OR v_package.metadata ? 'local_effect_integrity_hold'
     OR v_marker->>'localRunEvidenceId' <> p_local_run_evidence_id::text
     OR v_marker->>'evidenceFingerprint' <> v_evidence_fingerprint
     -- The supplied value is a public-marker CAS token only. It must match the
     -- current projection but is never used as the authoritative evidence ID.
     OR p_expected_marker_fingerprint <> v_evidence_fingerprint
     OR v_marker->>'disposition' <> p_action THEN
    RAISE EXCEPTION 'local recovery marker changed before action compare-and-set'
      USING ERRCODE = '40001';
  END IF;

  v_next_marker := NULL;
  IF p_action = 'review_local_changes' THEN
    v_next_marker := (v_marker - 'nextDisposition')
      || pg_catalog.jsonb_build_object(
        'disposition', v_marker->>'nextDisposition', 'reviewState', 'reviewed'
      );
    v_result := 'reviewed';
    v_status := 'blocked';
  ELSIF p_action = 'acknowledge_possible_local_invocation' THEN
    v_next_marker := v_marker || pg_catalog.jsonb_build_object(
      'disposition', 'retry_local_execution',
      'acknowledgedAt', pg_catalog.to_char(
        pg_catalog.clock_timestamp() AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      ),
      'acknowledgedByUserId', p_actor_user_id::text
    );
    v_result := 'acknowledged';
    v_status := 'blocked';
  ELSIF p_action = 'retry_local_execution' THEN
    v_result := 'ready';
    v_status := 'ready';
  ELSE
    v_result := 'cancelled';
    v_status := 'cancelled';
  END IF;
  v_action_id := pg_catalog.gen_random_uuid();
  INSERT INTO public.local_effect_recovery_actions (
    id, task_id, work_package_id, local_run_evidence_id, action,
    expected_marker_fingerprint, actor_user_id, result,
    result_marker_fingerprint, package_status
  ) VALUES (
    v_action_id, p_task_id, p_work_package_id, p_local_run_evidence_id,
    p_action, p_expected_marker_fingerprint, p_actor_user_id, v_result,
    CASE WHEN v_next_marker IS NULL THEN NULL
      ELSE v_next_marker->>'evidenceFingerprint' END,
    v_status
  );
  UPDATE public.work_packages package
  SET status = v_status,
      metadata = CASE WHEN v_next_marker IS NULL
        THEN package.metadata - 'local_effect_recovery'
        ELSE pg_catalog.jsonb_set(
          package.metadata, '{local_effect_recovery}', v_next_marker, true
        ) END,
      updated_at = pg_catalog.clock_timestamp()
  WHERE package.id = p_work_package_id
    AND package.status = 'blocked'
    AND package.metadata->'local_effect_recovery' = v_marker;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'local recovery action lost its marker compare-and-set'
      USING ERRCODE = '40001';
  END IF;
  action_id := v_action_id;
  result := v_result;
  result_marker_fingerprint := CASE WHEN v_next_marker IS NULL THEN NULL
    ELSE v_next_marker->>'evidenceFingerprint' END;
  package_status := v_status;
  RETURN NEXT;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION forge.apply_packet_issuance_recovery_action_v2(
  p_task_id uuid,
  p_work_package_id uuid,
  p_prior_runtime_audit_id uuid,
  p_action text,
  p_expected_marker_fingerprint text,
  p_actor_user_id uuid,
  p_authorizing_decision_id uuid
)
RETURNS TABLE (
  action_id uuid,
  result text,
  result_marker_fingerprint text,
  package_status text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, forge
AS $$
DECLARE
  v_project_id uuid;
  v_project public.projects%ROWTYPE;
  v_task public.tasks%ROWTYPE;
  v_package public.work_packages%ROWTYPE;
  v_audit public.filesystem_mcp_runtime_audits%ROWTYPE;
  v_decision public.project_filesystem_grant_decisions%ROWTYPE;
  v_marker jsonb;
  v_next_marker jsonb;
  v_action_id uuid;
  v_result text;
  v_status text;
  v_package_count integer;
  v_projection_head_count integer;
  v_required_capabilities text[];
  v_approved_capabilities text[];
  v_policy_fingerprint text;
  v_decision_found boolean := false;
  v_now timestamptz := pg_catalog.clock_timestamp();
BEGIN
  IF session_user <> 'forge_s4_recovery_operator'
     OR current_user <> 'forge_s4_routines_owner' THEN
    RAISE EXCEPTION 'packet recovery action requires the fixed recovery login'
      USING ERRCODE = '42501';
  END IF;
  IF p_action NOT IN (
    'acknowledge_possible_submission','retry_execution','decline_packet_recovery'
  ) OR p_expected_marker_fingerprint !~ '^sha256:[0-9a-f]{64}$'
     OR NOT forge.s4_protected_paths_enabled_v1() THEN
    RAISE EXCEPTION 'packet recovery action input or authority is invalid'
      USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  SELECT action.id, action.result, action.result_marker_fingerprint,
    action.package_status
  FROM public.filesystem_mcp_issuance_recovery_actions action
  WHERE action.task_id = p_task_id
    AND action.work_package_id = p_work_package_id
    AND action.prior_runtime_audit_id = p_prior_runtime_audit_id
    AND action.action = p_action
    AND action.expected_marker_fingerprint = p_expected_marker_fingerprint
    AND action.actor_user_id = p_actor_user_id
    AND action.authorizing_decision_id IS NOT DISTINCT FROM
      CASE WHEN p_action = 'retry_execution' THEN NULL
        ELSE p_authorizing_decision_id END
    AND action.authorizing_project_decision_id IS NOT DISTINCT FROM
      CASE WHEN p_action = 'retry_execution' THEN p_authorizing_decision_id
        ELSE NULL END;
  IF FOUND THEN RETURN; END IF;

  SELECT task.project_id INTO STRICT v_project_id
  FROM public.tasks task WHERE task.id = p_task_id;
  SELECT project.* INTO v_project
  FROM public.projects project
  WHERE project.id = v_project_id AND project.archived_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'packet recovery project is unavailable'
      USING ERRCODE = '40001';
  END IF;
  SELECT task.* INTO v_task
  FROM public.tasks task
  WHERE task.id = p_task_id AND task.project_id = v_project_id
    AND task.status = 'approved'
    AND task.local_projection_scope_state = 'active'
    AND task.local_projection_overlimit_package_count IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'packet recovery requires an approved active task'
      USING ERRCODE = '40001';
  END IF;
  PERFORM 1 FROM public.work_packages package
  WHERE package.task_id = p_task_id ORDER BY package.id FOR UPDATE;
  GET DIAGNOSTICS v_package_count = ROW_COUNT;
  IF v_package_count NOT BETWEEN 1 AND 256 THEN
    RAISE EXCEPTION 'packet recovery is outside the bounded projection scope'
      USING ERRCODE = 'P1726';
  END IF;
  -- Recovery and normal claims share task -> sibling package -> projection-head
  -- lock order. This makes a concurrent sibling transition elect one winner
  -- instead of letting recovery validate a mixture of pre/post-transition rows.
  PERFORM 1 FROM public.work_package_local_projection_heads head
  WHERE head.task_id = p_task_id ORDER BY head.id FOR UPDATE;
  GET DIAGNOSTICS v_projection_head_count = ROW_COUNT;
  IF v_projection_head_count <> v_package_count * 8
     OR EXISTS (
       SELECT 1
       FROM public.work_package_local_projection_heads head
       WHERE head.task_id = p_task_id
       GROUP BY head.work_package_id
       HAVING pg_catalog.count(*) <> 8
          OR pg_catalog.count(DISTINCT head.head_kind) <> 8
          OR pg_catalog.min(head.head_index) <> 0
          OR pg_catalog.max(head.head_index) <> 7
     ) THEN
    RAISE EXCEPTION 'packet recovery projection is incomplete or divergent'
      USING ERRCODE = 'P1726';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.work_packages sibling
    WHERE sibling.task_id = p_task_id
      AND (
        sibling.status IN ('running','awaiting_review')
        OR sibling.metadata ? 'packet_integrity_hold'
        OR sibling.metadata ? 'local_effect_integrity_hold'
        OR sibling.metadata ? 'local_effect_recovery'
      )
  ) OR EXISTS (
    SELECT 1
    FROM public.work_packages sibling
    JOIN public.agent_runs run
      ON run.work_package_id = sibling.id
     AND run.id::text = sibling.metadata->'executionLease'->>'runId'
    WHERE sibling.task_id = p_task_id
      AND forge.s4_execution_lease_live_v1(sibling.metadata, run.id, v_now)
  ) OR EXISTS (
    SELECT 1
    FROM public.work_package_local_run_evidence evidence
    WHERE evidence.task_id = p_task_id
      AND evidence.state = 'claimed'
      AND evidence.lease_expires_at > v_now
  ) OR EXISTS (
    SELECT 1
    FROM public.filesystem_mcp_runtime_audits audit
    WHERE audit.task_id = p_task_id
      AND audit.protocol_version = 2
      AND audit.status = 'claiming'
      AND audit.lease_expires_at > v_now
  ) THEN
    RAISE EXCEPTION 'packet recovery requires quiescent siblings and evidence'
      USING ERRCODE = '40001';
  END IF;
  SELECT audit.* INTO STRICT v_audit
  FROM public.filesystem_mcp_runtime_audits audit
  WHERE audit.id = p_prior_runtime_audit_id
    AND audit.task_id = p_task_id
    AND audit.work_package_id = p_work_package_id
    AND audit.protocol_version = 2 AND audit.status = 'failed'
  FOR UPDATE;
  SELECT package.* INTO STRICT v_package
  FROM public.work_packages package
  WHERE package.id = p_work_package_id AND package.status = 'blocked';
  v_marker := v_package.metadata->'packet_issuance';
  IF v_marker IS NULL
     OR v_marker->>'priorRuntimeAuditId' <> p_prior_runtime_audit_id::text
     OR v_marker->>'markerFingerprint' <> p_expected_marker_fingerprint
     OR forge.packet_recovery_marker_fingerprint_v2(v_marker - 'markerFingerprint')
        <> p_expected_marker_fingerprint
     OR (
       p_action = 'retry_execution'
       AND v_marker->>'disposition' NOT IN ('retry_execution','reviewed_submission')
     )
     OR (
       p_action = 'acknowledge_possible_submission'
       AND v_marker->>'disposition' NOT IN (
         'review_then_reapprove_allow_once','review_submission'
       )
     )
     OR (
       p_action = 'decline_packet_recovery'
       AND v_marker->>'disposition' NOT IN (
         'reapprove_allow_once','review_then_reapprove_allow_once',
         'retry_execution','review_submission','reviewed_submission'
       )
     ) THEN
    RAISE EXCEPTION 'packet recovery marker changed before action compare-and-set'
      USING ERRCODE = '40001';
  END IF;
  IF p_action = 'retry_execution' THEN
    SELECT decision.* INTO v_decision
    FROM public.project_filesystem_current_decision_pointers pointer
    JOIN public.project_filesystem_grant_decisions decision
      ON decision.id = pointer.current_decision_id
     AND decision.project_id = pointer.current_decision_project_id
     AND decision.grant_decision_revision = pointer.current_decision_revision
     AND decision.root_binding_revision = pointer.current_root_binding_revision
     AND decision.decision_fingerprint = pointer.current_decision_fingerprint
     AND decision.decision_generation = pointer.current_decision_generation
    WHERE pointer.project_id = v_project_id
      AND decision.id = p_authorizing_decision_id
    FOR UPDATE OF pointer, decision;
    v_decision_found := FOUND;
    -- The package pointer is preallocated. Lock it even when it is empty so a
    -- concurrent denial cannot appear after the retry authority was checked.
    PERFORM 1
    FROM public.filesystem_mcp_current_decision_pointers pointer
    WHERE pointer.work_package_id = p_work_package_id
    FOR UPDATE;
    SELECT ARRAY(
      SELECT capability
      FROM pg_catalog.jsonb_array_elements_text(
        CASE
          WHEN pg_catalog.jsonb_typeof(
            v_audit.authorization_snapshot->'requiredCapabilities'
          ) = 'array' THEN v_audit.authorization_snapshot->'requiredCapabilities'
          ELSE '[]'::jsonb
        END
      ) capability
      ORDER BY capability
    ) INTO v_required_capabilities;
    SELECT ARRAY(
      SELECT capability
      FROM pg_catalog.jsonb_array_elements_text(v_decision.capabilities) capability
      ORDER BY capability
    ) INTO v_approved_capabilities;
    v_policy_fingerprint := 'sha256:' || pg_catalog.encode(pg_catalog.sha256(
      pg_catalog.convert_to(
        'forge:packet-policy:v2:' ||
        (v_audit.authorization_snapshot->'requiredCapabilities')::text,
        'UTF8'
      )
    ), 'hex');
    IF NOT v_decision_found
       OR p_authorizing_decision_id IS NULL
       OR v_decision.decision <> 'approved'
       OR v_decision.root_binding_revision <> v_project.root_binding_revision
       OR v_decision.grant_decision_revision < v_audit.grant_decision_revision
       OR v_audit.authorization_source <> 'project_always_allow'
       OR v_audit.grant_mode <> 'always_allow'
       OR v_marker->>'grantMode' <> 'always_allow'
       OR v_marker->>'deliveryState' IS DISTINCT FROM v_audit.delivery->>'state'
       OR v_marker->>'coverageFingerprint' IS DISTINCT FROM
          v_audit.authorization_snapshot->>'coverageFingerprint'
       OR v_marker->>'policyFingerprint' IS DISTINCT FROM v_policy_fingerprint
       OR pg_catalog.cardinality(v_required_capabilities) NOT BETWEEN 1 AND 3
       OR v_required_capabilities IS DISTINCT FROM ARRAY(
         SELECT DISTINCT capability
         FROM pg_catalog.unnest(v_required_capabilities) capability
         ORDER BY capability
       )
       OR v_required_capabilities <@ ARRAY[
         'filesystem.project.list','filesystem.project.read',
         'filesystem.project.search'
       ]::text[] IS NOT TRUE
       OR v_required_capabilities <@ v_approved_capabilities IS NOT TRUE
       OR (
         v_decision.grant_decision_revision = v_audit.grant_decision_revision
         AND (
           v_decision.id <> v_audit.project_decision_id
           OR v_decision.root_binding_revision <>
              v_audit.authorization_root_binding_revision
           OR v_decision.decision_fingerprint <>
              v_audit.authorization_snapshot->>'coverageFingerprint'
         )
       )
       OR EXISTS (
         SELECT 1
         FROM public.filesystem_mcp_current_decision_pointers pointer
         JOIN public.filesystem_mcp_grant_approvals decision
           ON decision.id = pointer.current_decision_id
          AND decision.task_id = pointer.current_decision_task_id
          AND decision.work_package_id = pointer.current_decision_work_package_id
          AND decision.grant_decision_revision = pointer.current_decision_revision
          AND decision.pointer_fingerprint = pointer.current_decision_fingerprint
         WHERE pointer.work_package_id = p_work_package_id
           AND decision.project_id = v_project_id
           AND decision.decision = 'denied'
           AND (
             decision.grant_decision_revision IS NULL
             OR decision.root_binding_revision IS NULL
             OR (
               decision.root_binding_revision = v_project.root_binding_revision
               AND decision.grant_decision_revision >= v_decision.grant_decision_revision
             )
           )
       ) THEN
      RAISE EXCEPTION 'packet retry lacks an exact current always-allow authority'
        USING ERRCODE = '40001';
    END IF;
  ELSIF p_authorizing_decision_id IS NOT NULL THEN
    RAISE EXCEPTION 'only packet retry accepts an authorizing decision'
      USING ERRCODE = '22023';
  END IF;

  v_next_marker := NULL;
  IF p_action = 'acknowledge_possible_submission' THEN
    v_next_marker := v_marker || pg_catalog.jsonb_build_object(
      'disposition', CASE WHEN v_marker->>'grantMode' = 'allow_once'
        THEN 'reapprove_allow_once' ELSE 'reviewed_submission' END,
      'acknowledgedAt', pg_catalog.to_char(
        pg_catalog.clock_timestamp() AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      ),
      'acknowledgedByUserId', p_actor_user_id::text
    );
    v_next_marker := pg_catalog.jsonb_set(
      v_next_marker, '{markerFingerprint}',
      pg_catalog.to_jsonb(forge.packet_recovery_marker_fingerprint_v2(
        v_next_marker - 'markerFingerprint'
      )), true
    );
    v_result := 'acknowledged';
    v_status := 'blocked';
  ELSIF p_action = 'retry_execution' THEN
    v_result := 'ready';
    v_status := 'ready';
  ELSE
    v_result := 'cancelled';
    v_status := 'cancelled';
  END IF;
  v_action_id := pg_catalog.gen_random_uuid();
  INSERT INTO public.filesystem_mcp_issuance_recovery_actions (
    id, task_id, work_package_id, prior_runtime_audit_id, action,
    expected_marker_fingerprint, actor_user_id, authorizing_decision_id,
    authorizing_project_decision_id, result, result_marker_fingerprint,
    package_status
  ) VALUES (
    v_action_id, p_task_id, p_work_package_id, p_prior_runtime_audit_id,
    p_action, p_expected_marker_fingerprint, p_actor_user_id,
    CASE WHEN p_action = 'retry_execution' THEN NULL
      ELSE p_authorizing_decision_id END,
    CASE WHEN p_action = 'retry_execution' THEN p_authorizing_decision_id
      ELSE NULL END,
    v_result,
    CASE WHEN v_next_marker IS NULL THEN NULL
      ELSE v_next_marker->>'markerFingerprint' END,
    v_status
  );
  UPDATE public.work_packages package
  SET status = v_status,
      metadata = CASE WHEN v_next_marker IS NULL
        THEN package.metadata - 'packet_issuance'
        ELSE pg_catalog.jsonb_set(
          package.metadata, '{packet_issuance}', v_next_marker, true
        ) END,
      updated_at = pg_catalog.clock_timestamp()
  WHERE package.id = p_work_package_id
    AND package.status = 'blocked'
    AND package.metadata->'packet_issuance' = v_marker;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'packet recovery action lost its marker compare-and-set'
      USING ERRCODE = '40001';
  END IF;
  action_id := v_action_id;
  result := v_result;
  result_marker_fingerprint := CASE WHEN v_next_marker IS NULL THEN NULL
    ELSE v_next_marker->>'markerFingerprint' END;
  package_status := v_status;
  RETURN NEXT;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION forge.local_projection_archive_operation_fingerprint_v2(
  p_operation_id uuid,
  p_state text,
  p_prior_fingerprint text
)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = pg_catalog
AS $$
  SELECT 'sha256:' || pg_catalog.encode(pg_catalog.sha256(
    pg_catalog.convert_to(
      'forge:local-projection-archive-operation:v2:' || p_operation_id::text ||
      ':' || p_state || ':' || p_prior_fingerprint,
      'UTF8'
    )
  ), 'hex')
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION forge.inspect_local_projection_overlimit_v2(
  p_task_id uuid
)
RETURNS TABLE (snapshot jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, forge
AS $$
DECLARE
  v_task public.tasks%ROWTYPE;
  v_package_count integer;
  v_head_count integer;
  v_distinct_package_count integer;
  v_heads_fingerprint text;
  v_aggregate_fingerprint text;
  v_task_fingerprint text;
  v_integrity_state text;
BEGIN
  IF session_user <> 'forge_local_projection_archiver'
     OR current_user <> 'forge_s4_routines_owner' THEN
    RAISE EXCEPTION 'projection archive inspection requires the fixed archiver login'
      USING ERRCODE = '42501';
  END IF;
  SELECT task.* INTO STRICT v_task FROM public.tasks task WHERE task.id = p_task_id;
  SELECT pg_catalog.count(*)::integer INTO v_package_count
  FROM public.work_packages package WHERE package.task_id = p_task_id;
  SELECT pg_catalog.count(*)::integer,
    pg_catalog.count(DISTINCT head.work_package_id)::integer,
    'sha256:' || pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
      COALESCE(pg_catalog.string_agg(
        head.id::text || ':' || head.work_package_id::text || ':' ||
        head.head_kind || ':' || head.head_index::text || ':' ||
        head.head_revision::text || ':' || head.compare_and_set_fingerprint,
        '|' ORDER BY head.id
      ), ''), 'UTF8')), 'hex'),
    'sha256:' || pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
      COALESCE(pg_catalog.string_agg(
        head.work_package_id::text || ':' || head.head_kind || ':' ||
        head.contribution::text,
        '|' ORDER BY head.work_package_id, head.head_index
      ), ''), 'UTF8')), 'hex')
  INTO v_head_count, v_distinct_package_count,
    v_heads_fingerprint, v_aggregate_fingerprint
  FROM public.work_package_local_projection_heads head
  WHERE head.task_id = p_task_id;
  v_integrity_state := CASE
    WHEN v_head_count <> v_package_count * 8 THEN 'missing_heads'
    WHEN v_distinct_package_count <> v_package_count OR EXISTS (
      SELECT 1 FROM public.work_package_local_projection_heads head
      WHERE head.task_id = p_task_id
      GROUP BY head.work_package_id
      HAVING pg_catalog.count(*) <> 8
        OR pg_catalog.count(DISTINCT head.head_kind) <> 8
        OR pg_catalog.min(head.head_index) <> 0
        OR pg_catalog.max(head.head_index) <> 7
    ) THEN 'mismatched_heads'
    WHEN v_package_count > 256 THEN 'over_limit'
    ELSE 'coherent'
  END;
  v_task_fingerprint := 'sha256:' || pg_catalog.encode(pg_catalog.sha256(
    pg_catalog.convert_to(
      'forge:local-projection-task:v2:' || p_task_id::text || ':' ||
      v_task.local_projection_scope_state || ':' || v_package_count::text || ':' ||
      COALESCE(v_task.local_projection_overlimit_package_count::text, 'null') || ':' ||
      v_heads_fingerprint || ':' || v_aggregate_fingerprint || ':' ||
      COALESCE(v_task.local_projection_source_task_id::text, 'null') || ':' ||
      COALESCE(v_task.local_projection_replacement_state, 'null') || ':' ||
      COALESCE(v_task.local_projection_replacement_version::text, 'null') || ':' ||
      COALESCE(v_task.local_projection_replacement_fingerprint, 'null'),
      'UTF8'
    )
  ), 'hex');
  snapshot := pg_catalog.jsonb_build_object(
    'schemaVersion', 2,
    'taskId', p_task_id::text,
    'scopeState', v_task.local_projection_scope_state,
    'packageCount', v_package_count,
    'overlimitPackageCount', v_task.local_projection_overlimit_package_count,
    'replacement', CASE WHEN v_task.local_projection_source_task_id IS NULL
      THEN NULL ELSE pg_catalog.jsonb_build_object(
        'sourceTaskId', v_task.local_projection_source_task_id::text,
        'state', v_task.local_projection_replacement_state,
        'version', v_task.local_projection_replacement_version,
        'fingerprint', v_task.local_projection_replacement_fingerprint
      ) END,
    'projection', pg_catalog.jsonb_build_object(
      'expectedHeadKindCount', 8,
      'expectedHeadCount', v_package_count * 8,
      'actualHeadCount', v_head_count,
      'distinctPackageCount', v_distinct_package_count,
      'headsFingerprint', v_heads_fingerprint,
      'aggregateFingerprint', v_aggregate_fingerprint,
      'integrityState', v_integrity_state
    ),
    'taskFingerprint', v_task_fingerprint,
    'claimable', v_task.local_projection_scope_state = 'active'
      AND v_task.local_projection_overlimit_package_count IS NULL
      AND v_package_count <= 256 AND v_integrity_state = 'coherent'
      AND v_task.local_projection_source_task_id IS NULL
  );
  RETURN NEXT;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION forge.apply_local_projection_overlimit_archive_v2(
  p_source_task_id uuid,
  p_replacement_task_id uuid,
  p_actor_user_id uuid,
  p_expected_source_fingerprint text,
  p_expected_replacement_fingerprint text
)
RETURNS TABLE (
  operation_id uuid,
  state text,
  operation_fingerprint text,
  snapshot jsonb
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, forge
AS $$
DECLARE
  v_source jsonb;
  v_replacement jsonb;
  v_operation_id uuid := pg_catalog.gen_random_uuid();
  v_operation_fingerprint text;
  v_relation_fingerprint text;
  v_existing public.local_projection_archive_operations%ROWTYPE;
  v_updated integer;
BEGIN
  IF session_user <> 'forge_local_projection_archiver'
     OR current_user <> 'forge_s4_routines_owner' THEN
    RAISE EXCEPTION 'projection archive apply requires the fixed archiver login'
      USING ERRCODE = '42501';
  END IF;
  IF p_source_task_id = p_replacement_task_id
     OR p_expected_source_fingerprint !~ '^sha256:[0-9a-f]{64}$'
     OR p_expected_replacement_fingerprint !~ '^sha256:[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'projection archive apply input is invalid' USING ERRCODE = '22023';
  END IF;
  SELECT operation.* INTO v_existing
  FROM public.local_projection_archive_operations operation
  WHERE operation.source_task_id = p_source_task_id
    AND operation.state IN ('validated','quiesced','archived');
  IF FOUND THEN
    IF v_existing.replacement_task_id <> p_replacement_task_id
       OR v_existing.actor_user_id <> p_actor_user_id
       OR v_existing.source_fingerprint <> p_expected_source_fingerprint
       OR v_existing.replacement_fingerprint <> p_expected_replacement_fingerprint THEN
      RAISE EXCEPTION 'projection archive apply replay changed its identity'
        USING ERRCODE = '40001';
    END IF;
    operation_id := v_existing.id;
    state := v_existing.state;
    operation_fingerprint := v_existing.operation_fingerprint;
    SELECT inspect.snapshot INTO v_source
    FROM forge.inspect_local_projection_overlimit_v2(p_source_task_id) inspect;
    SELECT inspect.snapshot INTO v_replacement
    FROM forge.inspect_local_projection_overlimit_v2(p_replacement_task_id) inspect;
    snapshot := pg_catalog.jsonb_build_object(
      'schemaVersion', 2, 'source', v_source, 'replacement', v_replacement,
      'checkpoint', v_existing.state
    );
    RETURN NEXT;
    RETURN;
  END IF;

  PERFORM 1 FROM public.tasks task
  WHERE task.id IN (p_source_task_id, p_replacement_task_id)
  ORDER BY task.id FOR UPDATE;
  IF (SELECT pg_catalog.count(DISTINCT task.project_id) FROM public.tasks task
      WHERE task.id IN (p_source_task_id, p_replacement_task_id)) <> 1 THEN
    RAISE EXCEPTION 'source and replacement tasks must share one project'
      USING ERRCODE = '40001';
  END IF;
  PERFORM 1 FROM public.work_packages package
  WHERE package.task_id IN (p_source_task_id, p_replacement_task_id)
  ORDER BY package.id FOR UPDATE;
  PERFORM 1 FROM public.work_package_local_projection_heads head
  WHERE head.task_id IN (p_source_task_id, p_replacement_task_id)
  ORDER BY head.id FOR UPDATE;
  SELECT inspect.snapshot INTO STRICT v_source
  FROM forge.inspect_local_projection_overlimit_v2(p_source_task_id) inspect;
  SELECT inspect.snapshot INTO STRICT v_replacement
  FROM forge.inspect_local_projection_overlimit_v2(p_replacement_task_id) inspect;
  IF v_source->>'taskFingerprint' <> p_expected_source_fingerprint
     OR v_replacement->>'taskFingerprint' <> p_expected_replacement_fingerprint
     OR (v_source->>'packageCount')::integer <= 256
     OR v_source->>'scopeState' <> 'archive_pending'
     OR NOT (
       v_source->'projection'->>'integrityState' = 'over_limit'
       OR (
         v_source->'projection'->>'integrityState' = 'missing_heads'
         AND (v_source->'projection'->>'actualHeadCount')::integer = 0
         AND (v_source->'projection'->>'distinctPackageCount')::integer = 0
       )
     )
     OR v_source->>'overlimitPackageCount' IS NULL
     OR (v_source->>'overlimitPackageCount')::integer <> (v_source->>'packageCount')::integer
     OR (v_replacement->>'packageCount')::integer > 256
     OR v_replacement->'projection'->>'integrityState' <> 'coherent'
     OR v_replacement->>'scopeState' <> 'active'
     OR v_replacement->>'overlimitPackageCount' IS NOT NULL
     OR v_replacement->'replacement' <> 'null'::jsonb
     OR (v_replacement->>'claimable')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'source or replacement projection snapshot is not archive-eligible'
      USING ERRCODE = '40001';
  END IF;
  v_relation_fingerprint := 'sha256:' || pg_catalog.encode(pg_catalog.sha256(
    pg_catalog.convert_to(
      'forge:local-projection-replacement:v2:' || p_source_task_id::text || ':' ||
      p_replacement_task_id::text || ':1:' || p_expected_source_fingerprint || ':' ||
      p_expected_replacement_fingerprint,
      'UTF8'
    )
  ), 'hex');
  UPDATE public.tasks task
  SET local_projection_source_task_id = p_source_task_id,
      local_projection_replacement_state = 'pending',
      local_projection_replacement_version = 1,
      local_projection_replacement_fingerprint = v_relation_fingerprint
  WHERE task.id = p_replacement_task_id
    AND task.local_projection_scope_state = 'active'
    AND task.local_projection_overlimit_package_count IS NULL
    AND task.local_projection_source_task_id IS NULL
    AND task.local_projection_replacement_state IS NULL
    AND task.local_projection_replacement_version IS NULL
    AND task.local_projection_replacement_fingerprint IS NULL;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated <> 1 THEN
    RAISE EXCEPTION 'replacement task lost its unbound compare-and-set'
      USING ERRCODE = '40001';
  END IF;
  v_operation_fingerprint := forge.local_projection_archive_operation_fingerprint_v2(
    v_operation_id, 'validated',
    p_expected_source_fingerprint || ':' || p_expected_replacement_fingerprint
  );
  INSERT INTO public.local_projection_archive_operations (
    id, source_task_id, replacement_task_id, actor_user_id, state,
    source_scope_version, replacement_version, source_fingerprint,
    replacement_fingerprint, operation_fingerprint
  ) VALUES (
    v_operation_id, p_source_task_id, p_replacement_task_id, p_actor_user_id,
    'validated', 1, 1, p_expected_source_fingerprint,
    p_expected_replacement_fingerprint, v_operation_fingerprint
  );
  INSERT INTO public.local_projection_archive_operation_checkpoints (
    operation_id, ordinal, state, operation_fingerprint, actor_user_id
  ) VALUES (v_operation_id, 1, 'validated', v_operation_fingerprint, p_actor_user_id);
  SELECT inspect.snapshot INTO v_source
  FROM forge.inspect_local_projection_overlimit_v2(p_source_task_id) inspect;
  SELECT inspect.snapshot INTO v_replacement
  FROM forge.inspect_local_projection_overlimit_v2(p_replacement_task_id) inspect;
  operation_id := v_operation_id;
  state := 'validated';
  operation_fingerprint := v_operation_fingerprint;
  snapshot := pg_catalog.jsonb_build_object(
    'schemaVersion', 2, 'source', v_source, 'replacement', v_replacement,
    'checkpoint', 'validated'
  );
  RETURN NEXT;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION forge.resume_local_projection_overlimit_archive_v2(
  p_operation_id uuid,
  p_actor_user_id uuid,
  p_expected_operation_fingerprint text
)
RETURNS TABLE (
  operation_id uuid,
  state text,
  operation_fingerprint text,
  snapshot jsonb
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, forge
AS $$
DECLARE
  v_operation public.local_projection_archive_operations%ROWTYPE;
  v_source jsonb;
  v_replacement jsonb;
  v_next_state text;
  v_next_fingerprint text;
  v_next_ordinal integer;
  v_relation_fingerprint text;
  v_next_relation_fingerprint text;
  v_updated integer;
BEGIN
  IF session_user <> 'forge_local_projection_archiver'
     OR current_user <> 'forge_s4_routines_owner' THEN
    RAISE EXCEPTION 'projection archive resume requires the fixed archiver login'
      USING ERRCODE = '42501';
  END IF;
  SELECT operation.* INTO STRICT v_operation
  FROM public.local_projection_archive_operations operation
  WHERE operation.id = p_operation_id;
  IF v_operation.state = 'archived'
     AND v_operation.operation_fingerprint = p_expected_operation_fingerprint THEN
    SELECT inspect.snapshot INTO v_source
    FROM forge.inspect_local_projection_overlimit_v2(v_operation.source_task_id) inspect;
    SELECT inspect.snapshot INTO v_replacement
    FROM forge.inspect_local_projection_overlimit_v2(v_operation.replacement_task_id) inspect;
    operation_id := v_operation.id; state := v_operation.state;
    operation_fingerprint := v_operation.operation_fingerprint;
    snapshot := pg_catalog.jsonb_build_object(
      'schemaVersion', 2, 'source', v_source, 'replacement', v_replacement,
      'checkpoint', v_operation.state
    );
    RETURN NEXT; RETURN;
  END IF;
  PERFORM 1 FROM public.tasks task
  WHERE task.id IN (v_operation.source_task_id, v_operation.replacement_task_id)
  ORDER BY task.id FOR UPDATE;
  PERFORM 1 FROM public.work_packages package
  WHERE package.task_id IN (v_operation.source_task_id, v_operation.replacement_task_id)
  ORDER BY package.id FOR UPDATE;
  PERFORM 1 FROM public.work_package_local_projection_heads head
  WHERE head.task_id IN (v_operation.source_task_id, v_operation.replacement_task_id)
  ORDER BY head.id FOR UPDATE;
  SELECT operation.* INTO STRICT v_operation
  FROM public.local_projection_archive_operations operation
  WHERE operation.id = p_operation_id FOR UPDATE;
  IF v_operation.actor_user_id <> p_actor_user_id
     OR v_operation.operation_fingerprint <> p_expected_operation_fingerprint
     OR v_operation.state NOT IN ('validated','quiesced') THEN
    RAISE EXCEPTION 'projection archive resume lost its operation compare-and-set'
      USING ERRCODE = '40001';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.work_packages package
    WHERE package.task_id IN (v_operation.source_task_id, v_operation.replacement_task_id)
      AND (package.status IN ('running','awaiting_review')
        OR package.metadata ? 'executionLease')
  ) THEN
    RAISE EXCEPTION 'projection archive cannot advance while claims or reviews are live'
      USING ERRCODE = '40001';
  END IF;
  SELECT inspect.snapshot INTO STRICT v_source
  FROM forge.inspect_local_projection_overlimit_v2(v_operation.source_task_id) inspect;
  IF v_source->>'scopeState' <> 'archive_pending'
     OR NOT (
       v_source->'projection'->>'integrityState' = 'over_limit'
       OR (
         v_source->'projection'->>'integrityState' = 'missing_heads'
         AND (v_source->'projection'->>'actualHeadCount')::integer = 0
         AND (v_source->'projection'->>'distinctPackageCount')::integer = 0
       )
     )
     OR v_source->>'overlimitPackageCount' IS NULL
     OR (v_source->>'overlimitPackageCount')::integer <> (v_source->>'packageCount')::integer
     OR v_source->>'taskFingerprint' <> v_operation.source_fingerprint THEN
    RAISE EXCEPTION 'source projection changed before archive advancement'
      USING ERRCODE = '40001';
  END IF;
  IF v_operation.state = 'validated' THEN
    UPDATE public.tasks task SET local_projection_scope_state = 'archive_pending'
    WHERE task.id = v_operation.source_task_id
      AND task.local_projection_scope_state = 'archive_pending'
      AND task.local_projection_overlimit_package_count = (v_source->>'packageCount')::integer;
    GET DIAGNOSTICS v_updated = ROW_COUNT;
    IF v_updated <> 1 THEN
      RAISE EXCEPTION 'source task lost its archive hold compare-and-set'
        USING ERRCODE = '40001';
    END IF;
    v_next_state := 'quiesced';
    v_next_ordinal := 2;
  ELSE
    SELECT inspect.snapshot INTO STRICT v_replacement
    FROM forge.inspect_local_projection_overlimit_v2(v_operation.replacement_task_id) inspect;
    IF (v_replacement->>'packageCount')::integer > 256
       OR v_replacement->'projection'->>'integrityState' <> 'coherent'
       OR v_replacement->>'scopeState' <> 'active'
       OR v_replacement->>'overlimitPackageCount' IS NOT NULL
       OR v_replacement->'replacement'->>'sourceTaskId' <> v_operation.source_task_id::text
       OR v_replacement->'replacement'->>'state' <> 'pending'
       OR (v_replacement->'replacement'->>'version')::bigint <> v_operation.replacement_version THEN
      RAISE EXCEPTION 'replacement projection changed before final archive'
        USING ERRCODE = '40001';
    END IF;
    v_relation_fingerprint := 'sha256:' || pg_catalog.encode(pg_catalog.sha256(
      pg_catalog.convert_to(
        'forge:local-projection-replacement:v2:' || v_operation.source_task_id::text || ':' ||
        v_operation.replacement_task_id::text || ':' || v_operation.replacement_version::text ||
        ':' || v_operation.source_fingerprint || ':' || v_operation.replacement_fingerprint,
        'UTF8'
      )
    ), 'hex');
    IF v_replacement->'replacement'->>'fingerprint' <> v_relation_fingerprint THEN
      RAISE EXCEPTION 'replacement binding fingerprint changed before final archive'
        USING ERRCODE = '40001';
    END IF;
    UPDATE public.tasks task SET local_projection_scope_state = 'legacy_archived'
    WHERE task.id = v_operation.source_task_id
      AND task.local_projection_scope_state = 'archive_pending'
      AND task.local_projection_overlimit_package_count = (v_source->>'packageCount')::integer;
    GET DIAGNOSTICS v_updated = ROW_COUNT;
    IF v_updated <> 1 THEN
      RAISE EXCEPTION 'source task lost its final archive compare-and-set'
        USING ERRCODE = '40001';
    END IF;
    v_next_relation_fingerprint := 'sha256:' || pg_catalog.encode(pg_catalog.sha256(
      pg_catalog.convert_to(
        'forge:local-projection-replacement:v2:' || v_operation.source_task_id::text || ':' ||
        v_operation.replacement_task_id::text || ':' ||
        (v_operation.replacement_version + 1)::text || ':eligible', 'UTF8'
      )
    ), 'hex');
    UPDATE public.tasks task
    SET local_projection_replacement_state = 'eligible',
        local_projection_replacement_version = v_operation.replacement_version + 1,
        local_projection_replacement_fingerprint = v_next_relation_fingerprint
    WHERE task.id = v_operation.replacement_task_id
      AND task.local_projection_scope_state = 'active'
      AND task.local_projection_overlimit_package_count IS NULL
      AND task.local_projection_source_task_id = v_operation.source_task_id
      AND task.local_projection_replacement_state = 'pending'
      AND task.local_projection_replacement_version = v_operation.replacement_version
      AND task.local_projection_replacement_fingerprint = v_relation_fingerprint;
    GET DIAGNOSTICS v_updated = ROW_COUNT;
    IF v_updated <> 1 THEN
      RAISE EXCEPTION 'replacement task lost its final eligibility compare-and-set'
        USING ERRCODE = '40001';
    END IF;
    v_next_state := 'archived';
    v_next_ordinal := 3;
  END IF;
  v_next_fingerprint := forge.local_projection_archive_operation_fingerprint_v2(
    v_operation.id, v_next_state, v_operation.operation_fingerprint
  );
  UPDATE public.local_projection_archive_operations operation
  SET state = v_next_state, operation_fingerprint = v_next_fingerprint,
      updated_at = pg_catalog.clock_timestamp(),
      completed_at = CASE WHEN v_next_state = 'archived'
        THEN pg_catalog.clock_timestamp() ELSE NULL END,
      replacement_version = CASE WHEN v_next_state = 'archived'
        THEN operation.replacement_version + 1 ELSE operation.replacement_version END
  WHERE operation.id = v_operation.id
    AND operation.state = v_operation.state
    AND operation.operation_fingerprint = p_expected_operation_fingerprint;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated <> 1 THEN
    RAISE EXCEPTION 'archive operation lost its checkpoint compare-and-set'
      USING ERRCODE = '40001';
  END IF;
  INSERT INTO public.local_projection_archive_operation_checkpoints (
    operation_id, ordinal, state, operation_fingerprint, actor_user_id
  ) VALUES (
    v_operation.id, v_next_ordinal, v_next_state, v_next_fingerprint, p_actor_user_id
  );
  SELECT inspect.snapshot INTO v_source
  FROM forge.inspect_local_projection_overlimit_v2(v_operation.source_task_id) inspect;
  SELECT inspect.snapshot INTO v_replacement
  FROM forge.inspect_local_projection_overlimit_v2(v_operation.replacement_task_id) inspect;
  operation_id := v_operation.id; state := v_next_state;
  operation_fingerprint := v_next_fingerprint;
  snapshot := pg_catalog.jsonb_build_object(
    'schemaVersion', 2, 'source', v_source, 'replacement', v_replacement,
    'checkpoint', v_next_state
  );
  RETURN NEXT;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION forge.rollback_local_projection_overlimit_archive_v2(
  p_operation_id uuid,
  p_actor_user_id uuid,
  p_expected_operation_fingerprint text
)
RETURNS TABLE (operation_id uuid, state text, operation_fingerprint text, snapshot jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, forge
AS $$
DECLARE
  v_operation public.local_projection_archive_operations%ROWTYPE;
  v_source jsonb; v_replacement jsonb; v_next_fingerprint text; v_ordinal integer;
  v_relation_fingerprint text; v_updated integer;
BEGIN
  IF session_user <> 'forge_local_projection_archiver'
     OR current_user <> 'forge_s4_routines_owner' THEN
    RAISE EXCEPTION 'projection archive rollback requires the fixed archiver login' USING ERRCODE = '42501';
  END IF;
  SELECT operation.* INTO STRICT v_operation FROM public.local_projection_archive_operations operation
  WHERE operation.id = p_operation_id FOR UPDATE;
  IF v_operation.actor_user_id <> p_actor_user_id
     OR v_operation.operation_fingerprint <> p_expected_operation_fingerprint
     OR v_operation.state NOT IN ('validated','quiesced') THEN
    RAISE EXCEPTION 'projection archive rollback is no longer eligible' USING ERRCODE = '40001';
  END IF;
  PERFORM 1 FROM public.tasks task
  WHERE task.id IN (v_operation.source_task_id, v_operation.replacement_task_id)
  ORDER BY task.id FOR UPDATE;
  PERFORM 1 FROM public.work_packages package
  WHERE package.task_id IN (v_operation.source_task_id, v_operation.replacement_task_id)
  ORDER BY package.id FOR UPDATE;
  IF EXISTS (SELECT 1 FROM public.work_packages package
    WHERE package.task_id IN (v_operation.source_task_id, v_operation.replacement_task_id)
      AND (package.status IN ('running','awaiting_review') OR package.metadata ? 'executionLease')) THEN
    RAISE EXCEPTION 'projection archive rollback requires quiescent tasks' USING ERRCODE = '40001';
  END IF;
  SELECT inspect.snapshot INTO STRICT v_source
  FROM forge.inspect_local_projection_overlimit_v2(v_operation.source_task_id) inspect;
  IF v_source->>'scopeState' <> 'archive_pending'
     OR NOT (
       v_source->'projection'->>'integrityState' = 'over_limit'
       OR (
         v_source->'projection'->>'integrityState' = 'missing_heads'
         AND (v_source->'projection'->>'actualHeadCount')::integer = 0
         AND (v_source->'projection'->>'distinctPackageCount')::integer = 0
       )
     )
     OR v_source->>'overlimitPackageCount' IS NULL
     OR (v_source->>'overlimitPackageCount')::integer <> (v_source->>'packageCount')::integer
     OR v_source->>'taskFingerprint' <> v_operation.source_fingerprint THEN
    RAISE EXCEPTION 'source projection changed before rollback'
      USING ERRCODE = '40001';
  END IF;
  v_relation_fingerprint := 'sha256:' || pg_catalog.encode(pg_catalog.sha256(
    pg_catalog.convert_to(
      'forge:local-projection-replacement:v2:' || v_operation.source_task_id::text || ':' ||
      v_operation.replacement_task_id::text || ':' || v_operation.replacement_version::text ||
      ':' || v_operation.source_fingerprint || ':' || v_operation.replacement_fingerprint,
      'UTF8'
    )
  ), 'hex');
  UPDATE public.tasks task SET local_projection_scope_state = 'archive_pending'
  WHERE task.id = v_operation.source_task_id
    AND task.local_projection_scope_state = 'archive_pending'
    AND task.local_projection_overlimit_package_count = (v_source->>'packageCount')::integer;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated <> 1 THEN
    RAISE EXCEPTION 'source task lost its rollback compare-and-set'
      USING ERRCODE = '40001';
  END IF;
  UPDATE public.tasks task
  SET local_projection_source_task_id = NULL,
      local_projection_replacement_state = NULL,
      local_projection_replacement_version = NULL,
      local_projection_replacement_fingerprint = NULL
  WHERE task.id = v_operation.replacement_task_id
    AND task.local_projection_scope_state = 'active'
    AND task.local_projection_overlimit_package_count IS NULL
    AND task.local_projection_source_task_id = v_operation.source_task_id
    AND task.local_projection_replacement_state = 'pending'
    AND task.local_projection_replacement_version = v_operation.replacement_version
    AND task.local_projection_replacement_fingerprint = v_relation_fingerprint;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated <> 1 THEN
    RAISE EXCEPTION 'replacement task lost its rollback detach compare-and-set'
      USING ERRCODE = '40001';
  END IF;
  v_next_fingerprint := forge.local_projection_archive_operation_fingerprint_v2(
    v_operation.id, 'rolled_back', v_operation.operation_fingerprint
  );
  SELECT COALESCE(pg_catalog.max(checkpoint.ordinal), 0) + 1 INTO v_ordinal
  FROM public.local_projection_archive_operation_checkpoints checkpoint
  WHERE checkpoint.operation_id = v_operation.id;
  UPDATE public.local_projection_archive_operations operation
  SET state = 'rolled_back', operation_fingerprint = v_next_fingerprint,
      updated_at = pg_catalog.clock_timestamp(), completed_at = pg_catalog.clock_timestamp()
  WHERE operation.id = v_operation.id
    AND operation.state = v_operation.state
    AND operation.operation_fingerprint = p_expected_operation_fingerprint;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated <> 1 THEN
    RAISE EXCEPTION 'archive operation lost its rollback compare-and-set'
      USING ERRCODE = '40001';
  END IF;
  INSERT INTO public.local_projection_archive_operation_checkpoints
    (operation_id, ordinal, state, operation_fingerprint, actor_user_id)
  VALUES (v_operation.id, v_ordinal, 'rolled_back', v_next_fingerprint, p_actor_user_id);
  SELECT inspect.snapshot INTO v_source FROM forge.inspect_local_projection_overlimit_v2(v_operation.source_task_id) inspect;
  SELECT inspect.snapshot INTO v_replacement FROM forge.inspect_local_projection_overlimit_v2(v_operation.replacement_task_id) inspect;
  operation_id := v_operation.id; state := 'rolled_back'; operation_fingerprint := v_next_fingerprint;
  snapshot := pg_catalog.jsonb_build_object('schemaVersion',2,'source',v_source,'replacement',v_replacement,'checkpoint','rolled_back');
  RETURN NEXT;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION forge.cancel_local_projection_overlimit_archive_v2(
  p_operation_id uuid,
  p_actor_user_id uuid,
  p_expected_operation_fingerprint text
)
RETURNS TABLE (operation_id uuid, state text, operation_fingerprint text, snapshot jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, forge
AS $$
DECLARE
  v_operation public.local_projection_archive_operations%ROWTYPE;
  v_source jsonb; v_replacement jsonb; v_next_fingerprint text; v_ordinal integer;
  v_relation_fingerprint text; v_updated integer;
BEGIN
  IF session_user <> 'forge_local_projection_archiver'
     OR current_user <> 'forge_s4_routines_owner' THEN
    RAISE EXCEPTION 'projection archive cancellation requires the fixed archiver login' USING ERRCODE = '42501';
  END IF;
  SELECT operation.* INTO STRICT v_operation FROM public.local_projection_archive_operations operation
  WHERE operation.id = p_operation_id FOR UPDATE;
  IF v_operation.actor_user_id <> p_actor_user_id
     OR v_operation.operation_fingerprint <> p_expected_operation_fingerprint
     OR v_operation.state NOT IN ('validated','quiesced') THEN
    RAISE EXCEPTION 'projection archive cancellation is no longer eligible' USING ERRCODE = '40001';
  END IF;
  PERFORM 1 FROM public.tasks task
  WHERE task.id IN (v_operation.source_task_id, v_operation.replacement_task_id)
  ORDER BY task.id FOR UPDATE;
  PERFORM 1 FROM public.work_packages package
  WHERE package.task_id IN (v_operation.source_task_id, v_operation.replacement_task_id)
  ORDER BY package.id FOR UPDATE;
  IF EXISTS (SELECT 1 FROM public.work_packages package
    WHERE package.task_id IN (v_operation.source_task_id, v_operation.replacement_task_id)
      AND (package.status IN ('running','awaiting_review') OR package.metadata ? 'executionLease')) THEN
    RAISE EXCEPTION 'projection archive cancellation requires quiescent tasks' USING ERRCODE = '40001';
  END IF;
  SELECT inspect.snapshot INTO STRICT v_source
  FROM forge.inspect_local_projection_overlimit_v2(v_operation.source_task_id) inspect;
  IF v_source->>'scopeState' <> 'archive_pending'
     OR NOT (
       v_source->'projection'->>'integrityState' = 'over_limit'
       OR (
         v_source->'projection'->>'integrityState' = 'missing_heads'
         AND (v_source->'projection'->>'actualHeadCount')::integer = 0
         AND (v_source->'projection'->>'distinctPackageCount')::integer = 0
       )
     )
     OR v_source->>'overlimitPackageCount' IS NULL
     OR (v_source->>'overlimitPackageCount')::integer <> (v_source->>'packageCount')::integer
     OR v_source->>'taskFingerprint' <> v_operation.source_fingerprint THEN
    RAISE EXCEPTION 'source projection changed before cancellation'
      USING ERRCODE = '40001';
  END IF;
  v_relation_fingerprint := 'sha256:' || pg_catalog.encode(pg_catalog.sha256(
    pg_catalog.convert_to(
      'forge:local-projection-replacement:v2:' || v_operation.source_task_id::text || ':' ||
      v_operation.replacement_task_id::text || ':' || v_operation.replacement_version::text ||
      ':' || v_operation.source_fingerprint || ':' || v_operation.replacement_fingerprint,
      'UTF8'
    )
  ), 'hex');
  UPDATE public.tasks task SET local_projection_scope_state = 'archive_pending'
  WHERE task.id = v_operation.source_task_id
    AND task.local_projection_scope_state = 'archive_pending'
    AND task.local_projection_overlimit_package_count = (v_source->>'packageCount')::integer;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated <> 1 THEN
    RAISE EXCEPTION 'source task lost its cancellation compare-and-set'
      USING ERRCODE = '40001';
  END IF;
  UPDATE public.tasks task
  SET local_projection_replacement_state = 'cancelled',
      local_projection_replacement_version = task.local_projection_replacement_version + 1,
      local_projection_replacement_fingerprint = 'sha256:' || pg_catalog.encode(pg_catalog.sha256(
        pg_catalog.convert_to('forge:local-projection-replacement:v2:' || task.id::text || ':cancelled:' ||
          (task.local_projection_replacement_version + 1)::text, 'UTF8')), 'hex')
  WHERE task.id = v_operation.replacement_task_id
    AND task.local_projection_scope_state = 'active'
    AND task.local_projection_overlimit_package_count IS NULL
    AND task.local_projection_source_task_id = v_operation.source_task_id
    AND task.local_projection_replacement_state = 'pending'
    AND task.local_projection_replacement_version = v_operation.replacement_version
    AND task.local_projection_replacement_fingerprint = v_relation_fingerprint;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated <> 1 THEN
    RAISE EXCEPTION 'replacement task lost its cancellation compare-and-set'
      USING ERRCODE = '40001';
  END IF;
  v_next_fingerprint := forge.local_projection_archive_operation_fingerprint_v2(
    v_operation.id, 'cancelled', v_operation.operation_fingerprint
  );
  SELECT COALESCE(pg_catalog.max(checkpoint.ordinal), 0) + 1 INTO v_ordinal
  FROM public.local_projection_archive_operation_checkpoints checkpoint
  WHERE checkpoint.operation_id = v_operation.id;
  UPDATE public.local_projection_archive_operations operation
  SET state = 'cancelled', operation_fingerprint = v_next_fingerprint,
      updated_at = pg_catalog.clock_timestamp(), completed_at = pg_catalog.clock_timestamp(),
      replacement_version = operation.replacement_version + 1
  WHERE operation.id = v_operation.id
    AND operation.state = v_operation.state
    AND operation.operation_fingerprint = p_expected_operation_fingerprint;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated <> 1 THEN
    RAISE EXCEPTION 'archive operation lost its cancellation compare-and-set'
      USING ERRCODE = '40001';
  END IF;
  INSERT INTO public.local_projection_archive_operation_checkpoints
    (operation_id, ordinal, state, operation_fingerprint, actor_user_id)
  VALUES (v_operation.id, v_ordinal, 'cancelled', v_next_fingerprint, p_actor_user_id);
  SELECT inspect.snapshot INTO v_source FROM forge.inspect_local_projection_overlimit_v2(v_operation.source_task_id) inspect;
  SELECT inspect.snapshot INTO v_replacement FROM forge.inspect_local_projection_overlimit_v2(v_operation.replacement_task_id) inspect;
  operation_id := v_operation.id; state := 'cancelled'; operation_fingerprint := v_next_fingerprint;
  snapshot := pg_catalog.jsonb_build_object('schemaVersion',2,'source',v_source,'replacement',v_replacement,'checkpoint','cancelled');
  RETURN NEXT;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION forge.insert_architect_plan_version_v1(
  p_agent_run_id uuid,
  p_plan_artifact_id uuid,
  p_plan_version bigint,
  p_digest_key_id text,
  p_entry_set_digest text,
  p_structural_set_digest text,
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
    task_id, plan_artifact_id, plan_version, digest_key_id, entry_count,
    entry_set_digest, structural_set_digest
  ) VALUES (
    v_task_id, p_plan_artifact_id, p_plan_version, p_digest_key_id, v_count,
    p_entry_set_digest, p_structural_set_digest
  );

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
  IF NOT EXISTS (
    SELECT 1 FROM public.architect_plan_entries entry
    WHERE entry.task_id = v_task_id AND entry.plan_version = p_plan_version
      AND entry.entry_kind = 'plan_body' AND entry.entry_id = 'plan_body:000000'
  ) OR NOT EXISTS (
    SELECT 1 FROM public.architect_plan_entries entry
    WHERE entry.task_id = v_task_id AND entry.plan_version = p_plan_version
      AND entry.entry_kind = 'requirement'
      AND entry.entry_id = 'requirement:plan-policy'
      AND entry.requirement_key = 'plan-policy'
  ) THEN
    RAISE EXCEPTION 'Architect plan version lacks its self-contained plan and policy structural base'
      USING ERRCODE = '22023';
  END IF;
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
CREATE OR REPLACE FUNCTION forge.register_package_plan_entries_v1(
  p_task_id uuid,
  p_source_artifact_id uuid,
  p_source_plan_version bigint,
  p_work_package_ids uuid[],
  p_entry_ids text[],
  p_binding_set_digests text[],
  p_capability_offsets integer[],
  p_capabilities text[],
  p_capability_requirement_keys text[],
  p_routing_fingerprints text[]
)
RETURNS uuid[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_count integer := pg_catalog.cardinality(p_work_package_ids);
  v_capability_count integer := pg_catalog.cardinality(p_capabilities);
  v_registration_ids uuid[] := ARRAY[]::uuid[];
  v_registration_id uuid;
  v_entry public.architect_plan_entries%ROWTYPE;
  v_package public.work_packages%ROWTYPE;
  v_index integer;
  v_capability_index integer;
  v_start integer;
  v_end integer;
BEGIN
  IF session_user <> 'forge_architect_plan_writer'
     OR current_user <> 'forge_s4_routines_owner' THEN
    RAISE EXCEPTION 'package plan registration requires the protected plan writer'
      USING ERRCODE = '42501';
  END IF;
  IF NOT forge.s4_protected_paths_enabled_v1() THEN
    RAISE EXCEPTION 'Package plan registration is not enabled by the Step 0 authority'
      USING ERRCODE = '55000';
  END IF;
  IF v_count NOT BETWEEN 1 AND 256
     OR pg_catalog.cardinality(p_entry_ids) <> v_count
     OR pg_catalog.cardinality(p_binding_set_digests) <> v_count
     OR pg_catalog.cardinality(p_capability_offsets) <> v_count + 1
     OR pg_catalog.cardinality(p_capability_requirement_keys) <> v_capability_count
     OR pg_catalog.cardinality(p_routing_fingerprints) <> v_capability_count
     OR p_capability_offsets[1] <> 0
     OR p_capability_offsets[v_count + 1] <> v_capability_count
     OR (SELECT pg_catalog.count(DISTINCT (package_id, entry_id))
         FROM pg_catalog.unnest(p_work_package_ids, p_entry_ids)
           pair(package_id, entry_id)) <> v_count THEN
    RAISE EXCEPTION 'package plan registration arrays are invalid or duplicated'
      USING ERRCODE = '22023';
  END IF;
  PERFORM 1 FROM public.tasks task WHERE task.id = p_task_id FOR UPDATE;
  PERFORM 1 FROM public.work_packages package
  WHERE package.task_id = p_task_id ORDER BY package.id FOR UPDATE;
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.unnest(p_work_package_ids) requested(package_id)
    WHERE NOT EXISTS (
      SELECT 1
      FROM public.work_packages package
      WHERE package.id = requested.package_id
        AND package.task_id = p_task_id
    )
  ) THEN
    RAISE EXCEPTION 'package plan registration contains a stale or cross-task package'
      USING ERRCODE = '40001';
  END IF;
  PERFORM 1
  FROM public.architect_plan_versions version
  JOIN public.artifacts artifact ON artifact.id = version.plan_artifact_id
  JOIN public.agent_runs source_run
    ON source_run.id = artifact.agent_run_id
   AND source_run.task_id = version.task_id
   AND source_run.agent_type = 'architect'
   AND source_run.status = 'completed'
  WHERE version.task_id = p_task_id
    AND version.plan_artifact_id = p_source_artifact_id
    AND version.plan_version = p_source_plan_version
    AND NOT EXISTS (
      SELECT 1 FROM public.architect_plan_versions newer
      WHERE newer.task_id = p_task_id
        AND newer.plan_version > version.plan_version
    )
  FOR KEY SHARE OF version, artifact, source_run;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'package registration source is not the exact latest protected plan'
      USING ERRCODE = '40001';
  END IF;

  FOR v_index IN 1..v_count LOOP
    IF p_binding_set_digests[v_index] !~ '^hmac-sha256:[0-9a-f]{64}$'
       OR p_capability_offsets[v_index] < 0
       OR p_capability_offsets[v_index] > p_capability_offsets[v_index + 1] THEN
      RAISE EXCEPTION 'package entry binding digest or capability offset is invalid'
        USING ERRCODE = '22023';
    END IF;
    SELECT package.* INTO STRICT v_package
    FROM public.work_packages package
    WHERE package.id = p_work_package_ids[v_index]
      AND package.task_id = p_task_id;
    SELECT entry.* INTO STRICT v_entry
    FROM public.architect_plan_entries entry
    WHERE entry.task_id = p_task_id
      AND entry.plan_artifact_id = p_source_artifact_id
      AND entry.plan_version = p_source_plan_version
      AND entry.entry_id = p_entry_ids[v_index]
      AND entry.entry_kind IN ('requirement','routing','overlay','subtask')
      AND (entry.projection_eligible OR entry.entry_kind = 'routing')
    FOR KEY SHARE;
    IF v_entry.agent IS NOT NULL AND v_entry.agent <> v_package.assigned_role THEN
      RAISE EXCEPTION 'package registration copied an entry across assigned agents'
        USING ERRCODE = '40001';
    END IF;
    v_start := p_capability_offsets[v_index] + 1;
    v_end := p_capability_offsets[v_index + 1];
    IF v_end >= v_start AND EXISTS (
      SELECT 1 FROM pg_catalog.generate_series(v_start, v_end) capability_index
      WHERE p_capabilities[capability_index] !~ '^[a-z0-9._:-]{1,240}$'
         OR p_capabilities[capability_index]
              <> pg_catalog.lower(pg_catalog.btrim(p_capabilities[capability_index]))
         OR p_capability_requirement_keys[capability_index] !~ '^[a-z0-9._-]{1,64}$'
         OR p_routing_fingerprints[capability_index] !~ '^sha256:[0-9a-f]{64}$'
         OR (
           v_entry.entry_kind IN ('routing','overlay')
           AND (
             p_capability_requirement_keys[capability_index]
               <> v_entry.requirement_key
             OR p_routing_fingerprints[capability_index]
               <> v_entry.binding_fingerprint
           )
         )
         OR (
           v_entry.entry_kind = 'requirement'
           AND p_capability_requirement_keys[capability_index]
             <> v_entry.requirement_key
         )
         OR (
           v_entry.entry_kind = 'subtask'
           AND NOT EXISTS (
             SELECT 1
             FROM public.architect_plan_entries routing
             WHERE routing.task_id = p_task_id
               AND routing.plan_artifact_id = p_source_artifact_id
               AND routing.plan_version = p_source_plan_version
               AND routing.entry_kind = 'routing'
               AND routing.agent = v_package.assigned_role
               AND routing.requirement_key
                 = p_capability_requirement_keys[capability_index]
               AND routing.binding_fingerprint
                 = p_routing_fingerprints[capability_index]
               AND NOT routing.projection_eligible
           )
         )
    ) THEN
      RAISE EXCEPTION 'package registration capability binding is not normalized or entry-bound'
        USING ERRCODE = '22023';
    END IF;
    IF v_end >= v_start AND EXISTS (
      SELECT 1
      FROM pg_catalog.generate_series(v_start, v_end) left_index
      JOIN pg_catalog.generate_series(v_start, v_end) right_index
        ON right_index > left_index
      WHERE (p_capabilities[left_index], p_capability_requirement_keys[left_index],
             p_routing_fingerprints[left_index])
          >= (p_capabilities[right_index], p_capability_requirement_keys[right_index],
              p_routing_fingerprints[right_index])
    ) THEN
      RAISE EXCEPTION 'package registration capability bindings are not strictly sorted and unique'
        USING ERRCODE = '22023';
    END IF;

    IF v_end >= v_start THEN
      FOR v_capability_index IN v_start..v_end LOOP
        INSERT INTO public.protected_entry_capability_bindings (
          source_kind, source_id, source_version, entry_id, ordinal,
          capability, requirement_key, routing_fingerprint
        ) VALUES (
          'architect_plan', p_source_artifact_id, p_source_plan_version,
          v_entry.entry_id, v_capability_index - v_start,
          p_capabilities[v_capability_index],
          p_capability_requirement_keys[v_capability_index],
          p_routing_fingerprints[v_capability_index]
        ) ON CONFLICT (source_kind, source_id, source_version, entry_id, ordinal)
          DO NOTHING;
        IF NOT EXISTS (
          SELECT 1 FROM public.protected_entry_capability_bindings binding
          WHERE binding.source_kind = 'architect_plan'
            AND binding.source_id = p_source_artifact_id
            AND binding.source_version = p_source_plan_version
            AND binding.entry_id = v_entry.entry_id
            AND binding.ordinal = v_capability_index - v_start
            AND binding.capability = p_capabilities[v_capability_index]
            AND binding.requirement_key = p_capability_requirement_keys[v_capability_index]
            AND binding.routing_fingerprint = p_routing_fingerprints[v_capability_index]
        ) THEN
          RAISE EXCEPTION 'package registration capability binding conflicts with retained authority'
            USING ERRCODE = '40001';
        END IF;
      END LOOP;
    END IF;
    IF (
      SELECT pg_catalog.count(*)
      FROM public.protected_entry_capability_bindings binding
      WHERE binding.source_kind = 'architect_plan'
        AND binding.source_id = p_source_artifact_id
        AND binding.source_version = p_source_plan_version
        AND binding.entry_id = v_entry.entry_id
    ) <> GREATEST(v_end - v_start + 1, 0) THEN
      RAISE EXCEPTION 'package registration capability set is incomplete or widened'
        USING ERRCODE = '40001';
    END IF;
    v_registration_id := pg_catalog.gen_random_uuid();
    INSERT INTO public.protected_package_entry_registrations (
      id, task_id, work_package_id, source_kind, source_id, source_version,
      entry_id, entry_kind, binding_set_digest, content_digest, digest_key_id
    ) VALUES (
      v_registration_id, p_task_id, v_package.id, 'architect_plan',
      p_source_artifact_id, p_source_plan_version, v_entry.entry_id,
      v_entry.entry_kind, p_binding_set_digests[v_index],
      v_entry.content_digest, v_entry.digest_key_id
    );
    v_registration_ids := pg_catalog.array_append(v_registration_ids, v_registration_id);
  END LOOP;
  RETURN v_registration_ids;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION forge.bind_architect_plan_entry_v2(
  p_registration_id uuid,
  p_agent_run_id uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_reference_id uuid := pg_catalog.gen_random_uuid();
  v_registration public.protected_package_entry_registrations%ROWTYPE;
  v_package public.work_packages%ROWTYPE;
  v_entry public.architect_plan_entries%ROWTYPE;
  v_gate public.approval_gates%ROWTYPE;
  v_review_version_id uuid;
  v_review_required boolean;
BEGIN
  IF session_user <> 'forge_packet_issuer'
     OR current_user <> 'forge_s4_routines_owner' THEN
    RAISE EXCEPTION 'registered Architect plan binding requires the fixed-path issuer'
      USING ERRCODE = '42501';
  END IF;
  IF NOT forge.s4_protected_paths_enabled_v1() THEN
    RAISE EXCEPTION 'Registered Architect plan binding is not enabled by the Step 0 authority'
      USING ERRCODE = '55000';
  END IF;
  SELECT registration.* INTO STRICT v_registration
  FROM public.protected_package_entry_registrations registration
  WHERE registration.id = p_registration_id
    AND registration.source_kind = 'architect_plan'
  FOR KEY SHARE;
  PERFORM 1 FROM public.tasks task
  WHERE task.id = v_registration.task_id FOR UPDATE;
  SELECT package.* INTO STRICT v_package
  FROM public.work_packages package
  WHERE package.id = v_registration.work_package_id
    AND package.task_id = v_registration.task_id
  FOR UPDATE;
  PERFORM 1 FROM public.agent_runs run
  WHERE run.id = p_agent_run_id
    AND run.task_id = v_registration.task_id
    AND run.work_package_id = v_registration.work_package_id
    AND run.status = 'running'
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'registered Architect plan run is stale or cross-package'
      USING ERRCODE = '40001';
  END IF;
  SELECT entry.* INTO STRICT v_entry
  FROM public.architect_plan_entries entry
  WHERE entry.task_id = v_registration.task_id
    AND entry.plan_artifact_id = v_registration.source_id
    AND entry.plan_version = v_registration.source_version
    AND entry.entry_id = v_registration.entry_id
    AND entry.entry_kind = v_registration.entry_kind
    AND entry.content_digest = v_registration.content_digest
    AND entry.digest_key_id = v_registration.digest_key_id
    AND entry.projection_eligible
    AND (entry.agent IS NULL OR entry.agent = v_package.assigned_role)
    AND NOT EXISTS (
      SELECT 1 FROM public.architect_plan_versions newer
      WHERE newer.task_id = v_registration.task_id
        AND newer.plan_version > entry.plan_version
    )
  FOR KEY SHARE;
  SELECT gate.* INTO STRICT v_gate
  FROM public.approval_gates gate
  WHERE gate.task_id = v_registration.task_id
    AND gate.gate_type = 'plan_approval'
    AND gate.source_artifact_id = v_registration.source_id
    AND gate.status = 'approved'
  FOR KEY SHARE;

  SELECT EXISTS (
    SELECT 1
    FROM public.architect_plan_entries routing
    WHERE routing.task_id = v_registration.task_id
      AND routing.plan_artifact_id = v_registration.source_id
      AND routing.plan_version = v_registration.source_version
      AND routing.entry_kind = 'routing'
  ) OR EXISTS (
    SELECT 1
    FROM (
      SELECT v_entry.requirement_key AS requirement_key
      WHERE v_entry.requirement_key IS NOT NULL
      UNION
      SELECT binding.requirement_key
      FROM public.protected_entry_capability_bindings binding
      WHERE binding.source_kind = v_registration.source_kind
        AND binding.source_id = v_registration.source_id
        AND binding.source_version = v_registration.source_version
        AND binding.entry_id = v_registration.entry_id
    ) required_key
  ) INTO v_review_required;

  IF v_gate.protected_review_revision IS NULL THEN
    IF v_review_required THEN
      RAISE EXCEPTION 'registered Architect plan entry lacks its protected operator review'
        USING ERRCODE = '42501';
    END IF;
  ELSE
    SELECT review.id INTO STRICT v_review_version_id
    FROM public.mcp_operator_review_versions review
    WHERE review.approval_gate_id = v_gate.id
      AND review.task_id = v_registration.task_id
      AND review.source_artifact_id = v_registration.source_id
      AND review.source_plan_version = v_registration.source_version
      AND review.revision = v_gate.protected_review_revision
      AND review.review_set_digest = v_gate.protected_review_set_digest
      AND review.item_count = v_gate.protected_review_item_count
      AND review.approved_count = v_gate.protected_review_approved_count
      AND review.denied_count = v_gate.protected_review_denied_count
      AND review.blocker_codes = v_gate.protected_review_blocker_codes
    FOR KEY SHARE;

    IF EXISTS (
      SELECT 1
      FROM (
        SELECT v_entry.requirement_key AS requirement_key
        WHERE v_entry.requirement_key IS NOT NULL
        UNION
        SELECT binding.requirement_key
        FROM public.protected_entry_capability_bindings binding
        WHERE binding.source_kind = v_registration.source_kind
          AND binding.source_id = v_registration.source_id
          AND binding.source_version = v_registration.source_version
          AND binding.entry_id = v_registration.entry_id
      ) required_key
      WHERE (
        SELECT pg_catalog.count(*)
        FROM public.mcp_operator_review_entries decision
        WHERE decision.review_version_id = v_review_version_id
          AND decision.entry_kind = 'decision'
          AND decision.requirement_key = required_key.requirement_key
      ) <> 1
      OR (
        SELECT pg_catalog.count(*)
        FROM public.mcp_operator_review_entries decision
        WHERE decision.review_version_id = v_review_version_id
          AND decision.entry_kind = 'decision'
          AND decision.requirement_key = required_key.requirement_key
          AND decision.projection_eligible
          AND CASE
            WHEN pg_catalog.pg_input_is_valid(
              decision.content, 'pg_catalog.jsonb'
            ) THEN
              decision.content::pg_catalog.jsonb->'schemaVersion' = '2'::pg_catalog.jsonb
              AND decision.content::pg_catalog.jsonb->>'requirementKey'
                = required_key.requirement_key
              AND decision.content::pg_catalog.jsonb->>'decision' = 'approved'
            ELSE false
          END
      ) <> 1
    ) THEN
      RAISE EXCEPTION 'registered Architect plan entry has a denied, missing, or stale protected decision'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  INSERT INTO public.architect_plan_execution_references (
    id, purpose, task_id, work_package_id, agent_run_id, plan_artifact_id,
    plan_version, entry_id, agent, requirement_key, binding_fingerprint,
    content_digest, digest_key_id
  ) VALUES (
    v_reference_id, 'package_specialist', v_registration.task_id,
    v_registration.work_package_id, p_agent_run_id, v_registration.source_id,
    v_registration.source_version, v_registration.entry_id,
    v_package.assigned_role, v_entry.requirement_key, v_entry.binding_fingerprint,
    v_registration.content_digest, v_registration.digest_key_id
  );
  RETURN v_reference_id;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION forge.bind_architect_replan_context_v2(
  p_agent_run_id uuid,
  p_prior_plan_artifact_id uuid
)
RETURNS TABLE (reference_id uuid, entry_id text, entry_kind text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_task_id uuid;
  v_plan_version bigint;
  v_entry_count integer;
BEGIN
  IF session_user <> 'forge_architect_plan_writer' THEN
    RAISE EXCEPTION 'Architect replan context binding requires the protected plan writer login'
      USING ERRCODE = '42501';
  END IF;
  IF NOT forge.s4_protected_paths_enabled_v1() THEN
    RAISE EXCEPTION 'Architect replan context binding is not enabled by the Step 0 authority'
      USING ERRCODE = '55000';
  END IF;
  SELECT run.task_id INTO STRICT v_task_id
  FROM public.agent_runs run
  WHERE run.id = p_agent_run_id AND run.work_package_id IS NULL
    AND run.agent_type = 'architect' AND run.status = 'running'
  FOR UPDATE;
  PERFORM 1 FROM public.tasks task WHERE task.id = v_task_id FOR UPDATE;
  SELECT version.plan_version, version.entry_count
  INTO STRICT v_plan_version, v_entry_count
  FROM public.architect_plan_versions version
  JOIN public.artifacts artifact ON artifact.id = version.plan_artifact_id
  JOIN public.agent_runs source_run ON source_run.id = artifact.agent_run_id
  WHERE version.task_id = v_task_id
    AND version.plan_artifact_id = p_prior_plan_artifact_id
    AND source_run.task_id = v_task_id
    AND source_run.agent_type = 'architect'
    AND source_run.status = 'completed'
    AND source_run.id <> p_agent_run_id
    AND NOT EXISTS (
      SELECT 1 FROM public.architect_plan_versions newer
      WHERE newer.task_id = v_task_id
        AND newer.plan_version > version.plan_version
    )
  FOR KEY SHARE OF version, artifact, source_run;

  IF (
    SELECT pg_catalog.count(*)
    FROM public.architect_plan_entries entry
    WHERE entry.task_id = v_task_id
      AND entry.plan_artifact_id = p_prior_plan_artifact_id
      AND entry.plan_version = v_plan_version
      AND entry.entry_kind IN (
        'plan_body','requirement','routing','overlay','subtask',
        'clarification_question','clarification_answer'
      )
  ) <> v_entry_count THEN
    RAISE EXCEPTION 'Architect replan source contains a non-canonical or incomplete entry set'
      USING ERRCODE = '40001';
  END IF;

  RETURN QUERY
  WITH eligible AS (
    SELECT entry.*
    FROM public.architect_plan_entries entry
    WHERE entry.task_id = v_task_id
      AND entry.plan_artifact_id = p_prior_plan_artifact_id
      AND entry.plan_version = v_plan_version
      AND entry.entry_kind IN (
        'plan_body','requirement','routing','overlay','subtask',
        'clarification_question','clarification_answer'
      )
    ORDER BY entry.entry_id
    FOR KEY SHARE
  ), inserted AS (
    INSERT INTO public.architect_plan_execution_references (
      id, purpose, task_id, work_package_id, agent_run_id, plan_artifact_id,
      plan_version, entry_id, agent, requirement_key, binding_fingerprint,
      content_digest, digest_key_id
    )
    SELECT pg_catalog.gen_random_uuid(), 'architect_replan', v_task_id, NULL,
      p_agent_run_id, eligible.plan_artifact_id, eligible.plan_version,
      eligible.entry_id, 'architect', eligible.requirement_key,
      eligible.binding_fingerprint, eligible.content_digest, eligible.digest_key_id
    FROM eligible
    RETURNING id, architect_plan_execution_references.entry_id
  )
  SELECT inserted.id, inserted.entry_id, entry.entry_kind
  FROM inserted
  JOIN public.architect_plan_entries entry
    ON entry.task_id = v_task_id
   AND entry.plan_artifact_id = p_prior_plan_artifact_id
   AND entry.plan_version = v_plan_version
   AND entry.entry_id = inserted.entry_id
  ORDER BY inserted.entry_id;
END;
$$;
--> statement-breakpoint
-- B1A protected clarification subledger. It is deliberately separate from
-- finalized Architect plan versions and has no public-table text projection.
CREATE TABLE public.architect_clarification_answers (
  id uuid PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES public.tasks(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  question_id uuid NOT NULL REFERENCES public.task_questions(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  source_plan_artifact_id uuid NOT NULL,
  source_plan_version bigint NOT NULL,
  answer text NOT NULL CHECK (pg_catalog.octet_length(answer) BETWEEN 1 AND 65536),
  content_digest text NOT NULL CHECK (content_digest ~ '^hmac-sha256:[0-9a-f]{64}$'),
  digest_key_id text NOT NULL CHECK (digest_key_id ~ '^[a-z0-9._-]{1,64}$'),
  actor_user_id uuid NOT NULL REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  FOREIGN KEY (source_plan_artifact_id, source_plan_version)
    REFERENCES public.architect_plan_versions(plan_artifact_id, plan_version)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  UNIQUE (task_id, question_id, id)
);
ALTER TABLE public.task_questions
  ADD COLUMN question_entry_id text,
  ADD COLUMN source_plan_artifact_id uuid,
  ADD COLUMN source_plan_version bigint,
  ADD COLUMN answer_reference_id uuid,
  ADD CONSTRAINT task_questions_opaque_source_chk CHECK (
    (question_entry_id IS NULL AND source_plan_artifact_id IS NULL AND source_plan_version IS NULL)
    OR (question_entry_id = 'clarification_question:' || id::text
      AND source_plan_artifact_id IS NOT NULL AND source_plan_version > 0)
  ),
  ADD CONSTRAINT task_questions_opaque_source_fk FOREIGN KEY (source_plan_artifact_id, source_plan_version)
    REFERENCES public.architect_plan_versions(plan_artifact_id, plan_version)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  ADD CONSTRAINT task_questions_answer_reference_fk FOREIGN KEY (answer_reference_id)
    REFERENCES public.architect_clarification_answers(id) ON UPDATE RESTRICT ON DELETE RESTRICT;
CREATE TABLE public.architect_clarification_answer_writes (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  answer_id uuid NOT NULL REFERENCES public.architect_clarification_answers(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  task_id uuid NOT NULL REFERENCES public.tasks(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  actor_user_id uuid NOT NULL REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  written_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  UNIQUE (answer_id)
);
CREATE TRIGGER architect_clarification_answers_append_only
  BEFORE UPDATE OR DELETE ON public.architect_clarification_answers
  FOR EACH ROW EXECUTE FUNCTION forge.reject_s4_retained_mutation_v1();
CREATE TRIGGER architect_clarification_answer_writes_append_only
  BEFORE UPDATE OR DELETE ON public.architect_clarification_answer_writes
  FOR EACH ROW EXECUTE FUNCTION forge.reject_s4_retained_mutation_v1();
REVOKE ALL ON public.architect_clarification_answers, public.architect_clarification_answer_writes FROM PUBLIC;
ALTER TABLE public.architect_plan_execution_references
  ADD COLUMN source_kind text NOT NULL DEFAULT 'architect_plan_entry',
  ADD COLUMN clarification_answer_id uuid,
  ADD CONSTRAINT architect_plan_execution_references_source_kind_chk CHECK (
    (source_kind = 'architect_plan_entry' AND clarification_answer_id IS NULL)
    OR (source_kind = 'clarification_answer' AND clarification_answer_id IS NOT NULL
      AND purpose = 'architect_replan' AND work_package_id IS NULL AND agent = 'architect')
  ),
  ADD CONSTRAINT architect_plan_execution_references_answer_fk FOREIGN KEY (clarification_answer_id)
    REFERENCES public.architect_clarification_answers(id) ON UPDATE RESTRICT ON DELETE RESTRICT;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION forge.bind_architect_replan_context_v3(
  p_agent_run_id uuid, p_prior_plan_artifact_id uuid
)
RETURNS TABLE (reference_id uuid, entry_id text, entry_kind text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE v_task_id uuid; v_plan_version bigint;
BEGIN
  -- Retain the established plan-entry arm, including its run/task/source locks.
  RETURN QUERY SELECT * FROM forge.bind_architect_replan_context_v2(p_agent_run_id, p_prior_plan_artifact_id);
  SELECT run.task_id INTO STRICT v_task_id FROM public.agent_runs run
  WHERE run.id = p_agent_run_id AND run.agent_type = 'architect'
    AND run.work_package_id IS NULL AND run.status = 'running' FOR KEY SHARE;
  SELECT version.plan_version INTO STRICT v_plan_version
  FROM public.architect_plan_versions version
  WHERE version.task_id = v_task_id AND version.plan_artifact_id = p_prior_plan_artifact_id;
  RETURN QUERY
  WITH answers AS (
    SELECT answer.* FROM public.architect_clarification_answers answer
    JOIN public.architect_plan_entries question ON question.task_id = answer.task_id
      AND question.plan_artifact_id = answer.source_plan_artifact_id
      AND question.plan_version = answer.source_plan_version
      AND question.entry_id = 'clarification_question:' || answer.question_id::text
      AND question.entry_kind = 'clarification_question'
    WHERE answer.task_id = v_task_id
      AND answer.source_plan_artifact_id = p_prior_plan_artifact_id
      AND answer.source_plan_version = v_plan_version
    FOR KEY SHARE OF answer, question
  ), inserted AS (
    INSERT INTO public.architect_plan_execution_references (
      id, purpose, task_id, work_package_id, agent_run_id, plan_artifact_id,
      plan_version, entry_id, agent, requirement_key, binding_fingerprint,
      content_digest, digest_key_id, source_kind, clarification_answer_id
    ) SELECT pg_catalog.gen_random_uuid(), 'architect_replan', v_task_id, NULL,
      p_agent_run_id, answer.source_plan_artifact_id, answer.source_plan_version,
      'clarification_question:' || answer.question_id::text, 'architect', NULL, NULL,
      answer.content_digest, answer.digest_key_id, 'clarification_answer', answer.id
    FROM answers answer
    RETURNING id, clarification_answer_id
  )
  SELECT inserted.id, 'clarification_answer:' || inserted.clarification_answer_id::text,
    'clarification_answer'::text FROM inserted;
END;
$$;
CREATE OR REPLACE FUNCTION forge.resolve_architect_plan_entry_v2(p_reference_id uuid)
RETURNS TABLE (purpose text, task_id uuid, plan_artifact_id uuid, plan_version bigint,
  entry_id text, entry_kind text, agent text, requirement_key text,
  binding_fingerprint text, content text, content_digest text, digest_key_id text,
  projection_eligible boolean, clarification_question_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
BEGIN
  IF session_user <> 'forge_architect_plan_resolver' OR NOT forge.s4_protected_paths_enabled_v1() THEN
    RAISE EXCEPTION 'Protected Architect plan resolution is unavailable' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY WITH locked AS (
    SELECT reference.* FROM public.architect_plan_execution_references reference
    WHERE reference.id = p_reference_id AND reference.resolved_at IS NULL FOR UPDATE
  ), eligible AS (
    SELECT r.id, r.purpose, r.task_id, r.plan_artifact_id, r.plan_version,
      entry.entry_id, entry.entry_kind, entry.agent, entry.requirement_key,
      entry.binding_fingerprint, entry.content, entry.content_digest, entry.digest_key_id,
      entry.projection_eligible, NULL::uuid
    FROM locked r JOIN public.agent_runs run ON run.id = r.agent_run_id
      AND run.task_id = r.task_id AND run.status = 'running'
    JOIN public.architect_plan_entries entry ON r.source_kind = 'architect_plan_entry'
      AND entry.task_id = r.task_id AND entry.plan_artifact_id = r.plan_artifact_id
      AND entry.plan_version = r.plan_version AND entry.entry_id = r.entry_id
      AND entry.content_digest = r.content_digest AND entry.digest_key_id = r.digest_key_id
    WHERE (r.purpose = 'architect_replan' AND run.agent_type = 'architect' AND run.work_package_id IS NULL)
       OR (r.purpose = 'package_specialist' AND entry.projection_eligible)
    UNION ALL
    SELECT r.id, r.purpose, r.task_id, r.plan_artifact_id, r.plan_version,
      'clarification_answer:' || answer.id::text, 'clarification_answer', NULL, NULL, NULL,
      answer.answer, answer.content_digest, answer.digest_key_id, false, answer.question_id
    FROM locked r JOIN public.agent_runs run ON run.id = r.agent_run_id
      AND run.task_id = r.task_id AND run.status = 'running'
    JOIN public.architect_clarification_answers answer ON r.source_kind = 'clarification_answer'
      AND r.clarification_answer_id = answer.id AND answer.task_id = r.task_id
      AND answer.source_plan_artifact_id = r.plan_artifact_id AND answer.source_plan_version = r.plan_version
      AND answer.content_digest = r.content_digest AND answer.digest_key_id = r.digest_key_id
    WHERE r.purpose = 'architect_replan' AND r.work_package_id IS NULL
      AND r.agent = 'architect' AND run.agent_type = 'architect' AND run.work_package_id IS NULL
  ), consumed AS (
    UPDATE public.architect_plan_execution_references r SET resolved_at = pg_catalog.clock_timestamp()
    FROM eligible WHERE r.id = eligible.id RETURNING eligible.*
  ) SELECT purpose, task_id, plan_artifact_id, plan_version, entry_id, entry_kind,
    agent, requirement_key, binding_fingerprint, content, content_digest, digest_key_id,
    projection_eligible, clarification_question_id FROM consumed;
END;
$$;
CREATE OR REPLACE FUNCTION forge.append_architect_clarification_answer_v1(
  p_session_credential bytea, p_task_id uuid, p_question_id uuid,
  p_source_plan_artifact_id uuid, p_source_plan_version bigint, p_answer_id uuid,
  p_answer text, p_content_digest text, p_digest_key_id text
) RETURNS TABLE (answer_id uuid, all_answered boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE v_session public.sessions%ROWTYPE; v_digest bytea; v_user_id uuid;
BEGIN
  IF session_user <> 'forge_architect_plan_history_reader' OR NOT forge.s4_protected_paths_enabled_v1() THEN
    RAISE EXCEPTION 'Clarification append is unavailable' USING ERRCODE = '42501';
  END IF;
  IF pg_catalog.octet_length(p_session_credential) <> 36 OR p_content_digest !~ '^hmac-sha256:[0-9a-f]{64}$'
     OR p_digest_key_id !~ '^[a-z0-9._-]{1,64}$' OR pg_catalog.octet_length(p_answer) NOT BETWEEN 1 AND 65536
     OR p_answer <> pg_catalog.normalize(p_answer, 'NFC') THEN
    RAISE EXCEPTION 'Clarification append envelope is invalid' USING ERRCODE = '22023';
  END IF;
  v_digest := pg_catalog.sha256(pg_catalog.decode('666f7267653a7765622d73657373696f6e3a763100', 'hex') || p_session_credential);
  SELECT session_row.* INTO STRICT v_session FROM public.sessions session_row WHERE session_row.credential_digest_v1 = v_digest FOR UPDATE;
  IF v_session.revoked_at IS NOT NULL OR v_session.expires_at IS NULL OR pg_catalog.clock_timestamp() >= v_session.expires_at THEN
    RAISE EXCEPTION 'Session credential is revoked or expired' USING ERRCODE = '28000';
  END IF;
  v_user_id := v_session.user_id;
  PERFORM 1 FROM public.tasks task WHERE task.id = p_task_id AND task.submitted_by = v_user_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Task history is not accessible to this session' USING ERRCODE = '42501'; END IF;
  PERFORM 1 FROM public.architect_plan_entries entry WHERE entry.task_id = p_task_id
    AND entry.plan_artifact_id = p_source_plan_artifact_id AND entry.plan_version = p_source_plan_version
    AND entry.entry_id = 'clarification_question:' || p_question_id::text AND entry.entry_kind = 'clarification_question' FOR KEY SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Clarification source is stale or unavailable' USING ERRCODE = '40001'; END IF;
  PERFORM 1 FROM public.task_questions question WHERE question.id = p_question_id AND question.task_id = p_task_id
    AND question.status = 'open' AND question.answer_reference_id IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Clarification question is no longer open' USING ERRCODE = '40001'; END IF;
  INSERT INTO public.architect_clarification_answers (id, task_id, question_id, source_plan_artifact_id, source_plan_version, answer, content_digest, digest_key_id, actor_user_id)
  VALUES (p_answer_id, p_task_id, p_question_id, p_source_plan_artifact_id, p_source_plan_version, p_answer, p_content_digest, p_digest_key_id, v_user_id);
  INSERT INTO public.architect_clarification_answer_writes (answer_id, task_id, actor_user_id) VALUES (p_answer_id, p_task_id, v_user_id);
  UPDATE public.task_questions question SET status = 'answered', answer_reference_id = p_answer_id,
    answered_at = pg_catalog.clock_timestamp(), answered_by = v_user_id
  WHERE question.id = p_question_id AND question.task_id = p_task_id AND question.status = 'open' AND question.answer_reference_id IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'Clarification projection changed before append' USING ERRCODE = '40001'; END IF;
  answer_id := p_answer_id;
  SELECT NOT EXISTS (SELECT 1 FROM public.task_questions q WHERE q.task_id = p_task_id AND q.status <> 'answered') INTO all_answered;
  RETURN NEXT;
END;
$$;
-- The NOLOGIN owner receives only the existing-table privileges required by
-- the fixed-path functions above. Interactive and application logins receive
-- no equivalent table access.
GRANT SELECT ON public.tasks, public.projects, public.work_packages,
  public.agent_runs, public.artifacts, public.filesystem_mcp_grant_approvals,
  public.filesystem_mcp_current_decision_pointers,
  public.project_filesystem_grant_decisions,
  public.project_filesystem_current_decision_pointers,
  public.filesystem_mcp_runtime_audits,
  public.approval_gates TO forge_s4_routines_owner;
GRANT SELECT, UPDATE ON public.sessions TO forge_s4_routines_owner;
GRANT UPDATE ON public.filesystem_mcp_runtime_audits TO forge_s4_routines_owner;
GRANT UPDATE ON public.tasks, public.projects, public.work_packages,
  public.agent_runs, public.artifacts, public.approval_gates,
  public.filesystem_mcp_grant_approvals,
  public.filesystem_mcp_current_decision_pointers,
  public.project_filesystem_grant_decisions,
  public.project_filesystem_current_decision_pointers TO forge_s4_routines_owner;
GRANT INSERT ON public.agent_runs, public.artifacts, public.filesystem_mcp_runtime_audits,
  public.approval_gates
  TO forge_s4_routines_owner;
--> statement-breakpoint
REVOKE ALL ON public.architect_plan_versions, public.architect_plan_entries,
  public.architect_plan_execution_references, public.architect_plan_history_reads,
  public.protected_package_entry_registrations,
  public.protected_entry_capability_bindings,
  public.mcp_operator_review_versions, public.mcp_operator_review_entries,
  public.work_package_local_run_evidence, public.s4_completion_handoffs,
  public.s4_protected_review_sources, public.s4_protected_review_source_reads,
  public.s4_max_attempt_finalizations,
  public.filesystem_mcp_issuance_recovery_actions,
  public.local_effect_recovery_actions,
  public.local_projection_archive_operations,
  public.local_projection_archive_operation_checkpoints,
  public.filesystem_mcp_decision_nonce_claims,
  public.project_root_ref_reconciliation FROM PUBLIC;
REVOKE ALL ON FUNCTION forge.fill_project_root_ref_on_insert_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION forge.guard_project_root_ref_renull_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION forge.reconcile_project_root_refs_v1(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION forge.s4_protected_paths_enabled_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION forge.guard_s4_approval_gate_review_head_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION forge.reject_s4_retained_mutation_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION forge.guard_architect_plan_public_artifact_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION forge.read_architect_plan_history_v1(bytea,uuid,bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION forge.append_architect_clarification_answer_v1(bytea,uuid,uuid,uuid,bigint,uuid,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION forge.append_mcp_operator_review_version_v1(bytea,uuid,bigint,integer,text,text,integer,integer,integer,text[],text[],text[],text[],text[],text[],text[],text[],boolean[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION forge.read_mcp_operator_review_history_v1(bytea,uuid,uuid,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION forge.list_approved_package_plan_registrations_v1(bytea,uuid,bigint,integer,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION forge.resolve_architect_plan_entry_v1(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION forge.create_local_run_evidence_v1(uuid,uuid,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION forge.insert_packet_authorization_snapshot_v2(uuid,uuid,uuid,uuid,uuid,integer,text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION forge.validate_packet_authorization_snapshot_v2(jsonb,text,text,uuid,bigint,uuid,bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION forge.guard_packet_authorization_v2() FROM PUBLIC;
REVOKE ALL ON FUNCTION forge.s4_execution_lease_live_v1(jsonb,uuid,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION forge.s4_runtime_mode_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION forge.read_s4_runtime_mode_for_application_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION forge.packet_recovery_marker_token_v2(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION forge.packet_recovery_marker_fingerprint_v2(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION forge.claim_local_lifecycle_v2(uuid,uuid,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION forge.claim_packet_lifecycle_v2(uuid,uuid,uuid,uuid,integer,integer,text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION forge.claim_work_package_lifecycle_v2(text,uuid,uuid,timestamptz,uuid,text,uuid,integer,uuid,text,timestamptz,text,text,integer,uuid,uuid,uuid,integer,integer,text[]) FROM PUBLIC;
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
REVOKE ALL ON FUNCTION forge.materialize_s4_completion_handoff_v1(uuid,text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION forge.discover_s4_completion_handoff_v1(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION forge.list_pending_s4_completion_handoffs_v1(integer,timestamptz,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION forge.claim_pending_s4_completion_handoffs_v1(text,uuid,integer,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION forge.materialize_claimed_s4_completion_handoff_v1(uuid,text[],text,uuid,bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION forge.finalize_s4_max_attempts_v1(uuid,uuid,timestamptz,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION forge.resolve_s4_review_source_v1(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION forge.finalize_packet_failure_v2(uuid,uuid,bigint,uuid,bigint,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION forge.recover_stale_local_lifecycle_v2(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION forge.recover_stale_packet_lifecycle_v2(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION forge.recover_linked_s4_lifecycle_v2(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION forge.cas_packet_reapproval_v2(uuid,uuid,uuid,text,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION forge.apply_local_effect_recovery_action_v2(uuid,uuid,uuid,text,text,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION forge.apply_packet_issuance_recovery_action_v2(uuid,uuid,uuid,text,text,uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION forge.insert_architect_plan_version_v1(uuid,uuid,bigint,text,text,text,text[],text[],text[],text[],text[],text[],text[],text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION forge.register_package_plan_entries_v1(uuid,uuid,bigint,uuid[],text[],text[],integer[],text[],text[],text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION forge.bind_architect_plan_entry_v1(uuid,uuid,uuid,uuid,bigint,text,text,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION forge.bind_architect_plan_entry_v2(uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION forge.bind_architect_replan_entry_v1(uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION forge.bind_architect_replan_context_v2(uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION forge.local_projection_archive_operation_fingerprint_v2(uuid,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION forge.inspect_local_projection_overlimit_v2(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION forge.apply_local_projection_overlimit_archive_v2(uuid,uuid,uuid,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION forge.resume_local_projection_overlimit_archive_v2(uuid,uuid,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION forge.rollback_local_projection_overlimit_archive_v2(uuid,uuid,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION forge.cancel_local_projection_overlimit_archive_v2(uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION forge.insert_architect_plan_version_v1(uuid,uuid,bigint,text,text,text,text[],text[],text[],text[],text[],text[],text[],text[]) TO forge_architect_plan_writer;
GRANT EXECUTE ON FUNCTION forge.register_package_plan_entries_v1(uuid,uuid,bigint,uuid[],text[],text[],integer[],text[],text[],text[]) TO forge_architect_plan_writer;
GRANT EXECUTE ON FUNCTION forge.append_mcp_operator_review_version_v1(bytea,uuid,bigint,integer,text,text,integer,integer,integer,text[],text[],text[],text[],text[],text[],text[],text[],boolean[]) TO forge_architect_plan_history_reader;
GRANT EXECUTE ON FUNCTION forge.read_architect_plan_history_v1(bytea,uuid,bigint) TO forge_architect_plan_history_reader;
GRANT EXECUTE ON FUNCTION forge.append_architect_clarification_answer_v1(bytea,uuid,uuid,uuid,bigint,uuid,text,text,text) TO forge_architect_plan_history_reader;
GRANT EXECUTE ON FUNCTION forge.read_mcp_operator_review_history_v1(bytea,uuid,uuid,integer) TO forge_architect_plan_history_reader;
GRANT EXECUTE ON FUNCTION forge.list_approved_package_plan_registrations_v1(bytea,uuid,bigint,integer,text) TO forge_architect_plan_history_reader;
GRANT EXECUTE ON FUNCTION forge.resolve_architect_plan_entry_v1(uuid) TO forge_architect_plan_resolver;
GRANT EXECUTE ON FUNCTION forge.s4_runtime_mode_v1() TO forge_packet_issuer;
GRANT EXECUTE ON FUNCTION forge.claim_work_package_lifecycle_v2(text,uuid,uuid,timestamptz,uuid,text,uuid,integer,uuid,text,timestamptz,text,text,integer,uuid,uuid,uuid,integer,integer,text[]) TO forge_packet_issuer;
GRANT EXECUTE ON FUNCTION forge.heartbeat_local_lifecycle_v2(uuid,uuid,bigint,integer) TO forge_packet_issuer;
GRANT EXECUTE ON FUNCTION forge.heartbeat_packet_lifecycle_v2(uuid,uuid,bigint,uuid,bigint,integer,integer) TO forge_packet_issuer;
GRANT EXECUTE ON FUNCTION forge.begin_packet_assembly_v2(uuid,uuid,bigint,uuid,bigint,uuid) TO forge_packet_issuer;
GRANT EXECUTE ON FUNCTION forge.complete_packet_assembly_v2(uuid,uuid,bigint,uuid,bigint,uuid,text,integer,integer,integer,jsonb) TO forge_packet_issuer;
GRANT EXECUTE ON FUNCTION forge.begin_packet_delivery_v2(uuid,uuid,bigint,uuid,bigint,uuid) TO forge_packet_issuer;
GRANT EXECUTE ON FUNCTION forge.complete_packet_delivery_v2(uuid,uuid,bigint,uuid,bigint,uuid,text) TO forge_packet_issuer;
GRANT EXECUTE ON FUNCTION forge.finalize_local_success_v2(uuid,uuid,bigint,text,text,jsonb) TO forge_packet_issuer;
GRANT EXECUTE ON FUNCTION forge.finalize_local_failure_v2(uuid,uuid,bigint,text) TO forge_packet_issuer;
GRANT EXECUTE ON FUNCTION forge.finalize_packet_success_v2(uuid,uuid,bigint,uuid,bigint,text,text,jsonb) TO forge_packet_issuer;
GRANT EXECUTE ON FUNCTION forge.materialize_s4_completion_handoff_v1(uuid,text[]) TO forge_packet_issuer;
GRANT EXECUTE ON FUNCTION forge.discover_s4_completion_handoff_v1(uuid) TO forge_packet_issuer;
GRANT EXECUTE ON FUNCTION forge.list_pending_s4_completion_handoffs_v1(integer,timestamptz,uuid) TO forge_packet_issuer;
GRANT EXECUTE ON FUNCTION forge.claim_pending_s4_completion_handoffs_v1(text,uuid,integer,integer) TO forge_packet_issuer;
GRANT EXECUTE ON FUNCTION forge.materialize_claimed_s4_completion_handoff_v1(uuid,text[],text,uuid,bigint) TO forge_packet_issuer;
GRANT EXECUTE ON FUNCTION forge.finalize_s4_max_attempts_v1(uuid,uuid,timestamptz,integer) TO forge_packet_issuer;
GRANT EXECUTE ON FUNCTION forge.resolve_s4_review_source_v1(uuid) TO forge_review_source_resolver;
GRANT EXECUTE ON FUNCTION forge.finalize_packet_failure_v2(uuid,uuid,bigint,uuid,bigint,text,text) TO forge_packet_issuer;
GRANT EXECUTE ON FUNCTION forge.recover_linked_s4_lifecycle_v2(uuid) TO forge_packet_issuer;
GRANT EXECUTE ON FUNCTION forge.cas_packet_reapproval_v2(uuid,uuid,uuid,text,uuid) TO forge_packet_issuer;
GRANT EXECUTE ON FUNCTION forge.apply_local_effect_recovery_action_v2(uuid,uuid,uuid,text,text,uuid) TO forge_s4_recovery_operator;
GRANT EXECUTE ON FUNCTION forge.apply_packet_issuance_recovery_action_v2(uuid,uuid,uuid,text,text,uuid,uuid) TO forge_s4_recovery_operator;
GRANT EXECUTE ON FUNCTION forge.bind_architect_plan_entry_v1(uuid,uuid,uuid,uuid,bigint,text,text,text,text,text) TO forge_packet_issuer;
GRANT EXECUTE ON FUNCTION forge.bind_architect_plan_entry_v2(uuid,uuid) TO forge_packet_issuer;
GRANT EXECUTE ON FUNCTION forge.bind_architect_replan_entry_v1(uuid,uuid) TO forge_architect_plan_writer;
GRANT EXECUTE ON FUNCTION forge.bind_architect_replan_context_v2(uuid,uuid) TO forge_architect_plan_writer;
GRANT EXECUTE ON FUNCTION forge.bind_architect_replan_context_v3(uuid,uuid) TO forge_architect_plan_writer;
GRANT EXECUTE ON FUNCTION forge.resolve_architect_plan_entry_v2(uuid) TO forge_architect_plan_resolver;
GRANT EXECUTE ON FUNCTION forge.inspect_local_projection_overlimit_v2(uuid) TO forge_local_projection_archiver;
GRANT EXECUTE ON FUNCTION forge.apply_local_projection_overlimit_archive_v2(uuid,uuid,uuid,text,text) TO forge_local_projection_archiver;
GRANT EXECUTE ON FUNCTION forge.resume_local_projection_overlimit_archive_v2(uuid,uuid,text) TO forge_local_projection_archiver;
GRANT EXECUTE ON FUNCTION forge.rollback_local_projection_overlimit_archive_v2(uuid,uuid,text) TO forge_local_projection_archiver;
GRANT EXECUTE ON FUNCTION forge.cancel_local_projection_overlimit_archive_v2(uuid,uuid,text) TO forge_local_projection_archiver;
-- The bootstrap fence temporarily gives the incoming owner CREATE on the two
-- containing schemas because PostgreSQL requires it for SET OWNER. The
-- finalizer revokes both grants before it verifies the permanent boundary.
ALTER TABLE public.architect_plan_versions OWNER TO forge_s4_routines_owner;
ALTER TABLE public.architect_plan_entries OWNER TO forge_s4_routines_owner;
ALTER TABLE public.architect_plan_execution_references OWNER TO forge_s4_routines_owner;
ALTER TABLE public.architect_plan_history_reads OWNER TO forge_s4_routines_owner;
ALTER TABLE public.architect_clarification_answers OWNER TO forge_s4_routines_owner;
ALTER TABLE public.architect_clarification_answer_writes OWNER TO forge_s4_routines_owner;
ALTER TABLE public.protected_package_entry_registrations OWNER TO forge_s4_routines_owner;
ALTER TABLE public.protected_entry_capability_bindings OWNER TO forge_s4_routines_owner;
ALTER TABLE public.mcp_operator_review_versions OWNER TO forge_s4_routines_owner;
ALTER TABLE public.mcp_operator_review_entries OWNER TO forge_s4_routines_owner;
ALTER TABLE public.work_package_local_run_evidence OWNER TO forge_s4_routines_owner;
ALTER TABLE public.s4_completion_handoffs OWNER TO forge_s4_routines_owner;
ALTER TABLE public.s4_protected_review_sources OWNER TO forge_s4_routines_owner;
ALTER TABLE public.s4_protected_review_source_reads OWNER TO forge_s4_routines_owner;
ALTER TABLE public.s4_max_attempt_finalizations OWNER TO forge_s4_routines_owner;
ALTER TABLE public.filesystem_mcp_issuance_recovery_actions OWNER TO forge_s4_routines_owner;
ALTER TABLE public.local_effect_recovery_actions OWNER TO forge_s4_routines_owner;
ALTER TABLE public.local_projection_archive_operations OWNER TO forge_s4_routines_owner;
ALTER TABLE public.local_projection_archive_operation_checkpoints OWNER TO forge_s4_routines_owner;
ALTER TABLE public.filesystem_mcp_decision_nonce_claims OWNER TO forge_s4_routines_owner;
ALTER TABLE public.project_root_ref_reconciliation OWNER TO forge_s4_routines_owner;
ALTER FUNCTION forge.fill_project_root_ref_on_insert_v1() OWNER TO forge_s4_routines_owner;
ALTER FUNCTION forge.guard_project_root_ref_renull_v1() OWNER TO forge_s4_routines_owner;
ALTER FUNCTION forge.reconcile_project_root_refs_v1(integer) OWNER TO forge_s4_routines_owner;
ALTER FUNCTION forge.s4_protected_paths_enabled_v1() OWNER TO forge_s4_routines_owner;
ALTER FUNCTION forge.guard_s4_approval_gate_review_head_v1() OWNER TO forge_s4_routines_owner;
ALTER FUNCTION forge.reject_s4_retained_mutation_v1() OWNER TO forge_s4_routines_owner;
ALTER FUNCTION forge.guard_architect_plan_public_artifact_v1() OWNER TO forge_s4_routines_owner;
ALTER FUNCTION forge.read_architect_plan_history_v1(bytea,uuid,bigint) OWNER TO forge_s4_routines_owner;
ALTER FUNCTION forge.append_architect_clarification_answer_v1(bytea,uuid,uuid,uuid,bigint,uuid,text,text,text) OWNER TO forge_s4_routines_owner;
ALTER FUNCTION forge.append_mcp_operator_review_version_v1(bytea,uuid,bigint,integer,text,text,integer,integer,integer,text[],text[],text[],text[],text[],text[],text[],text[],boolean[]) OWNER TO forge_s4_routines_owner;
ALTER FUNCTION forge.read_mcp_operator_review_history_v1(bytea,uuid,uuid,integer) OWNER TO forge_s4_routines_owner;
ALTER FUNCTION forge.list_approved_package_plan_registrations_v1(bytea,uuid,bigint,integer,text) OWNER TO forge_s4_routines_owner;
ALTER FUNCTION forge.resolve_architect_plan_entry_v1(uuid) OWNER TO forge_s4_routines_owner;
ALTER FUNCTION forge.create_local_run_evidence_v1(uuid,uuid,integer) OWNER TO forge_s4_routines_owner;
ALTER FUNCTION forge.validate_packet_authorization_snapshot_v2(jsonb,text,text,uuid,bigint,uuid,bigint) OWNER TO forge_s4_routines_owner;
ALTER FUNCTION forge.insert_packet_authorization_snapshot_v2(uuid,uuid,uuid,uuid,uuid,integer,text[]) OWNER TO forge_s4_routines_owner;
ALTER FUNCTION forge.guard_packet_authorization_v2() OWNER TO forge_s4_routines_owner;
ALTER FUNCTION forge.s4_execution_lease_live_v1(jsonb,uuid,timestamptz) OWNER TO forge_s4_routines_owner;
ALTER FUNCTION forge.s4_runtime_mode_v1() OWNER TO forge_s4_routines_owner;
ALTER FUNCTION forge.read_s4_runtime_mode_for_application_v1() OWNER TO forge_s4_routines_owner;
ALTER FUNCTION forge.packet_recovery_marker_token_v2(text) OWNER TO forge_s4_routines_owner;
ALTER FUNCTION forge.packet_recovery_marker_fingerprint_v2(jsonb) OWNER TO forge_s4_routines_owner;
ALTER FUNCTION forge.claim_local_lifecycle_v2(uuid,uuid,integer) OWNER TO forge_s4_routines_owner;
ALTER FUNCTION forge.claim_packet_lifecycle_v2(uuid,uuid,uuid,uuid,integer,integer,text[]) OWNER TO forge_s4_routines_owner;
ALTER FUNCTION forge.claim_work_package_lifecycle_v2(text,uuid,uuid,timestamptz,uuid,text,uuid,integer,uuid,text,timestamptz,text,text,integer,uuid,uuid,uuid,integer,integer,text[]) OWNER TO forge_s4_routines_owner;
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
ALTER FUNCTION forge.materialize_s4_completion_handoff_v1(uuid,text[]) OWNER TO forge_s4_routines_owner;
ALTER FUNCTION forge.discover_s4_completion_handoff_v1(uuid) OWNER TO forge_s4_routines_owner;
ALTER FUNCTION forge.list_pending_s4_completion_handoffs_v1(integer,timestamptz,uuid) OWNER TO forge_s4_routines_owner;
ALTER FUNCTION forge.claim_pending_s4_completion_handoffs_v1(text,uuid,integer,integer) OWNER TO forge_s4_routines_owner;
ALTER FUNCTION forge.materialize_claimed_s4_completion_handoff_v1(uuid,text[],text,uuid,bigint) OWNER TO forge_s4_routines_owner;
ALTER FUNCTION forge.finalize_s4_max_attempts_v1(uuid,uuid,timestamptz,integer) OWNER TO forge_s4_routines_owner;
ALTER FUNCTION forge.resolve_s4_review_source_v1(uuid) OWNER TO forge_s4_routines_owner;
ALTER FUNCTION forge.finalize_packet_failure_v2(uuid,uuid,bigint,uuid,bigint,text,text) OWNER TO forge_s4_routines_owner;
ALTER FUNCTION forge.recover_stale_local_lifecycle_v2(uuid) OWNER TO forge_s4_routines_owner;
ALTER FUNCTION forge.recover_stale_packet_lifecycle_v2(uuid) OWNER TO forge_s4_routines_owner;
ALTER FUNCTION forge.recover_linked_s4_lifecycle_v2(uuid) OWNER TO forge_s4_routines_owner;
ALTER FUNCTION forge.cas_packet_reapproval_v2(uuid,uuid,uuid,text,uuid) OWNER TO forge_s4_routines_owner;
ALTER FUNCTION forge.apply_local_effect_recovery_action_v2(uuid,uuid,uuid,text,text,uuid) OWNER TO forge_s4_routines_owner;
ALTER FUNCTION forge.apply_packet_issuance_recovery_action_v2(uuid,uuid,uuid,text,text,uuid,uuid) OWNER TO forge_s4_routines_owner;
ALTER FUNCTION forge.insert_architect_plan_version_v1(uuid,uuid,bigint,text,text,text,text[],text[],text[],text[],text[],text[],text[],text[]) OWNER TO forge_s4_routines_owner;
ALTER FUNCTION forge.register_package_plan_entries_v1(uuid,uuid,bigint,uuid[],text[],text[],integer[],text[],text[],text[]) OWNER TO forge_s4_routines_owner;
ALTER FUNCTION forge.bind_architect_plan_entry_v1(uuid,uuid,uuid,uuid,bigint,text,text,text,text,text) OWNER TO forge_s4_routines_owner;
ALTER FUNCTION forge.bind_architect_plan_entry_v2(uuid,uuid) OWNER TO forge_s4_routines_owner;
ALTER FUNCTION forge.bind_architect_replan_entry_v1(uuid,uuid) OWNER TO forge_s4_routines_owner;
ALTER FUNCTION forge.bind_architect_replan_context_v2(uuid,uuid) OWNER TO forge_s4_routines_owner;
ALTER FUNCTION forge.bind_architect_replan_context_v3(uuid,uuid) OWNER TO forge_s4_routines_owner;
ALTER FUNCTION forge.resolve_architect_plan_entry_v2(uuid) OWNER TO forge_s4_routines_owner;
ALTER FUNCTION forge.local_projection_archive_operation_fingerprint_v2(uuid,text,text) OWNER TO forge_s4_routines_owner;
ALTER FUNCTION forge.inspect_local_projection_overlimit_v2(uuid) OWNER TO forge_s4_routines_owner;
ALTER FUNCTION forge.apply_local_projection_overlimit_archive_v2(uuid,uuid,uuid,text,text) OWNER TO forge_s4_routines_owner;
ALTER FUNCTION forge.resume_local_projection_overlimit_archive_v2(uuid,uuid,text) OWNER TO forge_s4_routines_owner;
ALTER FUNCTION forge.rollback_local_projection_overlimit_archive_v2(uuid,uuid,text) OWNER TO forge_s4_routines_owner;
ALTER FUNCTION forge.cancel_local_projection_overlimit_archive_v2(uuid,uuid,text) OWNER TO forge_s4_routines_owner;
--> statement-breakpoint
SET ROLE forge_s4_routines_owner;
DO $$
DECLARE
  v_application_role name := session_user;
BEGIN
  EXECUTE pg_catalog.format(
    'GRANT EXECUTE ON FUNCTION forge.read_s4_runtime_mode_for_application_v1() TO %I',
    v_application_role
  );
END;
$$;
RESET ROLE;
--> statement-breakpoint
SELECT public.forge_finalize_epic_172_s4_owner_bootstrap_v1();
