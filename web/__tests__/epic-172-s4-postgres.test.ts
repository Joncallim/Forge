import { randomBytes, randomUUID } from 'node:crypto'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  bindArchitectReplanEntry,
  executableReferenceForEntry,
  recordArchitectPlanVersion,
  resolveArchitectPlanEntry,
} from '@/lib/mcps/s4-protocol-store'
import { computeCredentialDigest } from '@/lib/session-credential-digest'
import { readArchitectPlanHistory } from '@/lib/mcps/history-reader'

const adminUrl = process.env.FORGE_S4_POSTGRES_TEST_DATABASE_URL?.trim()
const issuerUrl = process.env.FORGE_PACKET_ISSUER_DATABASE_URL?.trim()
const writerUrl = process.env.FORGE_ARCHITECT_PLAN_WRITER_DATABASE_URL?.trim()
const resolverUrl = process.env.FORGE_ARCHITECT_PLAN_RESOLVER_DATABASE_URL?.trim()
const historyReaderUrl = process.env.FORGE_ARCHITECT_PLAN_HISTORY_READER_DATABASE_URL?.trim()
const appUrl = process.env.FORGE_EPIC_172_TEST_APP_DATABASE_URL?.trim()
const enabled = Boolean(adminUrl && issuerUrl && writerUrl && resolverUrl && historyReaderUrl && appUrl)
const requirePostgresFixture = process.env.FORGE_S4_REQUIRE_POSTGRES_TEST === '1'
const SHA = `sha256:${'a'.repeat(64)}`

if (requirePostgresFixture && !enabled) {
  throw new Error(
    'FORGE_S4_REQUIRE_POSTGRES_TEST=1 requires the S4 administrator, ordinary app, packet issuer, Architect plan writer, Architect plan resolver, and Architect history reader PostgreSQL URLs; the explicit contract suite may not skip.',
  )
}

describe.skipIf(!enabled)('Epic 172 S4 PostgreSQL boundaries', () => {
  const ids = {
    user: randomUUID(),
    project: randomUUID(),
    task: randomUUID(),
    package: randomUUID(),
    architectRun: randomUUID(),
    replanRun: randomUUID(),
    firstRun: randomUUID(),
    secondRun: randomUUID(),
    firstEvidence: randomUUID(),
    secondEvidence: randomUUID(),
    firstLocalClaim: randomUUID(),
    secondLocalClaim: randomUUID(),
    decision: randomUUID(),
    nonce: randomUUID(),
    signerKey: randomUUID(),
    enablementReceipt: randomUUID(),
    readinessReceipt: randomUUID(),
    legacyArchitectRun: randomUUID(),
  }
  const key = randomBytes(32)
  const sessionCredential = randomUUID()
  let admin: ReturnType<typeof postgres>
  let app: ReturnType<typeof postgres>
  let issuer: ReturnType<typeof postgres>

  beforeAll(async () => {
    process.env.FORGE_ARCHITECT_PLAN_WRITER_DATABASE_URL = writerUrl!
    process.env.FORGE_ARCHITECT_PLAN_RESOLVER_DATABASE_URL = resolverUrl!
    process.env.FORGE_ARCHITECT_PLAN_HISTORY_READER_DATABASE_URL = historyReaderUrl!
    admin = postgres(adminUrl!, { max: 1, onnotice: () => {} })
    app = postgres(appUrl!, { max: 1, onnotice: () => {} })
    issuer = postgres(issuerUrl!, { max: 2, onnotice: () => {} })

    await admin.begin(async (tx) => {
      await tx`insert into users (id, display_name) values (${ids.user}::uuid, 'S4 PostgreSQL test')`
      await tx`
        insert into projects (
          id, name, submitted_by, grant_decision_revision, root_binding_revision
        ) values (${ids.project}::uuid, 'S4 PostgreSQL test', ${ids.user}::uuid, 1, 1)
      `
      await tx`
        insert into tasks (id, project_id, submitted_by, title, prompt, status)
        values (${ids.task}::uuid, ${ids.project}::uuid, ${ids.user}::uuid, 'S4 test', 'protected', 'running')
      `
      await tx`
        insert into sessions (id, user_id, credential_digest_v1, expires_at)
        values (
          ${randomUUID()}::uuid, ${ids.user}::uuid,
          ${computeCredentialDigest(sessionCredential).digest}::bytea,
          clock_timestamp() + interval '7 days'
        )
      `
      await tx`
        insert into work_packages (
          id, task_id, assigned_role, title, summary, sequence, status
        ) values (
          ${ids.package}::uuid, ${ids.task}::uuid, 'backend', 'S4 test package', 'bounded', 1, 'running'
        )
      `
      await tx`
        insert into agent_runs (id, task_id, work_package_id, agent_type, model_id_used, status)
        values
          (${ids.architectRun}::uuid, ${ids.task}::uuid, null, 'architect', 'test', 'completed'),
          (${ids.replanRun}::uuid, ${ids.task}::uuid, null, 'architect', 'test', 'running'),
          (${ids.firstRun}::uuid, ${ids.task}::uuid, ${ids.package}::uuid, 'backend', 'test', 'running'),
          (${ids.secondRun}::uuid, ${ids.task}::uuid, ${ids.package}::uuid, 'backend', 'test', 'running')
      `
      await tx`
        insert into filesystem_mcp_grant_approvals (
          id, project_id, task_id, work_package_id, decided_by, decision,
          capabilities, effective_grant, decision_scope, grant_decision_revision,
          root_binding_revision, grant_nonce, pointer_fingerprint
        ) values (
          ${ids.decision}::uuid, ${ids.project}::uuid, ${ids.task}::uuid, ${ids.package}::uuid,
          ${ids.user}::uuid, 'approved',
          '["filesystem.project.read"]'::jsonb, '{}'::jsonb, 'package', 1, 1,
          ${ids.nonce}::uuid, ${SHA}
        )
      `
      await tx`
        update filesystem_mcp_current_decision_pointers
        set current_decision_id = ${ids.decision}::uuid,
            current_decision_task_id = ${ids.task}::uuid,
            current_decision_work_package_id = ${ids.package}::uuid,
            current_decision_revision = 1,
            current_decision_fingerprint = ${SHA},
            pointer_fingerprint = ${SHA},
            pointer_version = 1
        where work_package_id = ${ids.package}::uuid
      `
      await tx`
        insert into work_package_local_run_evidence (
          id, task_id, work_package_id, agent_run_id, claim_token, lease_expires_at
        ) values
          (${ids.firstEvidence}::uuid, ${ids.task}::uuid, ${ids.package}::uuid,
           ${ids.firstRun}::uuid, ${ids.firstLocalClaim}::uuid, clock_timestamp() + interval '30 seconds'),
          (${ids.secondEvidence}::uuid, ${ids.task}::uuid, ${ids.package}::uuid,
           ${ids.secondRun}::uuid, ${ids.secondLocalClaim}::uuid, clock_timestamp() + interval '30 seconds')
      `
      await tx`
        insert into forge_release_signer_keys (
          id, generation, public_key_spki, github_app_id, ruleset_fingerprint,
          status, valid_from, valid_until
        ) values (
          ${ids.signerKey}::uuid, 1, decode('00', 'hex'), 's4-postgres-test',
          ${'b'.repeat(64)}, 'staged', clock_timestamp() - interval '1 minute',
          clock_timestamp() + interval '1 hour'
        )
      `
      await tx`
        insert into forge_epic_172_release_evidence (
          id, evidence_kind, owner_issue, owner_slice, exact_builds,
          required_evidence, reviewed_sha, epoch, predecessor_receipt_ids,
          predecessor_set_digest, transition_identity_digest, signer_key_id,
          signer_generation, github_app_id, controller_run_id, controller_job_id,
          envelope_digest, detached_signature, nonce, issued_at, envelope
        ) values
        (
          ${ids.enablementReceipt}::uuid, 'ingress_and_issuance_enabled', 179, 's4',
          ${JSON.stringify([
            `issue_179_s4@${'a'.repeat(40)}`,
            `issue_180_s5@${'a'.repeat(40)}`,
            `issue_181_s6@${'a'.repeat(40)}`,
          ])}::jsonb,
          '[{"name":"postgres_fixture","measurementDigest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}]'::jsonb,
          ${'a'.repeat(40)}, 2, '[]'::jsonb, ${'0'.repeat(64)}, ${'c'.repeat(64)},
          ${ids.signerKey}::uuid, 1, 's4-postgres-test', 's4-postgres-test', 'enablement',
          ${'e'.repeat(64)}, decode(repeat('aa', 64), 'hex'), ${randomUUID()}::uuid,
          clock_timestamp(), '{}'::jsonb
        ),
        (
          ${ids.readinessReceipt}::uuid, 's5_s6_release_ready', 181, 's6',
          ${JSON.stringify([
            `issue_179_s4@${'a'.repeat(40)}`,
            `issue_180_s5@${'a'.repeat(40)}`,
            `issue_181_s6@${'a'.repeat(40)}`,
          ])}::jsonb,
          '[{"name":"postgres_fixture","measurementDigest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}]'::jsonb,
          ${'a'.repeat(40)}, 2, '[]'::jsonb, ${'1'.repeat(64)}, ${'d'.repeat(64)},
          ${ids.signerKey}::uuid, 1, 's4-postgres-test', 's4-postgres-test', 'readiness',
          ${'f'.repeat(64)}, decode(repeat('bb', 64), 'hex'), ${randomUUID()}::uuid,
          clock_timestamp(), '{}'::jsonb
        )
      `
      await tx`
        update forge_epic_172_enablement_state
        set state = 'active', owner_operation_id = 's4-postgres-test',
            exact_builds = ${JSON.stringify([
              `issue_179_s4@${'a'.repeat(40)}`,
              `issue_180_s5@${'a'.repeat(40)}`,
              `issue_181_s6@${'a'.repeat(40)}`,
            ])}::jsonb,
            reviewed_sha = ${'a'.repeat(40)}, epoch = 2,
            enablement_receipt_id = ${ids.enablementReceipt}::uuid,
            final_readiness_receipt_id = ${ids.readinessReceipt}::uuid,
            state_fingerprint = ${'9'.repeat(64)}, updated_at = clock_timestamp()
        where singleton_id = 'epic-172'
      `
    })
  })

  afterAll(async () => {
    if (admin) {
      await admin`
        update forge_epic_172_enablement_state
        set state = 'disabled', owner_operation_id = null, exact_builds = null,
            reviewed_sha = null, epoch = null, started_at = null, expires_at = null,
            enablement_receipt_id = null, final_readiness_receipt_id = null,
            opening_authorization_id = null, controller_login_id = null,
            controller_run_id = null, controller_token_digest = null,
            lease_generation = null, last_heartbeat_at = null, lease_expires_at = null,
            state_fingerprint = 'b0789177e07f4a9307f3397a938999b6fcc8c835a97e03d2770f83e4978c2585',
            updated_at = clock_timestamp()
        where singleton_id = 'epic-172'
      `
    }
    await Promise.all([admin?.end({ timeout: 5 }), app?.end({ timeout: 5 }), issuer?.end({ timeout: 5 })])
  })

  it('permits only legacy adr_text planning while Step 0 is disabled', async () => {
    await admin`
      update forge_epic_172_enablement_state
      set state = 'disabled', owner_operation_id = null, exact_builds = null,
          reviewed_sha = null, epoch = null, started_at = null, expires_at = null,
          enablement_receipt_id = null, final_readiness_receipt_id = null,
          opening_authorization_id = null, controller_login_id = null,
          controller_run_id = null, controller_token_digest = null,
          lease_generation = null, last_heartbeat_at = null, lease_expires_at = null,
          state_fingerprint = 'b0789177e07f4a9307f3397a938999b6fcc8c835a97e03d2770f83e4978c2585'
      where singleton_id = 'epic-172'
    `
    try {
      await admin`
        insert into agent_runs (id, task_id, work_package_id, agent_type, model_id_used, status)
        values (${ids.legacyArchitectRun}::uuid, ${ids.task}::uuid, null, 'architect', 'test', 'completed')
      `
      await expect(app`
        insert into artifacts (agent_run_id, artifact_type, content, metadata)
        values (
          ${ids.legacyArchitectRun}::uuid, 'adr_text', 'Legacy Architect plan body',
          '{"storageMode":"legacy"}'::jsonb
        )
      `).resolves.toBeDefined()
      await expect(recordArchitectPlanVersion({
        agentRunId: ids.architectRun,
        digestKey: key,
        digestKeyId: 's4-test-key',
        planVersion: '1',
        taskId: ids.task,
        entries: [{
          agent: null, bindingFingerprint: null, content: 'Must remain blocked',
          entryId: 'plan_body:000000', entryKind: 'plan_body',
          projectionEligible: false, requirementKey: null,
        }],
      })).rejects.toMatchObject({ code: 'invalid_evidence' })
    } finally {
      await admin`
        update forge_epic_172_enablement_state
        set state = 'active', owner_operation_id = 's4-postgres-test',
            exact_builds = ${JSON.stringify([
              `issue_179_s4@${'a'.repeat(40)}`,
              `issue_180_s5@${'a'.repeat(40)}`,
              `issue_181_s6@${'a'.repeat(40)}`,
            ])}::jsonb,
            reviewed_sha = ${'a'.repeat(40)}, epoch = 2,
            enablement_receipt_id = ${ids.enablementReceipt}::uuid,
            final_readiness_receipt_id = ${ids.readinessReceipt}::uuid,
            state_fingerprint = ${'9'.repeat(64)}
        where singleton_id = 'epic-172'
      `
    }
    await expect(app`
      insert into artifacts (agent_run_id, artifact_type, content, metadata)
      values (
        ${ids.legacyArchitectRun}::uuid, 'adr_text', 'Unprotected active Architect plan body',
        '{"storageMode":"legacy"}'::jsonb
      )
    `).rejects.toMatchObject({ code: '42501' })
  })

  it('protects task-bound Architect source and burns each execution reference once', async () => {
    const recorded = await recordArchitectPlanVersion({
      agentRunId: ids.architectRun,
      digestKey: key,
      digestKeyId: 's4-test-key',
      planVersion: '1',
      taskId: ids.task,
      entries: [{
        agent: null,
        bindingFingerprint: null,
        content: 'Prior protected Architect plan body.',
        entryId: 'plan_body:000000',
        entryKind: 'plan_body',
        projectionEligible: false,
        requirementKey: null,
      }, {
        agent: 'backend',
        bindingFingerprint: SHA,
        content: 'Read only the approved bounded project context.',
        entryId: 'subtask:000001:backend',
        entryKind: 'subtask',
        projectionEligible: true,
        requirementKey: 'filesystem-context',
      }],
    })
    const [artifact] = await admin<{ content: string; metadata: Record<string, unknown> }[]>`
      select content, metadata from artifacts where id = ${recorded.artifactId}::uuid
    `
    expect(artifact).toEqual({
      content: 'Architect plan available in protected history',
      metadata: { schemaVersion: 1, stage: 'architect_plan', historyAvailable: true },
    })
    await expect(readArchitectPlanHistory({
      planVersion: '1', sessionCredential, taskId: ids.task,
    })).resolves.toEqual([expect.objectContaining({
      entryId: 'subtask:000001:backend',
      content: 'Read only the approved bounded project context.',
    })])
    const [historyAudit] = await admin<{ reads: number }[]>`
      select count(*)::integer as reads from architect_plan_history_reads
      where task_id = ${ids.task}::uuid and user_id = ${ids.user}::uuid
    `
    expect(historyAudit.reads).toBe(1)
    const packageEntry = recorded.entries.find((entry) => entry.entryKind === 'subtask')!
    const reference = executableReferenceForEntry(packageEntry)
    const [bound] = await issuer<{ referenceId: string }[]>`
      select forge.bind_architect_plan_entry_v1(
        ${ids.task}::uuid, ${ids.package}::uuid, ${ids.firstRun}::uuid,
        ${reference.planArtifactId}::uuid, ${reference.planVersion}::bigint,
        ${reference.entryId}, ${reference.contentDigest}, ${reference.digestKeyId},
        ${reference.requirementKey}, ${reference.bindingFingerprint}
      ) as "referenceId"
    `
    await expect(resolveArchitectPlanEntry({
      digestKey: key,
      reference,
      referenceId: bound.referenceId,
      taskId: ids.task,
    })).resolves.toEqual({
      content: 'Read only the approved bounded project context.',
      entryId: 'subtask:000001:backend',
    })
    await expect(resolveArchitectPlanEntry({
      digestKey: key,
      reference,
      referenceId: bound.referenceId,
      taskId: ids.task,
    })).rejects.toMatchObject({ code: 'invalid_evidence' })

    const planBody = recorded.entries.find((entry) => entry.entryKind === 'plan_body')!
    const replanReference = executableReferenceForEntry(planBody)
    const replanReferenceId = await bindArchitectReplanEntry({
      agentRunId: ids.replanRun,
      reference: replanReference,
      taskId: ids.task,
    })
    await expect(resolveArchitectPlanEntry({
      digestKey: key,
      expectedPurpose: 'architect_replan',
      reference: replanReference,
      referenceId: replanReferenceId,
      taskId: ids.task,
    })).resolves.toEqual({
      content: 'Prior protected Architect plan body.',
      entryId: 'plan_body:000000',
    })
    await expect(resolveArchitectPlanEntry({
      digestKey: key,
      expectedPurpose: 'architect_replan',
      reference: replanReference,
      referenceId: replanReferenceId,
      taskId: ids.task,
    })).rejects.toMatchObject({ code: 'invalid_evidence' })
  })

  it('resume-safely rekeys a crash-window legacy session and leaves no raw-id lookup target', async () => {
    const legacyCredential = randomUUID()
    const legacyUser = randomUUID()
    const expectedDigest = computeCredentialDigest(legacyCredential).digest
    await admin.begin(async (tx) => {
      await tx`insert into users (id, display_name) values (${legacyUser}::uuid, 'Legacy session rekey test')`
      // This is the durable state after digest backfill but before the independent
      // primary-key update. It models a statement-level migration interruption.
      await tx`
        insert into sessions (id, user_id, credential_digest_v1, expires_at)
        values (
          ${legacyCredential}::uuid, ${legacyUser}::uuid, ${expectedDigest}::bytea,
          clock_timestamp() + interval '7 days'
        )
      `
    })

    const applyRekey = () => admin`
      update sessions
      set id = gen_random_uuid()
      where credential_digest_v1 = sha256(
        convert_to('forge:web-session:v1', 'UTF8') || decode('00', 'hex') || convert_to(id::text, 'UTF8')
      )
    `
    expect((await applyRekey()).count).toBe(1)
    expect((await applyRekey()).count).toBe(0)

    const [proof] = await admin<{
      digestRows: number
      rawIdRows: number
      retainedRawIds: number
    }[]>`
      select
        count(*) filter (where credential_digest_v1 = ${expectedDigest}::bytea)::integer as "digestRows",
        count(*) filter (where id = ${legacyCredential}::uuid)::integer as "rawIdRows",
        count(*) filter (
          where credential_digest_v1 = sha256(
            convert_to('forge:web-session:v1', 'UTF8') || decode('00', 'hex') || convert_to(id::text, 'UTF8')
          )
        )::integer as "retainedRawIds"
      from sessions
    `
    expect(proof).toEqual({ digestRows: 1, rawIdRows: 0, retainedRawIds: 0 })
  })

  it('allow-once-single-winner: atomically keeps one audit and one nonce claim', async () => {
    const attempts = await Promise.allSettled([
      issuer`select forge.insert_packet_authorization_snapshot_v2(
        ${ids.firstRun}::uuid, ${ids.firstEvidence}::uuid, ${ids.decision}::uuid,
        ${ids.firstLocalClaim}::uuid, 20, array['filesystem.project.read']::text[]
      )`,
      issuer`select forge.insert_packet_authorization_snapshot_v2(
        ${ids.secondRun}::uuid, ${ids.secondEvidence}::uuid, ${ids.decision}::uuid,
        ${ids.secondLocalClaim}::uuid, 20, array['filesystem.project.read']::text[]
      )`,
    ])
    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1)
    expect(attempts.filter((attempt) => attempt.status === 'rejected')).toHaveLength(1)

    const [counts] = await admin<{ audits: number; nonceClaims: number }[]>`
      select
        count(distinct audit.id)::integer as audits,
        count(distinct claim.id)::integer as "nonceClaims"
      from filesystem_mcp_runtime_audits audit
      left join filesystem_mcp_decision_nonce_claims claim
        on claim.runtime_audit_id = audit.id
      where audit.grant_approval_id = ${ids.decision}::uuid
    `
    expect(counts).toEqual({ audits: 1, nonceClaims: 1 })
  })

  it('failure-recovery-atomicity: rolls back both audit and nonce on invalid coverage', async () => {
    const packageId = randomUUID()
    const runId = randomUUID()
    const evidenceId = randomUUID()
    const decisionId = randomUUID()
    const nonce = randomUUID()
    await admin.begin(async (tx) => {
      await tx`
        insert into work_packages (
          id, task_id, assigned_role, title, summary, sequence, status
        ) values (${packageId}::uuid, ${ids.task}::uuid, 'backend', 'Rollback package', 'bounded', 2, 'running')
      `
      await tx`
        insert into agent_runs (id, task_id, work_package_id, agent_type, model_id_used, status)
        values (${runId}::uuid, ${ids.task}::uuid, ${packageId}::uuid, 'backend', 'test', 'running')
      `
      await tx`
        insert into filesystem_mcp_grant_approvals (
          id, project_id, task_id, work_package_id, decided_by, decision,
          capabilities, effective_grant, decision_scope, grant_decision_revision,
          root_binding_revision, grant_nonce, pointer_fingerprint
        ) values (
          ${decisionId}::uuid, ${ids.project}::uuid, ${ids.task}::uuid, ${packageId}::uuid,
          ${ids.user}::uuid, 'approved', '["filesystem.project.read"]'::jsonb,
          '{}'::jsonb, 'package', 2, 1, ${nonce}::uuid, ${SHA}
        )
      `
      await tx`
        update filesystem_mcp_current_decision_pointers
        set current_decision_id = ${decisionId}::uuid,
            current_decision_task_id = ${ids.task}::uuid,
            current_decision_work_package_id = ${packageId}::uuid,
            current_decision_revision = 2, current_decision_fingerprint = ${SHA},
            pointer_fingerprint = ${SHA}, pointer_version = 1
        where work_package_id = ${packageId}::uuid
      `
      await tx`
        insert into work_package_local_run_evidence (
          id, task_id, work_package_id, agent_run_id, claim_token, lease_expires_at
        ) values (
          ${evidenceId}::uuid, ${ids.task}::uuid, ${packageId}::uuid, ${runId}::uuid,
          ${randomUUID()}::uuid, clock_timestamp() + interval '30 seconds'
        )
      `
    })

    await expect(issuer`select forge.insert_packet_authorization_snapshot_v2(
      ${runId}::uuid, ${evidenceId}::uuid, ${decisionId}::uuid,
      ${randomUUID()}::uuid, 20, array['filesystem.project.write']::text[]
    )`).rejects.toBeDefined()
    const [row] = await admin<{ audits: number; nonceClaims: number }[]>`
      select
        (select count(*)::integer from filesystem_mcp_runtime_audits
          where grant_approval_id = ${decisionId}::uuid) as audits,
        (select count(*)::integer from filesystem_mcp_decision_nonce_claims
          where grant_approval_id = ${decisionId}::uuid) as "nonceClaims"
    `
    expect(row).toEqual({ audits: 0, nonceClaims: 0 })
  })

  it('always-allow-single-run-claim: fails closed without the immutable S3 project pointer', async () => {
    const packageId = randomUUID()
    const runId = randomUUID()
    const evidenceId = randomUUID()
    const decisionId = randomUUID()
    const claimToken = randomUUID()
    await admin.begin(async (tx) => {
      await tx`
        insert into work_packages (
          id, task_id, assigned_role, title, summary, sequence, status
        ) values (${packageId}::uuid, ${ids.task}::uuid, 'backend', 'Project grant package', 'bounded', 3, 'running')
      `
      await tx`
        insert into agent_runs (id, task_id, work_package_id, agent_type, model_id_used, status)
        values (${runId}::uuid, ${ids.task}::uuid, ${packageId}::uuid, 'backend', 'test', 'running')
      `
      await tx`
        insert into project_filesystem_grant_decisions (
          id, project_id, decision, capabilities, grant_decision_revision,
          root_binding_revision, decision_fingerprint, decision_generation, decided_by
        ) values (
          ${decisionId}::uuid, ${ids.project}::uuid, 'approved',
          '["filesystem.project.read"]'::jsonb, 3, 1, ${SHA}, 1, ${ids.user}::uuid
        )
      `
      await tx`
        insert into work_package_local_run_evidence (
          id, task_id, work_package_id, agent_run_id, claim_token, lease_expires_at
        ) values (
          ${evidenceId}::uuid, ${ids.task}::uuid, ${packageId}::uuid, ${runId}::uuid,
          ${claimToken}::uuid, clock_timestamp() + interval '30 seconds'
        )
      `
    })

    await expect(issuer`select forge.insert_packet_authorization_snapshot_v2(
      ${runId}::uuid, ${evidenceId}::uuid, ${decisionId}::uuid,
      ${claimToken}::uuid, 20, array['filesystem.project.read']::text[]
    )`).rejects.toMatchObject({ code: '55000' })
    const [row] = await admin<{ audits: number }[]>`
      select count(*)::integer as audits from filesystem_mcp_runtime_audits
      where project_decision_id = ${decisionId}::uuid
    `
    expect(row.audits).toBe(0)
  })

  it('typed-writer-boundary: rejects a direct v2 audit before partial evidence exists', async () => {
    await expect(admin`
      insert into filesystem_mcp_runtime_audits (task_id, status, protocol_version)
      values (${ids.task}::uuid, 'claiming', 2)
    `).rejects.toMatchObject({ code: '42501' })
    const [row] = await admin<{ malformed: number }[]>`
      select count(*)::integer as malformed
      from filesystem_mcp_runtime_audits
      where protocol_version = 2 and authorization_snapshot is null
    `
    expect(row.malformed).toBe(0)
  })

  it('creates local evidence only through the running-run fixed principal', async () => {
    const packageId = randomUUID()
    const runId = randomUUID()
    const claimToken = randomUUID()
    await admin.begin(async (tx) => {
      await tx`
        insert into work_packages (id, task_id, assigned_role, title, summary, sequence, status)
        values (${packageId}::uuid, ${ids.task}::uuid, 'backend', 'Fixed writer package', 'bounded', 4, 'running')
      `
      await tx`
        insert into agent_runs (id, task_id, work_package_id, agent_type, model_id_used, status)
        values (${runId}::uuid, ${ids.task}::uuid, ${packageId}::uuid, 'backend', 'test', 'running')
      `
    })
    const [created] = await issuer<{ evidenceId: string }[]>`
      select forge.create_local_run_evidence_v1(
        ${runId}::uuid, ${claimToken}::uuid, 30
      ) as "evidenceId"
    `
    const [row] = await admin<{ agentRunId: string; state: string }[]>`
      select agent_run_id as "agentRunId", state
      from work_package_local_run_evidence where id = ${created.evidenceId}::uuid
    `
    expect(row).toEqual({ agentRunId: runId, state: 'claimed' })
  })

})
