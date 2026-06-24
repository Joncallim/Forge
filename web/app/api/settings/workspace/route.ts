import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { getSession } from '@/lib/session'
import { getWorkspaceSettings, saveWorkspaceRoot } from '@/lib/workspace'

const updateSchema = z.object({
  workspaceRoot: z.string().trim().min(1).max(1000),
})

export async function GET(request: NextRequest) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const workspace = await getWorkspaceSettings()
    return NextResponse.json({ workspace })
  } catch (err) {
    console.error('[GET /api/settings/workspace] Unexpected error', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function PUT(request: NextRequest) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const parsed = updateSchema.safeParse(await request.json().catch(() => null))
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', issues: parsed.error.issues },
        { status: 400 },
      )
    }

    try {
      const workspace = await saveWorkspaceRoot(parsed.data.workspaceRoot)
      return NextResponse.json({ workspace })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to save workspace root'
      return NextResponse.json({ error: message }, { status: 409 })
    }
  } catch (err) {
    console.error('[PUT /api/settings/workspace] Unexpected error', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
