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
  mockDbUpdate,
  mockRedisGet,
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
  mockDbUpdate: vi.fn(),
  mockRedisGet: vi.fn(),
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
    update: mockDbUpdate,
  },
}))

vi.mock('@/lib/redis', () => ({
  redis: {
    get: mockRedisGet,
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
  const methods = ['from', 'where', 'limit', 'orderBy', 'values', 'returning', 'set', 'execute']
  methods.forEach((m) => { t[m] = () => t })
  return t
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
    mockRedisSet.mockResolvedValue('OK')
    mockDbInsert.mockReturnValue(chain(undefined))
  })

  it('writes to Redis with EX 604800 (7 days)', async () => {
    await createSession('user-1', 'cred-1', { userAgent: 'UA', ip: '1.2.3.4' })

    expect(mockRedisSet).toHaveBeenCalledOnce()
    const [key, data, exFlag, exValue] = mockRedisSet.mock.calls[0]
    expect(key).toMatch(/^session:/)
    expect(exFlag).toBe('EX')
    expect(exValue).toBe(604800)
    const parsed = JSON.parse(data as string)
    expect(parsed.userId).toBe('user-1')
  })

  it('inserts a sessions row into the DB', async () => {
    await createSession('user-1', 'cred-1', { userAgent: 'UA', ip: '1.2.3.4' })
    expect(mockDbInsert).toHaveBeenCalledOnce()
  })

  it('returns the generated sessionId as a non-empty string', async () => {
    const id = await createSession('user-1', null, {})
    expect(typeof id).toBe('string')
    expect(id.length).toBeGreaterThan(0)
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

  it('returns null when the Redis key is missing', async () => {
    mockRedisGet.mockResolvedValue(null)
    const req = fakeRequest('some-session-id')
    const result = await getSession(req)
    expect(result).toBeNull()
  })

  it('returns { sessionId, userId } when the Redis key is present and recent', async () => {
    const sessionData = {
      userId: 'user-abc',
      credentialId: null,
      userAgent: null,
      ip: null,
      lastSeenAt: Date.now(), // fresh — no write-behind triggered
    }
    mockRedisGet.mockResolvedValue(JSON.stringify(sessionData))
    mockRedisSet.mockResolvedValue('OK')
    mockDbUpdate.mockReturnValue(chain(undefined))

    const req = fakeRequest('my-session-id')
    const result = await getSession(req)
    expect(result).toEqual({ sessionId: 'my-session-id', userId: 'user-abc' })
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
    mockDbUpdate.mockReturnValue(chain(undefined))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('does NOT trigger a DB write when lastSeenAt is less than 60 seconds old', async () => {
    const now = Date.now()
    vi.setSystemTime(now)

    const sessionData = {
      userId: 'user-1',
      credentialId: null,
      userAgent: null,
      ip: null,
      lastSeenAt: now - 30_000, // 30 s ago — within the 60 s window
    }
    mockRedisGet.mockResolvedValue(JSON.stringify(sessionData))

    const req = fakeRequest('session-id-fresh')
    await getSession(req)

    expect(mockDbUpdate).not.toHaveBeenCalled()
  })

  it('triggers a fire-and-forget DB write when lastSeenAt is older than 60 seconds', async () => {
    const now = Date.now()
    vi.setSystemTime(now)

    const sessionData = {
      userId: 'user-1',
      credentialId: null,
      userAgent: null,
      ip: null,
      lastSeenAt: now - 61_000, // 61 s ago — outside the window
    }
    mockRedisGet.mockResolvedValue(JSON.stringify(sessionData))

    const req = fakeRequest('session-id-stale')
    await getSession(req)

    // DB update is kicked off fire-and-forget; the mock should have been invoked
    expect(mockDbUpdate).toHaveBeenCalledOnce()
    // Redis was also refreshed
    expect(mockRedisSet).toHaveBeenCalledOnce()
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

  it('deletes the Redis key with the session: prefix', async () => {
    await destroySession('session-xyz')
    expect(mockRedisDel).toHaveBeenCalledWith('session:session-xyz')
  })

  it('sets revokedAt in the DB', async () => {
    await destroySession('session-xyz')
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
    mockDbInsert.mockReturnValue(chain(undefined))
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
    mockDbInsert.mockReturnValue(chain(undefined))
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
