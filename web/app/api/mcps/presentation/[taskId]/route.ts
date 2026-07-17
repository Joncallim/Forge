import 'server-only'
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { asc, eq } from 'drizzle-orm'
import { db } from '@/db'
import { workPackages } from '@/db/schema'
import { getSession } from '@/lib/session'
import {
  computeFreshnessFingerprint,
  type S5AdmissionPresenter,
  type S5PackagePresenter,
} from '@/lib/mcps/s5-server-reader'
import { summarizeFilesystemCapabilities } from '@/lib/mcps/filesystem-grants'
import { parseFilesystemGrantBlockMetadata } from '@/lib/mcps/filesystem-grant-lifecycle'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ taskId: string }> },
) {
  try {
    const session = await getSession(request)
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { taskId } = await params
    const allPackages = await db
      .select()
      .from(workPackages)
      .where(eq(workPackages.taskId, taskId))
      .orderBy(asc(workPackages.sequence))

    const pkgPresenters: S5PackagePresenter[] = allPackages.map((pkg) => {
      const summary = summarizeFilesystemCapabilities({
        mcpRequirements: pkg.mcpRequirements,
        metadata: pkg.metadata,
      })
      const meta = pkg.metadata as Record<string, unknown> | null
      const blockMeta = meta ? parseFilesystemGrantBlockMetadata(meta) : null
      return {
        workPackageId: pkg.id,
        title: pkg.title,
        assignedRole: pkg.assignedRole,
        status: pkg.status,
        requestedCapabilities: summary.requestedCapabilities,
        boundedRuntimeRequestedCapabilities: summary.boundedRuntimeRequestedCapabilities,
        blockingCapabilities: summary.blockingCapabilities,
        currentDecision: null,
        blockMetadata: blockMeta,
        pointerFingerprint: null,
        pointerVersion: null,
      }
    })

    const presenter: S5AdmissionPresenter = {
      computedAt: new Date().toISOString(),
      freshnessFingerprint: computeFreshnessFingerprint({ taskId, packageIds: allPackages.map((p) => p.id) }),
      cacheBypassId: '',
      taskId,
      packages: pkgPresenters,
      projectGrant: null,
    }

    return NextResponse.json(presenter)
  } catch (err) {
    console.error('[mcps/presentation GET] Unexpected error', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
