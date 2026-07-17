import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { db } from '@/db'
import { projects, tasks } from '@/db/schema'
import { eq, desc, count, getTableColumns, type SQL } from 'drizzle-orm'
import { getSession } from '@/lib/session'
import { redis } from '@/lib/redis'
import { generateTaskTitle } from '@/lib/task-title'
import { recordTaskLogBestEffort } from '@/worker/task-logs'
import {
  accessibleProjectOwnerCondition,
  getAccessibleProject,
} from '@/lib/project-access'
import { guardEpic172ProjectManagementIngress } from '@/lib/projects/epic-172-project-ingress'

// ---------------------------------------------------------------------------
// Validation schema
// ---------------------------------------------------------------------------

const createTaskSchema = z.object({
  projectId: z.string().uuid(),
  title: z.string().max(500).optional().default(''),
  prompt: z.string().min(1),
  pmProviderConfigId: z.string().uuid().optional(),
})

type TaskListRow = typeof tasks.$inferSelect & {
  projectName: string
}

// ---------------------------------------------------------------------------
// GET /api/tasks
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { searchParams } = request.nextUrl
    const projectId = searchParams.get('projectId') ?? undefined
    const status = searchParams.get('status') ?? undefined
    const page = Math.max(1, parseInt(searchParams.get('page') ?? '1', 10))
    const limit = Math.min(100, Math.max(1, parseInt(searchParams.get('limit') ?? '20', 10)))
    const offset = (page - 1) * limit

    // Build dynamic where conditions
    const conditions: SQL[] = []
    const access = accessibleProjectOwnerCondition(session.userId)
    if (access) conditions.push(access)
    if (projectId) conditions.push(eq(tasks.projectId, projectId))
    if (status) conditions.push(eq(tasks.status, status))

    // Execute count and data queries
    const baseQuery = db
      .select({
        ...getTableColumns(tasks),
        projectName: projects.name,
      })
      .from(tasks)
      .innerJoin(projects, eq(tasks.projectId, projects.id))
    const countQuery = db
      .select({ total: count() })
      .from(tasks)
      .innerJoin(projects, eq(tasks.projectId, projects.id))

    let rows: TaskListRow[]
    let totalResult: { total: number }[]

    if (conditions.length === 0) {
      rows = await baseQuery.orderBy(desc(tasks.createdAt)).limit(limit).offset(offset)
      totalResult = await countQuery
    } else if (conditions.length === 1) {
      rows = await baseQuery
        .where(conditions[0])
        .orderBy(desc(tasks.createdAt))
        .limit(limit)
        .offset(offset)
      totalResult = await countQuery.where(conditions[0])
    } else {
      // Multiple conditions — import and and apply dynamically
      const { and } = await import('drizzle-orm')
      const combined = and(...conditions)!
      rows = await baseQuery
        .where(combined)
        .orderBy(desc(tasks.createdAt))
        .limit(limit)
        .offset(offset)
      totalResult = await countQuery.where(combined)
    }

    const total = Number(totalResult[0]?.total ?? 0)

    return NextResponse.json({ tasks: rows, total, page })
  } catch (err) {
    console.error('[GET /api/tasks] Unexpected error', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// ---------------------------------------------------------------------------
// POST /api/tasks
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const ingressBlock = await guardEpic172ProjectManagementIngress()
    if (ingressBlock) return ingressBlock

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const parsed = createTaskSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', issues: parsed.error.issues },
        { status: 400 },
      )
    }

    const data = parsed.data

    const project = await getAccessibleProject(data.projectId, session.userId)

    if (!project || project.archivedAt) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    const title = data.title.trim() || (await generateTaskTitle(data.prompt, data.pmProviderConfigId))

    const [task] = await db
      .insert(tasks)
      .values({
        projectId: data.projectId,
        title,
        prompt: data.prompt,
        status: 'pending',
        submittedBy: session.userId,
        pmProviderConfigId: data.pmProviderConfigId ?? null,
      })
      .returning()

    await redis.lpush('forge:tasks', JSON.stringify({ taskId: task.id }))

    await recordTaskLogBestEffort({
      eventType: 'task.created',
      frontMatter: {
        model: data.pmProviderConfigId ?? null,
        connector: 'task-default',
      },
      level: 'info',
      message: `Task "${task.title}" was created and queued for planning.`,
      metadata: {
        projectId: task.projectId,
        submittedBy: session.userId,
      },
      source: 'api',
      taskId: task.id,
      title: 'Task created',
    })

    console.info('[POST /api/tasks] Created task', { id: task.id, projectId: task.projectId })
    return NextResponse.json({ task }, { status: 201 })
  } catch (err) {
    console.error('[POST /api/tasks] Unexpected error', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
