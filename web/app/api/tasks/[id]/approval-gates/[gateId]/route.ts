import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { getSession } from '@/lib/session'
import { decideReviewGate } from '@/worker/review-gates'

const DecisionSchema = z.object({
  decision: z.enum(['completed', 'needs_rework']),
  reason: z.string().trim().min(1).max(4000),
  sourceArtifactId: z.string().uuid(),
})

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; gateId: string }> },
) {
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

    const parsed = DecisionSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? 'Invalid decision payload' },
        { status: 400 },
      )
    }

    const { id: taskId, gateId } = await params
    const result = await decideReviewGate({
      decision: parsed.data.decision,
      gateId,
      reason: parsed.data.reason,
      sourceArtifactId: parsed.data.sourceArtifactId,
      taskId,
      userId: session.userId,
    })

    if (result.status === 'not_found') {
      return NextResponse.json({ error: result.message }, { status: 404 })
    }

    if (result.status !== 'decided') {
      return NextResponse.json({ error: result.message }, { status: 409 })
    }

    return NextResponse.json({ result })
  } catch (err) {
    console.error('[POST /api/tasks/:id/approval-gates/:gateId] Unexpected error', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
