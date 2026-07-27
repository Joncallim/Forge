import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { db } from '@/db'
import { providerConfigs, tasks, workPackages } from '@/db/schema'
import { and, eq, inArray } from 'drizzle-orm'
import { getSession } from '@/lib/session'
import { redis } from '@/lib/redis'
import { recordTaskLogBestEffort } from '@/worker/task-logs'
import { accessibleTaskCondition, getAccessibleTask } from '@/lib/task-access'
import { guardEpic172ProjectManagementIngress } from '@/lib/projects/epic-172-project-ingress'
import { publishTaskEvent } from '@/worker/events'

const retrySchema = z.object({
  pmProviderConfigId: z.string().uuid().nullable().optional(),
})

const RETRYABLE_STATUSES = ['failed', 'cancelled', 'rejected'] as const

async function hasRetryableHandoffPackages(taskId: string): Promise<boolean> {
  const [workPackage] = await db
    .select({ id: workPackages.id })
    .from(workPackages)
    .where(and(eq(workPackages.taskId, taskId), inArray(workPackages.status, ['failed', 'blocked'])))
    .limit(1)

  return workPackage !== undefined
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const ingressBlock = await guardEpic172ProjectManagementIngress()
    if (ingressBlock) return ingressBlock

    const { id: taskId } = await params
    const existing = await getAccessibleTask(taskId, session.userId)

    if (!existing) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 })
    }

    if (!RETRYABLE_STATUSES.includes(existing.status as typeof RETRYABLE_STATUSES[number])) {
      return NextResponse.json(
        { error: `Cannot retry task with status '${existing.status}'. Task must be stopped first.` },
        { status: 409 },
      )
    }

    let body: unknown
    try {
      body = await request.json()
    } catch {
      body = {}
    }

    const parsed = retrySchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', issues: parsed.error.issues },
        { status: 400 },
      )
    }

    const providerId = parsed.data.pmProviderConfigId ?? existing.pmProviderConfigId
    if (providerId) {
      const [provider] = await db
        .select({ id: providerConfigs.id })
        .from(providerConfigs)
        .where(and(eq(providerConfigs.id, providerId), eq(providerConfigs.isActive, true)))
        .limit(1)
      if (!provider) {
        return NextResponse.json({ error: 'Provider config is missing or inactive' }, { status: 400 })
      }
    }

    const retryHandoff = existing.status === 'failed' && await hasRetryableHandoffPackages(taskId)
    const nextStatus = retryHandoff ? 'approved' : 'pending'
    const queueName = retryHandoff ? 'forge:approvals' : 'forge:tasks'
    const queuePayload = retryHandoff ? { taskId, action: 'approve' } : { taskId }

    const [task] = await db
      .update(tasks)
      .set({
        status: nextStatus,
        pmProviderConfigId: providerId ?? null,
        errorMessage: null,
        updatedAt: new Date(),
      })
      .where(and(accessibleTaskCondition(taskId, session.userId), inArray(tasks.status, RETRYABLE_STATUSES)))
      .returning()

    if (!task) {
      return NextResponse.json(
        { error: `Cannot retry task with status '${existing.status}'. Task must be stopped first.` },
        { status: 409 },
      )
    }

    await redis.lpush(queueName, JSON.stringify(queuePayload))
    await publishTaskEvent(taskId, 'task:status', {
      status: nextStatus,
      errorMessage: null,
      updatedAt: task.updatedAt.toISOString(),
    })

    await recordTaskLogBestEffort({
      eventType: 'task.retried',
      frontMatter: {
        model: providerId ?? null,
        connector: providerId ? 'provider-override' : 'task-default',
      },
      level: 'info',
      message: retryHandoff
        ? `Task handoff was requeued from ${existing.status}.`
        : `Task was requeued from ${existing.status}.`,
      metadata: {
        previousStatus: existing.status,
        providerConfigId: providerId ?? null,
        retryQueue: retryHandoff ? 'approvals' : 'tasks',
      },
      source: 'api',
      taskId,
      title: 'Task retried',
    })

    return NextResponse.json({ task })
  } catch (err) {
    console.error('[POST /api/tasks/:id/retry] Unexpected error', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
