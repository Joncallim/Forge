import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { getSession } from '@/lib/session'
import { guardEpic172ProjectManagementIngress } from '@/lib/projects/epic-172-project-ingress'
import {
  getWorkspaceSettings,
  resolveWorkspaceInputPath,
  saveWorkspaceSettings,
  serializeWorkspaceSettings,
} from '@/lib/workspace'

const updateSchema = z.object({
  workspaceRoot: z.string().trim().min(1).max(1000),
  mcpsRoot: z.string().trim().min(1).max(1000).optional(),
})

export async function GET(request: NextRequest) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const workspace = await getWorkspaceSettings({ ensure: false })
    return NextResponse.json({ workspace: serializeWorkspaceSettings(workspace) })
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

    const ingressResponse = await guardEpic172ProjectManagementIngress()
    if (ingressResponse) return ingressResponse

    const parsed = updateSchema.safeParse(await request.json().catch(() => null))
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', issues: parsed.error.issues },
        { status: 400 },
      )
    }

    try {
      const currentWorkspace = await getWorkspaceSettings({ ensure: false })
      const workspaceRoot = resolveWorkspaceInputPath(
        parsed.data.workspaceRoot,
        currentWorkspace,
        currentWorkspace.workspaceRoot,
      )
      const mcpsRoot = parsed.data.mcpsRoot
        ? resolveWorkspaceInputPath(parsed.data.mcpsRoot, currentWorkspace, currentWorkspace.mcpsRoot)
        : undefined
      const workspace = await saveWorkspaceSettings({ workspaceRoot, mcpsRoot })
      return NextResponse.json({ workspace: serializeWorkspaceSettings(workspace) })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to save workspace root'
      return NextResponse.json({ error: message }, { status: 409 })
    }
  } catch (err) {
    console.error('[PUT /api/settings/workspace] Unexpected error', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
