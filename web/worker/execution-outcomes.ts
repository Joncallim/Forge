import { db } from '../db'
import { executionOutcomes } from '../db/schema'
import { normalizeExecutionOutcome, type ExecutionOutcome } from '../lib/execution-outcomes'
import { sanitizeWorkerMessage } from './redaction'

/** Idempotently stores the latest canonical interpretation for one attempt. */
export async function upsertExecutionOutcome(input: {
  taskId: string
  attemptKey: string
  workPackageId?: string | null
  agentRunId?: string | null
  taskAttemptId?: string | null
  outcome: ExecutionOutcome
}): Promise<{ id: string }> {
  if (!input.attemptKey || input.attemptKey.length > 200) {
    throw new Error('Execution outcome attempt key is required and bounded.')
  }
  const outcome = normalizeExecutionOutcome(input.outcome, sanitizeWorkerMessage)
  const [row] = await db
    .insert(executionOutcomes)
    .values({
      taskId: input.taskId,
      attemptKey: input.attemptKey,
      workPackageId: input.workPackageId ?? null,
      agentRunId: input.agentRunId ?? null,
      taskAttemptId: input.taskAttemptId ?? null,
      ...outcome,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [executionOutcomes.taskId, executionOutcomes.attemptKey],
      set: {
        workPackageId: input.workPackageId ?? null,
        agentRunId: input.agentRunId ?? null,
        taskAttemptId: input.taskAttemptId ?? null,
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
  if (!row) throw new Error('Execution outcome was not stored.')
  return row
}
