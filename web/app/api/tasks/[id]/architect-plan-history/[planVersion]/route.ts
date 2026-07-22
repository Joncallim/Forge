import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { readArchitectPlanHistory } from '@/lib/mcps/history-reader'
import { getSession, readSessionCredential } from '@/lib/session'
import { getAccessibleTask } from '@/lib/task-access'

const HISTORY_DENIED = { error: 'Architect plan history not found.' } as const

/**
 * The sole human-readable route for protected Architect plan text. The
 * dedicated database reader performs the exact task, artifact, stage, version,
 * session, and audit checks. All authenticated denials deliberately share one
 * response so callers cannot use this route to discover protected history.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; planVersion: string }> },
) {
  const session = await getSession(request)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id: taskId, planVersion } = await params
  if (!/^[1-9][0-9]{0,18}$/.test(planVersion)) {
    return NextResponse.json(HISTORY_DENIED, { status: 404 })
  }

  const [task, sessionCredential] = await Promise.all([
    getAccessibleTask(taskId, session.userId),
    Promise.resolve(readSessionCredential(request)),
  ])
  if (!task || !sessionCredential) {
    return NextResponse.json(HISTORY_DENIED, { status: 404 })
  }

  try {
    const entries = await readArchitectPlanHistory({
      planVersion,
      sessionCredential,
      taskId,
    })
    return NextResponse.json({ taskId, planVersion, entries })
  } catch {
    return NextResponse.json(HISTORY_DENIED, { status: 404 })
  }
}
