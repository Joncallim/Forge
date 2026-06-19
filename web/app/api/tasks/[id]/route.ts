import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { db } from '@/db'
import { tasks, agentRuns, artifacts } from '@/db/schema'
import { and, eq, asc, or } from 'drizzle-orm'
import { getSession } from '@/lib/session'

// ---------------------------------------------------------------------------
// GET /api/tasks/:id
// ---------------------------------------------------------------------------

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

    // Fetch artifacts for all runs
    const runIds = runs.map((r) => r.id)
    let taskArtifacts: typeof artifacts.$inferSelect[] = []
    if (runIds.length > 0) {
      const { inArray } = await import('drizzle-orm')
      taskArtifacts = await db
        .select()
        .from(artifacts)
        .where(inArray(artifacts.agentRunId, runIds))
    }

    return NextResponse.json({ task, runs, artifacts: taskArtifacts })
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
