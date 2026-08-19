import { NextResponse, type NextRequest } from 'next/server'

import { db } from '@/db'
import { sql } from 'drizzle-orm'
import { respondToRouteError } from '@/lib/http/route-error'
import { getAccessibleProject } from '@/lib/project-access'
import { guardEpic172ProjectManagementIngress } from '@/lib/projects/epic-172-project-ingress'
import { getSession } from '@/lib/session'
import { seedVerificationGoalPolicy } from '@/worker/verification-goals/policy'
import { admitManualVerificationGoalRun } from '@/worker/verification-goals/admission'
import { executeVerificationGoalRun } from '@/worker/verification-goals/runner'
import { resolveTrustedExecutables } from '@/worker/verification-goals/trusted-executables'

export const runtime = 'nodejs'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; goalId: string }> },
) {
  try {
    const session = await getSession(request)
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { id: rawProjectId, goalId } = await params
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

    const runs = await db.execute<{
      id: string
      status: string
      result: string | null
      terminal_code: string | null
      created_at: Date
      finished_at: Date | null
    }>(sql`
      SELECT
        id,
        status,
        result,
        terminal_code,
        created_at,
        finished_at
      FROM public.verification_goal_runs
      WHERE project_id = ${projectId}::uuid
        AND goal_id = ${goalId}::text
      ORDER BY created_at DESC
      LIMIT 100
    `)

    return NextResponse.json({
      runs: runs.map((run) => ({
        runId: run.id,
        status: run.status,
        result: run.result,
        terminalCode: run.terminal_code,
        createdAt: run.created_at.toISOString(),
        finishedAt: run.finished_at?.toISOString() ?? null,
      })),
    })
  } catch (error) {
    return respondToRouteError(
      'GET /api/projects/:id/verification-goals/:goalId/runs',
      error,
    )
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; goalId: string }> },
) {
  try {
    const session = await getSession(request)
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const ingressBlock = await guardEpic172ProjectManagementIngress()
    if (ingressBlock) return ingressBlock

    const { id: rawProjectId, goalId } = await params
    if (!UUID.test(rawProjectId)) {
      return NextResponse.json(
        { error: 'Invalid project id.', code: 'invalid_project_id' },
        { status: 400 },
      )
    }

    const idempotencyKey = request.headers.get('Idempotency-Key') ?? ''
    if (!UUID.test(idempotencyKey)) {
      return NextResponse.json(
        { error: 'A valid UUID Idempotency-Key header is required.', code: 'invalid_idempotency_key' },
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

    // Ensure a default-disabled policy exists for the project.
    const [existingHead] = await db.execute<{
      policy_revision_id: string
      revision_sequence: bigint
    }>(sql`
      SELECT policy_revision_id, revision_sequence FROM public.verification_goal_policy_heads
      WHERE project_id = ${projectId}::uuid
    `)
    let policyRevisionId: string
    let policyRevisionSequence: bigint
    if (existingHead) {
      policyRevisionId = existingHead.policy_revision_id
      policyRevisionSequence = existingHead.revision_sequence
    } else {
      const seededHead = await seedVerificationGoalPolicy({
        projectId,
        actorKind: 'system_default',
      })
      policyRevisionId = seededHead.policyRevisionId
      policyRevisionSequence = seededHead.revisionSequence
    }

    // Find the current registry entry for the requested goal.
    const [entry] = await db.execute<{
      registry_revision_id: string
      ordinal: number
      snapshot_id: string
      definition_version: number
      definition_digest: string
      source_path: string
      execution_binding_digest: string | null
      canonical_definition: unknown
    }>(sql`
      SELECT
        e.registry_revision_id,
        e.ordinal,
        e.snapshot_id,
        e.definition_version,
        e.definition_digest,
        e.source_path,
        e.execution_binding_digest,
        s.canonical_definition
      FROM public.verification_goal_registry_heads h
      JOIN public.verification_goal_registry_entries e
        ON e.registry_revision_id = h.registry_revision_id
      JOIN public.verification_goal_snapshots s
        ON s.id = e.snapshot_id
      WHERE h.project_id = ${projectId}::uuid
        AND e.goal_id = ${goalId}::text
    `)

    if (!entry) {
      return NextResponse.json(
        { error: 'Goal not found in the current registry.', code: 'goal_not_found' },
        { status: 404 },
      )
    }

    const definition = entry.canonical_definition as {
      schemaVersion: number
      goalId: string
      definitionVersion: number
      title: string
      description: string
      capability: string
      severity: string
      enabled: boolean
      operations: Array<{ operationId: string; operationVersion: number }>
      execution?: {
        manual: boolean
        schedule: unknown
        deadlineSeconds: number
        requiredEvidence: string[]
      }
    }

    if (!definition.enabled) {
      return NextResponse.json(
        { error: 'Verification goal is disabled.', code: 'goal_disabled' },
        { status: 409 },
      )
    }

    if (definition.schemaVersion !== 2 || !definition.execution?.manual) {
      return NextResponse.json(
        { error: 'Goal is not executable manually.', code: 'manual_execution_disabled' },
        { status: 409 },
      )
    }

    const admission = await admitManualVerificationGoalRun({
      project,
      goal: definition as never,
      snapshotId: entry.snapshot_id,
      sourcePath: entry.source_path,
      definitionDigest: entry.definition_digest,
      registryRevisionId: entry.registry_revision_id,
      registryEntryOrdinal: entry.ordinal,
      executionBindingDigest: entry.execution_binding_digest,
      requestedByUserId: session.userId.toLowerCase(),
      manualIdempotencyKey: idempotencyKey.toLowerCase(),
      policyRevisionId,
      policyRevisionSequence,
    })

    // For the manual-runner vertical slice, execute synchronously. Future slices
    // will move this to the Redis-delivered worker path.
    const trustedExecutables = await resolveTrustedExecutables({
      nodePath: process.execPath,
      gitPath: process.env.FORGE_TRUSTED_GIT_PATH ?? '/usr/bin/git',
      workspaceRoots: [process.cwd(), project.localPath].filter(
        (root): root is string => typeof root === 'string' && root.trim() !== '',
      ),
    })

    const outcome = await executeVerificationGoalRun({
      project,
      runId: admission.runId,
      trustedExecutables,
      nodePath: process.execPath,
      gitPath: process.env.FORGE_TRUSTED_GIT_PATH ?? '/usr/bin/git',
    })

    return NextResponse.json({
      runId: admission.runId,
      state: admission.state,
      result: outcome.result,
      terminalCode: outcome.terminalCode,
    })
  } catch (error) {
    const sqlState = (error as { code?: unknown } | null)?.code
    if (typeof sqlState === 'string') {
      // Closed SQLSTATE mapping for the protected admission/runner boundary.
      if (sqlState === 'P1871') {
        return NextResponse.json(
          { error: 'Verification goal execution is unavailable for this project.', code: 'execution_unavailable' },
          { status: 409 },
        )
      }
      if (sqlState === 'P1872') {
        return NextResponse.json(
          { error: 'Project verification policy or lease state changed. Retry the request.', code: 'policy_or_lease_changed' },
          { status: 409 },
        )
      }
      if (sqlState === 'P1873') {
        return NextResponse.json(
          { error: 'Verification goal is not executable under the current project policy or registry state.', code: 'execution_denied' },
          { status: 409 },
        )
      }
      if (sqlState === 'P1874') {
        return NextResponse.json(
          { error: 'Verification goal capacity limit reached. Retry later.', code: 'capacity_limit' },
          { status: 429 },
        )
      }
      if (sqlState === 'P1876') {
        return NextResponse.json(
          { error: 'The Idempotency-Key was already used for a different request.', code: 'idempotency_conflict' },
          { status: 409 },
        )
      }
    }
    return respondToRouteError(
      'POST /api/projects/:id/verification-goals/:goalId/runs',
      error,
    )
  }
}
