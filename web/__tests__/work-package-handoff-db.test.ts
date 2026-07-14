import { execFile as execFileCallback } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  dbInsert: vi.fn(),
  dbSelect: vi.fn(),
  dbTransaction: vi.fn(async (callback: (tx: unknown) => unknown) =>
    callback({
      insert: vi.fn(),
      update: vi.fn(),
    }),
  ),
  dbUpdate: vi.fn(),
  getProjectMcpOverview: vi.fn(),
  materializeReviewGatesForWorkPackageCompletion: vi.fn(),
  completeTaskIfReviewGatesSatisfied: vi.fn(),
  executeWorkPackage: vi.fn(),
  loadWorkPackageExecutionContext: vi.fn(),
  publishTaskEvent: vi.fn(),
  WorkPackageExecutionError: class WorkPackageExecutionError extends Error {
    failureDetails: unknown

    constructor(message: string, failureDetails: unknown) {
      super(message)
      this.name = 'WorkPackageExecutionError'
      this.failureDetails = failureDetails
    }
  },
}))

vi.mock('@/db', () => ({
  db: {
    insert: mocks.dbInsert,
    select: mocks.dbSelect,
    transaction: mocks.dbTransaction,
    update: mocks.dbUpdate,
  },
}))

vi.mock('@/worker/events', () => ({
  publishTaskEvent: mocks.publishTaskEvent,
}))

vi.mock('@/lib/mcps/manager', () => ({
  getProjectMcpOverview: mocks.getProjectMcpOverview,
}))

vi.mock('@/worker/review-gates', () => ({
  REVIEW_GATE_TYPES: ['qa_review', 'reviewer_review', 'security_review'],
  materializeReviewGatesForWorkPackageCompletion: mocks.materializeReviewGatesForWorkPackageCompletion,
  completeTaskIfReviewGatesSatisfied: mocks.completeTaskIfReviewGatesSatisfied,
  isImplementationPackageRole: (role: string) => ![
    '', 'architect', 'handoff', 'pm', 'qa', 'reviewer', 'security', 'security-review', 'security_review',
  ].includes(role.trim().toLowerCase()),
}))

vi.mock('@/worker/work-package-executor', () => ({
  executeWorkPackage: mocks.executeWorkPackage,
  loadWorkPackageExecutionContext: mocks.loadWorkPackageExecutionContext,
  MAX_WORK_PACKAGE_EXECUTION_ATTEMPTS: 3,
  WorkPackageExecutionError: mocks.WorkPackageExecutionError,
  isArchitectReservedExecutionRole: (role: string) =>
    ['architect', 'security', 'security-review', 'security_review'].includes(role.trim().toLowerCase()),
}))

function fixtureSecret(...parts: string[]) {
  return parts.join('')
}

import { handoffApprovedWorkPackages, progressWorkforce } from '@/worker/work-package-handoff'
import { prepareArchitectArtifact } from '@/worker/architect-artifact'
import { evaluateWorkPackageMcpBroker } from '@/worker/mcp-execution-design'
import { buildWorkforceMaterializationRows } from '@/worker/workforce-materializer'

const originalExecutionFlag = process.env.FORGE_WORK_PACKAGE_EXECUTION
const tempRoots: string[] = []
const execFile = promisify(execFileCallback)
let latestFreshAdmission: Record<string, unknown> | null = null

async function initDirtyGitRepo(dir: string) {
  await execFile('git', ['init', '-b', 'main'], { cwd: dir })
  await execFile('git', ['config', 'user.email', 'forge@example.com'], { cwd: dir })
  await execFile('git', ['config', 'user.name', 'Forge Test'], { cwd: dir })
  await writeFile(path.join(dir, 'README.md'), 'ready\n')
  await execFile('git', ['add', 'README.md'], { cwd: dir })
  await execFile('git', ['commit', '-m', 'initial'], { cwd: dir })
  await writeFile(path.join(dir, 'README.md'), 'ready\ndirty before handoff\n')
}

function chain(resolveValue: unknown) {
  const captureFreshAdmission = () => {
    if (!Array.isArray(resolveValue)) return
    const fresh = resolveValue.find((row) => (
      row && typeof row === 'object' &&
      'projectId' in row && 'mcpConfig' in row && 'assignedRole' in row && 'status' in row
    ))
    if (fresh) latestFreshAdmission = { ...(fresh as Record<string, unknown>) }
  }
  const thenable: Record<string, unknown> = {
    then: (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
      Promise.resolve().then(() => {
        captureFreshAdmission()
        return resolveValue
      }).then(onFulfilled, onRejected),
    catch: (onRejected: (e: unknown) => unknown) =>
      Promise.resolve(resolveValue).catch(onRejected),
  }
  const methods = ['from', 'where', 'limit', 'orderBy', 'values', 'returning', 'set', 'offset', 'innerJoin', 'leftJoin', 'for']
  methods.forEach((method) => {
    thenable[method] = () => thenable
  })
  return thenable
}

function chainWithLimit<T>(resolveValue: T[]) {
  const thenable = chain(resolveValue) as Record<string, unknown>
  thenable.limit = (count: number) => chain(resolveValue.slice(0, count))
  return thenable
}

function updateChain(returnValue: unknown) {
  const update = chain(returnValue)
  const returnedId = Array.isArray(returnValue) && returnValue[0] && typeof returnValue[0] === 'object'
    ? (returnValue[0] as { id?: unknown }).id
    : null
  update.set = vi.fn((values: Record<string, unknown>) => {
    const currentFreshAdmission = latestFreshAdmission
    if (currentFreshAdmission && currentFreshAdmission.id === returnedId) {
      latestFreshAdmission = {
        ...currentFreshAdmission,
        ...values,
        // SQL expressions patch the current JSONB value in PostgreSQL. Keep
        // the fixture's materialized metadata document for later lock reads.
        ...(values.metadata && typeof values.metadata === 'object' && 'queryChunks' in values.metadata
          ? { metadata: currentFreshAdmission.metadata }
          : {}),
      }
    }
    return update
  })
  return update
}

function freshLockSelectMock() {
  let call = 0
  return vi.fn(() => {
    call += 1
    if (!latestFreshAdmission) return chain([])
    if (call === 1) {
      return chain([{
        id: latestFreshAdmission.projectId,
        localPath: latestFreshAdmission.localPath ?? null,
        mcpConfig: latestFreshAdmission.mcpConfig ?? null,
      }])
    }
    if (call === 2) {
      return chain([{ id: 'task-1', projectId: latestFreshAdmission.projectId }])
    }
    return chain([{
      assignedRole: latestFreshAdmission.assignedRole,
      blockedReason: latestFreshAdmission.blockedReason ?? null,
      harnessId: latestFreshAdmission.harnessId ?? null,
      id: latestFreshAdmission.id,
      mcpRequirements: latestFreshAdmission.mcpRequirements,
      metadata: latestFreshAdmission.metadata,
      sequence: latestFreshAdmission.sequence,
      status: latestFreshAdmission.status,
      title: latestFreshAdmission.title,
      updatedAt: latestFreshAdmission.updatedAt ?? null,
    }])
  })
}

function jsonbMarkerFromUpdate(update: ReturnType<typeof updateChain>): Record<string, unknown> {
  const setMock = update.set as ReturnType<typeof vi.fn>
  const metadata = setMock.mock.calls[0]?.[0]?.metadata as { queryChunks?: unknown[] } | undefined
  const serialized = metadata?.queryChunks?.find((chunk): chunk is string => (
    typeof chunk === 'string' && chunk.startsWith('{')
  ))
  if (!serialized) throw new Error('Expected the handoff update to persist a JSONB marker.')
  return JSON.parse(serialized) as Record<string, unknown>
}

function insertChain(returnValue: unknown = []) {
  const insert = chain(returnValue)
  insert.values = vi.fn(() => insert)
  return insert
}

function freshAdmissionRow(
  pkg: Record<string, unknown>,
  project: Record<string, unknown> = { id: 'project-1' },
) {
  return {
    ...pkg,
    blockedReason: pkg.blockedReason ?? null,
    updatedAt: pkg.updatedAt ?? null,
    projectId: project.id,
    localPath: project.localPath ?? null,
    mcpConfig: project.mcpConfig ?? null,
  }
}

function defaultSourceArtifact(input: {
  content?: string
  id?: string
  metadata?: Record<string, unknown>
  runId?: string
} = {}) {
  return {
    id: input.id ?? 'artifact-1',
    agentRunId: input.runId ?? 'run-1',
    artifactType: 'log_output',
    content: input.content ?? 'handoff log',
    metadata: input.metadata ?? {
      hostRepositoryWrites: false,
      repositoryWrites: false,
      sandboxWrites: false,
      source: 'work-package-handoff',
      workPackageId: 'pkg-1',
    },
    createdAt: new Date('2026-06-25T00:00:00.000Z'),
  }
}

function mockNoOpHandoffTransaction(input: {
  packageId?: string
  runId?: string
} = {}) {
  const packageId = input.packageId ?? 'pkg-1'
  const runId = input.runId ?? 'run-1'
  const claimUpdate = updateChain([{ id: packageId }])
  const leaseUpdate = updateChain([{ id: packageId }])
  const runInsert = insertChain([{
    id: runId,
    agentType: 'handoff',
    modelIdUsed: 'forge-handoff/no-op',
    stage: 'handoff',
    status: 'running',
  }])
  mocks.dbTransaction.mockImplementationOnce(async (callback: (tx: unknown) => unknown) =>
    callback({
      insert: vi.fn().mockReturnValueOnce(runInsert),
      select: freshLockSelectMock(),
      update: vi.fn()
        .mockReturnValueOnce(claimUpdate)
        .mockReturnValueOnce(leaseUpdate),
    }),
  )
  return { claimUpdate, leaseUpdate, runInsert }
}

function mockFreshPromotionTransaction() {
  mocks.dbTransaction.mockImplementationOnce(async (callback: (tx: unknown) => unknown) =>
    callback({
      insert: vi.fn(),
      select: freshLockSelectMock(),
      update: mocks.dbUpdate,
    }),
  )
}

function healthyMcpOverview() {
  return {
    projectId: 'project-1',
    config: { profile: 'default' as const, requiredMcps: ['filesystem', 'github'], overrides: {} },
    catalog: [],
    mcpsRoot: '/tmp/forge/mcps',
    statuses: ['filesystem', 'github'].map((mcpId) => ({
      mcpId,
      displayName: mcpId === 'github' ? 'GitHub' : 'Filesystem',
      description: '',
      enabled: true,
      error: null,
      installPath: `/tmp/forge/mcps/${mcpId}`,
      installState: 'installed' as const,
      status: 'healthy' as const,
      checkedAt: '2026-07-14T00:00:00.000Z',
    })),
    summary: {
      label: 'MCPs healthy',
      status: 'healthy' as const,
      missing: 0,
      authRequired: 0,
      unhealthy: 0,
      disabled: 0,
    },
  }
}

function materializePackageFromPlan(input: {
  plan: string
  role?: string
}) {
  const overview = healthyMcpOverview()
  const prepared = prepareArchitectArtifact(input.plan, overview)
  let nextId = 0
  const role = input.role ?? 'backend'
  const rows = buildWorkforceMaterializationRows({
    taskId: 'task-1',
    architectRunId: 'run-architect',
    artifactId: 'artifact-plan',
    prepared,
  }, {
    activeAgents: [{ agentType: role, displayName: role }],
    idFactory: () => `00000000-0000-4000-8000-${String(++nextId).padStart(12, '0')}`,
  })
  const pkg = rows.workPackages.find((candidate) => candidate.assignedRole === role)
  if (!pkg) throw new Error(`Expected a materialized ${role} package.`)
  return { overview, pkg, prepared }
}

async function blockMaterializedPackageAtHandoff(
  pkg: Record<string, unknown>,
  overview: ReturnType<typeof healthyMcpOverview>,
) {
  if (typeof pkg.id !== 'string') throw new Error('Expected a materialized package id.')
  const packageId = pkg.id
  const project = { id: 'project-1', mcpConfig: overview.config }
  const handoffPackage = {
    ...pkg,
    blockedReason: pkg.blockedReason ?? null,
    harnessId: pkg.harnessId ?? null,
    sequence: pkg.sequence ?? 1,
    status: 'pending',
    updatedAt: pkg.updatedAt ?? null,
  }
  mocks.dbSelect
    .mockReturnValueOnce(chain([handoffPackage]))
    .mockReturnValueOnce(chain([]))
    .mockReturnValueOnce(chain([{ project }]))
    .mockReturnValueOnce(chain([freshAdmissionRow(handoffPackage, project)]))
  mocks.getProjectMcpOverview.mockResolvedValue(overview)
  const blockUpdate = updateChain([{ id: packageId }])
  mocks.dbUpdate.mockReturnValueOnce(blockUpdate)

  const result = await handoffApprovedWorkPackages('task-1', { claimEnabled: false })
  return { blockUpdate, result }
}

describe('handoffApprovedWorkPackages', () => {
  beforeEach(() => {
    process.env.FORGE_WORK_PACKAGE_EXECUTION = '0'
    vi.clearAllMocks()
    mocks.dbInsert.mockReset()
    mocks.dbSelect.mockReset()
    latestFreshAdmission = null
    mocks.dbTransaction.mockReset()
    mocks.dbTransaction.mockImplementation(async (callback: (tx: unknown) => unknown) =>
      callback({
        insert: vi.fn(),
        select: freshLockSelectMock(),
        update: mocks.dbUpdate,
      }),
    )
    mocks.dbUpdate.mockReset()
    mocks.executeWorkPackage.mockReset()
    mocks.loadWorkPackageExecutionContext.mockReset()
    mocks.getProjectMcpOverview.mockResolvedValue({
      projectId: 'project-1',
      config: { profile: 'default', requiredMcps: [], overrides: {} },
      catalog: [],
      mcpsRoot: '/tmp/forge/mcps',
      statuses: [],
      summary: {
        label: 'No MCPs configured',
        status: 'missing',
        missing: 0,
        authRequired: 0,
        unhealthy: 0,
        disabled: 0,
      },
    })
    mocks.materializeReviewGatesForWorkPackageCompletion.mockResolvedValue({
      status: 'materialized',
      packageStatus: 'awaiting_review',
      createdGates: [
        { id: 'gate-qa', gateType: 'qa_review', requiredRole: 'qa', title: 'QA review' },
        { id: 'gate-reviewer', gateType: 'reviewer_review', requiredRole: 'reviewer', title: 'Reviewer review' },
      ],
      sourceArtifact: defaultSourceArtifact(),
    })
  })

  afterEach(async () => {
    if (originalExecutionFlag === undefined) {
      delete process.env.FORGE_WORK_PACKAGE_EXECUTION
    } else {
      process.env.FORGE_WORK_PACKAGE_EXECUTION = originalExecutionFlag
    }
    await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  })

  it('marks root packages ready, claims the first package, and records a no-op handoff run', async () => {
    mocks.dbSelect
      .mockReturnValueOnce(chain([
        {
          id: 'pkg-1',
          assignedRole: 'backend',
          harnessId: 'harness-1',
          sequence: 1,
          status: 'pending',
          title: 'Backend package',
        },
        {
          id: 'pkg-2',
          assignedRole: 'qa',
          harnessId: 'harness-2',
          sequence: 2,
          status: 'pending',
          title: 'QA package',
        },
      ]))
      .mockReturnValueOnce(chain([
        { workPackageId: 'pkg-2', dependsOnWorkPackageId: 'pkg-1' },
      ]))
    const readyUpdate = updateChain([{ id: 'pkg-1' }])
    mocks.dbUpdate.mockReturnValueOnce(readyUpdate)
    const { claimUpdate, leaseUpdate, runInsert } = mockNoOpHandoffTransaction()

    const result = await handoffApprovedWorkPackages('task-1')

    expect(result).toEqual({
      status: 'handed_off',
      readyPackageIds: ['pkg-1'],
      claimedPackageId: 'pkg-1',
    })
    expect(readyUpdate.set).toHaveBeenCalledWith(expect.objectContaining({ status: 'ready' }))
    expect(claimUpdate.set).toHaveBeenCalledWith(expect.objectContaining({
      blockedReason: null,
      status: 'running',
    }))
    expect(runInsert.values).toHaveBeenCalledWith(expect.objectContaining({
      agentType: 'handoff',
      harnessId: 'harness-1',
      modelIdUsed: 'forge-handoff/no-op',
      stage: 'handoff',
      status: 'running',
      taskId: 'task-1',
      workPackageId: 'pkg-1',
    }))
    expect(leaseUpdate.set).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({
        executionLease: expect.objectContaining({
          attemptNumber: 1,
          runId: 'run-1',
          source: 'work-package-handoff',
        }),
      }),
    }))
    expect(mocks.publishTaskEvent).toHaveBeenCalledWith('task-1', 'artifact:created', expect.objectContaining({
      agentRunId: 'run-1',
      artifactId: 'artifact-1',
      content: 'handoff log',
      metadata: expect.objectContaining({ repositoryWrites: false }),
      workPackageId: 'pkg-1',
    }))
    expect(mocks.materializeReviewGatesForWorkPackageCompletion).toHaveBeenCalledWith(expect.objectContaining({
      completeSourceRun: expect.objectContaining({
        artifactType: 'log_output',
        content: expect.stringContaining('Forge handed off work package "Backend package" to backend.'),
        metadata: expect.objectContaining({
          hostRepositoryWrites: false,
          repositoryWrites: false,
          sandboxWrites: false,
          source: 'work-package-handoff',
          workPackageId: 'pkg-1',
        }),
      }),
      requireExecutionLease: true,
      sourceAgentRunId: 'run-1',
      sourceArtifactId: null,
      taskId: 'task-1',
      workPackageId: 'pkg-1',
    }))
    expect(mocks.publishTaskEvent).toHaveBeenCalledWith('task-1', 'work_package:handoff', expect.objectContaining({
      repositoryWrites: false,
      runId: 'run-1',
      stage: 'handoff',
      status: 'awaiting_review',
      workPackageId: 'pkg-1',
    }))
  })

  it('auto-advances to the next ready package when no review is required for the completed one', async () => {
    mocks.materializeReviewGatesForWorkPackageCompletion.mockResolvedValue({
      status: 'not_required',
      packageStatus: 'completed',
      createdGates: [],
      sourceArtifact: defaultSourceArtifact(),
    })
    mocks.completeTaskIfReviewGatesSatisfied.mockResolvedValue({ status: 'completed' })

    const firstPackages = [
      { id: 'pkg-1', assignedRole: 'qa', harnessId: 'harness-1', sequence: 1, status: 'pending', title: 'QA package' },
    ]
    const secondPackages = [
      { id: 'pkg-1', assignedRole: 'qa', harnessId: 'harness-1', sequence: 1, status: 'completed', title: 'QA package' },
    ]

    mocks.dbSelect
      .mockReturnValueOnce(chain(firstPackages))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain(secondPackages))
      .mockReturnValueOnce(chain([]))

    const readyUpdate = updateChain([{ id: 'pkg-1' }])
    mocks.dbUpdate.mockReturnValueOnce(readyUpdate)
    mockNoOpHandoffTransaction()

    const result = await handoffApprovedWorkPackages('task-1')

    expect(result).toEqual({
      status: 'handed_off',
      readyPackageIds: ['pkg-1'],
      claimedPackageId: 'pkg-1',
    })
    expect(mocks.completeTaskIfReviewGatesSatisfied).toHaveBeenCalledWith('task-1')
  })

  it('blocks a required unavailable MCP before claiming the package', async () => {
    const pkg = {
      id: 'pkg-1', assignedRole: 'backend', harnessId: 'harness-1',
      mcpRequirements: [{
        mcpId: 'github', requirement: 'required', permissions: ['github.issues.read'],
        fallback: { action: 'block', message: 'Connect GitHub first.' },
      }],
      metadata: {}, sequence: 1, status: 'pending', title: 'Backend package',
    }
    mocks.dbSelect
      .mockReturnValueOnce(chain([
        {
          ...pkg,
          harnessToolPolicy: {
            mcpGrants: [{
              mcpId: 'github',
              requirement: 'required',
              status: 'blocked',
              capabilities: ['github.issues.read'],
              fallback: { action: 'block', message: 'Connect GitHub first.' },
            }],
          },
        },
      ]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([{ project: { id: 'project-1' } }]))
      .mockReturnValueOnce(chain([freshAdmissionRow(pkg)]))
    mocks.getProjectMcpOverview.mockResolvedValue({
      projectId: 'project-1',
      config: { profile: 'default', requiredMcps: [], overrides: {} },
      catalog: [],
      mcpsRoot: '/tmp/forge/mcps',
      statuses: [],
      summary: {
        label: 'No MCPs configured',
        status: 'missing',
        missing: 1,
        authRequired: 0,
        unhealthy: 0,
        disabled: 0,
      },
    })

    const blockUpdate = updateChain([{ id: 'pkg-1' }])
    mocks.dbUpdate.mockReturnValueOnce(blockUpdate)

    const result = await handoffApprovedWorkPackages('task-1')

    expect(result).toMatchObject({
      status: 'blocked',
      claimedPackageId: null,
      blockedReason: expect.stringContaining('planning context was not materialized'),
    })

    expect(blockUpdate.set).toHaveBeenCalledWith(expect.objectContaining({
      blockedReason: expect.stringContaining('planning context was not materialized'),
      metadata: expect.anything(),
      status: 'blocked',
    }))
    expect(mocks.dbTransaction).toHaveBeenCalledTimes(1)
    expect(mocks.publishTaskEvent).toHaveBeenCalledWith('task-1', 'work_package:status', expect.objectContaining({
      blockedReason: expect.stringContaining('planning context was not materialized'),
      status: 'blocked',
      workPackageId: 'pkg-1',
    }))
  })

  it.each([
    ['architect', 'harness-architect', 'Architect package'],
    ['security', 'harness-security', 'Security package'],
  ])('fails stale Architect-created reserved %s packages before no-op handoff', async (assignedRole, harnessId, title) => {
    const pkg = {
      id: 'pkg-review', assignedRole, harnessId, mcpRequirements: [],
      metadata: { source: 'architect-artifact' }, sequence: 1, status: 'pending', title,
    }
    mocks.dbSelect
      .mockReturnValueOnce(chain([pkg]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([{ project: { id: 'project-1' } }]))
      .mockReturnValueOnce(chain([freshAdmissionRow(pkg)]))

    const failedUpdate = updateChain([{ id: 'pkg-review' }])
    mocks.dbUpdate.mockReturnValueOnce(failedUpdate)

    const result = await handoffApprovedWorkPackages('task-1')

    expect(result).toMatchObject({
      blockedReason: expect.stringContaining('reserved for review gates'),
      claimedPackageId: null,
      readyPackageIds: [],
      status: 'blocked',
    })
    expect(failedUpdate.set).toHaveBeenCalledWith(expect.objectContaining({
      blockedReason: expect.stringContaining('reserved for review gates'),
      metadata: expect.anything(),
      status: 'failed',
    }))
    expect(mocks.dbTransaction).toHaveBeenCalledTimes(1)
    expect(mocks.publishTaskEvent).toHaveBeenCalledWith('task-1', 'work_package:status', expect.objectContaining({
      blockedReason: expect.stringContaining('reserved for review gates'),
      handoffSafety: expect.objectContaining({
        source: 'architect-reserved-role',
        status: 'failed',
      }),
      status: 'failed',
      workPackageId: 'pkg-review',
    }))
  })

  it('fails the task when auto-progress reaches a terminal reserved-role handoff block', async () => {
    const pkg = {
      id: 'pkg-review', assignedRole: 'security', harnessId: 'harness-security',
      mcpRequirements: [], metadata: { source: 'architect-artifact' }, sequence: 1,
      status: 'pending', title: 'Security package',
    }
    mocks.dbSelect
      .mockReturnValueOnce(chain([pkg]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([{ project: { id: 'project-1' } }]))
      .mockReturnValueOnce(chain([freshAdmissionRow(pkg)]))

    const failedPackageUpdate = updateChain([{ id: 'pkg-review' }])
    const failedTaskUpdate = updateChain([{ id: 'task-1' }])
    mocks.dbUpdate
      .mockReturnValueOnce(failedPackageUpdate)
      .mockReturnValueOnce(failedTaskUpdate)

    const result = await progressWorkforce('task-1')

    expect(result).toMatchObject({
      blockedReason: expect.stringContaining('reserved for review gates'),
      claimedPackageId: null,
      status: 'blocked',
      terminalBlock: true,
    })
    expect(failedPackageUpdate.set).toHaveBeenCalledWith(expect.objectContaining({
      status: 'failed',
    }))
    expect(failedTaskUpdate.set).toHaveBeenCalledWith(expect.objectContaining({
      errorMessage: expect.stringContaining('reserved for review gates'),
      status: 'failed',
    }))
    expect(mocks.publishTaskEvent).toHaveBeenCalledWith('task-1', 'task:status', expect.objectContaining({
      errorMessage: expect.stringContaining('reserved for review gates'),
      status: 'failed',
    }))
  })

  it('holds a required filesystem package for grant approval before claiming or running it', async () => {
    const pkg = {
      id: 'pkg-fs', assignedRole: 'backend', harnessId: 'harness-1',
      mcpRequirements: [{
        mcpId: 'filesystem', requirement: 'required',
        capabilities: ['filesystem.project.read', 'filesystem.project.search'],
      }],
      metadata: {}, sequence: 1, status: 'pending', title: 'Read project files',
    }
    mocks.dbSelect
      .mockReturnValueOnce(chain([pkg]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([{ project: { id: 'project-1' } }]))
      .mockReturnValueOnce(chain([freshAdmissionRow(pkg)]))

    const failedPackageUpdate = updateChain([{ id: 'pkg-fs' }])
    const failedTaskUpdate = updateChain([{ id: 'task-1' }])
    mocks.dbUpdate
      .mockReturnValueOnce(failedPackageUpdate)
      .mockReturnValueOnce(failedTaskUpdate)

    const result = await progressWorkforce('task-1')

    expect(result).toMatchObject({
      blockedReason: expect.stringContaining('requires filesystem grant approval'),
      claimedPackageId: null,
      status: 'blocked',
      terminalBlock: true,
    })
    // Failed at the gate: the package carries the grant-block marker and no
    // implementation run/transaction was ever started, so no attempt is spent.
    expect(failedPackageUpdate.set).toHaveBeenCalledWith(expect.objectContaining({
      status: 'failed',
      metadata: expect.anything(),
    }))
    expect(failedTaskUpdate.set).toHaveBeenCalledWith(expect.objectContaining({
      errorMessage: expect.stringContaining('requires filesystem grant approval'),
      status: 'failed',
    }))
    expect(mocks.dbTransaction).toHaveBeenCalledTimes(1)
  })

  it('holds a stale project-level filesystem grant when the project grant was revoked', async () => {
    const project = {
      id: 'project-1',
      mcpConfig: { profile: 'default', requiredMcps: [], overrides: {} },
    }
    const pkg = {
      id: 'pkg-fs-project', assignedRole: 'backend', harnessId: 'harness-1',
      mcpRequirements: [{
        mcpId: 'filesystem', requirement: 'required', capabilities: ['filesystem.project.read'],
      }],
      metadata: {
        mcpGrantPhases: { effective: {
          schemaVersion: 1, phase: 'effective', source: 'project-filesystem-approval',
          runtimeEnforcement: 'bounded_context_packet', status: 'approved',
          grants: [{
            mcpId: 'filesystem', status: 'approved', capabilities: ['filesystem.project.read'],
          }],
        } },
      },
      sequence: 1, status: 'pending', title: 'Read project files',
    }
    mocks.dbSelect
      .mockReturnValueOnce(chain([pkg]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([{ project }]))
      .mockReturnValueOnce(chain([freshAdmissionRow(pkg, project)]))

    const failedPackageUpdate = updateChain([{ id: 'pkg-fs-project' }])
    const failedTaskUpdate = updateChain([{ id: 'task-1' }])
    mocks.dbUpdate
      .mockReturnValueOnce(failedPackageUpdate)
      .mockReturnValueOnce(failedTaskUpdate)

    const result = await progressWorkforce('task-1')

    expect(result).toMatchObject({
      blockedReason: expect.stringContaining('project-level filesystem grant'),
      claimedPackageId: null,
      status: 'blocked',
      terminalBlock: true,
    })
    expect(failedPackageUpdate.set).toHaveBeenCalledWith(expect.objectContaining({
      status: 'failed',
      metadata: expect.anything(),
    }))
    expect(mocks.dbTransaction).toHaveBeenCalledTimes(1)
  })

  it('uses a current approved project filesystem grant even when the package has no persisted project-effective phase', async () => {
    const projectGrant = {
      schemaVersion: 1,
      mcpId: 'filesystem',
      status: 'approved',
      grantMode: 'always_allow',
      capabilities: ['filesystem.project.read'],
      grantApprovalId: 'grant-project-1',
      approvedAt: '2026-07-14T00:00:00.000Z',
      approvedBy: 'user-1',
      reason: 'Approved project context.',
    }
    const project = {
      id: 'project-1',
      mcpConfig: {
        profile: 'default',
        requiredMcps: ['filesystem'],
        overrides: {},
        grants: { filesystem: projectGrant },
      },
    }
    const pkg = {
      id: 'pkg-fs-project',
      assignedRole: 'backend',
      harnessId: 'harness-1',
      mcpRequirements: [{
        requirementKey: 'mcp-requirement-v1-fs-1', sourceRequirementIndex: 0,
        agent: 'backend', mcpId: 'filesystem', requirement: 'required',
        permissions: ['filesystem.project.read'], prohibitedCapabilities: [],
        assignment: { type: 'agent', targetId: null },
        fallback: { action: 'block', message: '' },
      }],
      metadata: {},
      sequence: 1,
      status: 'pending',
      title: 'Read project files',
    }
    mocks.dbSelect
      .mockReturnValueOnce(chain([pkg]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([{ project }]))
      .mockReturnValueOnce(chain([freshAdmissionRow(pkg, project)]))
    mocks.getProjectMcpOverview.mockResolvedValue({
      projectId: project.id,
      config: project.mcpConfig,
      catalog: [],
      mcpsRoot: '/tmp/forge/mcps',
      statuses: [{
        mcpId: 'filesystem',
        displayName: 'Filesystem',
        description: 'Filesystem MCP',
        enabled: true,
        error: null,
        installPath: '/tmp/forge/mcps/filesystem',
        installState: 'installed',
        status: 'healthy',
        checkedAt: '2026-07-14T00:00:01.000Z',
      }],
      summary: {
        label: 'MCPs healthy',
        status: 'healthy',
        missing: 0,
        authRequired: 0,
        unhealthy: 0,
        disabled: 0,
      },
    })
    const readyUpdate = updateChain([{ id: 'pkg-fs-project' }])
    mocks.dbUpdate.mockReturnValueOnce(readyUpdate)

    await expect(handoffApprovedWorkPackages('task-1', { claimEnabled: false })).resolves.toEqual({
      claimedPackageId: null,
      status: 'ready_only',
      readyPackageIds: ['pkg-fs-project'],
    })
    expect(readyUpdate.set).toHaveBeenCalledWith(expect.objectContaining({
      blockedReason: null,
      status: 'ready',
    }))
  })

  it('runs the broker before ready promotion when handoff claiming is disabled', async () => {
    const pkg = {
      id: 'pkg-1', assignedRole: 'backend', harnessId: 'harness-1',
      mcpRequirements: [{
        mcpId: 'slack', agent: 'backend', requirement: 'optional',
        permissions: ['slack.messages.read'],
        fallback: { action: 'continue_without_mcp', message: 'Use local context.' },
      }],
      metadata: {}, sequence: 1, status: 'pending', title: 'Backend package',
    }
    mocks.dbSelect
      .mockReturnValueOnce(chain([pkg]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([{ project: { id: 'project-1' } }]))
      .mockReturnValueOnce(chain([freshAdmissionRow(pkg)]))

    const blockUpdate = updateChain([{ id: 'pkg-1' }])
    mocks.dbUpdate.mockReturnValueOnce(blockUpdate)

    const result = await handoffApprovedWorkPackages('task-1', { claimEnabled: false })

    expect(result).toMatchObject({
      blockedReason: expect.stringContaining('mcpId must identify a known MCP'),
      claimedPackageId: null,
      readyPackageIds: [],
      status: 'blocked',
    })
    expect(blockUpdate.set).toHaveBeenCalledWith(expect.objectContaining({
      blockedReason: expect.stringContaining('mcpId must identify a known MCP'),
      metadata: expect.anything(),
      status: 'blocked',
    }))
    expect(mocks.publishTaskEvent).not.toHaveBeenCalledWith('task-1', 'work_package:status', expect.objectContaining({
      status: 'ready',
      workPackageId: 'pkg-1',
    }))
  })

  it('blocks malformed legacy MCP containers at actual handoff instead of treating them as no runtime input', async () => {
    const project = {
      id: 'project-1',
      mcpConfig: { profile: 'default', requiredMcps: [], overrides: {} },
    }
    const pkg = {
      id: 'pkg-malformed-legacy',
      assignedRole: 'backend',
      harnessId: 'harness-1',
      mcpRequirements: { mcpId: 'github', permissions: ['github.issues.read'] },
      metadata: { mcpGrants: { decisionId: 'not-an-array' } },
      sequence: 1,
      status: 'pending',
      title: 'Malformed legacy MCP package',
    }
    mocks.dbSelect
      .mockReturnValueOnce(chain([pkg]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([{ project }]))
      .mockReturnValueOnce(chain([freshAdmissionRow(pkg, project)]))

    const blockUpdate = updateChain([{ id: pkg.id }])
    mocks.dbUpdate.mockReturnValueOnce(blockUpdate)

    const result = await handoffApprovedWorkPackages('task-1', { claimEnabled: false })

    expect(result).toMatchObject({
      blockedReason: expect.stringContaining('Legacy MCP policies must be stored as an array'),
      claimedPackageId: null,
      readyPackageIds: [],
      status: 'blocked',
    })
    expect(blockUpdate.set).toHaveBeenCalledWith(expect.objectContaining({
      blockedReason: expect.stringContaining('Legacy MCP policies must be stored as an array'),
      status: 'blocked',
    }))
    expect(mocks.executeWorkPackage).not.toHaveBeenCalled()
    expect(mocks.publishTaskEvent).not.toHaveBeenCalledWith('task-1', 'work_package:status', expect.objectContaining({
      status: 'ready',
      workPackageId: pkg.id,
    }))
  })

  it.each([
    ['deferred', 'github.contents.write', []],
    ['prohibited', 'github.issues.read', ['github.issues.read']],
    ['malformed', 'github..read', []],
    ['cross-MCP', 'filesystem.project.read', []],
  ] as const)('blocks materialized subtask overflow containing a trailing %s capability at actual handoff', async (
    _label,
    boundaryCapability,
    prohibitedCapabilities,
  ) => {
    const { overview, pkg, prepared } = materializePackageFromPlan({
      plan: [
        '# Plan',
        '- [Backend] Implement the package safely.',
        '```mcp_execution_design_json',
        JSON.stringify({
          schemaVersion: 1,
          requirements: [{
            mcpId: 'github',
            requirement: 'required',
            reason: 'Read issue context.',
            assignment: { type: 'agent', targetAgents: ['backend'], targetId: null },
            agentPermissions: { backend: ['github.issues.read'] },
            prohibitedCapabilities,
            fallback: { action: 'block', message: 'Revise the plan.' },
          }],
          promptOverlays: {},
          requirementContexts: [],
          mcpAwareSubtasks: [{
            id: 'inspect',
            agent: 'backend',
            dependsOn: [],
            mcpCapabilities: [...Array(30).fill('github.issues.read'), boundaryCapability],
            inputs: [],
            outputs: [],
            verification: [],
            stoppingCondition: 'Done.',
            fallback: 'Revise the plan.',
          }],
        }),
        '```',
      ].join('\n'),
    })

    expect(prepared.mcpExecutionDesign.grantDecisions).toMatchObject({
      admissionStatus: 'blocked',
      primaryMode: 'blocked',
      primaryRecoveryAction: 'revise_plan',
    })
    expect(prepared.mcpExecutionDesign.proposed).toMatchObject({
      mcpAwareSubtasks: [],
      normalizationErrors: expect.arrayContaining([
        expect.stringMatching(/mcpCapabilities exceeds the maximum raw count of 30/),
      ]),
    })
    expect(pkg.metadata).toMatchObject({
      mcpAwareSubtasks: [],
      mcpNormalizationErrors: expect.arrayContaining([
        expect.stringMatching(/mcpCapabilities exceeds the maximum raw count of 30/),
      ]),
    })
    const broker = evaluateWorkPackageMcpBroker({
      assignedRole: pkg.assignedRole,
      mcpOverview: overview,
      mcpRequirements: pkg.mcpRequirements,
      metadata: pkg.metadata,
      projectMcpConfig: overview.config,
      title: pkg.title,
    })
    expect(broker).toMatchObject({
      status: 'blocked',
      primaryMode: 'blocked',
      primaryRecoveryAction: 'revise_plan',
      retryable: false,
    })

    const { blockUpdate, result } = await blockMaterializedPackageAtHandoff(pkg, overview)
    expect(result).toMatchObject({
      status: 'blocked',
      claimedPackageId: null,
      blockedReason: expect.stringContaining('mcpCapabilities exceeds the maximum raw count of 30'),
    })
    expect(blockUpdate.set).toHaveBeenCalledWith(expect.objectContaining({ status: 'blocked' }))
    expect(jsonbMarkerFromUpdate(blockUpdate)).toMatchObject({
      primaryMode: broker.primaryMode,
      primaryRecoveryAction: broker.primaryRecoveryAction,
    })
    expect(mocks.dbTransaction).toHaveBeenCalledTimes(1)
  })

  it('blocks a real materialized separator-alias deny policy at handoff with preview parity', async () => {
    const { overview, pkg, prepared } = materializePackageFromPlan({
      role: 'backend-dev',
      plan: [
        '# Plan',
        '- [backend-dev] Implement the canonical package.',
        '```mcp_execution_design_json',
        JSON.stringify({
          schemaVersion: 1,
          requirements: [{
            mcpId: 'github',
            requirement: 'required',
            reason: 'Read issues.',
            assignment: { type: 'agent', targetAgents: ['backend_dev'], targetId: null },
            agentPermissions: { backend_dev: ['github.issues.read'] },
            prohibitedCapabilities: [],
            fallback: { action: 'block', message: 'Revise the plan.' },
          }, {
            mcpId: 'github',
            requirement: 'required',
            reason: 'Deny issue reads.',
            assignment: { type: 'agent', targetAgents: ['backend-dev'], targetId: null },
            agentPermissions: {},
            prohibitedCapabilities: ['github.issues.read'],
            fallback: { action: 'block', message: 'Revise the plan.' },
          }],
          promptOverlays: {},
          requirementContexts: [],
          mcpAwareSubtasks: [],
        }),
        '```',
      ].join('\n'),
    })
    const preview = prepared.mcpExecutionDesign.grantDecisions
    expect(preview).toMatchObject({
      admissionStatus: 'blocked',
      primaryMode: 'blocked',
      primaryRecoveryAction: 'revise_plan',
    })
    expect(pkg.mcpRequirements).toEqual([
      expect.objectContaining({ agent: 'backend-dev', permissions: ['github.issues.read'] }),
      expect.objectContaining({ agent: 'backend-dev', prohibitedCapabilities: ['github.issues.read'] }),
    ])
    const broker = evaluateWorkPackageMcpBroker({
      assignedRole: pkg.assignedRole,
      mcpOverview: overview,
      mcpRequirements: pkg.mcpRequirements,
      metadata: pkg.metadata,
      projectMcpConfig: overview.config,
      title: pkg.title,
    })
    expect(broker).toMatchObject({
      status: 'blocked',
      primaryMode: preview.primaryMode,
      primaryRecoveryAction: preview.primaryRecoveryAction,
    })

    const { blockUpdate, result } = await blockMaterializedPackageAtHandoff(pkg, overview)
    expect(result).toMatchObject({
      status: 'blocked',
      claimedPackageId: null,
      blockedReason: expect.stringContaining('prohibited'),
    })
    expect(blockUpdate.set).toHaveBeenCalledWith(expect.objectContaining({ status: 'blocked' }))
    expect(jsonbMarkerFromUpdate(blockUpdate)).toMatchObject({
      primaryMode: preview.primaryMode,
      primaryRecoveryAction: preview.primaryRecoveryAction,
    })
    expect(mocks.dbTransaction).toHaveBeenCalledTimes(1)
  })

  it('keeps an invalid exact fence durable through materialization and actual handoff', async () => {
    const { overview, pkg, prepared } = materializePackageFromPlan({
      plan: [
        '# Plan',
        '- [Backend] Implement the package safely.',
        '```mcp_execution_design_json',
        '{"schemaVersion":1,not-json}',
        '```',
      ].join('\n'),
    })
    expect(prepared.planText).not.toContain('mcp_execution_design_json')
    expect(prepared.mcpExecutionDesign.proposed).toMatchObject({
      requirements: [],
      normalizationEvidence: [{
        schemaVersion: 1,
        category: 'parse',
        code: 'mcp_design_json_parse_failed',
      }],
    })
    expect(prepared.mcpExecutionDesign.grantDecisions).toMatchObject({
      admissionStatus: 'blocked',
      primaryMode: 'blocked',
      primaryRecoveryAction: 'revise_plan',
    })
    expect(pkg.metadata).toMatchObject({
      mcpNormalizationErrors: [expect.stringMatching(/invalid JSON/)],
      mcpNormalizationEvidence: [{
        schemaVersion: 1,
        category: 'parse',
        code: 'mcp_design_json_parse_failed',
      }],
    })
    const broker = evaluateWorkPackageMcpBroker({
      assignedRole: pkg.assignedRole,
      mcpOverview: overview,
      mcpRequirements: pkg.mcpRequirements,
      metadata: pkg.metadata,
      projectMcpConfig: overview.config,
      title: pkg.title,
    })
    expect(broker).toMatchObject({
      status: 'blocked',
      primaryMode: 'blocked',
      primaryRecoveryAction: 'revise_plan',
      retryable: false,
    })

    const { blockUpdate, result } = await blockMaterializedPackageAtHandoff(pkg, overview)
    expect(result).toMatchObject({
      status: 'blocked',
      claimedPackageId: null,
      blockedReason: expect.stringContaining('invalid JSON'),
    })
    expect(blockUpdate.set).toHaveBeenCalledWith(expect.objectContaining({ status: 'blocked' }))
    expect(jsonbMarkerFromUpdate(blockUpdate)).toMatchObject({
      primaryMode: broker.primaryMode,
      primaryRecoveryAction: broker.primaryRecoveryAction,
    })
    expect(mocks.dbTransaction).toHaveBeenCalledTimes(1)
  })

  it('promotes prompt-only MCP filesystem packages when handoff claiming is disabled', async () => {
    const pkg = {
      id: 'pkg-1', assignedRole: 'frontend', harnessId: 'harness-1', harnessToolPolicy: null,
      mcpRequirements: [{
        requirementKey: 'filesystem-write-v1', sourceRequirementIndex: 0, mcpId: 'filesystem',
        agent: 'frontend', requirement: 'required', permissions: ['filesystem.project.write'],
        assignment: { type: 'agent', targetId: null }, fallback: { action: 'block', message: '' },
      }],
      metadata: {
        promptOverlay: 'Use the project context if available, otherwise continue with the greenfield scaffold.',
        mcpAwareSubtasks: [{
          id: 'inspect-repository', agent: 'frontend', mcpCapabilities: ['filesystem.project.write'],
          capabilityBindings: [{ capability: 'filesystem.project.write', requirementKey: 'filesystem-write-v1' }],
        }],
      },
      sequence: 1, status: 'pending', title: 'Frontend work package',
    }
    mocks.dbSelect
      .mockReturnValueOnce(chain([pkg]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([{ project: { id: 'project-1' } }]))
      .mockReturnValueOnce(chain([freshAdmissionRow(pkg)]))

    mocks.getProjectMcpOverview.mockResolvedValue({
      projectId: 'project-1',
      config: { profile: 'default', requiredMcps: ['filesystem'], overrides: {} },
      catalog: [],
      mcpsRoot: '/tmp/forge/mcps',
      statuses: [{
        mcpId: 'filesystem',
        displayName: 'Filesystem',
        description: 'Filesystem MCP',
        enabled: true,
        error: null,
        installPath: '/tmp/forge/mcps/filesystem',
        installState: 'installed',
        status: 'healthy',
      }],
      summary: {
        label: 'MCPs healthy',
        status: 'healthy',
        missing: 0,
        authRequired: 0,
        unhealthy: 0,
        disabled: 0,
      },
    })

    const readyUpdate = updateChain([{ id: 'pkg-1' }])
    mocks.dbUpdate.mockReturnValueOnce(readyUpdate)

    const result = await handoffApprovedWorkPackages('task-1', { claimEnabled: false })

    expect(result).toEqual({
      status: 'ready_only',
      readyPackageIds: ['pkg-1'],
      claimedPackageId: null,
    })
    expect(readyUpdate.set).toHaveBeenCalledWith(expect.objectContaining({
      blockedReason: null,
      status: 'ready',
    }))
    expect(mocks.publishTaskEvent).toHaveBeenCalledWith('task-1', 'work_package:status', expect.objectContaining({
      status: 'ready',
      workPackageId: 'pkg-1',
    }))
  })

  it('claims the next sequential package instead of letting a later ready package block the wave', async () => {
    mocks.dbSelect
      .mockReturnValueOnce(chain([
        {
          id: 'pkg-1',
          assignedRole: 'backend',
          harnessId: 'harness-1',
          mcpRequirements: [],
          metadata: {},
          sequence: 1,
          status: 'pending',
          title: 'Backend package',
        },
        {
          id: 'pkg-2',
          assignedRole: 'frontend',
          harnessId: 'harness-2',
          mcpRequirements: [{
            mcpId: 'slack',
            requirement: 'optional',
            permissions: ['slack.messages.read'],
            fallback: { action: 'continue_without_mcp', message: 'Use local context.' },
          }],
          metadata: {},
          sequence: 2,
          status: 'pending',
          title: 'Frontend package',
        },
      ]))
      .mockReturnValueOnce(chain([]))

    const readyUpdate = updateChain([{ id: 'pkg-1' }])
    mocks.dbUpdate.mockReturnValueOnce(readyUpdate)
    const { claimUpdate } = mockNoOpHandoffTransaction()

    const result = await handoffApprovedWorkPackages('task-1')

    expect(result).toMatchObject({
      claimedPackageId: 'pkg-1',
      readyPackageIds: ['pkg-1'],
      status: 'handed_off',
    })
    expect(readyUpdate.set).toHaveBeenCalledWith(expect.objectContaining({
      blockedReason: null,
      status: 'ready',
    }))
    expect(claimUpdate.set).toHaveBeenCalledWith(expect.objectContaining({
      blockedReason: null,
      status: 'running',
    }))
    expect(mocks.getProjectMcpOverview).not.toHaveBeenCalled()
  })

  it('rechecks the broker for packages that were already ready before handoff', async () => {
    const pkg = {
      id: 'pkg-1', assignedRole: 'backend', harnessId: 'harness-1',
      mcpRequirements: [{
        mcpId: 'github', requirement: 'required', permissions: ['github.contents.write'],
        fallback: { action: 'block', message: 'Use read-only GitHub access.' },
      }],
      metadata: {}, sequence: 1, status: 'ready', title: 'Backend package',
    }
    mocks.dbSelect
      .mockReturnValueOnce(chain([pkg]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([{ project: { id: 'project-1' } }]))
      .mockReturnValueOnce(chain([freshAdmissionRow(pkg)]))
    mocks.getProjectMcpOverview.mockResolvedValue({
      projectId: 'project-1',
      config: { profile: 'default', requiredMcps: ['github'], overrides: {} },
      catalog: [],
      mcpsRoot: '/tmp/forge/mcps',
      statuses: [{
        mcpId: 'github',
        displayName: 'GitHub',
        description: 'GitHub MCP',
        enabled: true,
        error: null,
        installPath: '/tmp/forge/mcps/github',
        installState: 'installed',
        status: 'healthy',
      }],
      summary: {
        label: 'MCPs healthy',
        status: 'healthy',
        missing: 0,
        authRequired: 0,
        unhealthy: 0,
        disabled: 0,
      },
    })

    const blockUpdate = updateChain([{ id: 'pkg-1' }])
    mocks.dbUpdate.mockReturnValueOnce(blockUpdate)

    const result = await handoffApprovedWorkPackages('task-1')

    expect(result).toMatchObject({
      blockedReason: expect.stringContaining('deferred live MCP capabilities'),
      claimedPackageId: null,
      readyPackageIds: [],
      status: 'blocked',
    })
    expect(blockUpdate.set).toHaveBeenCalledWith(expect.objectContaining({
      blockedReason: expect.stringContaining('deferred live MCP capabilities'),
      metadata: expect.anything(),
      status: 'blocked',
    }))
    expect(mocks.dbTransaction).toHaveBeenCalledTimes(1)
  })

  it('continues handoff for an optional unavailable MCP with continue_without_mcp fallback', async () => {
    mocks.dbSelect
      .mockReturnValueOnce(chain([
        {
          id: 'pkg-1',
          assignedRole: 'backend',
          harnessId: 'harness-1',
          harnessToolPolicy: null,
          mcpRequirements: [{
            mcpId: 'github',
            requirement: 'optional',
            permissions: ['github.issues.read'],
            fallback: { action: 'continue_without_mcp', message: 'Use local context.' },
          }],
          metadata: {},
          sequence: 1,
          status: 'pending',
          title: 'Backend package',
        },
      ]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([{ project: { id: 'project-1' } }]))
      .mockReturnValueOnce(chain([{
        id: 'pkg-1', assignedRole: 'backend', blockedReason: null, harnessId: 'harness-1',
        mcpRequirements: [{
          mcpId: 'github', requirement: 'optional', permissions: ['github.issues.read'],
          fallback: { action: 'continue_without_mcp', message: 'Use local context.' },
        }],
        metadata: {}, sequence: 1, status: 'pending', title: 'Backend package', updatedAt: null,
        projectId: 'project-1', localPath: null, mcpConfig: null,
      }]))

    const readyUpdate = updateChain([{ id: 'pkg-1' }])
    mocks.dbUpdate.mockReturnValueOnce(readyUpdate)
    mockFreshPromotionTransaction()
    const { claimUpdate } = mockNoOpHandoffTransaction()

    const result = await handoffApprovedWorkPackages('task-1')

    expect(result).toMatchObject({
      status: 'handed_off',
      claimedPackageId: 'pkg-1',
    })
    expect(claimUpdate.set).toHaveBeenCalledWith(expect.objectContaining({
      blockedReason: null,
      status: 'running',
    }))
    expect(mocks.publishTaskEvent).not.toHaveBeenCalledWith('task-1', 'work_package:status', expect.objectContaining({
      status: 'blocked',
      workPackageId: 'pkg-1',
    }))
  })

  it('blocks an optional unavailable MCP with ask_user fallback before claiming the package', async () => {
    const pkg = {
      id: 'pkg-1', assignedRole: 'backend', harnessId: 'harness-1', harnessToolPolicy: null,
      mcpRequirements: [{
        mcpId: 'github', requirement: 'optional', permissions: ['github.issues.read'],
        fallback: { action: 'ask_user', message: 'Connect GitHub or choose a local-only plan.' },
      }],
      metadata: {}, sequence: 1, status: 'pending', title: 'Backend package',
    }
    mocks.dbSelect
      .mockReturnValueOnce(chain([pkg]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([{ project: { id: 'project-1' } }]))
      .mockReturnValueOnce(chain([freshAdmissionRow(pkg)]))

    const blockUpdate = updateChain([{ id: 'pkg-1' }])
    mocks.dbUpdate.mockReturnValueOnce(blockUpdate)

    const result = await handoffApprovedWorkPackages('task-1')

    expect(result).toMatchObject({
      blockedReason: expect.stringContaining('planning context was not materialized'),
      claimedPackageId: null,
      readyPackageIds: [],
      status: 'blocked',
    })
    expect(blockUpdate.set).toHaveBeenCalledWith(expect.objectContaining({
      blockedReason: expect.stringContaining('planning context was not materialized'),
      metadata: expect.anything(),
      status: 'blocked',
    }))
    expect(mocks.dbTransaction).toHaveBeenCalledTimes(1)
  })

  it('returns blocked when auto-advancing into a broker-blocked follow-on package', async () => {
    mocks.materializeReviewGatesForWorkPackageCompletion.mockResolvedValueOnce({
      status: 'not_required',
      packageStatus: 'completed',
      createdGates: [],
      sourceArtifact: defaultSourceArtifact(),
    })

    mocks.dbSelect
      .mockReturnValueOnce(chain([
        {
          id: 'pkg-1',
          assignedRole: 'backend',
          harnessId: 'harness-1',
          harnessToolPolicy: null,
          mcpRequirements: [],
          metadata: {},
          sequence: 1,
          status: 'pending',
          title: 'Backend package',
        },
        {
          id: 'pkg-2',
          assignedRole: 'frontend',
          harnessId: 'harness-2',
          harnessToolPolicy: null,
          mcpRequirements: [{
            mcpId: 'github',
            requirement: 'optional',
            permissions: ['github.issues.read'],
            fallback: { action: 'ask_user', message: 'Connect GitHub before frontend handoff.' },
          }],
          metadata: {},
          sequence: 2,
          status: 'pending',
          title: 'Frontend package',
        },
      ]))
      .mockReturnValueOnce(chain([
        { workPackageId: 'pkg-2', dependsOnWorkPackageId: 'pkg-1' },
      ]))
      .mockReturnValueOnce(chain([
        {
          id: 'pkg-1',
          assignedRole: 'backend',
          harnessId: 'harness-1',
          harnessToolPolicy: null,
          mcpRequirements: [],
          metadata: {},
          sequence: 1,
          status: 'completed',
          title: 'Backend package',
        },
        {
          id: 'pkg-2',
          assignedRole: 'frontend',
          harnessId: 'harness-2',
          harnessToolPolicy: null,
          mcpRequirements: [{
            mcpId: 'github',
            requirement: 'optional',
            permissions: ['github.issues.read'],
            fallback: { action: 'ask_user', message: 'Connect GitHub before frontend handoff.' },
          }],
          metadata: {},
          sequence: 2,
          status: 'pending',
          title: 'Frontend package',
        },
      ]))
      .mockReturnValueOnce(chain([
        { workPackageId: 'pkg-2', dependsOnWorkPackageId: 'pkg-1' },
      ]))
      .mockReturnValueOnce(chain([{ project: { id: 'project-1' } }]))
      .mockReturnValueOnce(chain([freshAdmissionRow({
        id: 'pkg-2', assignedRole: 'frontend', harnessId: 'harness-2',
        mcpRequirements: [{
          mcpId: 'github', requirement: 'optional', permissions: ['github.issues.read'],
          fallback: { action: 'ask_user', message: 'Connect GitHub before frontend handoff.' },
        }],
        metadata: {}, sequence: 2, status: 'pending', title: 'Frontend package',
      })]))

    const readyUpdate = updateChain([{ id: 'pkg-1' }])
    const blockUpdate = updateChain([{ id: 'pkg-2' }])
    mocks.dbUpdate
      .mockReturnValueOnce(readyUpdate)
      .mockReturnValueOnce(blockUpdate)
    mockNoOpHandoffTransaction()

    const result = await handoffApprovedWorkPackages('task-1')

    expect(result).toMatchObject({
      blockedReason: expect.stringContaining('planning context was not materialized'),
      claimedPackageId: null,
      readyPackageIds: [],
      status: 'blocked',
    })
    expect(blockUpdate.set).toHaveBeenCalledWith(expect.objectContaining({
      blockedReason: expect.stringContaining('planning context was not materialized'),
      status: 'blocked',
    }))
    expect(mocks.publishTaskEvent).toHaveBeenCalledWith('task-1', 'work_package:status', expect.objectContaining({
      blockedReason: expect.stringContaining('planning context was not materialized'),
      status: 'blocked',
      workPackageId: 'pkg-2',
    }))
  })

  it('uses prior implementation runs for attempt number and passes rework context into sandbox execution', async () => {
    const previousExecutionFlag = process.env.FORGE_WORK_PACKAGE_EXECUTION
    process.env.FORGE_WORK_PACKAGE_EXECUTION = '1'
    const workPackage = {
      id: 'pkg-1',
      assignedRole: 'backend',
      blockedReason: 'Needs rework from QA.',
      harnessId: 'harness-1',
      mcpRequirements: [],
      metadata: {},
      sequence: 1,
      status: 'needs_rework',
      title: 'Backend package',
    }
    mocks.dbSelect
      .mockReturnValueOnce(chain([workPackage]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chainWithLimit([{ attemptNumber: null }, { attemptNumber: 1 }]))
      .mockReturnValueOnce(chain([{
        id: 'gate-qa',
        gateType: 'qa_review',
        metadata: { decisionReason: 'Add regression tests.' },
        sourceArtifactId: 'artifact-old',
        status: 'needs_rework',
      }]))
      .mockReturnValueOnce(chain([{
        id: 'artifact-old',
        content: 'Prior implementation output:\n- Added API route but skipped regression tests.',
      }]))
      .mockReturnValueOnce(chain([{
        metadata: {
          executionLease: {
            acquiredAt: '2026-06-25T00:00:00.000Z',
            attemptNumber: 2,
            heartbeatAt: '2026-06-25T00:00:00.000Z',
            runId: 'run-2',
          },
        },
        status: 'running',
      }]))
    const readyUpdate = updateChain([{ id: 'pkg-1' }])
    const claimUpdate = updateChain([{ id: 'pkg-1' }])
    const leaseUpdate = updateChain([{ id: 'pkg-1' }])
    const runModelUpdate = updateChain([{ id: 'run-2' }])
    const contextArtifactLeaseUpdate = updateChain([{ id: 'pkg-1' }])
    mocks.dbUpdate
      .mockReturnValueOnce(readyUpdate)
      .mockReturnValueOnce(runModelUpdate)
      .mockReturnValueOnce(contextArtifactLeaseUpdate)

    const runInsert = insertChain([{ id: 'run-2', agentRunId: 'run-2' }])
    const contextArtifactInsert = insertChain([{
      id: 'artifact-context',
      agentRunId: 'run-2',
      artifactType: 'log_output',
      content: 'context packet',
      metadata: {},
      createdAt: new Date('2026-06-25T00:00:00.000Z'),
    }])
    mocks.dbTransaction
      .mockImplementationOnce(async (callback: (tx: unknown) => unknown) =>
        callback({
          insert: vi.fn().mockReturnValueOnce(runInsert),
          select: freshLockSelectMock(),
          update: vi.fn()
            .mockReturnValueOnce(claimUpdate)
            .mockReturnValueOnce(leaseUpdate),
        }),
      )
      .mockImplementationOnce(async (callback: (tx: unknown) => unknown) =>
        callback({
          insert: mocks.dbInsert,
          update: mocks.dbUpdate,
        }),
      )
    mocks.dbInsert.mockReturnValueOnce(contextArtifactInsert)
    mocks.materializeReviewGatesForWorkPackageCompletion.mockResolvedValueOnce({
      status: 'materialized',
      packageStatus: 'awaiting_review',
      createdGates: [
        { id: 'gate-qa', gateType: 'qa_review', requiredRole: 'qa', title: 'QA review' },
        { id: 'gate-reviewer', gateType: 'reviewer_review', requiredRole: 'reviewer', title: 'Reviewer review' },
      ],
      sourceArtifact: defaultSourceArtifact({
        content: 'final output',
        id: 'artifact-final',
        metadata: {
          attemptNumber: 2,
          hostRepositoryWrites: false,
          repositoryWrites: false,
          sandboxPath: '/workspace/project/.forge/task-runs/task-1/pkg-1/attempt-2',
          sandboxWrites: true,
          source: 'work-package-executor',
          workPackageId: 'pkg-1',
        },
        runId: 'run-2',
      }),
    })
    mocks.loadWorkPackageExecutionContext.mockResolvedValueOnce({
      agentConfig: null,
      modelIdUsed: 'test-model',
      project: { id: 'project-1' },
      task: { id: 'task-1' },
      validatedProjectRoot: '/workspace/project',
      workPackage: {
        id: 'pkg-1',
        metadata: { repositoryWrites: false },
        requiredCapabilities: {},
        title: 'Backend package',
        assignedRole: 'backend',
      },
    })
    mocks.executeWorkPackage.mockResolvedValue({
      artifactContent: 'final output',
      artifactMetadata: {
        hostRepositoryWrites: false,
        repositoryWrites: false,
        sandboxPath: '/workspace/project/.forge/task-runs/task-1/pkg-1/attempt-2',
        sandboxWrites: true,
      },
      commandResults: [],
      executionContextArtifactContent: 'context packet',
      executionContextArtifactMetadata: {
        artifactKind: 'host_readonly_execution_context',
        hostRepositoryWrites: false,
        sandboxWrites: false,
      },
      executionContextPacket: {},
      fileCount: 1,
      hostRepositoryWritePaths: [],
      hostRepositoryWrites: false,
      repositoryWrites: false,
      sandboxPath: '/workspace/project/.forge/task-runs/task-1/pkg-1/attempt-2',
      summary: 'Implemented rework.',
    })

    try {
      const result = await handoffApprovedWorkPackages('task-1')

      expect(result).toMatchObject({
        status: 'handed_off',
        claimedPackageId: 'pkg-1',
      })
      expect(runInsert.values).toHaveBeenCalledWith(expect.objectContaining({
        attemptNumber: 2,
        modelIdUsed: 'pending',
        stage: 'implementation',
        workPackageId: 'pkg-1',
      }))
      expect(leaseUpdate.set).toHaveBeenCalledWith(expect.objectContaining({
        metadata: expect.objectContaining({
          executionLease: expect.objectContaining({
            attemptNumber: 2,
            runId: 'run-2',
            source: 'work-package-handoff',
          }),
        }),
      }))
      expect(runModelUpdate.set).toHaveBeenCalledWith(expect.objectContaining({ modelIdUsed: 'test-model' }))
      expect(mocks.executeWorkPackage).toHaveBeenCalledWith(expect.objectContaining({
        attemptNumber: 2,
        priorReviewContext: expect.objectContaining({
          packageBlockedReason: 'Needs rework from QA.',
          notes: [expect.objectContaining({
            gateId: 'gate-qa',
            reason: expect.stringContaining('Add regression tests.'),
            sourceArtifactId: 'artifact-old',
          })],
        }),
      }))
      expect(mocks.executeWorkPackage.mock.calls[0][0].priorReviewContext.notes[0].reason)
        .toContain('Prior implementation output')
      expect(contextArtifactInsert.values).toHaveBeenCalledWith(expect.objectContaining({
        metadata: expect.objectContaining({
          artifactKind: 'host_readonly_execution_context',
          attemptNumber: 2,
          hostRepositoryWrites: false,
          sandboxWrites: false,
          source: 'execution-context-packet',
        }),
      }))
      expect(mocks.materializeReviewGatesForWorkPackageCompletion).toHaveBeenCalledWith(expect.objectContaining({
        completeSourceRun: expect.objectContaining({
          artifactType: 'log_output',
          content: 'final output',
          metadata: expect.objectContaining({
            attemptNumber: 2,
            hostRepositoryWrites: false,
            repositoryWrites: false,
            sandboxWrites: true,
            source: 'work-package-executor',
          }),
        }),
        requireExecutionLease: true,
        sourceAgentRunId: 'run-2',
        sourceArtifactId: null,
        taskId: 'task-1',
        workPackageId: 'pkg-1',
      }))
      expect(mocks.publishTaskEvent).toHaveBeenCalledWith('task-1', 'artifact:created', expect.objectContaining({
        agentRunId: 'run-2',
        artifactId: 'artifact-final',
        content: 'final output',
        metadata: expect.objectContaining({
          attemptNumber: 2,
          source: 'work-package-executor',
        }),
      }))
      expect(mocks.publishTaskEvent).toHaveBeenCalledWith('task-1', 'work_package:handoff', expect.objectContaining({
        hostRepositoryWrites: false,
        repositoryWrites: false,
        sandboxWrites: true,
        sandboxPath: '/workspace/project/.forge/task-runs/task-1/pkg-1/attempt-2',
      }))
    } finally {
      if (previousExecutionFlag === undefined) {
        delete process.env.FORGE_WORK_PACKAGE_EXECUTION
      } else {
        process.env.FORGE_WORK_PACKAGE_EXECUTION = previousExecutionFlag
      }
    }
  })

  it('does not write stale package artifacts after execution if the lease was cancelled', async () => {
    const previousExecutionFlag = process.env.FORGE_WORK_PACKAGE_EXECUTION
    process.env.FORGE_WORK_PACKAGE_EXECUTION = '1'
    const workPackage = {
      id: 'pkg-1',
      assignedRole: 'backend',
      harnessId: 'harness-1',
      mcpRequirements: [],
      metadata: {},
      sequence: 1,
      status: 'pending',
      title: 'Backend package',
    }
    mocks.dbSelect
      .mockReturnValueOnce(chain([workPackage]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([{
        metadata: {
          executionLease: {
            acquiredAt: '2026-06-25T00:00:00.000Z',
            attemptNumber: 1,
            heartbeatAt: '2026-06-25T00:00:00.000Z',
            runId: 'run-1',
          },
        },
        status: 'running',
      }]))
      .mockReturnValueOnce(chain([]))

    const readyUpdate = updateChain([{ id: 'pkg-1' }])
    const claimUpdate = updateChain([{ id: 'pkg-1' }])
    const leaseUpdate = updateChain([{ id: 'pkg-1' }])
    const runModelUpdate = updateChain([{ id: 'run-1' }])
    const lostLeaseUpdate = updateChain([])
    const staleRunUpdate = updateChain([{ id: 'run-1' }])
    mocks.dbUpdate
      .mockReturnValueOnce(readyUpdate)
      .mockReturnValueOnce(runModelUpdate)
      .mockReturnValueOnce(lostLeaseUpdate)
      .mockReturnValueOnce(staleRunUpdate)

    const runInsert = insertChain([{ id: 'run-1', agentRunId: 'run-1' }])
    mocks.dbTransaction
      .mockImplementationOnce(async (callback: (tx: unknown) => unknown) =>
        callback({
          insert: vi.fn().mockReturnValueOnce(runInsert),
          select: freshLockSelectMock(),
          update: vi.fn()
            .mockReturnValueOnce(claimUpdate)
            .mockReturnValueOnce(leaseUpdate),
        }),
      )
      .mockImplementationOnce(async (callback: (tx: unknown) => unknown) =>
        callback({
          insert: mocks.dbInsert,
          update: mocks.dbUpdate,
        }),
      )
    mocks.loadWorkPackageExecutionContext.mockResolvedValueOnce({
      agentConfig: null,
      modelIdUsed: 'test-model',
      project: { id: 'project-1' },
      task: { id: 'task-1' },
      validatedProjectRoot: '/workspace/project',
      workPackage: {
        id: 'pkg-1',
        metadata: { repositoryWrites: false },
        requiredCapabilities: { repository: false },
        title: 'Backend package',
        assignedRole: 'backend',
      },
    })
    mocks.executeWorkPackage.mockResolvedValueOnce({
      artifactContent: 'final output after cancel',
      artifactMetadata: {
        hostRepositoryWrites: false,
        repositoryWrites: false,
        sandboxPath: '/workspace/project/.forge/task-runs/task-1/pkg-1/attempt-1',
        sandboxWrites: true,
      },
      commandResults: [],
      executionContextArtifactContent: 'context packet after cancel',
      executionContextArtifactMetadata: {
        artifactKind: 'host_readonly_execution_context',
        hostRepositoryWrites: false,
        sandboxWrites: false,
      },
      executionContextPacket: {},
      fileCount: 1,
      hostRepositoryWritePaths: [],
      hostRepositoryWrites: false,
      repositoryWrites: false,
      sandboxPath: '/workspace/project/.forge/task-runs/task-1/pkg-1/attempt-1',
      summary: 'Completed after cancellation.',
    })

    try {
      const result = await handoffApprovedWorkPackages('task-1')

      expect(result).toMatchObject({
        status: 'already_handed_off',
        claimedPackageId: 'pkg-1',
      })
      expect(mocks.executeWorkPackage).toHaveBeenCalled()
      expect(mocks.dbInsert).not.toHaveBeenCalled()
      expect(mocks.materializeReviewGatesForWorkPackageCompletion).not.toHaveBeenCalled()
      expect(staleRunUpdate.set).toHaveBeenCalledWith(expect.objectContaining({
        errorMessage: expect.stringContaining('no longer active'),
        status: 'failed',
      }))
      expect(mocks.publishTaskEvent).toHaveBeenCalledWith('task-1', 'run:failed', expect.objectContaining({
        errorMessage: expect.stringContaining('ignoring stale completion'),
        runId: 'run-1',
      }))
    } finally {
      if (previousExecutionFlag === undefined) {
        delete process.env.FORGE_WORK_PACKAGE_EXECUTION
      } else {
        process.env.FORGE_WORK_PACKAGE_EXECUTION = previousExecutionFlag
      }
    }
  })

  it('fails the package and task instead of starting a fourth implementation attempt', async () => {
    const previousExecutionFlag = process.env.FORGE_WORK_PACKAGE_EXECUTION
    process.env.FORGE_WORK_PACKAGE_EXECUTION = '1'
    mocks.dbSelect
      .mockReturnValueOnce(chain([{
        id: 'pkg-1',
        assignedRole: 'backend',
        harnessId: 'harness-1',
        mcpRequirements: [],
        metadata: {},
        sequence: 1,
        status: 'needs_rework',
        title: 'Backend package',
      }]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([{ attemptNumber: 3 }]))

    const readyUpdate = updateChain([{ id: 'pkg-1' }])
    const claimUpdate = updateChain([{ id: 'pkg-1' }])
    const failedPackageUpdate = updateChain([{ id: 'pkg-1' }])
    const runningTaskUpdate = updateChain([])
    const approvedTaskUpdate = updateChain([{ id: 'task-1' }])
    mocks.dbUpdate
      .mockReturnValueOnce(readyUpdate)
      .mockReturnValueOnce(runningTaskUpdate)
      .mockReturnValueOnce(approvedTaskUpdate)
    mocks.dbTransaction.mockImplementationOnce(async (callback: (tx: unknown) => unknown) =>
      callback({
        insert: vi.fn(),
        select: freshLockSelectMock(),
        update: vi.fn()
          .mockReturnValueOnce(claimUpdate)
          .mockReturnValueOnce(failedPackageUpdate),
      }),
    )

    try {
      const result = await handoffApprovedWorkPackages('task-1')

      expect(result).toMatchObject({
        status: 'blocked',
        terminalBlock: true,
        blockedReason: expect.stringContaining('maximum of 3 implementation attempts'),
      })
      expect(failedPackageUpdate.set).toHaveBeenCalledWith(expect.objectContaining({
        blockedReason: expect.stringContaining('maximum of 3 implementation attempts'),
        metadata: expect.objectContaining({
          executionAttempts: expect.objectContaining({
            maxAttempts: 3,
            nextAttemptNumber: 4,
            status: 'failed',
          }),
        }),
        status: 'failed',
      }))
      expect(claimUpdate.set).toHaveBeenCalledWith(expect.objectContaining({
        blockedReason: null,
        status: 'running',
      }))
      expect(approvedTaskUpdate.set).toHaveBeenCalledWith(expect.objectContaining({
        errorMessage: expect.stringContaining('maximum of 3 implementation attempts'),
        status: 'failed',
      }))
      expect(mocks.loadWorkPackageExecutionContext).not.toHaveBeenCalled()
      expect(mocks.executeWorkPackage).not.toHaveBeenCalled()
    } finally {
      if (previousExecutionFlag === undefined) {
        delete process.env.FORGE_WORK_PACKAGE_EXECUTION
      } else {
        process.env.FORGE_WORK_PACKAGE_EXECUTION = previousExecutionFlag
      }
    }
  })

  it('keeps package execution failures retryable before the final approval attempt', async () => {
    const previousExecutionFlag = process.env.FORGE_WORK_PACKAGE_EXECUTION
    process.env.FORGE_WORK_PACKAGE_EXECUTION = '1'
    mocks.dbSelect
      .mockReturnValueOnce(chain([{
        id: 'pkg-1',
        assignedRole: 'backend',
        harnessId: 'harness-1',
        mcpRequirements: [],
        metadata: { preClaimMetadata: 'keep' },
        sequence: 1,
        status: 'pending',
        title: 'Backend package',
      }]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([{
        metadata: {
          executionLease: {
            acquiredAt: '2026-06-25T00:00:00.000Z',
            attemptNumber: 1,
            heartbeatAt: '2026-06-25T00:00:00.000Z',
            runId: 'run-1',
          },
        },
        status: 'running',
      }]))

    const readyUpdate = updateChain([{ id: 'pkg-1' }])
    const claimUpdate = updateChain([{ id: 'pkg-1' }])
    const leaseUpdate = updateChain([{ id: 'pkg-1' }])
    const runModelUpdate = updateChain([{ id: 'run-1' }])
    const runFailedUpdate = updateChain([{ id: 'run-1' }])
    const packageBlockedUpdate = updateChain([{ id: 'pkg-1' }])
    const packageBlockedSet = packageBlockedUpdate.set as ReturnType<typeof vi.fn>
    mocks.dbUpdate
      .mockReturnValueOnce(readyUpdate)
      .mockReturnValueOnce(runModelUpdate)
      .mockReturnValueOnce(packageBlockedUpdate)
      .mockReturnValueOnce(runFailedUpdate)
    mocks.dbTransaction.mockImplementationOnce(async (callback: (tx: unknown) => unknown) =>
      callback({
        insert: vi.fn().mockReturnValueOnce(insertChain([{ id: 'run-1', agentRunId: 'run-1' }])),
        select: freshLockSelectMock(),
        update: vi.fn()
          .mockReturnValueOnce(claimUpdate)
          .mockReturnValueOnce(leaseUpdate),
      }),
    )
    const failedArtifactInsert = insertChain([{
      id: 'artifact-failed',
      agentRunId: 'run-1',
      artifactType: 'log_output',
      content: 'Generated files before failure.',
      metadata: {},
      createdAt: new Date('2026-06-25T00:00:00.000Z'),
    }])
    mocks.dbInsert.mockReturnValueOnce(failedArtifactInsert)
    mocks.loadWorkPackageExecutionContext.mockResolvedValue({
      agentConfig: null,
      modelIdUsed: 'test-model',
      project: { id: 'project-1' },
      task: { id: 'task-1' },
      validatedProjectRoot: '/workspace/project',
      workPackage: {
        id: 'pkg-1',
        metadata: { repositoryWrites: false },
        requiredCapabilities: {},
        title: 'Backend package',
        assignedRole: 'backend',
      },
    })
    const leakedBearerToken = fixtureSecret('sk', '-live', '-secret')
    mocks.executeWorkPackage.mockRejectedValueOnce(new mocks.WorkPackageExecutionError(
      `model unavailable Authorization: Bearer ${leakedBearerToken} https://user:remote-secret@example.com/repo.git`,
      {
        artifactContent: 'Generated files before failure.',
        artifactMetadata: {
          commandResults: [{ command: ['npm', 'test'], exitCode: 1, stdout: '', stderr: 'failed' }],
          files: ['package.json'],
          generatedBy: 'work-package-executor',
          repositoryWrites: false,
          sandboxPath: '/workspace/project/.forge/task-runs/task-1/pkg-1/attempt-1',
          sandboxWrites: true,
          validationStatus: 'failed',
        },
        commandResults: [{ command: ['npm', 'test'], exitCode: 1, stdout: '', stderr: 'failed' }],
        fileCount: 1,
        sandboxPath: '/workspace/project/.forge/task-runs/task-1/pkg-1/attempt-1',
      },
    ))
    const afterWorkPackageClaimed = vi.fn(async () => {
      // The real PostgreSQL companion test writes grant + unrelated JSONB here.
      // This unit seam proves cleanup happens strictly after the claim commits.
    })

    try {
      await expect(handoffApprovedWorkPackages('task-1', {
        afterWorkPackageClaimed,
        finalAttempt: false,
      }))
        .rejects.toThrow('model unavailable')

      expect(afterWorkPackageClaimed).toHaveBeenCalledWith({
        attempt: 1,
        packageId: 'pkg-1',
        runId: 'run-1',
      })
      expect(packageBlockedUpdate.set).toHaveBeenCalledWith(expect.objectContaining({
        blockedReason: 'Retrying package execution after error: model unavailable Authorization: Bearer [REDACTED_TOKEN] https://[REDACTED_USERINFO]@example.com/repo.git',
        metadata: expect.anything(),
        status: 'blocked',
      }))
      expect(packageBlockedSet.mock.calls[0][0].metadata)
        .not.toEqual({ preClaimMetadata: 'keep' })
      expect(mocks.publishTaskEvent).toHaveBeenCalledWith('task-1', 'work_package:status', expect.objectContaining({
        blockedReason: 'Retrying package execution after error: model unavailable Authorization: Bearer [REDACTED_TOKEN] https://[REDACTED_USERINFO]@example.com/repo.git',
        status: 'blocked',
        workPackageId: 'pkg-1',
      }))
      expect(mocks.publishTaskEvent).not.toHaveBeenCalledWith('task-1', 'run:failed', expect.objectContaining({
        errorMessage: expect.stringContaining(leakedBearerToken),
      }))
      expect(mocks.publishTaskEvent).not.toHaveBeenCalledWith('task-1', 'work_package:status', expect.objectContaining({
        status: 'failed',
        workPackageId: 'pkg-1',
      }))
      expect(failedArtifactInsert.values).toHaveBeenCalledWith(expect.objectContaining({
        content: expect.stringContaining('Generated files before failure.'),
        metadata: expect.objectContaining({
          errorMessage: 'model unavailable Authorization: Bearer [REDACTED_TOKEN] https://[REDACTED_USERINFO]@example.com/repo.git',
          failure: true,
          files: ['package.json'],
          generatedBy: 'work-package-executor',
          sandboxPath: '/workspace/project/.forge/task-runs/task-1/pkg-1/attempt-1',
          sandboxWrites: true,
          validationStatus: 'failed',
        }),
      }))
    } finally {
      if (previousExecutionFlag === undefined) {
        delete process.env.FORGE_WORK_PACKAGE_EXECUTION
      } else {
        process.env.FORGE_WORK_PACKAGE_EXECUTION = previousExecutionFlag
      }
    }
  })

  it('blocks repository-affecting packages on non-Git project paths without retrying handoff', async () => {
    const previousExecutionFlag = process.env.FORGE_WORK_PACKAGE_EXECUTION
    process.env.FORGE_WORK_PACKAGE_EXECUTION = '1'
    const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'forge-non-git-project-'))
    tempRoots.push(projectRoot)

    let selectCall = 0
    mocks.dbSelect.mockImplementation(() => {
      selectCall += 1
      if (selectCall === 1) return chain([{
        id: 'pkg-1',
        assignedRole: 'frontend',
        harnessId: 'harness-1',
        mcpRequirements: [],
        metadata: { repositoryWrites: true },
        sequence: 1,
        status: 'pending',
        title: 'Frontend package',
      }])
      if (selectCall === 2) return chain([])
      if (selectCall === 3) return chain([])
      if (selectCall === 4 || selectCall === 5) {
        return chain([{
          metadata: {
            executionLease: {
              acquiredAt: '2026-06-25T00:00:00.000Z',
              attemptNumber: 1,
              heartbeatAt: '2026-06-25T00:00:00.000Z',
              runId: 'run-1',
            },
          },
          status: 'running',
        }])
      }
      return chain([])
    })

    const readyUpdate = updateChain([{ id: 'pkg-1' }])
    const runModelUpdate = updateChain([{ id: 'run-1' }])
    const packageBlockedUpdate: Record<string, unknown> = {
      returning: vi.fn(async () => [{ id: 'pkg-1' }]),
    }
    packageBlockedUpdate.set = vi.fn(() => packageBlockedUpdate)
    packageBlockedUpdate.where = vi.fn(() => packageBlockedUpdate)
    const runFailedUpdate = updateChain([{ id: 'run-1' }])
    mocks.dbUpdate
      .mockReturnValueOnce(readyUpdate)
      .mockReturnValueOnce(runModelUpdate)
      .mockReturnValueOnce(packageBlockedUpdate)
      .mockReturnValueOnce(runFailedUpdate)

    const claimUpdate = updateChain([{ id: 'pkg-1' }])
    const leaseUpdate = updateChain([{ id: 'pkg-1' }])
    const firstEvidenceLeaseUpdate = updateChain([{ id: 'pkg-1' }])
    const firstEvidenceInsert = insertChain([{ id: 'vcs-1' }])
    const firstEvidenceLookup = vi.fn().mockReturnValueOnce(chain([]))
    const readinessArtifactLeaseUpdate = updateChain([{ id: 'pkg-1' }])
    const readinessArtifactInsert = insertChain([{
      id: 'artifact-readiness',
      agentRunId: 'run-1',
      artifactType: 'log_output',
      content: 'Repository readiness blocked.',
      metadata: {},
      createdAt: new Date('2026-06-25T00:00:00.000Z'),
    }])
    mocks.dbTransaction
      .mockImplementationOnce(async (callback: (tx: unknown) => unknown) =>
        callback({
          insert: vi.fn().mockReturnValueOnce(insertChain([{ id: 'run-1', agentRunId: 'run-1' }])),
          select: freshLockSelectMock(),
          update: vi.fn()
            .mockReturnValueOnce(claimUpdate)
            .mockReturnValueOnce(leaseUpdate),
        }),
      )
      .mockImplementationOnce(async (callback: (tx: unknown) => unknown) =>
        callback({
          insert: vi.fn().mockReturnValueOnce(firstEvidenceInsert),
          select: firstEvidenceLookup,
          update: vi.fn().mockReturnValueOnce(firstEvidenceLeaseUpdate),
        }),
      )
      .mockImplementationOnce(async (callback: (tx: unknown) => unknown) =>
        callback({
          insert: vi.fn().mockReturnValueOnce(readinessArtifactInsert),
          update: vi.fn().mockReturnValueOnce(readinessArtifactLeaseUpdate),
        }),
      )

    const evidenceFailureInsert = insertChain([{ id: 'vcs-1' }])
    const repositoryFailureArtifactInsert = insertChain([{
      id: 'artifact-repository-failure',
      agentRunId: 'run-1',
      artifactType: 'log_output',
      content: 'Repository evidence failed.',
      metadata: {},
      createdAt: new Date('2026-06-25T00:00:00.000Z'),
    }])
    const failedArtifactInsert = insertChain([{
      id: 'artifact-failed',
      agentRunId: 'run-1',
      artifactType: 'log_output',
      content: 'Work package execution failed.',
      metadata: {},
      createdAt: new Date('2026-06-25T00:00:00.000Z'),
    }])
    mocks.dbInsert
      .mockReturnValueOnce(evidenceFailureInsert)
      .mockReturnValueOnce(repositoryFailureArtifactInsert)
      .mockReturnValueOnce(failedArtifactInsert)
    mocks.loadWorkPackageExecutionContext.mockResolvedValue({
      agentConfig: null,
      modelIdUsed: 'test-model',
      project: { id: 'project-1', localPath: projectRoot, defaultBranch: 'main', githubRepo: 'owner/repo', name: 'Test' },
      task: { id: 'task-1', githubBranch: null, title: 'Tiny task tracker' },
      validatedProjectRoot: projectRoot,
      workPackage: {
        id: 'pkg-1',
        metadata: { repositoryWrites: true },
        requiredCapabilities: {},
        title: 'Frontend package',
        assignedRole: 'frontend',
      },
    })

    try {
      const result = await handoffApprovedWorkPackages('task-1', { finalAttempt: false })

      expect(result).toMatchObject({
        status: 'blocked',
        claimedPackageId: null,
        readyPackageIds: ['pkg-1'],
        blockedReason: expect.stringContaining('Project local path is not a Git repository'),
      })
      expect(packageBlockedUpdate.set as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(expect.objectContaining({
        blockedReason: expect.stringContaining('Project local path is not a Git repository'),
        status: 'blocked',
      }))
      expect(runFailedUpdate.set).toHaveBeenCalledWith(expect.objectContaining({
        errorMessage: expect.stringContaining('Project local path is not a Git repository'),
        status: 'failed',
      }))
      expect(mocks.executeWorkPackage).not.toHaveBeenCalled()
      expect(firstEvidenceLookup).toHaveBeenCalledOnce()
      expect(mocks.publishTaskEvent).toHaveBeenCalledWith('task-1', 'work_package:status', expect.objectContaining({
        blockedReason: expect.stringContaining('Project local path is not a Git repository'),
        status: 'blocked',
        workPackageId: 'pkg-1',
      }))
    } finally {
      if (previousExecutionFlag === undefined) {
        delete process.env.FORGE_WORK_PACKAGE_EXECUTION
      } else {
        process.env.FORGE_WORK_PACKAGE_EXECUTION = previousExecutionFlag
      }
    }
  })

  it('advances local-only non-Git project paths without Git-only evidence', async () => {
    const previousExecutionFlag = process.env.FORGE_WORK_PACKAGE_EXECUTION
    const previousHostRepositoryWrites = process.env.FORGE_HOST_REPOSITORY_WRITES
    process.env.FORGE_WORK_PACKAGE_EXECUTION = '1'
    process.env.FORGE_HOST_REPOSITORY_WRITES = '1'
    const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'forge-sandbox-non-git-project-'))
    tempRoots.push(projectRoot)

    const artifactWrites: Array<{
      artifactType: string
      content: string
      metadata: Record<string, unknown>
    }> = []
    const commandAuditWrites: Array<Record<string, unknown>> = []
    const evidenceWrites: Array<Record<string, unknown>> = []
    let artifactIndex = 0
    let evidenceIndex = 0

    const insertForValues = (values: Record<string, unknown>) => ({
      returning: vi.fn(async () => {
        if (typeof values.artifactType === 'string') {
          artifactIndex += 1
          const artifact = {
            id: `artifact-${artifactIndex}`,
            agentRunId: values.agentRunId as string,
            artifactType: values.artifactType,
            content: values.content as string,
            metadata: values.metadata as Record<string, unknown>,
            createdAt: new Date('2026-06-25T00:00:00.000Z'),
          }
          artifactWrites.push({
            artifactType: artifact.artifactType,
            content: artifact.content,
            metadata: artifact.metadata,
          })
          return [artifact]
        }

        if (values.command === 'git' && Array.isArray(values.argv)) {
          commandAuditWrites.push(values)
          return [{ id: 'audit-1' }]
        }

        if (typeof values.agentType === 'string') {
          return [{
            id: 'run-1',
            ...values,
          }]
        }

        evidenceIndex += 1
        evidenceWrites.push(values)
        return [{ id: `vcs-${evidenceIndex}` }]
      }),
    })
    const makeTransaction = () => ({
      insert: vi.fn(() => ({
        values: vi.fn((values: Record<string, unknown>) => insertForValues(values)),
      })),
      select: vi.fn(() => chain([])),
      update: vi.fn(() => updateChain([{ id: 'pkg-1' }])),
    })

    let selectCall = 0
    mocks.dbSelect.mockImplementation(() => {
      selectCall += 1
      if (selectCall === 1) {
        return chain([{
          id: 'pkg-1',
          assignedRole: 'backend',
          harnessId: 'harness-1',
          mcpRequirements: [],
          metadata: { repositoryWrites: true },
          sequence: 1,
          status: 'pending',
          title: 'Backend package',
        }])
      }
      if (selectCall === 2) return chain([])
      if (selectCall === 3) return chain([])
      if (selectCall === 4 || selectCall === 6) {
        return chain([{
          metadata: {
            executionLease: {
              acquiredAt: '2026-06-25T00:00:00.000Z',
              attemptNumber: 1,
              heartbeatAt: '2026-06-25T00:00:00.000Z',
              runId: 'run-1',
            },
          },
          status: 'running',
        }])
      }
      if (selectCall === 5) return chain([])
      return chain([])
    })

    const readyUpdate = updateChain([{ id: 'pkg-1' }])
    const runModelUpdate = updateChain([{ id: 'run-1' }])
    mocks.dbUpdate
      .mockReturnValueOnce(readyUpdate)
      .mockReturnValueOnce(runModelUpdate)
    mocks.dbTransaction.mockImplementation(async (callback: (tx: unknown) => unknown) =>
      callback(makeTransaction()),
    )
    mocks.materializeReviewGatesForWorkPackageCompletion.mockResolvedValueOnce({
      status: 'materialized',
      packageStatus: 'awaiting_review',
      createdGates: [
        { id: 'gate-qa', gateType: 'qa_review', requiredRole: 'qa', title: 'QA review' },
      ],
      sourceArtifact: defaultSourceArtifact({
        content: 'final output',
        id: 'artifact-final',
        metadata: {
          attemptNumber: 1,
          hostRepositoryWrites: true,
          repositoryWrites: true,
          sandboxPath: `${projectRoot}/.forge/task-runs/task-1/pkg-1/attempt-1`,
          sandboxWrites: true,
          source: 'work-package-executor',
          workPackageId: 'pkg-1',
        },
        runId: 'run-1',
      }),
    })
    mocks.loadWorkPackageExecutionContext.mockResolvedValue({
      agentConfig: null,
      modelIdUsed: 'test-model',
      project: { id: 'project-1', localPath: projectRoot, defaultBranch: 'main', githubRepo: null, name: 'Test' },
      task: { id: 'task-1', githubBranch: null, title: 'Tiny task tracker' },
      validatedProjectRoot: projectRoot,
      workPackage: {
        id: 'pkg-1',
        metadata: { repositoryWrites: true },
        requiredCapabilities: {},
        title: 'Backend package',
        assignedRole: 'backend',
      },
    })
    mocks.executeWorkPackage.mockResolvedValue({
      artifactContent: 'final output',
      artifactMetadata: {
        hostRepositoryWritePaths: ['package.json'],
        hostRepositoryWrites: true,
        repositoryWrites: true,
        sandboxPath: `${projectRoot}/.forge/task-runs/task-1/pkg-1/attempt-1`,
        sandboxWrites: true,
      },
      commandResults: [{ command: ['npm', 'test'], exitCode: 0, stdout: 'passed', stderr: '' }],
      executionContextArtifactContent: 'context packet',
      executionContextArtifactMetadata: {
        artifactKind: 'host_readonly_execution_context',
        hostRepositoryWrites: false,
        sandboxWrites: false,
      },
      executionContextPacket: {},
      fileCount: 1,
      hostRepositoryWritePaths: ['package.json'],
      hostRepositoryWrites: true,
      repositoryWrites: true,
      sandboxPath: `${projectRoot}/.forge/task-runs/task-1/pkg-1/attempt-1`,
      summary: 'Implemented in sandbox.',
    })

    try {
      const result = await handoffApprovedWorkPackages('task-1')

      expect(result).toMatchObject({
        status: 'handed_off',
        claimedPackageId: 'pkg-1',
      })
      expect(mocks.executeWorkPackage).toHaveBeenCalled()
      expect(artifactWrites).toEqual(expect.arrayContaining([
        expect.objectContaining({
          artifactType: 'test_report',
          content: expect.stringContaining('Command: npm test'),
          metadata: expect.objectContaining({
            artifactKind: 'validation_output_summary',
            validationStatus: 'passed',
          }),
        }),
      ]))
      expect(artifactWrites).not.toEqual(expect.arrayContaining([
        expect.objectContaining({
          metadata: expect.objectContaining({ artifactKind: 'repository_diff_summary' }),
        }),
      ]))
      expect(commandAuditWrites).toHaveLength(0)
      expect(evidenceWrites).toEqual(expect.arrayContaining([
        expect.objectContaining({
          diffSummary: null,
          metadata: expect.objectContaining({
            isGitRepository: false,
            validationStatus: 'passed',
          }),
          status: 'complete',
        }),
      ]))
      expect([
        ...artifactWrites.map((artifact) => artifact.content),
        ...evidenceWrites.map((evidence) => String(evidence.diffSummary ?? '')),
      ].join('\n')).not.toMatch(/not a git repository/i)
    } finally {
      if (previousExecutionFlag === undefined) {
        delete process.env.FORGE_WORK_PACKAGE_EXECUTION
      } else {
        process.env.FORGE_WORK_PACKAGE_EXECUTION = previousExecutionFlag
      }
      if (previousHostRepositoryWrites === undefined) {
        delete process.env.FORGE_HOST_REPOSITORY_WRITES
      } else {
        process.env.FORGE_HOST_REPOSITORY_WRITES = previousHostRepositoryWrites
      }
    }
  })

  it('skips dirty Git diff evidence for sandbox-only project paths without host writes', async () => {
    const previousExecutionFlag = process.env.FORGE_WORK_PACKAGE_EXECUTION
    const previousHostRepositoryWrites = process.env.FORGE_HOST_REPOSITORY_WRITES
    process.env.FORGE_WORK_PACKAGE_EXECUTION = '1'
    process.env.FORGE_HOST_REPOSITORY_WRITES = '0'
    const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'forge-sandbox-dirty-git-project-'))
    tempRoots.push(projectRoot)
    await initDirtyGitRepo(projectRoot)

    const artifactWrites: Array<{
      artifactType: string
      content: string
      metadata: Record<string, unknown>
    }> = []
    const commandAuditWrites: Array<Record<string, unknown>> = []
    const evidenceWrites: Array<Record<string, unknown>> = []
    let artifactIndex = 0
    let evidenceIndex = 0

    const insertForValues = (values: Record<string, unknown>) => ({
      returning: vi.fn(async () => {
        if (typeof values.artifactType === 'string') {
          artifactIndex += 1
          const artifact = {
            id: `artifact-${artifactIndex}`,
            agentRunId: values.agentRunId as string,
            artifactType: values.artifactType,
            content: values.content as string,
            metadata: values.metadata as Record<string, unknown>,
            createdAt: new Date('2026-06-25T00:00:00.000Z'),
          }
          artifactWrites.push({
            artifactType: artifact.artifactType,
            content: artifact.content,
            metadata: artifact.metadata,
          })
          return [artifact]
        }

        if (values.command === 'git' && Array.isArray(values.argv)) {
          commandAuditWrites.push(values)
          return [{ id: 'audit-1' }]
        }

        if (typeof values.agentType === 'string') {
          return [{
            id: 'run-1',
            ...values,
          }]
        }

        evidenceIndex += 1
        evidenceWrites.push(values)
        return [{ id: `vcs-${evidenceIndex}` }]
      }),
    })
    const makeTransaction = () => ({
      insert: vi.fn(() => ({
        values: vi.fn((values: Record<string, unknown>) => insertForValues(values)),
      })),
      select: vi.fn(() => chain([])),
      update: vi.fn(() => updateChain([{ id: 'pkg-1' }])),
    })

    let selectCall = 0
    mocks.dbSelect.mockImplementation(() => {
      selectCall += 1
      if (selectCall === 1) {
        return chain([{
          id: 'pkg-1',
          assignedRole: 'backend',
          harnessId: 'harness-1',
          mcpRequirements: [],
          metadata: { repositoryWrites: true },
          sequence: 1,
          status: 'pending',
          title: 'Backend package',
        }])
      }
      if (selectCall === 2) return chain([])
      if (selectCall === 3) return chain([])
      if (selectCall === 4 || selectCall === 6) {
        return chain([{
          metadata: {
            executionLease: {
              acquiredAt: '2026-06-25T00:00:00.000Z',
              attemptNumber: 1,
              heartbeatAt: '2026-06-25T00:00:00.000Z',
              runId: 'run-1',
            },
          },
          status: 'running',
        }])
      }
      if (selectCall === 5) return chain([])
      return chain([])
    })

    const readyUpdate = updateChain([{ id: 'pkg-1' }])
    const runModelUpdate = updateChain([{ id: 'run-1' }])
    mocks.dbUpdate
      .mockReturnValueOnce(readyUpdate)
      .mockReturnValueOnce(runModelUpdate)
    mocks.dbTransaction.mockImplementation(async (callback: (tx: unknown) => unknown) =>
      callback(makeTransaction()),
    )
    mocks.materializeReviewGatesForWorkPackageCompletion.mockResolvedValueOnce({
      status: 'materialized',
      packageStatus: 'awaiting_review',
      createdGates: [
        { id: 'gate-qa', gateType: 'qa_review', requiredRole: 'qa', title: 'QA review' },
      ],
      sourceArtifact: defaultSourceArtifact({
        content: 'final output',
        id: 'artifact-final',
        metadata: {
          attemptNumber: 1,
          hostRepositoryWrites: false,
          repositoryWrites: false,
          sandboxPath: `${projectRoot}/.forge/task-runs/task-1/pkg-1/attempt-1`,
          sandboxWrites: true,
          source: 'work-package-executor',
          workPackageId: 'pkg-1',
        },
        runId: 'run-1',
      }),
    })
    mocks.loadWorkPackageExecutionContext.mockResolvedValue({
      agentConfig: null,
      modelIdUsed: 'test-model',
      project: { id: 'project-1', localPath: projectRoot, defaultBranch: 'main', githubRepo: null, name: 'Test' },
      task: { id: 'task-1', githubBranch: null, title: 'Tiny task tracker' },
      validatedProjectRoot: projectRoot,
      workPackage: {
        id: 'pkg-1',
        metadata: { repositoryWrites: true },
        requiredCapabilities: {},
        title: 'Backend package',
        assignedRole: 'backend',
      },
    })
    mocks.executeWorkPackage.mockResolvedValue({
      artifactContent: 'final output',
      artifactMetadata: {
        hostRepositoryWrites: false,
        repositoryWrites: false,
        sandboxPath: `${projectRoot}/.forge/task-runs/task-1/pkg-1/attempt-1`,
        sandboxWrites: true,
      },
      commandResults: [{ command: ['npm', 'test'], exitCode: 0, stdout: 'passed', stderr: '' }],
      executionContextArtifactContent: 'context packet',
      executionContextArtifactMetadata: {
        artifactKind: 'host_readonly_execution_context',
        hostRepositoryWrites: false,
        sandboxWrites: false,
      },
      executionContextPacket: {},
      fileCount: 1,
      hostRepositoryWritePaths: [],
      hostRepositoryWrites: false,
      repositoryWrites: false,
      sandboxPath: `${projectRoot}/.forge/task-runs/task-1/pkg-1/attempt-1`,
      summary: 'Implemented in sandbox.',
    })

    try {
      const result = await handoffApprovedWorkPackages('task-1')

      expect(result).toMatchObject({
        status: 'handed_off',
        claimedPackageId: 'pkg-1',
      })
      expect(mocks.executeWorkPackage).toHaveBeenCalled()
      expect(artifactWrites).toEqual(expect.arrayContaining([
        expect.objectContaining({
          artifactType: 'test_report',
          content: expect.stringContaining('Command: npm test'),
          metadata: expect.objectContaining({
            artifactKind: 'validation_output_summary',
            validationStatus: 'passed',
          }),
        }),
      ]))
      expect(artifactWrites).not.toEqual(expect.arrayContaining([
        expect.objectContaining({
          metadata: expect.objectContaining({ artifactKind: 'repository_diff_summary' }),
        }),
      ]))
      expect(commandAuditWrites).toHaveLength(0)
      expect(evidenceWrites).toEqual(expect.arrayContaining([
        expect.objectContaining({
          diffSummary: null,
          metadata: expect.objectContaining({
            isDirty: true,
            isGitRepository: true,
            validationStatus: 'passed',
          }),
          status: 'complete',
        }),
      ]))
      expect([
        ...artifactWrites.map((artifact) => artifact.content),
        ...evidenceWrites.map((evidence) => String(evidence.diffSummary ?? '')),
      ].join('\n')).not.toContain('README.md')
    } finally {
      if (previousExecutionFlag === undefined) {
        delete process.env.FORGE_WORK_PACKAGE_EXECUTION
      } else {
        process.env.FORGE_WORK_PACKAGE_EXECUTION = previousExecutionFlag
      }
      if (previousHostRepositoryWrites === undefined) {
        delete process.env.FORGE_HOST_REPOSITORY_WRITES
      } else {
        process.env.FORGE_HOST_REPOSITORY_WRITES = previousHostRepositoryWrites
      }
    }
  })

  it('recovers a stale running package before retrying the next implementation attempt', async () => {
    const previousExecutionFlag = process.env.FORGE_WORK_PACKAGE_EXECUTION
    process.env.FORGE_WORK_PACKAGE_EXECUTION = '1'
    const staleUpdatedAt = new Date(Date.now() - 60 * 60 * 1000)
    mocks.dbSelect
      .mockReturnValueOnce(chain([{
        id: 'pkg-1',
        assignedRole: 'backend',
        blockedReason: null,
        harnessId: 'harness-1',
        mcpRequirements: [],
        metadata: {},
        sequence: 1,
        status: 'running',
        title: 'Backend package',
        updatedAt: staleUpdatedAt,
      }]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([{
        id: 'run-stale',
        attemptNumber: 1,
        stage: 'implementation',
      }]))
      .mockReturnValueOnce(chain([{
        id: 'pkg-1',
        assignedRole: 'backend',
        blockedReason: 'Recovered stale running work package.',
        harnessId: 'harness-1',
        mcpRequirements: [],
        metadata: {},
        sequence: 1,
        status: 'blocked',
        title: 'Backend package',
        updatedAt: new Date(),
      }]))
      .mockReturnValueOnce(chain([]))

    const recoveredPackageUpdate = updateChain([{ id: 'pkg-1' }])
    const recoveredRunUpdate = updateChain([{ id: 'run-stale' }])
    const readyUpdate = updateChain([{ id: 'pkg-1' }])
    mocks.dbUpdate
      .mockReturnValueOnce(recoveredPackageUpdate)
      .mockReturnValueOnce(recoveredRunUpdate)
      .mockReturnValueOnce(readyUpdate)

    try {
      const result = await handoffApprovedWorkPackages('task-1', { claimEnabled: false })

      expect(result).toMatchObject({
        status: 'ready_only',
        readyPackageIds: ['pkg-1'],
        claimedPackageId: null,
      })
      expect(recoveredPackageUpdate.set).toHaveBeenCalledWith(expect.objectContaining({
        status: 'blocked',
        blockedReason: expect.stringContaining('Recovered stale running work package'),
      }))
      expect(recoveredRunUpdate.set).toHaveBeenCalledWith(expect.objectContaining({
        status: 'failed',
        errorMessage: expect.stringContaining('Recovered stale running work package'),
      }))
      expect(mocks.publishTaskEvent).toHaveBeenCalledWith('task-1', 'run:failed', expect.objectContaining({
        runId: 'run-stale',
        workPackageId: 'pkg-1',
      }))
      expect(readyUpdate.set).toHaveBeenCalledWith(expect.objectContaining({
        blockedReason: null,
        status: 'ready',
      }))
    } finally {
      if (previousExecutionFlag === undefined) {
        delete process.env.FORGE_WORK_PACKAGE_EXECUTION
      } else {
        process.env.FORGE_WORK_PACKAGE_EXECUTION = previousExecutionFlag
      }
    }
  })

  it('recovers a previously broker-blocked package once MCP access is available', async () => {
    mocks.dbSelect
      .mockReturnValueOnce(chain([
        {
          id: 'pkg-1',
          assignedRole: 'backend',
          harnessId: 'harness-1',
          harnessToolPolicy: null,
          mcpRequirements: [{
            mcpId: 'github',
            requirement: 'required',
            permissions: ['github.issues.read'],
            fallback: { action: 'block', message: 'Connect GitHub first.' },
          }],
          metadata: {
            requirementContexts: [{
              requirementKey: 'legacy-0-github-backend',
              agent: 'backend',
              mcpId: 'github',
              promptOverlay: 'Use the supplied GitHub planning context.',
            }],
          },
          sequence: 1,
          status: 'blocked',
          title: 'Backend package',
        },
      ]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([{ project: { id: 'project-1' } }]))
      .mockReturnValueOnce(chain([{
        id: 'pkg-1', assignedRole: 'backend', blockedReason: null, harnessId: 'harness-1',
        mcpRequirements: [{
          mcpId: 'github', requirement: 'required', permissions: ['github.issues.read'],
          fallback: { action: 'block', message: 'Connect GitHub first.' },
        }],
        metadata: { requirementContexts: [{
          requirementKey: 'legacy-0-github-backend', agent: 'backend', mcpId: 'github',
          promptOverlay: 'Use the supplied GitHub planning context.',
        }] },
        sequence: 1, status: 'blocked', title: 'Backend package', updatedAt: null,
        projectId: 'project-1', localPath: null, mcpConfig: null,
      }]))
    mocks.getProjectMcpOverview.mockResolvedValue({
      projectId: 'project-1',
      config: { profile: 'default', requiredMcps: ['github'], overrides: {} },
      catalog: [],
      mcpsRoot: '/tmp/forge/mcps',
      statuses: [{
        mcpId: 'github',
        displayName: 'GitHub',
        description: 'GitHub MCP',
        enabled: true,
        error: null,
        installPath: '/tmp/forge/mcps/github',
        installState: 'installed',
        status: 'healthy',
      }],
      summary: {
        label: 'MCPs healthy',
        status: 'healthy',
        missing: 0,
        authRequired: 0,
        unhealthy: 0,
        disabled: 0,
      },
    })

    const readyUpdate = updateChain([{ id: 'pkg-1' }])
    mocks.dbUpdate.mockReturnValueOnce(readyUpdate)
    mockFreshPromotionTransaction()
    const { claimUpdate } = mockNoOpHandoffTransaction()

    const result = await handoffApprovedWorkPackages('task-1')

    expect(result).toMatchObject({
      status: 'handed_off',
      claimedPackageId: 'pkg-1',
    })
    expect(readyUpdate.set).toHaveBeenCalledWith(expect.objectContaining({
      blockedReason: null,
      status: 'ready',
    }))
    expect(claimUpdate.set).toHaveBeenCalledWith(expect.objectContaining({
      blockedReason: null,
      status: 'running',
    }))
  })

  it('durably blocks after repeated package or project freshness conflicts without starting a run', async () => {
    const candidate = {
      id: 'pkg-racing',
      assignedRole: 'backend',
      blockedReason: null,
      harnessId: 'harness-1',
      mcpRequirements: [{
        mcpId: 'github',
        requirement: 'optional',
        permissions: ['github.issues.read'],
        fallback: { action: 'continue_without_mcp', message: 'Use local context.' },
      }],
      metadata: { concurrentWriterValue: 'must-survive' },
      sequence: 1,
      status: 'pending',
      title: 'Racing package',
      updatedAt: new Date('2026-07-14T01:00:00.000Z'),
    }
    const project = {
      id: 'project-1',
      localPath: '/workspace/project',
      mcpConfig: { profile: 'default', requiredMcps: [], overrides: {} },
    }

    // Each admission pass captures MCP health, then its package+project CAS
    // loses to a simulated allow-once/config/localPath or metadata update.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      mocks.dbSelect
        .mockReturnValueOnce(chain([candidate]))
        .mockReturnValueOnce(chain([]))
        .mockReturnValueOnce(chain([{ project }]))
        .mockReturnValueOnce(chain([{
          ...candidate,
          projectId: project.id,
          localPath: project.localPath,
          mcpConfig: project.mcpConfig,
        }]))
    }
    // The exhaustion path reloads the latest row before applying its generic,
    // blockable-status-only jsonb_set marker.
    mocks.dbSelect
      .mockReturnValueOnce(chain([freshAdmissionRow(candidate, project)]))

    const failedCasUpdates = Array.from({ length: 3 }, () => updateChain([]))
    const durableBlockUpdate = updateChain([{ id: candidate.id }])
    mocks.dbUpdate
      .mockReturnValueOnce(failedCasUpdates[0])
      .mockReturnValueOnce(failedCasUpdates[1])
      .mockReturnValueOnce(failedCasUpdates[2])
      .mockReturnValueOnce(durableBlockUpdate)

    const result = await handoffApprovedWorkPackages('task-1')

    expect(result).toMatchObject({
      status: 'blocked',
      claimedPackageId: null,
      blockedReason: expect.stringContaining('changed repeatedly while MCP health was being checked'),
    })
    expect(mocks.getProjectMcpOverview).toHaveBeenCalledTimes(3)
    expect(mocks.dbTransaction).toHaveBeenCalledTimes(4)
    const durableBlockSet = durableBlockUpdate.set as ReturnType<typeof vi.fn>
    expect(durableBlockSet).toHaveBeenCalledWith(expect.objectContaining({
      blockedReason: expect.stringContaining('changed repeatedly'),
      metadata: expect.anything(),
      status: 'blocked',
    }))
    // Concurrent metadata is not copied from the stale snapshot; production
    // uses jsonb_set against the current database value.
    expect(durableBlockSet.mock.calls[0][0].metadata).not.toEqual(candidate.metadata)
    expect(mocks.publishTaskEvent).toHaveBeenCalledWith('task-1', 'work_package:status', expect.objectContaining({
      handoffFreshnessBlock: expect.objectContaining({ status: 'blocked' }),
      status: 'blocked',
      workPackageId: candidate.id,
    }))
  })

  it('rechecks MCP health after a claim CAS conflict and starts no stale run', async () => {
    const candidate = {
      id: 'pkg-claim-race', assignedRole: 'backend', blockedReason: null, harnessId: 'harness-1',
      mcpRequirements: [{
        mcpId: 'github', requirement: 'optional', permissions: ['github.issues.read'],
        fallback: { action: 'continue_without_mcp', message: 'Use local context.' },
      }],
      metadata: {}, sequence: 1, status: 'pending', title: 'Claim race', updatedAt: null,
    }
    const project = { id: 'project-1', localPath: '/workspace/project', mcpConfig: null }
    const fresh = { ...candidate, projectId: project.id, localPath: project.localPath, mcpConfig: null }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      mocks.dbSelect
        .mockReturnValueOnce(chain([candidate]))
        .mockReturnValueOnce(chain([]))
        .mockReturnValueOnce(chain([{ project }]))
        .mockReturnValueOnce(chain([fresh]))
    }
    mocks.dbUpdate
      .mockReturnValueOnce(updateChain([{ id: candidate.id }]))
      .mockReturnValueOnce(updateChain([{ id: candidate.id }]))

    const lostClaim = updateChain([])
    const staleInsert = vi.fn()
    mockFreshPromotionTransaction()
    mocks.dbTransaction.mockImplementationOnce(async (callback: (tx: unknown) => unknown) =>
      callback({
        insert: staleInsert,
        select: freshLockSelectMock(),
        update: vi.fn().mockReturnValueOnce(lostClaim),
      }),
    )
    mockFreshPromotionTransaction()
    mockNoOpHandoffTransaction({ packageId: candidate.id, runId: 'run-fresh' })

    const result = await handoffApprovedWorkPackages('task-1')

    expect(result).toMatchObject({ status: 'handed_off', claimedPackageId: candidate.id })
    expect(mocks.getProjectMcpOverview).toHaveBeenCalledTimes(2)
    expect(staleInsert).not.toHaveBeenCalled()
    expect(mocks.publishTaskEvent.mock.calls.filter(([, type]) => type === 'run:started')).toHaveLength(1)
  })
})
