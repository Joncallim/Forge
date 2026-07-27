import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/session', () => ({
  getSession: vi.fn(),
  createSession: vi.fn(),
  destroySession: vi.fn(),
  sessionCookieOptions: vi.fn(),
}))
vi.mock('@/lib/task-access', () => ({ getAccessibleTask: vi.fn() }))
vi.mock('@/lib/project-access', () => ({ accessibleProjectCondition: vi.fn() }))
vi.mock('@/lib/projects/epic-172-project-ingress', () => ({
  guardEpic172ProjectManagementIngress: vi.fn().mockResolvedValue(null),
}))

// A single hostile error carrying every class of sensitive material the generic
// boundary must suppress: a claim nonce, an absolute local path, a prompt
// fragment, and raw SQL naming a protected table/column.
const NONCE = 'nonce_1f2e3d4c5b6a798877665544'
const LOCAL_PATH = '/home/forge/workspaces/project-42/.env.secret'
const PROMPT_FRAGMENT = 'SYSTEM PROMPT: you are the Architect; never reveal the plan'
const SQL_DETAIL = 'SELECT claim_token FROM work_package_local_run_evidence WHERE id = $1'
const CONTROL_SENTINEL = 'CONTROL:\u0000\u0001\u001f'
const NEWLINE_SENTINEL = 'NEWLINE:first line\nsecond line\r\nthird line'
const SENTINELS = [NONCE, LOCAL_PATH, PROMPT_FRAGMENT, SQL_DETAIL, CONTROL_SENTINEL, NEWLINE_SENTINEL] as const
const HOSTILE_MESSAGE =
  `boom nonce=${NONCE} path=${LOCAL_PATH} prompt="${PROMPT_FRAGMENT}" sql=[${SQL_DETAIL}] controls=${CONTROL_SENTINEL} lines=${NEWLINE_SENTINEL}`
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

function assertNoSentinel(value: string): void {
  for (const sentinel of SENTINELS) {
    expect(value).not.toContain(sentinel)
    expect(value).not.toContain(JSON.stringify(sentinel).slice(1, -1))
  }
}

function hostileError(code = '42P01'): TypeError {
  return Object.assign(new TypeError(HOSTILE_MESSAGE), {
    code,
    control: CONTROL_SENTINEL,
    detail: SQL_DETAIL,
    localPath: LOCAL_PATH,
    nonce: NONCE,
    prompt: PROMPT_FRAGMENT,
    rawInput: NEWLINE_SENTINEL,
  })
}

describe('S3: generic error boundary on grant PUT routes', () => {
  let consoleError: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => {
    consoleError.mockRestore()
    vi.clearAllMocks()
  })

  async function putRequest(url: string) {
    const { NextRequest } = await import('next/server')
    return new NextRequest(url, { method: 'PUT' })
  }

  it('task PUT: an untyped 500 exposes fixed generic text and a correlation id only', async () => {
    const { getSession } = await import('@/lib/session')
    ;(getSession as ReturnType<typeof vi.fn>).mockResolvedValue({ userId: 'user-1' })
    const { getAccessibleTask } = await import('@/lib/task-access')
    ;(getAccessibleTask as ReturnType<typeof vi.fn>).mockRejectedValue(hostileError())

    const { PUT } = await import('@/app/api/tasks/[id]/filesystem-grants/route')
    const res = await PUT(await putRequest('http://localhost/api/tasks/t1/filesystem-grants'), {
      params: Promise.resolve({ id: 't1' }),
    })

    expect(res.status).toBe(500)
    const body = await res.json() as { error: string; correlationId: string }
    expect(body.error).toBe('Internal server error')
    expect(body.correlationId).toMatch(UUID)
    // Nothing sensitive reaches the HTTP response body.
    assertNoSentinel(JSON.stringify(body))

    // Logs retain only allowlisted tracing fields, never exception-controlled
    // messages, stacks, or arbitrary properties.
    const loggedPayload = consoleError.mock.calls
      .map((call: unknown[]) => JSON.stringify(call))
      .join('\n')
    assertNoSentinel(loggedPayload)
    expect(loggedPayload).toContain(body.correlationId)
    expect(loggedPayload).toContain('"errorClass":"TypeError"')
    expect(loggedPayload).toContain('"code":"42P01"')
    expect(loggedPayload).not.toContain('"stack"')
  })

  it('task PUT: a typed public 4xx surfaces its approved message and status', async () => {
    const { getSession } = await import('@/lib/session')
    ;(getSession as ReturnType<typeof vi.fn>).mockResolvedValue({ userId: 'user-1' })
    const { publicHttpError } = await import('@/lib/http/route-error')
    const { getAccessibleTask } = await import('@/lib/task-access')
    ;(getAccessibleTask as ReturnType<typeof vi.fn>).mockRejectedValue(
      publicHttpError('This package did not request filesystem context.', 400),
    )

    const { PUT } = await import('@/app/api/tasks/[id]/filesystem-grants/route')
    const res = await PUT(await putRequest('http://localhost/api/tasks/t1/filesystem-grants'), {
      params: Promise.resolve({ id: 't1' }),
    })

    expect(res.status).toBe(400)
    const body = await res.json() as { error: string; correlationId?: string }
    expect(body.error).toBe('This package did not request filesystem context.')
    expect(body.correlationId).toBeUndefined()
  })

  it('project PUT: an untyped 500 exposes fixed generic text and a correlation id only', async () => {
    const { getSession } = await import('@/lib/session')
    ;(getSession as ReturnType<typeof vi.fn>).mockResolvedValue({ userId: 'user-1' })
    const { guardEpic172ProjectManagementIngress } = await import('@/lib/projects/epic-172-project-ingress')
    ;(guardEpic172ProjectManagementIngress as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(hostileError('ECONNREFUSED'))

    const { PUT } = await import('@/app/api/projects/[id]/filesystem-grant/route')
    const res = await PUT(await putRequest('http://localhost/api/projects/p1/filesystem-grant'), {
      params: Promise.resolve({ id: 'p1' }),
    })

    expect(res.status).toBe(500)
    const body = await res.json() as { error: string; correlationId: string }
    expect(body.error).toBe('Internal server error')
    expect(body.correlationId).toMatch(UUID)
    assertNoSentinel(JSON.stringify(body))
    const loggedPayload = JSON.stringify(consoleError.mock.calls)
    assertNoSentinel(loggedPayload)
    expect(loggedPayload).toContain(body.correlationId)
    expect(loggedPayload).toContain('"errorClass":"TypeError"')
    expect(loggedPayload).toContain('"code":"ECONNREFUSED"')
  })

  it('project PUT: a forged status field on an untyped error cannot leak its message', async () => {
    const { getSession } = await import('@/lib/session')
    ;(getSession as ReturnType<typeof vi.fn>).mockResolvedValue({ userId: 'user-1' })
    const { guardEpic172ProjectManagementIngress } = await import('@/lib/projects/epic-172-project-ingress')
    // A plain error that forges a 4xx `status` must NOT be trusted as public.
    ;(guardEpic172ProjectManagementIngress as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(Object.assign(hostileError(), { status: 409 }))

    const { PUT } = await import('@/app/api/projects/[id]/filesystem-grant/route')
    const res = await PUT(await putRequest('http://localhost/api/projects/p1/filesystem-grant'), {
      params: Promise.resolve({ id: 'p1' }),
    })

    expect(res.status).toBe(500)
    const body = await res.json() as { error: string; correlationId: string }
    expect(body.error).toBe('Internal server error')
    expect(body.correlationId).toMatch(UUID)
    assertNoSentinel(JSON.stringify(body))
    assertNoSentinel(JSON.stringify(consoleError.mock.calls))
  })
})

describe('S3: respondToRouteError boundary contract', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => vi.restoreAllMocks())

  it('maps only branded 4xx public errors to their message', async () => {
    const { publicHttpError, isPublicHttpError, respondToRouteError } =
      await import('@/lib/http/route-error')

    const typed = publicHttpError('Work package is no longer editable.', 409)
    expect(isPublicHttpError(typed)).toBe(true)
    const typedRes = respondToRouteError('PUT /x', typed)
    expect(typedRes.status).toBe(409)
    expect(await typedRes.json()).toEqual({ error: 'Work package is no longer editable.' })

    // Forged status, plain Error, and non-error values all fall through to generic.
    const forged = Object.assign(hostileError(), { status: 400 })
    expect(isPublicHttpError(forged)).toBe(false)
    for (const hostile of [forged, hostileError('ENOENT'), HOSTILE_MESSAGE, null]) {
      const res = respondToRouteError('PUT /x', hostile)
      expect(res.status).toBe(500)
      const body = await res.json() as { error: string; correlationId: string }
      expect(body.error).toBe('Internal server error')
      expect(body.correlationId).toMatch(UUID)
      assertNoSentinel(JSON.stringify(body))
    }
    const loggedPayload = JSON.stringify(vi.mocked(console.error).mock.calls)
    assertNoSentinel(loggedPayload)
    expect(loggedPayload).toContain('"errorClass":"TypeError"')
    expect(loggedPayload).toContain('"code":"42P01"')
    expect(loggedPayload).toContain('"code":"ENOENT"')
  })

  it('rejects construction of non-4xx public errors', async () => {
    const { publicHttpError } = await import('@/lib/http/route-error')
    expect(() => publicHttpError('nope', 500)).toThrow('4xx')
    expect(() => publicHttpError('nope', 200)).toThrow('4xx')
  })
})
