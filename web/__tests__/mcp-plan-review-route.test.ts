import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockGetSession = vi.fn()
const mockGetAccessibleTask = vi.fn()
const mockSelect = vi.fn()
const mockUpdate = vi.fn()

function chain(value: unknown) {
  const result: Record<string, unknown> = {
    then: (resolve: (value: unknown) => unknown) => Promise.resolve(value).then(resolve),
  }
  for (const method of ['from', 'where', 'limit', 'for', 'set', 'returning']) result[method] = () => result
  return result
}

vi.mock('@/lib/session', () => ({ getSession: mockGetSession }))
vi.mock('@/lib/task-access', () => ({
  getAccessibleTask: mockGetAccessibleTask,
  accessibleTaskCondition: vi.fn(() => ({ condition: true })),
}))
vi.mock('@/db', () => ({
  db: {
    transaction: vi.fn(async (callback: (tx: unknown) => unknown) => callback({ select: mockSelect, update: mockUpdate })),
  },
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
    mockGetSession.mockResolvedValue({ userId: 'user-1' })
    mockGetAccessibleTask.mockResolvedValue({ id: 'task-1', status: 'awaiting_approval' })
    mockUpdate.mockReturnValue(chain([]))
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

  it('returns a conflict for a stale review base revision', async () => {
    mockSelect
      .mockReturnValueOnce(chain([{ id: 'task-1', status: 'awaiting_approval' }]))
      .mockReturnValueOnce(chain([{ id: 'gate-1', sourceArtifactId: 'artifact-1', metadata: {} }]))
      .mockReturnValueOnce(chain([{ id: 'artifact-1', metadata: { mcpExecutionDesign: { proposed: proposedDesign() } } }]))
      .mockReturnValueOnce(chain([{ assignedRole: 'backend' }]))
    const { POST } = await import('@/app/api/tasks/[id]/mcp-plan-review/route')
    const response = await POST(new Request('http://localhost/api/tasks/task-1/mcp-plan-review', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(reviewBody(1, 'stale')),
    }) as never, { params: Promise.resolve({ id: 'task-1' }) })
    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({ error: expect.stringMatching(/revision conflict/i) })
    expect(mockUpdate).not.toHaveBeenCalled()
  })
})
