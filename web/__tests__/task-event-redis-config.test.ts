import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const names = [
  'REDIS_URL',
  'FORGE_TASK_EVENT_PUBLISHER_REDIS_URL',
  'FORGE_TASK_EVENT_SUBSCRIBER_REDIS_URL',
] as const
const original = Object.fromEntries(names.map((name) => [name, process.env[name]]))

describe('task-event Redis credential boundary', () => {
  beforeEach(() => {
    for (const name of names) delete process.env[name]
  })

  afterEach(() => {
    for (const name of names) {
      const value = original[name]
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })

  it('keeps the shared URL only for legacy compatibility', async () => {
    process.env.REDIS_URL = 'redis://legacy@localhost/0'
    const { taskEventRedisConfiguration } = await import('@/lib/task-event-redis')
    expect(taskEventRedisConfiguration('legacy')).toEqual({
      dedicated: false,
      publisherUrl: 'redis://legacy@localhost/0',
      subscriberUrl: 'redis://legacy@localhost/0',
    })
  })

  it('requires an explicit authoritative runtime mode', async () => {
    const { taskEventRedisConfiguration } = await import('@/lib/task-event-redis')
    expect(() => taskEventRedisConfiguration(undefined as never)).toThrow(/runtime mode is unavailable/i)
  })

  it('selects distinct protected publisher and subscriber credentials without consulting REDIS_URL', async () => {
    process.env.REDIS_URL = 'redis://legacy@localhost/0'
    process.env.FORGE_TASK_EVENT_PUBLISHER_REDIS_URL = 'redis://event-publisher:publisher-password@localhost/0'
    process.env.FORGE_TASK_EVENT_SUBSCRIBER_REDIS_URL = 'redis://event-subscriber:subscriber-password@localhost/0'
    const { taskEventRedisConfiguration } = await import('@/lib/task-event-redis')
    expect(taskEventRedisConfiguration('legacy')).toEqual({
      dedicated: true,
      publisherUrl: 'redis://event-publisher:publisher-password@localhost/0',
      subscriberUrl: 'redis://event-subscriber:subscriber-password@localhost/0',
    })
  })

  it('fails closed for partial credentials and protected shared fallback', async () => {
    const { taskEventRedisConfiguration } = await import('@/lib/task-event-redis')
    process.env.FORGE_TASK_EVENT_PUBLISHER_REDIS_URL = 'redis://event:publisher-password@localhost/0'
    expect(() => taskEventRedisConfiguration('legacy')).toThrow(/partially configured/i)
    expect(() => taskEventRedisConfiguration('protected')).toThrow(/partially configured/i)

    delete process.env.FORGE_TASK_EVENT_PUBLISHER_REDIS_URL
    expect(() => taskEventRedisConfiguration('protected')).toThrow(/requires dedicated/i)
  })

  it('requires authenticated redis URLs for protected dedicated traffic', async () => {
    const { taskEventRedisConfiguration } = await import('@/lib/task-event-redis')
    const invalidPairs = [
      ['http://event-publisher:publisher-password@localhost/0', 'redis://event-subscriber:subscriber-password@localhost/0'],
      ['redis://event-publisher@localhost/0', 'redis://event-subscriber:subscriber-password@localhost/0'],
      ['redis://:publisher-password@localhost/0', 'redis://event-subscriber:subscriber-password@localhost/0'],
    ]
    for (const [publisherUrl, subscriberUrl] of invalidPairs) {
      process.env.FORGE_TASK_EVENT_PUBLISHER_REDIS_URL = publisherUrl
      process.env.FORGE_TASK_EVENT_SUBSCRIBER_REDIS_URL = subscriberUrl
      expect(() => taskEventRedisConfiguration('protected')).toThrow(/authenticated redis/i)
    }
  })

  it('rejects equivalent Redis ACL principals even when credentials or database differ', async () => {
    process.env.FORGE_TASK_EVENT_PUBLISHER_REDIS_URL = 'rediss://%65vent:publisher-password@Redis.Example.test./0'
    process.env.FORGE_TASK_EVENT_SUBSCRIBER_REDIS_URL = 'redis://event:subscriber-password@redis.example.test:6379/15'
    const { taskEventRedisConfiguration } = await import('@/lib/task-event-redis')
    expect(() => taskEventRedisConfiguration('protected')).toThrow(/distinct ACL principals/i)
  })

  it('allows different ACL usernames on one normalized endpoint', async () => {
    process.env.FORGE_TASK_EVENT_PUBLISHER_REDIS_URL = 'redis://event-publisher:publisher-password@redis.example.test./0'
    process.env.FORGE_TASK_EVENT_SUBSCRIBER_REDIS_URL = 'rediss://event-subscriber:subscriber-password@REDIS.EXAMPLE.TEST:6379/15'
    const { taskEventRedisConfiguration } = await import('@/lib/task-event-redis')
    expect(taskEventRedisConfiguration('protected').dedicated).toBe(true)
  })

  it('allows distinct endpoints with the same ACL username', async () => {
    process.env.FORGE_TASK_EVENT_PUBLISHER_REDIS_URL = 'redis://events:publisher-password@publisher.example.test/0'
    process.env.FORGE_TASK_EVENT_SUBSCRIBER_REDIS_URL = 'redis://events:subscriber-password@subscriber.example.test/0'
    const { taskEventRedisConfiguration } = await import('@/lib/task-event-redis')
    expect(taskEventRedisConfiguration('protected').dedicated).toBe(true)
  })

  it('uses v2-only live and durable names even while shared legacy compatibility is configured', async () => {
    process.env.REDIS_URL = 'redis://legacy@localhost/0'
    const {
      TASK_EVENT_V2_LIVE_PATTERN,
      taskEventRedisKeys,
      taskIdFromTaskEventLiveChannel,
    } = await import('@/lib/task-event-redis')

    expect(taskEventRedisKeys('task-1')).toEqual({
      history: 'forge:task-events:v2:task-1:history',
      live: 'forge:task-events:v2:task-1:live',
      sequence: 'forge:task-events:v2:task-1:seq',
    })
    expect(TASK_EVENT_V2_LIVE_PATTERN).toBe('forge:task-events:v2:*:live')
    expect(taskIdFromTaskEventLiveChannel('forge:task-events:v2:task-1:live')).toBe('task-1')
    expect(taskIdFromTaskEventLiveChannel('forge:task:task-1')).toBeNull()
  })
})
