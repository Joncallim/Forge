DO $$
BEGIN
  IF current_user IN (
    'forge_release_evidence_writer',
    'forge_release_transition',
    'forge_release_routines_owner'
  ) THEN
    RAISE EXCEPTION 'The migration login must not be a dedicated Epic 172 release principal'
      USING ERRCODE = '42501';
  END IF;
  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_roles
    WHERE rolname IN (
      'forge_release_evidence_writer',
      'forge_release_transition',
      'forge_release_routines_owner'
    )
      AND NOT rolinherit
      AND NOT rolsuper
      AND NOT rolcreatedb
      AND NOT rolcreaterole
      AND NOT rolreplication
      AND NOT rolbypassrls
      AND rolcanlogin = (rolname <> 'forge_release_routines_owner')
  ) <> 3 THEN
    RAISE EXCEPTION 'Epic 172 release roles must have exact least-privilege attributes; run protocol:bootstrap-epic-172-release-roles first'
      USING ERRCODE = '42501';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_auth_members membership
    JOIN pg_catalog.pg_roles granted ON granted.oid = membership.roleid
    JOIN pg_catalog.pg_roles member ON member.oid = membership.member
    WHERE granted.rolname IN (
      'forge_release_evidence_writer',
      'forge_release_transition',
      'forge_release_routines_owner'
    )
       OR member.rolname IN (
      'forge_release_evidence_writer',
      'forge_release_transition',
      'forge_release_routines_owner'
    )
  ) <> 1 OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_auth_members membership
    JOIN pg_catalog.pg_roles granted ON granted.oid = membership.roleid
    JOIN pg_catalog.pg_roles member ON member.oid = membership.member
    WHERE granted.rolname = 'forge_release_routines_owner'
      AND member.rolname = current_user
      AND NOT membership.admin_option
  ) THEN
    RAISE EXCEPTION 'migration role % must hold the sole non-admin temporary Epic 172 owner membership', current_user
      USING ERRCODE = '42501';
  END IF;
END;
$$;
--> statement-breakpoint
CREATE SCHEMA IF NOT EXISTS forge;
--> statement-breakpoint
REVOKE ALL ON SCHEMA forge FROM PUBLIC;
--> statement-breakpoint
ALTER SCHEMA forge OWNER TO forge_release_routines_owner;
--> statement-breakpoint
ALTER TABLE public.forge_release_signer_keys OWNER TO forge_release_routines_owner;
ALTER TABLE public.forge_release_signer_key_lifecycle_audits OWNER TO forge_release_routines_owner;
ALTER TABLE public.forge_epic_172_release_evidence OWNER TO forge_release_routines_owner;
ALTER TABLE public.forge_epic_172_transition_authorizations OWNER TO forge_release_routines_owner;
ALTER TABLE public.forge_epic_172_release_evidence_consumptions OWNER TO forge_release_routines_owner;
ALTER TABLE public.forge_epic_172_enablement_state OWNER TO forge_release_routines_owner;
ALTER TABLE public.forge_epic_172_enablement_transition_audits OWNER TO forge_release_routines_owner;
--> statement-breakpoint
ALTER FUNCTION public.forge_epic_172_reject_mutation_v1() OWNER TO forge_release_routines_owner;
REVOKE ALL ON FUNCTION public.forge_epic_172_reject_mutation_v1() FROM PUBLIC;
--> statement-breakpoint
SET LOCAL ROLE forge_release_routines_owner;
--> statement-breakpoint
DROP INDEX public.forge_epic_172_release_evidence_consumptions_authorization_idx;
CREATE UNIQUE INDEX forge_epic_172_release_evidence_consumptions_authorization_receipt_idx
  ON public.forge_epic_172_release_evidence_consumptions (authorization_id, receipt_id);
--> statement-breakpoint
ALTER TABLE public.forge_release_signer_keys
  ALTER COLUMN status SET DEFAULT 'staged',
  DROP CONSTRAINT forge_release_signer_keys_status_chk,
  DROP CONSTRAINT forge_release_signer_keys_lifecycle_chk,
  ADD CONSTRAINT forge_release_signer_keys_status_chk
    CHECK (status IN ('staged', 'active', 'retiring', 'retired')),
  ADD CONSTRAINT forge_release_signer_keys_lifecycle_chk CHECK (
    (status = 'staged' AND activated_at IS NULL AND retirement_started_at IS NULL AND retired_at IS NULL)
    OR (status = 'active' AND activated_at IS NOT NULL AND retirement_started_at IS NULL AND retired_at IS NULL)
    OR (status = 'retiring' AND activated_at IS NOT NULL AND retirement_started_at IS NOT NULL AND retired_at IS NULL)
    OR (status = 'retired' AND activated_at IS NOT NULL AND retirement_started_at IS NOT NULL AND retired_at IS NOT NULL)
  );
ALTER TABLE public.forge_release_signer_key_lifecycle_audits
  DROP CONSTRAINT forge_release_signer_lifecycle_prior_status_chk,
  DROP CONSTRAINT forge_release_signer_lifecycle_new_status_chk,
  ADD CONSTRAINT forge_release_signer_lifecycle_prior_status_chk
    CHECK (prior_status IS NULL OR prior_status IN ('staged', 'active', 'retiring', 'retired')),
  ADD CONSTRAINT forge_release_signer_lifecycle_new_status_chk
    CHECK (new_status IN ('staged', 'active', 'retiring', 'retired'));
ALTER TABLE public.forge_epic_172_enablement_state
  DROP CONSTRAINT forge_epic_172_enablement_token_chk,
  ALTER COLUMN controller_token_digest TYPE bytea
    USING CASE
      WHEN controller_token_digest IS NULL THEN NULL
      ELSE pg_catalog.decode(controller_token_digest, 'hex')
    END,
  ADD CONSTRAINT forge_epic_172_enablement_token_chk
    CHECK (controller_token_digest IS NULL OR pg_catalog.octet_length(controller_token_digest) = 32);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION forge.install_epic_172_release_signer_v1(
  p_signer_key_id uuid,
  p_generation bigint,
  p_public_key_spki bytea,
  p_github_app_id text,
  p_ruleset_fingerprint text,
  p_valid_from timestamptz,
  p_valid_until timestamptz,
  p_actor text,
  p_reason text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_key_count integer;
  v_active_count integer;
  v_staged_count integer;
  v_max_generation bigint;
BEGIN
  IF session_user <> 'forge_release_evidence_writer' THEN
    RAISE EXCEPTION 'Epic 172 signer installation requires the dedicated writer login'
      USING ERRCODE = '42501';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('forge:epic-172:signer-policy', 0)
  );
  IF pg_catalog.octet_length(p_public_key_spki) NOT BETWEEN 1 AND 512
     OR p_github_app_id !~ '^[1-9][0-9]{0,19}$'
     OR p_ruleset_fingerprint !~ '^[0-9a-f]{64}$'
     OR p_valid_until <= p_valid_from
     OR pg_catalog.length(pg_catalog.btrim(p_actor)) NOT BETWEEN 1 AND 200
     OR pg_catalog.length(p_reason) > 1000 THEN
    RAISE EXCEPTION 'Epic 172 signer installation fields are invalid'
      USING ERRCODE = '22023';
  END IF;
  SELECT
    pg_catalog.count(*)::integer,
    pg_catalog.count(*) FILTER (WHERE status = 'active')::integer,
    pg_catalog.count(*) FILTER (WHERE status = 'staged')::integer,
    pg_catalog.max(generation)
  INTO v_key_count, v_active_count, v_staged_count, v_max_generation
  FROM public.forge_release_signer_keys;
  IF (v_key_count = 0 AND p_generation <> 1)
     OR (v_key_count > 0 AND (
       v_active_count <> 1
       OR v_staged_count <> 0
       OR p_generation <> v_max_generation + 1
     )) THEN
    RAISE EXCEPTION 'Epic 172 signer installation requires generation 1 on an empty policy or the exact next generation with one active signer and no staged signer'
      USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.forge_release_signer_keys (
    id, policy_id, generation, algorithm, public_key_spki, github_app_id,
    ruleset_fingerprint, status, valid_from, valid_until
  ) VALUES (
    p_signer_key_id, 'forge-epic-172-release-signing-v1', p_generation,
    'Ed25519', p_public_key_spki, p_github_app_id, p_ruleset_fingerprint,
    'staged', p_valid_from, p_valid_until
  );
  INSERT INTO public.forge_release_signer_key_lifecycle_audits (
    signer_key_id, signer_generation, action, prior_status, new_status, actor, reason
  ) VALUES (
    p_signer_key_id, p_generation, 'installed', NULL, 'staged', pg_catalog.btrim(p_actor), p_reason
  );
  RETURN p_signer_key_id;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION forge.activate_epic_172_release_signer_v1(
  p_signer_key_id uuid,
  p_expected_active_signer_key_id uuid,
  p_expected_active_generation bigint,
  p_actor text,
  p_reason text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_staged public.forge_release_signer_keys%ROWTYPE;
  v_active public.forge_release_signer_keys%ROWTYPE;
  v_key_count integer;
  v_staged_count integer;
BEGIN
  IF session_user <> 'forge_release_evidence_writer' THEN
    RAISE EXCEPTION 'Epic 172 signer activation requires the dedicated writer login'
      USING ERRCODE = '42501';
  END IF;
  IF pg_catalog.length(pg_catalog.btrim(p_actor)) NOT BETWEEN 1 AND 200
     OR pg_catalog.length(p_reason) > 1000 THEN
    RAISE EXCEPTION 'Epic 172 signer activation actor or reason is invalid' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('forge:epic-172:signer-policy', 0)
  );
  SELECT * INTO STRICT v_staged
  FROM public.forge_release_signer_keys
  WHERE id = p_signer_key_id
  FOR UPDATE;
  IF v_staged.status <> 'staged'
     OR v_now < v_staged.valid_from
     OR v_now >= v_staged.valid_until THEN
    RAISE EXCEPTION 'Only a currently valid staged Epic 172 signer may activate'
      USING ERRCODE = '22023';
  END IF;
  SELECT pg_catalog.count(*)::integer,
         pg_catalog.count(*) FILTER (WHERE status = 'staged')::integer
  INTO v_key_count, v_staged_count
  FROM public.forge_release_signer_keys;
  SELECT * INTO v_active
  FROM public.forge_release_signer_keys
  WHERE policy_id = 'forge-epic-172-release-signing-v1'
    AND status = 'active'
  FOR UPDATE;

  IF v_staged.generation = 1 THEN
    IF p_expected_active_signer_key_id IS NOT NULL
       OR p_expected_active_generation IS NOT NULL
       OR v_active.id IS NOT NULL
       OR v_key_count <> 1
       OR v_staged_count <> 1 THEN
      RAISE EXCEPTION 'First signer activation requires an empty active-policy compare-and-set'
        USING ERRCODE = '40001';
    END IF;
  ELSIF p_expected_active_signer_key_id IS NULL
     OR p_expected_active_generation IS NULL
     OR v_active.id IS NULL
     OR v_active.id <> p_expected_active_signer_key_id
     OR v_active.generation <> p_expected_active_generation
     OR v_staged.generation <> p_expected_active_generation + 1
     OR v_staged_count <> 1 THEN
    RAISE EXCEPTION 'Signer rotation compare-and-set did not match the exact active generation'
      USING ERRCODE = '40001';
  ELSE
    UPDATE public.forge_release_signer_keys
    SET status = 'retiring', retirement_started_at = v_now
    WHERE id = v_active.id AND status = 'active';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Signer rotation lost the active-generation compare-and-set race'
        USING ERRCODE = '40001';
    END IF;
    INSERT INTO public.forge_release_signer_key_lifecycle_audits (
      signer_key_id, signer_generation, action, prior_status, new_status, actor, reason, occurred_at
    ) VALUES (
      v_active.id, v_active.generation, 'retirement_started', 'active', 'retiring',
      pg_catalog.btrim(p_actor), p_reason, v_now
    );
  END IF;
  UPDATE public.forge_release_signer_keys
  SET status = 'active', activated_at = v_now
  WHERE id = v_staged.id AND status = 'staged';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Signer activation lost the staged-generation compare-and-set race'
      USING ERRCODE = '40001';
  END IF;
  INSERT INTO public.forge_release_signer_key_lifecycle_audits (
    signer_key_id, signer_generation, action, prior_status, new_status, actor, reason, occurred_at
  ) VALUES (
    v_staged.id, v_staged.generation, 'activated', 'staged', 'active',
    pg_catalog.btrim(p_actor), p_reason, v_now
  );
  RETURN v_staged.id;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION forge.retire_epic_172_release_signer_v1(
  p_signer_key_id uuid,
  p_expected_generation bigint,
  p_actor text,
  p_reason text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_retiring public.forge_release_signer_keys%ROWTYPE;
BEGIN
  IF session_user <> 'forge_release_evidence_writer' THEN
    RAISE EXCEPTION 'Epic 172 signer retirement requires the dedicated writer login'
      USING ERRCODE = '42501';
  END IF;
  IF p_expected_generation <= 0
     OR pg_catalog.length(pg_catalog.btrim(p_actor)) NOT BETWEEN 1 AND 200
     OR pg_catalog.length(p_reason) > 1000 THEN
    RAISE EXCEPTION 'Epic 172 signer retirement generation, actor, or reason is invalid'
      USING ERRCODE = '22023';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('forge:epic-172:signer-policy', 0)
  );
  SELECT * INTO STRICT v_retiring
  FROM public.forge_release_signer_keys
  WHERE id = p_signer_key_id
  FOR UPDATE;
  IF v_retiring.generation <> p_expected_generation
     OR v_retiring.status <> 'retiring'
     OR NOT EXISTS (
       SELECT 1
       FROM public.forge_release_signer_keys active_key
       WHERE active_key.policy_id = v_retiring.policy_id
         AND active_key.status = 'active'
         AND active_key.generation > v_retiring.generation
     ) THEN
    RAISE EXCEPTION 'Signer retirement compare-and-set requires the exact retiring generation and a newer active signer'
      USING ERRCODE = '40001';
  END IF;
  UPDATE public.forge_release_signer_keys
  SET status = 'retired', retired_at = v_now
  WHERE id = v_retiring.id
    AND generation = p_expected_generation
    AND status = 'retiring';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Signer retirement lost the generation compare-and-set race'
      USING ERRCODE = '40001';
  END IF;
  INSERT INTO public.forge_release_signer_key_lifecycle_audits (
    signer_key_id, signer_generation, action, prior_status, new_status, actor, reason, occurred_at
  ) VALUES (
    v_retiring.id, v_retiring.generation, 'retired', 'retiring', 'retired',
    pg_catalog.btrim(p_actor), p_reason, v_now
  );
  RETURN v_retiring.id;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION forge.record_epic_172_release_evidence_v1(
  p_receipt_id uuid,
  p_evidence_kind text,
  p_owner_issue integer,
  p_owner_slice text,
  p_exact_builds jsonb,
  p_required_evidence jsonb,
  p_reviewed_sha text,
  p_epoch bigint,
  p_predecessor_receipt_ids jsonb,
  p_predecessor_set_digest text,
  p_transition_identity_digest text,
  p_signer_key_id uuid,
  p_signer_generation bigint,
  p_github_app_id text,
  p_controller_run_id text,
  p_controller_job_id text,
  p_envelope_digest text,
  p_detached_signature bytea,
  p_nonce uuid,
  p_issued_at timestamptz,
  p_envelope jsonb
)
RETURNS TABLE (receipt_id uuid, recorded_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_key public.forge_release_signer_keys%ROWTYPE;
  v_expected_kinds text[];
  v_expected_evidence_names text[];
  v_actual_kinds text[];
  v_actual_count integer;
  v_expected_envelope jsonb;
BEGIN
  IF session_user <> 'forge_release_evidence_writer' THEN
    RAISE EXCEPTION 'Epic 172 evidence recording requires the dedicated writer login'
      USING ERRCODE = '42501';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('forge:epic-172:evidence:identity:' || p_transition_identity_digest, 0)
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('forge:epic-172:evidence:nonce:' || p_nonce::text, 0)
  );

  SELECT * INTO STRICT v_key
  FROM public.forge_release_signer_keys
  WHERE id = p_signer_key_id
  FOR UPDATE;

  IF v_key.policy_id <> 'forge-epic-172-release-signing-v1'
     OR v_key.algorithm <> 'Ed25519'
     OR v_key.generation <> p_signer_generation
     OR v_key.github_app_id <> p_github_app_id
     OR v_key.status <> 'active'
     OR v_key.activated_at IS NULL
     OR p_issued_at < v_key.valid_from
     OR p_issued_at < v_key.activated_at
     OR p_issued_at >= v_key.valid_until
     OR p_issued_at > v_now
     OR v_now >= v_key.valid_until THEN
    RAISE EXCEPTION 'Epic 172 signer is not active and lifecycle-valid at issued and recorded database time'
      USING ERRCODE = '22023';
  END IF;

  v_expected_kinds := CASE p_evidence_kind
    WHEN 'step0_retention_bridge' THEN ARRAY[]::text[]
    WHEN 's3_issue_178' THEN ARRAY['step0_retention_bridge']
    WHEN 's4_expand' THEN ARRAY['s3_issue_178']
    WHEN 's4_producers_disabled' THEN ARRAY['s4_expand']
    WHEN 's5_compatible_consumers_deployed' THEN ARRAY['s4_producers_disabled']
    WHEN 's6_pre_activation_green' THEN ARRAY['s5_compatible_consumers_deployed']
    WHEN 's4_controlled_activation' THEN ARRAY['s6_pre_activation_green']
    WHEN 's6_post_activation_green' THEN ARRAY['s4_controlled_activation']
    WHEN 'ingress_and_issuance_enabled' THEN ARRAY['s6_post_activation_green']
    WHEN 'enabled_build_tests_green' THEN ARRAY['ingress_and_issuance_enabled']
    WHEN 's5_s6_release_ready' THEN ARRAY['enabled_build_tests_green', 'ingress_and_issuance_enabled']
    ELSE NULL
  END;
  IF v_expected_kinds IS NULL THEN
    RAISE EXCEPTION 'Unknown Epic 172 evidence kind %', p_evidence_kind USING ERRCODE = '22023';
  END IF;

  v_expected_evidence_names := CASE p_evidence_kind
    WHEN 'step0_retention_bridge' THEN ARRAY[
      'project_removal_route_archive_or_reject_before_filesystem_work',
      'all_project_management_ingress_closed',
      'pre_bridge_processes_and_sessions_drained',
      'retention_foreign_keys_restrict_or_no_action',
      'database_hard_delete_guard_installed',
      'release_authentication_substrate_installed',
      'enablement_state_initialized_disabled',
      'signed_empty_predecessor_receipt_retained'
    ]
    WHEN 's3_issue_178' THEN ARRAY[
      'step0_retention_bridge_receipt',
      'grant_decision_revision_contract_green',
      'operator_hold_and_reconciliation_contract_green',
      'canonical_lock_order_contract_green',
      'postgresql_s3_evidence_green'
    ]
    WHEN 's4_expand' THEN ARRAY[
      's3_issue_178_receipt',
      'additive_schema_and_protocol_v2_expansion_complete',
      'root_reference_lifecycle_guards_green',
      'postgresql_expansion_tests_green',
      'all_v2_producers_disabled'
    ]
    WHEN 's4_producers_disabled' THEN ARRAY[
      's4_expand_receipt',
      'legacy_credentials_publishers_and_sessions_drained',
      'expansion_journal_reconciled_through_watermark',
      'project_root_bindings_complete',
      'legacy_prompt_and_event_data_zero_scan_green',
      'all_v2_producers_disabled'
    ]
    WHEN 's5_compatible_consumers_deployed' THEN ARRAY[
      's4_producers_disabled_receipt',
      'compatible_s5_evidence_consumers_deployed',
      'disabled_s6_controller_and_supported_host_harness_deployed',
      'writers_ingress_and_issuance_remain_disabled'
    ]
    WHEN 's6_pre_activation_green' THEN ARRAY[
      's5_compatible_consumers_deployed_receipt',
      'exact_pre_activation_manifest_green',
      'supported_host_preflight_green',
      'pinned_signer_lifecycle_green',
      'writers_ingress_and_issuance_remain_disabled'
    ]
    WHEN 's4_controlled_activation' THEN ARRAY[
      's6_pre_activation_green_receipt',
      'legacy_claims_drained',
      'host_root_and_task_readiness_green',
      'controlled_activation_audit_retained',
      'activated_epoch_committed',
      'writers_ingress_and_issuance_remain_disabled'
    ]
    WHEN 's6_post_activation_green' THEN ARRAY[
      's4_controlled_activation_receipt',
      'exact_post_activation_manifest_green',
      'pre_activation_receipt_binding_verified',
      'controller_run_binding_verified',
      'writers_ingress_and_issuance_remain_disabled'
    ]
    WHEN 'ingress_and_issuance_enabled' THEN ARRAY[
      's6_post_activation_green_receipt',
      'fresh_opening_transition_authorization',
      'provisional_enablement_window_open',
      'controller_lease_live',
      'registered_s3_and_root_writers_enabled_first',
      'queue_and_project_ingress_enabled_next',
      'packet_issuance_enabled_last'
    ]
    WHEN 's5_s6_release_ready' THEN ARRAY[
      'ingress_and_issuance_enabled_receipt',
      'enabled_build_tests_green',
      'provisional_enablement_and_controller_lease_live',
      'fresh_final_transition_authorization',
      'signed_final_readiness_envelope',
      'enablement_promoted_active'
    ]
    WHEN 'enabled_build_tests_green' THEN ARRAY[
      'post_activation_receipt_binding_verified',
      'ingress_and_issuance_enabled_evidence_verified',
      'static_suite_manifest_verified',
      'executed_test_ids_verified',
      'first_attempt_results_green',
      'output_scan_green',
      'teardown_verified',
      'destruction_or_reimage_verified'
    ]
    ELSE NULL
  END;
  IF jsonb_typeof(p_required_evidence) <> 'array'
     OR jsonb_array_length(p_required_evidence) <> pg_catalog.cardinality(v_expected_evidence_names)
     OR EXISTS (
       SELECT 1
       FROM jsonb_array_elements(p_required_evidence) WITH ORDINALITY AS claim(value, ordinal)
       WHERE jsonb_typeof(claim.value) <> 'object'
          OR claim.value <> pg_catalog.jsonb_build_object(
            'name', claim.value -> 'name',
            'measurementDigest', claim.value -> 'measurementDigest'
          )
          OR claim.value ->> 'name' IS DISTINCT FROM v_expected_evidence_names[claim.ordinal::integer]
          OR (claim.value ->> 'measurementDigest' ~ '^[0-9a-f]{64}$') IS NOT TRUE
     ) THEN
    RAISE EXCEPTION 'Epic 172 required-evidence measurements do not match the exact manifest contract for %', p_evidence_kind
      USING ERRCODE = '22023';
  END IF;

  IF jsonb_typeof(p_predecessor_receipt_ids) <> 'array'
     OR jsonb_array_length(p_predecessor_receipt_ids) <> pg_catalog.cardinality(v_expected_kinds)
     OR EXISTS (
       SELECT 1
       FROM jsonb_array_elements_text(p_predecessor_receipt_ids) WITH ORDINALITY AS ids(value, ordinal)
       WHERE ordinal > 1
         AND value <= (p_predecessor_receipt_ids ->> (ordinal::integer - 2))
     ) THEN
    RAISE EXCEPTION 'Epic 172 predecessor receipt set is not canonical for %', p_evidence_kind
      USING ERRCODE = '22023';
  END IF;

  PERFORM 1
  FROM public.forge_epic_172_release_evidence e
  JOIN jsonb_array_elements_text(p_predecessor_receipt_ids) ids(value)
    ON e.id = ids.value::uuid
  ORDER BY e.id
  FOR KEY SHARE OF e;

  SELECT pg_catalog.array_agg(e.evidence_kind ORDER BY e.evidence_kind), pg_catalog.count(*)::integer
  INTO v_actual_kinds, v_actual_count
  FROM public.forge_epic_172_release_evidence e
  JOIN jsonb_array_elements_text(p_predecessor_receipt_ids) ids(value)
    ON e.id = ids.value::uuid
  ;

  IF v_actual_count <> pg_catalog.cardinality(v_expected_kinds)
     OR COALESCE(v_actual_kinds, ARRAY[]::text[]) <> v_expected_kinds THEN
    RAISE EXCEPTION 'Epic 172 predecessor receipts do not match the runtime activation contract for %', p_evidence_kind
      USING ERRCODE = '23503';
  END IF;

  v_expected_envelope := pg_catalog.jsonb_build_object(
    'envelopeVersion', 1,
    'receiptId', p_receipt_id::text,
    'manifestVersion', 1,
    'evidenceKind', p_evidence_kind,
    'owner', pg_catalog.jsonb_build_object('issue', p_owner_issue, 'slice', p_owner_slice),
    'exactBuilds', p_exact_builds,
    'requiredEvidence', p_required_evidence,
    'reviewedSha', p_reviewed_sha,
    'epoch', p_epoch,
    'predecessorReceiptIds', p_predecessor_receipt_ids,
    'predecessorSetDigest', p_predecessor_set_digest,
    'transitionIdentityDigest', p_transition_identity_digest,
    'signerKeyId', p_signer_key_id::text,
    'signerGeneration', p_signer_generation,
    'githubAppId', p_github_app_id,
    'controllerRunId', p_controller_run_id,
    'controllerJobId', p_controller_job_id,
    'nonce', p_nonce::text,
    'issuedAt', pg_catalog.to_char(p_issued_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  );
  IF p_envelope <> v_expected_envelope THEN
    RAISE EXCEPTION 'Epic 172 release envelope does not match its verified typed fields'
      USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  INSERT INTO public.forge_epic_172_release_evidence (
    id, manifest_version, evidence_kind, owner_issue, owner_slice, exact_builds, required_evidence,
    reviewed_sha, epoch, predecessor_receipt_ids, predecessor_set_digest,
    transition_identity_digest, signer_key_id, signer_generation, github_app_id,
    controller_run_id, controller_job_id, signature_domain, envelope_version,
    envelope_digest, detached_signature, nonce, issued_at, recorded_at, envelope
  ) VALUES (
    p_receipt_id, 1, p_evidence_kind, p_owner_issue, p_owner_slice, p_exact_builds, p_required_evidence,
    p_reviewed_sha, p_epoch, p_predecessor_receipt_ids, p_predecessor_set_digest,
    p_transition_identity_digest, p_signer_key_id, p_signer_generation, p_github_app_id,
    p_controller_run_id, p_controller_job_id, 'forge:epic-172-release-evidence:v1', 1,
    p_envelope_digest, p_detached_signature, p_nonce, p_issued_at, v_now, p_envelope
  )
  RETURNING id, forge_epic_172_release_evidence.recorded_at;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION forge.read_epic_172_enablement_state_v1()
RETURNS TABLE (
  state text,
  owner_operation_id text,
  exact_builds jsonb,
  reviewed_sha text,
  epoch bigint,
  started_at timestamptz,
  expires_at timestamptz,
  enablement_receipt_id uuid,
  final_readiness_receipt_id uuid,
  opening_authorization_id uuid,
  controller_login_id text,
  controller_run_id text,
  controller_token_digest bytea,
  lease_generation bigint,
  last_heartbeat_at timestamptz,
  lease_expires_at timestamptz,
  state_fingerprint text,
  database_now timestamptz
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT
    s.state,
    s.owner_operation_id,
    s.exact_builds,
    s.reviewed_sha,
    s.epoch,
    s.started_at,
    s.expires_at,
    s.enablement_receipt_id,
    s.final_readiness_receipt_id,
    s.opening_authorization_id,
    s.controller_login_id,
    s.controller_run_id,
    s.controller_token_digest,
    s.lease_generation,
    s.last_heartbeat_at,
    s.lease_expires_at,
    s.state_fingerprint,
    pg_catalog.clock_timestamp()
  FROM public.forge_epic_172_enablement_state s
  WHERE s.singleton_id = 'epic-172'
  LIMIT 2
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION forge.epic_172_controller_lease_digest_v1(p_secret bytea)
RETURNS bytea
LANGUAGE plpgsql
IMMUTABLE
STRICT
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF pg_catalog.octet_length(p_secret) <> 32 THEN
    RAISE EXCEPTION 'Epic 172 controller lease secret must be exactly 32 bytes'
      USING ERRCODE = '22023';
  END IF;
  RETURN pg_catalog.sha256(
    pg_catalog.decode('666f7267653a657069632d3137322d636f6e74726f6c6c65722d6c656173653a763100', 'hex')
    || p_secret
  );
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION forge.constant_time_equal_32_v1(p_left bytea, p_right bytea)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
STRICT
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_difference integer := 0;
  v_index integer;
BEGIN
  IF pg_catalog.octet_length(p_left) <> 32 OR pg_catalog.octet_length(p_right) <> 32 THEN
    RAISE EXCEPTION 'Epic 172 constant-time comparison requires two 32-byte values'
      USING ERRCODE = '22023';
  END IF;
  FOR v_index IN 0..31 LOOP
    v_difference := v_difference |
      (pg_catalog.get_byte(p_left, v_index) # pg_catalog.get_byte(p_right, v_index));
  END LOOP;
  RETURN v_difference = 0;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION forge.lock_epic_172_signer_for_verification_v1(p_signer_key_id uuid)
RETURNS TABLE (id uuid, generation bigint, public_key_spki bytea)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF session_user NOT IN ('forge_release_evidence_writer', 'forge_release_transition') THEN
    RAISE EXCEPTION 'Epic 172 signer verification locks require a dedicated release login'
      USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT k.id, k.generation, k.public_key_spki
  FROM public.forge_release_signer_keys k
  WHERE k.id = p_signer_key_id
  FOR UPDATE;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION forge.lock_epic_172_release_receipts_v1(p_receipt_ids uuid[])
RETURNS TABLE (id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF session_user NOT IN ('forge_release_evidence_writer', 'forge_release_transition') THEN
    RAISE EXCEPTION 'Epic 172 receipt verification locks require a dedicated release login'
      USING ERRCODE = '42501';
  END IF;
  IF pg_catalog.cardinality(p_receipt_ids) > 64 THEN
    RAISE EXCEPTION 'Epic 172 receipt verification lock set is too large' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  SELECT e.id
  FROM public.forge_epic_172_release_evidence e
  WHERE e.id = ANY(p_receipt_ids)
  ORDER BY e.id
  FOR KEY SHARE;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION forge.lock_epic_172_transition_verification_v1(
  p_receipt_ids uuid[],
  p_authorization_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_receipt_count integer;
BEGIN
  IF session_user <> 'forge_release_transition' THEN
    RAISE EXCEPTION 'Epic 172 transition verification locks require the dedicated transition login'
      USING ERRCODE = '42501';
  END IF;
  IF pg_catalog.cardinality(p_receipt_ids) NOT BETWEEN 1 AND 64 THEN
    RAISE EXCEPTION 'Epic 172 transition receipt set must contain 1..64 receipts'
      USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.unnest(p_receipt_ids) WITH ORDINALITY AS receipt(id, ordinal)
    WHERE ordinal > 1 AND id <= p_receipt_ids[ordinal::integer - 1]
  ) THEN
    RAISE EXCEPTION 'Epic 172 transition receipt set must be unique and canonically sorted'
      USING ERRCODE = '22023';
  END IF;

  PERFORM 1
  FROM public.forge_epic_172_release_evidence
  WHERE id = ANY(p_receipt_ids)
  ORDER BY id
  FOR KEY SHARE;
  GET DIAGNOSTICS v_receipt_count = ROW_COUNT;
  IF v_receipt_count <> pg_catalog.cardinality(p_receipt_ids) THEN
    RAISE EXCEPTION 'The exact Epic 172 transition receipt set is not retained'
      USING ERRCODE = '23503';
  END IF;

  PERFORM 1
  FROM public.forge_epic_172_transition_authorizations
  WHERE id = p_authorization_id
  FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'The exact Epic 172 transition authorization is not retained'
      USING ERRCODE = '23503';
  END IF;
  PERFORM 1
  FROM public.forge_release_signer_keys signer
  WHERE signer.id IN (
    SELECT evidence.signer_key_id
    FROM public.forge_epic_172_release_evidence evidence
    WHERE evidence.id = ANY(p_receipt_ids)
    UNION
    SELECT authorization_row.signer_key_id
    FROM public.forge_epic_172_transition_authorizations authorization_row
    WHERE authorization_row.id = p_authorization_id
  )
  ORDER BY signer.id
  FOR UPDATE;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION forge.record_epic_172_transition_authorization_v1(
  p_authorization_id uuid,
  p_target_node text,
  p_transition_identity_digest text,
  p_source_receipt_ids jsonb,
  p_source_receipt_set_digest text,
  p_owner_issue integer,
  p_owner_slice text,
  p_exact_builds jsonb,
  p_reviewed_sha text,
  p_epoch bigint,
  p_operation_id text,
  p_operation text,
  p_controller_login_id text,
  p_controller_run_id text,
  p_signer_key_id uuid,
  p_signer_generation bigint,
  p_envelope_digest text,
  p_detached_signature bytea,
  p_nonce uuid,
  p_issued_at timestamptz,
  p_expires_at timestamptz,
  p_envelope jsonb
)
RETURNS TABLE (authorization_id uuid, recorded_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_key public.forge_release_signer_keys%ROWTYPE;
  v_expected_kinds text[];
  v_actual_kinds text[];
  v_actual_count integer;
  v_expected_envelope jsonb;
BEGIN
  IF session_user <> 'forge_release_evidence_writer' THEN
    RAISE EXCEPTION 'Epic 172 authorization recording requires the dedicated writer login'
      USING ERRCODE = '42501';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('forge:epic-172:authorization:nonce:' || p_nonce::text, 0)
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('forge:epic-172:authorization:identity:' || p_transition_identity_digest, 0)
  );

  SELECT * INTO STRICT v_key
  FROM public.forge_release_signer_keys
  WHERE id = p_signer_key_id
  FOR UPDATE;

  IF v_key.policy_id <> 'forge-epic-172-release-signing-v1'
     OR v_key.algorithm <> 'Ed25519'
     OR v_key.generation <> p_signer_generation
     OR v_key.status <> 'active'
     OR v_key.activated_at IS NULL
     OR p_issued_at < v_key.valid_from
     OR p_issued_at < v_key.activated_at
     OR p_issued_at >= v_key.valid_until
     OR p_issued_at > v_now
     OR v_now >= v_key.valid_until
     OR p_expires_at <= p_issued_at
     OR p_expires_at > p_issued_at + interval '30 minutes'
     OR v_now >= p_expires_at THEN
    RAISE EXCEPTION 'Epic 172 authorization signer or lifetime is not valid at recorded database time'
      USING ERRCODE = '22023';
  END IF;

  v_expected_kinds := CASE p_target_node
    WHEN 's3_issue_178' THEN ARRAY['step0_retention_bridge']
    WHEN 's4_expand' THEN ARRAY['s3_issue_178']
    WHEN 's4_producers_disabled' THEN ARRAY['s4_expand']
    WHEN 's5_compatible_consumers_deployed' THEN ARRAY['s4_producers_disabled']
    WHEN 's6_pre_activation_green' THEN ARRAY['s5_compatible_consumers_deployed']
    WHEN 's4_controlled_activation' THEN ARRAY['s6_pre_activation_green']
    WHEN 's6_post_activation_green' THEN ARRAY['s4_controlled_activation']
    WHEN 'ingress_and_issuance_enabled' THEN ARRAY['s6_post_activation_green']
    WHEN 's5_s6_release_ready' THEN ARRAY['enabled_build_tests_green', 'ingress_and_issuance_enabled']
    ELSE NULL
  END;
  IF v_expected_kinds IS NULL THEN
    RAISE EXCEPTION 'Unknown Epic 172 authorization target %', p_target_node USING ERRCODE = '22023';
  END IF;

  IF jsonb_typeof(p_source_receipt_ids) <> 'array'
     OR jsonb_array_length(p_source_receipt_ids) <> pg_catalog.cardinality(v_expected_kinds)
     OR EXISTS (
       SELECT 1
       FROM jsonb_array_elements_text(p_source_receipt_ids) WITH ORDINALITY AS ids(value, ordinal)
       WHERE ordinal > 1
         AND value <= (p_source_receipt_ids ->> (ordinal::integer - 2))
     ) THEN
    RAISE EXCEPTION 'Epic 172 authorization source receipt set is not canonical for %', p_target_node
      USING ERRCODE = '22023';
  END IF;

  PERFORM 1
  FROM public.forge_epic_172_release_evidence e
  JOIN jsonb_array_elements_text(p_source_receipt_ids) ids(value)
    ON e.id = ids.value::uuid
  ORDER BY e.id
  FOR KEY SHARE OF e;

  SELECT pg_catalog.array_agg(e.evidence_kind ORDER BY e.evidence_kind), pg_catalog.count(*)::integer
  INTO v_actual_kinds, v_actual_count
  FROM public.forge_epic_172_release_evidence e
  JOIN jsonb_array_elements_text(p_source_receipt_ids) ids(value)
    ON e.id = ids.value::uuid
  ;

  IF v_actual_count <> pg_catalog.cardinality(v_expected_kinds)
     OR COALESCE(v_actual_kinds, ARRAY[]::text[]) <> v_expected_kinds THEN
    RAISE EXCEPTION 'Epic 172 authorization sources do not match the runtime activation contract for %', p_target_node
      USING ERRCODE = '23503';
  END IF;

  v_expected_envelope := pg_catalog.jsonb_build_object(
    'envelopeVersion', 1,
    'authorizationId', p_authorization_id::text,
    'manifestVersion', 1,
    'targetNode', p_target_node,
    'transitionIdentityDigest', p_transition_identity_digest,
    'sourceReceiptIds', p_source_receipt_ids,
    'sourceReceiptSetDigest', p_source_receipt_set_digest,
    'owner', pg_catalog.jsonb_build_object('issue', p_owner_issue, 'slice', p_owner_slice),
    'exactBuilds', p_exact_builds,
    'reviewedSha', p_reviewed_sha,
    'epoch', p_epoch,
    'operationId', p_operation_id,
    'operation', p_operation,
    'controllerLoginId', p_controller_login_id,
    'controllerRunId', p_controller_run_id,
    'signerKeyId', p_signer_key_id::text,
    'signerGeneration', p_signer_generation,
    'nonce', p_nonce::text,
    'issuedAt', pg_catalog.to_char(p_issued_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'expiresAt', pg_catalog.to_char(p_expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  );
  IF p_envelope <> v_expected_envelope THEN
    RAISE EXCEPTION 'Epic 172 authorization envelope does not match its verified typed fields'
      USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  INSERT INTO public.forge_epic_172_transition_authorizations (
    id, manifest_version, target_node, transition_identity_digest, source_receipt_ids,
    source_receipt_set_digest, owner_issue, owner_slice, exact_builds, reviewed_sha,
    epoch, operation_id, operation, controller_login_id, controller_run_id,
    signer_key_id, signer_generation, signature_domain, envelope_version,
    envelope_digest, detached_signature, nonce, issued_at, expires_at, recorded_at, envelope
  ) VALUES (
    p_authorization_id, 1, p_target_node, p_transition_identity_digest, p_source_receipt_ids,
    p_source_receipt_set_digest, p_owner_issue, p_owner_slice, p_exact_builds, p_reviewed_sha,
    p_epoch, p_operation_id, p_operation, p_controller_login_id, p_controller_run_id,
    p_signer_key_id, p_signer_generation, 'forge:epic-172-transition-authorization:v1', 1,
    p_envelope_digest, p_detached_signature, p_nonce, p_issued_at, p_expires_at, v_now, p_envelope
  )
  RETURNING id, forge_epic_172_transition_authorizations.recorded_at;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION forge.consume_epic_172_release_evidence_v1(
  p_receipt_id uuid,
  p_authorization_id uuid,
  p_consumer_node text,
  p_transition_identity_digest text,
  p_operation_id text
)
RETURNS TABLE (consumption_id uuid, consumed_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_receipt public.forge_epic_172_release_evidence%ROWTYPE;
  v_authorization public.forge_epic_172_transition_authorizations%ROWTYPE;
  v_receipt_key public.forge_release_signer_keys%ROWTYPE;
  v_authorization_key public.forge_release_signer_keys%ROWTYPE;
BEGIN
  IF session_user <> 'forge_release_transition' THEN
    RAISE EXCEPTION 'Epic 172 evidence consumption requires the dedicated transition login'
      USING ERRCODE = '42501';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('forge:epic-172:consumption:receipt:' || p_receipt_id::text, 0)
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('forge:epic-172:consumption:identity:' || p_transition_identity_digest || ':' || p_consumer_node, 0)
  );

  SELECT * INTO STRICT v_receipt
  FROM public.forge_epic_172_release_evidence
  WHERE id = p_receipt_id
  FOR KEY SHARE;
  SELECT * INTO STRICT v_authorization
  FROM public.forge_epic_172_transition_authorizations
  WHERE id = p_authorization_id
  FOR KEY SHARE;
  SELECT * INTO STRICT v_receipt_key
  FROM public.forge_release_signer_keys
  WHERE id = v_receipt.signer_key_id
  FOR UPDATE;
  IF v_authorization.signer_key_id = v_receipt.signer_key_id THEN
    v_authorization_key := v_receipt_key;
  ELSE
    SELECT * INTO STRICT v_authorization_key
    FROM public.forge_release_signer_keys
    WHERE id = v_authorization.signer_key_id
    FOR UPDATE;
  END IF;

  IF v_authorization.transition_identity_digest <> p_transition_identity_digest
     OR v_authorization.target_node <> p_consumer_node
     OR v_authorization.operation_id <> p_operation_id
     OR NOT v_authorization.source_receipt_ids @> pg_catalog.jsonb_build_array(p_receipt_id::text)
     OR v_authorization.controller_login_id = ''
     OR v_receipt.signer_generation <> v_receipt_key.generation
     OR v_authorization.signer_generation <> v_authorization_key.generation
     OR v_receipt.github_app_id <> v_receipt_key.github_app_id
     OR v_receipt.issued_at < v_receipt_key.valid_from
     OR v_receipt.issued_at >= v_receipt_key.valid_until
     OR (v_receipt_key.retirement_started_at IS NOT NULL AND v_receipt.issued_at >= v_receipt_key.retirement_started_at)
     OR v_authorization.issued_at < v_authorization_key.valid_from
     OR v_authorization.issued_at >= v_authorization_key.valid_until
     OR (v_authorization_key.retirement_started_at IS NOT NULL AND v_authorization.issued_at >= v_authorization_key.retirement_started_at)
     OR v_now >= v_authorization.expires_at THEN
    RAISE EXCEPTION 'Epic 172 receipt and authorization are not an exact live transition binding'
      USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  INSERT INTO public.forge_epic_172_release_evidence_consumptions (
    receipt_id, transition_identity_digest, authorization_id, consumer_node,
    operation_id, actor, consumed_at
  ) VALUES (
    p_receipt_id, v_receipt.transition_identity_digest, p_authorization_id,
    p_consumer_node, p_operation_id, v_authorization.controller_login_id, v_now
  )
  RETURNING id, forge_epic_172_release_evidence_consumptions.consumed_at;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION forge.assert_epic_172_transition_authorization_live_v1(
  p_authorization_id uuid,
  p_operation_id text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_expires_at timestamptz;
  v_operation_id text;
BEGIN
  IF session_user <> 'forge_release_transition' THEN
    RAISE EXCEPTION 'Epic 172 authorization checks require the dedicated transition login'
      USING ERRCODE = '42501';
  END IF;
  SELECT expires_at, operation_id
  INTO STRICT v_expires_at, v_operation_id
  FROM public.forge_epic_172_transition_authorizations
  WHERE id = p_authorization_id
  FOR KEY SHARE;
  IF v_operation_id <> p_operation_id OR pg_catalog.clock_timestamp() >= v_expires_at THEN
    RAISE EXCEPTION 'Epic 172 transition authorization expired before the final transaction statement'
      USING ERRCODE = '22023';
  END IF;
END;
$$;
--> statement-breakpoint
ALTER FUNCTION forge.record_epic_172_release_evidence_v1(uuid,text,integer,text,jsonb,jsonb,text,bigint,jsonb,text,text,uuid,bigint,text,text,text,text,bytea,uuid,timestamptz,jsonb)
  OWNER TO forge_release_routines_owner;
ALTER FUNCTION forge.record_epic_172_transition_authorization_v1(uuid,text,text,jsonb,text,integer,text,jsonb,text,bigint,text,text,text,text,uuid,bigint,text,bytea,uuid,timestamptz,timestamptz,jsonb)
  OWNER TO forge_release_routines_owner;
ALTER FUNCTION forge.consume_epic_172_release_evidence_v1(uuid,uuid,text,text,text)
  OWNER TO forge_release_routines_owner;
ALTER FUNCTION forge.assert_epic_172_transition_authorization_live_v1(uuid,text)
  OWNER TO forge_release_routines_owner;
ALTER FUNCTION forge.install_epic_172_release_signer_v1(uuid,bigint,bytea,text,text,timestamptz,timestamptz,text,text)
  OWNER TO forge_release_routines_owner;
ALTER FUNCTION forge.activate_epic_172_release_signer_v1(uuid,uuid,bigint,text,text)
  OWNER TO forge_release_routines_owner;
ALTER FUNCTION forge.retire_epic_172_release_signer_v1(uuid,bigint,text,text)
  OWNER TO forge_release_routines_owner;
ALTER FUNCTION forge.read_epic_172_enablement_state_v1()
  OWNER TO forge_release_routines_owner;
ALTER FUNCTION forge.lock_epic_172_signer_for_verification_v1(uuid)
  OWNER TO forge_release_routines_owner;
ALTER FUNCTION forge.lock_epic_172_release_receipts_v1(uuid[])
  OWNER TO forge_release_routines_owner;
ALTER FUNCTION forge.lock_epic_172_transition_verification_v1(uuid[],uuid)
  OWNER TO forge_release_routines_owner;
ALTER FUNCTION forge.epic_172_controller_lease_digest_v1(bytea)
  OWNER TO forge_release_routines_owner;
ALTER FUNCTION forge.constant_time_equal_32_v1(bytea,bytea)
  OWNER TO forge_release_routines_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION forge.record_epic_172_release_evidence_v1(uuid,text,integer,text,jsonb,jsonb,text,bigint,jsonb,text,text,uuid,bigint,text,text,text,text,bytea,uuid,timestamptz,jsonb)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION forge.record_epic_172_transition_authorization_v1(uuid,text,text,jsonb,text,integer,text,jsonb,text,bigint,text,text,text,text,uuid,bigint,text,bytea,uuid,timestamptz,timestamptz,jsonb)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION forge.consume_epic_172_release_evidence_v1(uuid,uuid,text,text,text)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION forge.assert_epic_172_transition_authorization_live_v1(uuid,text)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION forge.install_epic_172_release_signer_v1(uuid,bigint,bytea,text,text,timestamptz,timestamptz,text,text)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION forge.activate_epic_172_release_signer_v1(uuid,uuid,bigint,text,text)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION forge.retire_epic_172_release_signer_v1(uuid,bigint,text,text)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION forge.read_epic_172_enablement_state_v1()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION forge.lock_epic_172_signer_for_verification_v1(uuid)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION forge.lock_epic_172_release_receipts_v1(uuid[])
  FROM PUBLIC;
REVOKE ALL ON FUNCTION forge.lock_epic_172_transition_verification_v1(uuid[],uuid)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION forge.epic_172_controller_lease_digest_v1(bytea)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION forge.constant_time_equal_32_v1(bytea,bytea)
  FROM PUBLIC;
--> statement-breakpoint
GRANT USAGE ON SCHEMA forge TO forge_release_evidence_writer, forge_release_transition;
GRANT EXECUTE ON FUNCTION forge.record_epic_172_release_evidence_v1(uuid,text,integer,text,jsonb,jsonb,text,bigint,jsonb,text,text,uuid,bigint,text,text,text,text,bytea,uuid,timestamptz,jsonb)
  TO forge_release_evidence_writer;
GRANT EXECUTE ON FUNCTION forge.record_epic_172_transition_authorization_v1(uuid,text,text,jsonb,text,integer,text,jsonb,text,bigint,text,text,text,text,uuid,bigint,text,bytea,uuid,timestamptz,timestamptz,jsonb)
  TO forge_release_evidence_writer;
GRANT EXECUTE ON FUNCTION forge.consume_epic_172_release_evidence_v1(uuid,uuid,text,text,text)
  TO forge_release_transition;
GRANT EXECUTE ON FUNCTION forge.assert_epic_172_transition_authorization_live_v1(uuid,text)
  TO forge_release_transition;
GRANT EXECUTE ON FUNCTION forge.install_epic_172_release_signer_v1(uuid,bigint,bytea,text,text,timestamptz,timestamptz,text,text)
  TO forge_release_evidence_writer;
GRANT EXECUTE ON FUNCTION forge.activate_epic_172_release_signer_v1(uuid,uuid,bigint,text,text)
  TO forge_release_evidence_writer;
GRANT EXECUTE ON FUNCTION forge.retire_epic_172_release_signer_v1(uuid,bigint,text,text)
  TO forge_release_evidence_writer;
GRANT EXECUTE ON FUNCTION forge.lock_epic_172_signer_for_verification_v1(uuid)
  TO forge_release_evidence_writer, forge_release_transition;
GRANT EXECUTE ON FUNCTION forge.lock_epic_172_release_receipts_v1(uuid[])
  TO forge_release_evidence_writer, forge_release_transition;
GRANT EXECUTE ON FUNCTION forge.lock_epic_172_transition_verification_v1(uuid[],uuid)
  TO forge_release_transition;
GRANT EXECUTE ON FUNCTION forge.epic_172_controller_lease_digest_v1(bytea)
  TO forge_release_transition;
--> statement-breakpoint
DO $$
DECLARE
  v_migration_role name := session_user;
BEGIN
  EXECUTE pg_catalog.format(
    'REVOKE ALL ON TABLE public.forge_release_signer_keys, public.forge_release_signer_key_lifecycle_audits, public.forge_epic_172_release_evidence, public.forge_epic_172_transition_authorizations, public.forge_epic_172_release_evidence_consumptions, public.forge_epic_172_enablement_state, public.forge_epic_172_enablement_transition_audits FROM %I',
    v_migration_role
  );
  EXECUTE pg_catalog.format(
    'REVOKE ALL ON ALL FUNCTIONS IN SCHEMA forge FROM %I',
    v_migration_role
  );
  EXECUTE pg_catalog.format('GRANT USAGE ON SCHEMA forge TO %I', v_migration_role);
  EXECUTE pg_catalog.format(
    'GRANT EXECUTE ON FUNCTION forge.read_epic_172_enablement_state_v1() TO %I',
    v_migration_role
  );
END;
$$;
--> statement-breakpoint
RESET ROLE;
--> statement-breakpoint
SELECT public.forge_finalize_epic_172_release_owner_bootstrap_v1();
