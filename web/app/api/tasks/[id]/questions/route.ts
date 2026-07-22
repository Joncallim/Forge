import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { db } from '@/db'
import { taskQuestions } from '@/db/schema'
import { and, asc, eq, inArray } from 'drizzle-orm'
import { getSession } from '@/lib/session'
import { redis } from '@/lib/redis'
import { getAccessibleTask } from '@/lib/task-access'
import { guardEpic172ProjectManagementIngress } from '@/lib/projects/epic-172-project-ingress'
import { publishTaskEvent } from '@/worker/events'
import { taskQuestionSummary } from '@/lib/mcps/clarification-projection'

// ---------------------------------------------------------------------------
// Validation schema
// ---------------------------------------------------------------------------

const answersSchema = z.object({
  answers: z
    .array(
      z.object({
        id: z.string().uuid(),
        answer: z.string().min(1, 'Answer cannot be empty'),
      }),
    )
    .min(1, 'At least one answer is required'),
})

// ---------------------------------------------------------------------------
// GET /api/tasks/:id/questions
// ---------------------------------------------------------------------------

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { id: taskId } = await params

    const task = await getAccessibleTask(taskId, session.userId)

    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 })
    }

    const questions = await db
      .select({
        id: taskQuestions.id,
        status: taskQuestions.status,
        createdAt: taskQuestions.createdAt,
        answeredAt: taskQuestions.answeredAt,
      })
      .from(taskQuestions)
      .where(eq(taskQuestions.taskId, taskId))
      .orderBy(asc(taskQuestions.createdAt))

    return NextResponse.json({ questions: questions.map(taskQuestionSummary) })
  } catch (err) {
    console.error('[GET /api/tasks/:id/questions] Unexpected error', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// ---------------------------------------------------------------------------
// POST /api/tasks/:id/questions — submit answers for one or more open questions
// ---------------------------------------------------------------------------

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

    const task = await getAccessibleTask(taskId, session.userId)

    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 })
    }

    if (task.status !== 'awaiting_answers') {
      return NextResponse.json(
        { error: `Cannot answer questions for task with status '${task.status}'. Task must be in 'awaiting_answers' status.` },
        { status: 409 },
      )
    }

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const parsed = answersSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', issues: parsed.error.issues },
        { status: 400 },
      )
    }

    const { answers } = parsed.data
    const questionIds = answers.map((a) => a.id)

    const existingQuestions = await db
      .select({ id: taskQuestions.id })
      .from(taskQuestions)
      .where(and(eq(taskQuestions.taskId, taskId), inArray(taskQuestions.id, questionIds)))

    const existingIds = new Set(existingQuestions.map((q) => q.id))
    const unknownIds = questionIds.filter((id) => !existingIds.has(id))
    if (unknownIds.length > 0) {
      return NextResponse.json(
        { error: `Unknown question id(s) for this task: ${unknownIds.join(', ')}` },
        { status: 400 },
      )
    }

    const now = new Date()
    const updated = await Promise.all(
      answers.map(({ id, answer }) =>
        db
          .update(taskQuestions)
          .set({
            answer,
            status: 'answered',
            answeredAt: now,
            answeredBy: session.userId,
          })
          .where(eq(taskQuestions.id, id))
          .returning({
            id: taskQuestions.id,
            status: taskQuestions.status,
            createdAt: taskQuestions.createdAt,
            answeredAt: taskQuestions.answeredAt,
          }),
      ),
    )
    const updatedQuestions = updated.flat()

    // Check whether every question for this task is now answered. If so,
    // enqueue a re-plan job so the architect re-runs with the answers in
    // context and the task can move on to awaiting_approval.
    const allQuestions = await db
      .select({ status: taskQuestions.status })
      .from(taskQuestions)
      .where(eq(taskQuestions.taskId, taskId))

    const allAnswered = allQuestions.length > 0 && allQuestions.every((q) => q.status === 'answered')

    await publishTaskEvent(taskId, 'questions:answered', {
      answeredCount: updatedQuestions.length,
      allAnswered,
    })

    if (allAnswered) {
      await redis.lpush('forge:answers', JSON.stringify({ taskId }))
      console.info('[POST /api/tasks/:id/questions] All questions answered; enqueued re-plan', { taskId })
    }

    console.info('[POST /api/tasks/:id/questions] Recorded answers', {
      taskId,
      count: updatedQuestions.length,
      allAnswered,
    })

    return NextResponse.json({
      questions: updatedQuestions.map(taskQuestionSummary),
      allAnswered,
    })
  } catch (err) {
    console.error('[POST /api/tasks/:id/questions] Unexpected error', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
