import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { db } from '@/db'
import { projects } from '@/db/schema'
import { getSession } from '@/lib/session'
import { accessibleProjectCondition } from '@/lib/project-access'
import { guardEpic172ProjectManagementIngress } from '@/lib/projects/epic-172-project-ingress'
import { isKnownMcpId } from '@/lib/mcps/catalog'
import { getProjectMcpOverview, installMcps, installRecommendedMcps } from '@/lib/mcps/manager'
import type { McpId } from '@/lib/mcps/types'

const installRequestSchema = z.object({
  mcpIds: z.array(z.string().trim().min(1)).optional(),
}).default({})

async function parseInstallRequest(request: NextRequest): Promise<{ mcpIds?: McpId[] } | { error: string; status: number }> {
  let raw = ''
  try {
    raw = await request.text()
  } catch {
    return {}
  }
  if (!raw.trim()) return {}

  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return { error: 'Invalid JSON body', status: 400 }
  }

  const parsed = installRequestSchema.safeParse(json)
  if (!parsed.success) {
    return { error: 'Validation failed', status: 400 }
  }

  if (!parsed.data.mcpIds) return {}

  const uniqueIds: McpId[] = []
  const seenIds = new Set<string>()
  for (const id of parsed.data.mcpIds) {
    if (seenIds.has(id)) continue
    if (!isKnownMcpId(id)) {
      return { error: `Unknown MCP id: ${id}`, status: 400 }
    }
    seenIds.add(id)
    uniqueIds.push(id)
  }

  return { mcpIds: uniqueIds }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const ingressBlock = await guardEpic172ProjectManagementIngress()
    if (ingressBlock) return ingressBlock

    const { id } = await params
    const [project] = await db
      .select()
      .from(projects)
      .where(accessibleProjectCondition(id, session.userId))
      .limit(1)

    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    const installRequest = await parseInstallRequest(request)
    if ('error' in installRequest) {
      return NextResponse.json({ error: installRequest.error }, { status: installRequest.status })
    }

    if (installRequest.mcpIds) {
      await installMcps(installRequest.mcpIds)
    } else {
      await installRecommendedMcps()
    }

    const overview = await getProjectMcpOverview(project)
    return NextResponse.json({ overview })
  } catch (err) {
    console.error('[POST /api/projects/:id/mcps/install-recommended] Unexpected error', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
