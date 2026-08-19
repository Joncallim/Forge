import { NextRequest, NextResponse } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  getAccessibleProject: vi.fn(),
  guardIngress: vi.fn(),
  dbExecute: vi.fn(),
  seedPolicy: vi.fn(),
  admit: vi.fn(),
  executeRun: vi.fn(),
  resolveExecutables: vi.fn(),
}))

vi.mock('@/lib/session', () => ({ getSession: mocks.getSession }))
vi.mock('@/lib/project-access', () => ({ getAccessibleProject: mocks.getAccessibleProject }))
vi.mock('@/lib/projects/epic-172-project-ingress', () => ({
  guardEpic172ProjectManagementIngress: mocks.guardIngress,
}))
vi.mock('@/db', () => ({ db: { execute: mocks.dbExecute } }))
vi.mock('@/worker/verification-goals/policy', () => ({
  seedVerificationGoalPolicy: mocks.seedPolicy,
}))
vi.mock('@/worker/verification-goals/admission', () => ({
  admitManualVerificationGoalRun: mocks.admit,
}))
vi.mock('@/worker/verification-goals/runner', () => ({
  executeVerificationGoalRun: mocks.executeRun,
}))
vi.mock('@/worker/verification-goals/trusted-executables', () => ({
  resolveTrustedExecutables: mocks.resolveExecutables,
}))

import { GET, POST, runtime } from '@/app/api/projects/[id]/verification-goals/[goalId]/runs/route'

const PROJECT_ID = '11111111-1111-4111-8111-111111111111'
const USER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const GOAL_ID = 'goal-one'
const IDEMPOTENCY_KEY = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const RUN_ID = '22222222-2222-4222-8222-222222222222'
const POLICY_REVISION_ID = '77777777-7777-4777-8777-777777777777'
const REGISTRY_REVISION_ID = '55555555-5555-4555-8555-555555555555'
const SNAPSHOT_ID = '33333333-3333-4333-8333-333333333333'

const ROUTE_CONTEXT = {
  params: Promise.resolve({ id: PROJECT_ID, goalId: GOAL_ID }),
}

function postRequest(options: { idempotencyKey?: string; body?: string } = {}): NextRequest {
  return new NextRequest(
    `http://localhost/api/projects/${PROJECT_ID}/verification-goals/${GOAL_ID}/runs`,
    {
      method: 'POST',
      headers: { 'Idempotency-Key': options.idempotencyKey ?? IDEMPOTENCY_KEY },
      ...(options.body === undefined ? {} : { body: options.body }),
    },
  )
}

function getRequest(): NextRequest {
  return new NextRequest(
    `http://localhost/api/projects/${PROJECT_ID}/verification-goals/${GOAL_ID}/runs`,
    { method: 'GET' },
  )
}

function entryFixture(overrides: Record<string, unknown> = {}) {
  return {
    registry_revision_id: REGISTRY_REVISION_ID,
    ordinal: 0,
    snapshot_id: SNAPSHOT_ID,
    definition_version: 1,
    definition_digest: 'a'.repeat(64),
    source_path: '.forge/verification-goals/goal-one.json',
    execution_binding_digest: null,
    canonical_definition: {
      schemaVersion: 2,
      goalId: GOAL_ID,
      definitionVersion: 1,
      title: 'Status is readable',
      description: 'Prove the repository status read.',
      capability: 'filesystem.project.read',
      severity: 'medium',
      enabled: true,
      operations: [{ operationId: 'repository.status.read', operationVersion: 1 }],
      execution: {
        manual: true,
        schedule: null,
        deadlineSeconds: 60,
        requiredEvidence: ['repository_identity', 'execution_environment'],
      },
    },
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getSession.mockResolvedValue({ userId: USER_ID })
  mocks.guardIngress.mockResolvedValue(null)
  mocks.getAccessibleProject.mockResolvedValue({ id: PROJECT_ID, archivedAt: null })
  mocks.dbExecute.mockReset()
  mocks.seedPolicy.mockResolvedValue({ policyRevisionId: POLICY_REVISION_ID, revisionSequence: BigInt(1) })
  mocks.admit.mockResolvedValue({ runId: RUN_ID, state: 'created' })
  mocks.resolveExecutables.mockResolvedValue({
    schemaVersion: 1,
    node: {},
    git: {},
  })
  mocks.executeRun.mockResolvedValue({ result: 'passed', terminalCode: 'passed' })
})

describe('POST /api/projects/:id/verification-goals/:goalId/runs', () => {
  it('uses the Node runtime', () => {
    expect(runtime).toBe('nodejs')
  })

  it('admits and synchronously executes a manual run for an enabled goal', async () => {
    mocks.dbExecute
      .mockResolvedValueOnce([])            // policy head: none yet
      .mockResolvedValueOnce([entryFixture()])

    const response = await POST(postRequest(), ROUTE_CONTEXT)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      runId: RUN_ID,
      state: 'created',
      result: 'passed',
      terminalCode: 'passed',
    })
    expect(mocks.admit).toHaveBeenCalledOnce()
    expect(mocks.admit).toHaveBeenCalledWith(expect.objectContaining({
      requestedByUserId: USER_ID,
      manualIdempotencyKey: IDEMPOTENCY_KEY,
      policyRevisionId: POLICY_REVISION_ID,
      policyRevisionSequence: BigInt(1),
      snapshotId: SNAPSHOT_ID,
      registryRevisionId: REGISTRY_REVISION_ID,
    }))
    expect(mocks.resolveExecutables).toHaveBeenCalledOnce()
    expect(mocks.executeRun).toHaveBeenCalledOnce()
  })

  it('returns 401 before the ingress gate, access lookup, or admission for an unauthenticated caller', async () => {
    mocks.getSession.mockResolvedValue(null)

    const response = await POST(postRequest(), ROUTE_CONTEXT)

    expect(response.status).toBe(401)
    expect(mocks.guardIngress).not.toHaveBeenCalled()
    expect(mocks.getAccessibleProject).not.toHaveBeenCalled()
    expect(mocks.admit).not.toHaveBeenCalled()
  })

  it('returns the fail-closed project-management response before any admission work', async () => {
    mocks.guardIngress.mockResolvedValue(NextResponse.json(
      {
        error: 'Project management is temporarily disabled while release safety checks are incomplete.',
        code: 'epic_172_project_management_ingress_closed',
        reason: 'database_unavailable',
      },
      { status: 503 },
    ))

    const response = await POST(postRequest(), ROUTE_CONTEXT)

    expect(response.status).toBe(503)
    expect(mocks.getAccessibleProject).not.toHaveBeenCalled()
    expect(mocks.admit).not.toHaveBeenCalled()
  })

  it('returns 400 for an invalid project id without querying access', async () => {
    const response = await POST(postRequest(), {
      params: Promise.resolve({ id: 'not-a-project-id', goalId: GOAL_ID }),
    })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      error: 'Invalid project id.',
      code: 'invalid_project_id',
    })
    expect(mocks.getAccessibleProject).not.toHaveBeenCalled()
    expect(mocks.admit).not.toHaveBeenCalled()
  })

  it('returns 400 when the Idempotency-Key header is not a UUID', async () => {
    const response = await POST(postRequest({ idempotencyKey: 'not-a-uuid' }), ROUTE_CONTEXT)

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      error: 'A valid UUID Idempotency-Key header is required.',
      code: 'invalid_idempotency_key',
    })
    expect(mocks.admit).not.toHaveBeenCalled()
  })

  it('returns 404 and does not admit a run when the project is inaccessible or archived', async () => {
    mocks.getAccessibleProject.mockResolvedValue({
      id: PROJECT_ID,
      archivedAt: new Date('2026-08-15T00:00:00.000Z'),
    })

    const response = await POST(postRequest(), ROUTE_CONTEXT)

    expect(response.status).toBe(404)
    expect(mocks.admit).not.toHaveBeenCalled()
  })

  it('rejects any caller body without consuming it or passing caller data to admission', async () => {
    const callerData = JSON.stringify({ goalId: 'caller-goal', operations: ['--unsafe'] })
    const bodyRequest = postRequest({ body: callerData })

    const response = await POST(bodyRequest, ROUTE_CONTEXT)

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      error: 'This endpoint does not accept a request body.',
      code: 'unexpected_request_body',
    })
    expect(mocks.dbExecute).not.toHaveBeenCalled()
    expect(mocks.admit).not.toHaveBeenCalled()
  })

  it('returns 404 when the goal has no current registry entry', async () => {
    mocks.dbExecute
      .mockResolvedValueOnce([])            // policy head: none yet
      .mockResolvedValueOnce([])            // no registry entry

    const response = await POST(postRequest(), ROUTE_CONTEXT)

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toEqual({
      error: 'Goal not found in the current registry.',
      code: 'goal_not_found',
    })
    expect(mocks.admit).not.toHaveBeenCalled()
  })

  it('returns 409 for a disabled goal without executing', async () => {
    mocks.dbExecute
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([entryFixture({ canonical_definition: { ...entryFixture().canonical_definition, enabled: false } })])

    const response = await POST(postRequest(), ROUTE_CONTEXT)

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({
      error: 'Verification goal is disabled.',
      code: 'goal_disabled',
    })
    expect(mocks.admit).not.toHaveBeenCalled()
    expect(mocks.executeRun).not.toHaveBeenCalled()
  })

  it('returns 409 for a goal that is not manually executable without executing', async () => {
    mocks.dbExecute
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([entryFixture({
        canonical_definition: {
          ...entryFixture().canonical_definition,
          execution: { manual: false, schedule: null, deadlineSeconds: 60, requiredEvidence: [] },
        },
      })])

    const response = await POST(postRequest(), ROUTE_CONTEXT)

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({
      error: 'Goal is not executable manually.',
      code: 'manual_execution_disabled',
    })
    expect(mocks.admit).not.toHaveBeenCalled()
    expect(mocks.executeRun).not.toHaveBeenCalled()
  })

  it.each([
    ['P1871', 409, 'execution_unavailable', 'Verification goal execution is unavailable for this project.'],
    ['P1872', 409, 'policy_or_lease_changed', 'Project verification policy or lease state changed. Retry the request.'],
    ['P1873', 409, 'execution_denied', 'Verification goal is not executable under the current project policy or registry state.'],
    ['P1874', 429, 'capacity_limit', 'Verification goal capacity limit reached. Retry later.'],
    ['P1876', 409, 'idempotency_conflict', 'The Idempotency-Key was already used for a different request.'],
  ] as const)('maps SQLSTATE %s to a bounded %i %s response', async (sqlState, status, code, error) => {
    mocks.dbExecute.mockImplementation(async () => {
      throw Object.assign(new Error('untrusted PostgreSQL detail'), { code: sqlState })
    })

    const response = await POST(postRequest(), ROUTE_CONTEXT)
    const text = await response.text()

    expect(response.status).toBe(status)
    expect(JSON.parse(text)).toEqual({ error, code })
    expect(text).not.toContain('untrusted PostgreSQL detail')
    expect(mocks.admit).not.toHaveBeenCalled()
  })

  it('returns a generic correlated 500 for unexpected failures without leaking detail', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    mocks.dbExecute.mockImplementation(async () => {
      throw new Error('database failed with password TOP SECRET at /private/secret-project')
    })

    try {
      const response = await POST(postRequest(), ROUTE_CONTEXT)
      const text = await response.text()
      const body = JSON.parse(text) as { error: string; correlationId: string }

      expect(response.status).toBe(500)
      expect(body.error).toBe('Internal server error')
      expect(body.correlationId).toMatch(/^[0-9a-f-]{36}$/u)
      expect(text).not.toContain('TOP SECRET')
      expect(text).not.toContain('/private/secret-project')
    } finally {
      consoleError.mockRestore()
    }
  })
})

describe('GET /api/projects/:id/verification-goals/:goalId/runs', () => {
  it('lists recent runs in reverse chronological order with stable serialization', async () => {
    mocks.dbExecute.mockResolvedValueOnce([
      {
        id: RUN_ID,
        status: 'completed',
        result: 'passed',
        terminal_code: 'passed',
        created_at: new Date('2026-08-15T00:00:00.000Z'),
        finished_at: null,
      },
      {
        id: '99999999-9999-4999-8999-999999999999',
        status: 'queued',
        result: null,
        terminal_code: null,
        created_at: new Date('2026-08-14T00:00:00.000Z'),
        finished_at: new Date('2026-08-14T00:05:00.000Z'),
      },
    ])

    const response = await GET(getRequest(), ROUTE_CONTEXT)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      runs: [
        {
          runId: RUN_ID,
          status: 'completed',
          result: 'passed',
          terminalCode: 'passed',
          createdAt: '2026-08-15T00:00:00.000Z',
          finishedAt: null,
        },
        {
          runId: '99999999-9999-4999-8999-999999999999',
          status: 'queued',
          result: null,
          terminalCode: null,
          createdAt: '2026-08-14T00:00:00.000Z',
          finishedAt: '2026-08-14T00:05:00.000Z',
        },
      ],
    })
  })

  it('returns 401 before any project access for an unauthenticated caller', async () => {
    mocks.getSession.mockResolvedValue(null)

    const response = await GET(getRequest(), ROUTE_CONTEXT)

    expect(response.status).toBe(401)
    expect(mocks.getAccessibleProject).not.toHaveBeenCalled()
    expect(mocks.dbExecute).not.toHaveBeenCalled()
  })

  it('returns 404 for an inaccessible or archived project without listing runs', async () => {
    mocks.getAccessibleProject.mockResolvedValue(null)

    const response = await GET(getRequest(), ROUTE_CONTEXT)

    expect(response.status).toBe(404)
    expect(mocks.dbExecute).not.toHaveBeenCalled()
  })
})
