import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  insertValues: vi.fn(),
  insertOnConflict: vi.fn(),
}))

function chain(rows: unknown[]): Record<string, unknown> {
  const thenable: Record<string, unknown> = {
    then: (onFulfilled: (value: unknown[]) => unknown) => Promise.resolve(rows).then(onFulfilled),
  }
  thenable.from = () => thenable
  thenable.where = () => thenable
  thenable.orderBy = () => thenable
  thenable.limit = () => thenable
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
    select: () => chain([]),
  },
}))

vi.mock('@/db/schema', () => ({
  capabilityAttempts: {
    executionOutcomeId: 'execution_outcome_id',
    capabilityKey: 'capability_key',
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
  type RecordCapabilityAttemptsInput,
} from '@/worker/reliability/ledger'

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
