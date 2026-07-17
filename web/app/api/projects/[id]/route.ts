import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import fs from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { db } from '@/db'
import { projects } from '@/db/schema'
import { and, eq } from 'drizzle-orm'
import { getSession } from '@/lib/session'
import { accessibleProjectOwnerCondition, getAccessibleProject } from '@/lib/project-access'
import { registerProjectPath, unregisterProjectPath } from '@/lib/project-registry'
import { validateGitHubTokenEnvVar } from '@/lib/github'
import {
  assertProjectLocalPathAllowed,
  assertProjectLocalPathPreflightAllowed,
  assertProjectPathNotProtected,
} from '@/lib/projects/local-path'
import { guardEpic172ProjectManagementIngress } from '@/lib/projects/epic-172-project-ingress'
import {
  displayPathForWorkspacePath,
  getWorkspaceSettings,
  isWithinPath,
  resolveWorkspaceInputPath,
  type WorkspaceSettings,
} from '@/lib/workspace'

// ---------------------------------------------------------------------------
// Validation schema (all fields optional for PUT)
// ---------------------------------------------------------------------------

const updateProjectSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  githubRepo: z.string().nullable().optional(),
  localPath: z.string().nullable().optional(),
  githubTokenEnvVar: z.string().nullable().optional(),
  pmProviderConfigId: z.string().uuid().nullable().optional(),
  defaultBranch: z.string().optional(),
})

async function assertRealPathWithinWorkspace(
  candidatePath: string,
  workspace: WorkspaceSettings,
): Promise<void> {
  const [realWorkspaceRoot, realCandidate] = await Promise.all([
    fs.realpath(workspace.workspaceRoot),
    fs.realpath(candidatePath),
  ])

  if (!isWithinPath(realWorkspaceRoot, realCandidate)) {
    throw new Error('localPath must be inside the active workspace root')
  }
}

async function assertExistingLocalPathWithinWorkspace(
  candidatePath: string,
  workspace: WorkspaceSettings,
): Promise<void> {
  let currentPath = path.resolve(/*turbopackIgnore: true*/ candidatePath)
  const workspaceRoot = path.resolve(/*turbopackIgnore: true*/ workspace.workspaceRoot)

  while (isWithinPath(workspaceRoot, currentPath)) {
    try {
      await assertRealPathWithinWorkspace(currentPath, workspace)
      return
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      const parentPath = path.dirname(currentPath)
      if (parentPath === currentPath) break
      currentPath = parentPath
    }
  }

  throw new Error('localPath must be inside the active workspace root')
}

function projectResponse<T extends { localPath: string | null }>(
  project: T,
  workspace: WorkspaceSettings,
): T & { displayLocalPath: string | null } {
  return {
    ...project,
    displayLocalPath: project.localPath
      ? displayPathForWorkspacePath(workspace, project.localPath)
      : null,
  }
}

// ---------------------------------------------------------------------------
// GET /api/projects/:id
// ---------------------------------------------------------------------------

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

    const project = await getAccessibleProject(id, session.userId)

    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    const workspace = await getWorkspaceSettings({ ensure: false })
    return NextResponse.json({ project: projectResponse(project, workspace) })
  } catch (err) {
    console.error('[GET /api/projects/:id] Unexpected error', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// ---------------------------------------------------------------------------
// PUT /api/projects/:id
// ---------------------------------------------------------------------------

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

    const existing = await getAccessibleProject(id, session.userId)

    if (!existing) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const parsed = updateProjectSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', issues: parsed.error.issues },
        { status: 400 },
      )
    }

    const data = parsed.data

    const updateSet: Record<string, unknown> = { updatedAt: new Date() }
    if (data.name !== undefined) updateSet.name = data.name
    if ('githubRepo' in data) updateSet.githubRepo = data.githubRepo ?? null
    if ('localPath' in data) {
      const rawLocalPath = data.localPath?.trim() ?? ''
      if (rawLocalPath.includes('\0')) {
        return NextResponse.json({ error: 'Invalid local path' }, { status: 400 })
      }
      if (!rawLocalPath) {
        updateSet.localPath = null
      } else {
        const workspace = await getWorkspaceSettings()
        const resolvedLocalPath = resolveWorkspaceInputPath(rawLocalPath, workspace, workspace.projectsRoot)
        if (!isWithinPath(workspace.workspaceRoot, resolvedLocalPath)) {
          return NextResponse.json(
            { error: 'localPath must be inside the active workspace root' },
            { status: 400 },
          )
        }
        try {
          assertProjectPathNotProtected(resolvedLocalPath, workspace)
          await assertProjectLocalPathPreflightAllowed({
            localPath: resolvedLocalPath,
            projectId: id,
            workspace,
          })
          await assertExistingLocalPathWithinWorkspace(resolvedLocalPath, workspace)
          await assertProjectLocalPathAllowed({
            localPath: resolvedLocalPath,
            projectId: id,
            workspace,
          })
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Invalid local path'
          return NextResponse.json({ error: message }, { status: 400 })
        }
        updateSet.localPath = resolvedLocalPath
      }
    }
    if ('githubTokenEnvVar' in data) {
      const githubTokenEnvVar = data.githubTokenEnvVar?.trim() || null
      const githubTokenEnvVarError = validateGitHubTokenEnvVar(githubTokenEnvVar)
      if (githubTokenEnvVarError) {
        return NextResponse.json({ error: githubTokenEnvVarError }, { status: 400 })
      }
      updateSet.githubTokenEnvVar = githubTokenEnvVar
    }
    if ('pmProviderConfigId' in data) updateSet.pmProviderConfigId = data.pmProviderConfigId ?? null
    if (data.defaultBranch !== undefined) updateSet.defaultBranch = data.defaultBranch

    const [updated] = await db
      .update(projects)
      .set(updateSet)
      .where(and(eq(projects.id, id), accessibleProjectOwnerCondition(session.userId)))
      .returning()

    console.info('[PUT /api/projects/:id] Updated project', { id: updated.id })
    if ('localPath' in updateSet && existing.localPath !== updated.localPath) {
      if (existing.localPath) await unregisterProjectPath(existing.localPath)
      if (updated.localPath) await registerProjectPath(updated.localPath)
    }
    const workspace = await getWorkspaceSettings({ ensure: false })
    return NextResponse.json({ project: projectResponse(updated, workspace) })
  } catch (err) {
    console.error('[PUT /api/projects/:id] Unexpected error', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// ---------------------------------------------------------------------------
// DELETE /api/projects/:id
//
// Project history is release evidence under Epic 172. "Remove" therefore
// archives the project record. Requests that also ask Forge to delete files are
// rejected before any workspace lookup or filesystem operation.
// ---------------------------------------------------------------------------

export async function DELETE(
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
    const deleteFiles = request.nextUrl.searchParams.get('deleteFiles') === 'true'

    if (deleteFiles) {
      return NextResponse.json(
        {
          error: 'Project files cannot be deleted while retained release evidence is enabled. Retry without deleteFiles to archive the project.',
          code: 'project_hard_delete_disabled',
        },
        { status: 409 },
      )
    }

    const existing = await getAccessibleProject(id, session.userId)

    if (!existing) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    const archivedAt = new Date()
    await db
      .update(projects)
      .set({ archivedAt, updatedAt: archivedAt })
      .where(and(eq(projects.id, id), accessibleProjectOwnerCondition(session.userId)))

    console.info('[DELETE /api/projects/:id] Archived project', { id })
    return NextResponse.json({
      ok: true,
      archived: true,
      filesDeleted: false,
      fileDeletionSkippedReason: 'retained_release_evidence',
      fileDeletionMessage: 'Project files were retained. Forge archived the project record instead.',
    })
  } catch (err) {
    console.error('[DELETE /api/projects/:id] Unexpected error', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
