import { redis } from '@/lib/redis'

export const PASSWORD_LOGIN_RATE_LIMIT_WINDOW_SECONDS = 900
export const PASSWORD_LOGIN_RATE_LIMIT_PER_IP = 10
export const PASSWORD_LOGIN_RATE_LIMIT_GLOBAL = 50

export const PASSWORD_LOGIN_RATE_LIMIT_PATTERN = 'ratelimit:login:password:*'

export function passwordLoginRateLimitKeys(ip: string): {
  ipKey: string
  globalKey: string
} {
  return {
    ipKey: `ratelimit:login:password:ip:${ip}`,
    globalKey: 'ratelimit:login:password:global',
  }
}

export async function hitPasswordLoginRateLimit(key: string): Promise<number> {
  const count = await redis.incr(key)
  if (count === 1) {
    await redis.expire(key, PASSWORD_LOGIN_RATE_LIMIT_WINDOW_SECONDS)
  }
  return count
}

export async function clearPasswordLoginRateLimits(): Promise<number> {
  const keys = await redis.keys(PASSWORD_LOGIN_RATE_LIMIT_PATTERN)
  if (keys.length === 0) return 0

  return redis.del(...keys)
}
