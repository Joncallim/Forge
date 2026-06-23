import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { getSession } from '@/lib/session'
import { listRepos, resolveGitHubToken } from '@/lib/github'

// ---------------------------------------------------------------------------
// GET /api/github/repos
//
// Lists the authenticated user's GitHub repos using whichever token Forge can
// resolve (stored PAT > gh CLI > env var). Used by the New Project flow to
// populate a repo picker for the 'clone' source.
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const resolved = await resolveGitHubToken()
    if (!resolved) {
      return NextResponse.json(
        { error: 'Connect a GitHub token first.' },
        { status: 400 },
      )
    }

    try {
      const repos = await listRepos(resolved.token)
      return NextResponse.json({ repos })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to list GitHub repos'
      console.error('[GET /api/github/repos] GitHub API error', message)
      return NextResponse.json({ error: message }, { status: 502 })
    }
  } catch (err) {
    console.error('[GET /api/github/repos] Unexpected error', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
