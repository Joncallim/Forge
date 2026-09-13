import { randomUUID } from 'node:crypto'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const required = process.env.FORGE_VNEXT_RUNTIME_REQUIRE_POSTGRES_TEST === '1'
const appUrl = process.env.FORGE_VNEXT_RUNTIME_POSTGRES_APP_TEST_URL?.trim()
const adminUrl = process.env.FORGE_VNEXT_RUNTIME_POSTGRES_ADMIN_TEST_URL?.trim()
const enabled = Boolean(appUrl && adminUrl)

if (required && !enabled) {
  throw new Error('FORGE_VNEXT_RUNTIME_REQUIRE_POSTGRES_TEST=1 requires disposable app and administrator PostgreSQL URLs.')
}

describe.skipIf(!enabled)('VNext runtime protected PostgreSQL foundation', () => {
  let app: ReturnType<typeof postgres>
  let admin: ReturnType<typeof postgres>
  const actor = randomUUID()
  const otherActor = randomUUID()
  const mission = randomUUID()
  const execution = randomUUID()
  const digest = 'a'.repeat(64)

  async function create(): Promise<void> {
    await app`
      select * from forge.create_vnext_mission_v1(
        ${mission}::uuid, ${execution}::uuid, null::uuid, ${actor}::uuid,
        ${digest}, ${digest}, ${app.json({ version: 'v1', workflowRevision: 'zero-capability-v1', policyRevision: 'zero-capability-v1', budgetEnvelopeRevision: 'zero-capability-v1', compatibilityMode: 'software_engineering_legacy_v1' })},
        'zero-capability-v1', ${app.json([])}, 'mission.created'
      )
    `
  }

  beforeAll(async () => {
    app = postgres(appUrl!, { max: 4, onnotice: () => {} })
    admin = postgres(adminUrl!, { max: 1, onnotice: () => {} })
    await admin`insert into users (id, display_name) values (${actor}::uuid, 'runtime owner'), (${otherActor}::uuid, 'other runtime owner')`
  })
  afterAll(async () => { await app?.end({ timeout: 5 }); await admin?.end({ timeout: 5 }) })

  it('denies direct app DML but permits the protected atomic creator', async () => {
    await expect(app`insert into missions (id, owner_principal_type, owner_principal_id, desired_outcome_digest, constraints_digest, compatibility_pins) values (${randomUUID()}::uuid, 'operator', ${actor}::uuid, ${digest}, ${digest}, '{}'::jsonb)`).rejects.toMatchObject({ code: '42501' })
    const projectId = randomUUID()
    const taskId = randomUUID()
    await admin`insert into projects (id, name, submitted_by) values (${projectId}::uuid, 'runtime task-owner hostile fixture', ${actor}::uuid)`
    await admin`insert into tasks (id, project_id, submitted_by, title, prompt) values (${taskId}::uuid, ${projectId}::uuid, ${otherActor}::uuid, 'runtime task-owner hostile fixture', 'runtime task-owner hostile fixture')`
    await expect(app`
      select * from forge.create_vnext_mission_v1(
        ${randomUUID()}::uuid, ${randomUUID()}::uuid, ${taskId}::uuid, ${actor}::uuid,
        ${digest}, ${digest}, ${app.json({ version: 'v1', workflowRevision: 'zero-capability-v1', policyRevision: 'zero-capability-v1', budgetEnvelopeRevision: 'zero-capability-v1', compatibilityMode: 'software_engineering_legacy_v1' })},
        'zero-capability-v1', ${app.json([])}, 'mission.created'
      )
    `).rejects.toMatchObject({ code: '22023' })
    await expect(app`
      select * from forge.create_vnext_mission_v1(
        ${randomUUID()}::uuid, ${randomUUID()}::uuid, null::uuid, ${actor}::uuid,
        ${digest}, ${digest}, ${app.json({ version: 'v1', workflowRevision: 'zero-capability-v1', policyRevision: 'zero-capability-v1', budgetEnvelopeRevision: 'zero-capability-v1', compatibilityMode: 'software_engineering_legacy_v1' })},
        'zero-capability-v1', ${app.json([{ version: 'v1', resource: { version: 'v1', id: null, type: 'service', revision: '1', classification: 'unknown' }, selectorDigest: digest, provenance: 'system' }])}, 'mission.created'
      )
    `).rejects.toMatchObject({ code: '22023' })
    await expect(app`
      select * from forge.create_vnext_mission_v1(
        ${randomUUID()}::uuid, ${randomUUID()}::uuid, null::uuid, ${actor}::uuid,
        ${digest}, ${digest}, ${app.json({ version: 'v1', workflowRevision: 'zero-capability-v1', policyRevision: 'zero-capability-v1', budgetEnvelopeRevision: 'zero-capability-v1', compatibilityMode: 'software_engineering_legacy_v1' })},
        'zero-capability-v1', 'true'::jsonb, 'mission.created'
      )
    `).rejects.toMatchObject({ code: '22023' })
    await expect(app`
      select * from forge.create_vnext_mission_v1(
        ${randomUUID()}::uuid, ${randomUUID()}::uuid, null::uuid, ${actor}::uuid,
        ${digest}, ${digest}, ${app.json({ version: 'v1', workflowRevision: 'zero-capability-v1', policyRevision: 'zero-capability-v1', budgetEnvelopeRevision: 'zero-capability-v1', compatibilityMode: 'software_engineering_legacy_v1', unexpected: 'reject' })},
        'zero-capability-v1', ${app.json([])}, 'mission.created'
      )
    `).rejects.toMatchObject({ code: '22023' })
    await create()
    const rows = await admin<{ missionAuditCount: string; executionAuditCount: string }[]>`
      select
        count(*) filter (where entity_kind = 'mission')::text as "missionAuditCount",
        count(*) filter (where entity_kind = 'execution')::text as "executionAuditCount"
      from runtime_transition_audits where entity_id in (${mission}::uuid, ${execution}::uuid)
    `
    expect(rows[0]).toEqual({ missionAuditCount: '1', executionAuditCount: '1' })
  })

  it('uses CAS so concurrent terminal transitions produce one audit revision', async () => {
    await expect(app`select * from forge.transition_vnext_execution_v1(${execution}::uuid, 0::bigint, 'running', null, null, ${actor}::uuid, 'execution.running', null)`).rejects.toMatchObject({ code: 'P3346' })
    await expect(app`select * from forge.transition_vnext_execution_v1(${execution}::uuid, 0::bigint, 'terminal', 'cancelled', null, ${otherActor}::uuid, 'execution.cancelled', null)`).rejects.toMatchObject({ code: 'P3345' })
    const transition = () => app`select * from forge.transition_vnext_execution_v1(${execution}::uuid, 0::bigint, 'terminal', 'cancelled', null, ${actor}::uuid, 'execution.cancelled', null)`
    const results = await Promise.allSettled([transition(), transition()])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
    await expect(app`select * from forge.transition_vnext_execution_v1(${execution}::uuid, 1::bigint, 'terminal', 'failed', null, ${actor}::uuid, 'execution.failed', null)`).rejects.toMatchObject({ code: 'P3344' })
    const audits = await admin`select resulting_revision, reason_code from runtime_transition_audits where entity_kind = 'execution' and entity_id = ${execution}::uuid order by resulting_revision`
    expect(audits).toHaveLength(2)
    expect(audits.map((row) => row.resulting_revision)).toEqual(['0', '1'])
  })

  it('persists, loads, and legally transitions a project-less Mission with atomic audits', async () => {
    const projectlessMission = randomUUID()
    const projectlessExecution = randomUUID()
    await app`
      select * from forge.create_vnext_mission_v1(
        ${projectlessMission}::uuid, ${projectlessExecution}::uuid, null::uuid, ${actor}::uuid,
        ${digest}, ${digest}, ${app.json({ version: 'v1', workflowRevision: 'zero-capability-v1', policyRevision: 'zero-capability-v1', budgetEnvelopeRevision: 'zero-capability-v1', compatibilityMode: 'software_engineering_legacy_v1' })},
        'zero-capability-v1', ${app.json([])}, 'mission.created'
      )
    `
    const [created] = await app`select lifecycle_state, outcome, state_revision::text as revision, task_id from missions left join task_mission_bindings on task_mission_bindings.mission_id=missions.id where missions.id=${projectlessMission}::uuid`
    expect(created).toEqual({ lifecycle_state: 'draft', outcome: null, revision: '0', task_id: null })
    await app`select * from forge.transition_vnext_mission_v1(${projectlessMission}::uuid, 0::bigint, 'active', null, ${actor}::uuid, 'mission.activated', null)`
    await expect(app`select * from forge.transition_vnext_mission_v1(${projectlessMission}::uuid, 1::bigint, 'waiting', null, ${actor}::uuid, 'mission.waiting', null)`).rejects.toMatchObject({ code: 'P3347' })
    for (const [from, to, revision, reason] of [
      ['created', 'admitted', 0, 'execution.admitted'],
      ['admitted', 'queued', 1, 'execution.queued'],
      ['queued', 'leased', 2, 'execution.leased'],
      ['leased', 'running', 3, 'execution.running'],
      ['running', 'waiting', 4, 'execution.waiting'],
      ['waiting', 'terminal', 5, 'execution.succeeded'],
    ] as const) {
      await app`select * from forge.transition_vnext_execution_v1(${projectlessExecution}::uuid, ${revision}::bigint, ${to}, ${to === 'terminal' ? 'succeeded' : null}, null, ${actor}::uuid, ${reason}, null)`
      void from
    }
    await app`select * from forge.transition_vnext_mission_v1(${projectlessMission}::uuid, 1::bigint, 'waiting', null, ${actor}::uuid, 'mission.waiting', null)`
    await app`select * from forge.transition_vnext_mission_v1(${projectlessMission}::uuid, 2::bigint, 'active', null, ${actor}::uuid, 'mission.activated', null)`
    await app`select * from forge.transition_vnext_mission_v1(${projectlessMission}::uuid, 3::bigint, 'terminal', 'succeeded', ${actor}::uuid, 'mission.succeeded', null)`
    await expect(app`select * from forge.transition_vnext_execution_v1(${projectlessExecution}::uuid, 6::bigint, 'terminal', 'failed', null, ${actor}::uuid, 'execution.failed', null)`).rejects.toMatchObject({ code: 'P3348' })
    const audits = await admin`select entity_kind, resulting_revision, occurred_at from runtime_transition_audits where entity_id in (${projectlessMission}::uuid, ${projectlessExecution}::uuid) order by occurred_at, resulting_revision`
    expect(audits.length).toBe(12)
    expect(audits.every((audit) => audit.occurred_at instanceof Date || typeof audit.occurred_at === 'string')).toBe(true)
  })

  it('serializes Mission waiting against an active Execution instead of admitting an invalid interleaving', async () => {
    const concurrentMission = randomUUID()
    const concurrentExecution = randomUUID()
    await app`
      select * from forge.create_vnext_mission_v1(
        ${concurrentMission}::uuid, ${concurrentExecution}::uuid, null::uuid, ${actor}::uuid,
        ${digest}, ${digest}, ${app.json({ version: 'v1', workflowRevision: 'zero-capability-v1', policyRevision: 'zero-capability-v1', budgetEnvelopeRevision: 'zero-capability-v1', compatibilityMode: 'software_engineering_legacy_v1' })},
        'zero-capability-v1', ${app.json([])}, 'mission.created'
      )
    `
    await app`select * from forge.transition_vnext_mission_v1(${concurrentMission}::uuid, 0::bigint, 'active', null, ${actor}::uuid, 'mission.activated', null)`
    const wait = () => app`select * from forge.transition_vnext_mission_v1(${concurrentMission}::uuid, 1::bigint, 'waiting', null, ${actor}::uuid, 'mission.waiting', null)`
    const terminalize = () => app`select * from forge.transition_vnext_execution_v1(${concurrentExecution}::uuid, 0::bigint, 'terminal', 'cancelled', null, ${actor}::uuid, 'execution.cancelled', null)`
    const results = await Promise.allSettled([wait(), terminalize()])
    expect(results.filter((result) => result.status === 'fulfilled').length).toBeGreaterThanOrEqual(1)
    const [state] = await admin<{ missionState: string; executionState: string }[]>`
      select mission.lifecycle_state as "missionState", execution.lifecycle_state as "executionState"
      from missions mission join executions execution on execution.mission_id = mission.id
      where mission.id = ${concurrentMission}::uuid
    `
    expect(state).not.toEqual({ missionState: 'waiting', executionState: 'created' })
    expect(state).not.toEqual({ missionState: 'terminal', executionState: 'created' })
  })

  it('stores only typed reasons and safe digests in the authoritative audit shape', async () => {
    const columns = await admin<{ column_name: string }[]>`
      select column_name from information_schema.columns
      where table_schema = 'public' and table_name = 'runtime_transition_audits'
    `
    expect(columns.map((column) => column.column_name)).not.toEqual(expect.arrayContaining(['prompt', 'title', 'local_path', 'error_message']))
  })
})
