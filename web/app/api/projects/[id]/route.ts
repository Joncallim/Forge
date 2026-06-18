import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { db } from '@/db'
import { projects } from '@/db/schema'
import { eq } from 'drizzle-orm'
import { getSession } from '@/lib/session'

// ---------------------------------------------------------------------------
// Validation schema (all fields optional for PUT)
// ---------------------------------------------------------------------------

const updateProjectSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  githubRepo: z.string().nullable().optional(),
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
// DELETE /api/projects/:id  (soft-delete by setting archivedAt)
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

    const { id } = await params

    const [existing] = await db
      .select()
      .from(projects)
      .where(eq(projects.id, id))
      .limit(1)

    if (!existing) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    await db
      .update(projects)
      .set({ archivedAt: new Date(), updatedAt: new Date() })
      .where(eq(projects.id, id))

    console.info('[DELETE /api/projects/:id] Archived project', { id })
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[DELETE /api/projects/:id] Unexpected error', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
