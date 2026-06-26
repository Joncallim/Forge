import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import fs from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { db } from '@/db'
import { projects } from '@/db/schema'
import { eq } from 'drizzle-orm'
import { getSession } from '@/lib/session'
import { registerProjectPath, unregisterProjectPath } from '@/lib/project-registry'
import { validateGitHubTokenEnvVar } from '@/lib/github'
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

    const [project] = await db
      .select()
      .from(projects)
      .where(eq(projects.id, id))
      .limit(1)

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

    const { id } = await params

    const [existing] = await db
      .select()
      .from(projects)
      .where(eq(projects.id, id))
      .limit(1)

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
          await assertExistingLocalPathWithinWorkspace(resolvedLocalPath, workspace)
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
      .where(eq(projects.id, id))
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
// Removes the project (cascading to its tasks/runs/artifacts). With
// ?deleteFiles=true it also removes the local project folder from disk.
// ---------------------------------------------------------------------------

type ProjectDeletePathCheck =
  | { action: 'delete' }
  | { action: 'skip'; reason: string; message: string }
  | { action: 'error'; message: string }

async function checkProjectDeletePath(target: string, projectId: string): Promise<ProjectDeletePathCheck> {
  const workspace = await getWorkspaceSettings()
  const resolved = path.resolve(/*turbopackIgnore: true*/ target)
  const protectedRoots = [
    workspace.workspaceRoot,
    workspace.projectsRoot,
    workspace.mcpsRoot,
    workspace.templatesRoot,
    workspace.localMemoryRoot,
    workspace.checkpointsRoot,
    workspace.promptsRoot,
    workspace.agentPromptsRoot,
    workspace.workforcesRoot,
    workspace.configRoot,
    workspace.runtimeRoot,
    workspace.logsRoot,
    workspace.backupsRoot,
  ].map((root) => path.resolve(/*turbopackIgnore: true*/ root))

  if (protectedRoots.includes(resolved)) {
    return {
      action: 'error',
      message: 'Refusing to delete files: the project path points at a shared Forge workspace directory.',
    }
  }

  if (!isWithinPath(workspace.projectsRoot, resolved)) {
    return {
      action: 'skip',
      reason: 'outside_forge_managed_projects',
      message: 'Files were not deleted because the project path is outside Forge-managed projects.',
    }
  }

  let stat
  try {
    stat = await fs.lstat(resolved)
  } catch {
    return {
      action: 'error',
      message: 'Refusing to delete files: the project path does not exist.',
    }
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    return {
      action: 'error',
      message: 'Refusing to delete files: the project path must be a real directory.',
    }
  }

  const [realProjectsRoot, realTarget] = await Promise.all([
    fs.realpath(workspace.projectsRoot),
    fs.realpath(resolved),
  ])
  if (realTarget === realProjectsRoot || !isWithinPath(realProjectsRoot, realTarget)) {
    return {
      action: 'error',
      message: 'Refusing to delete files: the project path escapes the real Forge projects directory.',
    }
  }

  try {
    const raw = await fs.readFile(path.join(/*turbopackIgnore: true*/ resolved, 'forge.project.json'), 'utf-8')
    const marker = JSON.parse(raw) as { projectId?: unknown }
    if (marker.projectId !== projectId) {
      return {
        action: 'error',
        message: 'Refusing to delete files: the Forge project marker does not match this project.',
      }
    }
  } catch {
    return {
      action: 'error',
      message: 'Refusing to delete files: no matching Forge project marker was found.',
    }
  }

  return { action: 'delete' }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { id } = await params
    const deleteFiles = request.nextUrl.searchParams.get('deleteFiles') === 'true'

    const [existing] = await db
      .select()
      .from(projects)
      .where(eq(projects.id, id))
      .limit(1)

    if (!existing) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    const workspace = await getWorkspaceSettings({ ensure: false })
    let filesDeleted = false
    let fileDeletionSkippedReason: string | null = null
    let fileDeletionMessage: string | null = null
    if (deleteFiles && existing.localPath) {
      const deletePathCheck = await checkProjectDeletePath(existing.localPath, id)
      if (deletePathCheck.action === 'error') {
        return NextResponse.json(
          { error: deletePathCheck.message },
          { status: 400 },
        )
      }
      if (deletePathCheck.action === 'skip') {
        fileDeletionSkippedReason = deletePathCheck.reason
        fileDeletionMessage = deletePathCheck.message
      } else {
        try {
          await fs.rm(existing.localPath, { recursive: true, force: true })
          filesDeleted = true
        } catch (err) {
          console.error('[DELETE /api/projects/:id] Failed to remove project files', err)
          return NextResponse.json(
            { error: `Could not delete project files: ${err instanceof Error ? err.message : 'unknown error'}` },
            { status: 500 },
          )
        }
      }
    }

    if (existing.localPath) {
      await unregisterProjectPath(existing.localPath)
    }

    await db.delete(projects).where(eq(projects.id, id))

    console.info('[DELETE /api/projects/:id] Deleted project', {
      id,
      filesDeleted,
      fileDeletionSkippedReason,
    })
    return NextResponse.json({
      ok: true,
      filesDeleted,
      fileDeletionSkippedReason,
      fileDeletionMessage,
      localPath: existing.localPath,
      displayLocalPath: existing.localPath
        ? displayPathForWorkspacePath(workspace, existing.localPath)
        : null,
    })
  } catch (err) {
    console.error('[DELETE /api/projects/:id] Unexpected error', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
