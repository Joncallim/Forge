import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockRedisKeys, mockRedisDel, mockRedisEval } = vi.hoisted(() => ({
  mockRedisKeys: vi.fn(),
  mockRedisDel: vi.fn(),
  mockRedisEval: vi.fn(),
}))

vi.mock('@/lib/redis', () => ({
  redis: {
    keys: mockRedisKeys,
    del: mockRedisDel,
    eval: mockRedisEval,
  },
}))

import {
  PASSWORD_LOGIN_RATE_LIMIT_PATTERN,
  PASSWORD_LOGIN_RATE_LIMIT_WINDOW_SECONDS,
  clearPasswordLoginRateLimits,
  hitPasswordLoginRateLimit,
} from '@/lib/auth-rate-limit'

describe('clearPasswordLoginRateLimits', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns 0 and skips delete when no password throttle keys exist', async () => {
    mockRedisKeys.mockResolvedValue([])

    await expect(clearPasswordLoginRateLimits()).resolves.toBe(0)

    expect(mockRedisKeys).toHaveBeenCalledWith(PASSWORD_LOGIN_RATE_LIMIT_PATTERN)
    expect(mockRedisDel).not.toHaveBeenCalled()
  })

  it('deletes all password-login throttle keys found in Redis', async () => {
    const keys = [
      'ratelimit:login:password:ip:direct',
      'ratelimit:login:password:global',
    ]
    mockRedisKeys.mockResolvedValue(keys)
    mockRedisDel.mockResolvedValue(2)

    await expect(clearPasswordLoginRateLimits()).resolves.toBe(2)

    expect(mockRedisKeys).toHaveBeenCalledWith('ratelimit:login:password:*')
    expect(mockRedisDel).toHaveBeenCalledWith(...keys)
  })
})

describe('hitPasswordLoginRateLimit', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('increments the counter through one atomic script with the window TTL', async () => {
    mockRedisEval.mockResolvedValue(3)

    await expect(hitPasswordLoginRateLimit('ratelimit:login:password:ip:direct')).resolves.toBe(3)

    expect(mockRedisEval).toHaveBeenCalledTimes(1)
    const [script, keyCount, key, windowSeconds] = mockRedisEval.mock.calls[0]!
    expect(keyCount).toBe(1)
    expect(key).toBe('ratelimit:login:password:ip:direct')
    expect(windowSeconds).toBe(String(PASSWORD_LOGIN_RATE_LIMIT_WINDOW_SECONDS))
    // The script must arm the TTL on the first hit AND re-arm it when a legacy
    // counter lost its expiry, never leaving a permanent lockout key behind.
    expect(String(script)).toContain("redis.call('INCR', KEYS[1])")
    expect(String(script)).toContain("redis.call('EXPIRE', KEYS[1], ARGV[1])")
    expect(String(script)).toContain("redis.call('TTL', KEYS[1]) < 0")
  })

  it('fails closed on an invalid counter result', async () => {
    mockRedisEval.mockResolvedValue('not-a-number')

    await expect(hitPasswordLoginRateLimit('ratelimit:login:password:global'))
      .rejects.toThrow('invalid counter')
  })
})
