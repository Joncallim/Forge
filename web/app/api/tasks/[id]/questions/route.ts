import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { db } from '@/db'
import { agentRuns, artifacts, taskQuestions } from '@/db/schema'
import { and, asc, desc, eq, inArray } from 'drizzle-orm'
import { getSession, readSessionCredential } from '@/lib/session'
import { redis } from '@/lib/redis'
import { getAccessibleTask } from '@/lib/task-access'
import { guardEpic172ProjectManagementIngress } from '@/lib/projects/epic-172-project-ingress'
import { publishTaskEvent } from '@/worker/events'
import { taskQuestionSummary } from '@/lib/mcps/clarification-projection'
import { appendArchitectClarificationAnswer } from '@/lib/mcps/history-reader'
import { architectPlanStorageConfiguration } from '@/lib/mcps/s4-protocol-store'
import { readS4RuntimeModeV1 } from '@/lib/mcps/s4-lease'
import {
  LEGACY_CLARIFICATION_MAX_TEXT_BYTES,
  LEGACY_CLARIFICATION_METADATA_KEY,
  answerLegacyClarification,
  legacyClarificationAllAnswered,
  readLegacyClarification,
  sealLegacyClarification,
} from '@/lib/mcps/legacy-clarification'

// ---------------------------------------------------------------------------
// Validation schema
// ---------------------------------------------------------------------------

const answersSchema = z.object({
  answers: z
    .array(
      z.object({
        id: z.string().uuid(),
        answer: z.string()
          .min(1, 'Answer cannot be empty')
          .refine(
            (value) => Buffer.byteLength(value, 'utf8') <= LEGACY_CLARIFICATION_MAX_TEXT_BYTES,
            'Answer is too large',
          ),
      }),
    )
    .min(1, 'At least one answer is required')
    .superRefine((answers, context) => {
      const ids = new Set(answers.map((answer) => answer.id))
      if (ids.size !== answers.length) {
        context.addIssue({ code: 'custom', message: 'Question ids must be unique' })
      }
    }),
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const legacyArtifactSelection = {
  id: artifacts.id,
  agentRunId: artifacts.agentRunId,
  metadata: artifacts.metadata,
}

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

    const summaries = questions.map(taskQuestionSummary)
    if (questions.length === 0) return NextResponse.json({ questions: summaries })
    const storage = architectPlanStorageConfiguration(process.env, await readS4RuntimeModeV1())
    if (storage.mode !== 'legacy') {
      return NextResponse.json({ questions: summaries })
    }

    const [artifact] = await db
      .select(legacyArtifactSelection)
      .from(artifacts)
      .innerJoin(agentRuns, eq(artifacts.agentRunId, agentRuns.id))
      .where(and(
        eq(agentRuns.taskId, taskId),
        eq(artifacts.artifactType, 'adr_text'),
      ))
      .orderBy(desc(artifacts.createdAt))
      .limit(1)
    const metadata = artifact && isRecord(artifact.metadata) ? artifact.metadata : null
    const planVersion = metadata?.planVersion
    const envelope = artifact && typeof planVersion === 'string'
      ? readLegacyClarification(metadata, {
          taskId,
          agentRunId: artifact.agentRunId,
          planVersion,
        })
      : null
    const summaryById = new Map(summaries.map((summary) => [summary.id, summary]))
    if (!envelope
      || envelope.questions.length !== summaries.length
      || envelope.questions.some((question) => !summaryById.has(question.id))) {
      return NextResponse.json({ error: 'Legacy clarification history is unavailable.' }, { status: 409 })
    }
    return NextResponse.json({
      questions: envelope.questions.map((question) => {
        const summary = summaryById.get(question.id)!
        return {
          ...summary,
          question: question.question,
          suggestions: question.suggestions,
          answer: summary.status === 'answered' ? question.answer : null,
        }
      }),
    })
  } catch {
    console.error('[GET /api/tasks/:id/questions] Unexpected error')
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
    const storage = architectPlanStorageConfiguration(process.env, await readS4RuntimeModeV1())
    let result:
      | {
          ok: true
          updatedQuestions: Array<{
            id: string
            status: string
            createdAt: Date
            answeredAt: Date | null
          }>
          allAnswered: boolean
        }
      | { ok: false; error: string; status: 400 | 409 }

    if (storage.mode === 'legacy') {
      result = await db.transaction(async (tx) => {
        const existingQuestions = await tx
          .select({
            id: taskQuestions.id,
            status: taskQuestions.status,
            createdAt: taskQuestions.createdAt,
            answeredAt: taskQuestions.answeredAt,
            answerReferenceId: taskQuestions.answerReferenceId,
            questionEntryId: taskQuestions.questionEntryId,
            sourcePlanArtifactId: taskQuestions.sourcePlanArtifactId,
            sourcePlanVersion: taskQuestions.sourcePlanVersion,
          })
          .from(taskQuestions)
          .where(eq(taskQuestions.taskId, taskId))
          .for('update')
        const existingIds = new Set(existingQuestions.map((question) => question.id))
        const unknownIds = questionIds.filter((id) => !existingIds.has(id))
        if (unknownIds.length > 0) {
          return {
            ok: false as const,
            error: `Unknown question id(s) for this task: ${unknownIds.join(', ')}`,
            status: 400 as const,
          }
        }
        if (existingQuestions.some((question) =>
          question.questionEntryId !== null
          || question.sourcePlanArtifactId !== null
          || question.sourcePlanVersion !== null
          || question.answerReferenceId !== null)) {
          return {
            ok: false as const,
            error: 'Legacy clarification state is not answerable.',
            status: 409 as const,
          }
        }

        const [artifact] = await tx
          .select(legacyArtifactSelection)
          .from(artifacts)
          .innerJoin(agentRuns, eq(artifacts.agentRunId, agentRuns.id))
          .where(and(
            eq(agentRuns.taskId, taskId),
            eq(artifacts.artifactType, 'adr_text'),
          ))
          .orderBy(desc(artifacts.createdAt))
          .limit(1)
          .for('update')
        const metadata = artifact && isRecord(artifact.metadata) ? artifact.metadata : null
        const planVersion = metadata?.planVersion
        const envelope = artifact && typeof planVersion === 'string'
          ? readLegacyClarification(metadata, {
              taskId,
              agentRunId: artifact.agentRunId,
              planVersion,
            })
          : null
        const answeredEnvelope = envelope
          ? answerLegacyClarification(envelope, answers)
          : null
        if (!artifact || !metadata || !answeredEnvelope) {
          return {
            ok: false as const,
            error: 'Legacy clarification history is unavailable.',
            status: 409 as const,
          }
        }
        const envelopeQuestionById = new Map(envelope!.questions.map((question) => [question.id, question]))
        if (envelopeQuestionById.size !== existingQuestions.length
          || existingQuestions.some((question) => {
            const durableQuestion = envelopeQuestionById.get(question.id)
            if (!durableQuestion) return true
            if (durableQuestion.answer === null) {
              return question.status !== 'open' || question.answeredAt !== null
            }
            return question.status !== 'answered' || question.answeredAt === null
          })
          || questionIds.some((id) => envelopeQuestionById.get(id)?.answer !== null)) {
          return {
            ok: false as const,
            error: 'Legacy clarification projection does not match its durable artifact.',
            status: 409 as const,
          }
        }

        const now = new Date()
        const [updatedArtifact] = await tx
          .update(artifacts)
          .set({
            metadata: {
              ...metadata,
              [LEGACY_CLARIFICATION_METADATA_KEY]: sealLegacyClarification(answeredEnvelope),
            },
          })
          .where(eq(artifacts.id, artifact.id))
          .returning({ id: artifacts.id })
        if (!updatedArtifact) throw new Error('Legacy clarification artifact update failed.')
        const updatedQuestions = await tx
          .update(taskQuestions)
          .set({
            status: 'answered',
            answeredAt: now,
            answeredBy: session.userId,
          })
          .where(and(eq(taskQuestions.taskId, taskId), inArray(taskQuestions.id, questionIds)))
          .returning({
            id: taskQuestions.id,
            status: taskQuestions.status,
            createdAt: taskQuestions.createdAt,
            answeredAt: taskQuestions.answeredAt,
          })
        if (updatedQuestions.length !== questionIds.length) {
          throw new Error('Legacy clarification projection update failed.')
        }
        return {
          ok: true as const,
          updatedQuestions,
          allAnswered: legacyClarificationAllAnswered(answeredEnvelope),
        }
      })
    } else {
      const existingQuestions = await db
        .select({
          id: taskQuestions.id,
          sourcePlanArtifactId: taskQuestions.sourcePlanArtifactId,
          sourcePlanVersion: taskQuestions.sourcePlanVersion,
        })
        .from(taskQuestions)
        .where(and(eq(taskQuestions.taskId, taskId), inArray(taskQuestions.id, questionIds)))
      const existingIds = new Set(existingQuestions.map((question) => question.id))
      const unknownIds = questionIds.filter((id) => !existingIds.has(id))
      if (unknownIds.length > 0) {
        return NextResponse.json(
          { error: `Unknown question id(s) for this task: ${unknownIds.join(', ')}` },
          { status: 400 },
        )
      }
      const credential = readSessionCredential(request)
      if (!credential) {
        return NextResponse.json({ error: 'Protected clarification history is unavailable.' }, { status: 409 })
      }
      const sourceById = new Map(existingQuestions.map((question) => [question.id, question]))
      if ([...sourceById.values()].some((question) => !question.sourcePlanArtifactId || !question.sourcePlanVersion)) {
        return NextResponse.json({ error: 'Clarification source is unavailable.' }, { status: 409 })
      }
      const appended = []
      for (const answer of answers) {
        const source = sourceById.get(answer.id)!
        appended.push(await appendArchitectClarificationAnswer({
          answer: answer.answer, digestKey: storage.digestKey, digestKeyId: storage.digestKeyId,
          questionId: answer.id, sessionCredential: credential,
          sourcePlanArtifactId: source.sourcePlanArtifactId!, sourcePlanVersion: String(source.sourcePlanVersion), taskId,
        }))
      }
      const updatedQuestions = await db
        .select({
          id: taskQuestions.id,
          status: taskQuestions.status,
          createdAt: taskQuestions.createdAt,
          answeredAt: taskQuestions.answeredAt,
        })
        .from(taskQuestions)
        .where(and(eq(taskQuestions.taskId, taskId), inArray(taskQuestions.id, questionIds)))
      result = {
        ok: true,
        updatedQuestions,
        allAnswered: appended.at(-1)?.allAnswered === true,
      }
    }

    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status })
    }
    const { updatedQuestions, allAnswered } = result

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
  } catch {
    console.error('[POST /api/tasks/:id/questions] Unexpected error')
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
