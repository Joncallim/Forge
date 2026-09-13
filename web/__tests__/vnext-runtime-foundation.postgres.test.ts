import { randomUUID } from 'node:crypto'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { computeCredentialDigest } from '@/lib/session-credential-digest'

const required = process.env.FORGE_VNEXT_RUNTIME_REQUIRE_POSTGRES_TEST === '1'
const appUrl = process.env.FORGE_VNEXT_RUNTIME_POSTGRES_APP_TEST_URL?.trim()
const apiUrl = process.env.FORGE_VNEXT_RUNTIME_POSTGRES_API_TEST_URL?.trim()
const adminUrl = process.env.FORGE_VNEXT_RUNTIME_POSTGRES_ADMIN_TEST_URL?.trim()
const enabled = Boolean(appUrl && apiUrl && adminUrl)

if (required && !enabled) throw new Error('FORGE_VNEXT_RUNTIME_REQUIRE_POSTGRES_TEST=1 requires disposable legacy-app, runtime-API, and administrator PostgreSQL URLs.')

describe.skipIf(!enabled)('VNext runtime session authority', () => {
  let api: ReturnType<typeof postgres>
  let legacy: ReturnType<typeof postgres>
  let admin: ReturnType<typeof postgres>
  const actor = randomUUID()
  const otherActor = randomUUID()
  const credential = randomUUID()
  const otherCredential = randomUUID()
  const digest = 'a'.repeat(64)

  const generic = (sessionCredential: string, mission = randomUUID(), execution = randomUUID()) => api`
    select * from forge.create_vnext_generic_zero_mission_v1(${Buffer.from(sessionCredential, 'ascii')}::bytea, ${mission}::uuid, ${execution}::uuid, ${digest}, ${digest})
  `

  beforeAll(async () => {
    api = postgres(apiUrl!, { max: 4, onnotice: () => {} })
    legacy = postgres(appUrl!, { max: 2, onnotice: () => {} })
    admin = postgres(adminUrl!, { max: 1, onnotice: () => {} })
    await admin`insert into users (id, display_name) values (${actor}::uuid, 'runtime owner'), (${otherActor}::uuid, 'other runtime owner')`
    await admin`insert into sessions (user_id, credential_digest_v1, expires_at, credential_storage_version) values (${actor}::uuid, ${computeCredentialDigest(credential).digest}, clock_timestamp() + interval '1 hour', 1), (${otherActor}::uuid, ${computeCredentialDigest(otherCredential).digest}, clock_timestamp() + interval '1 hour', 1)`
  })
  afterAll(async () => { await legacy?.end({ timeout: 5 }); await api?.end({ timeout: 5 }); await admin?.end({ timeout: 5 }) })

  it('[scenarioId=vnext.a1.protected-postgres] exposes neither protected tables nor caller-shaped routines to either app role', async () => {
    await expect(legacy`insert into missions (id, owner_principal_type, owner_principal_id, desired_outcome_digest, constraints_digest, compatibility_pins) values (${randomUUID()}::uuid, 'operator', ${actor}::uuid, ${digest}, ${digest}, '{}'::jsonb)`).rejects.toMatchObject({ code: '42501' })
    await expect(api`select * from forge.create_vnext_mission_v1(${randomUUID()}::uuid, ${randomUUID()}::uuid, null::uuid, ${actor}::uuid, ${digest}, ${digest}, '{}'::jsonb, 'rev:v1:forged', '[]'::jsonb, 'mission.created')`).rejects.toMatchObject({ code: '42501' })
    const [acl] = await admin<{ apiRead: boolean; apiCreate: boolean; apiResolver: boolean; legacyCreate: boolean }[]>`
      select pg_catalog.has_table_privilege('forge_runtime_api_login', 'public.missions', 'select') as "apiRead",
        pg_catalog.has_function_privilege('forge_runtime_api_login', 'forge.create_vnext_generic_zero_mission_v1(bytea,uuid,uuid,text,text)'::regprocedure, 'execute') as "apiCreate",
        pg_catalog.has_function_privilege('forge_runtime_api_login', 'forge.resolve_vnext_operator_session_v1(bytea)'::regprocedure, 'execute') as "apiResolver",
        pg_catalog.has_function_privilege('forge', 'forge.create_vnext_generic_zero_mission_v1(bytea,uuid,uuid,text,text)'::regprocedure, 'execute') as "legacyCreate"
    `
    expect(acl).toEqual({ apiRead: false, apiCreate: true, apiResolver: false, legacyCreate: false })
  })

  it('uses one indistinguishable database failure for malformed, random, revoked, and expired credentials', async () => {
    const revoked = randomUUID()
    const expired = randomUUID()
    await admin`insert into sessions (user_id, credential_digest_v1, expires_at, revoked_at, credential_storage_version) values (${actor}::uuid, ${computeCredentialDigest(revoked).digest}, clock_timestamp() + interval '1 hour', clock_timestamp(), 1), (${actor}::uuid, ${computeCredentialDigest(expired).digest}, clock_timestamp() - interval '1 second', null, 1)`
    for (const candidate of [Buffer.from('bad', 'ascii'), Buffer.from(randomUUID(), 'ascii'), Buffer.from(revoked, 'ascii'), Buffer.from(expired, 'ascii')]) {
      await expect(api`select * from forge.create_vnext_generic_zero_mission_v1(${candidate}::bytea, ${randomUUID()}::uuid, ${randomUUID()}::uuid, ${digest}, ${digest})`).rejects.toMatchObject({ code: '28000', message: expect.stringContaining('VNext session authorization failed') })
    }
  })

  it('derives ownership from the locked session for creation, reads, and transitions', async () => {
    const mission = randomUUID()
    const execution = randomUUID()
    await generic(credential, mission, execution)
    const [created] = await admin`select compatibility_pins, resource_bindings from missions join executions on executions.mission_id=missions.id where missions.id=${mission}::uuid`
    expect(created.compatibility_pins).toMatchObject({ compatibilityMode: 'generic_zero_capability_v1', policyRevision: 'rev:v1:generic-zero-v1' })
    expect(created.resource_bindings).toEqual([])
    expect(await api`select * from forge.read_vnext_mission_v1(${Buffer.from(otherCredential, 'ascii')}::bytea, ${mission}::uuid)`).toEqual([])
    await expect(api`select * from forge.transition_vnext_execution_for_session_v1(${Buffer.from(otherCredential, 'ascii')}::bytea, ${execution}::uuid, 0::bigint, 'terminal', 'cancelled', null, 'execution.cancelled', null)`).rejects.toMatchObject({ code: 'P3345' })
    await api`select * from forge.transition_vnext_execution_for_session_v1(${Buffer.from(credential, 'ascii')}::bytea, ${execution}::uuid, 0::bigint, 'terminal', 'cancelled', null, 'execution.cancelled', null)`
  })

  it('[scenarioId=vnext.a1.pointer-concurrency-fixture-boundary] keeps compare-and-swap transitions inside the credential-derived owner boundary', async () => {
    const mission = randomUUID()
    const execution = randomUUID()
    await generic(credential, mission, execution)
    const transition = () => api`select * from forge.transition_vnext_execution_for_session_v1(${Buffer.from(credential, 'ascii')}::bytea, ${execution}::uuid, 0::bigint, 'terminal', 'cancelled', null, 'execution.cancelled', null)`
    const results = await Promise.allSettled([transition(), transition()])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
    await expect(api`select * from forge.transition_vnext_execution_for_session_v1(${Buffer.from(credential, 'ascii')}::bytea, ${execution}::uuid, 1::bigint, 'terminal', 'failed', null, 'execution.failed', null)`).rejects.toMatchObject({ code: 'P3344' })
    const audits = await admin`select resulting_revision from runtime_transition_audits where entity_kind='execution' and entity_id=${execution}::uuid order by resulting_revision`
    expect(audits.map((row) => row.resulting_revision)).toEqual(['0', '1'])
  })

  it('[scenarioId=vnext.a1.projectless-lifecycle] derives Task resources and rejects mismatched, archived, and rootless Task fixtures', async () => {
    const makeTask = async (options: { taskOwner?: string; projectOwner?: string; archived?: boolean; rootRef?: string | null; rootRevision?: number } = {}) => {
      const project = randomUUID(); const task = randomUUID()
      const rootRef = options.rootRef === undefined ? randomUUID() : options.rootRef
      await admin`insert into projects (id, name, submitted_by, root_ref, root_binding_revision, archived_at) values (${project}::uuid, 'runtime fixture', ${(options.projectOwner ?? actor)}::uuid, ${rootRef}::uuid, ${(options.rootRevision ?? 1)}::bigint, ${options.archived ? new Date() : null})`
      await admin`insert into tasks (id, project_id, submitted_by, title, prompt) values (${task}::uuid, ${project}::uuid, ${(options.taskOwner ?? actor)}::uuid, 'runtime fixture', 'runtime fixture')`
      return task
    }
    const task = await makeTask()
    await api`select * from forge.create_vnext_task_mission_v1(${Buffer.from(credential, 'ascii')}::bytea, ${task}::uuid, ${randomUUID()}::uuid, ${randomUUID()}::uuid, ${digest}, ${digest})`
    for (const taskId of [await makeTask({ taskOwner: otherActor }), await makeTask({ archived: true }), await makeTask({ rootRef: null }), await makeTask({ rootRevision: 0 })]) {
      await expect(api`select * from forge.create_vnext_task_mission_v1(${Buffer.from(credential, 'ascii')}::bytea, ${taskId}::uuid, ${randomUUID()}::uuid, ${randomUUID()}::uuid, ${digest}, ${digest})`).rejects.toMatchObject({ code: 'P3345' })
    }
  })
})
