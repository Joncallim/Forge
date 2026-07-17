import 'server-only'
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { workPackageLocalRunEvidence, workPackages } from '@/db/schema'
import { getSession } from '@/lib/session'
import { computeFreshnessFingerprint } from '@/lib/mcps/s5-server-reader'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ taskId: string }> },
) {
  try {
    const session = await getSession(request)
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const { taskId } = await params

    const evidence = await db
      .select({
        claimToken: workPackageLocalRunEvidence.claimToken,
        state: workPackageLocalRunEvidence.state,
        leaseExpiresAt: workPackageLocalRunEvidence.leaseExpiresAt,
        terminalAt: workPackageLocalRunEvidence.terminalAt,
      })
      .from(workPackageLocalRunEvidence)
      .where(eq(workPackageLocalRunEvidence.taskId, taskId))

    return NextResponse.json({
      computedAt: new Date().toISOString(),
      freshnessFingerprint: computeFreshnessFingerprint({ taskId, evidenceCount: evidence.length }),
      taskId,
      evidenceRecords: evidence.map((e) => ({
        claimToken: e.claimToken,
        state: e.state,
        leaseExpiresAt: e.leaseExpiresAt?.toISOString() ?? null,
        terminalAt: e.terminalAt?.toISOString() ?? null,
      })),
    })
  } catch (err) {
    console.error('[mcps/local-evidence GET] Unexpected error', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
