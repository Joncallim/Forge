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
        ${mission}::uuid, ${execution}::uuid, ${actor}::uuid,
        ${digest}, ${digest}, ${JSON.stringify({ version: 'v1', workflowRevision: 'zero-capability-v1', policyRevision: 'zero-capability-v1', budgetEnvelopeRevision: 'zero-capability-v1' })}::jsonb,
        'zero-capability-v1', '[]'::jsonb, 'vnext.mission.created'
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
    await expect(app`select * from forge.transition_vnext_execution_v1(${execution}::uuid, 0::bigint, 'running', null, null, ${actor}::uuid, 'vnext.execution.running', null)`).rejects.toMatchObject({ code: 'P3346' })
    await expect(app`select * from forge.transition_vnext_execution_v1(${execution}::uuid, 0::bigint, 'terminal', 'cancelled', null, ${otherActor}::uuid, 'vnext.execution.cancelled', null)`).rejects.toMatchObject({ code: 'P3345' })
    const transition = () => app`select * from forge.transition_vnext_execution_v1(${execution}::uuid, 0::bigint, 'terminal', 'cancelled', null, ${actor}::uuid, 'vnext.execution.cancelled', null)`
    const results = await Promise.allSettled([transition(), transition()])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
    await expect(app`select * from forge.transition_vnext_execution_v1(${execution}::uuid, 1::bigint, 'terminal', 'failed', null, ${actor}::uuid, 'vnext.execution.failed', null)`).rejects.toMatchObject({ code: 'P3344' })
    const audits = await admin`select resulting_revision, reason_code from runtime_transition_audits where entity_kind = 'execution' and entity_id = ${execution}::uuid order by resulting_revision`
    expect(audits).toHaveLength(2)
    expect(audits.map((row) => row.resulting_revision)).toEqual(['0', '1'])
  })

  it('stores only typed reasons and safe digests in the authoritative audit shape', async () => {
    const columns = await admin<{ column_name: string }[]>`
      select column_name from information_schema.columns
      where table_schema = 'public' and table_name = 'runtime_transition_audits'
    `
    expect(columns.map((column) => column.column_name)).not.toEqual(expect.arrayContaining(['prompt', 'title', 'local_path', 'error_message']))
  })
})
