import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { and, count, desc, eq, inArray } from 'drizzle-orm'
import { db } from '@/db'
import { projects, tasks } from '@/db/schema'
import { getSession } from '@/lib/session'
import { accessibleProjectOwnerCondition } from '@/lib/project-access'

// ---------------------------------------------------------------------------
// GET /api/tasks/summary
//
// Lightweight counts used by the sidebar status strip. "Active" tasks are
// those still moving through the pipeline; "attention" tasks are stalled and
// want the operator. A handful of the most recent attention tasks are returned
// so the sidebar tooltip can name them.
// ---------------------------------------------------------------------------

const ACTIVE_STATUSES = ['pending', 'running', 'approved'] as const
const ATTENTION_STATUSES = ['awaiting_approval', 'awaiting_answers', 'failed'] as const

export async function GET(request: NextRequest) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const grouped = await db
      .select({ status: tasks.status, total: count() })
      .from(tasks)
      .innerJoin(projects, eq(tasks.projectId, projects.id))
      .where(accessibleProjectOwnerCondition(session.userId))
      .groupBy(tasks.status)

    const byStatus: Record<string, number> = {}
    for (const row of grouped) byStatus[row.status] = row.total

    const sum = (statuses: readonly string[]) =>
      statuses.reduce((acc, status) => acc + (byStatus[status] ?? 0), 0)

    const attentionTasks = await db
      .select({ id: tasks.id, title: tasks.title, status: tasks.status })
      .from(tasks)
      .innerJoin(projects, eq(tasks.projectId, projects.id))
      .where(and(accessibleProjectOwnerCondition(session.userId), inArray(tasks.status, [...ATTENTION_STATUSES])))
      .orderBy(desc(tasks.updatedAt))
      .limit(5)

    return NextResponse.json({
      active: sum(ACTIVE_STATUSES),
      attention: sum(ATTENTION_STATUSES),
      byStatus,
      attentionTasks,
    })
  } catch (err) {
    console.error('[GET /api/tasks/summary] Unexpected error', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
