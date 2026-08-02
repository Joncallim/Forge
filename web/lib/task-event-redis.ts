import Redis from 'ioredis'
import { redis } from '@/lib/redis'

export type TaskEventRedisConfiguration = {
  dedicated: boolean
  publisherUrl: string
  subscriberUrl: string
}

export type TaskEventRedisRuntimeMode = 'legacy' | 'protected'

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
export const LEGACY_TASK_EVENT_STORAGE_PATTERN = 'forge:task:*'
export const TASK_EVENT_V2_STORAGE_PATTERN = 'forge:task-events:v2:*'

export type TaskEventStorageKey = Readonly<{
  taskId: string
  kind: 'history' | 'seq'
}>

const TASK_EVENT_STORAGE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/** Exact storage-key classifiers shared by the task-event runtime and scrubber. */
export function parseLegacyTaskEventStorageKey(key: string): TaskEventStorageKey | null {
  const match = /^forge:task:([0-9a-f-]+):(history|seq)$/.exec(key)
  if (!match || !TASK_EVENT_STORAGE_UUID.test(match[1])) return null
  return { taskId: match[1], kind: match[2] as TaskEventStorageKey['kind'] }
}

export function parseV2TaskEventStorageKey(key: string): TaskEventStorageKey | null {
  const match = /^forge:task-events:v2:([0-9a-f-]+):(history|seq)$/.exec(key)
  if (!match || !TASK_EVENT_STORAGE_UUID.test(match[1])) return null
  return { taskId: match[1], kind: match[2] as TaskEventStorageKey['kind'] }
}

export function taskIdFromTaskEventLiveChannel(channel: string): string | null {
  const match = /^forge:task-events:v2:([^:]+):live$/.exec(channel)
  return match?.[1] ?? null
}

/**
 * Protected task-event traffic uses two Redis principals. The publisher owns
 * sequence/history mutation and PUBLISH; the subscriber can only read history
 * and subscribe. The caller must supply the database-authoritative runtime
 * mode; this pure decision deliberately cannot infer cutover from environment.
 */
export function taskEventRedisConfiguration(
  runtimeMode: TaskEventRedisRuntimeMode,
): TaskEventRedisConfiguration {
  if (runtimeMode !== 'legacy' && runtimeMode !== 'protected') {
    throw new Error('The task-event Redis runtime mode is unavailable.')
  }
  const publisherUrl = process.env.FORGE_TASK_EVENT_PUBLISHER_REDIS_URL?.trim() ?? ''
  const subscriberUrl = process.env.FORGE_TASK_EVENT_SUBSCRIBER_REDIS_URL?.trim() ?? ''
  if (Boolean(publisherUrl) !== Boolean(subscriberUrl)) {
    throw new Error('The task-event Redis credential set is partially configured.')
  }
  if (publisherUrl && subscriberUrl) {
    const publisherPrincipal = taskEventRedisPrincipal(publisherUrl)
    const subscriberPrincipal = taskEventRedisPrincipal(subscriberUrl)
    if (publisherPrincipal === subscriberPrincipal) {
      throw new Error('Task-event publisher and subscriber Redis URLs must use distinct ACL principals.')
    }
    return { dedicated: true, publisherUrl, subscriberUrl }
  }
  if (runtimeMode === 'protected') {
    throw new Error('Protected task-event traffic requires dedicated publisher and subscriber Redis credentials.')
  }
  // REDIS_URL remains the legacy compatibility path. The shared Redis client
  // performs the deployment-time required-value validation before commands.
  const redisUrl = process.env.REDIS_URL?.trim() || 'redis://localhost:6379/0'
  return { dedicated: false, publisherUrl: redisUrl, subscriberUrl: redisUrl }
}

function taskEventRedisPrincipal(redisUrl: string): string {
  let parsed: URL
  try {
    parsed = new URL(redisUrl)
  } catch {
    throw new Error('Task-event Redis credentials must use authenticated redis:// or rediss:// URLs.')
  }
  let username: string
  let password: string
  try {
    username = decodeURIComponent(parsed.username)
    password = decodeURIComponent(parsed.password)
  } catch {
    throw new Error('Task-event Redis credentials must use authenticated redis:// or rediss:// URLs.')
  }
  if ((parsed.protocol !== 'redis:' && parsed.protocol !== 'rediss:')
    || !parsed.hostname || !username || !password) {
    throw new Error('Task-event Redis credentials must use authenticated redis:// or rediss:// URLs.')
  }
  // ACL usernames are case-sensitive. Endpoint DNS names are not; transport,
  // a database number, and a password never distinguish a Redis ACL principal.
  const hostname = parsed.hostname.toLowerCase().replace(/\.+$/, '')
  if (!hostname) {
    throw new Error('Task-event Redis credentials must use authenticated redis:// or rediss:// URLs.')
  }
  const effectivePort = parsed.port || '6379'
  return JSON.stringify([hostname, effectivePort, username])
}

const globalForTaskEvents = globalThis as unknown as {
  forgeTaskEventPublisherRedis?: Redis
  forgeTaskEventPublisherRedisUrl?: string
}

function retireTaskEventPublisherRedis(): void {
  const client = globalForTaskEvents.forgeTaskEventPublisherRedis
  delete globalForTaskEvents.forgeTaskEventPublisherRedis
  delete globalForTaskEvents.forgeTaskEventPublisherRedisUrl
  if (!client) return
  client.removeAllListeners()
  client.disconnect(false)
}

export function taskEventPublisherRedis(configuration: TaskEventRedisConfiguration): Redis {
  if (!configuration.dedicated) {
    return redis
  }
  const cached = globalForTaskEvents.forgeTaskEventPublisherRedis
  if (cached
    && globalForTaskEvents.forgeTaskEventPublisherRedisUrl === configuration.publisherUrl
    && cached.status !== 'end') {
    return cached
  }
  retireTaskEventPublisherRedis()
  const client = new Redis(configuration.publisherUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 3,
    retryStrategy: (times) => Math.min(times * 100, 3000),
  })
  client.on('error', () => {
    console.warn('[task-events] Publisher connection unavailable')
  })
  globalForTaskEvents.forgeTaskEventPublisherRedis = client
  globalForTaskEvents.forgeTaskEventPublisherRedisUrl = configuration.publisherUrl
  return client
}

/** Releases the process-scoped dedicated publisher between isolated tests. */
export function resetTaskEventPublisherRedisForTests(): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('The task-event publisher test reset is unavailable.')
  }
  retireTaskEventPublisherRedis()
}
