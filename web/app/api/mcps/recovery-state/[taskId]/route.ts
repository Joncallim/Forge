import 'server-only'
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { asc, eq } from 'drizzle-orm'
import { db } from '@/db'
import { workPackages } from '@/db/schema'
import { getSession } from '@/lib/session'
import { computeFreshnessFingerprint } from '@/lib/mcps/s5-server-reader'
import { parseFilesystemGrantBlockMetadata } from '@/lib/mcps/filesystem-grant-lifecycle'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ taskId: string }> },
) {
  try {
    const session = await getSession(request)
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { taskId } = await params
    const packages = await db
      .select({ id: workPackages.id, metadata: workPackages.metadata, status: workPackages.status })
      .from(workPackages).where(eq(workPackages.taskId, taskId)).orderBy(asc(workPackages.sequence))

    const markers: { workPackageId: string; markerKind: string; markerFingerprint: string; disposition: string; reviewState: string }[] = []
    for (const pkg of packages) {
      if (pkg.status !== 'blocked') continue
      const meta = pkg.metadata as Record<string, unknown> | null
      const block = meta ? parseFilesystemGrantBlockMetadata(meta) : null
      if (block) {
        markers.push({
          workPackageId: pkg.id,
          markerKind: block.holdKind,
          markerFingerprint: block.blockFingerprint,
          disposition: 'operator_hold',
          reviewState: block.holdKind === 'consumed_once' ? 'terminal' : 'active',
        })
      }
    }

    const presenter = {
      computedAt: new Date().toISOString(),
      freshnessFingerprint: computeFreshnessFingerprint({ taskId, markerCount: markers.length }),
      taskId,
      blockedPackages: [],
      recoveryMarkers: markers,
    }

    return NextResponse.json(presenter)
  } catch (err) {
    console.error('[mcps/recovery-state GET] Unexpected error', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
