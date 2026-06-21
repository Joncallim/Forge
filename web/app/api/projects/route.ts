import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { db } from '@/db'
import { projects } from '@/db/schema'
import { isNull, desc } from 'drizzle-orm'
import { getSession } from '@/lib/session'

// ---------------------------------------------------------------------------
// Validation schema
// ---------------------------------------------------------------------------

const createProjectSchema = z.object({
  name: z.string().min(1).max(200),
  source: z.enum(['github', 'local']).optional(),
  githubRepo: z.string().trim().min(1).max(200).optional(),
  localPath: z.string().trim().min(1).max(1000).optional(),
  githubTokenEnvVar: z.string().optional(),
  pmProviderConfigId: z.string().uuid().optional(),
  defaultBranch: z.string().optional(),
})

// ---------------------------------------------------------------------------
// GET /api/projects
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const rows = await db
      .select()
      .from(projects)
      .where(isNull(projects.archivedAt))
      .orderBy(desc(projects.createdAt))

    return NextResponse.json({ projects: rows })
  } catch (err) {
    console.error('[GET /api/projects] Unexpected error', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// ---------------------------------------------------------------------------
// POST /api/projects
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const parsed = createProjectSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', issues: parsed.error.issues },
        { status: 400 },
      )
    }

    const data = parsed.data
    const source = data.source ?? (data.githubRepo ? 'github' : 'local')
    if (source === 'github' && !data.githubRepo) {
      return NextResponse.json(
        { error: 'GitHub repo is required for GitHub projects' },
        { status: 400 },
      )
    }

    const [project] = await db
      .insert(projects)
      .values({
        name: data.name,
        githubRepo: source === 'github' ? data.githubRepo ?? null : null,
        localPath: source === 'local' ? data.localPath ?? null : null,
        githubTokenEnvVar: data.githubTokenEnvVar ?? null,
        pmProviderConfigId: data.pmProviderConfigId ?? null,
        defaultBranch: data.defaultBranch ?? 'main',
      })
      .returning()

    console.info('[POST /api/projects] Created project', { id: project.id, name: project.name })
    return NextResponse.json({ project }, { status: 201 })
  } catch (err) {
    console.error('[POST /api/projects] Unexpected error', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
