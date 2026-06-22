import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockGetSession = vi.fn()
vi.mock('@/lib/session', () => ({ getSession: mockGetSession }))

const mockInsert = vi.fn(() => ({ values: () => ({ onConflictDoUpdate: () => Promise.resolve() }) }))
const mockDelete = vi.fn(() => ({ where: () => Promise.resolve() }))
const mockSelect = vi.fn(() => {
  const chain: Record<string, unknown> = {}
  for (const m of ['from', 'where', 'limit']) chain[m] = () => chain
  ;(chain as { then: unknown }).then = (f: (v: unknown) => unknown) => Promise.resolve([]).then(f)
  return chain
})
vi.mock('@/db', () => ({ db: { insert: mockInsert, delete: mockDelete, select: mockSelect } }))

vi.mock('@/lib/crypto', () => ({
  encryptSecret: (s: string) => `enc:${s}`,
  decryptSecret: (s: string) => s.replace(/^enc:/, ''),
}))

const FAKE_SESSION = { sessionId: 'sess-1', userId: 'user-1' }

function req(body?: unknown) {
  return new Request('http://localhost/api/github/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

describe('POST /api/github/token', () => {
  beforeEach(() => { vi.clearAllMocks() })
  afterEach(() => { vi.unstubAllGlobals() })

  it('returns 401 when not authenticated', async () => {
    mockGetSession.mockResolvedValue(null)
    const { POST } = await import('@/app/api/github/token/route')
    const res = await POST(req({ token: 'ghp_x' }) as never)
    expect(res.status).toBe(401)
  })

  it('returns 400 when GitHub rejects the token', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }))
    const { POST } = await import('@/app/api/github/token/route')
    const res = await POST(req({ token: 'ghp_bad' }) as never)
    expect(res.status).toBe(400)
    expect(mockInsert).not.toHaveBeenCalled()
  })

  it('stores the token and returns the login on success', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ login: 'octocat' }),
    }))
    const { POST } = await import('@/app/api/github/token/route')
    const res = await POST(req({ token: 'ghp_good' }) as never)
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.login).toBe('octocat')
    expect(mockInsert).toHaveBeenCalled()
  })

  it('returns 400 when the token is missing', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    const { POST } = await import('@/app/api/github/token/route')
    const res = await POST(req({}) as never)
    expect(res.status).toBe(400)
  })
})

describe('GET /api/github/status', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('returns 401 when not authenticated', async () => {
    mockGetSession.mockResolvedValue(null)
    const { GET } = await import('@/app/api/github/status/route')
    const res = await GET(new Request('http://localhost/api/github/status') as never)
    expect(res.status).toBe(401)
  })
})
