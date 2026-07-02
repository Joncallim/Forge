import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { getSession } from '@/lib/session'
import { redis } from '@/lib/redis'
import { getAccessibleTask } from '@/lib/task-access'
import { decideReviewGate } from '@/worker/review-gates'

const DecisionSchema = z.object({
  decision: z.enum(['completed', 'needs_rework']),
  reason: z.string().trim().min(1).max(4000),
  securityReview: z.unknown().optional(),
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
    const task = await getAccessibleTask(taskId, session.userId)
    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 })
    }

    // Review gates (QA / Reviewer / Security) carry an agent `requiredRole`, but
    // Forge has no human-role model — it is a single-operator app, so any
    // authenticated operator may decide any gate. The role on the gate describes
    // which agent persona it represents, not an access-control restriction.
    const result = await decideReviewGate({
      decision: parsed.data.decision,
      gateId,
      reason: parsed.data.reason,
      securityReview: parsed.data.securityReview,
      sourceArtifactId: parsed.data.sourceArtifactId,
      taskId,
      userId: session.userId,
    })

    if (result.status === 'not_found') {
      return NextResponse.json({ error: result.message }, { status: 404 })
    }

    if (result.status !== 'decided') {
      const status = result.status === 'invalid_security_review_payload' ? 400 : 409
      return NextResponse.json({ error: result.message }, { status })
    }

    try {
      await redis.lpush('forge:approvals', JSON.stringify({ taskId, action: 'approve' }))
    } catch (err) {
      // The gate decision above already committed successfully; a failure here
      // only means the worker continuation wasn't queued yet, not that the
      // decision failed, so return an accepted response the operator can retry.
      console.error('[POST /api/tasks/:id/approval-gates/:gateId] Failed to enqueue worker continuation', err)
      return NextResponse.json(
        {
          error: 'Review gate decision was saved, but the worker continuation could not be queued.',
          result,
        },
        { status: 202 },
      )
    }

    return NextResponse.json({ result })
  } catch (err) {
    console.error('[POST /api/tasks/:id/approval-gates/:gateId] Unexpected error', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
