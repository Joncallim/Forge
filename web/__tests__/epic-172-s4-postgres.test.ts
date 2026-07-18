import { randomBytes, randomUUID } from 'node:crypto'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  executableReferenceForEntry,
  recordArchitectPlanVersion,
  resolveArchitectPlanEntry,
} from '@/lib/mcps/s4-protocol-store'

const adminUrl = process.env.FORGE_S4_POSTGRES_TEST_DATABASE_URL?.trim()
const issuerUrl = process.env.FORGE_PACKET_ISSUER_DATABASE_URL?.trim()
const writerUrl = process.env.FORGE_ARCHITECT_PLAN_WRITER_DATABASE_URL?.trim()
const resolverUrl = process.env.FORGE_ARCHITECT_PLAN_RESOLVER_DATABASE_URL?.trim()
const enabled = Boolean(adminUrl && issuerUrl && writerUrl && resolverUrl)
const requirePostgresFixture = process.env.FORGE_S4_REQUIRE_POSTGRES_TEST === '1'
const SHA = `sha256:${'a'.repeat(64)}`

if (requirePostgresFixture && !enabled) {
  throw new Error(
    'FORGE_S4_REQUIRE_POSTGRES_TEST=1 requires the S4 administrator, packet issuer, Architect plan writer, and Architect plan resolver PostgreSQL URLs; the explicit contract suite may not skip.',
  )
}

describe.skipIf(!enabled)('Epic 172 S4 PostgreSQL boundaries', () => {
  const ids = {
    user: randomUUID(),
    project: randomUUID(),
    task: randomUUID(),
    package: randomUUID(),
    architectRun: randomUUID(),
    firstRun: randomUUID(),
    secondRun: randomUUID(),
    firstEvidence: randomUUID(),
    secondEvidence: randomUUID(),
    firstLocalClaim: randomUUID(),
    secondLocalClaim: randomUUID(),
    decision: randomUUID(),
    nonce: randomUUID(),
  }
  const key = randomBytes(32)
  let admin: ReturnType<typeof postgres>
  let issuer: ReturnType<typeof postgres>

  beforeAll(async () => {
    process.env.FORGE_ARCHITECT_PLAN_WRITER_DATABASE_URL = writerUrl!
    process.env.FORGE_ARCHITECT_PLAN_RESOLVER_DATABASE_URL = resolverUrl!
    admin = postgres(adminUrl!, { max: 1, onnotice: () => {} })
    issuer = postgres(issuerUrl!, { max: 2, onnotice: () => {} })

    await admin.begin(async (tx) => {
      await tx`insert into users (id, display_name) values (${ids.user}::uuid, 'S4 PostgreSQL test')`
      await tx`
        insert into projects (
          id, name, submitted_by, grant_decision_revision, root_binding_revision
        ) values (${ids.project}::uuid, 'S4 PostgreSQL test', ${ids.user}::uuid, 1, 1)
      `
      await tx`
        insert into tasks (id, project_id, submitted_by, title, prompt)
        values (${ids.task}::uuid, ${ids.project}::uuid, ${ids.user}::uuid, 'S4 test', 'protected')
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
        update epic_172_s4_protocol_state
        set producers_enabled = true, protocol_epoch = 2,
            enabled_build_sha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
        where singleton
      `
    })
  })

  afterAll(async () => {
    await Promise.all([admin?.end({ timeout: 5 }), issuer?.end({ timeout: 5 })])
  })

  it('protects task-bound Architect source and burns each execution reference once', async () => {
    const recorded = await recordArchitectPlanVersion({
      agentRunId: ids.architectRun,
      digestKey: key,
      digestKeyId: 's4-test-key',
      planVersion: '1',
      taskId: ids.task,
      entries: [{
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
    const reference = executableReferenceForEntry(recorded.entries[0])
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
})
