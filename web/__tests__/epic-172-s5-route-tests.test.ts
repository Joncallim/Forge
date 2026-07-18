import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/session', () => ({
  getSession: vi.fn(),
  createSession: vi.fn(), destroySession: vi.fn(), sessionCookieOptions: vi.fn(),
}))

vi.mock('@/lib/task-access', () => ({
  getAccessibleTask: vi.fn(),
}))

const mockDbSelect = () => ({
  from: vi.fn().mockReturnValue({
    where: vi.fn().mockReturnValue({ orderBy: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([]) }) }),
  }),
})

vi.mock('@/db', () => ({ db: { select: vi.fn().mockReturnValue(mockDbSelect()), update: vi.fn().mockReturnValue({ set: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([]) }) }) }) } }))

vi.mock('server-only', () => ({ default: {} }))

describe('S5: MCP route ACL enforcement', () => {
  it('admission GET rejects unauthenticated', async () => {
    const { getSession } = await import('@/lib/session')
    ;(getSession as ReturnType<typeof vi.fn>).mockResolvedValue(null)
    const { GET } = await import('@/app/api/mcps/admission/[taskId]/route')
    const { NextRequest } = await import('next/server')
    const res = await GET(new NextRequest('http://x/api/mcps/admission/t1'), { params: Promise.resolve({ taskId: 't1' }) })
    expect(res.status).toBe(401)
  })

  it('admission GET rejects non-owner', async () => {
    const { getSession } = await import('@/lib/session')
    const { getAccessibleTask } = await import('@/lib/task-access')
    ;(getSession as ReturnType<typeof vi.fn>).mockResolvedValue({ userId: 'u1', credentialId: null })
    ;(getAccessibleTask as ReturnType<typeof vi.fn>).mockResolvedValue({ submittedBy: 'u2', id: 't1' })
    const { GET } = await import('@/app/api/mcps/admission/[taskId]/route')
    const { NextRequest } = await import('next/server')
    const res = await GET(new NextRequest('http://x/api/mcps/admission/t1'), { params: Promise.resolve({ taskId: 't1' }) })
    expect(res.status).toBe(404)
  })

  it('presentation GET rejects unauthenticated', async () => {
    const { getSession } = await import('@/lib/session')
    ;(getSession as ReturnType<typeof vi.fn>).mockResolvedValue(null)
    const { GET } = await import('@/app/api/mcps/presentation/[taskId]/route')
    const { NextRequest } = await import('next/server')
    const res = await GET(new NextRequest('http://x/api/mcps/presentation/t1'), { params: Promise.resolve({ taskId: 't1' }) })
    expect(res.status).toBe(401)
  })
})
