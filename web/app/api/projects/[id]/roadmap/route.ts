import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { getSession } from '@/lib/session'
import { getAccessibleProject } from '@/lib/project-access'
import { resolveGitHubToken } from '@/lib/github'
import { fetchProjectRoadmap, isValidGitHubRepo } from '@/lib/github-project'

// ---------------------------------------------------------------------------
// GET /api/projects/:id/roadmap
//
// Returns the highest-priority roadmap file found in the project repo, or
// { roadmap: null } when none exists / no repo / no auth. The project page hides
// the Roadmap panel entirely when roadmap is null.
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await getSession(request)
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { id } = await params
    const project = await getAccessibleProject(id, session.userId)
    if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

    if (!isValidGitHubRepo(project.githubRepo)) {
      return NextResponse.json({ roadmap: null, reason: 'no-repo' })
    }

    const resolved = await resolveGitHubToken({ envVar: project.githubTokenEnvVar })
    if (!resolved) {
      return NextResponse.json({ roadmap: null, reason: 'no-auth' })
    }

    const roadmap = await fetchProjectRoadmap(resolved.token, project.githubRepo)
    return NextResponse.json({ roadmap, reason: null })
  } catch (err) {
    console.error('[GET /api/projects/:id/roadmap] Unexpected error', err)
    return NextResponse.json({ error: 'Failed to load project roadmap' }, { status: 502 })
  }
}
