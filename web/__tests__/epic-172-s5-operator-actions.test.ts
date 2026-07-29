import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({ default: {} }))

const getSession = vi.fn()
const getAccessibleTask = vi.fn()
const guardEpic172ProjectManagementIngress = vi.fn()
const readS5AuthoritativeTaskState = vi.fn()
const mutateProjectFilesystemGrant = vi.fn()
const getProjectMcpOverview = vi.fn()
const filesystemGrantHealthError = vi.fn()
const lpush = vi.fn()
const select = vi.fn()

vi.mock('@/lib/session', () => ({ getSession }))
vi.mock('@/lib/task-access', () => ({ getAccessibleTask }))
vi.mock('@/lib/projects/epic-172-project-ingress', () => ({ guardEpic172ProjectManagementIngress }))
vi.mock('@/lib/mcps/manager', () => ({ getProjectMcpOverview }))
vi.mock('@/lib/mcps/filesystem-grants', () => ({ filesystemGrantHealthError }))
vi.mock('@/lib/mcps/filesystem-grant-reconciliation', () => ({ mutateProjectFilesystemGrant }))
vi.mock('@/lib/redis', () => ({ redis: { lpush } }))
vi.mock('@/db', () => ({ db: { select } }))
vi.mock('@/db/schema', () => ({ projects: {} }))
vi.mock('@/lib/project-access', () => ({ accessibleProjectCondition: vi.fn() }))
vi.mock('@/lib/mcps/s5-server-reader', () => ({
  readS5AuthoritativeTaskState,
  S5TaskNotFoundError: class S5TaskNotFoundError extends Error {},
}))

const TASK_ID = '00000000-0000-4000-8000-000000000001'
const PROJECT_ID = '00000000-0000-4000-8000-000000000002'
const PACKAGE_ID = '00000000-0000-4000-8000-000000000003'
const EVIDENCE_ID = '00000000-0000-4000-8000-000000000004'
const AUDIT_ID = '00000000-0000-4000-8000-000000000005'
const FINGERPRINT = `sha256:${'a'.repeat(64)}`
const EVIDENCE_FINGERPRINT = `sha256:${'b'.repeat(64)}`
const MARKER_FINGERPRINT = `sha256:${'c'.repeat(64)}`

function state(overrides: Record<string, unknown> = {}) {
  return {
    computedAt: '2026-07-18T00:00:00.000Z',
    observedAtMs: 0,
    localEvidenceAvailable: true,
    taskId: TASK_ID,
    projectId: PROJECT_ID,
    taskStatus: 'running',
    freshnessFingerprint: FINGERPRINT,
    packages: [],
    projectGrant: null,
    recoveryMarkers: [
      {
        workPackageId: PACKAGE_ID,
        kind: 'local_effect_recovery',
        state: 'current',
        action: 'retry_local_execution',
        evidenceId: EVIDENCE_ID,
        evidenceFingerprint: EVIDENCE_FINGERPRINT,
      },
      {
        workPackageId: PACKAGE_ID,
        kind: 'packet_issuance',
        state: 'current',
        action: 'retry_execution',
        evidenceId: AUDIT_ID,
        evidenceFingerprint: MARKER_FINGERPRINT,
      },
    ],
    terminalPackages: [],
    evidenceRecords: [],
    ...overrides,
  }
}

async function post(body: unknown, taskId = TASK_ID) {
  const { POST } = await import('@/app/api/mcps/actions/[taskId]/route')
  const { NextRequest } = await import('next/server')
  return POST(
    new NextRequest('http://forge.test/api/mcps/actions/task', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ taskId }) },
  )
}

const retryLocal = {
  schemaVersion: 1,
  action: 'retry_local_execution',
  expectedFreshnessFingerprint: FINGERPRINT,
  localRunEvidenceId: EVIDENCE_ID,
  evidenceFingerprint: EVIDENCE_FINGERPRINT,
}

describe('S5 operator action endpoint', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getSession.mockResolvedValue({ userId: 'owner' })
    getAccessibleTask.mockResolvedValue({ id: TASK_ID, submittedBy: 'owner' })
    guardEpic172ProjectManagementIngress.mockResolvedValue(null)
    readS5AuthoritativeTaskState.mockResolvedValue(state())
  })

  it('rejects an unauthenticated request before reading any state', async () => {
    getSession.mockResolvedValue(null)
    const response = await post(retryLocal)
    expect(response.status).toBe(401)
    expect(readS5AuthoritativeTaskState).not.toHaveBeenCalled()
    expect(mutateProjectFilesystemGrant).not.toHaveBeenCalled()
  })

  it('does not disclose another operator task and mutates nothing', async () => {
    getAccessibleTask.mockResolvedValue({ id: TASK_ID, submittedBy: 'someone-else' })
    const response = await post(retryLocal)
    expect(response.status).toBe(404)
    expect(readS5AuthoritativeTaskState).not.toHaveBeenCalled()
    expect(mutateProjectFilesystemGrant).not.toHaveBeenCalled()
  })

  it.each([
    ['an unknown action', { ...retryLocal, action: 'delete_everything' }],
    ['a missing fingerprint', { ...retryLocal, expectedFreshnessFingerprint: undefined }],
    ['a non-digest fingerprint', { ...retryLocal, expectedFreshnessFingerprint: 'recheck:abc' }],
    ['a malformed evidence id', { ...retryLocal, localRunEvidenceId: 'not-a-uuid' }],
    ['an extra key', { ...retryLocal, capabilities: ['filesystem.project.read'] }],
    ['a caller-supplied authority field', { ...retryLocal, grantMode: 'always_allow' }],
  ])('refuses %s with zero mutation', async (_label, body) => {
    const response = await post(body)
    expect(response.status).toBe(400)
    expect(mutateProjectFilesystemGrant).not.toHaveBeenCalled()
    expect(lpush).not.toHaveBeenCalled()
  })

  it('refuses a stale fingerprint with zero mutation', async () => {
    readS5AuthoritativeTaskState.mockResolvedValue(state({ freshnessFingerprint: `sha256:${'d'.repeat(64)}` }))
    const response = await post(retryLocal)
    expect(response.status).toBe(409)
    expect((await response.json()).code).toBe('stale_state')
    expect(mutateProjectFilesystemGrant).not.toHaveBeenCalled()
  })

  it('refuses an action the persisted marker does not currently offer', async () => {
    const response = await post({ ...retryLocal, action: 'decline_local_retry' })
    expect(response.status).toBe(409)
    expect((await response.json()).code).toBe('stale_action')
    expect(mutateProjectFilesystemGrant).not.toHaveBeenCalled()
  })

  it('refuses evidence substituted from another marker', async () => {
    const response = await post({ ...retryLocal, localRunEvidenceId: AUDIT_ID })
    expect(response.status).toBe(409)
    expect((await response.json()).code).toBe('stale_action')
  })

  it('refuses a marker whose fingerprint has moved on', async () => {
    const response = await post({ ...retryLocal, evidenceFingerprint: `sha256:${'e'.repeat(64)}` })
    expect(response.status).toBe(409)
    expect((await response.json()).code).toBe('stale_action')
  })

  it('refuses an invalidated marker', async () => {
    readS5AuthoritativeTaskState.mockResolvedValue(state({
      recoveryMarkers: [{
        workPackageId: PACKAGE_ID,
        kind: 'local_effect_recovery',
        state: 'invalid',
        action: null,
        evidenceId: null,
        evidenceFingerprint: null,
      }],
    }))
    const response = await post(retryLocal)
    expect(response.status).toBe(409)
  })

  it('reports an authorized recovery step whose protected transition is unreleased, without mutating', async () => {
    const response = await post(retryLocal)
    expect(response.status).toBe(503)
    expect((await response.json()).code).toBe('recovery_transition_unreleased')
    expect(mutateProjectFilesystemGrant).not.toHaveBeenCalled()
    expect(lpush).not.toHaveBeenCalled()
  })

  it('honours the closed ingress gate before doing anything else', async () => {
    const { NextResponse } = await import('next/server')
    guardEpic172ProjectManagementIngress.mockResolvedValue(NextResponse.json({ error: 'closed' }, { status: 503 }))
    const response = await post(retryLocal)
    expect(response.status).toBe(503)
    expect(readS5AuthoritativeTaskState).not.toHaveBeenCalled()
  })

  describe('project filesystem approval', () => {
    const approve = {
      schemaVersion: 1,
      action: 'approve_project_filesystem_context',
      expectedFreshnessFingerprint: FINGERPRINT,
      projectId: PROJECT_ID,
      expectedProjectDecisionId: null,
      expectedProjectDecisionRevision: null,
    }

    beforeEach(() => {
      lpush.mockResolvedValue(1)
      select.mockReturnValue({
        from: () => ({ where: () => ({ limit: async () => [{ id: PROJECT_ID }] }) }),
      })
      filesystemGrantHealthError.mockReturnValue(null)
      getProjectMcpOverview.mockResolvedValue({ statuses: [] })
      mutateProjectFilesystemGrant.mockResolvedValue({ authority: {}, grant: null, mcpConfig: {}, recoveredTaskIds: [TASK_ID] })
    })

    it('applies the canonical mutation and enqueues only after it commits', async () => {
      const response = await post(approve)
      expect(response.status).toBe(200)
      expect(mutateProjectFilesystemGrant).toHaveBeenCalledTimes(1)
      const order = mutateProjectFilesystemGrant.mock.invocationCallOrder[0]
      expect(lpush.mock.invocationCallOrder[0]).toBeGreaterThan(order)
    })

    it('never accepts caller-supplied capabilities', async () => {
      await post(approve)
      expect(mutateProjectFilesystemGrant).toHaveBeenCalledWith(expect.objectContaining({
        actorId: 'owner',
        capabilities: ['filesystem.project.read', 'filesystem.project.list', 'filesystem.project.search'],
        projectId: PROJECT_ID,
      }))
    })

    it('refuses when the operator acted on "no decision" but one now exists', async () => {
      readS5AuthoritativeTaskState.mockResolvedValue(state({
        projectGrant: { enabled: true, capabilities: [], grantDecisionRevision: '4', rootBindingRevision: '1', decisionFingerprint: FINGERPRINT, decisionGeneration: '2', decidedAt: '', decidedBy: '' },
      }))
      const response = await post(approve)
      expect(response.status).toBe(409)
      expect(mutateProjectFilesystemGrant).not.toHaveBeenCalled()
    })

    it('refuses when the current decision revision moved on', async () => {
      readS5AuthoritativeTaskState.mockResolvedValue(state({
        projectGrant: { enabled: true, capabilities: [], grantDecisionRevision: '9', rootBindingRevision: '1', decisionFingerprint: FINGERPRINT, decisionGeneration: '2', decidedAt: '', decidedBy: '' },
      }))
      const response = await post({
        ...approve,
        expectedProjectDecisionId: EVIDENCE_ID,
        expectedProjectDecisionRevision: '4',
      })
      expect(response.status).toBe(409)
      expect(mutateProjectFilesystemGrant).not.toHaveBeenCalled()
    })

    it('refuses a project that is not this task project', async () => {
      const response = await post({ ...approve, projectId: AUDIT_ID })
      expect(response.status).toBe(409)
      expect(mutateProjectFilesystemGrant).not.toHaveBeenCalled()
    })

    it('refuses a half-supplied decision pair', async () => {
      const response = await post({ ...approve, expectedProjectDecisionId: EVIDENCE_ID })
      expect(response.status).toBe(400)
    })

    it('refuses when the filesystem MCP is unhealthy', async () => {
      filesystemGrantHealthError.mockReturnValue('The filesystem MCP is unavailable.')
      const response = await post(approve)
      expect(response.status).toBe(409)
      expect(mutateProjectFilesystemGrant).not.toHaveBeenCalled()
    })

    it('keeps a committed mutation committed when the wake-up cannot be queued', async () => {
      lpush.mockRejectedValue(new Error('redis down'))
      const response = await post(approve)
      expect(response.status).toBe(202)
      expect(mutateProjectFilesystemGrant).toHaveBeenCalledTimes(1)
      expect((await response.json()).failedTaskIds).toEqual([TASK_ID])
    })

    it('is not replayable once the state it named has changed', async () => {
      const first = await post(approve)
      expect(first.status).toBe(200)
      readS5AuthoritativeTaskState.mockResolvedValue(state({ freshnessFingerprint: `sha256:${'f'.repeat(64)}` }))
      const replay = await post(approve)
      expect(replay.status).toBe(409)
      expect(mutateProjectFilesystemGrant).toHaveBeenCalledTimes(1)
    })
  })
})
