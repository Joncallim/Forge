import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({ default: {} }))

const readAuthorizedS5State = vi.fn()

class MockAuthorizationError extends Error {
  constructor(readonly status: 401 | 404) {
    super(status === 401 ? 'Unauthorized' : 'Task not found')
  }
}

vi.mock('@/lib/mcps/s5-route', () => ({
  readAuthorizedS5State,
  S5RouteAuthorizationError: MockAuthorizationError,
}))

const state = {
  computedAt: '2026-07-18T00:00:00.000Z',
  taskId: '00000000-0000-4000-8000-000000000001',
  projectId: '00000000-0000-4000-8000-000000000002',
  taskStatus: 'approved',
  freshnessFingerprint: `sha256:${'a'.repeat(64)}`,
  packages: [],
  projectGrant: null,
  recoveryMarkers: [],
  terminalPackages: [],
  evidenceRecords: [{
    id: '00000000-0000-4000-8000-000000000003',
    workPackageId: '00000000-0000-4000-8000-000000000004',
    agentRunId: '00000000-0000-4000-8000-000000000005',
    state: 'terminal',
    leaseExpiresAt: '2026-07-18T00:00:00.000Z',
    terminalAt: '2026-07-18T00:00:00.000Z',
  }],
}

const routes = [
  ['admission', () => import('@/app/api/mcps/admission/[taskId]/route')],
  ['freshness', () => import('@/app/api/mcps/freshness/[taskId]/route')],
  ['grant-state', () => import('@/app/api/mcps/grant-state/[taskId]/route')],
  ['local-evidence', () => import('@/app/api/mcps/local-evidence/[taskId]/route')],
  ['presentation', () => import('@/app/api/mcps/presentation/[taskId]/route')],
  ['recovery-state', () => import('@/app/api/mcps/recovery-state/[taskId]/route')],
  ['terminal-state', () => import('@/app/api/mcps/terminal-state/[taskId]/route')],
] as const

describe.each(routes)('S5 %s GET route', (_name, loadRoute) => {
  beforeEach(() => {
    vi.clearAllMocks()
    readAuthorizedS5State.mockResolvedValue({ state, userId: 'owner' })
  })

  it('rejects an unauthenticated request', async () => {
    readAuthorizedS5State.mockRejectedValue(new MockAuthorizationError(401))
    const { GET } = await loadRoute()
    const { NextRequest } = await import('next/server')
    const response = await GET(new NextRequest('http://forge.test'), { params: Promise.resolve({ taskId: state.taskId }) })
    expect(response.status).toBe(401)
  })

  it('does not disclose a non-owner task', async () => {
    readAuthorizedS5State.mockRejectedValue(new MockAuthorizationError(404))
    const { GET } = await loadRoute()
    const { NextRequest } = await import('next/server')
    const response = await GET(new NextRequest('http://forge.test'), { params: Promise.resolve({ taskId: state.taskId }) })
    expect(response.status).toBe(404)
  })

  it('returns the one task-bound authoritative freshness identity', async () => {
    const { GET } = await loadRoute()
    const { NextRequest } = await import('next/server')
    const response = await GET(new NextRequest('http://forge.test'), { params: Promise.resolve({ taskId: state.taskId }) })
    expect(response.status).toBe(200)
    expect(JSON.stringify(await response.json())).toContain(state.freshnessFingerprint)
    expect(readAuthorizedS5State).toHaveBeenCalledWith(expect.anything(), state.taskId)
  })
})

describe('S5 safe local evidence serialization', () => {
  it('never serializes the S4 claim token', async () => {
    const { GET } = await import('@/app/api/mcps/local-evidence/[taskId]/route')
    const { NextRequest } = await import('next/server')
    const response = await GET(new NextRequest('http://forge.test'), { params: Promise.resolve({ taskId: state.taskId }) })
    const body = await response.json()
    expect(body.evidenceRecords).toEqual(state.evidenceRecords)
    expect(JSON.stringify(body)).not.toContain('claimToken')
  })
})
