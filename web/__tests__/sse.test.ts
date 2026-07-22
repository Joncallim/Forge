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
  historyGet: vi.fn().mockResolvedValue('0'),
  historyRange: vi.fn().mockResolvedValue([]),
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
    get: state.historyGet,
    zrangebyscore: state.historyRange,
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
  ;['from', 'where', 'limit', 'orderBy', 'select', 'innerJoin'].forEach((m) => { t[m] = () => t })
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

function dataPayloads(lines: string[]): Array<Record<string, unknown>> {
  return lines
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice('data: '.length)) as Record<string, unknown>)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/tasks/:id/runs — SSE stream', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    state.mockSub = null
    state.historyGet.mockResolvedValue('0')
    state.historyRange.mockResolvedValue([])
    mockGetSession.mockResolvedValue({ sessionId: 'sess-abc', userId: 'user-1' })
    let selectCount = 0
    mockDbSelect.mockImplementation(() => {
      selectCount += 1
      if (selectCount === 1) return dbChain([fakeTask()])
      if (selectCount === 2) return dbChain([{ status: fakeTask().status }])
      return dbChain([])
    })
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

  it('emits the current task status snapshot on connect', async () => {
    const { GET } = await import('@/app/api/tasks/[id]/runs/route')
    const params = Promise.resolve({ id: 'task-sse-1' })
    const res = await GET(sseRequest() as never, { params })

    const lines = await readLines(res.body!, 500)
    expect(lines).toContain('event: task:status')
    expect(lines.join('\n')).toContain('"status":"running"')
  }, 2000)

  it('includes package scope while reducing protected Architect snapshots to opaque history availability', async () => {
    let selectCount = 0
    mockDbSelect.mockImplementation(() => {
      selectCount += 1
      if (selectCount === 1) return dbChain([fakeTask()])
      if (selectCount === 2) return dbChain([{ status: fakeTask().status }])
      if (selectCount === 3) {
        return dbChain([
          {
            id: 'run-package',
            taskId: 'task-sse-1',
            workPackageId: 'package-1',
            agentType: 'handoff',
            modelIdUsed: 'forge-handoff/no-op',
            status: 'completed',
            inputTokens: null,
            outputTokens: null,
            costUsd: null,
            startedAt: new Date('2026-06-25T00:00:00.000Z'),
            completedAt: new Date('2026-06-25T00:00:01.000Z'),
            errorMessage: null,
            createdAt: new Date('2026-06-25T00:00:00.000Z'),
          },
          {
            id: 'run-task',
            taskId: 'task-sse-1',
            workPackageId: null,
            agentType: 'architect',
            modelIdUsed: 'openrouter/architect',
            status: 'completed',
            inputTokens: null,
            outputTokens: null,
            costUsd: null,
            startedAt: new Date('2026-06-25T00:00:02.000Z'),
            completedAt: new Date('2026-06-25T00:00:03.000Z'),
            errorMessage: null,
            createdAt: new Date('2026-06-25T00:00:02.000Z'),
          },
        ])
      }
      if (selectCount === 4) {
        return dbChain([
          {
            id: 'artifact-package',
            agentRunId: 'run-package',
            artifactType: 'log_output',
            content: 'Package handoff summary.',
            metadata: {},
            createdAt: new Date('2026-06-25T00:00:01.000Z'),
          },
          {
            id: 'artifact-task',
            agentRunId: 'run-task',
            artifactType: 'adr_text',
            content: 'Architect plan available in protected history',
            metadata: {
              historyAvailable: true,
              planVersion: '7',
              entryCount: 3,
              system_prompt: 'RAW-SYSTEM-PROMPT-SENTINEL',
              apiKey: 'RAW-API-KEY-SENTINEL',
            },
            createdAt: new Date('2026-06-25T00:00:03.000Z'),
          },
        ])
      }
      return dbChain([])
    })

    const { GET } = await import('@/app/api/tasks/[id]/runs/route')
    const params = Promise.resolve({ id: 'task-sse-1' })
    const res = await GET(sseRequest() as never, { params })

    const lines = await readLines(res.body!, 500)
    const payloads = dataPayloads(lines)
    const artifactPayloads = payloads.filter((payload) => payload.artifactType)
    expect(artifactPayloads).toContainEqual(expect.objectContaining({
      id: 'artifact-package',
      workPackageId: 'package-1',
    }))
    expect(payloads).toContainEqual({
      agentRunId: 'run-task',
      historyAvailable: true,
    })
    expect(payloads.find((payload) => payload.historyAvailable === true)).not.toHaveProperty('workPackageId')
    expect(payloads.find((payload) => payload.historyAvailable === true)).not.toHaveProperty('planVersion')
    expect(payloads.find((payload) => payload.historyAvailable === true)).not.toHaveProperty('entryCount')
    expect(artifactPayloads.every((payload) => !Object.hasOwn(payload, 'content'))).toBe(true)
    expect(lines.join('\n')).not.toContain('planVersion')
    expect(lines.join('\n')).not.toContain('entryCount')
    expect(lines.join('\n')).not.toContain('RAW-SYSTEM-PROMPT-SENTINEL')
    expect(lines.join('\n')).not.toContain('RAW-API-KEY-SENTINEL')
  }, 2000)

  it('keeps run chunks sanitized and live-only instead of storing an invalid empty history event', async () => {
    const { GET } = await import('@/app/api/tasks/[id]/runs/route')
    const params = Promise.resolve({ id: 'task-sse-1' })
    const res = await GET(sseRequest() as never, { params })

    setTimeout(() => {
      state.mockSub?.emit(
        'message',
        'forge:task:task-sse-1',
        JSON.stringify({
          schemaVersion: 2,
          id: null,
          type: 'run:chunk',
          data: {
            type: 'run:chunk',
            delta: 'RAW-DELTA-SENTINEL',
            metadata: {
              promptOverlay: 'RAW-OVERLAY-SENTINEL',
              api_key: 'RAW-KEY-SENTINEL',
              status: 'streaming',
            },
          },
        }),
      )
    }, 100)

    const lines = await readLines(res.body!, 500)
    const payload = dataPayloads(lines).find((candidate) => candidate.type === 'run:chunk')
    expect(payload).toMatchObject({ type: 'run:chunk', metadata: { status: 'streaming' } })
    expect(payload).not.toHaveProperty('delta')
    expect(JSON.stringify(payload)).not.toContain('RAW-')
    const { redis } = await import('@/lib/redis')
    expect(redis.incr).not.toHaveBeenCalled()
    expect(redis.zadd).not.toHaveBeenCalled()
  }, 2000)

  it('keeps question answers live-only instead of storing prompt-bearing history', async () => {
    const { GET } = await import('@/app/api/tasks/[id]/runs/route')
    const params = Promise.resolve({ id: 'task-sse-1' })
    const res = await GET(sseRequest() as never, { params })

    setTimeout(() => {
      state.mockSub?.emit(
        'message',
        'forge:task:task-sse-1',
        JSON.stringify({
          schemaVersion: 2,
          id: null,
          type: 'questions:answered',
          data: {
            type: 'questions:answered',
            questions: [{ id: 'question-1', answer: 'operator answer' }],
          },
        }),
      )
    }, 100)

    const lines = await readLines(res.body!, 500)
    expect(lines).toContain('event: questions:answered')
    const { redis } = await import('@/lib/redis')
    expect(redis.incr).not.toHaveBeenCalled()
    expect(redis.zadd).not.toHaveBeenCalled()
  }, 2000)

  it('emits event: run:started within 500ms when a run:started message is published', async () => {
    const { GET } = await import('@/app/api/tasks/[id]/runs/route')
    const params = Promise.resolve({ id: 'task-sse-1' })
    const res = await GET(sseRequest() as never, { params })

    // Give the stream a tick to subscribe, then publish the event
    setTimeout(() => {
      state.mockSub?.emit(
        'message',
        'forge:task:task-sse-1',
        JSON.stringify({ schemaVersion: 2, id: 1, type: 'run:started', data: { type: 'run:started' } }),
      )
    }, 100)

    const lines = await readLines(res.body!, 500)
    const eventLine = lines.find((l) => l.startsWith('event: run:started'))
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
        JSON.stringify({
          schemaVersion: 2,
          id: 1,
          type: 'task:status',
          data: { type: 'task:status', status: 'completed' },
        }),
      )
    }, 100)

    const lines = await readLines(res.body!, 1500)
    const allText = lines.join('\n')
    expect(allText).toContain('[DONE]')
  }, 3000)

  it('fills a live producer-ID gap from durable history before delivering the new event', async () => {
    state.historyGet.mockResolvedValue('1')
    state.historyRange.mockResolvedValue([
      JSON.stringify({
        schemaVersion: 2,
        id: 2,
        type: 'run:started',
        data: { type: 'run:started', runId: 'run-2' },
      }),
      '2',
    ])
    const { GET } = await import('@/app/api/tasks/[id]/runs/route')
    const res = await GET(sseRequest() as never, { params: Promise.resolve({ id: 'task-sse-1' }) })

    setTimeout(() => {
      state.mockSub?.emit('message', 'forge:task:task-sse-1', JSON.stringify({
        schemaVersion: 2,
        id: 3,
        type: 'run:completed',
        data: { type: 'run:completed', runId: 'run-2' },
      }))
    }, 100)

    const lines = await readLines(res.body!, 500)
    expect(lines).toContain('id: 2')
    expect(lines).toContain('id: 3')
    expect(lines.indexOf('id: 2')).toBeLessThan(lines.indexOf('id: 3'))
  }, 2000)

  it('signals a reset when reconnect history has been trimmed past the requested event ID', async () => {
    state.historyGet.mockResolvedValue('4')
    state.historyRange.mockResolvedValue([
      JSON.stringify({
        schemaVersion: 2,
        id: 3,
        type: 'run:started',
        data: { type: 'run:started', runId: 'run-3' },
      }),
      '3',
      JSON.stringify({
        schemaVersion: 2,
        id: 4,
        type: 'run:completed',
        data: { type: 'run:completed', runId: 'run-3' },
      }),
      '4',
    ])
    const request = new Request('http://localhost/api/tasks/task-sse-1/runs', {
      headers: {
        cookie: 'forge_session=sess-abc',
        'last-event-id': '1',
      },
    })
    const { GET } = await import('@/app/api/tasks/[id]/runs/route')
    const res = await GET(request as never, { params: Promise.resolve({ id: 'task-sse-1' }) })

    const lines = await readLines(res.body!, 500)
    expect(lines).toContain('event: stream:reset')
    expect(lines.join('\n')).toContain('"reason":"retention_gap"')
  }, 2000)

  it('drops pub/sub messages after the client stream closes without logging controller errors', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const { GET } = await import('@/app/api/tasks/[id]/runs/route')
      const params = Promise.resolve({ id: 'task-sse-1' })
      const res = await GET(sseRequest() as never, { params })

      const reader = res.body!.getReader()
      await reader.read()
      await reader.cancel()

      state.mockSub?.emit(
        'message',
        'forge:task:task-sse-1',
        JSON.stringify({
          schemaVersion: 2,
          id: null,
          type: 'run:chunk',
          data: { type: 'run:chunk', delta: 'late chunk' },
        }),
      )
      await new Promise((resolve) => setTimeout(resolve, 20))

      expect(errorSpy.mock.calls.flat().join('\n')).not.toContain('Error processing message')
      expect(errorSpy.mock.calls.flat().join('\n')).not.toContain('Controller is already closed')
    } finally {
      errorSpy.mockRestore()
    }
  }, 2000)
})
