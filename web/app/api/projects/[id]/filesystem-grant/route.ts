import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { projects, type ProjectMcpConfig } from '@/db/schema'
import { getSession } from '@/lib/session'
import { accessibleProjectCondition } from '@/lib/project-access'
import { getProjectMcpOverview } from '@/lib/mcps/manager'
import {
  canonicalFilesystemProjectCapabilities,
  FILESYSTEM_MCP_ID,
  filesystemGrantHealthError,
  isRecord,
  projectFilesystemGrantFromConfig,
} from '@/lib/mcps/filesystem-grants'

// ---------------------------------------------------------------------------
// Project-level filesystem access grant.
//
// This is the "set it once for the whole project" counterpart to the per-work-
// package approval in /api/tasks/:id/filesystem-grants. Turning it on stores an
// `always_allow` grant on the project's mcpConfig so every ready package that
// needs read-only project filesystem context is covered without a per-package
// approval. It only issues a bounded, read-only context packet — never live
// filesystem tool handles or writes — mirroring the per-task grant.
// ---------------------------------------------------------------------------

const ALL_READ_ONLY_CAPABILITIES = [
  'filesystem.project.read',
  'filesystem.project.list',
  'filesystem.project.search',
]

const putSchema = z.object({
  enabled: z.boolean(),
  reason: z.string().max(4000).optional(),
})

async function findProject(id: string, userId: string) {
  const [project] = await db
    .select()
    .from(projects)
    .where(accessibleProjectCondition(id, userId))
    .limit(1)
  return project ?? null
}

function grantSummary(mcpConfig: ProjectMcpConfig) {
  const grant = projectFilesystemGrantFromConfig(mcpConfig)
  return grant
    ? {
      enabled: true,
      capabilities: grant.capabilities,
      approvedAt: grant.approvedAt,
      approvedBy: grant.approvedBy,
      reason: grant.reason,
    }
    : { enabled: false, capabilities: [] as string[], approvedAt: null, approvedBy: null, reason: '' }
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

    const overview = await getProjectMcpOverview(project)
    return NextResponse.json({
      grant: grantSummary(project.mcpConfig),
      healthError: filesystemGrantHealthError(overview.statuses),
    })
  } catch (err) {
    console.error('[GET /api/projects/:id/filesystem-grant] Unexpected error', err)
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

    const { id } = await params
    const project = await findProject(id, session.userId)
    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    const parsed = putSchema.safeParse(await request.json().catch(() => null))
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', issues: parsed.error.issues },
        { status: 400 },
      )
    }

    const overview = await getProjectMcpOverview(project)
    const healthError = filesystemGrantHealthError(overview.statuses)

    // Approving requires a healthy filesystem MCP; revoking never does.
    if (parsed.data.enabled && healthError) {
      return NextResponse.json({ error: healthError }, { status: 409 })
    }

    const existingGrants = isRecord(project.mcpConfig.grants) ? project.mcpConfig.grants : {}
    const now = new Date()

    let nextGrants: Record<string, unknown>
    if (parsed.data.enabled) {
      nextGrants = {
        ...existingGrants,
        filesystem: {
          schemaVersion: 1,
          mcpId: FILESYSTEM_MCP_ID,
          status: 'approved',
          grantMode: 'always_allow',
          capabilities: canonicalFilesystemProjectCapabilities(ALL_READ_ONLY_CAPABILITIES),
          grantApprovalId: randomUUID(),
          approvedAt: now.toISOString(),
          approvedBy: session.userId,
          reason: parsed.data.reason?.trim() ?? '',
        },
      }
    } else {
      nextGrants = Object.fromEntries(
        Object.entries(existingGrants).filter(([key]) => key !== 'filesystem'),
      )
    }

    const nextConfig: ProjectMcpConfig = { ...project.mcpConfig, grants: nextGrants }
    await db
      .update(projects)
      .set({ mcpConfig: nextConfig, updatedAt: now })
      .where(eq(projects.id, project.id))

    return NextResponse.json({
      grant: grantSummary(nextConfig),
      healthError,
    })
  } catch (err) {
    console.error('[PUT /api/projects/:id/filesystem-grant] Unexpected error', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
