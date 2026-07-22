/**
 * Suite 1 — Auth
 *
 * Tests for:
 *  - register/start registration gating and challenge TTL
 *  - lib/session: createSession, getSession (write-behind), destroySession
 *  - login/finish clone-detection logic
 *
 * All external dependencies (db, redis, @simplewebauthn/server) are mocked at
 * the module level so no real network connections are made.
 *
 * vi.hoisted() is used for mock functions so they are available before the
 * vi.mock() factory calls are executed (vi.mock factories are hoisted to the
 * top of the file, ahead of variable declarations).
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'

// ---------------------------------------------------------------------------
// Hoisted mock functions — must be declared before vi.mock() calls
// ---------------------------------------------------------------------------

const {
  mockDbSelect,
  mockDbInsert,
  mockDbTransaction,
  mockDbUpdate,
  mockRedisGet,
  mockRedisEval,
  mockRedisGetdel,
  mockRedisSet,
  mockRedisDel,
  mockRedisIncr,
  mockRedisExpire,
  mockRedisLpush,
  mockHashPassword,
  mockVerifyPassword,
  mockGenerateRegistrationOptions,
  mockVerifyAuthenticationResponse,
  mockVerifyRegistrationResponse,
} = vi.hoisted(() => ({
  mockDbSelect: vi.fn(),
  mockDbInsert: vi.fn(),
  mockDbTransaction: vi.fn(async (callback: (tx: unknown) => unknown) => callback({
    select: mockDbSelect,
    insert: mockDbInsert,
    update: mockDbUpdate,
  })),
  mockDbUpdate: vi.fn(),
  mockRedisGet: vi.fn(),
  mockRedisEval: vi.fn(),
  mockRedisGetdel: vi.fn(),
  mockRedisSet: vi.fn(),
  mockRedisDel: vi.fn(),
  mockRedisIncr: vi.fn(),
  mockRedisExpire: vi.fn(),
  mockRedisLpush: vi.fn(),
  mockHashPassword: vi.fn(),
  mockVerifyPassword: vi.fn(),
  mockGenerateRegistrationOptions: vi.fn(),
  mockVerifyAuthenticationResponse: vi.fn(),
  mockVerifyRegistrationResponse: vi.fn(),
}))

// ---------------------------------------------------------------------------
// Module-level mocks
// ---------------------------------------------------------------------------

vi.mock('@/db', () => ({
  db: {
    select: mockDbSelect,
    insert: mockDbInsert,
    transaction: mockDbTransaction,
    update: mockDbUpdate,
  },
}))

vi.mock('@/lib/redis', () => ({
  redis: {
    get: mockRedisGet,
    eval: mockRedisEval,
    getdel: mockRedisGetdel,
    set: mockRedisSet,
    del: mockRedisDel,
    incr: mockRedisIncr,
    expire: mockRedisExpire,
    lpush: mockRedisLpush,
  },
}))

vi.mock('@/lib/password', () => ({
  hashPassword: mockHashPassword,
  verifyPassword: mockVerifyPassword,
  validatePassword: (password: string) =>
    password.length >= 8 ? null : 'Password must be at least 8 characters.',
}))

vi.mock('@simplewebauthn/server', () => ({
  generateRegistrationOptions: mockGenerateRegistrationOptions,
  verifyAuthenticationResponse: mockVerifyAuthenticationResponse,
  verifyRegistrationResponse: mockVerifyRegistrationResponse,
}))

vi.mock('@simplewebauthn/server/helpers', () => ({
  isoUint8Array: {
    fromUTF8String: (s: string) => new TextEncoder().encode(s),
  },
  isoBase64URL: {
    fromBuffer: (b: Uint8Array) => Buffer.from(b).toString('base64url'),
    toBuffer: (s: string) => Buffer.from(s, 'base64url'),
  },
}))

// ---------------------------------------------------------------------------
// Import SUT after mocks are registered
// ---------------------------------------------------------------------------

import { createSession, getSession, destroySession } from '@/lib/session'
import { sessions } from '@/db/schema'

// ---------------------------------------------------------------------------
// Drizzle chain factory
// ---------------------------------------------------------------------------

function chain(resolveValue: unknown) {
  const t: Record<string, unknown> = {
    then: (ok: (v: unknown) => unknown, err?: (e: unknown) => unknown) =>
      Promise.resolve(resolveValue).then(ok, err),
    catch: (onRejected: (e: unknown) => unknown) =>
      Promise.resolve(resolveValue).catch(onRejected),
  }
  const methods = ['from', 'where', 'limit', 'orderBy', 'values', 'returning', 'set', 'execute', 'for']
  methods.forEach((m) => { t[m] = vi.fn(() => t) })
  return t
}

function createdSessionChain() {
  return chain([{
    sessionId: '00000000-0000-4000-8000-000000000001',
    lastSeenAt: new Date('2026-07-18T00:00:00.000Z'),
    expiresAt: new Date('2026-07-25T00:00:00.000Z'),
  }])
}

function transactionClient() {
  return { select: mockDbSelect, insert: mockDbInsert, update: mockDbUpdate }
}

// ---------------------------------------------------------------------------
// Fake request builder
// ---------------------------------------------------------------------------

function fakeRequest(cookieValue?: string): Request {
  const headers: Record<string, string> = {}
  if (cookieValue !== undefined) {
    headers['cookie'] = `forge_session=${cookieValue}`
  }
  return new Request('http://localhost/', { headers })
}

beforeEach(() => {
  delete process.env.FORGE_PASSKEYS_ENABLED
  delete process.env.FORGE_DISABLE_PASSKEYS
  delete process.env.FORGE_SESSION_CREDENTIAL_MODE
})

// ---------------------------------------------------------------------------
// Tests — register/start
// ---------------------------------------------------------------------------

describe('register/start — registration gating', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.WEBAUTHN_RP_NAME = 'Forge'
    process.env.WEBAUTHN_RP_ID = 'localhost'
    process.env.WEBAUTHN_ORIGIN = 'http://localhost:3000'
  })

  it('returns 403 when users count > 0', async () => {
    mockDbSelect.mockReturnValue(chain([{ value: 1 }]))

    const { POST } = await import('@/app/api/auth/register/start/route')

    const req = new Request('http://localhost/api/auth/register/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: 'Alice' }),
    })

    const res = await POST(req as never)
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.error).toBe('Registration closed')
  })

  it('stores challenge in Redis with EX 300 when no users exist', async () => {
    mockDbSelect.mockReturnValue(chain([{ value: 0 }]))
    mockGenerateRegistrationOptions.mockResolvedValue({
      challenge: 'test-challenge-abc',
      user: { id: 'temp-id' },
    })
    mockRedisSet.mockResolvedValue('OK')

    const { POST } = await import('@/app/api/auth/register/start/route')

    const req = new Request('http://localhost/api/auth/register/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: 'Alice' }),
    })

    const res = await POST(req as never)
    expect(res.status).toBe(200)

    // redis.set must have been called with EX 300
    expect(mockRedisSet).toHaveBeenCalledOnce()
    const [, , exFlag, exValue] = mockRedisSet.mock.calls[0]
    expect(exFlag).toBe('EX')
    expect(exValue).toBe(300)
  })
})

// ---------------------------------------------------------------------------
// Tests — createSession
// ---------------------------------------------------------------------------

describe('createSession', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockDbSelect.mockReturnValue(chain([{ state: 'strict' }]))
    mockRedisSet.mockResolvedValue('OK')
    mockDbInsert.mockReturnValue(createdSessionChain())
  })

  it('commits the database row before writing the digest-keyed Redis cache', async () => {
    await createSession('user-1', 'cred-1', { userAgent: 'UA', ip: '1.2.3.4' })

    expect(mockRedisSet).toHaveBeenCalledOnce()
    const [key, data, expiryMode, expiresAt] = mockRedisSet.mock.calls[0]
    expect(key).toMatch(/^session:v2:[0-9a-f]{64}$/)
    expect(expiryMode).toBe('PXAT')
    expect(expiresAt).toBe(new Date('2026-07-25T00:00:00.000Z').getTime())
    const parsed = JSON.parse(data as string)
    expect(parsed.userId).toBe('user-1')
    expect(mockDbInsert.mock.invocationCallOrder[0]).toBeLessThan(mockRedisSet.mock.invocationCallOrder[0])
  })

  it('inserts a sessions row into the DB', async () => {
    await createSession('user-1', 'cred-1', { userAgent: 'UA', ip: '1.2.3.4' })
    expect(mockDbInsert).toHaveBeenCalledOnce()
  })

  it('stores null when session metadata has a non-IP rate-limit bucket', async () => {
    await createSession('user-1', null, { userAgent: 'UA', ip: 'direct' })

    expect(mockDbInsert).toHaveBeenCalledOnce()
    expect(mockDbInsert.mock.calls[0][0]).toBe(sessions)
    expect(mockDbInsert.mock.results[0].value.values).toHaveBeenCalledWith(
      expect.objectContaining({ ipAddress: undefined }),
    )
  })

  it('returns the generated sessionId as a non-empty string', async () => {
    const id = await createSession('user-1', null, {})
    expect(typeof id).toBe('string')
    expect(id.length).toBeGreaterThan(0)
  })

  it('dual-writes the legacy Redis key with the same absolute expiry when explicitly enabled', async () => {
    process.env.FORGE_SESSION_CREDENTIAL_MODE = 'dual'
    mockDbSelect.mockReturnValue(chain([{ state: 'expansion' }]))
    const credential = await createSession('user-1', null, {})

    expect(mockRedisSet).toHaveBeenCalledTimes(2)
    expect(mockRedisSet).toHaveBeenCalledWith(
      `session:${credential}`,
      expect.any(String),
      'PXAT',
      new Date('2026-07-25T00:00:00.000Z').getTime(),
    )
    expect(mockDbInsert.mock.results[0].value.values).toHaveBeenCalledWith(
      expect.objectContaining({ id: credential, credentialStorageVersion: 1 }),
    )
  })

  it('does not write either Redis session key when the database commit fails', async () => {
    process.env.FORGE_SESSION_CREDENTIAL_MODE = 'dual'
    mockDbSelect.mockReturnValue(chain([{ state: 'expansion' }]))
    mockDbTransaction.mockImplementationOnce(async (callback: (tx: unknown) => unknown) => {
      await callback(transactionClient())
      throw new Error('commit failed')
    })

    await expect(createSession('user-1', null, {})).rejects.toThrow('commit failed')
    expect(mockDbInsert).toHaveBeenCalledOnce()
    expect(mockRedisSet).not.toHaveBeenCalled()
  })

  it('writes the dual legacy cache only after the transaction has committed', async () => {
    process.env.FORGE_SESSION_CREDENTIAL_MODE = 'dual'
    mockDbSelect.mockReturnValue(chain([{ state: 'expansion' }]))
    let committed = false
    mockDbTransaction.mockImplementationOnce(async (callback: (tx: unknown) => unknown) => {
      const result = await callback(transactionClient())
      committed = true
      return result
    })
    mockRedisSet.mockImplementation(async () => {
      expect(committed).toBe(true)
      return 'OK'
    })

    await createSession('user-1', null, {})
    expect(mockRedisSet).toHaveBeenCalledTimes(2)
  })
})

// ---------------------------------------------------------------------------
// Tests — getSession
// ---------------------------------------------------------------------------

describe('getSession', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns null when the forge_session cookie is absent', async () => {
    const req = fakeRequest()
    const result = await getSession(req)
    expect(result).toBeNull()
    expect(mockRedisGet).not.toHaveBeenCalled()
  })

  it('rejects a non-canonical cookie without consulting either store', async () => {
    const req = fakeRequest('some-session-id')
    const result = await getSession(req)
    expect(result).toBeNull()
    expect(mockDbTransaction).not.toHaveBeenCalled()
    expect(mockRedisGet).not.toHaveBeenCalled()
  })

  it('authorizes from a live digest-matched PostgreSQL row even when Redis is empty', async () => {
    const now = new Date()
    mockRedisSet.mockResolvedValue('OK')
    mockDbSelect.mockReturnValue(chain([{
      sessionId: '00000000-0000-4000-8000-000000000010',
      userId: 'user-abc',
      lastSeenAt: now,
      expiresAt: new Date(now.getTime() + 60_000),
      revokedAt: null,
      databaseNow: now,
    }]))
    mockDbUpdate.mockReturnValue(chain(undefined))

    const req = fakeRequest('00000000-0000-4000-8000-000000000000')
    const result = await getSession(req)
    expect(result).toEqual({ sessionId: '00000000-0000-4000-8000-000000000010', userId: 'user-abc' })
    expect(mockDbTransaction).toHaveBeenCalledOnce()
    expect(mockRedisSet).toHaveBeenCalledWith(expect.stringMatching(/^session:v2:/), expect.any(String), 'PXAT', expect.any(Number))
  })

  it('authorizes when a raw PostgreSQL clock timestamp is returned as text', async () => {
    const now = new Date()
    mockRedisSet.mockResolvedValue('OK')
    mockDbSelect.mockReturnValue(chain([{
      sessionId: '00000000-0000-4000-8000-000000000010',
      userId: 'user-abc',
      lastSeenAt: now,
      expiresAt: new Date(now.getTime() + 60_000),
      revokedAt: null,
      databaseNow: now.toISOString().replace('T', ' ').replace('Z', '+00'),
    }]))

    const req = fakeRequest('00000000-0000-4000-8000-000000000000')
    const result = await getSession(req)

    expect(result).toEqual({
      sessionId: '00000000-0000-4000-8000-000000000010',
      userId: 'user-abc',
    })
    expect(mockRedisSet).toHaveBeenCalledOnce()
  })

  it('fails closed when PostgreSQL returns a non-finite session timestamp', async () => {
    const now = new Date()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    mockDbSelect.mockReturnValue(chain([{
      sessionId: '00000000-0000-4000-8000-000000000010',
      userId: 'user-abc',
      lastSeenAt: now,
      expiresAt: new Date(now.getTime() + 60_000),
      revokedAt: null,
      databaseNow: 'infinity',
    }]))

    const req = fakeRequest('00000000-0000-4000-8000-000000000000')
    const result = await getSession(req)

    expect(result).toBeNull()
    expect(mockDbUpdate).not.toHaveBeenCalled()
    expect(mockRedisSet).not.toHaveBeenCalled()
    expect(consoleError).toHaveBeenCalledWith(
      'Database-authoritative session check failed:',
      expect.objectContaining({ message: expect.stringContaining('invalid clock') }),
    )
    consoleError.mockRestore()
  })

  it('fails closed when a stored session expiry is non-finite', async () => {
    const now = new Date()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    mockDbSelect.mockReturnValue(chain([{
      sessionId: '00000000-0000-4000-8000-000000000010',
      userId: 'user-abc',
      lastSeenAt: now,
      expiresAt: new Date('infinity'),
      revokedAt: null,
      databaseNow: now,
    }]))

    const req = fakeRequest('00000000-0000-4000-8000-000000000000')
    const result = await getSession(req)

    expect(result).toBeNull()
    expect(mockDbUpdate).not.toHaveBeenCalled()
    expect(mockRedisSet).not.toHaveBeenCalled()
    expect(consoleError).toHaveBeenCalledWith(
      'Database-authoritative session check failed:',
      expect.objectContaining({ message: expect.stringContaining('invalid expiry') }),
    )
    consoleError.mockRestore()
  })

  it('denies a session exactly at its database expiry boundary', async () => {
    const now = new Date()
    mockRedisDel.mockResolvedValue(1)
    mockDbSelect.mockReturnValue(chain([{
      sessionId: '00000000-0000-4000-8000-000000000010',
      userId: 'user-abc',
      lastSeenAt: new Date(now.getTime() - 30_000),
      expiresAt: now,
      revokedAt: null,
      databaseNow: now,
    }]))

    const req = fakeRequest('00000000-0000-4000-8000-000000000000')
    const result = await getSession(req)

    expect(result).toBeNull()
    expect(mockDbUpdate).not.toHaveBeenCalled()
    expect(mockRedisSet).not.toHaveBeenCalled()
  })

  it('denies and removes stale cache state for a revoked database row', async () => {
    mockRedisDel.mockResolvedValue(1)
    const now = new Date()
    mockDbSelect.mockReturnValue(chain([{
      sessionId: '00000000-0000-4000-8000-000000000010', userId: 'user-abc',
      lastSeenAt: now, expiresAt: new Date(now.getTime() + 60_000),
      revokedAt: now, databaseNow: now,
    }]))

    const req = fakeRequest('00000000-0000-4000-8000-000000000000')
    const result = await getSession(req)

    expect(result).toBeNull()
    expect(mockRedisDel).toHaveBeenCalledOnce()
    expect(mockDbUpdate).not.toHaveBeenCalled()
  })

  it('backfills a legacy session from its exact Redis PEXPIRETIME authority', async () => {
    const redisNowMs = Date.now()
    const expiresAtMs = redisNowMs + 90_000
    const credential = '00000000-0000-4000-8000-000000000000'
    mockRedisEval.mockResolvedValue([
      JSON.stringify({ userId: 'user-abc', lastSeenAt: redisNowMs - 1_000 }),
      expiresAtMs,
      Math.floor(redisNowMs / 1000),
      (redisNowMs % 1000) * 1000,
    ])
    mockRedisSet.mockResolvedValue('OK')
    mockDbSelect
      .mockReturnValueOnce(chain([{ state: 'expansion' }]))
      .mockReturnValueOnce(chain([{
      sessionId: credential,
      userId: 'user-abc',
      lastSeenAt: new Date(redisNowMs - 1_000),
      expiresAt: null,
      revokedAt: null,
      credentialDigestV1: null,
      credentialStorageVersion: 0,
      databaseNow: new Date(redisNowMs),
    }]))
    mockDbUpdate.mockReturnValue(chain([{ id: credential }]))

    await expect(getSession(fakeRequest(credential))).resolves.toEqual({
      sessionId: credential,
      userId: 'user-abc',
    })
    expect(mockRedisEval).toHaveBeenCalledOnce()
    const backfill = mockDbUpdate.mock.results[0].value.set.mock.calls[0][0]
    expect(backfill).toEqual(expect.objectContaining({
      credentialStorageVersion: 1,
      expiresAt: new Date(expiresAtMs),
    }))
    expect(mockRedisSet).toHaveBeenCalledWith(
      expect.stringMatching(/^session:v2:/), expect.any(String), 'PXAT', expiresAtMs,
    )
    expect(mockRedisSet).toHaveBeenCalledWith(
      `session:${credential}`, expect.any(String), 'PXAT', expiresAtMs,
    )
  })

  it('fails closed and queues purge for a non-expiring legacy Redis session', async () => {
    const redisNowMs = Date.now()
    const credential = '00000000-0000-4000-8000-000000000000'
    mockRedisEval.mockResolvedValue([
      JSON.stringify({ userId: 'user-abc', lastSeenAt: redisNowMs - 1_000 }),
      -1,
      Math.floor(redisNowMs / 1000),
      (redisNowMs % 1000) * 1000,
    ])
    mockRedisDel.mockResolvedValue(1)
    mockDbSelect.mockReturnValue(chain([{
      sessionId: credential,
      userId: 'user-abc',
      lastSeenAt: new Date(redisNowMs - 1_000),
      expiresAt: null,
      revokedAt: null,
      credentialDigestV1: null,
      credentialStorageVersion: 0,
      databaseNow: new Date(redisNowMs),
    }]))
    mockDbUpdate.mockReturnValue(chain([]))

    await expect(getSession(fakeRequest(credential))).resolves.toBeNull()
    expect(mockDbUpdate).toHaveBeenCalledOnce()
    expect(mockRedisDel).toHaveBeenCalledWith(
      expect.stringMatching(/^session:v2:/), `session:${credential}`,
    )
  })
})

// ---------------------------------------------------------------------------
// Tests — getSession write-behind logic
// ---------------------------------------------------------------------------

describe('getSession — write-behind logic', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    mockRedisSet.mockResolvedValue('OK')
    mockDbUpdate.mockReturnValue(chain([{
      lastSeenAt: new Date(), expiresAt: new Date(Date.now() + 604_800_000),
    }]))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('does NOT trigger a DB write when lastSeenAt is less than 60 seconds old', async () => {
    const now = Date.now()
    vi.setSystemTime(now)

    mockDbSelect.mockReturnValue(chain([{
      sessionId: '00000000-0000-4000-8000-000000000010', userId: 'user-1',
      lastSeenAt: new Date(now - 30_000), expiresAt: new Date(now + 60_000),
      revokedAt: null, databaseNow: new Date(now),
    }]))

    const req = fakeRequest('00000000-0000-4000-8000-000000000000')
    await getSession(req)

    expect(mockDbUpdate).not.toHaveBeenCalled()
  })

  it('triggers a fire-and-forget DB write when lastSeenAt is older than 60 seconds', async () => {
    const now = Date.now()
    vi.setSystemTime(now)

    mockDbSelect.mockReturnValue(chain([{
      sessionId: '00000000-0000-4000-8000-000000000010', userId: 'user-1',
      lastSeenAt: new Date(now - 61_000), expiresAt: new Date(now + 60_000),
      revokedAt: null, databaseNow: new Date(now),
    }]))

    const req = fakeRequest('00000000-0000-4000-8000-000000000000')
    await getSession(req)

    // DB update is kicked off fire-and-forget; the mock should have been invoked
    expect(mockDbUpdate).toHaveBeenCalledOnce()
    // Redis was also refreshed
    expect(mockRedisSet).toHaveBeenCalledOnce()
  })

  it('does not write a legacy cache when the sliding-refresh transaction fails to commit', async () => {
    const now = Date.now()
    vi.setSystemTime(now)
    process.env.FORGE_SESSION_CREDENTIAL_MODE = 'dual'
    mockDbSelect
      .mockReturnValueOnce(chain([{ state: 'expansion' }]))
      .mockReturnValueOnce(chain([{
        sessionId: '00000000-0000-4000-8000-000000000010',
        userId: 'user-1',
        lastSeenAt: new Date(now - 61_000),
        expiresAt: new Date(now + 60_000),
        revokedAt: null,
        credentialStorageVersion: 1,
        databaseNow: new Date(now),
      }]))
    mockDbTransaction.mockImplementationOnce(async (callback: (tx: unknown) => unknown) => {
      await callback(transactionClient())
      throw new Error('commit failed')
    })
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    await expect(getSession(fakeRequest('00000000-0000-4000-8000-000000000000'))).resolves.toBeNull()
    expect(mockDbUpdate).toHaveBeenCalledOnce()
    expect(mockRedisSet).not.toHaveBeenCalled()
    consoleError.mockRestore()
  })

  it('writes the sliding-refresh legacy cache only after commit', async () => {
    const now = Date.now()
    vi.setSystemTime(now)
    process.env.FORGE_SESSION_CREDENTIAL_MODE = 'dual'
    mockDbSelect
      .mockReturnValueOnce(chain([{ state: 'expansion' }]))
      .mockReturnValueOnce(chain([{
        sessionId: '00000000-0000-4000-8000-000000000010',
        userId: 'user-1',
        lastSeenAt: new Date(now - 61_000),
        expiresAt: new Date(now + 60_000),
        revokedAt: null,
        credentialStorageVersion: 1,
        databaseNow: new Date(now),
      }]))
    let committed = false
    mockDbTransaction.mockImplementationOnce(async (callback: (tx: unknown) => unknown) => {
      const result = await callback(transactionClient())
      committed = true
      return result
    })
    mockRedisSet.mockImplementation(async () => {
      expect(committed).toBe(true)
      return 'OK'
    })

    await expect(getSession(fakeRequest('00000000-0000-4000-8000-000000000000'))).resolves.toEqual({
      sessionId: '00000000-0000-4000-8000-000000000010',
      userId: 'user-1',
    })
    expect(mockRedisSet).toHaveBeenCalledTimes(2)
  })
})

// ---------------------------------------------------------------------------
// Tests — destroySession
// ---------------------------------------------------------------------------

describe('destroySession', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRedisDel.mockResolvedValue(1)
    mockDbUpdate.mockReturnValue(chain(undefined))
  })

  it('deletes both digest and legacy Redis keys after DB revocation', async () => {
    await destroySession('00000000-0000-4000-8000-000000000000')
    expect(mockRedisDel).toHaveBeenCalledWith(
      expect.stringMatching(/^session:v2:[0-9a-f]{64}$/),
      'session:00000000-0000-4000-8000-000000000000',
    )
    expect(mockDbUpdate.mock.invocationCallOrder[0]).toBeLessThan(mockRedisDel.mock.invocationCallOrder[0])
  })

  it('sets revokedAt in the DB', async () => {
    await destroySession('00000000-0000-4000-8000-000000000000')
    expect(mockDbUpdate).toHaveBeenCalledOnce()
  })
})

// ---------------------------------------------------------------------------
// Tests — login/finish clone detection
// ---------------------------------------------------------------------------

describe('login/finish — clone detection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.WEBAUTHN_ORIGIN = 'http://localhost:3000'
    process.env.WEBAUTHN_RP_ID = 'localhost'

    // login/finish now uses getdel (atomic read+delete) instead of get+del
    mockRedisGetdel.mockResolvedValue('stored-challenge-value')
    mockRedisSet.mockResolvedValue('OK')
    mockDbInsert.mockReturnValue(createdSessionChain())
    mockDbUpdate.mockReturnValue(chain([]))
  })

  it('does NOT return 403 when newCounter=0 and storedCounter=0 (counter-0 passkeys are exempt)', async () => {
    const storedCredential = {
      id: 'cred-row-id',
      credentialId: 'abc123',
      userId: 'user-1',
      publicKey: Buffer.from('pk'),
      counter: 0,
      transports: null,
    }
    const user = { id: 'user-1', displayName: 'Alice' }

    mockDbSelect
      .mockReturnValueOnce(chain([storedCredential]))
      .mockReturnValueOnce(chain([user]))

    mockVerifyAuthenticationResponse.mockResolvedValue({
      verified: true,
      authenticationInfo: { newCounter: 0 },
    })

    const { POST } = await import('@/app/api/auth/login/finish/route')

    const req = new Request('http://localhost/api/auth/login/finish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        nonce: 'nonce-xyz',
        credential: { id: 'abc123', response: {}, type: 'public-key' },
      }),
    })

    const res = await POST(req as never)
    // Counter-0 passkeys are exempt — must NOT be 403
    expect(res.status).not.toBe(403)
  })

  it('returns 403 when newCounter < storedCounter and storedCounter > 0', async () => {
    const storedCredential = {
      id: 'cred-row-id',
      credentialId: 'abc123',
      userId: 'user-1',
      publicKey: Buffer.from('pk'),
      counter: 10,
      transports: null,
    }
    const user = { id: 'user-1', displayName: 'Alice' }

    mockDbSelect
      .mockReturnValueOnce(chain([storedCredential]))
      .mockReturnValueOnce(chain([user]))

    mockVerifyAuthenticationResponse.mockResolvedValue({
      verified: true,
      authenticationInfo: { newCounter: 5 }, // regression: 5 < 10
    })

    const { POST } = await import('@/app/api/auth/login/finish/route')

    const req = new Request('http://localhost/api/auth/login/finish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        nonce: 'nonce-xyz',
        credential: { id: 'abc123', response: {}, type: 'public-key' },
      }),
    })

    const res = await POST(req as never)
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.error).toMatch(/counter regression/i)
  })
})

// ---------------------------------------------------------------------------
// Tests — password login
// ---------------------------------------------------------------------------

describe('login/password', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRedisSet.mockResolvedValue('OK')
    mockRedisDel.mockResolvedValue(1)
    mockRedisIncr.mockResolvedValue(1)
    mockRedisExpire.mockResolvedValue(1)
    mockDbInsert.mockReturnValue(createdSessionChain())
  })

  it('creates a session when the password matches', async () => {
    mockDbSelect.mockReturnValue(
      chain([{ id: 'user-1', displayName: 'Alice', passwordHash: 'stored-hash' }]),
    )
    mockVerifyPassword.mockResolvedValue(true)

    const { POST } = await import('@/app/api/auth/login/password/route')

    const req = new Request('http://localhost/api/auth/login/password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'correct-password' }),
    })

    const res = await POST(req as never)
    expect(res.status).toBe(200)
    expect(mockVerifyPassword).toHaveBeenCalledWith('correct-password', 'stored-hash')
    expect(mockRedisSet).toHaveBeenCalledOnce()
    expect(mockDbInsert).toHaveBeenCalledOnce()
    expect(mockDbInsert.mock.results[0].value.values).toHaveBeenCalledWith(
      expect.objectContaining({ ipAddress: undefined }),
    )
  })

  it('returns 401 when the password does not match', async () => {
    mockDbSelect.mockReturnValue(
      chain([{ id: 'user-1', displayName: 'Alice', passwordHash: 'stored-hash' }]),
    )
    mockVerifyPassword.mockResolvedValue(false)

    const { POST } = await import('@/app/api/auth/login/password/route')

    const req = new Request('http://localhost/api/auth/login/password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'wrong-password' }),
    })

    const res = await POST(req as never)
    expect(res.status).toBe(401)
    expect(mockRedisSet).not.toHaveBeenCalled()
    expect(mockDbInsert).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Tests — password login rate limiting
// ---------------------------------------------------------------------------

describe('login/password — rate limiting', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    delete process.env.FORGE_TRUST_PROXY
    mockRedisExpire.mockResolvedValue(1)
  })

  it('returns 429 once the per-IP attempt limit is exceeded', async () => {
    mockRedisIncr.mockResolvedValue(11)

    const { POST } = await import('@/app/api/auth/login/password/route')

    const req = new Request('http://localhost/api/auth/login/password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'whatever' }),
    })

    const res = await POST(req as never)
    expect(res.status).toBe(429)
    expect(mockVerifyPassword).not.toHaveBeenCalled()
  })

  it('does not trust forwarded IP headers unless proxy mode is enabled', async () => {
    mockRedisIncr.mockResolvedValue(11)

    const { POST } = await import('@/app/api/auth/login/password/route')

    const req = new Request('http://localhost/api/auth/login/password', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-forwarded-for': '203.0.113.10',
      },
      body: JSON.stringify({ password: 'whatever' }),
    })

    await POST(req as never)

    expect(mockRedisIncr).toHaveBeenCalledWith('ratelimit:login:password:ip:direct')
  })

  it('uses forwarded IP headers when trusted proxy mode is enabled', async () => {
    process.env.FORGE_TRUST_PROXY = '1'
    mockRedisIncr.mockResolvedValue(11)

    const { POST } = await import('@/app/api/auth/login/password/route')

    const req = new Request('http://localhost/api/auth/login/password', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-forwarded-for': '203.0.113.10, 198.51.100.20',
      },
      body: JSON.stringify({ password: 'whatever' }),
    })

    await POST(req as never)

    expect(mockRedisIncr).toHaveBeenCalledWith('ratelimit:login:password:ip:203.0.113.10')
  })

  it('does not write malformed trusted proxy headers to the sessions inet column', async () => {
    process.env.FORGE_TRUST_PROXY = '1'
    mockRedisIncr.mockResolvedValue(1)
    mockDbSelect.mockReturnValue(
      chain([{ id: 'user-1', displayName: 'Alice', passwordHash: 'stored-hash' }]),
    )
    mockVerifyPassword.mockResolvedValue(true)
    mockDbInsert.mockReturnValue(createdSessionChain())

    const { POST } = await import('@/app/api/auth/login/password/route')

    const req = new Request('http://localhost/api/auth/login/password', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-forwarded-for': 'not-an-ip',
      },
      body: JSON.stringify({ password: 'correct-password' }),
    })

    const res = await POST(req as never)
    expect(res.status).toBe(200)
    expect(mockDbInsert.mock.results[0].value.values).toHaveBeenCalledWith(
      expect.objectContaining({ ipAddress: undefined }),
    )
  })
})

// ---------------------------------------------------------------------------
// Tests — register/finish password validation
// ---------------------------------------------------------------------------

describe('register/finish — password validation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns 400 when the password is missing', async () => {
    const { POST } = await import('@/app/api/auth/register/finish/route')
    const { NextRequest } = await import('next/server')

    const req = new NextRequest('http://localhost/api/auth/register/finish', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: 'reg_nonce=temp-user' },
      body: JSON.stringify({ credential: { id: 'x' } }),
    })

    const res = await POST(req)
    expect(res.status).toBe(400)
    expect(mockRedisGetdel).not.toHaveBeenCalled()
  })

  it('returns 400 when the password is too short', async () => {
    const { POST } = await import('@/app/api/auth/register/finish/route')
    const { NextRequest } = await import('next/server')

    const req = new NextRequest('http://localhost/api/auth/register/finish', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: 'reg_nonce=temp-user' },
      body: JSON.stringify({ credential: { id: 'x' }, password: 'short' }),
    })

    const res = await POST(req)
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toMatch(/at least 8 characters/i)
  })
})

// ---------------------------------------------------------------------------
// Tests — password-only registration
// ---------------------------------------------------------------------------

describe('register/password — passkeys disabled', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.FORGE_PASSKEYS_ENABLED = '0'
    mockRedisSet.mockResolvedValue('OK')
    mockRedisGet.mockResolvedValue('lock-token')
    mockRedisDel.mockResolvedValue(1)
    mockHashPassword.mockResolvedValue('hashed-password')
    mockDbInsert.mockReturnValueOnce(chain([{ id: 'user-1' }]))
    mockDbInsert.mockReturnValue(createdSessionChain())
    mockDbUpdate.mockReturnValue(chain(undefined))
  })

  it('creates the first user without a passkey when passkeys are disabled', async () => {
    mockDbSelect.mockReturnValue(chain([{ value: 0 }]))

    const { POST } = await import('@/app/api/auth/register/password/route')
    const { NextRequest } = await import('next/server')

    const req = new NextRequest('http://localhost/api/auth/register/password', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'Alice', password: 'correct-password' }),
    })

    const res = await POST(req)

    expect(res.status).toBe(200)
    expect(mockHashPassword).toHaveBeenCalledWith('correct-password')
    expect(mockDbInsert).toHaveBeenCalledTimes(2)
    expect(mockDbUpdate).toHaveBeenCalledTimes(2)
    expect(mockRedisSet).toHaveBeenCalledWith(
      'webauthn:registration:first-user-lock',
      expect.any(String),
      'EX',
      30,
      'NX',
    )
  })

  it('is not available while passkeys are enabled', async () => {
    process.env.FORGE_PASSKEYS_ENABLED = '1'

    const { POST } = await import('@/app/api/auth/register/password/route')
    const { NextRequest } = await import('next/server')

    const req = new NextRequest('http://localhost/api/auth/register/password', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'Alice', password: 'correct-password' }),
    })

    const res = await POST(req)

    expect(res.status).toBe(404)
    expect(mockDbSelect).not.toHaveBeenCalled()
  })
})
