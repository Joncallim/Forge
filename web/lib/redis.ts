import Redis from 'ioredis'

const globalForRedis = globalThis as unknown as { redis: Redis | undefined }

export const redis =
  globalForRedis.redis ??
  new Redis(process.env.REDIS_URL!, {
    lazyConnect: true,
    maxRetriesPerRequest: 3,
    retryStrategy: (times) => Math.min(times * 100, 3000),
  })

if (process.env.NODE_ENV !== 'production') globalForRedis.redis = redis
