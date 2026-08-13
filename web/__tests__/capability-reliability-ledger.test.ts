import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  insertValues: vi.fn(),
  insertOnConflict: vi.fn(),
  dbSelect: vi.fn(),
  txSelect: vi.fn(),
  txInsert: vi.fn(),
  operations: [] as string[],
  txExecQueries: [] as string[],
}))

// Flattens a drizzle sql template into its interpolated text so the mock can
// assert exactly what was executed inside the adjudication transaction.
function sqlText(query: unknown): string {
  const chunks = (query as { queryChunks?: unknown[] } | null)?.queryChunks ?? []
  return chunks.map((chunk) => (typeof chunk === 'string' ? chunk : String((chunk as { value?: unknown }).value))).join('')
}

function chain(rows: unknown[]): Record<string, unknown> {
  const thenable: Record<string, unknown> = {
    then: (onFulfilled: (value: unknown[]) => unknown) => Promise.resolve(rows).then(onFulfilled),
  }
  thenable.from = () => thenable
  thenable.where = () => thenable
  thenable.orderBy = () => thenable
  thenable.limit = () => thenable
  thenable.for = () => thenable
  return thenable
}

vi.mock('@/db', () => ({
  db: {
    insert: (table: unknown) => ({
      values: (rows: unknown) => {
        mocks.insertValues(table, rows)
        return {
          onConflictDoNothing: (opts: unknown) => {
            mocks.insertOnConflict(opts)
            return Promise.resolve([])
          },
          then: (onFulfilled: (value: unknown) => unknown) => Promise.resolve(undefined).then(onFulfilled),
        }
      },
    }),
    select: (...args: unknown[]) => {
      mocks.operations.push('select')
      return chain(mocks.dbSelect(...args) ?? [])
    },
    transaction: async (callback: (tx: unknown) => unknown) => callback({
      execute: (query: unknown) => {
        const text = sqlText(query)
        mocks.txExecQueries.push(text)
        mocks.operations.push(text.includes('lock_timeout') ? 'tx:lock-timeout' : 'tx:advisory-lock')
        return Promise.resolve([])
      },
      select: (...args: unknown[]) => {
        mocks.operations.push('tx:select')
        return chain(mocks.txSelect(...args) ?? [])
      },
      insert: (...args: unknown[]) => {
        mocks.operations.push('tx:insert')
        const values: (rows: unknown) => unknown = (rows) => {
          mocks.txInsert(args[0], rows)
          return Promise.resolve([])
        }
        return { values }
      },
    }),
  },
}))

vi.mock('@/db/schema', () => ({
  capabilityAttempts: {
    executionOutcomeId: 'execution_outcome_id',
    capabilityKey: 'capability_key',
    id: 'id',
  },
  capabilityAttemptAdjudications: {
    capabilityAttemptId: 'capability_attempt_id',
    sequence: 'sequence',
  },
  executionOutcomes: {
    taskId: 'task_id',
    attemptKey: 'attempt_key',
    id: 'id',
  },
}))

import {
  recordCapabilityAttempts,
  recordCapabilityAttemptsBestEffort,
  recordDeterministicAdapterVerdictBestEffort,
  recordHumanDecisionAdjudicationBestEffort,
  recordVerificationAdjudicationBestEffort,
  type RecordCapabilityAttemptsInput,
} from '@/worker/reliability/ledger'
import { outcomeDigest } from '@/lib/reliability/contracts'
import { normalizeExecutionOutcome } from '@/lib/execution-outcomes'
import { sanitizeWorkerMessage } from '@/worker/redaction'

function baseInput(overrides: Partial<RecordCapabilityAttemptsInput> = {}): RecordCapabilityAttemptsInput {
  return {
    projectId: 'project-1',
    taskId: 'task-1',
    workPackageId: 'wp-1',
    agentRunId: 'run-1',
    taskAttemptId: null,
    executionOutcomeId: 'outcome-1',
    operationRunId: null,
    outcome: {
      schemaVersion: 1,
      transportStatus: 'ok',
      result: 'completed',
      stopReasonCode: null,
      stopReasonSummary: null,
      retryable: false,
      evidenceRefs: [],
      verifierRequired: false,
      verificationStatus: 'not_required',
    },
    attemptNumber: 1,
    source: { kind: 'work_package', role: 'backend', capabilities: ['api-implementation'] },
    scope: {
      contractVersion: 1,
      projectId: 'project-1',
      rootRef: 'root-1',
      rootBindingRevision: '1',
      grantDecisionRevision: '1',
      repositoryWriteIntent: false,
      capabilities: ['api-implementation'],
      mcpRequirementKeys: [],
    },
    runtime: {
      kind: 'model',
      providerType: 'anthropic',
      modelId: 'claude-sonnet-5',
      providerIsLocal: false,
      providerConfigUpdatedAt: null,
      acpExecutionMode: 'not_applicable',
    },
    policy: {
      contractVersion: 1,
      policyVersion: 'reliability-policy-v1',
      harnessId: null,
      harnessUpdatedAt: null,
      reviewRequirement: 'both',
      repositoryWritesEnabled: false,
    },
    verificationMode: 'none',
    acceptanceCriteriaTotal: 0,
    validationCommandTotal: 0,
    validationCommandFailed: 0,
    observedAt: new Date('2026-08-01T00:00:00.000Z'),
    ...overrides,
  }
}

describe('recordCapabilityAttempts', () => {
  beforeEach(() => {
    mocks.insertValues.mockReset()
    mocks.insertOnConflict.mockReset()
    delete process.env.FORGE_CAPABILITY_RELIABILITY_LEDGER
  })

  afterEach(() => {
    delete process.env.FORGE_CAPABILITY_RELIABILITY_LEDGER
  })

  it('requests the idempotent conflict target on (execution_outcome_id, capability_key)', async () => {
    await recordCapabilityAttempts(baseInput())
    expect(mocks.insertValues).toHaveBeenCalledTimes(1)
    expect(mocks.insertOnConflict).toHaveBeenCalledWith({
      target: ['execution_outcome_id', 'capability_key'],
    })
  })

  it('refuses independent_agent verification mode at ingest', async () => {
    await recordCapabilityAttempts(baseInput({
      outcome: {
        schemaVersion: 1,
        transportStatus: 'ok',
        result: 'completed',
        stopReasonCode: null,
        stopReasonSummary: null,
        retryable: false,
        evidenceRefs: [],
        verifierRequired: true,
        verificationStatus: 'pending',
      },
      verificationMode: 'independent_agent',
    }))
    expect(mocks.insertValues).not.toHaveBeenCalled()
  })

  it('does not write when the feature flag is explicitly disabled', async () => {
    process.env.FORGE_CAPABILITY_RELIABILITY_LEDGER = '0'
    await recordCapabilityAttempts(baseInput())
    expect(mocks.insertValues).not.toHaveBeenCalled()
  })

  it('writes one unclassified row when the capability classification is missing', async () => {
    await recordCapabilityAttempts(baseInput({
      source: { kind: 'work_package', role: 'backend', capabilities: null },
    }))
    expect(mocks.insertValues).toHaveBeenCalledTimes(1)
    const [, rows] = mocks.insertValues.mock.calls[0] as [unknown, Array<Record<string, unknown>>]
    expect(rows).toHaveLength(1)
    expect(rows[0].capabilityKey).toBe('workpackage:backend/unclassified')
    expect(rows[0].classificationState).toBe('missing')
  })

  it('writes one unclassified overflow row when more than 12 capabilities are declared', async () => {
    const capabilities = Array.from({ length: 13 }, (_, i) => `capability-${i}`)
    await recordCapabilityAttempts(baseInput({
      source: { kind: 'work_package', role: 'backend', capabilities },
    }))
    const [, rows] = mocks.insertValues.mock.calls[0] as [unknown, Array<Record<string, unknown>>]
    expect(rows).toHaveLength(1)
    expect(rows[0].classificationState).toBe('overflow')
  })

  it('writes one row per capability, sharing an attempt group and multiplicity count', async () => {
    await recordCapabilityAttempts(baseInput({
      source: { kind: 'work_package', role: 'backend', capabilities: ['api-implementation', 'database-migration'] },
    }))
    const [, rows] = mocks.insertValues.mock.calls[0] as [unknown, Array<Record<string, unknown>>]
    expect(rows).toHaveLength(2)
    expect(rows[0].attemptGroupId).toBe(rows[1].attemptGroupId)
    expect(rows[0].capabilityMultiplicity).toBe(2)
  })

  it('digests the normalized outcome so redacted or truncated summaries never look drifted', async () => {
    // The stored execution_outcomes row holds the sanitized and truncated
    // summary (upsertExecutionOutcome normalizes before writing), and the
    // reader recomputes the digest from that stored row. The ingest-time
    // digest must therefore be computed over the same normalized form;
    // digesting the raw message would mismatch whenever sanitization or the
    // 1000-char bound changes anything, permanently marking a failed attempt
    // as evidence_drift and suppressing every rate in its cohort.
    const outcome: RecordCapabilityAttemptsInput['outcome'] = {
      schemaVersion: 1,
      transportStatus: 'ok',
      result: 'failed',
      stopReasonCode: 'unknown',
      stopReasonSummary: 'Failed to connect: postgres://admin:hunter2@localhost:5432/forge',
      retryable: false,
      evidenceRefs: [],
      verifierRequired: false,
      verificationStatus: 'not_required',
    }
    await recordCapabilityAttempts(baseInput({ outcome }))
    const [, rows] = mocks.insertValues.mock.calls[0] as [unknown, Array<Record<string, unknown>>]
    const storedDigest = rows[0].outcomeDigest as string
    expect(storedDigest).toBe(outcomeDigest(normalizeExecutionOutcome(outcome, sanitizeWorkerMessage)))
    expect(storedDigest).not.toBe(outcomeDigest(outcome))
  })
})

describe('recordCapabilityAttemptsBestEffort', () => {
  beforeEach(() => {
    mocks.insertValues.mockReset()
    mocks.insertOnConflict.mockReset()
    delete process.env.FORGE_CAPABILITY_RELIABILITY_LEDGER
  })

  it('never throws when the underlying write fails', async () => {
    mocks.insertOnConflict.mockImplementation(() => {
      throw new Error('simulated database failure')
    })
    await expect(recordCapabilityAttemptsBestEffort(baseInput())).resolves.toBeUndefined()
  })
})

describe('adjudication appends', () => {
  beforeEach(() => {
    mocks.dbSelect.mockReset()
    mocks.txSelect.mockReset()
    mocks.txInsert.mockReset()
    mocks.operations.length = 0
    delete process.env.FORGE_CAPABILITY_RELIABILITY_LEDGER
  })

  afterEach(() => {
    delete process.env.FORGE_CAPABILITY_RELIABILITY_LEDGER
  })

  it('allocates the adjudication sequence under the attempt advisory lock, then inserts', async () => {
    mocks.dbSelect
      .mockReturnValueOnce([{ id: 'outcome-1' }])
      .mockReturnValueOnce([{ id: 'ATTEMPT-1' }])
    mocks.txSelect.mockReturnValueOnce([{ sequence: 4 }])

    await recordHumanDecisionAdjudicationBestEffort({
      taskId: 'task-1',
      attemptKey: 'work-package:wp-1:run:run-1',
      humanDecision: 'accepted',
      decidedBy: 'user-1',
      approvalGateId: 'gate-1',
      observedAt: new Date('2026-08-01T00:00:00.000Z'),
    })

    // Bound the advisory-lock wait, then resolve outcome -> resolve attempt
    // rows -> take the advisory lock -> read max sequence -> insert, all in
    // that order inside one transaction.
    expect(mocks.operations).toEqual([
      'select', 'select', 'tx:lock-timeout', 'tx:advisory-lock', 'tx:select', 'tx:insert',
    ])
    // The lock key must be the canonical lowercase form so it pairs with the
    // migration guard's uuid::text derivation even for a non-canonical input.
    expect(mocks.txExecQueries[0]).toContain("lock_timeout = '5s'")
    expect(mocks.txExecQueries[1]).toContain('hashtextextended(attempt-1::text, 0)')
    const [, values] = mocks.txInsert.mock.calls[0] as [unknown, Record<string, unknown>]
    expect(values).toMatchObject({
      capabilityAttemptId: 'ATTEMPT-1',
      sequence: 5,
      kind: 'human_decision',
      humanDecision: 'accepted',
      decidedBy: 'user-1',
      approvalGateId: 'gate-1',
    })
  })

  it('records the deterministic adapter verdict as a verification_recorded adjudication', async () => {
    mocks.dbSelect.mockReturnValueOnce([{ id: 'attempt-1' }])
    mocks.txSelect.mockReturnValueOnce([])

    await recordDeterministicAdapterVerdictBestEffort({
      executionOutcomeId: 'outcome-1',
      verificationResult: 'passed',
      observedAt: new Date('2026-08-01T00:00:00.000Z'),
    })

    expect(mocks.operations).toContain('tx:advisory-lock')
    const [, values] = mocks.txInsert.mock.calls[0] as [unknown, Record<string, unknown>]
    expect(values).toMatchObject({
      capabilityAttemptId: 'attempt-1',
      sequence: 0,
      kind: 'verification_recorded',
      verificationMode: 'deterministic_adapter',
      verificationResult: 'passed',
    })
  })

  it('writes no adjudication when the outcome has no attempt rows', async () => {
    mocks.dbSelect
      .mockReturnValueOnce([{ id: 'outcome-1' }])
      .mockReturnValueOnce([])

    await recordVerificationAdjudicationBestEffort({
      taskId: 'task-1',
      attemptKey: 'work-package:wp-1:run:run-1',
      verificationMode: 'human_review',
      verificationResult: 'passed',
      observedAt: new Date('2026-08-01T00:00:00.000Z'),
    })

    expect(mocks.txInsert).not.toHaveBeenCalled()
  })
})
