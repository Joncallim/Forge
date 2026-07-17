import 'server-only'
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { asc, eq } from 'drizzle-orm'
import { db } from '@/db'
import { filesystemMcpRuntimeAudits, workPackages } from '@/db/schema'
import { getSession } from '@/lib/session'
import { getAccessibleTask } from '@/lib/task-access'
import { computeFreshnessFingerprint } from '@/lib/mcps/s5-server-reader'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ taskId: string }> },
) {
  try {
    const session = await getSession(request)
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const { taskId } = await params
    const task = await getAccessibleTask(taskId, session.userId)
    if (!task || task.submittedBy !== session.userId) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 })
    }

    const audits = await db
      .select()
      .from(filesystemMcpRuntimeAudits)
      .where(eq(filesystemMcpRuntimeAudits.taskId, taskId))
      .orderBy(asc(filesystemMcpRuntimeAudits.createdAt))

    const terminalPackages = audits.map((a) => ({
      workPackageId: a.workPackageId ?? '',
      assemblyState: a.assembly ? 'assembled' : 'not_assembled',
      deliveryOutcome: a.delivery ? 'submitted' : 'not_exposed',
      terminalOutcome: a.terminal ? 'terminal' : 'current',
      terminalAt: a.terminalAt?.toISOString() ?? null,
    }))

    return NextResponse.json({
      computedAt: new Date().toISOString(),
      freshnessFingerprint: computeFreshnessFingerprint({ taskId, auditCount: audits.length }),
      taskId, terminalPackages,
    })
  } catch (err) {
    console.error('[mcps/terminal-state GET] Unexpected error', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
