import { randomUUID } from 'node:crypto'

import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const required = process.env.FORGE_RELIABILITY_LEDGER_REQUIRE_POSTGRES_TEST === '1'
const databaseUrl = process.env.DATABASE_URL?.trim()
const adminUrl = process.env.FORGE_RELIABILITY_LEDGER_POSTGRES_ADMIN_TEST_URL?.trim()
const enabled = required && Boolean(databaseUrl && adminUrl)

if (required && (!databaseUrl || !adminUrl)) {
  throw new Error(
    'FORGE_RELIABILITY_LEDGER_REQUIRE_POSTGRES_TEST=1 requires DATABASE_URL and FORGE_RELIABILITY_LEDGER_POSTGRES_ADMIN_TEST_URL for the disposable PostgreSQL capability-reliability-ledger proof; the mandatory suite may not skip.',
  )
}

describe.skipIf(!enabled)('capability reliability ledger PostgreSQL behavior', () => {
  const ids = {
    user: randomUUID(),
    project: randomUUID(),
    task: randomUUID(),
    executionOutcome: randomUUID(),
    attempt: randomUUID(),
  }
  const cohortFingerprint = 'a'.repeat(64)
  const scopeFingerprint = 'b'.repeat(64)
  const runtimeFingerprint = 'c'.repeat(64)
  const policyFingerprint = 'd'.repeat(64)
  const outcomeDigest = 'e'.repeat(64)

  let sql: ReturnType<typeof postgres>
  let adminSql: ReturnType<typeof postgres>

  beforeAll(async () => {
    sql = postgres(databaseUrl!, { max: 4, onnotice: () => {} })
    adminSql = postgres(adminUrl!, { max: 1, onnotice: () => {} })

    await sql.begin(async (tx) => {
      await tx`
        insert into users (id, display_name)
        values (${ids.user}::uuid, 'Capability reliability ledger PostgreSQL proof')
      `
      await tx`
        insert into projects (id, name, submitted_by, grant_decision_revision, root_binding_revision)
        values (${ids.project}::uuid, 'Capability reliability ledger PostgreSQL proof', ${ids.user}::uuid, 1, 1)
      `
      await tx`
        insert into tasks (id, project_id, submitted_by, title, prompt, status)
        values (
          ${ids.task}::uuid, ${ids.project}::uuid, ${ids.user}::uuid,
          'Capability reliability ledger PostgreSQL proof', 'Bounded disposable test fixture', 'running'
        )
      `
      await tx`
        insert into execution_outcomes (
          id, task_id, attempt_key, schema_version, transport_status, result,
          retryable, verifier_required, verification_status
        )
        values (
          ${ids.executionOutcome}::uuid, ${ids.task}::uuid, 'capability-ledger-postgres-proof',
          1, 'ok', 'completed', false, false, 'not_required'
        )
      `
      await tx`
        insert into capability_attempts (
          id, attempt_group_id, project_id, task_id, execution_outcome_id,
          contract_version, capability_key, classification_state, capability_multiplicity,
          cohort_fingerprint, scope_fingerprint, runtime_fingerprint, policy_fingerprint, outcome_digest,
          transport_status, result, retryable, attempt_number, severity_class,
          verifier_required, verification_mode, verification_status, observed_at
        )
        values (
          ${ids.attempt}::uuid, ${ids.attempt}::uuid, ${ids.project}::uuid, ${ids.task}::uuid, ${ids.executionOutcome}::uuid,
          1, 'workpackage:backend/api-implementation', 'classified', 1,
          ${cohortFingerprint}, ${scopeFingerprint}, ${runtimeFingerprint}, ${policyFingerprint}, ${outcomeDigest},
          'ok', 'completed', false, 1, 'normal',
          false, 'none', 'not_required', now()
        )
      `
    })
  })

  afterAll(async () => {
    await Promise.all([
      sql?.end({ timeout: 5 }),
      adminSql?.end({ timeout: 5 }),
    ])
  })

  it('rejects UPDATE and DELETE on capability_attempts', async () => {
    await expect(sql`
      update capability_attempts set result = 'failed' where id = ${ids.attempt}::uuid
    `).rejects.toThrow('capability attempts are append-only')
    await expect(sql`
      delete from capability_attempts where id = ${ids.attempt}::uuid
    `).rejects.toThrow('capability attempts are append-only')
  })

  it('rejects a duplicate (execution_outcome_id, capability_key) attempt', async () => {
    await expect(sql`
      insert into capability_attempts (
        id, attempt_group_id, project_id, task_id, execution_outcome_id,
        contract_version, capability_key, classification_state, capability_multiplicity,
        cohort_fingerprint, scope_fingerprint, runtime_fingerprint, policy_fingerprint, outcome_digest,
        transport_status, result, retryable, attempt_number, severity_class,
        verifier_required, verification_mode, verification_status, observed_at
      )
      values (
        ${randomUUID()}::uuid, ${randomUUID()}::uuid, ${ids.project}::uuid, ${ids.task}::uuid, ${ids.executionOutcome}::uuid,
        1, 'workpackage:backend/api-implementation', 'classified', 1,
        ${cohortFingerprint}, ${scopeFingerprint}, ${runtimeFingerprint}, ${policyFingerprint}, ${outcomeDigest},
        'ok', 'completed', false, 1, 'normal',
        false, 'none', 'not_required', now()
      )
    `).rejects.toThrow(/duplicate key value|unique constraint/i)
  })

  it('enforces gapless adjudication sequence order per attempt', async () => {
    await sql`
      insert into capability_attempt_adjudications (
        capability_attempt_id, sequence, kind, human_decision, observed_at
      )
      values (${ids.attempt}::uuid, 0, 'human_decision', 'accepted', now())
    `
    await expect(sql`
      insert into capability_attempt_adjudications (
        capability_attempt_id, sequence, kind, human_decision, observed_at
      )
      values (${ids.attempt}::uuid, 2, 'human_decision', 'accepted', now())
    `).rejects.toThrow('gapless sequence order')
    await sql`
      insert into capability_attempt_adjudications (
        capability_attempt_id, sequence, kind, observed_at
      )
      values (${ids.attempt}::uuid, 1, 'rollback_recorded', now())
    `
  })

  it('rejects UPDATE and DELETE on capability_attempt_adjudications', async () => {
    const [row] = await sql<{ id: string }[]>`
      select id from capability_attempt_adjudications
      where capability_attempt_id = ${ids.attempt}::uuid and sequence = 0
    `
    await expect(sql`
      update capability_attempt_adjudications set human_decision = 'rejected' where id = ${row!.id}::uuid
    `).rejects.toThrow('capability attempt adjudications are append-only')
    await expect(sql`
      delete from capability_attempt_adjudications where id = ${row!.id}::uuid
    `).rejects.toThrow('capability attempt adjudications are append-only')
  })

  it('the ordinary application role has no UPDATE or DELETE on either ledger table', async () => {
    const [privileges] = await sql<{ canUpdateAttempts: boolean; canDeleteAttempts: boolean; canUpdateAdjudications: boolean; canDeleteAdjudications: boolean }[]>`
      select
        has_table_privilege(current_user, 'public.capability_attempts', 'UPDATE') as "canUpdateAttempts",
        has_table_privilege(current_user, 'public.capability_attempts', 'DELETE') as "canDeleteAttempts",
        has_table_privilege(current_user, 'public.capability_attempt_adjudications', 'UPDATE') as "canUpdateAdjudications",
        has_table_privilege(current_user, 'public.capability_attempt_adjudications', 'DELETE') as "canDeleteAdjudications"
    `
    expect(privileges).toEqual({
      canUpdateAttempts: false,
      canDeleteAttempts: false,
      canUpdateAdjudications: false,
      canDeleteAdjudications: false,
    })
  })
})
