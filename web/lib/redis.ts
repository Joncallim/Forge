import Redis from 'ioredis'
import { getRequiredEnv } from '@/lib/env'

const globalForRedis = globalThis as unknown as { redis: Redis | undefined }
let redisProxy: Redis | undefined

function redisErrorMessage(err: Error): string {
  const aggregate = err as Error & { code?: string; errors?: { code?: string; message?: string }[] }
  return (
    err.message ||
    aggregate.code ||
    aggregate.errors?.map((nested) => nested.code ?? nested.message).filter(Boolean).join(', ') ||
    err.name
  )
}

function createRedisClient(): Redis {
  const client = new Redis(getRequiredEnv('REDIS_URL'), {
    lazyConnect: true,
    maxRetriesPerRequest: 3,
    retryStrategy: (times) => Math.min(times * 100, 3000),
  })

  client.on('error', (err) => {
    console.warn('[redis] connection error:', redisErrorMessage(err))
  })

  return client
}

function getRedisClient(): Redis {
  if (globalForRedis.redis) return globalForRedis.redis

  const client = createRedisClient()
  if (process.env.NODE_ENV !== 'production') globalForRedis.redis = client
  return client
}

export const redis =
  redisProxy ??
  (redisProxy = new Proxy({} as Redis, {
    get(_target, prop, receiver) {
      const client = getRedisClient()
      const value = Reflect.get(client, prop, receiver)
      return typeof value === 'function' ? value.bind(client) : value
    },
  }))
