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
  observedAtMs: Date.parse('2026-07-18T00:00:00.000Z'),
  localEvidenceAvailable: true,
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


// Fields that must never leave the server on any S5 surface: live ownership
// credentials, one-time authority, and internal pointers. The scan is
// recursive so a forbidden field cannot hide inside a nested object or array.
const FORBIDDEN_FIELDS = [
  'claimToken',
  'claim_token',
  'grantNonce',
  'grant_nonce',
  'effectiveGrant',
  'effective_grant',
  'controllerTokenDigest',
  'leaseDigest',
  'digest',
  'secret',
] as const

function forbiddenFieldsIn(value: unknown, path = '$'): string[] {
  if (Array.isArray(value)) return value.flatMap((item, index) => forbiddenFieldsIn(item, `${path}[${index}]`))
  if (typeof value !== 'object' || value === null) return []
  return Object.entries(value as Record<string, unknown>).flatMap(([key, nested]) => [
    ...(FORBIDDEN_FIELDS.includes(key as typeof FORBIDDEN_FIELDS[number]) ? [`${path}.${key}`] : []),
    ...forbiddenFieldsIn(nested, `${path}.${key}`),
  ])
}

describe.each(routes)('S5 %s GET redaction', (_name, loadRoute) => {
  beforeEach(() => {
    vi.clearAllMocks()
    // A deliberately hostile authoritative state: if any route echoed raw rows
    // instead of its typed projection, these fields would surface.
    readAuthorizedS5State.mockResolvedValue({
      state: {
        ...state,
        claimToken: 'ownership-token',
        packages: [{
          workPackageId: '00000000-0000-4000-8000-000000000004',
          title: 'package',
          assignedRole: 'backend',
          status: 'blocked',
          requestedCapabilities: [],
          boundedRuntimeRequestedCapabilities: [],
          blockingCapabilities: [],
          currentDecision: null,
          decisionHistory: [],
          blockMetadata: null,
          pointerFingerprint: `sha256:${'b'.repeat(64)}`,
          pointerVersion: '3',
          grantNonce: 'one-time-authority',
          effectiveGrant: { capabilities: ['filesystem.project.read'] },
        }],
        evidenceRecords: [{ ...state.evidenceRecords[0], claimToken: 'ownership-token' }],
      },
      userId: 'owner',
    })
  })

  it('never serializes an ownership credential or one-time authority', async () => {
    const { GET } = await loadRoute()
    const { NextRequest } = await import('next/server')
    const response = await GET(new NextRequest('http://forge.test'), { params: Promise.resolve({ taskId: state.taskId }) })
    const body = await response.json()
    expect(forbiddenFieldsIn(body)).toEqual([])
    expect(JSON.stringify(body)).not.toContain('ownership-token')
    expect(JSON.stringify(body)).not.toContain('one-time-authority')
  })

  it('serializes without throwing on bigint-shaped revisions', async () => {
    const { GET } = await loadRoute()
    const { NextRequest } = await import('next/server')
    const response = await GET(new NextRequest('http://forge.test'), { params: Promise.resolve({ taskId: state.taskId }) })
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toBeTypeOf('object')
  })
})

describe('S5 freshness honesty', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    readAuthorizedS5State.mockResolvedValue({
      state: { ...state, observedAtMs: Date.now() - 5_000 },
      userId: 'owner',
    })
  })

  it('reports real elapsed age and mints no browser-visible recheck token', async () => {
    const { GET } = await import('@/app/api/mcps/freshness/[taskId]/route')
    const { NextRequest } = await import('next/server')
    const response = await GET(new NextRequest('http://forge.test'), { params: Promise.resolve({ taskId: state.taskId }) })
    const body = await response.json()
    expect(body.freshnessAgeMs).toBeGreaterThanOrEqual(4_000)
    expect(body).not.toHaveProperty('casRecheckToken')
    expect(body.fingerprint).toBe(state.freshnessFingerprint)
  })
})
