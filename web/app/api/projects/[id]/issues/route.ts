import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { db } from '@/db'
import { projects } from '@/db/schema'
import { eq } from 'drizzle-orm'
import { getSession } from '@/lib/session'
import { resolveGitHubToken } from '@/lib/github'
import { createProjectIssue, isValidGitHubRepo, listProjectIssues } from '@/lib/github-project'

async function findProject(id: string) {
  const [project] = await db.select().from(projects).where(eq(projects.id, id)).limit(1)
  return project ?? null
}

// ---------------------------------------------------------------------------
// GET /api/projects/:id/issues
//
// Returns the project repo's GitHub issues. `reason` distinguishes the disabled
// states the UI renders: no configured repo vs. no available GitHub auth.
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await getSession(request)
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { id } = await params
    const project = await findProject(id)
    if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

    if (!isValidGitHubRepo(project.githubRepo)) {
      return NextResponse.json({ repo: null, reason: 'no-repo', issues: [] })
    }

    const resolved = await resolveGitHubToken({ envVar: project.githubTokenEnvVar })
    if (!resolved) {
      return NextResponse.json({ repo: project.githubRepo, reason: 'no-auth', issues: [] })
    }

    const issues = await listProjectIssues(resolved.token, project.githubRepo)
    return NextResponse.json({ repo: project.githubRepo, reason: null, issues })
  } catch (err) {
    console.error('[GET /api/projects/:id/issues] Unexpected error', err)
    return NextResponse.json({ error: 'Failed to load GitHub issues' }, { status: 502 })
  }
}

// ---------------------------------------------------------------------------
// POST /api/projects/:id/issues  — create a GitHub issue
// ---------------------------------------------------------------------------

const createIssueSchema = z.object({
  title: z.string().trim().min(1).max(256),
  body: z.string().max(65536).optional(),
})

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await getSession(request)
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { id } = await params
    const project = await findProject(id)
    if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

    if (!isValidGitHubRepo(project.githubRepo)) {
      return NextResponse.json({ error: 'Project has no GitHub repository configured' }, { status: 400 })
    }

    let json: unknown
    try {
      json = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }
    const parsed = createIssueSchema.safeParse(json)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', fields: parsed.error.flatten().fieldErrors },
        { status: 400 },
      )
    }

    const resolved = await resolveGitHubToken({ envVar: project.githubTokenEnvVar })
    if (!resolved) {
      return NextResponse.json({ error: 'No GitHub authentication available' }, { status: 400 })
    }

    const issue = await createProjectIssue(resolved.token, project.githubRepo, parsed.data)
    return NextResponse.json({ issue }, { status: 201 })
  } catch (err) {
    console.error('[POST /api/projects/:id/issues] Unexpected error', err)
    return NextResponse.json({ error: 'Failed to create GitHub issue' }, { status: 502 })
  }
}
