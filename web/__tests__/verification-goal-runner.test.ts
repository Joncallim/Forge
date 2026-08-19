import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Project } from '@/db/schema'
import { resolveVerificationGoalOperationBinding } from '@/lib/verification-goals/eligibility'
import { VERIFICATION_GOAL_SYSTEM_LIMITS_V1 } from '@/lib/verification-goals/system-limits'
import { RootCommandLauncherError } from '@/worker/verification-goals/root-command-launcher'
import type { TrustedExecutableRegistryV1 } from '@/worker/verification-goals/trusted-executables'

const mocks = vi.hoisted(() => ({
  dbExecute: vi.fn(),
  loadAuthority: vi.fn(),
  computeProfile: vi.fn(),
  launch: vi.fn(),
  revalidate: vi.fn(),
}))

vi.mock('@/db', () => ({ db: { execute: mocks.dbExecute } }))
vi.mock('@/worker/verification-goals/filesystem-authority', () => ({
  loadVerificationGoalFilesystemAuthority: mocks.loadAuthority,
}))
vi.mock('@/worker/verification-goals/repository-profile', () => ({
  computeGoalRepositoryProfile: mocks.computeProfile,
}))
vi.mock('@/worker/verification-goals/trusted-executables', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/worker/verification-goals/trusted-executables')>(),
  revalidateTrustedExecutable: mocks.revalidate,
}))
vi.mock('@/worker/verification-goals/root-command-launcher', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/worker/verification-goals/root-command-launcher')>(),
  launchRootAnchoredCommand: mocks.launch,
}))

import { executeVerificationGoalRun } from '@/worker/verification-goals/runner'

const PROJECT_ID = '11111111-1111-4111-8111-111111111111'
const RUN_ID = '22222222-2222-4222-8222-222222222222'
const CHILD_ID = '33333333-3333-4333-8333-333333333333'
const USER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

const GOAL_CAPABILITY = 'filesystem.project.read'
const PASSED_LAUNCH = {
  exitCode: 0,
  signal: null,
  stdout: 'clean',
  stderr: '',
  timedOut: false,
  spawnError: null,
}

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

function executableRegistry(): TrustedExecutableRegistryV1 {
  const base = {
    schemaVersion: 1 as const,
    absoluteRealPath: '/usr/bin/node',
    device: BigInt(1),
    inode: BigInt(2),
    contentDigest: '1'.repeat(64),
    normalizedVersion: 'v22.0.0',
  }
  return {
    schemaVersion: 1,
    node: { ...base, kind: 'node' as const },
    git: {
      ...base,
      kind: 'git' as const,
      absoluteRealPath: '/usr/bin/git',
      normalizedVersion: 'git version 2.45.0',
    },
  }
}

function authorityFixture() {
  return {
    projectId: PROJECT_ID,
    path: '/workspace/projects/example',
    dev: BigInt(1),
    ino: BigInt(2),
    rootBindingRevision: BigInt(7),
    grantDecisionRevision: BigInt(9),
    projectRevision: new Date('2026-08-01T00:00:00.000Z'),
  }
}

function profileFixture() {
  return {
    schemaVersion: 1,
    supported: true,
    reasonCode: null,
    objectFormat: 'sha1',
    headOid: 'a'.repeat(40),
    metadataFingerprint: 'b'.repeat(64),
    indexFingerprint: 'c'.repeat(64),
    configFingerprint: 'd'.repeat(64),
    gitSafetyProfileVersion: 1,
    gitSafetyProfileDigest: 'e'.repeat(64),
  }
}

function authoritativeBinding(operationId: string) {
  return resolveVerificationGoalOperationBinding({
    operationId,
    operationVersion: 1,
    goalCapability: GOAL_CAPABILITY,
    trigger: 'manual',
  })
}

type PolicyOperation = {
  operationId: string
  definitionDigest?: string
  executionProfileDigest?: string
}

function resolvedPolicyFixture(operations: PolicyOperation[]) {
  return {
    goalCapability: GOAL_CAPABILITY,
    effectiveDeadlineSeconds: 120,
    canonicalOperationOrdinals: operations.map((operation, index) => {
      const binding = authoritativeBinding(operation.operationId)
      return {
        ordinal: index,
        operationId: operation.operationId,
        operationVersion: 1,
        definitionDigest: operation.definitionDigest ?? binding.definitionDigest,
        executionProfileDigest: operation.executionProfileDigest ?? binding.executionProfileDigest,
        eligibility: 'manual_and_scheduled',
        timeoutSeconds: 30,
      }
    }),
  }
}

function runRowFixture(resolvedPolicy: unknown) {
  return {
    registry_revision_id: '55555555-5555-4555-8555-555555555555',
    registry_entry_ordinal: 0,
    snapshot_id: '66666666-6666-4666-8666-666666666666',
    goal_id: 'goal-one',
    definition_version: 1,
    definition_digest: 'f'.repeat(64),
    source_path: '.forge/verification-goals/goal-one.json',
    execution_binding_digest: null,
    policy_revision_id: '77777777-7777-4777-8777-777777777777',
    policy_revision_sequence: '1',
    resolved_policy: resolvedPolicy,
    resolved_policy_fingerprint: '9'.repeat(64),
    trigger_kind: 'manual',
  }
}

function queueDb(...rows: unknown[]) {
  const queue = [...rows]
  mocks.dbExecute.mockImplementation(async () => {
    const next = queue.shift()
    if (next instanceof Error) throw next
    return next
  })
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

function callSql(callIndex: number): string {
  const [query] = mocks.dbExecute.mock.calls[callIndex]! as [SqlQuery]
  return renderSql(query)
}

function callParams(callIndex: number): unknown[] {
  const [query] = mocks.dbExecute.mock.calls[callIndex]! as [SqlQuery]
  return extractParams(query)
}

function runContext() {
  return {
    project: projectFixture(),
    runId: RUN_ID,
    trustedExecutables: executableRegistry(),
    nodePath: '/usr/bin/node',
    gitPath: '/usr/bin/git',
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.revalidate.mockResolvedValue(undefined)
  mocks.loadAuthority.mockResolvedValue(authorityFixture())
  mocks.computeProfile.mockResolvedValue(profileFixture())
  mocks.launch.mockResolvedValue(PASSED_LAUNCH)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('executeVerificationGoalRun', () => {
  it('executes the exact bound operations in order, records both evidence snapshots, and finalizes with the claim lease token', async () => {
    queueDb(
      undefined,      // 0: lease claim
      [runRowFixture(resolvedPolicyFixture([{ operationId: 'repository.status.read' }]))], // 1: run row
      [],             // 2: repository snapshot
      [],             // 3: environment snapshot
      [{ id: CHILD_ID }], // 4: begin child
      [],             // 5: finalize child
      [],             // 6: terminalize
    )

    const outcome = await executeVerificationGoalRun(runContext())

    expect(outcome).toEqual({ result: 'passed', terminalCode: 'passed' })
    expect(mocks.dbExecute).toHaveBeenCalledTimes(7)
    expect(callSql(2)).toContain('forge_record_verification_goal_repository_snapshot_v1')
    expect(callSql(3)).toContain('forge_record_verification_goal_environment_snapshot_v1')
    expect(callSql(4)).toContain('forge_begin_verification_goal_child_operation_v1')
    expect(callSql(5)).toContain('forge_finalize_verification_goal_child_operation_v1')
    expect(callSql(6)).toContain('forge_terminalize_verification_goal_run_v2')

    // The claim token is the third claim parameter; the lease-fenced finalize
    // must carry the same token so a fenced row can never be finalized.
    const claimParams = callParams(0)
    const leaseToken = claimParams[2]
    expect(leaseToken).toMatch(/^[0-9a-f-]{36}$/u)
    expect(callParams(5)).toContain(leaseToken)

    // The launch must run the exact reviewed git template under the retained
    // filesystem authority, never a caller-shaped argv.
    expect(mocks.launch).toHaveBeenCalledOnce()
    expect(mocks.launch).toHaveBeenCalledWith(expect.objectContaining({
      executable: expect.objectContaining({ kind: 'git' }),
      argv: ['status', '--short'],
      timeoutMs: 30_000,
    }))
    expect(mocks.launch.mock.calls[0]![0]).toMatchObject({
      rootLease: { projectId: PROJECT_ID, path: '/workspace/projects/example' },
    })
  })

  it('refuses a stored policy that lacks the canonical operation key', async () => {
    queueDb(
      undefined,      // 0: lease claim
      [runRowFixture({
        goalCapability: GOAL_CAPABILITY,
        operations: [{ operationId: 'repository.status.read' }],
      })],           // 1: run row with the legacy `operations` key
      [],             // 2: terminalize
    )

    const outcome = await executeVerificationGoalRun(runContext())

    expect(outcome).toEqual({ result: 'inconclusive', terminalCode: 'operation_contract_changed' })
    expect(mocks.dbExecute).toHaveBeenCalledTimes(3)
    expect(callSql(2)).toContain('forge_terminalize_verification_goal_run_v2')
    expect(mocks.launch).not.toHaveBeenCalled()
  })

  it('terminalizes a spawn-level launch failure as infrastructure, never as a pass', async () => {
    mocks.launch.mockResolvedValue({
      exitCode: null,
      signal: null,
      stdout: '',
      stderr: '',
      timedOut: false,
      spawnError: { code: 'ENOENT', message: 'spawn git ENOENT' },
    })
    queueDb(
      undefined,
      [runRowFixture(resolvedPolicyFixture([{ operationId: 'repository.status.read' }]))],
      [],
      [],
      [{ id: CHILD_ID }],
      [],
      [],
    )

    const outcome = await executeVerificationGoalRun(runContext())

    expect(outcome).toEqual({ result: 'inconclusive', terminalCode: 'operation_infrastructure_failed' })
    expect(callSql(6)).toContain('forge_terminalize_verification_goal_run_v2')
  })

  it('stops before execution when the stored binding digests no longer match the reviewed code', async () => {
    queueDb(
      undefined,
      [runRowFixture(resolvedPolicyFixture([
        { operationId: 'repository.status.read', definitionDigest: '0'.repeat(64) },
      ]))],
      [],
      [],
      [],             // terminalize
    )

    const outcome = await executeVerificationGoalRun(runContext())

    expect(outcome).toEqual({ result: 'inconclusive', terminalCode: 'operation_contract_changed' })
    expect(callSql(4)).toContain('forge_terminalize_verification_goal_run_v2')
    expect(mocks.launch).not.toHaveBeenCalled()
  })

  it('abandons proof writes without terminalizing once the business lease is lost', async () => {
    vi.useFakeTimers()
    queueDb(
      undefined,      // 0: lease claim
      [runRowFixture(resolvedPolicyFixture([
        { operationId: 'repository.status.read' },
        { operationId: 'repository.branch.read' },
      ]))],           // 1: run row with two operations
      [],             // 2: repository snapshot
      [],             // 3: environment snapshot
      [{ id: CHILD_ID }], // 4: begin first child
      [{ state: 'not_owner' }], // 5: renewal response, fired during the first launch
      [],             // 6: finalize first child
    )
    mocks.launch.mockImplementation(async () => {
      await vi.advanceTimersByTimeAsync(VERIFICATION_GOAL_SYSTEM_LIMITS_V1.leaseRenewTargetMs)
      return PASSED_LAUNCH
    })

    const outcome = await executeVerificationGoalRun(runContext())

    expect(outcome).toEqual({ result: 'inconclusive', terminalCode: 'lease_lost' })
    expect(mocks.dbExecute).toHaveBeenCalledTimes(7)
    expect(mocks.launch).toHaveBeenCalledOnce()
    const executedSql = mocks.dbExecute.mock.calls.map(([query]) => renderSql(query as SqlQuery))
    expect(executedSql.some((sqlText) => sqlText.includes('forge_terminalize_verification_goal_run_v2'))).toBe(false)
  })

  it('maps a root-anchored launcher failure to its terminal code', async () => {
    mocks.launch.mockRejectedValue(
      new RootCommandLauncherError('root_changed', 'Project root dev/ino mismatch before launch.'),
    )
    queueDb(
      undefined,
      [runRowFixture(resolvedPolicyFixture([{ operationId: 'repository.status.read' }]))],
      [],
      [],
      [{ id: CHILD_ID }],
      [],
    )

    const outcome = await executeVerificationGoalRun(runContext())

    expect(outcome).toEqual({ result: 'inconclusive', terminalCode: 'root_changed' })
    expect(callSql(5)).toContain('forge_terminalize_verification_goal_run_v2')
  })

  it('maps an unsupported repository profile to its reason code without launching', async () => {
    mocks.computeProfile.mockResolvedValue({
      ...profileFixture(),
      supported: false,
      reasonCode: 'repository_dirty',
    })
    queueDb(
      undefined,
      [runRowFixture(resolvedPolicyFixture([{ operationId: 'repository.status.read' }]))],
      [],             // terminalize
    )

    const outcome = await executeVerificationGoalRun(runContext())

    expect(outcome).toEqual({ result: 'inconclusive', terminalCode: 'repository_dirty' })
    expect(callSql(2)).toContain('forge_terminalize_verification_goal_run_v2')
    expect(mocks.launch).not.toHaveBeenCalled()
  })
})
