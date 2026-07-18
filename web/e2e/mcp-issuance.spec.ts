import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import postgres from 'postgres'
import { applyEpic172Step0E2EBridge } from './epic-172-step0-bridge'

const SHA = `sha256:${'a'.repeat(64)}`

function requiredUrl(name: 'FORGE_PACKET_ISSUER_DATABASE_URL' | 'FORGE_S4_POSTGRES_TEST_DATABASE_URL'): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required for the manifest-bound issuance suite.`)
  return value
}

function clients() {
  return {
    admin: postgres(requiredUrl('FORGE_S4_POSTGRES_TEST_DATABASE_URL'), { max: 1, onnotice: () => {} }),
    issuer: postgres(requiredUrl('FORGE_PACKET_ISSUER_DATABASE_URL'), { max: 2, onnotice: () => {} }),
  }
}

type ProtocolState = {
  enabledBuildSha: string | null
  producersEnabled: boolean
  protocolEpoch: string
}

async function captureProtocolState(admin: ReturnType<typeof postgres>): Promise<ProtocolState> {
  const [state] = await admin<ProtocolState[]>`
    select producers_enabled as "producersEnabled",
           protocol_epoch::text as "protocolEpoch",
           enabled_build_sha as "enabledBuildSha"
    from epic_172_s4_protocol_state
    where singleton
  `
  if (!state) throw new Error('The S4 protocol singleton is missing.')
  return state
}

async function restoreProtocolState(
  admin: ReturnType<typeof postgres>,
  state: ProtocolState,
): Promise<void> {
  await admin`
    update epic_172_s4_protocol_state
    set producers_enabled = ${state.producersEnabled},
        protocol_epoch = ${state.protocolEpoch}::bigint,
        enabled_build_sha = ${state.enabledBuildSha}
    where singleton
  `
}

async function closeClients(
  admin: ReturnType<typeof postgres>,
  issuer: ReturnType<typeof postgres>,
  protocolState: ProtocolState,
): Promise<void> {
  try {
    await restoreProtocolState(admin, protocolState)
  } finally {
    await Promise.all([admin.end({ timeout: 5 }), issuer.end({ timeout: 5 })])
  }
}

async function seedBase(admin: ReturnType<typeof postgres>) {
  const ids = {
    project: randomUUID(),
    task: randomUUID(),
    user: randomUUID(),
  }
  await admin.begin(async (tx) => {
    await tx`insert into users (id, display_name) values (${ids.user}::uuid, 'S6 issuance operator')`
    await tx`
      insert into projects (
        id, name, submitted_by, grant_decision_revision, root_binding_revision
      ) values (${ids.project}::uuid, 'S6 issuance project', ${ids.user}::uuid, 1, 1)
    `
    await tx`
      insert into tasks (id, project_id, submitted_by, title, prompt, status)
      values (
        ${ids.task}::uuid, ${ids.project}::uuid, ${ids.user}::uuid,
        'S6 issuance task', 'protected', 'running'
      )
    `
    await tx`
      update epic_172_s4_protocol_state
      set producers_enabled = true, protocol_epoch = 2,
          enabled_build_sha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
      where singleton
    `
  })
  return ids
}

async function seedPackageRun(
  admin: ReturnType<typeof postgres>,
  input: { packageId?: string; sequence: number; taskId: string },
) {
  const ids = {
    claim: randomUUID(),
    evidence: randomUUID(),
    package: input.packageId ?? randomUUID(),
    run: randomUUID(),
  }
  await admin.begin(async (tx) => {
    if (!input.packageId) {
      await tx`
        insert into work_packages (
          id, task_id, assigned_role, title, summary, sequence, status
        ) values (
          ${ids.package}::uuid, ${input.taskId}::uuid, 'backend',
          'S6 issuance package', 'bounded', ${input.sequence}, 'running'
        )
      `
    }
    await tx`
      insert into agent_runs (id, task_id, work_package_id, agent_type, model_id_used, status)
      values (${ids.run}::uuid, ${input.taskId}::uuid, ${ids.package}::uuid, 'backend', 'test', 'running')
    `
    await tx`
      insert into work_package_local_run_evidence (
        id, task_id, work_package_id, agent_run_id, claim_token, lease_expires_at
      ) values (
        ${ids.evidence}::uuid, ${input.taskId}::uuid, ${ids.package}::uuid,
        ${ids.run}::uuid, ${ids.claim}::uuid, clock_timestamp() + interval '45 seconds'
      )
    `
  })
  return ids
}

async function insertPackageDecision(
  admin: ReturnType<typeof postgres>,
  input: {
    decisionRevision: number
    packageId: string
    projectId: string
    taskId: string
    userId: string
  },
) {
  const decisionId = randomUUID()
  await admin.begin(async (tx) => {
    await tx`
      insert into filesystem_mcp_grant_approvals (
        id, project_id, task_id, work_package_id, decided_by, decision,
        capabilities, effective_grant, decision_scope, grant_decision_revision,
        root_binding_revision, grant_nonce, pointer_fingerprint
      ) values (
        ${decisionId}::uuid, ${input.projectId}::uuid, ${input.taskId}::uuid,
        ${input.packageId}::uuid, ${input.userId}::uuid, 'approved',
        '["filesystem.project.read"]'::jsonb, '{}'::jsonb, 'package',
        ${input.decisionRevision}, 1, ${randomUUID()}::uuid, ${SHA}
      )
    `
    await tx`
      update filesystem_mcp_current_decision_pointers
      set current_decision_id = ${decisionId}::uuid,
          current_decision_task_id = ${input.taskId}::uuid,
          current_decision_work_package_id = ${input.packageId}::uuid,
          current_decision_revision = ${input.decisionRevision},
          current_decision_fingerprint = ${SHA},
          pointer_fingerprint = ${SHA}, pointer_version = 1
      where work_package_id = ${input.packageId}::uuid
    `
  })
  return decisionId
}

test.describe('Epic 172 manifest-bound packet issuance', () => {
  test.describe.configure({ mode: 'serial', retries: 0 })

  test.beforeEach(async ({}, testInfo) => {
    applyEpic172Step0E2EBridge(testInfo, 'mcp-issuance.spec.ts')
  })

  test('mcp-admission.allow-once-single-winner', {
    tag: '@mcp-issuance',
    annotation: { type: 'scenarioId', description: 'mcp-admission.allow-once-single-winner' },
  }, async () => {
    const { admin, issuer } = clients()
    const protocolState = await captureProtocolState(admin)
    try {
      const base = await seedBase(admin)
      const first = await seedPackageRun(admin, { sequence: 1, taskId: base.task })
      const second = await seedPackageRun(admin, {
        packageId: first.package,
        sequence: 1,
        taskId: base.task,
      })
      const decisionId = await insertPackageDecision(admin, {
        decisionRevision: 1,
        packageId: first.package,
        projectId: base.project,
        taskId: base.task,
        userId: base.user,
      })
      const attempts = await Promise.allSettled([
        issuer`select forge.insert_packet_authorization_snapshot_v2(
          ${first.run}::uuid, ${first.evidence}::uuid, ${decisionId}::uuid,
          ${first.claim}::uuid, 20, array['filesystem.project.read']::text[]
        )`,
        issuer`select forge.insert_packet_authorization_snapshot_v2(
          ${second.run}::uuid, ${second.evidence}::uuid, ${decisionId}::uuid,
          ${second.claim}::uuid, 20, array['filesystem.project.read']::text[]
        )`,
      ])
      expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1)
      expect(attempts.filter((attempt) => attempt.status === 'rejected')).toHaveLength(1)
      const [counts] = await admin<{ audits: number; nonceClaims: number }[]>`
        select
          count(distinct audit.id)::integer as audits,
          count(distinct claim.id)::integer as "nonceClaims"
        from filesystem_mcp_runtime_audits audit
        left join filesystem_mcp_decision_nonce_claims claim on claim.runtime_audit_id = audit.id
        where audit.grant_approval_id = ${decisionId}::uuid
      `
      expect(counts).toEqual({ audits: 1, nonceClaims: 1 })
    } finally {
      await closeClients(admin, issuer, protocolState)
    }
  })

  test('mcp-admission.always-allow-single-run-claim', {
    tag: '@mcp-issuance',
    annotation: { type: 'scenarioId', description: 'mcp-admission.always-allow-single-run-claim' },
  }, async () => {
    const { admin, issuer } = clients()
    const protocolState = await captureProtocolState(admin)
    try {
      const base = await seedBase(admin)
      const run = await seedPackageRun(admin, { sequence: 1, taskId: base.task })
      const decisionId = randomUUID()
      await admin.begin(async (tx) => {
        await tx`
          insert into project_filesystem_grant_decisions (
            id, project_id, decision, capabilities, grant_decision_revision,
            root_binding_revision, decision_fingerprint, decision_generation, decided_by
          ) values (
            ${decisionId}::uuid, ${base.project}::uuid, 'approved',
            '["filesystem.project.read"]'::jsonb, 1, 1, ${SHA}, 1, ${base.user}::uuid
          )
        `
        await tx`
          update project_filesystem_current_decision_pointers
          set current_decision_id = ${decisionId}::uuid,
              current_decision_project_id = ${base.project}::uuid,
              current_decision_revision = 1, current_root_binding_revision = 1,
              current_decision_fingerprint = ${SHA}, current_decision_generation = 1,
              pointer_generation = 1
          where project_id = ${base.project}::uuid
        `
      })

      const issue = () => issuer`select forge.insert_packet_authorization_snapshot_v2(
        ${run.run}::uuid, ${run.evidence}::uuid, ${decisionId}::uuid,
        ${run.claim}::uuid, 20, array['filesystem.project.read']::text[]
      )`
      const attempts = await Promise.allSettled([issue(), issue()])
      expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1)
      expect(attempts.filter((attempt) => attempt.status === 'rejected')).toHaveLength(1)
      const [counts] = await admin<{ audits: number; nonceClaims: number }[]>`
        select
          (select count(*)::integer from filesystem_mcp_runtime_audits
            where project_decision_id = ${decisionId}::uuid) as audits,
          (select count(*)::integer from filesystem_mcp_decision_nonce_claims claim
            join filesystem_mcp_runtime_audits audit on audit.id = claim.runtime_audit_id
            where audit.project_decision_id = ${decisionId}::uuid) as "nonceClaims"
      `
      expect(counts).toEqual({ audits: 1, nonceClaims: 0 })
    } finally {
      await closeClients(admin, issuer, protocolState)
    }
  })

  test('mcp-admission.failure-recovery-atomicity', {
    tag: '@mcp-issuance',
    annotation: { type: 'scenarioId', description: 'mcp-admission.failure-recovery-atomicity' },
  }, async () => {
    const { admin, issuer } = clients()
    const protocolState = await captureProtocolState(admin)
    try {
      const base = await seedBase(admin)
      const run = await seedPackageRun(admin, { sequence: 1, taskId: base.task })
      const decisionId = await insertPackageDecision(admin, {
        decisionRevision: 1,
        packageId: run.package,
        projectId: base.project,
        taskId: base.task,
        userId: base.user,
      })
      await expect(issuer`select forge.insert_packet_authorization_snapshot_v2(
        ${run.run}::uuid, ${run.evidence}::uuid, ${decisionId}::uuid,
        ${run.claim}::uuid, 20, array['filesystem.project.write']::text[]
      )`).rejects.toBeDefined()
      const [counts] = await admin<{ audits: number; nonceClaims: number }[]>`
        select
          (select count(*)::integer from filesystem_mcp_runtime_audits
            where grant_approval_id = ${decisionId}::uuid) as audits,
          (select count(*)::integer from filesystem_mcp_decision_nonce_claims
            where grant_approval_id = ${decisionId}::uuid) as "nonceClaims"
      `
      expect(counts).toEqual({ audits: 0, nonceClaims: 0 })
    } finally {
      await closeClients(admin, issuer, protocolState)
    }
  })
})
