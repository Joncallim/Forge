import 'server-only'
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { createHash } from 'node:crypto'
import { asc, eq } from 'drizzle-orm'
import { db } from '@/db'
import { workPackages } from '@/db/schema'
import { getSession } from '@/lib/session'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ taskId: string }> },
) {
  try {
    const session = await getSession(request)
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const { taskId } = await params

    const packages = await db
      .select({ id: workPackages.id, updatedAt: workPackages.updatedAt })
      .from(workPackages).where(eq(workPackages.taskId, taskId))
      .orderBy(asc(workPackages.sequence))

    const fingerprint = createHash('sha256')
      .update(packages.map((p) => `${p.id}:${p.updatedAt?.getTime() ?? 0}`).join('\n'))
      .digest('hex')

    const casToken = createHash('sha256')
      .update(`forge:s5:cas-recheck:v1\0${fingerprint}\0${Date.now()}`)
      .digest('hex').substring(0, 16)

    return NextResponse.json({
      computedAt: new Date().toISOString(),
      fingerprint: `sha256:${fingerprint}`,
      casRecheckToken: `recheck:${casToken}`,
      freshnessAgeMs: Date.now() - new Date().getTime(),
      taskId,
    })
  } catch (err) {
    console.error('[mcps/freshness GET] Unexpected error', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
