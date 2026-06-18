import Redis from 'ioredis'
import { getRequiredEnv } from '@/lib/env'

const globalForRedis = globalThis as unknown as { redis: Redis | undefined }

function redisErrorMessage(err: Error): string {
  const aggregate = err as Error & { code?: string; errors?: { code?: string; message?: string }[] }
  return (
    err.message ||
    aggregate.code ||
    aggregate.errors?.map((nested) => nested.code ?? nested.message).filter(Boolean).join(', ') ||
    err.name
  )
}

export const redis =
  globalForRedis.redis ??
  new Redis(getRequiredEnv('REDIS_URL'), {
    lazyConnect: true,
    maxRetriesPerRequest: 3,
    retryStrategy: (times) => Math.min(times * 100, 3000),
  })

if (redis.listenerCount('error') === 0) {
  redis.on('error', (err) => {
    console.warn('[redis] connection error:', redisErrorMessage(err))
  })
}

if (process.env.NODE_ENV !== 'production') globalForRedis.redis = redis
