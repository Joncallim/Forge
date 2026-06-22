import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { getSession } from '@/lib/session'
import { getGitHubStatus } from '@/lib/github'

// ---------------------------------------------------------------------------
// GET /api/github/status
//
// Reports whether Forge can reach GitHub and from where. The `gh` CLI takes
// precedence, so the UI only prompts for a PAT when the CLI is not already
// authenticated.
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const status = await getGitHubStatus()
    return NextResponse.json(status)
  } catch (err) {
    console.error('[GET /api/github/status] Unexpected error', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
