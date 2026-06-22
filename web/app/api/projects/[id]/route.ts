import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import { db } from '@/db'
import { projects } from '@/db/schema'
import { eq } from 'drizzle-orm'
import { getSession } from '@/lib/session'
import { unregisterProjectPath } from '@/lib/project-registry'

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

    return NextResponse.json({ project })
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
    if ('localPath' in data) updateSet.localPath = data.localPath ?? null
    if ('githubTokenEnvVar' in data) updateSet.githubTokenEnvVar = data.githubTokenEnvVar ?? null
    if ('pmProviderConfigId' in data) updateSet.pmProviderConfigId = data.pmProviderConfigId ?? null
    if (data.defaultBranch !== undefined) updateSet.defaultBranch = data.defaultBranch

    const [updated] = await db
      .update(projects)
      .set(updateSet)
      .where(eq(projects.id, id))
      .returning()

    console.info('[PUT /api/projects/:id] Updated project', { id: updated.id })
    return NextResponse.json({ project: updated })
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

/**
 * Guard against deleting paths that are clearly not a project folder we created
 * (filesystem root, the user's home directory, very shallow paths).
 */
function isSafeToDelete(target: string): boolean {
  const resolved = path.resolve(target)
  const root = path.parse(resolved).root
  if (resolved === root) return false
  if (resolved === path.resolve(os.homedir())) return false
  // Require at least two path segments below root (e.g. /Users/alex/proj).
  const relativeDepth = resolved.slice(root.length).split(path.sep).filter(Boolean).length
  return relativeDepth >= 2
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

    let filesDeleted = false
    if (deleteFiles && existing.localPath) {
      if (!isSafeToDelete(existing.localPath)) {
        return NextResponse.json(
          { error: 'Refusing to delete files: the project path looks unsafe to remove.' },
          { status: 400 },
        )
      }
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

    if (existing.localPath) {
      await unregisterProjectPath(existing.localPath)
    }

    await db.delete(projects).where(eq(projects.id, id))

    console.info('[DELETE /api/projects/:id] Deleted project', { id, filesDeleted })
    return NextResponse.json({ ok: true, filesDeleted })
  } catch (err) {
    console.error('[DELETE /api/projects/:id] Unexpected error', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
