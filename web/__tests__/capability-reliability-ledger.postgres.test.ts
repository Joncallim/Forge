import { randomUUID } from 'node:crypto'

import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { ExecutionOutcome } from '@/lib/execution-outcomes'

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
    const databaseModule = await import('@/db')
    await databaseModule.closeDb()
    await Promise.all([
      sql?.end({ timeout: 5 }),
      adminSql?.end({ timeout: 5 }),
    ])
  })

  it('rejects UPDATE and DELETE on capability_attempts', async () => {
    // The ordinary app role has no UPDATE/DELETE at all, so PostgreSQL denies
    // those statements before the trigger can run; prove the append-only
    // trigger through the admin connection, which has the privilege.
    await expect(adminSql`
      update capability_attempts set result = 'failed' where id = ${ids.attempt}::uuid
    `).rejects.toThrow('capability attempts are append-only')
    await expect(adminSql`
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
    await expect(adminSql`
      update capability_attempt_adjudications set human_decision = 'rejected' where id = ${row!.id}::uuid
    `).rejects.toThrow('capability attempt adjudications are append-only')
    await expect(adminSql`
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

  it('rejects evidence refs that are not a bounded array of UUIDs on the attempt table', async () => {
    // sql.json binds the JS value as real JSON so the `::jsonb` cast sees
    // arrays as arrays (a bare postgres.js interpolation of a JS array would
    // serialize as a Postgres array literal, and JSON.stringify would arrive
    // double-encoded as a jsonb string). Every value passed below is JSON.
    const insertAttempt = (id: string, evidenceRefs: postgres.JSONValue) => sql`
      insert into capability_attempts (
        id, attempt_group_id, project_id, task_id, execution_outcome_id,
        contract_version, capability_key, classification_state, capability_multiplicity,
        cohort_fingerprint, scope_fingerprint, runtime_fingerprint, policy_fingerprint, outcome_digest,
        transport_status, result, retryable, attempt_number, severity_class,
        verifier_required, verification_mode, verification_status, evidence_refs, observed_at
      )
      values (
        ${id}::uuid, ${id}::uuid, ${ids.project}::uuid, ${ids.task}::uuid, ${ids.executionOutcome}::uuid,
        1, 'workpackage:backend/api-implementation-extra', 'classified', 1,
        ${cohortFingerprint}, ${scopeFingerprint}, ${runtimeFingerprint}, ${policyFingerprint}, ${outcomeDigest},
        'ok', 'completed', false, 1, 'normal',
        false, 'none', 'not_required', ${sql.json(evidenceRefs)}::jsonb, now()
      )
    `

    await expect(insertAttempt(randomUUID(), ['/private/path'])).rejects.toThrow(/evidence_refs_check/)
    await expect(insertAttempt(randomUUID(), ['secret text'])).rejects.toThrow(/evidence_refs_check/)
    await expect(insertAttempt(randomUUID(), [123])).rejects.toThrow(/evidence_refs_check/)
    await expect(insertAttempt(randomUUID(), [null])).rejects.toThrow(/evidence_refs_check/)
    await expect(insertAttempt(randomUUID(), Array.from({ length: 129 }, () => randomUUID())))
      .rejects.toThrow(/evidence_refs_check/)
    await expect(insertAttempt(randomUUID(), 'not-an-array')).rejects.toThrow(/evidence_refs_check/)

    // A genuine UUID array is accepted.
    await insertAttempt(randomUUID(), [randomUUID()])
    const [stored] = await sql<{ refs: string[] }[]>`
      select evidence_refs as refs from capability_attempts
      where capability_key = 'workpackage:backend/api-implementation-extra'
    `
    expect(stored).not.toBeNull()
    expect(stored!.refs).toHaveLength(1)
  })

  it('records the deterministic adapter verdict as verification evidence', async () => {
    const ledgerModule = await import('@/worker/reliability/ledger')
    const [{ max }] = await sql<{ max: number | null }[]>`
      select max(sequence) as max from capability_attempt_adjudications
      where capability_attempt_id = ${ids.attempt}::uuid
    `
    await ledgerModule.recordDeterministicAdapterVerdictBestEffort({
      executionOutcomeId: ids.executionOutcome,
      verificationResult: 'passed',
      observedAt: new Date(),
    })
    const rows = await sql<{ verificationMode: string; verificationResult: string; sequence: number }[]>`
      select verification_mode as "verificationMode", verification_result as "verificationResult", sequence
      from capability_attempt_adjudications
      where capability_attempt_id = ${ids.attempt}::uuid
        and kind = 'verification_recorded' and verification_mode = 'deterministic_adapter'
    `
    expect(rows).toMatchObject([{
      verificationMode: 'deterministic_adapter',
      verificationResult: 'passed',
      sequence: (max ?? -1) + 1,
    }])
  })

  it('serializes concurrent adjudication appends without silently dropping a decision', async () => {
    const ledgerModule = await import('@/worker/reliability/ledger')
    const [before] = await sql<{ max: number | null; count: number }[]>`
      select
        max(sequence) as max,
        count(*)::int as count
      from capability_attempt_adjudications
      where capability_attempt_id = ${ids.attempt}::uuid
    `
    await Promise.all([
      ledgerModule.recordHumanDecisionAdjudicationBestEffort({
        taskId: ids.task,
        attemptKey: 'capability-ledger-postgres-proof',
        humanDecision: 'accepted',
        decidedBy: null,
        approvalGateId: null,
        observedAt: new Date(),
      }),
      ledgerModule.recordVerificationAdjudicationBestEffort({
        taskId: ids.task,
        attemptKey: 'capability-ledger-postgres-proof',
        verificationMode: 'human_review',
        verificationResult: 'passed',
        observedAt: new Date(),
      }),
    ])
    const [rows] = await sql<{ count: number; sequences: number[] }[]>`
      select
        count(*)::int as count,
        array_agg(sequence order by sequence) as sequences
      from capability_attempt_adjudications
      where capability_attempt_id = ${ids.attempt}::uuid
    `
    // Both concurrent writers must land: count grows by two and the two new
    // rows continue the gapless sequence from wherever the fixture left off.
    expect(rows!.count).toBe(before!.count + 2)
    const next = (before!.max ?? -1) + 1
    expect(rows!.sequences.filter((sequence) => sequence >= next)).toEqual([next, next + 1])
  })

  it('keeps out-of-window critical failures visible when the cohort is read back', async () => {
    // The reader performs a second, age-unbounded query for the cohort's
    // critical history and unions it into the rate sample. Prove that
    // end-to-end: one in-window normal attempt, plus one ancient
    // severity-critical row and one ancient row marked critical only by a
    // rollback adjudication. Both must survive in the summary while the
    // bounded rate sample stays bounded.
    const ledgerModule = await import('@/worker/reliability/ledger')
    const readerModule = await import('@/worker/reliability/reader')
    const readerOutcomeId = randomUUID()
    const outcome: ExecutionOutcome = {
      schemaVersion: 1,
      transportStatus: 'ok',
      result: 'completed',
      stopReasonCode: null,
      stopReasonSummary: null,
      retryable: false,
      evidenceRefs: [],
      verifierRequired: false,
      verificationStatus: 'not_required',
    }
    await sql`
      insert into execution_outcomes (
        id, task_id, attempt_key, schema_version, transport_status, result,
        retryable, verifier_required, verification_status
      )
      values (
        ${readerOutcomeId}::uuid, ${ids.task}::uuid, 'capability-ledger-reader-proof',
        1, 'ok', 'completed', false, false, 'not_required'
      )
    `
    const observedAt = new Date()
    await ledgerModule.recordCapabilityAttempts({
      projectId: ids.project,
      taskId: ids.task,
      workPackageId: null,
      agentRunId: null,
      taskAttemptId: null,
      executionOutcomeId: readerOutcomeId,
      operationRunId: null,
      outcome,
      attemptNumber: 1,
      source: { kind: 'work_package', role: 'qa', capabilities: ['reader-proof'] },
      scope: {
        contractVersion: 1,
        projectId: ids.project,
        rootRef: null,
        rootBindingRevision: '1',
        grantDecisionRevision: '1',
        repositoryWriteIntent: false,
        capabilities: ['reader-proof'],
        mcpRequirementKeys: [],
      },
      runtime: {
        kind: 'model',
        providerType: null,
        modelId: 'reader-proof-model',
        providerIsLocal: null,
        providerConfigUpdatedAt: null,
        acpExecutionMode: 'proof',
      },
      policy: {
        contractVersion: 1,
        policyVersion: 'reader-proof',
        harnessId: null,
        harnessUpdatedAt: null,
        reviewRequirement: 'none',
        repositoryWritesEnabled: false,
      },
      verificationMode: 'none',
      acceptanceCriteriaTotal: 0,
      validationCommandTotal: 0,
      validationCommandFailed: 0,
      observedAt,
    })
    const [row] = await sql<{ cohortFingerprint: string; outcomeDigest: string }[]>`
      select cohort_fingerprint as "cohortFingerprint", outcome_digest as "outcomeDigest"
      from capability_attempts
      where execution_outcome_id = ${readerOutcomeId}::uuid
    `

    // Two ancient rows share the ingested row's cohort and digest (so neither
    // drifts): one severity-critical, one normal but rollback-adjudicated.
    // Each needs its own execution_outcomes row because the schema uniquely
    // binds (execution_outcome_id, capability_key); the outcome content is
    // identical, so every recomputed digest matches.
    const ancientCritical = new Date(observedAt.getTime() - 400 * 24 * 60 * 60 * 1000)
    const ancientRollback = new Date(ancientCritical.getTime() + 1000)
    const ancientCriticalId = randomUUID()
    const ancientRollbackId = randomUUID()
    const ancientCriticalOutcomeId = randomUUID()
    const ancientRollbackOutcomeId = randomUUID()
    for (const [outcomeId, attemptKey] of [
      [ancientCriticalOutcomeId, 'capability-ledger-reader-proof-ancient-critical'],
      [ancientRollbackOutcomeId, 'capability-ledger-reader-proof-ancient-rollback'],
    ] as const) {
      await sql`
        insert into execution_outcomes (
          id, task_id, attempt_key, schema_version, transport_status, result,
          retryable, verifier_required, verification_status
        )
        values (
          ${outcomeId}::uuid, ${ids.task}::uuid, ${attemptKey},
          1, 'ok', 'completed', false, false, 'not_required'
        )
      `
    }
    const insertAncient = (id: string, outcomeId: string, severityClass: 'critical' | 'normal', observed: Date) => sql`
      insert into capability_attempts (
        id, attempt_group_id, project_id, task_id, execution_outcome_id,
        contract_version, capability_key, classification_state, capability_multiplicity,
        cohort_fingerprint, scope_fingerprint, runtime_fingerprint, policy_fingerprint, outcome_digest,
        transport_status, result, retryable, attempt_number, severity_class,
        verifier_required, verification_mode, verification_status, observed_at
      )
      values (
        ${id}::uuid, ${id}::uuid, ${ids.project}::uuid, ${ids.task}::uuid, ${outcomeId}::uuid,
        1, 'workpackage:qa/reader-proof', 'classified', 1,
        ${row!.cohortFingerprint}, ${'a'.repeat(64)}, ${'a'.repeat(64)}, ${'a'.repeat(64)}, ${row!.outcomeDigest},
        'ok', 'completed', false, 1, ${severityClass},
        false, 'none', 'not_required', ${observed}
      )
    `
    await insertAncient(ancientCriticalId, ancientCriticalOutcomeId, 'critical', ancientCritical)
    await insertAncient(ancientRollbackId, ancientRollbackOutcomeId, 'normal', ancientRollback)
    await sql`
      insert into capability_attempt_adjudications (capability_attempt_id, sequence, kind, observed_at)
      values (${ancientRollbackId}::uuid, 0, 'rollback_recorded', ${ancientRollback})
    `

    const summary = await readerModule.readCohortReliability({
      cohortFingerprint: row!.cohortFingerprint,
      now: observedAt,
    })
    expect(summary).toMatchObject({
      state: 'insufficient_evidence',
      sampleCount: 1,
      criticalFailureCount: 2,
      lastCriticalAt: ancientRollback.toISOString(),
    })
    expect(summary.excluded).toContainEqual({ reason: 'outside_window', count: 2 })
  })
})
