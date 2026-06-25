import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockRedisKeys, mockRedisDel } = vi.hoisted(() => ({
  mockRedisKeys: vi.fn(),
  mockRedisDel: vi.fn(),
}))

vi.mock('@/lib/redis', () => ({
  redis: {
    keys: mockRedisKeys,
    del: mockRedisDel,
  },
}))

import {
  PASSWORD_LOGIN_RATE_LIMIT_PATTERN,
  clearPasswordLoginRateLimits,
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
