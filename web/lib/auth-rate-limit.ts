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

// INCR and EXPIRE must be atomic: a worker crash between them would leave the
// first-hit counter without a TTL, so the key could never reset and could lock
// out login permanently. The TTL re-arm on a missing expiry also heals any
// legacy counter that lost its TTL to that race.
const HIT_PASSWORD_LOGIN_RATE_LIMIT_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 or redis.call('TTL', KEYS[1]) < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return count
`

export async function hitPasswordLoginRateLimit(key: string): Promise<number> {
  const count = await redis.eval(
    HIT_PASSWORD_LOGIN_RATE_LIMIT_SCRIPT,
    1,
    key,
    String(PASSWORD_LOGIN_RATE_LIMIT_WINDOW_SECONDS),
  )
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 1) {
    throw new Error('Password login rate limit returned an invalid counter.')
  }
  return count
}

export async function clearPasswordLoginRateLimits(): Promise<number> {
  const keys = await redis.keys(PASSWORD_LOGIN_RATE_LIMIT_PATTERN)
  if (keys.length === 0) return 0

  return redis.del(...keys)
}
