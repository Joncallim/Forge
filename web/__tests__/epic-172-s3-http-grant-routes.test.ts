import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/session', () => ({
  getSession: vi.fn(),
  createSession: vi.fn(),
  destroySession: vi.fn(),
  sessionCookieOptions: vi.fn(),
}))

describe('S3: HTTP grant route authentication gates', () => {
  it('project filesystem-grant GET blocks unauthenticated requests', async () => {
    const { getSession } = await import('@/lib/session')
    ;(getSession as ReturnType<typeof vi.fn>).mockResolvedValue(null)
    const { GET } = await import('@/app/api/projects/[id]/filesystem-grant/route')
    const { NextRequest } = await import('next/server')
    const req = new NextRequest('http://localhost/api/projects/x/filesystem-grant')
    const res = await GET(req, { params: Promise.resolve({ id: 'x' }) })
    expect(res.status).toBe(401)
    const body = await res.json() as { error: string }
    expect(body.error).toBe('Unauthorized')
  })

  it('task filesystem-grants GET blocks unauthenticated requests', async () => {
    const { getSession } = await import('@/lib/session')
    ;(getSession as ReturnType<typeof vi.fn>).mockResolvedValue(null)
    const { GET } = await import('@/app/api/tasks/[id]/filesystem-grants/route')
    const { NextRequest } = await import('next/server')
    const req = new NextRequest('http://localhost/api/tasks/x/filesystem-grants')
    const res = await GET(req, { params: Promise.resolve({ id: 'x' }) })
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'Unauthorized' })
  })
})
