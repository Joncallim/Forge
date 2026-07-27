import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  constructorUrls: [] as string[],
  sub: null as (EventEmitter & {
    disconnect: ReturnType<typeof vi.fn>
    psubscribe: ReturnType<typeof vi.fn>
  }) | null,
}))

vi.mock('ioredis', () => {
  class RedisMock {
    constructor(url: string) {
      state.constructorUrls.push(url)
      const sub = new EventEmitter() as NonNullable<typeof state.sub>
      sub.disconnect = vi.fn()
      sub.psubscribe = vi.fn().mockResolvedValue(undefined)
      state.sub = sub
      return sub
    }
  }
  return { default: RedisMock }
})

const mockGetSession = vi.fn()
const mockGetAccessibleTask = vi.fn()
vi.mock('@/lib/session', () => ({ getSession: mockGetSession }))
vi.mock('@/lib/task-access', () => ({ getAccessibleTask: mockGetAccessibleTask }))

const originalPublisher = process.env.FORGE_TASK_EVENT_PUBLISHER_REDIS_URL
const originalSubscriber = process.env.FORGE_TASK_EVENT_SUBSCRIBER_REDIS_URL

async function readUntil(stream: ReadableStream<Uint8Array>, needle: string): Promise<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let output = ''
  const deadline = Date.now() + 1000
  while (Date.now() < deadline && !output.includes(needle)) {
    const result = await Promise.race([
      reader.read(),
      new Promise<{ done: true; value: undefined }>((resolve) => setTimeout(() => resolve({ done: true, value: undefined }), 50)),
    ])
    if (result.done) continue
    output += decoder.decode(result.value, { stream: true })
  }
  await reader.cancel()
  return output
}

describe('dashboard task-event stream', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    state.constructorUrls.length = 0
    state.sub = null
    process.env.FORGE_TASK_EVENT_PUBLISHER_REDIS_URL = 'redis://event-publisher@localhost/0'
    process.env.FORGE_TASK_EVENT_SUBSCRIBER_REDIS_URL = 'redis://event-subscriber@localhost/0'
    mockGetSession.mockResolvedValue({ userId: 'user-1' })
    mockGetAccessibleTask.mockResolvedValue({ id: 'task-1' })
  })

  afterEach(() => {
    if (originalPublisher === undefined) delete process.env.FORGE_TASK_EVENT_PUBLISHER_REDIS_URL
    else process.env.FORGE_TASK_EVENT_PUBLISHER_REDIS_URL = originalPublisher
    if (originalSubscriber === undefined) delete process.env.FORGE_TASK_EVENT_SUBSCRIBER_REDIS_URL
    else process.env.FORGE_TASK_EVENT_SUBSCRIBER_REDIS_URL = originalSubscriber
  })

  it('uses the read-only subscriber credential and accepts only durable v2 envelopes', async () => {
    const { GET } = await import('@/app/api/tasks/events/route')
    const response = await GET(new Request('http://localhost/api/tasks/events') as never)

    setTimeout(() => {
      state.sub?.emit('pmessage', 'forge:task:*', 'forge:task:task-1', JSON.stringify({
        type: 'task:status', status: 'failed',
      }))
      state.sub?.emit('pmessage', 'forge:task:*', 'forge:task:task-1', JSON.stringify({
        schemaVersion: 2,
        id: 9,
        type: 'task:status',
        data: { status: 'running', updatedAt: '2026-07-22T00:00:00.000Z' },
      }))
    }, 50)

    const output = await readUntil(response.body!, '"status":"running"')
    expect(state.constructorUrls).toEqual(['redis://event-subscriber@localhost/0'])
    expect(state.sub?.psubscribe).toHaveBeenCalledWith('forge:task:*')
    expect(output).toContain('event: task:status')
    expect(output).toContain('"taskId":"task-1"')
    expect(output).not.toContain('"status":"failed"')
  })
})
