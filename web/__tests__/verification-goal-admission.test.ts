import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Project } from '@/db/schema'
import type { VerificationGoalDefinitionV2 } from '@/lib/verification-goals/executable-contracts'

const mocks = vi.hoisted(() => ({
  dbExecute: vi.fn(),
}))

vi.mock('@/db', () => ({ db: { execute: mocks.dbExecute } }))

import { admitManualVerificationGoalRun } from '@/worker/verification-goals/admission'

const PROJECT_ID = '11111111-1111-4111-8111-111111111111'
const USER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const RUN_ID = '22222222-2222-4222-8222-222222222222'
const SNAPSHOT_ID = '33333333-3333-4333-8333-333333333333'
const REGISTRY_REVISION_ID = '55555555-5555-4555-8555-555555555555'
const POLICY_REVISION_ID = '77777777-7777-4777-8777-777777777777'
const IDEMPOTENCY_KEY = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

function projectFixture(): Project {
  return {
    id: PROJECT_ID,
    name: 'example',
    submittedBy: USER_ID,
    githubRepo: null,
    localPath: '/workspace/projects/example',
    githubTokenEnvVar: null,
    pmProviderConfigId: null,
    mcpConfig: { profile: 'default', requiredMcps: [], overrides: {} },
    rootRef: '44444444-4444-4444-8444-444444444444',
    grantDecisionRevision: BigInt(9),
    rootBindingRevision: BigInt(7),
    defaultBranch: 'main',
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
    updatedAt: new Date('2026-08-01T00:00:00.000Z'),
    archivedAt: null,
  }
}

function goalFixture(overrides: Partial<VerificationGoalDefinitionV2> = {}): VerificationGoalDefinitionV2 {
  return {
    schemaVersion: 2,
    goalId: 'goal-one',
    definitionVersion: 1,
    title: 'Status is readable',
    description: 'Prove the repository status read.',
    capability: 'filesystem.project.read',
    severity: 'medium',
    enabled: true,
    operations: [{ operationId: 'repository.status.read', operationVersion: 1 }],
    execution: {
      manual: true,
      schedule: null,
      deadlineSeconds: 60,
      requiredEvidence: ['repository_identity', 'execution_environment'],
    },
    ...overrides,
  }
}

function admissionInput(overrides: Record<string, unknown> = {}) {
  return {
    project: projectFixture(),
    goal: goalFixture(),
    snapshotId: SNAPSHOT_ID,
    sourcePath: '.forge/verification-goals/goal-one.json',
    definitionDigest: 'a'.repeat(64),
    registryRevisionId: REGISTRY_REVISION_ID,
    registryEntryOrdinal: 0,
    executionBindingDigest: null,
    requestedByUserId: USER_ID,
    manualIdempotencyKey: IDEMPOTENCY_KEY,
    policyRevisionId: POLICY_REVISION_ID,
    policyRevisionSequence: BigInt(1),
    ...overrides,
  }
}

type SqlQuery = { queryChunks: unknown[] }

function renderSql(query: SqlQuery): string {
  return query.queryChunks.map((chunk) => {
    if (
      chunk !== null
      && typeof chunk === 'object'
      && Array.isArray((chunk as { value?: unknown }).value)
    ) {
      return (chunk as { value: string[] }).value.join('')
    }
    return '<param>'
  }).join('')
}

function extractParams(query: SqlQuery): unknown[] {
  return query.queryChunks.filter((chunk) => !(
    chunk !== null
    && typeof chunk === 'object'
    && Array.isArray((chunk as { value?: unknown }).value)
  ))
}

function resolvedPolicyParam(): Record<string, unknown> {
  const [query] = mocks.dbExecute.mock.calls[0]! as [SqlQuery]
  const serialized = extractParams(query).find(
    (param): param is string => typeof param === 'string' && param.startsWith('{"schemaVersion":1'),
  )
  if (!serialized) throw new Error('Expected the resolved policy JSON parameter.')
  return JSON.parse(serialized) as Record<string, unknown>
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('admitManualVerificationGoalRun', () => {
  it('admits through the protected routine with the live policy head and canonical operation ordinals', async () => {
    mocks.dbExecute.mockResolvedValueOnce([{ run_id: RUN_ID, state: 'created' }])

    const result = await admitManualVerificationGoalRun(admissionInput())

    expect(result).toEqual({ runId: RUN_ID, state: 'created' })
    expect(mocks.dbExecute).toHaveBeenCalledOnce()

    const [query] = mocks.dbExecute.mock.calls[0]! as [SqlQuery]
    const sqlText = renderSql(query)
    expect(sqlText).toContain('forge_admit_verification_goal_run_v1')
    expect(sqlText).not.toContain('INSERT INTO')

    // The authoritative policy identity must travel as the real live head
    // parameters, and the bigint sequence must never be smuggled through JSON.
    const params = extractParams(query)
    expect(params).toContain(PROJECT_ID)
    expect(params).toContain(POLICY_REVISION_ID)
    expect(params).toContain(BigInt(1))
    expect(params).toContain(USER_ID)
    expect(params).toContain(IDEMPOTENCY_KEY)
    // The manual trigger kind is a fixed template literal, never caller data.
    expect(sqlText).toContain("'manual'")

    const policy = resolvedPolicyParam()
    expect(policy.policyRevisionSequence).toBe('1')
    expect(policy.triggerKind).toBe('manual')
    expect(policy.goalCapability).toBe('filesystem.project.read')
    expect(Array.isArray(policy.canonicalOperationOrdinals)).toBe(true)
    const ordinals = policy.canonicalOperationOrdinals as Array<Record<string, unknown>>
    expect(ordinals).toHaveLength(1)
    expect(ordinals[0]).toMatchObject({
      ordinal: 0,
      operationId: 'repository.status.read',
      operationVersion: 1,
      eligibility: 'manual_and_scheduled',
      timeoutSeconds: 30,
    })
    expect(ordinals[0]!.definitionDigest).toMatch(/^[0-9a-f]{64}$/u)
    expect(ordinals[0]!.executionProfileDigest).toMatch(/^[0-9a-f]{64}$/u)
  })

  it('returns the existing run for an idempotent replay without changing state', async () => {
    mocks.dbExecute.mockResolvedValueOnce([{ run_id: RUN_ID, state: 'existing' }])

    const result = await admitManualVerificationGoalRun(admissionInput())

    expect(result).toEqual({ runId: RUN_ID, state: 'existing' })
    expect(mocks.dbExecute).toHaveBeenCalledOnce()
  })

  it('throws a stable error when the protected routine returns no admission row', async () => {
    mocks.dbExecute.mockResolvedValueOnce([])

    await expect(admitManualVerificationGoalRun(admissionInput())).rejects.toThrow(
      'Verification goal admission returned no row.',
    )
  })

  it('rejects a non-allowlisted operation before any database call', async () => {
    const input = admissionInput({
      goal: goalFixture({
        operations: [{ operationId: 'mcp.unsafe.run', operationVersion: 1 }],
      }),
    })

    await expect(admitManualVerificationGoalRun(input)).rejects.toThrow(
      /not registered|not on the goal-execution allowlist/u,
    )
    expect(mocks.dbExecute).not.toHaveBeenCalled()
  })

  it('rejects an allowlisted operation whose capability does not match the goal before any database call', async () => {
    const input = admissionInput({
      goal: goalFixture({ capability: 'filesystem.project.write' }),
    })

    await expect(admitManualVerificationGoalRun(input)).rejects.toThrow(
      /does not match the goal capability/u,
    )
    expect(mocks.dbExecute).not.toHaveBeenCalled()
  })
})
