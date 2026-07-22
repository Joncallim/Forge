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
    expect(taskEventRedisConfiguration()).toEqual({
      dedicated: false,
      publisherUrl: 'redis://legacy@localhost/0',
      subscriberUrl: 'redis://legacy@localhost/0',
    })
  })

  it('selects distinct protected publisher and subscriber credentials without consulting REDIS_URL', async () => {
    process.env.REDIS_URL = 'redis://legacy@localhost/0'
    process.env.FORGE_TASK_EVENT_PUBLISHER_REDIS_URL = 'redis://event-publisher@localhost/0'
    process.env.FORGE_TASK_EVENT_SUBSCRIBER_REDIS_URL = 'redis://event-subscriber@localhost/0'
    const { taskEventRedisConfiguration } = await import('@/lib/task-event-redis')
    expect(taskEventRedisConfiguration()).toEqual({
      dedicated: true,
      publisherUrl: 'redis://event-publisher@localhost/0',
      subscriberUrl: 'redis://event-subscriber@localhost/0',
    })
  })

  it('fails closed for partial or shared protected credentials', async () => {
    const { taskEventRedisConfiguration } = await import('@/lib/task-event-redis')
    process.env.FORGE_TASK_EVENT_PUBLISHER_REDIS_URL = 'redis://event@localhost/0'
    expect(() => taskEventRedisConfiguration()).toThrow(/partially configured/i)

    process.env.FORGE_TASK_EVENT_SUBSCRIBER_REDIS_URL = 'redis://event@localhost/0'
    expect(() => taskEventRedisConfiguration()).toThrow(/separate credentials/i)
  })
})
