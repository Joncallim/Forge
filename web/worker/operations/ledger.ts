import { and, eq } from 'drizzle-orm'

import { db } from '@/db'
import { executionOutcomes, operationRunEvents, operationRuns } from '@/db/schema'
import {
  isExecutionOutcome,
  normalizeExecutionOutcome,
  type ExecutionOutcome,
} from '@/lib/execution-outcomes'
import {
  operationFingerprint,
  type OperationExecutionResult,
  type OperationRunStatus,
  type OperationVerificationStatus,
} from '@/lib/operations/contracts'
import { sanitizeWorkerMessage } from '@/worker/redaction'
import {
  buildOperationPolicyInput,
  buildOperationReliabilityScope,
  buildOperationRuntimeInput,
} from '@/worker/reliability/context'
import { recordCapabilityAttemptsBestEffort, recordDeterministicAdapterVerdictBestEffort } from '@/worker/reliability/ledger'
import { resolveOperationDefinition } from '@/lib/operations/catalog'
import type {
  OperationLedger,
  OperationRunEventWrite,
  OperationRunFinalization,
  OperationRunStart,
} from './executor'

type LedgerTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0]

function runStatus(value: string): OperationRunStatus {
  if (value === 'running' || value === 'completed' || value === 'blocked' || value === 'failed') return value
  throw new Error('Stored operation run has an invalid status.')
}

function verificationStatus(value: string): OperationVerificationStatus {
  if (value === 'not_started' || value === 'passed' || value === 'failed') return value
  throw new Error('Stored operation run has an invalid verification status.')
}

function storedOutcome(row: typeof executionOutcomes.$inferSelect): ExecutionOutcome {
  const outcome: unknown = {
    schemaVersion: row.schemaVersion,
    transportStatus: row.transportStatus,
    result: row.result,
    stopReasonCode: row.stopReasonCode,
    stopReasonSummary: row.stopReasonSummary,
    retryable: row.retryable,
    evidenceRefs: row.evidenceRefs,
    verifierRequired: row.verifierRequired,
    verificationStatus: row.verificationStatus,
  }
  if (!isExecutionOutcome(outcome)) throw new Error('Stored operation outcome is invalid.')
  return outcome
}

async function replayResult(
  tx: LedgerTransaction,
  row: typeof operationRuns.$inferSelect,
): Promise<OperationExecutionResult> {
  let outcome: ExecutionOutcome | null = null
  if (row.executionOutcomeId) {
    const [stored] = await tx
      .select()
      .from(executionOutcomes)
      .where(eq(executionOutcomes.id, row.executionOutcomeId))
      .limit(1)
    if (!stored) throw new Error('Operation run references a missing canonical outcome.')
    outcome = storedOutcome(stored)
    if (row.outcomeFingerprint !== operationFingerprint('canonical-outcome', outcome)) {
      throw new Error('Stored canonical operation outcome does not match its immutable fingerprint.')
    }
  } else if (row.status !== 'running') {
    throw new Error('Terminal operation run has no canonical outcome linkage.')
  }
  return {
    runId: row.id,
    operationId: row.operationId,
    operationVersion: row.operationVersion,
    definitionDigest: row.definitionDigest,
    scopeFingerprint: row.scopeFingerprint,
    status: runStatus(row.status),
    verificationStatus: verificationStatus(row.verificationStatus),
    replayed: true,
    output: null,
    outcome,
  }
}

/**
 * drizzle-orm wraps every failed query in a DrizzleQueryError whose message
 * is a generic "Failed query: ..." dump of the SQL and params; the real
 * driver/database error (e.g. a trigger's RAISE EXCEPTION text) is only
 * reachable via `.cause`. Surface that instead so callers -- and anyone
 * reading logs -- see the actual reason a ledger write was rejected.
 */
function unwrapDatabaseError(err: unknown): never {
  if (err instanceof Error && err.cause instanceof Error) throw err.cause
  throw err
}

function eventValues(event: OperationRunEventWrite) {
  return {
    operationRunId: event.runId,
    sequence: event.sequence,
    phase: event.phase,
    status: event.status,
    detailCode: event.detailCode,
    detailFingerprint: event.detailFingerprint,
    evidenceRefs: event.evidenceRefs,
  }
}

export function createDatabaseOperationLedger(database: typeof db = db): OperationLedger {
  return {
    async begin(input: OperationRunStart) {
      return database.transaction(async (tx) => {
        const [inserted] = await tx
          .insert(operationRuns)
          .values({
            taskId: input.taskId,
            projectId: input.projectId,
            workPackageId: input.workPackageId,
            agentRunId: input.agentRunId,
            taskAttemptId: input.taskAttemptId,
            definitionSchemaVersion: input.definitionSchemaVersion,
            operationId: input.operationId,
            operationVersion: input.operationVersion,
            capability: input.capability,
            idempotencyKey: input.idempotencyKey,
            definitionDigest: input.definitionDigest,
            scopeFingerprint: input.scopeFingerprint,
            requestFingerprint: input.requestFingerprint,
            inputsFingerprint: input.inputsFingerprint,
            reasonFingerprint: input.reasonFingerprint,
            policyDecision: { ...input.policyDecision },
          })
          .onConflictDoNothing({
            target: [operationRuns.taskId, operationRuns.idempotencyKey],
          })
          .returning({ id: operationRuns.id })
        if (inserted) return { kind: 'started' as const, runId: inserted.id }

        const [existing] = await tx
          .select()
          .from(operationRuns)
          .where(and(
            eq(operationRuns.taskId, input.taskId),
            eq(operationRuns.idempotencyKey, input.idempotencyKey),
          ))
          .limit(1)
        if (!existing) throw new Error('Idempotent operation run could not be resolved.')
        return {
          kind: 'replayed' as const,
          requestFingerprint: existing.requestFingerprint,
          definitionDigest: existing.definitionDigest,
          scopeFingerprint: existing.scopeFingerprint,
          result: await replayResult(tx, existing),
        }
      })
    },

    async appendEvent(event: OperationRunEventWrite) {
      try {
        await database.insert(operationRunEvents).values(eventValues(event))
      } catch (err) {
        unwrapDatabaseError(err)
      }
    },

    async finalize(input: OperationRunFinalization) {
      let txResult: { executionOutcomeId: string }
      try {
        txResult = await database.transaction(async (tx) => {
          const outcome = normalizeExecutionOutcome(input.outcome, sanitizeWorkerMessage)
          const [outcomeRow] = await tx
            .insert(executionOutcomes)
            .values({
              taskId: input.taskId,
              workPackageId: input.workPackageId,
              agentRunId: input.agentRunId,
              taskAttemptId: input.taskAttemptId,
              attemptKey: input.attemptKey,
              schemaVersion: outcome.schemaVersion,
              transportStatus: outcome.transportStatus,
              result: outcome.result,
              stopReasonCode: outcome.stopReasonCode,
              stopReasonSummary: outcome.stopReasonSummary,
              retryable: outcome.retryable,
              evidenceRefs: outcome.evidenceRefs,
              verifierRequired: outcome.verifierRequired,
              verificationStatus: outcome.verificationStatus,
              updatedAt: new Date(),
            })
            .onConflictDoUpdate({
              target: [executionOutcomes.taskId, executionOutcomes.attemptKey],
              set: {
                workPackageId: input.workPackageId,
                agentRunId: input.agentRunId,
                taskAttemptId: input.taskAttemptId,
                transportStatus: outcome.transportStatus,
                result: outcome.result,
                stopReasonCode: outcome.stopReasonCode,
                stopReasonSummary: outcome.stopReasonSummary,
                retryable: outcome.retryable,
                evidenceRefs: outcome.evidenceRefs,
                verifierRequired: outcome.verifierRequired,
                verificationStatus: outcome.verificationStatus,
                updatedAt: new Date(),
              },
            })
            .returning({ id: executionOutcomes.id })
          if (!outcomeRow) throw new Error('Canonical operation outcome was not stored.')

          await tx.insert(operationRunEvents).values(eventValues(input.outcomeEvent))
          const [completed] = await tx
            .update(operationRuns)
            .set({
              executionOutcomeId: outcomeRow.id,
              status: input.status,
              verificationStatus: input.verificationStatus,
              outputFingerprint: input.outputFingerprint,
              outcomeFingerprint: operationFingerprint('canonical-outcome', outcome),
              completedAt: new Date(),
            })
            .where(and(eq(operationRuns.id, input.runId), eq(operationRuns.status, 'running')))
            .returning({ id: operationRuns.id })
          if (!completed) throw new Error('Operation run was not in a finalizable state.')
          return { executionOutcomeId: outcomeRow.id }
        })
      } catch (err) {
        unwrapDatabaseError(err)
      }
      // Ledger write happens after the ADR 0011 transaction has committed --
      // never inside it -- and is best-effort so it can never affect the
      // operation run's already-terminal outcome.
      await recordOperationCapabilityAttemptBestEffort({
        database,
        runId: input.runId,
        executionOutcomeId: txResult.executionOutcomeId,
      })
      return txResult
    },
  }
}

/**
 * Reads the immutable identity columns of a terminal operation_runs row and
 * records the corresponding capability attempt. operationId/operationVersion
 * are read here rather than threaded through OperationRunFinalization,
 * keeping the ADR 0011 executor contract unchanged.
 */
async function recordOperationCapabilityAttemptBestEffort(input: {
  database: typeof db
  runId: string
  executionOutcomeId: string
}): Promise<void> {
  try {
    const [run] = await input.database
      .select({
        taskId: operationRuns.taskId,
        projectId: operationRuns.projectId,
        workPackageId: operationRuns.workPackageId,
        agentRunId: operationRuns.agentRunId,
        taskAttemptId: operationRuns.taskAttemptId,
        operationId: operationRuns.operationId,
        operationVersion: operationRuns.operationVersion,
        capability: operationRuns.capability,
        status: operationRuns.status,
        verificationStatus: operationRuns.verificationStatus,
        completedAt: operationRuns.completedAt,
      })
      .from(operationRuns)
      .where(eq(operationRuns.id, input.runId))
      .limit(1)
    if (!run) return
    const definition = resolveOperationDefinition({
      operationId: run.operationId,
      operationVersion: run.operationVersion,
    })
    const scope = await buildOperationReliabilityScope({ projectId: run.projectId, capability: run.capability })
    if (!scope) return
    const [outcomeRow] = await input.database
      .select()
      .from(executionOutcomes)
      .where(eq(executionOutcomes.id, input.executionOutcomeId))
      .limit(1)
    if (!outcomeRow) return
    if (!run.taskId) return
    const outcomeCandidate: unknown = {
      schemaVersion: outcomeRow.schemaVersion,
      transportStatus: outcomeRow.transportStatus,
      result: outcomeRow.result,
      stopReasonCode: outcomeRow.stopReasonCode,
      stopReasonSummary: outcomeRow.stopReasonSummary,
      retryable: outcomeRow.retryable,
      evidenceRefs: outcomeRow.evidenceRefs,
      verifierRequired: outcomeRow.verifierRequired,
      verificationStatus: outcomeRow.verificationStatus,
    }
    if (!isExecutionOutcome(outcomeCandidate)) return
    await recordCapabilityAttemptsBestEffort({
      projectId: run.projectId,
      taskId: run.taskId,
      workPackageId: run.workPackageId,
      agentRunId: run.agentRunId,
      taskAttemptId: run.taskAttemptId,
      executionOutcomeId: input.executionOutcomeId,
      operationRunId: input.runId,
      outcome: outcomeCandidate,
      attemptNumber: 1,
      source: { kind: 'operation', operationId: run.operationId, operationVersion: run.operationVersion },
      scope,
      runtime: buildOperationRuntimeInput(definition.adapter),
      policy: buildOperationPolicyInput(),
      verificationMode: 'none',
      acceptanceCriteriaTotal: 0,
      validationCommandTotal: 0,
      validationCommandFailed: 0,
      observedAt: run.completedAt ?? new Date(),
    })
    // The canonical outcome always carries verifier_required = false, so the
    // attempt row cannot hold the deterministic adapter's verdict; append it
    // as a verification_recorded adjudication once the run reached one.
    if (run.verificationStatus === 'passed' || run.verificationStatus === 'failed') {
      await recordDeterministicAdapterVerdictBestEffort({
        executionOutcomeId: input.executionOutcomeId,
        verificationResult: run.verificationStatus,
        observedAt: run.completedAt ?? new Date(),
      })
    }
  } catch {
    // Best-effort: the capability ledger is an interpretation layer over the
    // already-committed operation run and canonical outcome.
  }
}

export const databaseOperationLedger = createDatabaseOperationLedger()
