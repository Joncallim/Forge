import { NextRequest, NextResponse } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { VerificationGoalContractError } from '@/lib/verification-goals/contracts'
import { VerificationGoalRegistryError } from '@/lib/verification-goals/registry'
import { VerificationGoalImportError } from '@/worker/verification-goals/importer'
import { VerificationGoalSnapshotConflictError } from '@/worker/verification-goals/snapshots'

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  getAccessibleProject: vi.fn(),
  guardIngress: vi.fn(),
  importRegistry: vi.fn(),
}))

vi.mock('@/lib/session', () => ({ getSession: mocks.getSession }))
vi.mock('@/lib/project-access', () => ({ getAccessibleProject: mocks.getAccessibleProject }))
vi.mock('@/lib/projects/epic-172-project-ingress', () => ({
  guardEpic172ProjectManagementIngress: mocks.guardIngress,
}))
vi.mock('@/worker/verification-goals/importer', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/worker/verification-goals/importer')>(),
  importVerificationGoalRegistry: mocks.importRegistry,
}))

import { POST, runtime } from '@/app/api/projects/[id]/verification-goals/import/route'

const PROJECT_ID = '11111111-1111-4111-8111-111111111111'
const USER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const REGISTRY_REVISION_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const MANIFEST_DIGEST = 'c'.repeat(64)
const ROUTE_CONTEXT = { params: Promise.resolve({ id: PROJECT_ID }) }

function request(body?: string): NextRequest {
  return new NextRequest(`http://localhost/api/projects/${PROJECT_ID}/verification-goals/import`, {
    method: 'POST',
    ...(body === undefined ? {} : { body }),
  })
}

describe('POST /api/projects/:id/verification-goals/import', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getSession.mockResolvedValue({ userId: USER_ID })
    mocks.guardIngress.mockResolvedValue(null)
    mocks.getAccessibleProject.mockResolvedValue({ id: PROJECT_ID, archivedAt: null })
    mocks.importRegistry.mockResolvedValue({
      registryRevisionId: REGISTRY_REVISION_ID,
      manifestDigest: MANIFEST_DIGEST,
      headState: 'advanced',
      snapshots: [{
        snapshotId: '22222222-2222-4222-8222-222222222222',
        goalId: 'goal-one',
        definitionVersion: 1,
        kind: 'inserted',
      }],
    })
  })

  it('uses the Node runtime', () => {
    expect(runtime).toBe('nodejs')
  })

  it('returns 401 before the ingress gate, access lookup, or importer for an unauthenticated caller', async () => {
    mocks.getSession.mockResolvedValue(null)
    const unauthorizedRequest = request('{"projectRoot":"/private/unauthorized"}')

    const response = await POST(unauthorizedRequest, ROUTE_CONTEXT)

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' })
    expect(mocks.guardIngress).not.toHaveBeenCalled()
    expect(mocks.getAccessibleProject).not.toHaveBeenCalled()
    expect(mocks.importRegistry).not.toHaveBeenCalled()
    await expect(unauthorizedRequest.text()).resolves.toBe('{"projectRoot":"/private/unauthorized"}')
  })

  it('returns the fail-closed project-management response before project access or import', async () => {
    mocks.guardIngress.mockResolvedValue(NextResponse.json(
      {
        error: 'Project management is temporarily disabled while release safety checks are incomplete.',
        code: 'epic_172_project_management_ingress_closed',
        reason: 'database_unavailable',
      },
      { status: 503 },
    ))

    const response = await POST(request(), ROUTE_CONTEXT)

    expect(response.status).toBe(503)
    expect(mocks.guardIngress).toHaveBeenCalledOnce()
    expect(mocks.getAccessibleProject).not.toHaveBeenCalled()
    expect(mocks.importRegistry).not.toHaveBeenCalled()
  })

  it('returns 404 and does not import when the project is inaccessible', async () => {
    mocks.getAccessibleProject.mockResolvedValue(null)

    const response = await POST(request('{"goalId":"inaccessible"}'), ROUTE_CONTEXT)

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toEqual({ error: 'Project not found' })
    expect(mocks.getAccessibleProject).toHaveBeenCalledWith(PROJECT_ID, USER_ID)
    expect(mocks.importRegistry).not.toHaveBeenCalled()
  })

  it('returns 404 through the access seam and does not import an archived project', async () => {
    mocks.getAccessibleProject.mockResolvedValue({
      id: PROJECT_ID,
      archivedAt: new Date('2026-08-15T00:00:00.000Z'),
    })

    const response = await POST(request('{"goalId":"archived"}'), ROUTE_CONTEXT)

    expect(response.status).toBe(404)
    expect(mocks.getAccessibleProject).toHaveBeenCalledWith(PROJECT_ID, USER_ID)
    expect(mocks.importRegistry).not.toHaveBeenCalled()
  })

  it('returns a stable 400 for an invalid project id without querying project access', async () => {
    const response = await POST(request(), {
      params: Promise.resolve({ id: 'not-a-project-id' }),
    })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      error: 'Invalid project id.',
      code: 'invalid_project_id',
    })
    expect(mocks.getAccessibleProject).not.toHaveBeenCalled()
    expect(mocks.importRegistry).not.toHaveBeenCalled()
  })

  it('canonicalizes an uppercase project id before access, import, and response serialization', async () => {
    const uppercaseProjectId = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA'
    const canonicalProjectId = uppercaseProjectId.toLowerCase()
    mocks.getAccessibleProject.mockResolvedValue({ id: canonicalProjectId, archivedAt: null })

    const response = await POST(request(), {
      params: Promise.resolve({ id: uppercaseProjectId }),
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      schemaVersion: 2,
      projectId: canonicalProjectId,
      registryRevisionId: REGISTRY_REVISION_ID,
      manifestDigest: MANIFEST_DIGEST,
      headState: 'advanced',
    })
    expect(mocks.getAccessibleProject).toHaveBeenCalledWith(canonicalProjectId, USER_ID)
    expect(mocks.importRegistry).toHaveBeenCalledWith({
      projectId: canonicalProjectId,
      actorUserId: USER_ID,
    })
  })

  it('rejects any caller body without consuming it or passing caller data to the importer', async () => {
    const callerData = JSON.stringify({
      projectRoot: '/private/secret-project',
      definition: { goalId: 'caller-goal' },
      operationArguments: ['--unsafe'],
    })
    const bodyRequest = request(callerData)
    const response = await POST(bodyRequest, ROUTE_CONTEXT)

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      error: 'This endpoint does not accept a request body.',
      code: 'unexpected_request_body',
    })
    expect(mocks.importRegistry).not.toHaveBeenCalled()
    expect(mocks.getAccessibleProject).toHaveBeenCalledWith(PROJECT_ID, USER_ID)
    await expect(bodyRequest.text()).resolves.toBe(callerData)
  })

  it('returns only deterministic inserted and existing snapshot results', async () => {
    mocks.importRegistry.mockResolvedValue({
      registryRevisionId: REGISTRY_REVISION_ID,
      manifestDigest: MANIFEST_DIGEST,
      headState: 'advanced',
      snapshots: [
        {
          snapshotId: '33333333-3333-4333-8333-333333333333',
          goalId: 'z-goal',
          definitionVersion: 2,
          kind: 'existing',
        },
        {
          snapshotId: '22222222-2222-4222-8222-222222222222',
          goalId: 'a-goal',
          definitionVersion: 1,
          kind: 'inserted',
        },
      ],
    })

    const response = await POST(request(), ROUTE_CONTEXT)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      schemaVersion: 2,
      projectId: PROJECT_ID,
      registryRevisionId: REGISTRY_REVISION_ID,
      manifestDigest: MANIFEST_DIGEST,
      headState: 'advanced',
      snapshots: [
        {
          snapshotId: '22222222-2222-4222-8222-222222222222',
          goalId: 'a-goal',
          definitionVersion: 1,
          state: 'inserted',
        },
        {
          snapshotId: '33333333-3333-4333-8333-333333333333',
          goalId: 'z-goal',
          definitionVersion: 2,
          state: 'existing',
        },
      ],
      summary: { total: 2, inserted: 1, existing: 1 },
    })
    expect(mocks.importRegistry).toHaveBeenCalledOnce()
    expect(mocks.importRegistry).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      actorUserId: USER_ID,
    })
  })

  it('keeps repeated existing imports idempotent and caller-input free', async () => {
    const existing = [{
      snapshotId: '22222222-2222-4222-8222-222222222222',
      goalId: 'goal-one',
      definitionVersion: 1,
      kind: 'existing',
    }]
    mocks.importRegistry.mockResolvedValue({
      registryRevisionId: REGISTRY_REVISION_ID,
      manifestDigest: MANIFEST_DIGEST,
      headState: 'existing',
      snapshots: existing,
    })

    const first = await POST(request(), ROUTE_CONTEXT)
    const second = await POST(request(), ROUTE_CONTEXT)

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    const expectedResponse = {
      schemaVersion: 2,
      projectId: PROJECT_ID,
      registryRevisionId: REGISTRY_REVISION_ID,
      manifestDigest: MANIFEST_DIGEST,
      headState: 'existing',
      snapshots: [{
        snapshotId: '22222222-2222-4222-8222-222222222222',
        goalId: 'goal-one',
        definitionVersion: 1,
        state: 'existing',
      }],
      summary: { total: 1, inserted: 0, existing: 1 },
    }
    expect(await first.json()).toEqual(expectedResponse)
    expect(await second.json()).toEqual(expectedResponse)
    expect(mocks.importRegistry).toHaveBeenCalledTimes(2)
    expect(mocks.importRegistry).toHaveBeenNthCalledWith(1, {
      projectId: PROJECT_ID,
      actorUserId: USER_ID,
    })
    expect(mocks.importRegistry).toHaveBeenNthCalledWith(2, {
      projectId: PROJECT_ID,
      actorUserId: USER_ID,
    })
  })

  it('returns a successful empty authoritative import when the project registry is absent or empty', async () => {
    mocks.importRegistry.mockResolvedValue({
      registryRevisionId: REGISTRY_REVISION_ID,
      manifestDigest: MANIFEST_DIGEST,
      headState: 'advanced',
      snapshots: [],
    })

    const response = await POST(request(), ROUTE_CONTEXT)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      schemaVersion: 2,
      projectId: PROJECT_ID,
      registryRevisionId: REGISTRY_REVISION_ID,
      manifestDigest: MANIFEST_DIGEST,
      headState: 'advanced',
      snapshots: [],
      summary: { total: 0, inserted: 0, existing: 0 },
    })
  })

  it('returns a redacted 409 for an immutable snapshot conflict', async () => {
    mocks.importRegistry.mockRejectedValue(new VerificationGoalSnapshotConflictError({
      projectId: PROJECT_ID,
      goalId: 'private-goal-id',
      definitionVersion: 7,
    }))

    const response = await POST(request(), ROUTE_CONTEXT)
    const text = await response.text()

    expect(response.status).toBe(409)
    expect(JSON.parse(text)).toEqual({
      error: 'A verification goal version conflicts with an existing snapshot.',
      code: 'definition_version_conflict',
    })
    expect(text).not.toContain('private-goal-id')
    expect(text).not.toContain(PROJECT_ID)
  })

  it.each([
    new VerificationGoalRegistryError(
      'invalid_file',
      '/private/secret-project/.forge/verification-goals/a.json contains parser text: TOP SECRET',
    ),
    new VerificationGoalContractError(
      'invalid_definition',
      'Untrusted definition text TOP SECRET from /private/secret-project.',
    ),
  ])('returns a bounded, redacted 422 for an expected malformed or unsafe registry failure', async (failure) => {
    mocks.importRegistry.mockRejectedValue(failure)

    const response = await POST(request(), ROUTE_CONTEXT)
    const text = await response.text()

    expect(response.status).toBe(422)
    expect(JSON.parse(text)).toEqual({
      error: 'The verification goal registry is invalid or unsafe.',
      code: 'invalid_verification_goal_registry',
    })
    expect(text).not.toContain('/private/secret-project')
    expect(text).not.toContain('TOP SECRET')
  })

  it('returns a fixed 409 for a typed unavailable project repository', async () => {
    mocks.importRegistry.mockRejectedValue(
      new VerificationGoalImportError('project_repository_unavailable'),
    )

    const response = await POST(request(), ROUTE_CONTEXT)
    const text = await response.text()

    expect(response.status).toBe(409)
    expect(JSON.parse(text)).toEqual({
      error: 'The project repository is unavailable for verification goal import.',
      code: 'project_repository_unavailable',
    })
    expect(text).not.toContain('/private/secret-project')
  })

  it('returns a fixed 409 for typed project-context loss', async () => {
    mocks.importRegistry.mockRejectedValue(
      new VerificationGoalImportError('project_context_unavailable'),
    )

    const response = await POST(request(), ROUTE_CONTEXT)

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({
      error: 'The project context is no longer available for verification goal import.',
      code: 'project_context_unavailable',
    })
  })

  it.each([
    ['project_authority_changed', 'The project authority changed during verification goal import.'],
    ['registry_head_changed', 'The verification goal registry changed during import. Retry the request.'],
  ] as const)('returns a fixed 409 for typed %s conflicts', async (code, error) => {
    mocks.importRegistry.mockRejectedValue(new VerificationGoalImportError(code))

    const response = await POST(request(), ROUTE_CONTEXT)

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({ error, code })
  })

  it('returns a fixed 400 for a typed importer project-id rejection', async () => {
    mocks.importRegistry.mockRejectedValue(
      new VerificationGoalImportError('invalid_project_id'),
    )

    const response = await POST(request(), ROUTE_CONTEXT)

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      error: 'Invalid project id.',
      code: 'invalid_project_id',
    })
  })

  it.each([
    Object.assign(new Error('filesystem failed at /private/secret-project'), { code: 'EIO' }),
    new Error('database failed with password TOP SECRET at /private/secret-project'),
  ])('returns a generic correlated 500 for unexpected filesystem or database failures', async (failure) => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    mocks.importRegistry.mockRejectedValue(failure)

    try {
      const response = await POST(request(), ROUTE_CONTEXT)
      const text = await response.text()
      const body = JSON.parse(text) as { error: string; correlationId: string }

      expect(response.status).toBe(500)
      expect(body.error).toBe('Internal server error')
      expect(body.correlationId).toMatch(/^[0-9a-f-]{36}$/u)
      expect(text).not.toContain('TOP SECRET')
      expect(text).not.toContain('/private/secret-project')
      expect(consoleError).toHaveBeenCalledWith(
        '[POST /api/projects/:id/verification-goals/import] Unexpected error',
        expect.objectContaining({
          route: 'POST /api/projects/:id/verification-goals/import',
          errorClass: 'Error',
          correlationId: body.correlationId,
        }),
      )
    } finally {
      consoleError.mockRestore()
    }
  })
})
