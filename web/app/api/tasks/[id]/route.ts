import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { db } from '@/db'
import {
  agentHarnesses,
  approvalGates,
  artifacts,
  agentRuns,
  taskAttempts,
  taskQuestions,
  tasks,
  vcsChanges,
  workPackages,
} from '@/db/schema'
import { and, eq, asc, inArray, or } from 'drizzle-orm'
import { getSession } from '@/lib/session'

// ---------------------------------------------------------------------------
// GET /api/tasks/:id
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function metadataString(metadata: unknown, key: string): string | null {
  if (!isRecord(metadata)) return null
  const value = metadata[key]
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { id } = await params

    const [task] = await db
      .select()
      .from(tasks)
      .where(eq(tasks.id, id))
      .limit(1)

    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 })
    }

    // Fetch agent runs ordered by createdAt asc
    const runs = await db
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.taskId, id))
      .orderBy(asc(agentRuns.createdAt))

    const attempts = await db
      .select()
      .from(taskAttempts)
      .where(eq(taskAttempts.taskId, id))
      .orderBy(asc(taskAttempts.createdAt))

    const questions = await db
      .select()
      .from(taskQuestions)
      .where(eq(taskQuestions.taskId, id))
      .orderBy(asc(taskQuestions.createdAt))

    // Fetch artifacts for all runs
    const runIds = runs.map((r) => r.id)
    let taskArtifacts: typeof artifacts.$inferSelect[] = []
    if (runIds.length > 0) {
      taskArtifacts = await db
        .select()
        .from(artifacts)
        .where(inArray(artifacts.agentRunId, runIds))
        .orderBy(asc(artifacts.createdAt))
    }

    const [taskWorkPackages, taskApprovalGates, taskVcsChanges] = await Promise.all([
      db
        .select()
        .from(workPackages)
        .where(eq(workPackages.taskId, id))
        .orderBy(asc(workPackages.sequence), asc(workPackages.createdAt)),
      db
        .select()
        .from(approvalGates)
        .where(eq(approvalGates.taskId, id))
        .orderBy(asc(approvalGates.createdAt)),
      db
        .select()
        .from(vcsChanges)
        .where(eq(vcsChanges.taskId, id))
        .orderBy(asc(vcsChanges.createdAt)),
    ])
    const harnessIds = [
      ...new Set(
        taskWorkPackages
          .map((pkg) => pkg.harnessId)
          .filter((harnessId): harnessId is string => typeof harnessId === 'string' && harnessId.length > 0),
      ),
    ]
    const taskHarnesses = harnessIds.length > 0
      ? await db
        .select({
          id: agentHarnesses.id,
          role: agentHarnesses.role,
          displayName: agentHarnesses.displayName,
          description: agentHarnesses.description,
        })
        .from(agentHarnesses)
        .where(inArray(agentHarnesses.id, harnessIds))
      : []
    const harnessById = new Map(taskHarnesses.map((harness) => [harness.id, harness]))
    const taskWorkPackagesWithPrompts = taskWorkPackages.map((pkg) => {
      const harness = pkg.harnessId ? harnessById.get(pkg.harnessId) : undefined
      return {
        ...pkg,
        harnessRole: harness?.role ?? null,
        harnessDisplayName: harness?.displayName ?? null,
        harnessDescription: harness?.description ?? null,
        promptOverlay: metadataString(pkg.metadata, 'promptOverlay'),
      }
    })

    return NextResponse.json({
      task,
      runs,
      artifacts: taskArtifacts,
      attempts,
      questions,
      workPackages: taskWorkPackagesWithPrompts,
      approvalGates: taskApprovalGates,
      vcsChanges: taskVcsChanges,
    })
  } catch (err) {
    console.error('[GET /api/tasks/:id] Unexpected error', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// ---------------------------------------------------------------------------
// DELETE /api/tasks/:id
// ---------------------------------------------------------------------------

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { id } = await params

    const [existing] = await db
      .select()
      .from(tasks)
      .where(eq(tasks.id, id))
      .limit(1)

    if (!existing) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 })
    }

    if (existing.status !== 'pending' && existing.status !== 'failed') {
      return NextResponse.json(
        { error: `Cannot cancel task with status '${existing.status}'. Only 'pending' or 'failed' tasks can be cancelled.` },
        { status: 409 },
      )
    }

    const [cancelled] = await db
      .update(tasks)
      .set({ status: 'cancelled', updatedAt: new Date() })
      .where(and(eq(tasks.id, id), or(eq(tasks.status, 'pending'), eq(tasks.status, 'failed'))!))
      .returning({ id: tasks.id })

    if (!cancelled) {
      return NextResponse.json(
        { error: `Cannot cancel task with status '${existing.status}'. Only 'pending' or 'failed' tasks can be cancelled.` },
        { status: 409 },
      )
    }

    console.info('[DELETE /api/tasks/:id] Cancelled task', { id })
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[DELETE /api/tasks/:id] Unexpected error', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
