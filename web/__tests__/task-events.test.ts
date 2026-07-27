import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockEval, mockPublish, mockPublisherRedis } = vi.hoisted(() => {
  const mockEval = vi.fn().mockResolvedValue(7)
  const mockPublish = vi.fn().mockResolvedValue(1)
  return {
    mockEval,
    mockPublish,
    mockPublisherRedis: { eval: mockEval, publish: mockPublish },
  }
})

vi.mock('@/lib/task-event-redis', () => ({
  taskEventPublisherRedis: vi.fn(() => mockPublisherRedis),
}))

describe('task-event publisher authority', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockEval.mockResolvedValue(7)
    mockPublish.mockResolvedValue(1)
  })

  it('assigns, stores, bounds, and publishes one identical durable v2 envelope atomically', async () => {
    const { publishTaskEvent } = await import('@/worker/events')
    await publishTaskEvent('task-1', 'task:status', {
      status: 'running',
      updatedAt: '2026-07-22T00:00:00.000Z',
    })

    expect(mockEval).toHaveBeenCalledOnce()
    const [script, keyCount, sequenceKey, historyKey, type, data, channel, limit] = mockEval.mock.calls[0]
    expect(script).toContain("redis.call('INCR', KEYS[1])")
    expect(script).toContain("redis.call('ZADD', KEYS[2], sequence, envelope)")
    expect(script).toContain("redis.call('ZREMRANGEBYRANK'")
    expect(script).toContain("redis.call('PUBLISH', ARGV[3], envelope)")
    expect(script).toContain('schemaVersion = 2')
    expect(keyCount).toBe(2)
    expect(sequenceKey).toBe('forge:task-events:v2:task-1:seq')
    expect(historyKey).toBe('forge:task-events:v2:task-1:history')
    expect(type).toBe('task:status')
    expect(JSON.parse(data as string)).toEqual({
      status: 'running',
      updatedAt: '2026-07-22T00:00:00.000Z',
    })
    expect(channel).toBe('forge:task:task-1')
    expect(limit).toBe('4096')
    expect(mockPublish).not.toHaveBeenCalled()
  })

  it('rejects run chunks before Redis so raw model output has no live bypass', async () => {
    const { publishTaskEvent } = await import('@/worker/events')
    await expect(publishTaskEvent('task-1', 'run:chunk', {
      delta: 'secret model output',
      metadata: { status: 'streaming' },
    })).rejects.toThrow("does not match the closed v2 schema")

    expect(mockEval).not.toHaveBeenCalled()
    expect(mockPublish).not.toHaveBeenCalled()
  })

  it('persists only a bounded content-free question-answer projection', async () => {
    const { publishTaskEvent } = await import('@/worker/events')
    await publishTaskEvent('task-1', 'questions:answered', {
      answeredCount: 2,
      allAnswered: true,
      questions: [{
        question: 'RAW-QUESTION-SENTINEL',
        suggestions: ['RAW-SUGGESTION-SENTINEL'],
        answer: 'RAW-ANSWER-SENTINEL',
      }],
    })

    expect(mockEval).toHaveBeenCalledOnce()
    const data = mockEval.mock.calls[0][5]
    expect(JSON.parse(data as string)).toEqual({ answeredCount: 2, allAnswered: true })
    expect(String(data)).not.toContain('RAW-')
    expect(mockPublish).not.toHaveBeenCalled()
  })

  it.each([
    ['unknown type', 'provider:raw', { status: 'streaming' }],
    ['malformed known type', 'task:status', { status: 'running' }],
  ])('rejects %s before any Redis call', async (_label, type, payload) => {
    const { publishTaskEvent } = await import('@/worker/events')
    await expect(publishTaskEvent('task-1', type, payload)).rejects.toThrow(/closed v2 schema/)
    expect(mockEval).not.toHaveBeenCalled()
    expect(mockPublish).not.toHaveBeenCalled()
  })

  it('fails before any separate publish when the atomic durable write fails', async () => {
    mockEval.mockRejectedValueOnce(new Error('publisher unavailable'))
    const { publishTaskEvent } = await import('@/worker/events')

    await expect(publishTaskEvent('task-1', 'task:status', {
      status: 'failed',
      updatedAt: '2026-07-22T00:00:00.000Z',
    }))
      .rejects.toThrow('publisher unavailable')
    expect(mockPublish).not.toHaveBeenCalled()
  })
})
