\set ON_ERROR_STOP on

-- Exercise recovery against the real PostgreSQL routines without activating a
-- disposable database. The test-only authority override and all fixtures are
-- rolled back together, restoring the installed predicate byte-for-byte.
BEGIN;
CREATE OR REPLACE FUNCTION forge.s4_protected_paths_enabled_v1()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog AS $$ SELECT true $$;
ALTER FUNCTION forge.s4_protected_paths_enabled_v1() OWNER TO forge_s4_routines_owner;

UPDATE public.projects
SET root_binding_revision = 1, grant_decision_revision = 1
WHERE id = '27000000-0000-4000-8000-000000000010';
INSERT INTO public.project_filesystem_grant_decisions (
  id, project_id, decision, capabilities, grant_decision_revision,
  root_binding_revision, decision_fingerprint, decision_generation,
  decided_by, decided_at
) VALUES (
  '27000000-0000-4000-8000-00000000d501',
  '27000000-0000-4000-8000-000000000010', 'approved',
  '["filesystem.project.read"]'::jsonb, 1, 1,
  'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  1, '27000000-0000-4000-8000-000000000001',
  '2026-07-22T00:00:00.000Z'::timestamptz
);
UPDATE public.project_filesystem_current_decision_pointers
SET current_decision_id = '27000000-0000-4000-8000-00000000d501',
    current_decision_project_id = project_id,
    current_decision_revision = 1,
    current_root_binding_revision = 1,
    current_decision_fingerprint =
      'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    current_decision_generation = 1,
    pointer_generation = 1
WHERE project_id = '27000000-0000-4000-8000-000000000010';

INSERT INTO public.tasks (id, project_id, submitted_by, title, prompt, status)
VALUES (
  '27000000-0000-4000-8000-00000000d001',
  '27000000-0000-4000-8000-000000000010',
  '27000000-0000-4000-8000-000000000001',
  'Packet recovery proof', 'recovery proof', 'approved'
);
INSERT INTO public.work_packages (
  id, task_id, assigned_role, title, summary, status, sequence
) VALUES
  ('27000000-0000-4000-8000-00000000d101',
   '27000000-0000-4000-8000-00000000d001', 'backend',
   'Recovery target', 'recovery proof', 'blocked', 1),
  ('27000000-0000-4000-8000-00000000d102',
   '27000000-0000-4000-8000-00000000d001', 'qa',
   'Recovery sibling', 'recovery proof', 'pending', 2);
INSERT INTO public.agent_runs (
  id, task_id, work_package_id, agent_type, model_id_used, status,
  stage, attempt_number, started_at, completed_at, error_message
) VALUES
  ('27000000-0000-4000-8000-00000000d201',
   '27000000-0000-4000-8000-00000000d001',
   '27000000-0000-4000-8000-00000000d101', 'backend', 'proof-model',
   'failed', 'implementation', 1, pg_catalog.clock_timestamp() - interval '3 minutes',
   pg_catalog.clock_timestamp() - interval '1 minute', 'recovered failure'),
  ('27000000-0000-4000-8000-00000000d202',
   '27000000-0000-4000-8000-00000000d001',
   '27000000-0000-4000-8000-00000000d102', 'qa', 'proof-model',
   'running', 'qa', 1, pg_catalog.clock_timestamp(), NULL, NULL);
INSERT INTO public.work_package_local_run_evidence (
  id, task_id, work_package_id, agent_run_id, claim_token,
  claim_generation, last_heartbeat_at, lease_expires_at, state,
  terminal, terminal_at
) VALUES (
  '27000000-0000-4000-8000-00000000d301',
  '27000000-0000-4000-8000-00000000d001',
  '27000000-0000-4000-8000-00000000d101',
  '27000000-0000-4000-8000-00000000d201',
  '27000000-0000-4000-8000-00000000d311', 1,
  pg_catalog.clock_timestamp() - interval '3 minutes',
  pg_catalog.clock_timestamp() - interval '2 minutes', 'uncertain',
  '{"status":"failed","failureCode":"execution_lease_expired"}'::jsonb,
  pg_catalog.clock_timestamp() - interval '2 minutes'
);

ALTER TABLE public.filesystem_mcp_runtime_audits DISABLE TRIGGER
  filesystem_mcp_runtime_audits_protocol_v2_guard;
INSERT INTO public.filesystem_mcp_runtime_audits (
  id, task_id, work_package_id, agent_run_id, operation, status,
  capabilities, requested_capabilities, protocol_version,
  local_run_evidence_id, claim_token, claim_generation,
  last_heartbeat_at, lease_expires_at, authorization_snapshot,
  authorization_source, grant_mode, grant_decision_revision,
  authorization_root_binding_revision, project_decision_id,
  assembly, delivery, terminal, terminal_at
) VALUES (
  '27000000-0000-4000-8000-00000000d401',
  '27000000-0000-4000-8000-00000000d001',
  '27000000-0000-4000-8000-00000000d101',
  '27000000-0000-4000-8000-00000000d201', 'context_packet', 'failed',
  '["filesystem.project.read"]'::jsonb,
  '["filesystem.project.read"]'::jsonb, 2,
  '27000000-0000-4000-8000-00000000d301',
  '27000000-0000-4000-8000-00000000d312', 1,
  pg_catalog.clock_timestamp() - interval '3 minutes',
  pg_catalog.clock_timestamp() - interval '2 minutes',
  pg_catalog.jsonb_build_object(
    'schemaVersion', 2, 'source', 'project_always_allow',
    'grantMode', 'always_allow', 'grantApprovalId', NULL,
    'grantDecisionRevision', '1', 'grantDecisionNonce', NULL,
    'rootBindingRevision', '1',
    'approvedCapabilities', '["filesystem.project.read"]'::jsonb,
    'requiredCapabilities', '["filesystem.project.read"]'::jsonb,
    'decidedByUserId', '27000000-0000-4000-8000-000000000001',
    'decidedAt', '2026-07-22T00:00:00.000Z',
    'coverageFingerprint',
      'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  ), 'project_always_allow', 'always_allow', 1, 1,
  '27000000-0000-4000-8000-00000000d501',
  '{"state":"not_assembled","failureStage":"claim"}'::jsonb,
  '{"state":"not_exposed"}'::jsonb,
  '{"status":"failed","failureCode":"execution_lease_expired"}'::jsonb,
  pg_catalog.clock_timestamp() - interval '2 minutes'
);
ALTER TABLE public.filesystem_mcp_runtime_audits ENABLE TRIGGER
  filesystem_mcp_runtime_audits_protocol_v2_guard;

DO $seed_recovery_marker$
DECLARE
  v_marker jsonb;
BEGIN
  v_marker := pg_catalog.jsonb_build_object(
    'schemaVersion', 2, 'kind', 'packet_issuance',
    'priorAgentRunId', '27000000-0000-4000-8000-00000000d201',
    'priorRuntimeAuditId', '27000000-0000-4000-8000-00000000d401',
    'recoveryFailure',
      '{"status":"failed","failureCode":"execution_lease_expired"}'::jsonb,
    'deliveryState', 'not_exposed', 'grantMode', 'always_allow',
    'disposition', 'retry_execution', 'acknowledgedAt', NULL,
    'acknowledgedByUserId', NULL,
    'combinedRepositoryReviewFingerprint',
      'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    'policyFingerprint', 'sha256:' || pg_catalog.encode(pg_catalog.sha256(
      pg_catalog.convert_to(
        'forge:packet-policy:v2:' ||
        '["filesystem.project.read"]'::jsonb::text, 'UTF8'
      )
    ), 'hex'),
    'coverageFingerprint',
      'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'autoRetryable', false
  );
  v_marker := pg_catalog.jsonb_set(
    v_marker, '{markerFingerprint}',
    pg_catalog.to_jsonb(forge.packet_recovery_marker_fingerprint_v2(v_marker)), true
  );
  UPDATE public.work_packages package
  SET metadata = pg_catalog.jsonb_set(
    package.metadata, '{packet_issuance}', v_marker, true
  )
  WHERE package.id = '27000000-0000-4000-8000-00000000d101';
  PERFORM pg_catalog.set_config(
    'forge.proof.packet_marker_fingerprint', v_marker->>'markerFingerprint', false
  );
END;
$seed_recovery_marker$;

-- Keep the exact canonical packet marker.  The following matrix restores this
-- value between transitions so every action is exercised against real locked
-- PostgreSQL rows, rather than chaining a test-only projection.
CREATE TEMP TABLE forge_proof_saved_packet_marker ON COMMIT DROP AS
SELECT metadata->'packet_issuance' AS marker
FROM public.work_packages
WHERE id = '27000000-0000-4000-8000-00000000d101';
GRANT SELECT ON TABLE forge_proof_saved_packet_marker TO forge_s4_recovery_operator;

CREATE FUNCTION public.forge_proof_expect_packet_retry_rejected_v1()
RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog, forge AS $$
BEGIN
  BEGIN
    PERFORM 1 FROM forge.apply_packet_issuance_recovery_action_v2(
      '27000000-0000-4000-8000-00000000d001',
      '27000000-0000-4000-8000-00000000d101',
      '27000000-0000-4000-8000-00000000d401', 'retry_execution',
      pg_catalog.current_setting('forge.proof.packet_marker_fingerprint'),
      '27000000-0000-4000-8000-000000000001',
      '27000000-0000-4000-8000-00000000d501'
    );
  EXCEPTION WHEN serialization_failure OR SQLSTATE 'P1726' THEN
    RETURN;
  END;
  RAISE EXCEPTION 'Packet retry unexpectedly passed a rejection fixture';
END;
$$;
GRANT EXECUTE ON FUNCTION public.forge_proof_expect_packet_retry_rejected_v1()
  TO forge_s4_recovery_operator;

-- Non-approved task states are all rejected by the explicit FOUND check.
UPDATE public.tasks SET status = 'running'
WHERE id = '27000000-0000-4000-8000-00000000d001';
SET SESSION AUTHORIZATION forge_s4_recovery_operator;
SELECT public.forge_proof_expect_packet_retry_rejected_v1();
RESET SESSION AUTHORIZATION;
UPDATE public.tasks SET status = 'failed'
WHERE id = '27000000-0000-4000-8000-00000000d001';
SET SESSION AUTHORIZATION forge_s4_recovery_operator;
SELECT public.forge_proof_expect_packet_retry_rejected_v1();
RESET SESSION AUTHORIZATION;
UPDATE public.tasks SET status = 'cancelled'
WHERE id = '27000000-0000-4000-8000-00000000d001';
SET SESSION AUTHORIZATION forge_s4_recovery_operator;
SELECT public.forge_proof_expect_packet_retry_rejected_v1();
RESET SESSION AUTHORIZATION;
UPDATE public.tasks SET status = 'approved'
WHERE id = '27000000-0000-4000-8000-00000000d001';

-- Sibling review, execution lease, local lease, packet lease, integrity hold,
-- and invalid projection are independently rejected.
UPDATE public.work_packages SET status = 'awaiting_review'
WHERE id = '27000000-0000-4000-8000-00000000d102';
SET SESSION AUTHORIZATION forge_s4_recovery_operator;
SELECT public.forge_proof_expect_packet_retry_rejected_v1();
RESET SESSION AUTHORIZATION;
UPDATE public.work_packages SET status = 'pending', metadata = pg_catalog.jsonb_build_object(
  'executionLease', pg_catalog.jsonb_build_object(
    'runId', '27000000-0000-4000-8000-00000000d202',
    'source', 'work-package-handoff', 'attemptNumber', 1,
    'acquiredAt', pg_catalog.to_char(pg_catalog.clock_timestamp() AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'heartbeatAt', pg_catalog.to_char(pg_catalog.clock_timestamp() AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'staleAfterSeconds', 60
  )
) WHERE id = '27000000-0000-4000-8000-00000000d102';
SET SESSION AUTHORIZATION forge_s4_recovery_operator;
SELECT public.forge_proof_expect_packet_retry_rejected_v1();
RESET SESSION AUTHORIZATION;
UPDATE public.work_packages SET metadata = '{}'::jsonb
WHERE id = '27000000-0000-4000-8000-00000000d102';

INSERT INTO public.work_package_local_run_evidence (
  id, task_id, work_package_id, agent_run_id, claim_token,
  claim_generation, last_heartbeat_at, lease_expires_at, state
) VALUES (
  '27000000-0000-4000-8000-00000000d302',
  '27000000-0000-4000-8000-00000000d001',
  '27000000-0000-4000-8000-00000000d102',
  '27000000-0000-4000-8000-00000000d202',
  '27000000-0000-4000-8000-00000000d313', 1,
  pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp() + interval '1 minute',
  'claimed'
);
SET SESSION AUTHORIZATION forge_s4_recovery_operator;
SELECT public.forge_proof_expect_packet_retry_rejected_v1();
RESET SESSION AUTHORIZATION;
UPDATE public.work_package_local_run_evidence
SET state = 'terminal', terminal = '{"status":"failed"}'::jsonb,
    terminal_at = pg_catalog.clock_timestamp()
WHERE id = '27000000-0000-4000-8000-00000000d302';

ALTER TABLE public.filesystem_mcp_runtime_audits DISABLE TRIGGER
  filesystem_mcp_runtime_audits_protocol_v2_guard;
INSERT INTO public.filesystem_mcp_runtime_audits (
  id, task_id, work_package_id, agent_run_id, operation, status,
  capabilities, requested_capabilities, protocol_version,
  local_run_evidence_id, claim_token, claim_generation,
  last_heartbeat_at, lease_expires_at, authorization_snapshot,
  authorization_source, grant_mode, grant_decision_revision,
  authorization_root_binding_revision, project_decision_id,
  assembly, delivery
)
SELECT
  '27000000-0000-4000-8000-00000000d402', audit.task_id,
  '27000000-0000-4000-8000-00000000d102',
  '27000000-0000-4000-8000-00000000d202', audit.operation, 'claiming',
  audit.capabilities, audit.requested_capabilities, audit.protocol_version,
  '27000000-0000-4000-8000-00000000d302',
  '27000000-0000-4000-8000-00000000d314', 1,
  pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp() + interval '1 minute',
  audit.authorization_snapshot, audit.authorization_source, audit.grant_mode,
  audit.grant_decision_revision, audit.authorization_root_binding_revision,
  audit.project_decision_id, NULL, NULL
FROM public.filesystem_mcp_runtime_audits audit
WHERE audit.id = '27000000-0000-4000-8000-00000000d401';
ALTER TABLE public.filesystem_mcp_runtime_audits ENABLE TRIGGER
  filesystem_mcp_runtime_audits_protocol_v2_guard;
SET SESSION AUTHORIZATION forge_s4_recovery_operator;
SELECT public.forge_proof_expect_packet_retry_rejected_v1();
RESET SESSION AUTHORIZATION;
DELETE FROM public.filesystem_mcp_runtime_audits
WHERE id = '27000000-0000-4000-8000-00000000d402';

UPDATE public.work_packages SET metadata = '{"packet_integrity_hold":{}}'::jsonb
WHERE id = '27000000-0000-4000-8000-00000000d102';
SET SESSION AUTHORIZATION forge_s4_recovery_operator;
SELECT public.forge_proof_expect_packet_retry_rejected_v1();
RESET SESSION AUTHORIZATION;
UPDATE public.work_packages SET metadata = '{}'::jsonb
WHERE id = '27000000-0000-4000-8000-00000000d102';
UPDATE public.tasks SET local_projection_overlimit_package_count = 257
WHERE id = '27000000-0000-4000-8000-00000000d001';
SET SESSION AUTHORIZATION forge_s4_recovery_operator;
SELECT public.forge_proof_expect_packet_retry_rejected_v1();
RESET SESSION AUTHORIZATION;
UPDATE public.tasks SET local_projection_overlimit_package_count = NULL
WHERE id = '27000000-0000-4000-8000-00000000d001';

-- Equal-revision package denial wins over project coverage.
INSERT INTO public.filesystem_mcp_grant_approvals (
  id, project_id, task_id, work_package_id, decided_by, decision,
  capabilities, decision_scope, grant_decision_revision,
  root_binding_revision, pointer_fingerprint
) VALUES (
  '27000000-0000-4000-8000-00000000d601',
  '27000000-0000-4000-8000-000000000010',
  '27000000-0000-4000-8000-00000000d001',
  '27000000-0000-4000-8000-00000000d101',
  '27000000-0000-4000-8000-000000000001', 'denied', '[]'::jsonb,
  'package', 1, 1,
  'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'
);
UPDATE public.filesystem_mcp_current_decision_pointers
SET current_decision_id = '27000000-0000-4000-8000-00000000d601',
    current_decision_task_id = task_id,
    current_decision_work_package_id = work_package_id,
    current_decision_revision = 1,
    current_decision_fingerprint =
      'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
    pointer_fingerprint =
      'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
    pointer_version = 1
WHERE work_package_id = '27000000-0000-4000-8000-00000000d101';
SET SESSION AUTHORIZATION forge_s4_recovery_operator;
SELECT public.forge_proof_expect_packet_retry_rejected_v1();
RESET SESSION AUTHORIZATION;
UPDATE public.filesystem_mcp_current_decision_pointers
SET current_decision_id = NULL, current_decision_task_id = NULL,
    current_decision_work_package_id = NULL, current_decision_revision = NULL,
    current_decision_fingerprint = NULL,
    pointer_fingerprint = 'empty:' || work_package_id::text, pointer_version = 0
WHERE work_package_id = '27000000-0000-4000-8000-00000000d101';

DO $recovery_rejection_zero_mutation$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.filesystem_mcp_issuance_recovery_actions
    WHERE prior_runtime_audit_id = '27000000-0000-4000-8000-00000000d401'
  ) OR NOT EXISTS (
    SELECT 1 FROM public.work_packages package
    WHERE package.id = '27000000-0000-4000-8000-00000000d101'
      AND package.status = 'blocked' AND package.metadata ? 'packet_issuance'
  ) THEN
    RAISE EXCEPTION 'A rejected packet recovery action mutated durable state';
  END IF;
END;
$recovery_rejection_zero_mutation$;

SET SESSION AUTHORIZATION forge_s4_recovery_operator;
SELECT result, package_status
FROM forge.apply_packet_issuance_recovery_action_v2(
  '27000000-0000-4000-8000-00000000d001',
  '27000000-0000-4000-8000-00000000d101',
  '27000000-0000-4000-8000-00000000d401', 'retry_execution',
  pg_catalog.current_setting('forge.proof.packet_marker_fingerprint'),
  '27000000-0000-4000-8000-000000000001',
  '27000000-0000-4000-8000-00000000d501'
);
-- Exact ledger-first replay succeeds after the marker was cleared.
SELECT result, package_status
FROM forge.apply_packet_issuance_recovery_action_v2(
  '27000000-0000-4000-8000-00000000d001',
  '27000000-0000-4000-8000-00000000d101',
  '27000000-0000-4000-8000-00000000d401', 'retry_execution',
  pg_catalog.current_setting('forge.proof.packet_marker_fingerprint'),
  '27000000-0000-4000-8000-000000000001',
  '27000000-0000-4000-8000-00000000d501'
);
RESET SESSION AUTHORIZATION;

DO $recovery_success_assertions$
BEGIN
  IF (SELECT pg_catalog.count(*)
      FROM public.filesystem_mcp_issuance_recovery_actions action
      WHERE action.prior_runtime_audit_id = '27000000-0000-4000-8000-00000000d401'
        AND action.action = 'retry_execution'
        AND action.authorizing_decision_id IS NULL
        AND action.authorizing_project_decision_id =
          '27000000-0000-4000-8000-00000000d501') <> 1
     OR NOT EXISTS (
       SELECT 1 FROM public.work_packages package
       WHERE package.id = '27000000-0000-4000-8000-00000000d101'
         AND package.status = 'ready'
         AND NOT package.metadata ? 'packet_issuance'
     ) THEN
    RAISE EXCEPTION 'Packet retry did not retain its exact project decision binding';
  END IF;
END;
$recovery_success_assertions$;

-- Packet secondary-action matrix. Acknowledge is only valid for review
-- dispositions, then its exact new marker permits decline. Both actions are
-- ledger-first replayable and retain no project authority binding.
WITH next_marker AS (
  SELECT marker || '{"disposition":"review_submission"}'::jsonb AS marker
  FROM forge_proof_saved_packet_marker
)
UPDATE public.work_packages package
SET status = 'blocked', metadata = pg_catalog.jsonb_set(
  package.metadata, '{packet_issuance}',
  pg_catalog.jsonb_set(next_marker.marker, '{markerFingerprint}',
    pg_catalog.to_jsonb(forge.packet_recovery_marker_fingerprint_v2(
      next_marker.marker - 'markerFingerprint'
    )), true
  ), true
)
FROM next_marker
WHERE package.id = '27000000-0000-4000-8000-00000000d101';
SELECT metadata->'packet_issuance'->>'markerFingerprint' AS fingerprint
FROM public.work_packages WHERE id = '27000000-0000-4000-8000-00000000d101'
\gset packet_ack_
SET SESSION AUTHORIZATION forge_s4_recovery_operator;
SELECT result, result_marker_fingerprint, package_status
FROM forge.apply_packet_issuance_recovery_action_v2(
  '27000000-0000-4000-8000-00000000d001', '27000000-0000-4000-8000-00000000d101',
  '27000000-0000-4000-8000-00000000d401', 'acknowledge_possible_submission',
  :'packet_ack_fingerprint', '27000000-0000-4000-8000-000000000001', NULL
);
-- Exact action replay returns the retained result after the mutable marker moved.
SELECT result, result_marker_fingerprint, package_status
FROM forge.apply_packet_issuance_recovery_action_v2(
  '27000000-0000-4000-8000-00000000d001', '27000000-0000-4000-8000-00000000d101',
  '27000000-0000-4000-8000-00000000d401', 'acknowledge_possible_submission',
  :'packet_ack_fingerprint', '27000000-0000-4000-8000-000000000001', NULL
);
-- The recovery login has no direct mutable projection read. Inspect the
-- returned action above under that boundary, then capture the next CAS token
-- under the admin fixture context.
RESET SESSION AUTHORIZATION;
SELECT metadata->'packet_issuance'->>'markerFingerprint' AS fingerprint
FROM public.work_packages WHERE id = '27000000-0000-4000-8000-00000000d101'
\gset packet_decline_
SET SESSION AUTHORIZATION forge_s4_recovery_operator;
SELECT result, package_status
FROM forge.apply_packet_issuance_recovery_action_v2(
  '27000000-0000-4000-8000-00000000d001', '27000000-0000-4000-8000-00000000d101',
  '27000000-0000-4000-8000-00000000d401', 'decline_packet_recovery',
  :'packet_decline_fingerprint', '27000000-0000-4000-8000-000000000001', NULL
);
SELECT result, package_status
FROM forge.apply_packet_issuance_recovery_action_v2(
  '27000000-0000-4000-8000-00000000d001', '27000000-0000-4000-8000-00000000d101',
  '27000000-0000-4000-8000-00000000d401', 'decline_packet_recovery',
  :'packet_decline_fingerprint', '27000000-0000-4000-8000-000000000001', NULL
);
RESET SESSION AUTHORIZATION;
DO $packet_secondary_action_assertions$
BEGIN
  IF (SELECT count(*) FROM public.filesystem_mcp_issuance_recovery_actions
      WHERE prior_runtime_audit_id = '27000000-0000-4000-8000-00000000d401'
        AND action = 'acknowledge_possible_submission') <> 1
     OR (SELECT count(*) FROM public.filesystem_mcp_issuance_recovery_actions
         WHERE prior_runtime_audit_id = '27000000-0000-4000-8000-00000000d401'
           AND action = 'decline_packet_recovery') <> 1
     OR EXISTS (SELECT 1 FROM public.filesystem_mcp_issuance_recovery_actions
                WHERE prior_runtime_audit_id = '27000000-0000-4000-8000-00000000d401'
                  AND action IN ('acknowledge_possible_submission','decline_packet_recovery')
                  AND (authorizing_decision_id IS NOT NULL OR authorizing_project_decision_id IS NOT NULL))
     OR (SELECT status FROM public.work_packages WHERE id = '27000000-0000-4000-8000-00000000d101') <> 'cancelled'
     OR (SELECT metadata ? 'packet_issuance' FROM public.work_packages
         WHERE id = '27000000-0000-4000-8000-00000000d101') THEN
    RAISE EXCEPTION 'Packet acknowledge/decline matrix did not retain exact ledger, authority, marker, or status semantics';
  END IF;
END;
$packet_secondary_action_assertions$;

-- Every wrong pairing and stale token is rejected before it can append a
-- ledger row or alter the canonical package projection.
WITH next_marker AS (
  SELECT marker || '{"disposition":"retry_execution"}'::jsonb AS marker
  FROM forge_proof_saved_packet_marker
)
UPDATE public.work_packages package
SET status = 'blocked', metadata = pg_catalog.jsonb_set(package.metadata, '{packet_issuance}',
  pg_catalog.jsonb_set(next_marker.marker, '{markerFingerprint}',
    pg_catalog.to_jsonb(forge.packet_recovery_marker_fingerprint_v2(
      next_marker.marker - 'markerFingerprint'
    )), true
  ), true
)
FROM next_marker
WHERE package.id = '27000000-0000-4000-8000-00000000d101';
-- Exhaustively execute the persisted packet disposition/action cartesian
-- product under the actual recovery login. Each case receives a distinct,
-- canonically fingerprinted marker; allowed actions must replay exactly, while
-- every disallowed pairing must leave the ledger and package untouched.
CREATE FUNCTION public.forge_proof_packet_action_matrix_v1()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, forge AS $$
DECLARE
  v_base jsonb;
  v_marker jsonb;
  v_disposition text;
  v_action text;
  v_allowed boolean;
  v_fingerprint text;
  v_before_actions integer;
  v_before_metadata jsonb;
  v_before_status text;
  v_first record;
  v_second record;
  v_after_metadata jsonb;
  v_after_status text;
  v_authorizer uuid;
BEGIN
  SELECT metadata->'packet_issuance' INTO STRICT v_base
  FROM public.work_packages WHERE id = '27000000-0000-4000-8000-00000000d101';
  FOREACH v_disposition IN ARRAY ARRAY[
    'review_local_changes','reapprove_allow_once','review_then_reapprove_allow_once',
    'retry_execution','review_submission','reviewed_submission'
  ] LOOP
    FOREACH v_action IN ARRAY ARRAY[
      'acknowledge_possible_submission','retry_execution','decline_packet_recovery'
    ] LOOP
      v_marker := v_base || pg_catalog.jsonb_build_object(
        'disposition', v_disposition, 'matrixCase', v_disposition || ':' || v_action
      );
      v_marker := pg_catalog.jsonb_set(v_marker, '{markerFingerprint}',
        pg_catalog.to_jsonb(forge.packet_recovery_marker_fingerprint_v2(v_marker - 'markerFingerprint')), true);
      UPDATE public.work_packages SET status = 'blocked',
        metadata = pg_catalog.jsonb_set(metadata, '{packet_issuance}', v_marker, true)
      WHERE id = '27000000-0000-4000-8000-00000000d101';
      v_fingerprint := v_marker->>'markerFingerprint';
      v_authorizer := CASE WHEN v_action = 'retry_execution'
        THEN '27000000-0000-4000-8000-00000000d501'::uuid ELSE NULL END;
      v_allowed := (v_action = 'acknowledge_possible_submission'
          AND v_disposition IN ('review_then_reapprove_allow_once','review_submission'))
        OR (v_action = 'retry_execution'
          AND v_disposition IN ('retry_execution','reviewed_submission'))
        OR (v_action = 'decline_packet_recovery'
          AND v_disposition IN ('reapprove_allow_once','review_then_reapprove_allow_once',
            'retry_execution','review_submission','reviewed_submission'));
      SELECT count(*)::integer, metadata, status INTO v_before_actions, v_before_metadata, v_before_status
      FROM public.filesystem_mcp_issuance_recovery_actions action
      CROSS JOIN public.work_packages package
      WHERE action.prior_runtime_audit_id = '27000000-0000-4000-8000-00000000d401'
        AND package.id = '27000000-0000-4000-8000-00000000d101'
      GROUP BY package.metadata, package.status;
      BEGIN
        SELECT * INTO v_first FROM forge.apply_packet_issuance_recovery_action_v2(
          '27000000-0000-4000-8000-00000000d001', '27000000-0000-4000-8000-00000000d101',
          '27000000-0000-4000-8000-00000000d401', v_action, v_fingerprint,
          '27000000-0000-4000-8000-000000000001', v_authorizer
        );
        IF NOT v_allowed THEN RAISE EXCEPTION 'disallowed packet matrix pair passed: %/%', v_disposition, v_action; END IF;
        SELECT metadata, status INTO v_after_metadata, v_after_status
        FROM public.work_packages WHERE id = '27000000-0000-4000-8000-00000000d101';
        IF (SELECT count(*) FROM public.filesystem_mcp_issuance_recovery_actions
            WHERE prior_runtime_audit_id = '27000000-0000-4000-8000-00000000d401') <> v_before_actions + 1
           OR v_first.result IS DISTINCT FROM CASE v_action WHEN 'acknowledge_possible_submission' THEN 'acknowledged'
             WHEN 'retry_execution' THEN 'ready' ELSE 'cancelled' END
           OR v_first.package_status IS DISTINCT FROM CASE v_action WHEN 'acknowledge_possible_submission' THEN 'blocked'
             WHEN 'retry_execution' THEN 'ready' ELSE 'cancelled' END
           OR v_after_status IS DISTINCT FROM v_first.package_status
           OR (v_action = 'acknowledge_possible_submission' AND (
             NOT v_after_metadata ? 'packet_issuance'
             OR v_after_metadata->'packet_issuance'->>'markerFingerprint' IS DISTINCT FROM v_first.result_marker_fingerprint
             OR forge.packet_recovery_marker_fingerprint_v2((v_after_metadata->'packet_issuance') - 'markerFingerprint')
                IS DISTINCT FROM v_first.result_marker_fingerprint))
           OR (v_action <> 'acknowledge_possible_submission' AND v_after_metadata ? 'packet_issuance') THEN
          RAISE EXCEPTION 'allowed packet matrix pair did not append its exact canonical transition: %/%', v_disposition, v_action;
        END IF;
        SELECT * INTO v_second FROM forge.apply_packet_issuance_recovery_action_v2(
          '27000000-0000-4000-8000-00000000d001', '27000000-0000-4000-8000-00000000d101',
          '27000000-0000-4000-8000-00000000d401', v_action, v_fingerprint,
          '27000000-0000-4000-8000-000000000001', v_authorizer
        );
        IF v_second.action_id IS DISTINCT FROM v_first.action_id
           OR v_second.result IS DISTINCT FROM v_first.result
           OR v_second.result_marker_fingerprint IS DISTINCT FROM v_first.result_marker_fingerprint
           OR v_second.package_status IS DISTINCT FROM v_first.package_status
           OR (SELECT count(*) FROM public.filesystem_mcp_issuance_recovery_actions
               WHERE prior_runtime_audit_id = '27000000-0000-4000-8000-00000000d401') <> v_before_actions + 1
           OR (SELECT metadata FROM public.work_packages WHERE id = '27000000-0000-4000-8000-00000000d101') IS DISTINCT FROM v_after_metadata
           OR (SELECT status FROM public.work_packages WHERE id = '27000000-0000-4000-8000-00000000d101') IS DISTINCT FROM v_after_status THEN
          RAISE EXCEPTION 'packet matrix replay was not ledger-first and byte-stable: %/%', v_disposition, v_action;
        END IF;
      EXCEPTION WHEN serialization_failure OR SQLSTATE 'P1726' OR invalid_parameter_value THEN
        IF v_allowed THEN RAISE; END IF;
      END;
      IF NOT v_allowed AND (
        (SELECT count(*) FROM public.filesystem_mcp_issuance_recovery_actions
         WHERE prior_runtime_audit_id = '27000000-0000-4000-8000-00000000d401') <> v_before_actions
        OR (SELECT metadata FROM public.work_packages WHERE id = '27000000-0000-4000-8000-00000000d101') IS DISTINCT FROM v_before_metadata
        OR (SELECT status FROM public.work_packages WHERE id = '27000000-0000-4000-8000-00000000d101') IS DISTINCT FROM v_before_status
      ) THEN RAISE EXCEPTION 'rejected packet matrix pair mutated state: %/%', v_disposition, v_action; END IF;
    END LOOP;
  END LOOP;
  UPDATE public.work_packages SET status = 'blocked',
    metadata = pg_catalog.jsonb_set(metadata, '{packet_issuance}', v_base, true)
  WHERE id = '27000000-0000-4000-8000-00000000d101';
END;
$$;
ALTER FUNCTION public.forge_proof_packet_action_matrix_v1() OWNER TO forge_s4_routines_owner;
GRANT EXECUTE ON FUNCTION public.forge_proof_packet_action_matrix_v1() TO forge_s4_recovery_operator;
SET SESSION AUTHORIZATION forge_s4_recovery_operator;
SELECT public.forge_proof_packet_action_matrix_v1();
RESET SESSION AUTHORIZATION;
REVOKE EXECUTE ON FUNCTION public.forge_proof_packet_action_matrix_v1() FROM forge_s4_recovery_operator;
CREATE FUNCTION public.forge_proof_expect_packet_action_rejected_v1(p_action text, p_fingerprint text, p_authorizer uuid)
RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog, forge AS $$
BEGIN
  BEGIN
    PERFORM 1 FROM forge.apply_packet_issuance_recovery_action_v2(
      '27000000-0000-4000-8000-00000000d001', '27000000-0000-4000-8000-00000000d101',
      '27000000-0000-4000-8000-00000000d401', p_action, p_fingerprint,
      '27000000-0000-4000-8000-000000000001', p_authorizer
    );
  EXCEPTION WHEN serialization_failure OR SQLSTATE 'P1726' OR invalid_parameter_value THEN RETURN;
  END;
  RAISE EXCEPTION 'Packet action % unexpectedly passed its rejection fixture', p_action;
END;
$$;
GRANT EXECUTE ON FUNCTION public.forge_proof_expect_packet_action_rejected_v1(text,text,uuid)
  TO forge_s4_recovery_operator;
-- The cartesian matrix above deliberately appended allowed actions. Snapshot
-- the exact durable state immediately before these three stale/invalid calls;
-- rejection is zero-mutation relative to that state, not to an earlier phase.
CREATE TEMP TABLE forge_proof_packet_rejection_baseline ON COMMIT DROP AS
SELECT
  (SELECT count(*)::integer FROM public.filesystem_mcp_issuance_recovery_actions
   WHERE prior_runtime_audit_id = '27000000-0000-4000-8000-00000000d401') AS action_count,
  package.status AS package_status,
  package.metadata AS package_metadata
FROM public.work_packages package
WHERE package.id = '27000000-0000-4000-8000-00000000d101';
SET SESSION AUTHORIZATION forge_s4_recovery_operator;
SELECT public.forge_proof_expect_packet_action_rejected_v1('acknowledge_possible_submission',
  (SELECT marker->>'markerFingerprint' FROM forge_proof_saved_packet_marker), NULL);
SELECT public.forge_proof_expect_packet_action_rejected_v1('decline_packet_recovery',
  'sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', NULL);
SELECT public.forge_proof_expect_packet_action_rejected_v1('retry_execution',
  (SELECT marker->>'markerFingerprint' FROM forge_proof_saved_packet_marker),
  '27000000-0000-4000-8000-00000000d502');
RESET SESSION AUTHORIZATION;
DO $packet_rejects_unchanged$
BEGIN
  IF (SELECT count(*) FROM public.filesystem_mcp_issuance_recovery_actions
      WHERE prior_runtime_audit_id = '27000000-0000-4000-8000-00000000d401')
        <> (SELECT action_count FROM forge_proof_packet_rejection_baseline)
     OR (SELECT status FROM public.work_packages WHERE id = '27000000-0000-4000-8000-00000000d101')
        IS DISTINCT FROM (SELECT package_status FROM forge_proof_packet_rejection_baseline)
     OR (SELECT metadata FROM public.work_packages WHERE id = '27000000-0000-4000-8000-00000000d101')
        IS DISTINCT FROM (SELECT package_metadata FROM forge_proof_packet_rejection_baseline) THEN
    RAISE EXCEPTION 'Rejected packet actions changed durable ledger or canonical marker state';
  END IF;
END;
$packet_rejects_unchanged$;
REVOKE SELECT ON TABLE forge_proof_saved_packet_marker FROM forge_s4_recovery_operator;

-- Local-effect recovery must make the same authoritative task-wide decision
-- as packet recovery before it writes its ledger or package state.
INSERT INTO public.tasks (id, project_id, submitted_by, title, prompt, status)
VALUES (
  '27000000-0000-4000-8000-00000000e001',
  '27000000-0000-4000-8000-000000000010',
  '27000000-0000-4000-8000-000000000001',
  'Local recovery proof', 'local recovery proof', 'approved'
);
INSERT INTO public.work_packages (
  id, task_id, assigned_role, title, summary, status, sequence
) VALUES
  ('27000000-0000-4000-8000-00000000e101',
   '27000000-0000-4000-8000-00000000e001', 'backend',
   'Local recovery target', 'local recovery proof', 'blocked', 1),
  ('27000000-0000-4000-8000-00000000e102',
   '27000000-0000-4000-8000-00000000e001', 'qa',
   'Local recovery sibling', 'local recovery proof', 'pending', 2);
INSERT INTO public.agent_runs (
  id, task_id, work_package_id, agent_type, model_id_used, status,
  stage, attempt_number, started_at, completed_at, error_message
) VALUES
  ('27000000-0000-4000-8000-00000000e201',
   '27000000-0000-4000-8000-00000000e001',
   '27000000-0000-4000-8000-00000000e101', 'backend', 'proof-model',
   'failed', 'implementation', 1, pg_catalog.clock_timestamp() - interval '3 minutes',
   pg_catalog.clock_timestamp() - interval '1 minute', 'recovered local failure'),
  ('27000000-0000-4000-8000-00000000e202',
   '27000000-0000-4000-8000-00000000e001',
   '27000000-0000-4000-8000-00000000e102', 'qa', 'proof-model',
   'running', 'qa', 1, pg_catalog.clock_timestamp(), NULL, NULL),
  ('27000000-0000-4000-8000-00000000e203',
   '27000000-0000-4000-8000-00000000e001',
   '27000000-0000-4000-8000-00000000e102', 'qa', 'proof-model',
   'running', 'qa', 2, pg_catalog.clock_timestamp(), NULL, NULL);
INSERT INTO public.work_package_local_run_evidence (
  id, task_id, work_package_id, agent_run_id, claim_token,
  claim_generation, last_heartbeat_at, lease_expires_at, state,
  terminal, terminal_at
) VALUES (
  '27000000-0000-4000-8000-00000000e301',
  '27000000-0000-4000-8000-00000000e001',
  '27000000-0000-4000-8000-00000000e101',
  '27000000-0000-4000-8000-00000000e201',
  '27000000-0000-4000-8000-00000000e311', 1,
  pg_catalog.clock_timestamp() - interval '3 minutes',
  pg_catalog.clock_timestamp() - interval '2 minutes', 'uncertain',
  '{"status":"failed","failureCode":"local_execution_failed"}'::jsonb,
  pg_catalog.clock_timestamp() - interval '2 minutes'
);
UPDATE public.work_packages package
SET metadata = pg_catalog.jsonb_set(
  package.metadata, '{local_effect_recovery}',
  pg_catalog.jsonb_build_object(
    'schemaVersion', 1, 'kind', 'local_effect_recovery',
    'source', 'local-run-evidence',
    'priorAgentRunId', '27000000-0000-4000-8000-00000000e201',
    'localRunEvidenceId', '27000000-0000-4000-8000-00000000e301',
    'evidenceFingerprint',
      'sha256:' || pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
        'forge:local-run-evidence:v1:' || evidence.id::text || ':' || evidence.terminal::text,
        'UTF8'
      )), 'hex'),
    'taskDisposition', 'operator_hold', 'autoRetryable', false,
    'reason', 'local_execution_interrupted',
    'disposition', 'retry_local_execution', 'reviewState', 'not_applicable'
  ), true
)
FROM public.work_package_local_run_evidence evidence
WHERE package.id = '27000000-0000-4000-8000-00000000e101'
  AND evidence.id = '27000000-0000-4000-8000-00000000e301';

CREATE FUNCTION public.forge_proof_expect_local_retry_rejected_v1()
RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog, forge AS $$
BEGIN
  BEGIN
    PERFORM 1 FROM forge.apply_local_effect_recovery_action_v2(
      '27000000-0000-4000-8000-00000000e001',
      '27000000-0000-4000-8000-00000000e101',
      '27000000-0000-4000-8000-00000000e301', 'retry_local_execution',
      'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
      '27000000-0000-4000-8000-000000000001'
    );
  EXCEPTION WHEN serialization_failure OR SQLSTATE 'P1726' THEN
    RETURN;
  END;
  RAISE EXCEPTION 'Local retry unexpectedly passed a rejection fixture';
END;
$$;
GRANT EXECUTE ON FUNCTION public.forge_proof_expect_local_retry_rejected_v1()
  TO forge_s4_recovery_operator;

-- Every non-approved terminal or active task state is rejected.
UPDATE public.tasks SET status = 'running'
WHERE id = '27000000-0000-4000-8000-00000000e001';
SET SESSION AUTHORIZATION forge_s4_recovery_operator;
SELECT public.forge_proof_expect_local_retry_rejected_v1();
RESET SESSION AUTHORIZATION;
UPDATE public.tasks SET status = 'failed'
WHERE id = '27000000-0000-4000-8000-00000000e001';
SET SESSION AUTHORIZATION forge_s4_recovery_operator;
SELECT public.forge_proof_expect_local_retry_rejected_v1();
RESET SESSION AUTHORIZATION;
UPDATE public.tasks SET status = 'cancelled'
WHERE id = '27000000-0000-4000-8000-00000000e001';
SET SESSION AUTHORIZATION forge_s4_recovery_operator;
SELECT public.forge_proof_expect_local_retry_rejected_v1();
RESET SESSION AUTHORIZATION;
UPDATE public.tasks SET status = 'approved'
WHERE id = '27000000-0000-4000-8000-00000000e001';

UPDATE public.work_packages SET status = 'awaiting_review'
WHERE id = '27000000-0000-4000-8000-00000000e102';
SET SESSION AUTHORIZATION forge_s4_recovery_operator;
SELECT public.forge_proof_expect_local_retry_rejected_v1();
RESET SESSION AUTHORIZATION;
UPDATE public.work_packages SET status = 'pending', metadata = pg_catalog.jsonb_build_object(
  'executionLease', pg_catalog.jsonb_build_object(
    'runId', '27000000-0000-4000-8000-00000000e202',
    'source', 'work-package-handoff', 'attemptNumber', 1,
    'acquiredAt', pg_catalog.to_char(pg_catalog.clock_timestamp() AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'heartbeatAt', pg_catalog.to_char(pg_catalog.clock_timestamp() AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'staleAfterSeconds', 60
  )
) WHERE id = '27000000-0000-4000-8000-00000000e102';
SET SESSION AUTHORIZATION forge_s4_recovery_operator;
SELECT public.forge_proof_expect_local_retry_rejected_v1();
RESET SESSION AUTHORIZATION;
UPDATE public.work_packages SET metadata = '{}'::jsonb
WHERE id = '27000000-0000-4000-8000-00000000e102';

-- An expired claim is still claimed evidence; a live claim also proves the
-- local lease rejection independently.
INSERT INTO public.work_package_local_run_evidence (
  id, task_id, work_package_id, agent_run_id, claim_token,
  claim_generation, last_heartbeat_at, lease_expires_at, state
) VALUES (
  '27000000-0000-4000-8000-00000000e302',
  '27000000-0000-4000-8000-00000000e001',
  '27000000-0000-4000-8000-00000000e102',
  '27000000-0000-4000-8000-00000000e202',
  '27000000-0000-4000-8000-00000000e312', 1,
  pg_catalog.clock_timestamp() - interval '2 minutes',
  pg_catalog.clock_timestamp() - interval '1 minute', 'claimed'
);
SET SESSION AUTHORIZATION forge_s4_recovery_operator;
SELECT public.forge_proof_expect_local_retry_rejected_v1();
RESET SESSION AUTHORIZATION;
UPDATE public.work_package_local_run_evidence
SET state = 'terminal', terminal = '{"status":"failed"}'::jsonb,
    terminal_at = pg_catalog.clock_timestamp()
WHERE id = '27000000-0000-4000-8000-00000000e302';
INSERT INTO public.work_package_local_run_evidence (
  id, task_id, work_package_id, agent_run_id, claim_token,
  claim_generation, last_heartbeat_at, lease_expires_at, state
) VALUES (
  '27000000-0000-4000-8000-00000000e303',
  '27000000-0000-4000-8000-00000000e001',
  '27000000-0000-4000-8000-00000000e102',
  '27000000-0000-4000-8000-00000000e203',
  '27000000-0000-4000-8000-00000000e313', 1,
  pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp() + interval '1 minute',
  'claimed'
);
SET SESSION AUTHORIZATION forge_s4_recovery_operator;
SELECT public.forge_proof_expect_local_retry_rejected_v1();
RESET SESSION AUTHORIZATION;
UPDATE public.work_package_local_run_evidence
SET state = 'terminal', terminal = '{"status":"failed"}'::jsonb,
    terminal_at = pg_catalog.clock_timestamp()
WHERE id = '27000000-0000-4000-8000-00000000e303';

-- Packet claims are rejected even after expiry, and the live form separately
-- proves that an active packet lease cannot overlap local recovery.
ALTER TABLE public.filesystem_mcp_runtime_audits DISABLE TRIGGER
  filesystem_mcp_runtime_audits_protocol_v2_guard;
INSERT INTO public.filesystem_mcp_runtime_audits (
  id, task_id, work_package_id, agent_run_id, operation, status,
  capabilities, requested_capabilities, protocol_version,
  local_run_evidence_id, claim_token, claim_generation,
  last_heartbeat_at, lease_expires_at, authorization_snapshot,
  authorization_source, grant_mode, grant_decision_revision,
  authorization_root_binding_revision, project_decision_id,
  assembly, delivery
)
SELECT
  '27000000-0000-4000-8000-00000000e402',
  '27000000-0000-4000-8000-00000000e001',
  '27000000-0000-4000-8000-00000000e102',
  '27000000-0000-4000-8000-00000000e203', audit.operation, 'claiming',
  audit.capabilities, audit.requested_capabilities, audit.protocol_version,
  '27000000-0000-4000-8000-00000000e303',
  '27000000-0000-4000-8000-00000000e314', 1,
  pg_catalog.clock_timestamp() - interval '2 minutes',
  pg_catalog.clock_timestamp() - interval '1 minute',
  audit.authorization_snapshot, audit.authorization_source, audit.grant_mode,
  audit.grant_decision_revision, audit.authorization_root_binding_revision,
  audit.project_decision_id, NULL, NULL
FROM public.filesystem_mcp_runtime_audits audit
WHERE audit.id = '27000000-0000-4000-8000-00000000d401';
ALTER TABLE public.filesystem_mcp_runtime_audits ENABLE TRIGGER
  filesystem_mcp_runtime_audits_protocol_v2_guard;
SET SESSION AUTHORIZATION forge_s4_recovery_operator;
SELECT public.forge_proof_expect_local_retry_rejected_v1();
RESET SESSION AUTHORIZATION;
DELETE FROM public.filesystem_mcp_runtime_audits
WHERE id = '27000000-0000-4000-8000-00000000e402';
ALTER TABLE public.filesystem_mcp_runtime_audits DISABLE TRIGGER
  filesystem_mcp_runtime_audits_protocol_v2_guard;
INSERT INTO public.filesystem_mcp_runtime_audits (
  id, task_id, work_package_id, agent_run_id, operation, status,
  capabilities, requested_capabilities, protocol_version,
  local_run_evidence_id, claim_token, claim_generation,
  last_heartbeat_at, lease_expires_at, authorization_snapshot,
  authorization_source, grant_mode, grant_decision_revision,
  authorization_root_binding_revision, project_decision_id,
  assembly, delivery
)
SELECT
  '27000000-0000-4000-8000-00000000e403',
  '27000000-0000-4000-8000-00000000e001',
  '27000000-0000-4000-8000-00000000e102',
  '27000000-0000-4000-8000-00000000e203', audit.operation, 'claiming',
  audit.capabilities, audit.requested_capabilities, audit.protocol_version,
  '27000000-0000-4000-8000-00000000e303',
  '27000000-0000-4000-8000-00000000e315', 1,
  pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp() + interval '1 minute',
  audit.authorization_snapshot, audit.authorization_source, audit.grant_mode,
  audit.grant_decision_revision, audit.authorization_root_binding_revision,
  audit.project_decision_id, NULL, NULL
FROM public.filesystem_mcp_runtime_audits audit
WHERE audit.id = '27000000-0000-4000-8000-00000000d401';
ALTER TABLE public.filesystem_mcp_runtime_audits ENABLE TRIGGER
  filesystem_mcp_runtime_audits_protocol_v2_guard;
SET SESSION AUTHORIZATION forge_s4_recovery_operator;
SELECT public.forge_proof_expect_local_retry_rejected_v1();
RESET SESSION AUTHORIZATION;
DELETE FROM public.filesystem_mcp_runtime_audits
WHERE id = '27000000-0000-4000-8000-00000000e403';

UPDATE public.work_packages
SET metadata = metadata || '{"local_effect_integrity_hold":{}}'::jsonb
WHERE id = '27000000-0000-4000-8000-00000000e102';
SET SESSION AUTHORIZATION forge_s4_recovery_operator;
SELECT public.forge_proof_expect_local_retry_rejected_v1();
RESET SESSION AUTHORIZATION;
UPDATE public.work_packages SET metadata = metadata - 'local_effect_integrity_hold'
WHERE id = '27000000-0000-4000-8000-00000000e102';
UPDATE public.work_packages
SET metadata = metadata || '{"packet_integrity_hold":{}}'::jsonb
WHERE id = '27000000-0000-4000-8000-00000000e101';
SET SESSION AUTHORIZATION forge_s4_recovery_operator;
SELECT public.forge_proof_expect_local_retry_rejected_v1();
RESET SESSION AUTHORIZATION;
UPDATE public.work_packages SET metadata = metadata - 'packet_integrity_hold'
WHERE id = '27000000-0000-4000-8000-00000000e101';

-- The target may carry only its exact local marker, and no sibling may carry
-- a competing local/packet recovery marker.
UPDATE public.work_packages
SET metadata = metadata || '{"packet_issuance":{}}'::jsonb
WHERE id = '27000000-0000-4000-8000-00000000e101';
SET SESSION AUTHORIZATION forge_s4_recovery_operator;
SELECT public.forge_proof_expect_local_retry_rejected_v1();
RESET SESSION AUTHORIZATION;
UPDATE public.work_packages SET metadata = metadata - 'packet_issuance'
WHERE id = '27000000-0000-4000-8000-00000000e101';
UPDATE public.work_packages
SET metadata = metadata || '{"local_effect_recovery":{}}'::jsonb
WHERE id = '27000000-0000-4000-8000-00000000e102';
SET SESSION AUTHORIZATION forge_s4_recovery_operator;
SELECT public.forge_proof_expect_local_retry_rejected_v1();
RESET SESSION AUTHORIZATION;
UPDATE public.work_packages SET metadata = metadata - 'local_effect_recovery'
WHERE id = '27000000-0000-4000-8000-00000000e102';

UPDATE public.tasks SET local_projection_overlimit_package_count = 257
WHERE id = '27000000-0000-4000-8000-00000000e001';
SET SESSION AUTHORIZATION forge_s4_recovery_operator;
SELECT public.forge_proof_expect_local_retry_rejected_v1();
RESET SESSION AUTHORIZATION;
UPDATE public.tasks SET local_projection_overlimit_package_count = NULL
WHERE id = '27000000-0000-4000-8000-00000000e001';
CREATE TEMP TABLE forge_proof_saved_projection_head ON COMMIT DROP AS
SELECT * FROM public.work_package_local_projection_heads
WHERE task_id = '27000000-0000-4000-8000-00000000e001'
ORDER BY id LIMIT 1;
ALTER TABLE public.work_package_local_projection_heads DISABLE TRIGGER
  trg_reject_projection_head_mutation;
DELETE FROM public.work_package_local_projection_heads head
USING forge_proof_saved_projection_head saved
WHERE head.id = saved.id;
ALTER TABLE public.work_package_local_projection_heads ENABLE TRIGGER
  trg_reject_projection_head_mutation;
SET SESSION AUTHORIZATION forge_s4_recovery_operator;
SELECT public.forge_proof_expect_local_retry_rejected_v1();
RESET SESSION AUTHORIZATION;
INSERT INTO public.work_package_local_projection_heads
SELECT * FROM forge_proof_saved_projection_head;

DO $local_recovery_rejection_zero_mutation$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.local_effect_recovery_actions
    WHERE local_run_evidence_id = '27000000-0000-4000-8000-00000000e301'
  ) OR NOT EXISTS (
    SELECT 1 FROM public.work_packages package
    WHERE package.id = '27000000-0000-4000-8000-00000000e101'
      AND package.status = 'blocked'
      AND package.metadata ? 'local_effect_recovery'
      AND NOT package.metadata ? 'packet_issuance'
      AND NOT package.metadata ? 'packet_integrity_hold'
      AND NOT package.metadata ? 'local_effect_integrity_hold'
  ) THEN
    RAISE EXCEPTION 'A rejected local recovery action mutated durable state';
  END IF;
END;
$local_recovery_rejection_zero_mutation$;

-- Exercise every local marker disposition/action pair against the installed
-- routine.  Each transition uses the real marker and canonical evidence; the
-- marker is restored between cases so one terminal action cannot authorize
-- the next.  This specifically guards the decline action, whose accepted
-- disposition intentionally differs from its action name.
CREATE TEMP TABLE forge_proof_saved_local_marker ON COMMIT DROP AS
SELECT metadata->'local_effect_recovery' AS marker
FROM public.work_packages
WHERE id = '27000000-0000-4000-8000-00000000e101';
GRANT SELECT ON TABLE forge_proof_saved_local_marker TO forge_s4_recovery_operator;

-- Exhaustive local recovery disposition/action matrix. The local marker's CAS
-- token is the canonical evidence fingerprint, so each cartesian case uses a
-- distinct fixture actor while still calling the installed protected routine.
INSERT INTO public.users (id, display_name) VALUES
  ('27000000-0000-4000-8000-00000000e901', 'local matrix 01'),
  ('27000000-0000-4000-8000-00000000e902', 'local matrix 02'),
  ('27000000-0000-4000-8000-00000000e903', 'local matrix 03'),
  ('27000000-0000-4000-8000-00000000e904', 'local matrix 04'),
  ('27000000-0000-4000-8000-00000000e905', 'local matrix 05'),
  ('27000000-0000-4000-8000-00000000e906', 'local matrix 06'),
  ('27000000-0000-4000-8000-00000000e907', 'local matrix 07'),
  ('27000000-0000-4000-8000-00000000e908', 'local matrix 08'),
  ('27000000-0000-4000-8000-00000000e909', 'local matrix 09'),
  ('27000000-0000-4000-8000-00000000e910', 'local matrix 10'),
  ('27000000-0000-4000-8000-00000000e911', 'local matrix 11'),
  ('27000000-0000-4000-8000-00000000e912', 'local matrix 12'),
  ('27000000-0000-4000-8000-00000000e913', 'local matrix 13'),
  ('27000000-0000-4000-8000-00000000e914', 'local matrix 14'),
  ('27000000-0000-4000-8000-00000000e915', 'local matrix 15'),
  ('27000000-0000-4000-8000-00000000e916', 'local matrix 16');
CREATE FUNCTION public.forge_proof_local_action_matrix_v1()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, forge AS $$
DECLARE
  v_base jsonb;
  v_marker jsonb;
  v_disposition text;
  v_action text;
  v_allowed boolean;
  v_actor uuid;
  v_index integer := 0;
  v_before_actions integer;
  v_before_metadata jsonb;
  v_before_status text;
  v_first record;
  v_second record;
  v_after_metadata jsonb;
  v_after_status text;
  v_actors uuid[] := ARRAY[
    '27000000-0000-4000-8000-00000000e901'::uuid,'27000000-0000-4000-8000-00000000e902'::uuid,
    '27000000-0000-4000-8000-00000000e903'::uuid,'27000000-0000-4000-8000-00000000e904'::uuid,
    '27000000-0000-4000-8000-00000000e905'::uuid,'27000000-0000-4000-8000-00000000e906'::uuid,
    '27000000-0000-4000-8000-00000000e907'::uuid,'27000000-0000-4000-8000-00000000e908'::uuid,
    '27000000-0000-4000-8000-00000000e909'::uuid,'27000000-0000-4000-8000-00000000e910'::uuid,
    '27000000-0000-4000-8000-00000000e911'::uuid,'27000000-0000-4000-8000-00000000e912'::uuid,
    '27000000-0000-4000-8000-00000000e913'::uuid,'27000000-0000-4000-8000-00000000e914'::uuid,
    '27000000-0000-4000-8000-00000000e915'::uuid,'27000000-0000-4000-8000-00000000e916'::uuid
  ];
BEGIN
  SELECT metadata->'local_effect_recovery' INTO STRICT v_base
  FROM public.work_packages WHERE id = '27000000-0000-4000-8000-00000000e101';
  FOREACH v_disposition IN ARRAY ARRAY[
    'review_local_changes','acknowledge_possible_local_invocation','retry_local_execution','dependent_packet'
  ] LOOP
    FOREACH v_action IN ARRAY ARRAY[
      'review_local_changes','acknowledge_possible_local_invocation','retry_local_execution','decline_local_retry'
    ] LOOP
      v_index := v_index + 1; v_actor := v_actors[v_index];
      v_marker := v_base || pg_catalog.jsonb_build_object(
        'disposition', v_disposition, 'nextDisposition', 'retry_local_execution',
        'matrixCase', v_disposition || ':' || v_action
      );
      UPDATE public.work_packages SET status = 'blocked',
        metadata = pg_catalog.jsonb_set(metadata, '{local_effect_recovery}', v_marker, true)
      WHERE id = '27000000-0000-4000-8000-00000000e101';
      v_allowed := (v_action = 'review_local_changes' AND v_disposition = 'review_local_changes')
        OR (v_action = 'acknowledge_possible_local_invocation' AND v_disposition = 'acknowledge_possible_local_invocation')
        OR (v_action = 'retry_local_execution' AND v_disposition = 'retry_local_execution')
        OR (v_action = 'decline_local_retry' AND v_disposition IN ('acknowledge_possible_local_invocation','retry_local_execution'));
      SELECT count(*)::integer, metadata, status INTO v_before_actions, v_before_metadata, v_before_status
      FROM public.local_effect_recovery_actions action CROSS JOIN public.work_packages package
      WHERE action.local_run_evidence_id = '27000000-0000-4000-8000-00000000e301'
        AND package.id = '27000000-0000-4000-8000-00000000e101'
      GROUP BY package.metadata, package.status;
      BEGIN
        SELECT * INTO v_first FROM forge.apply_local_effect_recovery_action_v2(
          '27000000-0000-4000-8000-00000000e001', '27000000-0000-4000-8000-00000000e101',
          '27000000-0000-4000-8000-00000000e301', v_action,
          v_marker->>'evidenceFingerprint', v_actor
        );
        IF NOT v_allowed THEN RAISE EXCEPTION 'disallowed local matrix pair passed: %/%', v_disposition, v_action; END IF;
        SELECT metadata, status INTO v_after_metadata, v_after_status
        FROM public.work_packages WHERE id = '27000000-0000-4000-8000-00000000e101';
        IF (SELECT count(*) FROM public.local_effect_recovery_actions
            WHERE local_run_evidence_id = '27000000-0000-4000-8000-00000000e301') <> v_before_actions + 1
           OR v_first.result IS DISTINCT FROM CASE v_action WHEN 'review_local_changes' THEN 'reviewed'
             WHEN 'acknowledge_possible_local_invocation' THEN 'acknowledged'
             WHEN 'retry_local_execution' THEN 'ready' ELSE 'cancelled' END
           OR v_first.package_status IS DISTINCT FROM CASE v_action WHEN 'review_local_changes' THEN 'blocked'
             WHEN 'acknowledge_possible_local_invocation' THEN 'blocked'
             WHEN 'retry_local_execution' THEN 'ready' ELSE 'cancelled' END
           OR v_after_status IS DISTINCT FROM v_first.package_status
           OR (v_action IN ('review_local_changes','acknowledge_possible_local_invocation')
             AND NOT v_after_metadata ? 'local_effect_recovery')
           OR (v_action NOT IN ('review_local_changes','acknowledge_possible_local_invocation')
             AND v_after_metadata ? 'local_effect_recovery') THEN
          RAISE EXCEPTION 'allowed local matrix pair did not append its exact canonical transition: %/%', v_disposition, v_action;
        END IF;
        SELECT * INTO v_second FROM forge.apply_local_effect_recovery_action_v2(
          '27000000-0000-4000-8000-00000000e001', '27000000-0000-4000-8000-00000000e101',
          '27000000-0000-4000-8000-00000000e301', v_action,
          v_marker->>'evidenceFingerprint', v_actor
        );
        IF v_second.action_id IS DISTINCT FROM v_first.action_id
           OR v_second.result IS DISTINCT FROM v_first.result
           OR v_second.result_marker_fingerprint IS DISTINCT FROM v_first.result_marker_fingerprint
           OR v_second.package_status IS DISTINCT FROM v_first.package_status
           OR (SELECT count(*) FROM public.local_effect_recovery_actions
               WHERE local_run_evidence_id = '27000000-0000-4000-8000-00000000e301') <> v_before_actions + 1
           OR (SELECT metadata FROM public.work_packages WHERE id = '27000000-0000-4000-8000-00000000e101') IS DISTINCT FROM v_after_metadata
           OR (SELECT status FROM public.work_packages WHERE id = '27000000-0000-4000-8000-00000000e101') IS DISTINCT FROM v_after_status THEN
          RAISE EXCEPTION 'local matrix replay was not ledger-first and byte-stable: %/%', v_disposition, v_action;
        END IF;
      EXCEPTION WHEN serialization_failure OR SQLSTATE 'P1726' THEN
        IF v_allowed THEN RAISE; END IF;
      END;
      IF NOT v_allowed AND (
        (SELECT count(*) FROM public.local_effect_recovery_actions
         WHERE local_run_evidence_id = '27000000-0000-4000-8000-00000000e301') <> v_before_actions
        OR (SELECT metadata FROM public.work_packages WHERE id = '27000000-0000-4000-8000-00000000e101') IS DISTINCT FROM v_before_metadata
        OR (SELECT status FROM public.work_packages WHERE id = '27000000-0000-4000-8000-00000000e101') IS DISTINCT FROM v_before_status
      ) THEN RAISE EXCEPTION 'rejected local matrix pair mutated state: %/%', v_disposition, v_action; END IF;
    END LOOP;
  END LOOP;
  UPDATE public.work_packages SET status = 'blocked',
    metadata = pg_catalog.jsonb_set(metadata, '{local_effect_recovery}', v_base, true)
  WHERE id = '27000000-0000-4000-8000-00000000e101';
END;
$$;
ALTER FUNCTION public.forge_proof_local_action_matrix_v1() OWNER TO forge_s4_routines_owner;
GRANT EXECUTE ON FUNCTION public.forge_proof_local_action_matrix_v1() TO forge_s4_recovery_operator;
SET SESSION AUTHORIZATION forge_s4_recovery_operator;
SELECT public.forge_proof_local_action_matrix_v1();
RESET SESSION AUTHORIZATION;
REVOKE EXECUTE ON FUNCTION public.forge_proof_local_action_matrix_v1() FROM forge_s4_recovery_operator;

UPDATE public.work_packages
SET metadata = pg_catalog.jsonb_set(
  metadata, '{local_effect_recovery}',
  (SELECT marker || '{"disposition":"review_local_changes","nextDisposition":"retry_local_execution"}'::jsonb
   FROM forge_proof_saved_local_marker), true
)
WHERE id = '27000000-0000-4000-8000-00000000e101';
SET SESSION AUTHORIZATION forge_s4_recovery_operator;
SELECT result, package_status FROM forge.apply_local_effect_recovery_action_v2(
  '27000000-0000-4000-8000-00000000e001', '27000000-0000-4000-8000-00000000e101',
  '27000000-0000-4000-8000-00000000e301', 'review_local_changes',
  (SELECT marker->>'evidenceFingerprint' FROM forge_proof_saved_local_marker),
  '27000000-0000-4000-8000-000000000001'
);
RESET SESSION AUTHORIZATION;

UPDATE public.work_packages
SET metadata = pg_catalog.jsonb_set(
  metadata, '{local_effect_recovery}',
  (SELECT marker || '{"disposition":"acknowledge_possible_local_invocation"}'::jsonb
   FROM forge_proof_saved_local_marker), true
)
WHERE id = '27000000-0000-4000-8000-00000000e101';
SET SESSION AUTHORIZATION forge_s4_recovery_operator;
SELECT result, package_status FROM forge.apply_local_effect_recovery_action_v2(
  '27000000-0000-4000-8000-00000000e001', '27000000-0000-4000-8000-00000000e101',
  '27000000-0000-4000-8000-00000000e301', 'acknowledge_possible_local_invocation',
  (SELECT marker->>'evidenceFingerprint' FROM forge_proof_saved_local_marker),
  '27000000-0000-4000-8000-000000000001'
);
RESET SESSION AUTHORIZATION;

UPDATE public.work_packages
SET metadata = pg_catalog.jsonb_set(metadata, '{local_effect_recovery}',
  (SELECT marker FROM forge_proof_saved_local_marker), true)
WHERE id = '27000000-0000-4000-8000-00000000e101';
SET SESSION AUTHORIZATION forge_s4_recovery_operator;
SELECT result, package_status FROM forge.apply_local_effect_recovery_action_v2(
  '27000000-0000-4000-8000-00000000e001', '27000000-0000-4000-8000-00000000e101',
  '27000000-0000-4000-8000-00000000e301', 'decline_local_retry',
  (SELECT marker->>'evidenceFingerprint' FROM forge_proof_saved_local_marker),
  '27000000-0000-4000-8000-000000000001'
);
RESET SESSION AUTHORIZATION;
DO $local_disposition_actions$
BEGIN
  IF (SELECT count(*) FROM public.local_effect_recovery_actions
      WHERE local_run_evidence_id = '27000000-0000-4000-8000-00000000e301'
        AND action IN ('review_local_changes', 'acknowledge_possible_local_invocation', 'decline_local_retry')) <> 3
     OR (SELECT status FROM public.work_packages WHERE id = '27000000-0000-4000-8000-00000000e101') <> 'cancelled' THEN
    RAISE EXCEPTION 'Local recovery disposition/action proof did not persist exactly one action per transition';
  END IF;
END;
$local_disposition_actions$;

UPDATE public.work_packages
SET status = 'blocked', metadata = pg_catalog.jsonb_set(metadata, '{local_effect_recovery}',
  (SELECT marker FROM forge_proof_saved_local_marker), true)
WHERE id = '27000000-0000-4000-8000-00000000e101';

SELECT 'sha256:' || pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
  'forge:local-run-evidence:v1:' || evidence.id::text || ':' || evidence.terminal::text,
  'UTF8'
)), 'hex') AS fingerprint
FROM public.work_package_local_run_evidence evidence
WHERE evidence.id = '27000000-0000-4000-8000-00000000e301'
\gset local_recovery_
SET SESSION AUTHORIZATION forge_s4_recovery_operator;
SELECT result, package_status
FROM forge.apply_local_effect_recovery_action_v2(
    '27000000-0000-4000-8000-00000000e001',
    '27000000-0000-4000-8000-00000000e101',
    '27000000-0000-4000-8000-00000000e301', 'retry_local_execution',
    :'local_recovery_fingerprint',
    '27000000-0000-4000-8000-000000000001'
  );
-- Exact ledger-first replay succeeds after the local marker was cleared.
SELECT result, package_status
FROM forge.apply_local_effect_recovery_action_v2(
    '27000000-0000-4000-8000-00000000e001',
    '27000000-0000-4000-8000-00000000e101',
    '27000000-0000-4000-8000-00000000e301', 'retry_local_execution',
    :'local_recovery_fingerprint',
    '27000000-0000-4000-8000-000000000001'
  );
RESET SESSION AUTHORIZATION;
DO $local_recovery_success_assertions$
BEGIN
  IF (SELECT pg_catalog.count(*)
      FROM public.local_effect_recovery_actions action
      WHERE action.local_run_evidence_id = '27000000-0000-4000-8000-00000000e301'
        AND action.action = 'retry_local_execution') <> 1
     OR NOT EXISTS (
       SELECT 1 FROM public.work_packages package
       WHERE package.id = '27000000-0000-4000-8000-00000000e101'
         AND package.status = 'ready'
         AND NOT package.metadata ? 'local_effect_recovery'
     ) THEN
    RAISE EXCEPTION 'Local retry did not retain one exact replayable action';
  END IF;
END;
$local_recovery_success_assertions$;
REVOKE SELECT ON TABLE forge_proof_saved_local_marker FROM forge_s4_recovery_operator;
ROLLBACK;
