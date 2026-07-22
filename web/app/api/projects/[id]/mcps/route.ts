import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import path from 'node:path'
import { z } from 'zod'
import { db } from '@/db'
import { projects, type ProjectMcpConfig } from '@/db/schema'
import { getSession } from '@/lib/session'
import { accessibleProjectCondition } from '@/lib/project-access'
import { guardEpic172ProjectManagementIngress } from '@/lib/projects/epic-172-project-ingress'
import { isKnownMcpId } from '@/lib/mcps/catalog'
import { getProjectMcpOverview, setProjectMcpConfig } from '@/lib/mcps/manager'
import { getWorkspaceSettings, isWithinPath } from '@/lib/workspace'

const mcpConfigSchema = z.object({
  profile: z.enum(['default', 'custom']).default('custom'),
  requiredMcps: z.array(z.string().trim().min(1)),
  overrides: z.record(z.object({
    enabled: z.boolean().optional(),
    installPath: z.string().trim().min(1).max(1000).optional(),
  })).default({}),
})

async function findProject(id: string, userId: string) {
  const [project] = await db
    .select()
    .from(projects)
    .where(accessibleProjectCondition(id, userId))
    .limit(1)

  return project ?? null
}

function validateKnownMcps(config: ProjectMcpConfig): string | null {
  const ids = new Set([...config.requiredMcps, ...Object.keys(config.overrides)])
  for (const id of ids) {
    if (!isKnownMcpId(id)) {
      return `Unknown MCP id: ${id}`
    }
  }
  return null
}

async function validateOverridePaths(config: ProjectMcpConfig): Promise<string | null> {
  const workspace = await getWorkspaceSettings()
  for (const [mcpId, override] of Object.entries(config.overrides)) {
    if (!override.installPath) continue
    const installPath = path.resolve(/*turbopackIgnore: true*/ override.installPath)
    if (!isWithinPath(workspace.workspaceRoot, installPath)) {
      return `${mcpId} installPath must stay inside the active workspace root.`
    }
  }
  return null
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
    const project = await findProject(id, session.userId)
    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    const overview = await getProjectMcpOverview(
      project,
      null,
      { cache: false, ensureWorkspace: false },
    )
    return NextResponse.json({ overview })
  } catch (err) {
    console.error('[GET /api/projects/:id/mcps] Unexpected error', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function PUT(
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
    const project = await findProject(id, session.userId)
    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    const parsed = mcpConfigSchema.safeParse(await request.json().catch(() => null))
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', issues: parsed.error.issues },
        { status: 400 },
      )
    }

    const config = {
      ...parsed.data,
      grants: project.mcpConfig.grants,
    }
    const knownError = validateKnownMcps(config)
    if (knownError) {
      return NextResponse.json({ error: knownError }, { status: 400 })
    }

    const pathError = await validateOverridePaths(config)
    if (pathError) {
      return NextResponse.json({ error: pathError }, { status: 400 })
    }

    const normalized = await setProjectMcpConfig(project, config)
    const overview = await getProjectMcpOverview({ ...project, mcpConfig: normalized })
    return NextResponse.json({ overview })
  } catch (err) {
    console.error('[PUT /api/projects/:id/mcps] Unexpected error', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
