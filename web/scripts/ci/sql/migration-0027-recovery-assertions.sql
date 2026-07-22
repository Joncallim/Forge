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
ROLLBACK;
