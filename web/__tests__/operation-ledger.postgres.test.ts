import { randomUUID } from 'node:crypto'

import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  operationFingerprint,
  type OperationPolicyDecision,
} from '@/lib/operations/contracts'
import type {
  OperationLedger,
  OperationRunEventWrite,
  OperationRunFinalization,
  OperationRunStart,
} from '@/worker/operations/executor'

const required = process.env.FORGE_OPERATION_LEDGER_REQUIRE_POSTGRES_TEST === '1'
const databaseUrl = process.env.DATABASE_URL?.trim()
const adminUrl = process.env.FORGE_OPERATION_LEDGER_POSTGRES_ADMIN_TEST_URL?.trim()
const enabled = required && Boolean(databaseUrl && adminUrl)

if (required && (!databaseUrl || !adminUrl)) {
  throw new Error(
    'FORGE_OPERATION_LEDGER_REQUIRE_POSTGRES_TEST=1 requires DATABASE_URL and FORGE_OPERATION_LEDGER_POSTGRES_ADMIN_TEST_URL for the disposable PostgreSQL operation-ledger proof; the mandatory suite may not skip.',
  )
}

describe.skipIf(!enabled)('operation ledger PostgreSQL behavior', () => {
  const ids = {
    user: randomUUID(),
    project: randomUUID(),
    task: randomUUID(),
  }
  const idempotencyKey = operationFingerprint('postgres-proof-idempotency', randomUUID())
  const outcomeAttemptKey = `operation:${operationFingerprint('postgres-proof-outcome', randomUUID())}`
  const policyDecision: OperationPolicyDecision = {
    schemaVersion: 1,
    allowed: true,
    code: 'allowed',
    capability: 'filesystem.project.read',
    projectId: ids.project,
    policyVersion: 'operation-ledger-postgres-v1',
  }
  const start: OperationRunStart = {
    taskId: ids.task,
    projectId: ids.project,
    workPackageId: null,
    agentRunId: null,
    taskAttemptId: null,
    definitionSchemaVersion: 1,
    operationId: 'repository.status.read',
    operationVersion: 1,
    capability: 'filesystem.project.read',
    idempotencyKey,
    definitionDigest: operationFingerprint('postgres-proof-definition', { version: 1 }),
    scopeFingerprint: operationFingerprint('postgres-proof-scope', { projectId: ids.project }),
    requestFingerprint: operationFingerprint('postgres-proof-request', { operationId: 'repository.status.read' }),
    inputsFingerprint: operationFingerprint('postgres-proof-inputs', {}),
    reasonFingerprint: operationFingerprint('postgres-proof-reason', 'live ledger proof'),
    policyDecision,
  }
  const outcome = {
    schemaVersion: 1 as const,
    transportStatus: 'ok' as const,
    result: 'completed' as const,
    stopReasonCode: null,
    stopReasonSummary: null,
    retryable: false,
    evidenceRefs: [],
    verifierRequired: false,
    verificationStatus: 'not_required' as const,
  }

  let sql: ReturnType<typeof postgres>
  let adminSql: ReturnType<typeof postgres>
  let factoryLedger: OperationLedger
  let defaultLedger: OperationLedger
  let closeDb: () => Promise<void>

  function event(
    runId: string,
    sequence: number,
    phase: OperationRunEventWrite['phase'],
    status: OperationRunEventWrite['status'] = 'passed',
  ): OperationRunEventWrite {
    return {
      runId,
      sequence,
      phase,
      status,
      detailCode: `${phase}_${status}`,
      detailFingerprint: operationFingerprint(`postgres-proof-event:${phase}`, { runId, sequence, status }),
      evidenceRefs: [],
    }
  }

  beforeAll(async () => {
    sql = postgres(databaseUrl!, { max: 4, onnotice: () => {} })
    adminSql = postgres(adminUrl!, { max: 1, onnotice: () => {} })
    const ledgerModule = await import('@/worker/operations/ledger')
    const databaseModule = await import('@/db')
    factoryLedger = ledgerModule.createDatabaseOperationLedger()
    defaultLedger = ledgerModule.databaseOperationLedger
    closeDb = databaseModule.closeDb

    await sql.begin(async (tx) => {
      await tx`
        insert into users (id, display_name)
        values (${ids.user}::uuid, 'Operation ledger PostgreSQL proof')
      `
      await tx`
        insert into projects (id, name, submitted_by, grant_decision_revision, root_binding_revision)
        values (${ids.project}::uuid, 'Operation ledger PostgreSQL proof', ${ids.user}::uuid, 1, 1)
      `
      await tx`
        insert into tasks (id, project_id, submitted_by, title, prompt, status)
        values (
          ${ids.task}::uuid, ${ids.project}::uuid, ${ids.user}::uuid,
          'Operation ledger PostgreSQL proof', 'Bounded disposable test fixture', 'running'
        )
      `
    })
  })

  afterAll(async () => {
    await closeDb?.()
    await Promise.all([
      sql?.end({ timeout: 5 }),
      adminSql?.end({ timeout: 5 }),
    ])
  })

  it('enforces concurrency, ordered append-only phases, atomic finalization, replay, and outcome integrity', async () => {
    const begins = await Promise.all([
      factoryLedger.begin(start),
      defaultLedger.begin(start),
    ])
    const started = begins.filter((result) => result.kind === 'started')
    const concurrentReplay = begins.filter((result) => result.kind === 'replayed')
    expect(started).toHaveLength(1)
    expect(concurrentReplay).toHaveLength(1)
    expect(concurrentReplay[0]).toMatchObject({
      kind: 'replayed',
      result: { status: 'running', verificationStatus: 'not_started', outcome: null },
    })
    const runId = started[0]!.runId

    await expect(defaultLedger.appendEvent(event(runId, 1, 'policy')))
      .rejects.toThrow('operation run events must be appended in phase order')

    for (const [sequence, phase] of [
      [0, 'request_validation'],
      [1, 'policy'],
      [2, 'preflight'],
      [3, 'execution'],
      [4, 'verification'],
    ] as const) {
      await factoryLedger.appendEvent(event(runId, sequence, phase))
    }

    const finalization: OperationRunFinalization = {
      runId,
      taskId: ids.task,
      workPackageId: null,
      agentRunId: null,
      taskAttemptId: null,
      attemptKey: outcomeAttemptKey,
      status: 'completed',
      verificationStatus: 'passed',
      outputFingerprint: operationFingerprint('postgres-proof-output', { exitCode: 0, summary: '' }),
      policyDecision,
      outcome,
      outcomeEvent: event(runId, 5, 'outcome'),
    }

    await expect(defaultLedger.finalize({
      ...finalization,
      outcomeEvent: event(runId, 4, 'verification'),
    })).rejects.toThrow('operation run events must be appended in phase order')
    const [rolledBack] = await sql<{
      outcomeCount: number
      status: string
      executionOutcomeId: string | null
    }[]>`
      select
        (select count(*)::int from execution_outcomes where task_id = ${ids.task}::uuid and attempt_key = ${outcomeAttemptKey}) as "outcomeCount",
        status,
        execution_outcome_id as "executionOutcomeId"
      from operation_runs
      where id = ${runId}::uuid
    `
    expect(rolledBack).toEqual({ outcomeCount: 0, status: 'running', executionOutcomeId: null })

    const finalized = await defaultLedger.finalize(finalization)
    const [persisted] = await sql<{
      executionOutcomeId: string
      outcomeFingerprint: string
      status: string
      verificationStatus: string
      phases: string[]
    }[]>`
      select
        run.execution_outcome_id as "executionOutcomeId",
        run.outcome_fingerprint as "outcomeFingerprint",
        run.status,
        run.verification_status as "verificationStatus",
        array(
          select event_row.phase
          from operation_run_events event_row
          where event_row.operation_run_id = run.id
          order by event_row.sequence
        ) as phases
      from operation_runs run
      where run.id = ${runId}::uuid
    `
    expect(persisted).toMatchObject({
      executionOutcomeId: finalized.executionOutcomeId,
      status: 'completed',
      verificationStatus: 'passed',
      phases: ['request_validation', 'policy', 'preflight', 'execution', 'verification', 'outcome'],
    })
    expect(persisted?.outcomeFingerprint).toMatch(/^[0-9a-f]{64}$/)

    const replay = await factoryLedger.begin(start)
    expect(replay).toMatchObject({
      kind: 'replayed',
      result: {
        runId,
        status: 'completed',
        verificationStatus: 'passed',
        outcome: { result: 'completed', stopReasonCode: null },
      },
    })

    await expect(defaultLedger.appendEvent(event(runId, 5, 'outcome')))
      .rejects.toThrow('terminal operation runs cannot receive events')
    await expect(sql`update operation_runs set status = 'failed' where id = ${runId}::uuid`)
      .rejects.toThrow('terminal operation runs are immutable')
    const [eventPrivileges] = await sql<{ canUpdate: boolean }[]>`
      select has_table_privilege(
        current_user, 'public.operation_run_events', 'UPDATE'
      ) as "canUpdate"
    `
    expect(eventPrivileges).toEqual({ canUpdate: false })
    await expect(adminSql`
      update operation_run_events
      set detail_code = 'tampered'
      where operation_run_id = ${runId}::uuid and sequence = 0
    `).rejects.toThrow('operation run events are append-only')

    await sql`
      update execution_outcomes
      set stop_reason_summary = 'tampered after terminalization'
      where id = ${finalized.executionOutcomeId}::uuid
    `
    await expect(defaultLedger.begin(start))
      .rejects.toThrow('Stored canonical operation outcome does not match its immutable fingerprint')
  })
})
