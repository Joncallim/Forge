import { NextResponse, type NextRequest } from 'next/server'

import { respondToRouteError } from '@/lib/http/route-error'
import { getAccessibleProject } from '@/lib/project-access'
import { guardEpic172ProjectManagementIngress } from '@/lib/projects/epic-172-project-ingress'
import { getSession } from '@/lib/session'
import { VerificationGoalContractError } from '@/lib/verification-goals/contracts'
import { VerificationGoalRegistryError } from '@/lib/verification-goals/registry'
import {
  importVerificationGoalRegistry,
  VerificationGoalImportError,
} from '@/worker/verification-goals/importer'
import {
  VerificationGoalSnapshotConflictError,
  type VerificationGoalSnapshotImportResult,
} from '@/worker/verification-goals/snapshots'

export const runtime = 'nodejs'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function compareStrings(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

function compareImportResults(
  left: VerificationGoalSnapshotImportResult,
  right: VerificationGoalSnapshotImportResult,
): number {
  return compareStrings(left.goalId, right.goalId)
    || left.definitionVersion - right.definitionVersion
    || compareStrings(left.snapshotId, right.snapshotId)
}

function isInvalidRegistryError(error: unknown): boolean {
  if (
    error instanceof VerificationGoalRegistryError
    || error instanceof VerificationGoalContractError
  ) {
    return true
  }
  return false
}

function invalidRegistryResponse(): NextResponse {
  return NextResponse.json(
    {
      error: 'The verification goal registry is invalid or unsafe.',
      code: 'invalid_verification_goal_registry',
    },
    { status: 422 },
  )
}

function projectRepositoryUnavailableResponse(): NextResponse {
  return NextResponse.json(
    {
      error: 'The project repository is unavailable for verification goal import.',
      code: 'project_repository_unavailable',
    },
    { status: 409 },
  )
}

function projectContextUnavailableResponse(): NextResponse {
  return NextResponse.json(
    {
      error: 'The project context is no longer available for verification goal import.',
      code: 'project_context_unavailable',
    },
    { status: 409 },
  )
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await getSession(request)
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const ingressBlock = await guardEpic172ProjectManagementIngress()
    if (ingressBlock) return ingressBlock

    const { id: rawProjectId } = await params
    if (!UUID.test(rawProjectId)) {
      return NextResponse.json(
        { error: 'Invalid project id.', code: 'invalid_project_id' },
        { status: 400 },
      )
    }
    const projectId = rawProjectId.toLowerCase()
    const project = await getAccessibleProject(projectId, session.userId)
    if (!project || project.archivedAt !== null) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    if (request.body !== null) {
      return NextResponse.json(
        { error: 'This endpoint does not accept a request body.', code: 'unexpected_request_body' },
        { status: 400 },
      )
    }

    const result = await importVerificationGoalRegistry({
      projectId,
      actorUserId: session.userId.toLowerCase(),
    })
    const snapshots = [...result.snapshots].sort(compareImportResults).map((snapshot) => ({
      snapshotId: snapshot.snapshotId,
      goalId: snapshot.goalId,
      definitionVersion: snapshot.definitionVersion,
      definitionSchemaVersion: snapshot.definitionSchemaVersion ?? 1,
      state: snapshot.kind,
    }))

    return NextResponse.json({
      schemaVersion: 2,
      projectId,
      registryRevisionId: result.registryRevisionId,
      manifestSchemaVersion: result.manifestSchemaVersion ?? 1,
      manifestDigest: result.manifestDigest,
      headState: result.headState,
      snapshots,
      summary: {
        total: snapshots.length,
        inserted: snapshots.filter((snapshot) => snapshot.state === 'inserted').length,
        existing: snapshots.filter((snapshot) => snapshot.state === 'existing').length,
      },
    })
  } catch (error) {
    if (error instanceof VerificationGoalSnapshotConflictError) {
      return NextResponse.json(
        {
          error: 'A verification goal version conflicts with an existing snapshot.',
          code: 'definition_version_conflict',
        },
        { status: 409 },
      )
    }
    if (isInvalidRegistryError(error)) return invalidRegistryResponse()
    if (error instanceof VerificationGoalImportError) {
      switch (error.code) {
        case 'invalid_project_id':
          return NextResponse.json(
            { error: 'Invalid project id.', code: 'invalid_project_id' },
            { status: 400 },
          )
        case 'project_context_unavailable':
          return projectContextUnavailableResponse()
        case 'project_repository_unavailable':
          return projectRepositoryUnavailableResponse()
        case 'project_authority_changed':
          return NextResponse.json(
            {
              error: 'The project authority changed during verification goal import.',
              code: 'project_authority_changed',
            },
            { status: 409 },
          )
        case 'registry_head_changed':
          return NextResponse.json(
            {
              error: 'The verification goal registry changed during import. Retry the request.',
              code: 'registry_head_changed',
            },
            { status: 409 },
          )
      }
    }

    return respondToRouteError(
      'POST /api/projects/:id/verification-goals/import',
      error,
    )
  }
}
