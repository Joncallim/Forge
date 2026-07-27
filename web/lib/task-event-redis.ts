import Redis from 'ioredis'
import { redis } from '@/lib/redis'

export type TaskEventRedisConfiguration = {
  dedicated: boolean
  publisherUrl: string
  subscriberUrl: string
}

/**
 * The only task-event Redis names used by current producers and subscribers.
 * Legacy `forge:task:*` names deliberately do not appear here: an installation
 * without dedicated credentials may share a Redis connection temporarily, but
 * it still speaks only the v2 namespace.
 */
export function taskEventRedisKeys(taskId: string): Readonly<{
  history: string
  live: string
  sequence: string
}> {
  return {
    history: `forge:task-events:v2:${taskId}:history`,
    live: `forge:task-events:v2:${taskId}:live`,
    sequence: `forge:task-events:v2:${taskId}:seq`,
  }
}

export const TASK_EVENT_V2_LIVE_PATTERN = 'forge:task-events:v2:*:live'

export function taskIdFromTaskEventLiveChannel(channel: string): string | null {
  const match = /^forge:task-events:v2:([^:]+):live$/.exec(channel)
  return match?.[1] ?? null
}

/**
 * Protected task-event traffic uses two Redis principals. The publisher owns
 * sequence/history mutation and PUBLISH; the subscriber can only read history
 * and subscribe. Legacy installations retain the shared REDIS_URL path.
 */
export function taskEventRedisConfiguration(): TaskEventRedisConfiguration {
  const publisherUrl = process.env.FORGE_TASK_EVENT_PUBLISHER_REDIS_URL?.trim() ?? ''
  const subscriberUrl = process.env.FORGE_TASK_EVENT_SUBSCRIBER_REDIS_URL?.trim() ?? ''
  if (Boolean(publisherUrl) !== Boolean(subscriberUrl)) {
    throw new Error('The task-event Redis credential set is partially configured.')
  }
  if (publisherUrl && subscriberUrl) {
    if (publisherUrl === subscriberUrl) {
      throw new Error('Task-event publisher and subscriber Redis URLs must use separate credentials.')
    }
    return { dedicated: true, publisherUrl, subscriberUrl }
  }
  // REDIS_URL remains the legacy compatibility path. The shared Redis client
  // performs the deployment-time required-value validation before commands.
  const redisUrl = process.env.REDIS_URL?.trim() || 'redis://localhost:6379/0'
  return { dedicated: false, publisherUrl: redisUrl, subscriberUrl: redisUrl }
}

const globalForTaskEvents = globalThis as unknown as {
  forgeTaskEventPublisherRedis?: Redis
}

export function taskEventPublisherRedis(): Redis {
  const configuration = taskEventRedisConfiguration()
  if (!configuration.dedicated) {
    return redis
  }
  if (globalForTaskEvents.forgeTaskEventPublisherRedis) {
    return globalForTaskEvents.forgeTaskEventPublisherRedis
  }
  const client = new Redis(configuration.publisherUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 3,
    retryStrategy: (times) => Math.min(times * 100, 3000),
  })
  client.on('error', (error) => {
    console.warn('[task-events] publisher connection error:', error.message)
  })
  if (process.env.NODE_ENV !== 'production') {
    globalForTaskEvents.forgeTaskEventPublisherRedis = client
  }
  return client
}
