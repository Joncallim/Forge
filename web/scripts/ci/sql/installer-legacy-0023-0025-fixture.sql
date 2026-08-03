-- Builds the exact known pre-repair physical fingerprint in a disposable
-- database already migrated through 0026. Never run against an operator DB.

DROP FUNCTION forge.record_epic_172_release_evidence_v1(
  uuid,text,integer,text,jsonb,jsonb,text,bigint,jsonb,text,text,uuid,bigint,
  text,text,text,text,bytea,uuid,timestamptz,jsonb
);
DROP FUNCTION forge.install_epic_172_release_signer_v1(uuid,bigint,bytea,text,text,timestamptz,timestamptz,text,text);
DROP FUNCTION forge.activate_epic_172_release_signer_v1(uuid,uuid,bigint,text,text);
DROP FUNCTION forge.retire_epic_172_release_signer_v1(uuid,bigint,text,text);
DROP FUNCTION forge.lock_epic_172_transition_verification_v1(uuid[],uuid);
DROP FUNCTION forge.read_epic_172_enablement_state_v1();
DROP FUNCTION forge.epic_172_controller_lease_digest_v1(bytea);
DROP FUNCTION forge.constant_time_equal_32_v1(bytea,bytea);
DROP FUNCTION forge.lock_epic_172_signer_for_verification_v1(uuid);
DROP FUNCTION forge.lock_epic_172_release_receipts_v1(uuid[]);

ALTER TABLE public.forge_epic_172_release_evidence
  DROP CONSTRAINT forge_epic_172_release_evidence_required_evidence_chk,
  DROP CONSTRAINT forge_epic_172_release_evidence_sha_chk,
  DROP COLUMN required_evidence,
  ADD CONSTRAINT forge_epic_172_release_evidence_sha_chk
    CHECK (reviewed_sha ~ '^[0-9a-f]{40,64}$');

ALTER TABLE public.forge_epic_172_enablement_state
  DROP CONSTRAINT forge_epic_172_enablement_sha_chk,
  DROP CONSTRAINT forge_epic_172_enablement_token_chk,
  ALTER COLUMN controller_token_digest TYPE text
    USING CASE
      WHEN controller_token_digest IS NULL THEN NULL
      ELSE pg_catalog.encode(controller_token_digest, 'hex')
    END,
  ADD CONSTRAINT forge_epic_172_enablement_sha_chk
    CHECK (reviewed_sha IS NULL OR reviewed_sha ~ '^[0-9a-f]{40,64}$'),
  ADD CONSTRAINT forge_epic_172_enablement_token_chk
    CHECK (controller_token_digest IS NULL OR controller_token_digest ~ '^[0-9a-f]{64}$');

ALTER TABLE public.forge_epic_172_transition_authorizations
  DROP CONSTRAINT forge_epic_172_transition_authorizations_sha_chk,
  ADD CONSTRAINT forge_epic_172_transition_authorizations_sha_chk
    CHECK (reviewed_sha ~ '^[0-9a-f]{40,64}$');

ALTER TABLE public.forge_release_signer_keys
  ALTER COLUMN status SET DEFAULT 'active',
  DROP CONSTRAINT forge_release_signer_keys_status_chk,
  DROP CONSTRAINT forge_release_signer_keys_lifecycle_chk,
  ADD CONSTRAINT forge_release_signer_keys_status_chk
    CHECK (status IN ('active', 'retiring', 'retired')),
  ADD CONSTRAINT forge_release_signer_keys_lifecycle_chk CHECK (
    (status = 'active' AND retirement_started_at IS NULL AND retired_at IS NULL)
    OR (status = 'retiring' AND retirement_started_at IS NOT NULL AND retired_at IS NULL)
    OR (status = 'retired' AND retirement_started_at IS NOT NULL AND retired_at IS NOT NULL)
  );
ALTER TABLE public.forge_release_signer_key_lifecycle_audits
  DROP CONSTRAINT forge_release_signer_lifecycle_prior_status_chk,
  DROP CONSTRAINT forge_release_signer_lifecycle_new_status_chk,
  ADD CONSTRAINT forge_release_signer_lifecycle_prior_status_chk
    CHECK (prior_status IS NULL OR prior_status IN ('active', 'retiring', 'retired')),
  ADD CONSTRAINT forge_release_signer_lifecycle_new_status_chk
    CHECK (new_status IN ('active', 'retiring', 'retired'));

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles
    WHERE rolname = 'forge_release_evidence_consumer'
  ) THEN
    CREATE ROLE forge_release_evidence_consumer
      LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
END;
$$;
GRANT SELECT ON TABLE
  public.forge_release_signer_keys,
  public.forge_epic_172_release_evidence,
  public.forge_epic_172_transition_authorizations,
  public.forge_epic_172_release_evidence_consumptions
TO forge_release_evidence_consumer;


CREATE OR REPLACE FUNCTION forge.assert_epic_172_transition_authorization_live_v1(p_authorization_id uuid, p_operation_id text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION forge.consume_epic_172_release_evidence_v1(p_receipt_id uuid, p_authorization_id uuid, p_consumer_node text, p_transition_identity_digest text, p_operation_id text)
 RETURNS TABLE(consumption_id uuid, consumed_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
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
  IF p_consumer_node = 's3_issue_178' THEN
    RAISE EXCEPTION 's3_issue_178 requires the dedicated S3 completion transaction'
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
$function$;

CREATE OR REPLACE FUNCTION forge.record_epic_172_release_evidence_v1(p_receipt_id uuid, p_evidence_kind text, p_owner_issue integer, p_owner_slice text, p_exact_builds jsonb, p_reviewed_sha text, p_epoch bigint, p_predecessor_receipt_ids jsonb, p_predecessor_set_digest text, p_transition_identity_digest text, p_signer_key_id uuid, p_signer_generation bigint, p_github_app_id text, p_controller_run_id text, p_controller_job_id text, p_envelope_digest text, p_detached_signature bytea, p_nonce uuid, p_issued_at timestamp with time zone, p_envelope jsonb)
 RETURNS TABLE(receipt_id uuid, recorded_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_key public.forge_release_signer_keys%ROWTYPE;
  v_expected_kinds text[];
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
     OR pg_catalog.coalesce(v_actual_kinds, ARRAY[]::text[]) <> v_expected_kinds THEN
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
    id, manifest_version, evidence_kind, owner_issue, owner_slice, exact_builds,
    reviewed_sha, epoch, predecessor_receipt_ids, predecessor_set_digest,
    transition_identity_digest, signer_key_id, signer_generation, github_app_id,
    controller_run_id, controller_job_id, signature_domain, envelope_version,
    envelope_digest, detached_signature, nonce, issued_at, recorded_at, envelope
  ) VALUES (
    p_receipt_id, 1, p_evidence_kind, p_owner_issue, p_owner_slice, p_exact_builds,
    p_reviewed_sha, p_epoch, p_predecessor_receipt_ids, p_predecessor_set_digest,
    p_transition_identity_digest, p_signer_key_id, p_signer_generation, p_github_app_id,
    p_controller_run_id, p_controller_job_id, 'forge:epic-172-release-evidence:v1', 1,
    p_envelope_digest, p_detached_signature, p_nonce, p_issued_at, v_now, p_envelope
  )
  RETURNING id, forge_epic_172_release_evidence.recorded_at;
END;
$function$;

CREATE OR REPLACE FUNCTION forge.record_epic_172_transition_authorization_v1(p_authorization_id uuid, p_target_node text, p_transition_identity_digest text, p_source_receipt_ids jsonb, p_source_receipt_set_digest text, p_owner_issue integer, p_owner_slice text, p_exact_builds jsonb, p_reviewed_sha text, p_epoch bigint, p_operation_id text, p_operation text, p_controller_login_id text, p_controller_run_id text, p_signer_key_id uuid, p_signer_generation bigint, p_envelope_digest text, p_detached_signature bytea, p_nonce uuid, p_issued_at timestamp with time zone, p_expires_at timestamp with time zone, p_envelope jsonb)
 RETURNS TABLE(authorization_id uuid, recorded_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
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
     OR pg_catalog.coalesce(v_actual_kinds, ARRAY[]::text[]) <> v_expected_kinds THEN
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
$function$;


ALTER FUNCTION forge.record_epic_172_release_evidence_v1(uuid,text,integer,text,jsonb,text,bigint,jsonb,text,text,uuid,bigint,text,text,text,text,bytea,uuid,timestamptz,jsonb)
  OWNER TO forge_release_routines_owner;
ALTER FUNCTION forge.record_epic_172_transition_authorization_v1(uuid,text,text,jsonb,text,integer,text,jsonb,text,bigint,text,text,text,text,uuid,bigint,text,bytea,uuid,timestamptz,timestamptz,jsonb)
  OWNER TO forge_release_routines_owner;
ALTER FUNCTION forge.consume_epic_172_release_evidence_v1(uuid,uuid,text,text,text)
  OWNER TO forge_release_routines_owner;
ALTER FUNCTION forge.assert_epic_172_transition_authorization_live_v1(uuid,text)
  OWNER TO forge_release_routines_owner;

REVOKE ALL ON FUNCTION forge.record_epic_172_release_evidence_v1(uuid,text,integer,text,jsonb,text,bigint,jsonb,text,text,uuid,bigint,text,text,text,text,bytea,uuid,timestamptz,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION forge.record_epic_172_transition_authorization_v1(uuid,text,text,jsonb,text,integer,text,jsonb,text,bigint,text,text,text,text,uuid,bigint,text,bytea,uuid,timestamptz,timestamptz,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION forge.consume_epic_172_release_evidence_v1(uuid,uuid,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION forge.assert_epic_172_transition_authorization_live_v1(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION forge.record_epic_172_release_evidence_v1(uuid,text,integer,text,jsonb,text,bigint,jsonb,text,text,uuid,bigint,text,text,text,text,bytea,uuid,timestamptz,jsonb) TO forge_release_evidence_writer;
GRANT EXECUTE ON FUNCTION forge.record_epic_172_transition_authorization_v1(uuid,text,text,jsonb,text,integer,text,jsonb,text,bigint,text,text,text,text,uuid,bigint,text,bytea,uuid,timestamptz,timestamptz,jsonb) TO forge_release_evidence_writer;
GRANT EXECUTE ON FUNCTION forge.consume_epic_172_release_evidence_v1(uuid,uuid,text,text,text) TO forge_release_transition;
GRANT EXECUTE ON FUNCTION forge.assert_epic_172_transition_authorization_live_v1(uuid,text) TO forge_release_transition;

-- The fixture is applied by the disposable database administrator, whereas
-- the real legacy database had already completed the temporary migration
-- handoff. Derive the ordinary migration login from the Drizzle schema owner
-- and remove only its current-era direct Forge-schema/routine grants.
DO $fixture_acl_cleanup$
DECLARE
  v_migration_login name;
BEGIN
  SELECT owner_role.rolname INTO v_migration_login
  FROM pg_catalog.pg_namespace namespace_row
  JOIN pg_catalog.pg_roles owner_role ON owner_role.oid = namespace_row.nspowner
  WHERE namespace_row.nspname = 'drizzle';
  IF v_migration_login IS NULL OR v_migration_login IN (
    'forge_release_evidence_writer', 'forge_release_transition', 'forge_release_routines_owner'
  ) THEN
    RAISE EXCEPTION 'Fixture cannot identify an ordinary disposable migration login';
  END IF;
  EXECUTE pg_catalog.format('REVOKE ALL ON SCHEMA forge FROM %I', v_migration_login);
  EXECUTE pg_catalog.format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA forge FROM %I', v_migration_login);
END;
$fixture_acl_cleanup$;

UPDATE drizzle.__drizzle_migrations
SET hash = CASE created_at
  WHEN 1784258966103 THEN 'bf855fc0d4f110864badedf287c987adbe7913059b3673d385c81b1dbc2d9d31'
  WHEN 1784263200000 THEN '46d68b45f7c0a61d247f7f87770e25b029f9b4bc4ebb904cf33bf57400963d04'
END
WHERE created_at IN (1784258966103, 1784263200000);
