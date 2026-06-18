/**
 * Suite 3 — REST endpoint contracts
 *
 * Tests HTTP contract behaviours by importing route handlers directly and
 * constructing Request objects manually (no live network or DB).
 *
 * Mocks:
 *  - @/lib/session  — getSession returns null or a fake session
 *  - @/db           — mock db object
 *  - @/lib/redis    — mock redis object
 *  - @/lib/providers/registry — listActiveProviders
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Module-level mocks
// ---------------------------------------------------------------------------

// Session mock
const mockGetSession = vi.fn()
vi.mock('@/lib/session', () => ({
  getSession: mockGetSession,
  createSession: vi.fn(),
  destroySession: vi.fn(),
  sessionCookieOptions: vi.fn().mockReturnValue({
    name: 'forge_session',
    httpOnly: true,
    secure: false,
    sameSite: 'strict',
    maxAge: 604800,
    path: '/',
  }),
}))

// DB mock — returns fluent chain helpers per-call
const mockDbSelect = vi.fn()
const mockDbInsert = vi.fn()
const mockDbUpdate = vi.fn()

vi.mock('@/db', () => ({
  db: {
    select: mockDbSelect,
    insert: mockDbInsert,
    update: mockDbUpdate,
  },
}))

// Redis mock
const mockRedisLpush = vi.fn()
const mockRedisZadd = vi.fn()
const mockRedisExpire = vi.fn()
const mockRedisPublish = vi.fn()

vi.mock('@/lib/redis', () => ({
  redis: {
    lpush: mockRedisLpush,
    zadd: mockRedisZadd,
    expire: mockRedisExpire,
    publish: mockRedisPublish,
  },
}))

// Provider registry mock
vi.mock('@/lib/providers/registry', () => ({
  listActiveProviders: vi.fn().mockResolvedValue([]),
  getProvider: vi.fn().mockResolvedValue(null),
  getModel: vi.fn().mockResolvedValue(null),
}))

// ---------------------------------------------------------------------------
// Drizzle chain factory
// ---------------------------------------------------------------------------

function chain(resolveValue: unknown) {
  const thenable: Record<string, unknown> = {
    then: (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
      Promise.resolve(resolveValue).then(onFulfilled, onRejected),
    catch: (onRejected: (e: unknown) => unknown) =>
      Promise.resolve(resolveValue).catch(onRejected),
  }
  const methods = ['from', 'where', 'limit', 'orderBy', 'values', 'returning', 'set', 'offset', 'innerJoin']
  methods.forEach((m) => { thenable[m] = () => thenable })
  return thenable
}

// ---------------------------------------------------------------------------
// Fake sessions
// ---------------------------------------------------------------------------

const FAKE_SESSION = { sessionId: 'sess-123', userId: 'user-abc' }

function authRequest(path: string, init: RequestInit = {}) {
  return new Request(`http://localhost${path}`, init)
}

function nextAuthRequest(path: string, init: RequestInit = {}) {
  return Object.assign(authRequest(path, init), {
    nextUrl: new URL(`http://localhost${path}`),
  })
}

// ---------------------------------------------------------------------------
// Suite 3.1 — Auth guard: GET /api/projects returns 401 when not authenticated
// ---------------------------------------------------------------------------

describe('GET /api/projects — auth guard', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('returns 401 when getSession returns null', async () => {
    mockGetSession.mockResolvedValue(null)

    const { GET } = await import('@/app/api/projects/route')
    const res = await GET(authRequest('/api/projects') as never)

    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error).toBe('Unauthorized')
  })
})

// ---------------------------------------------------------------------------
// Suite 3.2 — 404: GET /api/projects/:id when project does not exist
// ---------------------------------------------------------------------------

describe('GET /api/projects/:id — 404 when project not found', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('returns 404 when the project does not exist', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    mockDbSelect.mockReturnValue(chain([]))  // empty result = not found

    const { GET } = await import('@/app/api/projects/[id]/route')
    const req = authRequest('/api/projects/nonexistent-id')
    const params = Promise.resolve({ id: 'nonexistent-id' })

    const res = await GET(req as never, { params })

    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error).toMatch(/not found/i)
  })
})

// ---------------------------------------------------------------------------
// Suite 3.3 — Task status guard: DELETE /api/tasks/:id returns 409 when status is 'running'
// ---------------------------------------------------------------------------

describe('DELETE /api/tasks/:id — 409 when status is running', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('returns 409 when task status is running', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    const runningTask = {
      id: 'task-1',
      status: 'running',
      projectId: 'proj-1',
      title: 'Test',
      prompt: 'Do something',
      submittedBy: 'user-abc',
      pmProviderConfigId: null,
      githubBranch: null,
      githubPrUrl: null,
      errorMessage: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      completedAt: null,
    }
    mockDbSelect.mockReturnValue(chain([runningTask]))

    const { DELETE } = await import('@/app/api/tasks/[id]/route')
    const req = authRequest('/api/tasks/task-1', { method: 'DELETE' })
    const params = Promise.resolve({ id: 'task-1' })

    const res = await DELETE(req as never, { params })

    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error).toMatch(/running/i)
  })
})

// ---------------------------------------------------------------------------
// Suite 3.4 — Task status guard: POST /api/tasks/:id/approve returns 409 when status is 'pending'
// ---------------------------------------------------------------------------

describe('POST /api/tasks/:id/approve — 409 when status is pending', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('returns 409 when task status is pending', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    const pendingTask = {
      id: 'task-2',
      status: 'pending',
    }
    mockDbSelect.mockReturnValue(chain([pendingTask]))

    const { POST } = await import('@/app/api/tasks/[id]/approve/route')
    const req = authRequest('/api/tasks/task-2/approve', { method: 'POST' })
    const params = Promise.resolve({ id: 'task-2' })

    const res = await POST(req as never, { params })

    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error).toMatch(/awaiting_approval/i)
  })
})

// ---------------------------------------------------------------------------
// Suite 3.5 — Agent type sanitisation: PUT /api/agents/../../etc/passwd returns 400
//
// BUG FOUND: The route handler at app/api/agents/[type]/route.ts validates the
// agent type against a strict allowlist (VALID_AGENT_TYPES). A path segment
// like "../../etc/passwd" is URL-decoded to "../../etc/passwd" before being
// passed as `type`. Since it is not in the allowlist, the handler returns 400.
// This means the path traversal is blocked by the allowlist check, NOT by an
// explicit path normalisation step — which is the correct outcome but for a
// slightly different reason. The test documents that the endpoint returns 400.
// ---------------------------------------------------------------------------

describe('PUT /api/agents/[type] — path traversal blocked', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('returns 400 for a non-allowlisted agent type (path traversal attempt)', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)

    const { PUT } = await import('@/app/api/agents/[type]/route')
    const req = authRequest('/api/agents/../../etc/passwd', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ systemPrompt: 'injected' }),
    })
    // Simulate Next.js passing the raw decoded segment as params.type
    const params = Promise.resolve({ type: '../../etc/passwd' })

    const res = await PUT(req as never, { params })

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/invalid agent type/i)
  })
})

// ---------------------------------------------------------------------------
// Suite 3.6 — Provider validation: POST /api/providers with providerType='ollama'
//              and no baseUrl returns 400
// ---------------------------------------------------------------------------

describe('POST /api/providers — baseUrl required for ollama', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('returns 400 when providerType is ollama and baseUrl is missing', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)

    const { POST } = await import('@/app/api/providers/route')
    const req = authRequest('/api/providers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        displayName: 'Local Ollama',
        providerType: 'ollama',
        modelId: 'llama3',
        isLocal: true,
        // no baseUrl
      }),
    })

    const res = await POST(req as never)

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/baseUrl/i)
  })
})

// ---------------------------------------------------------------------------
// Suite 3.7 — Task creation enqueues to Redis: POST /api/tasks calls redis.lpush
// ---------------------------------------------------------------------------

describe('POST /api/tasks — enqueues to Redis', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('calls redis.lpush("forge:tasks", ...) when task is created', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)

    const createdTask = {
      id: 'task-new',
      projectId: 'proj-uuid-1234-5678-9012-3456789012',
      title: 'My task',
      prompt: 'Do a thing',
      status: 'pending',
      submittedBy: 'user-abc',
      pmProviderConfigId: null,
      githubBranch: null,
      githubPrUrl: null,
      errorMessage: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      completedAt: null,
    }
    mockDbInsert.mockReturnValue(chain([createdTask]))
    mockRedisLpush.mockResolvedValue(1)

    const { POST } = await import('@/app/api/tasks/route')
    const req = authRequest('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
        title: 'My task',
        prompt: 'Do a thing',
      }),
    })

    const res = await POST(req as never)

    expect(res.status).toBe(201)
    expect(mockRedisLpush).toHaveBeenCalledOnce()
    const [queueKey, payload] = mockRedisLpush.mock.calls[0]
    expect(queueKey).toBe('forge:tasks')
    const parsed = JSON.parse(payload as string)
    expect(parsed).toHaveProperty('taskId', 'task-new')
  })
})

// ---------------------------------------------------------------------------
// Suite 3.8 — Task listing includes the project name from the joined project
// ---------------------------------------------------------------------------

describe('GET /api/tasks — includes project name', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('returns task rows with projectName', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)

    const listedTask = {
      id: 'task-listed',
      projectId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
      projectName: 'Forge Web',
      title: 'Listed task',
      prompt: 'Do a listed thing',
      status: 'pending',
      submittedBy: 'user-abc',
      pmProviderConfigId: null,
      githubBranch: null,
      githubPrUrl: null,
      errorMessage: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      completedAt: null,
    }

    mockDbSelect
      .mockReturnValueOnce(chain([listedTask]))
      .mockReturnValueOnce(chain([{ total: 1 }]))

    const { GET } = await import('@/app/api/tasks/route')
    const res = await GET(nextAuthRequest('/api/tasks') as never)

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.tasks).toHaveLength(1)
    expect(body.tasks[0]).toMatchObject({
      id: 'task-listed',
      projectId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
      projectName: 'Forge Web',
    })
    expect(body.total).toBe(1)
  })
})
