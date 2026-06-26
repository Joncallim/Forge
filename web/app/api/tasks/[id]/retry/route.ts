import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { db } from '@/db'
import { providerConfigs, tasks } from '@/db/schema'
import { and, eq, inArray } from 'drizzle-orm'
import { getSession } from '@/lib/session'
import { redis } from '@/lib/redis'

const retrySchema = z.object({
  pmProviderConfigId: z.string().uuid().nullable().optional(),
})

const RETRYABLE_STATUSES = ['failed', 'cancelled', 'rejected'] as const

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { id: taskId } = await params
    const [existing] = await db
      .select()
      .from(tasks)
      .where(eq(tasks.id, taskId))
      .limit(1)

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

    const [task] = await db
      .update(tasks)
      .set({
        status: 'pending',
        pmProviderConfigId: providerId ?? null,
        errorMessage: null,
        updatedAt: new Date(),
      })
      .where(and(eq(tasks.id, taskId), inArray(tasks.status, RETRYABLE_STATUSES)))
      .returning()

    if (!task) {
      return NextResponse.json(
        { error: `Cannot retry task with status '${existing.status}'. Task must be stopped first.` },
        { status: 409 },
      )
    }

    await redis.lpush('forge:tasks', JSON.stringify({ taskId: task.id }))
    await redis.publish('forge:task:' + taskId, JSON.stringify({
      type: 'task:status',
      status: 'pending',
      errorMessage: null,
      updatedAt: task.updatedAt.toISOString(),
    }))

    return NextResponse.json({ task })
  } catch (err) {
    console.error('[POST /api/tasks/:id/retry] Unexpected error', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
