/**
 * Suite 4 — SSE smoke test
 *
 * Tests the GET /api/tasks/:id/runs streaming endpoint.
 *
 * The SSE route does a dynamic `const { default: Redis } = await import('ioredis')`
 * inside the ReadableStream start() callback and calls `new Redis(url)` to create
 * a dedicated pub/sub subscriber.  We mock ioredis with a class (a real constructor)
 * that returns a controllable EventEmitter stub, and we expose that stub via the
 * module-scoped `mockSub` variable so individual tests can emit messages on it.
 *
 * vi.hoisted() is used so the mockSub reference is available before vi.mock()
 * factories run.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'
import { EventEmitter } from 'events'

// ---------------------------------------------------------------------------
// Hoisted state — shared sub stub updated each time ioredis is instantiated
// ---------------------------------------------------------------------------

const state = vi.hoisted(() => ({
  mockSub: null as (EventEmitter & {
    subscribe: ReturnType<typeof vi.fn>
    disconnect: ReturnType<typeof vi.fn>
  }) | null,
}))

// ---------------------------------------------------------------------------
// Module-level mocks
// ---------------------------------------------------------------------------

// ioredis — the route uses `new Redis(url)` inside the stream start() handler.
// We must export a real class (constructor function) so `new` works.
vi.mock('ioredis', () => {
  class RedisMock {
    constructor() {
      // Build a fresh sub stub and store it for test access
      const sub = new EventEmitter() as EventEmitter & {
        subscribe: ReturnType<typeof vi.fn>
        disconnect: ReturnType<typeof vi.fn>
      }
      sub.subscribe = vi.fn().mockResolvedValue(undefined)
      sub.disconnect = vi.fn()
      state.mockSub = sub
      return sub
    }
  }
  return { default: RedisMock }
})

// Session mock
const mockGetSession = vi.fn()
vi.mock('@/lib/session', () => ({
  getSession: mockGetSession,
  createSession: vi.fn(),
  destroySession: vi.fn(),
  sessionCookieOptions: vi.fn(),
}))

// DB mock
const mockDbSelect = vi.fn()
vi.mock('@/db', () => ({
  db: { select: mockDbSelect },
}))

// Redis singleton (used for incr/zadd/expire/zrangebyscore in the send() helper)
vi.mock('@/lib/redis', () => ({
  redis: {
    incr: vi.fn().mockResolvedValue(1),
    zadd: vi.fn().mockResolvedValue(0),
    expire: vi.fn().mockResolvedValue(1),
    zrangebyscore: vi.fn().mockResolvedValue([]),
  },
}))

// ---------------------------------------------------------------------------
// Drizzle chain factory
// ---------------------------------------------------------------------------

function dbChain(value: unknown) {
  const t: Record<string, unknown> = {
    then: (ok: (v: unknown) => unknown, err?: (e: unknown) => unknown) =>
      Promise.resolve(value).then(ok, err),
    catch: (onRejected: (e: unknown) => unknown) =>
      Promise.resolve(value).catch(onRejected),
  }
  ;['from', 'where', 'limit', 'orderBy', 'select'].forEach((m) => { t[m] = () => t })
  return t
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fakeTask() {
  return {
    id: 'task-sse-1',
    projectId: 'proj-1',
    title: 'SSE Task',
    prompt: 'Go',
    status: 'running',
    submittedBy: null,
    pmProviderConfigId: null,
    githubBranch: null,
    githubPrUrl: null,
    errorMessage: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    completedAt: null,
  }
}

function sseRequest() {
  return new Request('http://localhost/api/tasks/task-sse-1/runs', {
    headers: { cookie: 'forge_session=sess-abc' },
  })
}

/**
 * Collect lines from an SSE ReadableStream until either:
 *  - the stream closes (done=true), or
 *  - the timeoutMs wall-clock limit is reached, or
 *  - the "[DONE]" sentinel appears in the output.
 */
async function readLines(stream: ReadableStream<Uint8Array>, timeoutMs: number): Promise<string[]> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  const lines: string[] = []
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    const result = await Promise.race([
      reader.read(),
      new Promise<{ done: true; value: undefined }>((resolve) =>
        setTimeout(() => resolve({ done: true, value: undefined }), timeoutMs),
      ),
    ])
    if (result.done) break
    const text = decoder.decode(result.value, { stream: true })
    lines.push(...text.split('\n'))
    if (text.includes('[DONE]')) break
  }

  reader.releaseLock()
  return lines
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/tasks/:id/runs — SSE stream', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    state.mockSub = null
    mockGetSession.mockResolvedValue({ sessionId: 'sess-abc', userId: 'user-1' })
    mockDbSelect.mockReturnValue(dbChain([fakeTask()]))
  })

  it('returns 401 when session is missing', async () => {
    mockGetSession.mockResolvedValue(null)

    const { GET } = await import('@/app/api/tasks/[id]/runs/route')
    const params = Promise.resolve({ id: 'task-sse-1' })
    const req = new Request('http://localhost/api/tasks/task-sse-1/runs')
    const res = await GET(req as never, { params })

    expect(res.status).toBe(401)
  })

  it('returns 404 when the task does not exist', async () => {
    mockDbSelect.mockReturnValue(dbChain([]))

    const { GET } = await import('@/app/api/tasks/[id]/runs/route')
    const params = Promise.resolve({ id: 'task-sse-1' })
    const res = await GET(sseRequest() as never, { params })

    expect(res.status).toBe(404)
  })

  it('sends a retry directive as the first SSE chunk', async () => {
    const { GET } = await import('@/app/api/tasks/[id]/runs/route')
    const params = Promise.resolve({ id: 'task-sse-1' })
    const res = await GET(sseRequest() as never, { params })

    expect(res.headers.get('content-type')).toContain('text/event-stream')
    expect(res.body).toBeTruthy()

    const reader = res.body!.getReader()
    const first = await reader.read()
    reader.releaseLock()
    const text = new TextDecoder().decode(first.value)
    expect(text).toContain('retry: 5000')
  })

  it('emits event: run:started within 500ms when a run:started message is published', async () => {
    const { GET } = await import('@/app/api/tasks/[id]/runs/route')
    const params = Promise.resolve({ id: 'task-sse-1' })
    const res = await GET(sseRequest() as never, { params })

    // Give the stream a tick to subscribe, then publish the event
    setTimeout(() => {
      state.mockSub?.emit(
        'message',
        'forge:task:task-sse-1',
        JSON.stringify({ type: 'run:started' }),
      )
    }, 100)

    const lines = await readLines(res.body!, 500)
    const eventLine = lines.find((l) => l.startsWith('event:'))
    expect(eventLine).toBeDefined()
    expect(eventLine).toContain('run:started')
  }, 2000)

  it('closes the stream (emits [DONE]) after a terminal task:status completed event', async () => {
    const { GET } = await import('@/app/api/tasks/[id]/runs/route')
    const params = Promise.resolve({ id: 'task-sse-1' })
    const res = await GET(sseRequest() as never, { params })

    setTimeout(() => {
      state.mockSub?.emit(
        'message',
        'forge:task:task-sse-1',
        JSON.stringify({ type: 'task:status', status: 'completed' }),
      )
    }, 100)

    const lines = await readLines(res.body!, 500)
    const allText = lines.join('\n')
    expect(allText).toContain('[DONE]')
  }, 2000)
})
