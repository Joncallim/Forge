import { describe, expect, it, vi } from 'vitest'

import { BUILT_IN_OPERATIONS, createOperationCatalog } from '@/lib/operations/catalog'
import type { OperationExecutionResult } from '@/lib/operations/contracts'
import { createRepositoryStatusReadAdapter } from '@/worker/operations/adapters/repository-read'
import {
  OperationAdapterExecutionError,
  executeOperation,
  type FixedOperationAdapters,
  type OperationLedger,
  type OperationRunEventWrite,
  type OperationRunFinalization,
  type OperationRunStart,
  type TrustedOperationContext,
} from '@/worker/operations/executor'

const taskId = '11111111-1111-4111-8111-111111111111'
const projectId = '22222222-2222-4222-8222-222222222222'
const runId = '33333333-3333-4333-8333-333333333333'
const outcomeId = '44444444-4444-4444-8444-444444444444'
const evidenceId = '55555555-5555-4555-8555-555555555555'

class FakeLedger implements OperationLedger {
  start: OperationRunStart | null = null
  events: OperationRunEventWrite[] = []
  finalization: OperationRunFinalization | null = null
  replay: OperationExecutionResult | null = null

  async begin(input: OperationRunStart) {
    this.start = input
    if (this.replay) {
      return {
        kind: 'replayed' as const,
        requestFingerprint: input.requestFingerprint,
        definitionDigest: input.definitionDigest,
        scopeFingerprint: input.scopeFingerprint,
        result: this.replay,
      }
    }
    return { kind: 'started' as const, runId }
  }

  async appendEvent(event: OperationRunEventWrite) {
    this.events.push(event)
  }

  async finalize(input: OperationRunFinalization) {
    this.finalization = input
    this.events.push(input.outcomeEvent)
    return { executionOutcomeId: outcomeId }
  }
}

function context(overrides: Partial<TrustedOperationContext> = {}): TrustedOperationContext {
  return {
    taskId,
    projectId,
    attemptKey: 'attempt-1',
    projectRoot: '/trusted/project',
    rootBindingRevision: '7',
    projectRevision: '2026-08-06T00:00:00.000Z',
    policy: {
      projectId,
      scopedProjectId: projectId,
      policyVersion: 'policy-v1',
      allowedCapabilities: ['filesystem.project.read'],
      policyCeilings: { repository_read: true },
    },
    ...overrides,
  }
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    operationId: 'repository.status.read',
    operationVersion: 1,
    inputs: {},
    reason: 'Read status.',
    requestedCapability: 'filesystem.project.read',
    ...overrides,
  }
}

function adapters(overrides: Partial<FixedOperationAdapters> = {}): FixedOperationAdapters {
  return {
    repositoryStatusRead: vi.fn(async () => ({ output: { exitCode: 0, summary: 'M file.ts' }, evidenceRefs: [evidenceId] })),
    repositoryDiffSummary: vi.fn(async () => ({ output: { exitCode: 0, summary: '1 file changed' }, evidenceRefs: [evidenceId] })),
    repositoryBranchRead: vi.fn(async () => ({ output: { exitCode: 0, summary: 'main' }, evidenceRefs: [evidenceId] })),
    ...overrides,
  }
}

describe('deterministic operation executor', () => {
  it('records fixed ordered phases and links a verified canonical outcome', async () => {
    const ledger = new FakeLedger()
    const result = await executeOperation({ request: request(), context: context(), dependencies: { ledger, adapters: adapters() } })

    expect(result).toMatchObject({ status: 'completed', verificationStatus: 'passed', replayed: false })
    expect(result.definitionDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(result.scopeFingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(ledger.start?.inputsFingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(ledger.events.map(({ sequence, phase }) => [sequence, phase])).toEqual([
      [0, 'request_validation'], [1, 'policy'], [2, 'preflight'],
      [3, 'execution'], [4, 'verification'], [5, 'outcome'],
    ])
    expect(ledger.finalization?.outcome).toMatchObject({ result: 'completed', stopReasonCode: null })
  })

  it('fails invalid input before the ledger or adapter sees it', async () => {
    const ledger = new FakeLedger()
    const fixed = adapters()
    await expect(executeOperation({
      request: request({ inputs: { cwd: '/tmp', argv: ['sh'] } }),
      context: context(),
      dependencies: { ledger, adapters: fixed },
    })).rejects.toThrow('Inputs do not match')
    expect(ledger.start).toBeNull()
    expect(fixed.repositoryStatusRead).not.toHaveBeenCalled()
  })

  it('blocks on the trusted policy ceiling before adapter execution', async () => {
    const ledger = new FakeLedger()
    const fixed = adapters()
    const trusted = context({
      policy: { ...context().policy, policyCeilings: { repository_read: false } },
    })
    const result = await executeOperation({ request: request(), context: trusted, dependencies: { ledger, adapters: fixed } })
    expect(result.status).toBe('blocked')
    expect(result.outcome?.stopReasonCode).toBe('policy_blocked')
    expect(fixed.repositoryStatusRead).not.toHaveBeenCalled()
    expect(ledger.events.map((event) => event.phase)).toEqual(['request_validation', 'policy', 'outcome'])
  })

  it('does not treat adapter transport success as verification success', async () => {
    const ledger = new FakeLedger()
    const fixed = adapters({
      repositoryStatusRead: vi.fn(async () => ({ output: { exitCode: 0, summary: 'transport only' }, evidenceRefs: [] })),
    })
    const result = await executeOperation({ request: request(), context: context(), dependencies: { ledger, adapters: fixed } })
    expect(result).toMatchObject({ status: 'failed', verificationStatus: 'failed' })
    expect(result.outcome?.stopReasonCode).toBe('validation_failed')
  })

  it('fails closed on timeout', async () => {
    const ledger = new FakeLedger()
    const timeoutDefinition = { ...BUILT_IN_OPERATIONS[0], timeoutMs: 5 }
    let observedSignal: AbortSignal | null = null
    let adapterSettled = false
    const fixed = adapters({
      repositoryStatusRead: vi.fn((_context, execution) => {
        observedSignal = execution.signal
        return new Promise<never>((_resolve, reject) => {
          execution.signal.addEventListener('abort', () => {
            adapterSettled = true
            reject(new OperationAdapterExecutionError('cancelled', [evidenceId]))
          }, { once: true })
        })
      }),
    })
    const result = await executeOperation({
      request: request(),
      context: context(),
      dependencies: { ledger, adapters: fixed, catalog: createOperationCatalog([timeoutDefinition]) },
    })
    expect(result.status).toBe('failed')
    expect(result.outcome?.stopReasonCode).toBe('timeout')
    expect((observedSignal as unknown as AbortSignal).aborted).toBe(true)
    expect(adapterSettled).toBe(true)
    expect(ledger.events.find((event) => event.phase === 'execution')?.evidenceRefs).toEqual([evidenceId])
    expect(ledger.finalization?.outcome.evidenceRefs).toEqual([evidenceId])
  })

  it('links typed adapter-failure audit evidence without exposing raw output', async () => {
    const ledger = new FakeLedger()
    const result = await executeOperation({
      request: request(),
      context: context(),
      dependencies: {
        ledger,
        adapters: adapters({
          repositoryStatusRead: vi.fn(async () => {
            throw new OperationAdapterExecutionError('adapter_failed', [evidenceId])
          }),
        }),
      },
    })
    expect(result).toMatchObject({ status: 'failed', output: null })
    expect(result.outcome).toMatchObject({ evidenceRefs: [evidenceId], stopReasonSummary: 'The deterministic operation execution failed.' })
    expect(ledger.events.find((event) => event.phase === 'execution')?.evidenceRefs).toEqual([evidenceId])
  })

  it('leaves the run incomplete when an injected adapter ignores cancellation', async () => {
    const ledger = new FakeLedger()
    const timeoutDefinition = { ...BUILT_IN_OPERATIONS[0], timeoutMs: 5 }
    await expect(executeOperation({
      request: request(),
      context: context(),
      dependencies: {
        ledger,
        adapters: adapters({ repositoryStatusRead: vi.fn(() => new Promise<never>(() => {})) }),
        catalog: createOperationCatalog([timeoutDefinition]),
      },
    })).rejects.toThrow('requires recovery')
    expect(ledger.finalization).toBeNull()
    expect(ledger.events.map((event) => event.phase)).toEqual(['request_validation', 'policy', 'preflight'])
  })

  it('keeps the audit-only reason out of request idempotency', async () => {
    const first = new FakeLedger()
    const second = new FakeLedger()
    await executeOperation({ request: request({ reason: 'First audit note.' }), context: context(), dependencies: { ledger: first, adapters: adapters() } })
    await executeOperation({ request: request({ reason: 'Different audit note.' }), context: context(), dependencies: { ledger: second, adapters: adapters() } })
    expect(first.start?.idempotencyKey).toBe(second.start?.idempotencyKey)
    expect(first.start?.requestFingerprint).toBe(second.start?.requestFingerprint)
    expect(first.start?.reasonFingerprint).not.toBe(second.start?.reasonFingerprint)
  })

  it('binds replay scope to normalized policy and project revisions', async () => {
    const baseline = new FakeLedger()
    const reordered = new FakeLedger()
    const policyChanged = new FakeLedger()
    const rootChanged = new FakeLedger()
    const projectChanged = new FakeLedger()
    await executeOperation({ request: request(), context: context(), dependencies: { ledger: baseline, adapters: adapters() } })
    await executeOperation({
      request: request(),
      context: context({
        policy: {
          ...context().policy,
          allowedCapabilities: ['filesystem.project.read', 'filesystem.project.read'],
        },
      }),
      dependencies: { ledger: reordered, adapters: adapters() },
    })
    await executeOperation({
      request: request(),
      context: context({ policy: { ...context().policy, policyVersion: 'policy-v2' } }),
      dependencies: { ledger: policyChanged, adapters: adapters() },
    })
    await executeOperation({
      request: request(),
      context: context({ rootBindingRevision: '8' }),
      dependencies: { ledger: rootChanged, adapters: adapters() },
    })
    await executeOperation({
      request: request(),
      context: context({ projectRevision: '2026-08-06T00:01:00.000Z' }),
      dependencies: { ledger: projectChanged, adapters: adapters() },
    })

    expect(reordered.start?.scopeFingerprint).toBe(baseline.start?.scopeFingerprint)
    expect(policyChanged.start?.scopeFingerprint).not.toBe(baseline.start?.scopeFingerprint)
    expect(rootChanged.start?.scopeFingerprint).not.toBe(baseline.start?.scopeFingerprint)
    expect(projectChanged.start?.scopeFingerprint).not.toBe(baseline.start?.scopeFingerprint)
  })

  it('keeps idempotency stable per operation and distinct across operations', async () => {
    const status = new FakeLedger()
    const diff = new FakeLedger()
    const branch = new FakeLedger()
    await executeOperation({ request: request(), context: context(), dependencies: { ledger: status, adapters: adapters() } })
    await executeOperation({
      request: request({ operationId: 'repository.diff.summary' }),
      context: context(),
      dependencies: { ledger: diff, adapters: adapters() },
    })
    await executeOperation({
      request: request({
        operationId: 'repository.branch.read',
      }),
      context: context(),
      dependencies: { ledger: branch, adapters: adapters() },
    })

    expect(new Set([
      status.start?.idempotencyKey,
      diff.start?.idempotencyKey,
      branch.start?.idempotencyKey,
    ])).toHaveProperty('size', 3)
    expect(new Set([
      status.finalization?.attemptKey,
      diff.finalization?.attemptKey,
      branch.finalization?.attemptKey,
    ])).toHaveProperty('size', 3)
  })

  it('records trusted-scope failure as preflight, before adapter execution', async () => {
    const ledger = new FakeLedger()
    const fixed = adapters()
    const result = await executeOperation({
      request: request(),
      context: context({ projectRoot: null }),
      dependencies: { ledger, adapters: fixed },
    })
    expect(result.status).toBe('failed')
    expect(result.outcome?.stopReasonCode).toBe('missing_repository_context')
    expect(fixed.repositoryStatusRead).not.toHaveBeenCalled()
    expect(ledger.events.map((event) => [event.phase, event.status])).toEqual([
      ['request_validation', 'passed'],
      ['policy', 'passed'],
      ['preflight', 'failed'],
      ['outcome', 'failed'],
    ])
  })

  it('attributes a non-absolute trusted repository root to preflight', async () => {
    const ledger = new FakeLedger()
    const runCommand = vi.fn(async () => ({ exitCode: 0, outputSummary: '' }))
    const fixed = adapters({
      repositoryStatusRead: createRepositoryStatusReadAdapter({ runCommand }),
    })
    const result = await executeOperation({
      request: request(),
      context: context({ projectRoot: '../outside' }),
      dependencies: { ledger, adapters: fixed },
    })

    expect(result.status).toBe('failed')
    expect(runCommand).not.toHaveBeenCalled()
    expect(ledger.events.map((event) => [event.phase, event.status, event.detailCode])).toEqual([
      ['request_validation', 'passed', 'request_valid'],
      ['policy', 'passed', 'allowed'],
      ['preflight', 'failed', 'preflight_failed'],
      ['outcome', 'failed', 'missing_repository_context'],
    ])
  })

  it('rejects invalid evidence references and replays a completed idempotent run without execution', async () => {
    const invalidLedger = new FakeLedger()
    const invalid = adapters({
      repositoryStatusRead: vi.fn(async () => ({ output: { exitCode: 0, summary: '' }, evidenceRefs: ['not-a-uuid'] })),
    })
    const failed = await executeOperation({ request: request(), context: context(), dependencies: { ledger: invalidLedger, adapters: invalid } })
    expect(failed.status).toBe('failed')

    const ledger = new FakeLedger()
    ledger.replay = {
      runId,
      operationId: 'repository.status.read',
      operationVersion: 1,
      definitionDigest: 'a'.repeat(64),
      scopeFingerprint: 'b'.repeat(64),
      status: 'completed',
      verificationStatus: 'passed',
      replayed: false,
      output: { shouldNotReplay: true },
      outcome: null,
    }
    const fixed = adapters()
    const replayed = await executeOperation({ request: request(), context: context(), dependencies: { ledger, adapters: fixed } })
    expect(replayed).toMatchObject({ replayed: true, output: null })
    expect(fixed.repositoryStatusRead).not.toHaveBeenCalled()
  })

  it('does not return a nonterminal running row as a completed replay', async () => {
    const ledger = new FakeLedger()
    ledger.replay = {
      runId,
      operationId: 'repository.status.read',
      operationVersion: 1,
      definitionDigest: 'a'.repeat(64),
      scopeFingerprint: 'b'.repeat(64),
      status: 'running',
      verificationStatus: 'not_started',
      replayed: false,
      output: null,
      outcome: null,
    }
    const fixed = adapters()
    await expect(executeOperation({
      request: request(),
      context: context(),
      dependencies: { ledger, adapters: fixed },
    })).rejects.toThrow('still in progress or requires recovery')
    expect(fixed.repositoryStatusRead).not.toHaveBeenCalled()
  })
})
