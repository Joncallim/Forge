import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockGetSession = vi.fn()
const mockReadSessionCredential = vi.fn()
const mockReadArchitectPlanHistory = vi.fn()
const mockAppendProtectedMcpOperatorReview = vi.fn()
const mockLoadProtectedReviewPreflight = vi.fn()
const mockGetAccessibleTask = vi.fn()
const mockSelect = vi.fn()
const mockUpdate = vi.fn()
const mockGetProjectMcpOverview = vi.fn()
const mockLoadCurrentProjectFilesystemDecision = vi.fn()
const mockRedisLpush = vi.fn()
const mockRedisPublish = vi.fn()
const mockGuardEpic172ProjectManagementIngress = vi.fn().mockResolvedValue(null)

function chain(value: unknown) {
  const result: Record<string, unknown> = {
    then: (resolve: (value: unknown) => unknown) => Promise.resolve(value).then(resolve),
  }
  for (const method of ['from', 'where', 'limit', 'orderBy', 'for', 'set', 'returning']) result[method] = () => result
  return result
}

vi.mock('@/lib/session', () => ({
  getSession: mockGetSession,
  readSessionCredential: mockReadSessionCredential,
}))
vi.mock('@/lib/mcps/history-reader', () => ({
  readArchitectPlanHistory: mockReadArchitectPlanHistory,
  appendProtectedMcpOperatorReview: mockAppendProtectedMcpOperatorReview,
  listApprovedPackagePlanRegistrations: vi.fn().mockResolvedValue([]),
  readProtectedMcpOperatorReview: vi.fn(),
}))
vi.mock('@/lib/mcps/protected-review-preflight', () => ({
  loadProtectedReviewPreflight: mockLoadProtectedReviewPreflight,
  loadProtectedApprovalReviewPreflight: vi.fn().mockResolvedValue(null),
}))
vi.mock('@/lib/task-access', () => ({
  getAccessibleTask: mockGetAccessibleTask,
  accessibleTaskCondition: vi.fn(() => ({ condition: true })),
}))
vi.mock('@/db', () => ({
  db: {
    select: mockSelect,
    transaction: vi.fn(async (callback: (tx: unknown) => unknown) => callback({ select: mockSelect, update: mockUpdate })),
  },
}))
vi.mock('@/lib/mcps/manager', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/mcps/manager')>(),
  getProjectMcpOverview: mockGetProjectMcpOverview,
}))
vi.mock('@/lib/mcps/filesystem-grant-reconciliation', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/mcps/filesystem-grant-reconciliation')>(),
  loadCurrentProjectFilesystemDecision: mockLoadCurrentProjectFilesystemDecision,
}))
vi.mock('@/lib/redis', () => ({
  redis: { lpush: mockRedisLpush, publish: mockRedisPublish },
}))
vi.mock('@/worker/task-logs', () => ({ recordTaskLogBestEffort: vi.fn() }))
vi.mock('@/lib/projects/epic-172-project-ingress', () => ({
  guardEpic172ProjectManagementIngress: mockGuardEpic172ProjectManagementIngress,
}))

function proposedDesign() {
  return {
    schemaVersion: 1,
    requirements: [{
      requirementKey: 'mcp-requirement-v1-test-1', sourceRequirementIndex: 0, mcpId: 'github',
      requirement: 'required', reason: 'Read issue.', confidence: 'medium', scope: { kind: 'project' }, accessMode: 'planning_instruction',
      assignment: { type: 'agent', targetAgents: ['backend'], targetId: null },
      agentPermissions: { backend: ['github.issues.read'] }, prohibitedCapabilities: [],
      fallback: { action: 'ask_user', message: 'Ask user.' },
    }],
    promptOverlays: {}, requirementContexts: [], mcpAwareSubtasks: [], normalizationErrors: [],
  }
}

function reviewBody(baseRevision = 0, baseDigest: string | null = null) {
  return {
    sourceArtifactId: 'artifact-1', baseRevision, baseDigest,
    items: [{
      requirementKey: 'mcp-requirement-v1-test-1', decision: 'approved',
      assignment: { type: 'agent', targetAgents: ['backend'], targetId: null },
      agentPermissions: { backend: ['github.issues.read'] }, promptOverlays: { backend: 'Use issue context.' },
    }],
  }
}

describe('POST /api/tasks/:id/mcp-plan-review', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSelect.mockReset()
    mockUpdate.mockReset()
    mockGetSession.mockResolvedValue({ userId: 'user-1' })
    mockReadSessionCredential.mockReturnValue('00000000-0000-4000-8000-000000000000')
    mockGetAccessibleTask.mockResolvedValue({ id: 'task-1', status: 'awaiting_approval' })
    mockLoadCurrentProjectFilesystemDecision.mockResolvedValue(null)
    mockUpdate.mockReturnValue(chain([]))
    mockRedisLpush.mockResolvedValue(1)
    mockRedisPublish.mockResolvedValue(1)
    mockLoadProtectedReviewPreflight.mockResolvedValue(null)
    mockAppendProtectedMcpOperatorReview.mockResolvedValue('review-version-1')
  })

  it('approves only the validated reviewed projection and preserves the review identity on the package', async () => {
    const { buildMcpOperatorReview, mcpOperatorReviewSummary } = await import('@/worker/mcp-plan-review')
    const { parseMcpExecutionDesign } = await import('@/worker/mcp-execution-design')
    const design = parseMcpExecutionDesign(`\`\`\`mcp_execution_design_json
${JSON.stringify({
  schemaVersion: 1,
  requirements: [{
    mcpId: 'github', requirement: 'required', reason: 'Read issue.',
    assignment: { type: 'agent', targetAgents: ['backend'], targetId: null },
    agentPermissions: { backend: ['github.issues.read'] }, prohibitedCapabilities: [],
    fallback: { action: 'ask_user', message: 'Ask user.' },
  }],
  promptOverlays: {}, requirementContexts: [], mcpAwareSubtasks: [],
})}
\`\`\``).design!
    const review = buildMcpOperatorReview({
      proposedDesign: design, plannedAgents: ['backend'], previous: null, createdBy: 'user-1',
      review: {
        sourceArtifactId: 'artifact-1', baseRevision: 0, baseDigest: null,
        items: [{
          requirementKey: design.requirements[0].requirementKey!, decision: 'approved',
          assignment: { type: 'agent', targetAgents: ['backend'], targetId: null },
          agentPermissions: { backend: ['github.issues.read'] }, promptOverlays: { backend: 'Reviewed context.' },
        }],
      },
    })
    const gateMetadata = {
      mcpOperatorReviewRequired: true,
      mcpOperatorReviews: [review],
      mcpOperatorReview: mcpOperatorReviewSummary(review),
    }
    mockGetAccessibleTask.mockResolvedValue({ id: 'task-1', projectId: 'project-1', status: 'awaiting_approval' })
    mockGetProjectMcpOverview.mockResolvedValue({
      projectId: 'project-1', config: {}, catalog: [], mcpsRoot: '/tmp/mcps',
      statuses: [{
        mcpId: 'github', displayName: 'GitHub', description: '', installPath: '/tmp/mcps/github',
        installState: 'installed', status: 'healthy', enabled: true, error: null,
        checkedAt: '2026-07-17T00:00:00.000Z',
      }],
      summary: { label: 'Healthy', status: 'healthy', missing: 0, authRequired: 0, unhealthy: 0, disabled: 0 },
    })
    mockSelect
      .mockReturnValueOnce(chain([{ id: 'project-1', localPath: '/tmp/project', mcpConfig: {} }]))
      .mockReturnValueOnce(chain([{ id: 'project-1', localPath: '/tmp/project', mcpConfig: {} }]))
      .mockReturnValueOnce(chain([{ id: 'task-1', projectId: 'project-1', status: 'awaiting_approval' }]))
      .mockReturnValueOnce(chain([{
        id: 'pkg-1', assignedRole: 'backend', title: 'Backend', mcpRequirements: [], metadata: {},
        planGateMetadata: gateMetadata, planGateSourceArtifactId: 'artifact-1',
      }]))
    const approvedTask = { id: 'task-1', projectId: 'project-1', status: 'approved', updatedAt: new Date() }
    const taskUpdate = chain([approvedTask])
    const packageUpdate = chain([{ id: 'pkg-1' }])
    const gateUpdate = chain([{ id: 'gate-1' }])
    taskUpdate.set = vi.fn(() => taskUpdate)
    packageUpdate.set = vi.fn(() => packageUpdate)
    gateUpdate.set = vi.fn(() => gateUpdate)
    mockUpdate
      .mockReturnValueOnce(taskUpdate)
      .mockReturnValueOnce(packageUpdate)
      .mockReturnValueOnce(gateUpdate)

    const { POST } = await import('@/app/api/tasks/[id]/approve/route')
    const response = await POST(new Request('http://localhost/api/tasks/task-1/approve', { method: 'POST' }) as never, {
      params: Promise.resolve({ id: 'task-1' }),
    })
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ task: { id: 'task-1', status: 'approved' } })
    expect(packageUpdate.set).toHaveBeenCalledWith(expect.objectContaining({
      mcpRequirements: [expect.objectContaining({ mcpId: 'github', permissions: ['github.issues.read'] })],
      metadata: expect.objectContaining({
        promptOverlay: 'Reviewed context.',
        mcpOperatorReview: { sourceArtifactId: 'artifact-1', revision: 1, digest: review.digest },
      }),
    }))
    expect(gateUpdate.set).toHaveBeenCalledWith(expect.objectContaining({ status: 'approved' }))
  })

  it('persists a source-bound immutable review revision', async () => {
    mockSelect
      .mockReturnValueOnce(chain([{ id: 'task-1', status: 'awaiting_approval' }]))
      .mockReturnValueOnce(chain([{ id: 'gate-1', sourceArtifactId: 'artifact-1', metadata: {} }]))
      .mockReturnValueOnce(chain([{ id: 'artifact-1', metadata: { mcpExecutionDesign: { proposed: proposedDesign() } } }]))
      .mockReturnValueOnce(chain([{ assignedRole: 'backend' }]))
    const { POST } = await import('@/app/api/tasks/[id]/mcp-plan-review/route')
    const response = await POST(new Request('http://localhost/api/tasks/task-1/mcp-plan-review', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(reviewBody()),
    }) as never, { params: Promise.resolve({ id: 'task-1' }) })
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      review: { sourceArtifactId: 'artifact-1', revision: 1, previousDigest: null, accessMode: 'planning_instruction' },
    })
    expect(mockUpdate).toHaveBeenCalled()
  })

  it('reads a protected review source only through the session-bound history reader', async () => {
    const protectedPlan = `\`\`\`mcp_execution_design_json\n${JSON.stringify({
      schemaVersion: 1,
      requirements: [{
        mcpId: 'github', requirement: 'required', reason: 'Read issue.',
        assignment: { type: 'agent', targetAgents: ['backend'], targetId: null },
        agentPermissions: { backend: ['github.issues.read'] }, prohibitedCapabilities: [],
        fallback: { action: 'ask_user', message: 'Ask user.' },
      }],
      promptOverlays: {}, requirementContexts: [], mcpAwareSubtasks: [],
    })}\n\`\`\``
    const { parseMcpExecutionDesign } = await import('@/worker/mcp-execution-design')
    const protectedDesign = parseMcpExecutionDesign(protectedPlan).design!
    mockReadArchitectPlanHistory.mockResolvedValue([{
      entryId: 'plan_body:000000', entryKind: 'plan_body', content: '# Protected plan',
    }, {
      entryId: `requirement:${protectedDesign.requirements[0].requirementKey}`,
      entryKind: 'requirement',
      requirementKey: protectedDesign.requirements[0].requirementKey,
      content: JSON.stringify({ schemaVersion: 1, ...protectedDesign.requirements[0] }),
    }])
    mockLoadProtectedReviewPreflight.mockResolvedValue({
      gate: {
        id: 'gate-1', sourceArtifactId: 'artifact-1', metadata: { planVersion: '7' },
      },
      sourcePlanVersion: '7',
    })
    process.env.FORGE_ARCHITECT_PLAN_DIGEST_KEY_HEX = 'a'.repeat(64)
    process.env.FORGE_ARCHITECT_PLAN_DIGEST_KEY_ID = 'test-key-v1'
    let appendedHead: Record<string, unknown> | null = null
    mockAppendProtectedMcpOperatorReview.mockImplementation(async (input: { head: Record<string, unknown> }) => {
      appendedHead = input.head
      return 'review-version-1'
    })
    mockSelect
      .mockReturnValueOnce(chain([{ assignedRole: 'backend' }]))
      .mockReturnValueOnce(chain([{ id: 'task-1', status: 'awaiting_approval' }]))
      .mockImplementationOnce(() => chain([{
        id: 'gate-1', sourceArtifactId: 'artifact-1', status: 'pending',
        metadata: { protectedMcpReview: appendedHead },
      }]))
    const { POST } = await import('@/app/api/tasks/[id]/mcp-plan-review/route')
    const body = reviewBody()
    body.items[0].requirementKey = protectedDesign.requirements[0].requirementKey!
    ;(body.items[0] as { promptOverlays: Record<string, string> }).promptOverlays = {}
    const response = await POST(new Request('http://localhost/api/tasks/task-1/mcp-plan-review', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        cookie: 'forge_session=00000000-0000-4000-8000-000000000000',
      },
      body: JSON.stringify(body),
    }) as never, { params: Promise.resolve({ id: 'task-1' }) })
    expect(response.status).toBe(200)
    expect(mockReadArchitectPlanHistory).toHaveBeenCalledWith({
      planVersion: '7',
      sessionCredential: '00000000-0000-4000-8000-000000000000',
      taskId: 'task-1',
    })
    expect(mockAppendProtectedMcpOperatorReview).toHaveBeenCalledWith(expect.objectContaining({
      approvalGateId: 'gate-1',
      sourcePlanVersion: '7',
    }))
    expect(mockUpdate).not.toHaveBeenCalled()
    delete process.env.FORGE_ARCHITECT_PLAN_DIGEST_KEY_HEX
    delete process.env.FORGE_ARCHITECT_PLAN_DIGEST_KEY_ID
  })

  it('returns a reloadable conflict when the protected append loses its revision compare-and-set', async () => {
    const design = proposedDesign()
    mockReadArchitectPlanHistory.mockResolvedValue([{
      entryId: 'plan_body:000000', entryKind: 'plan_body', content: '# Protected plan',
    }, {
      entryId: `requirement:${design.requirements[0].requirementKey}`,
      entryKind: 'requirement',
      requirementKey: design.requirements[0].requirementKey,
      content: JSON.stringify({ schemaVersion: 1, ...design.requirements[0] }),
    }])
    mockLoadProtectedReviewPreflight.mockResolvedValue({
      gate: { id: 'gate-1', sourceArtifactId: 'artifact-1', metadata: {} },
      sourcePlanVersion: '7',
    })
    mockAppendProtectedMcpOperatorReview.mockRejectedValue(
      Object.assign(new Error('append conflict'), { code: 'conflict' }),
    )
    mockSelect.mockReturnValueOnce(chain([{ assignedRole: 'backend' }]))
    process.env.FORGE_ARCHITECT_PLAN_DIGEST_KEY_HEX = 'a'.repeat(64)
    process.env.FORGE_ARCHITECT_PLAN_DIGEST_KEY_ID = 'test-key-v1'
    try {
      const body = reviewBody()
      ;(body.items[0] as { promptOverlays: Record<string, string> }).promptOverlays = {}
      const { POST } = await import('@/app/api/tasks/[id]/mcp-plan-review/route')
      const response = await POST(new Request('http://localhost/api/tasks/task-1/mcp-plan-review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }) as never, { params: Promise.resolve({ id: 'task-1' }) })

      expect(response.status).toBe(409)
      await expect(response.json()).resolves.toEqual({
        error: 'The protected MCP review changed while it was saved. Reload and review again.',
      })
      expect(mockAppendProtectedMcpOperatorReview).toHaveBeenCalledOnce()
      expect(mockUpdate).not.toHaveBeenCalled()
    } finally {
      delete process.env.FORGE_ARCHITECT_PLAN_DIGEST_KEY_HEX
      delete process.env.FORGE_ARCHITECT_PLAN_DIGEST_KEY_ID
    }
  })

  it('fails closed when a protected gate lacks its bound plan version', async () => {
    mockSelect
      .mockReturnValueOnce(chain([{ id: 'task-1', status: 'awaiting_approval' }]))
      .mockReturnValueOnce(chain([{ id: 'gate-1', sourceArtifactId: 'artifact-1', metadata: {} }]))
      .mockReturnValueOnce(chain([{
        id: 'artifact-1', content: 'Architect plan available in protected history', metadata: { historyAvailable: true },
      }]))
    const { POST } = await import('@/app/api/tasks/[id]/mcp-plan-review/route')
    const response = await POST(new Request('http://localhost/api/tasks/task-1/mcp-plan-review', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(reviewBody()),
    }) as never, { params: Promise.resolve({ id: 'task-1' }) })
    expect(response.status).toBe(409)
    expect(mockReadArchitectPlanHistory).not.toHaveBeenCalled()
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('returns a conflict for a stale review base revision', async () => {
    mockSelect
      .mockReturnValueOnce(chain([{ id: 'task-1', status: 'awaiting_approval' }]))
      .mockReturnValueOnce(chain([{ id: 'gate-1', sourceArtifactId: 'artifact-1', metadata: {} }]))
      .mockReturnValueOnce(chain([{ id: 'artifact-1', metadata: { mcpExecutionDesign: { proposed: proposedDesign() } } }]))
      .mockReturnValueOnce(chain([{ assignedRole: 'backend' }]))
    const { POST } = await import('@/app/api/tasks/[id]/mcp-plan-review/route')
    const response = await POST(new Request('http://localhost/api/tasks/task-1/mcp-plan-review', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(reviewBody(1, 'a'.repeat(64))),
    }) as never, { params: Promise.resolve({ id: 'task-1' }) })
    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({ error: expect.stringMatching(/revision conflict/i) })
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('rejects oversized nested fields even when the requirement is denied', async () => {
    const body = reviewBody()
    body.items[0].decision = 'denied'
    body.items[0].promptOverlays = { backend: 'x'.repeat(1001) }
    const { POST } = await import('@/app/api/tasks/[id]/mcp-plan-review/route')
    const response = await POST(new Request('http://localhost/api/tasks/task-1/mcp-plan-review', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }) as never, { params: Promise.resolve({ id: 'task-1' }) })
    expect(response.status).toBe(400)
    expect(mockSelect).not.toHaveBeenCalled()
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('rejects excessive nested capability counts before opening a transaction', async () => {
    const body = reviewBody()
    body.items[0].agentPermissions = {
      backend: Array.from({ length: 21 }, (_, index) => `github.capability.${index}`),
    }
    const { POST } = await import('@/app/api/tasks/[id]/mcp-plan-review/route')
    const response = await POST(new Request('http://localhost/api/tasks/task-1/mcp-plan-review', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }) as never, { params: Promise.resolve({ id: 'task-1' }) })
    expect(response.status).toBe(400)
    expect(mockSelect).not.toHaveBeenCalled()
    expect(mockUpdate).not.toHaveBeenCalled()
  })
})

describe('GET /api/tasks/:id/architect-plan-history/:planVersion', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetSession.mockResolvedValue({ userId: 'user-1' })
    mockReadSessionCredential.mockReturnValue('00000000-0000-4000-8000-000000000000')
    mockGetAccessibleTask.mockResolvedValue({ id: 'task-1' })
    mockReadArchitectPlanHistory.mockResolvedValue([{ entryId: 'plan_body:000000', content: 'protected plan' }])
  })

  it('returns only the audited fixed-principal history result', async () => {
    const { GET } = await import('@/app/api/tasks/[id]/architect-plan-history/[planVersion]/route')
    const response = await GET(new Request('http://localhost/api/tasks/task-1/architect-plan-history/2') as never, {
      params: Promise.resolve({ id: 'task-1', planVersion: '2' }),
    })
    expect(response.status).toBe(200)
    expect(mockReadArchitectPlanHistory).toHaveBeenCalledWith({
      planVersion: '2',
      sessionCredential: '00000000-0000-4000-8000-000000000000',
      taskId: 'task-1',
    })
  })

  it('returns the same safe denial when the dedicated history reader rejects the request', async () => {
    mockReadArchitectPlanHistory.mockRejectedValue(new Error('reader unavailable'))
    const { GET } = await import('@/app/api/tasks/[id]/architect-plan-history/[planVersion]/route')
    const response = await GET(new Request('http://localhost/api/tasks/task-1/architect-plan-history/2') as never, {
      params: Promise.resolve({ id: 'task-1', planVersion: '2' }),
    })
    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toEqual({ error: 'Architect plan history not found.' })
  })

  it('uses the same safe denial for inaccessible tasks and invalid versions', async () => {
    mockGetAccessibleTask.mockResolvedValue(null)
    const { GET } = await import('@/app/api/tasks/[id]/architect-plan-history/[planVersion]/route')
    const inaccessible = await GET(new Request('http://localhost/api/tasks/task-2/architect-plan-history/2') as never, {
      params: Promise.resolve({ id: 'task-2', planVersion: '2' }),
    })
    const invalid = await GET(new Request('http://localhost/api/tasks/task-1/architect-plan-history/latest') as never, {
      params: Promise.resolve({ id: 'task-1', planVersion: 'latest' }),
    })
    expect(inaccessible.status).toBe(404)
    expect(invalid.status).toBe(404)
    await expect(inaccessible.json()).resolves.toEqual({ error: 'Architect plan history not found.' })
    await expect(invalid.json()).resolves.toEqual({ error: 'Architect plan history not found.' })
  })
})
