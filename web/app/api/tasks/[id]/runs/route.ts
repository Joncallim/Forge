import type { NextRequest } from 'next/server'
import { db } from '@/db'
import { agentRuns, artifacts, taskQuestions, tasks } from '@/db/schema'
import { asc, eq, inArray } from 'drizzle-orm'
import { getSession } from '@/lib/session'
import { redis } from '@/lib/redis'

// ---------------------------------------------------------------------------
// SSE stream — GET /api/tasks/:id/runs
// ---------------------------------------------------------------------------

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSession(request)
  if (!session) return new Response('Unauthorized', { status: 401 })

  const { id: taskId } = await params

  // Verify task exists
  const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1)
  if (!task) return new Response('Task not found', { status: 404 })

  const encoder = new TextEncoder()

  const stream = new ReadableStream({
    async start(controller) {
      // persistAndSend: allocates a global monotonic sequence number, writes to the
      // sorted set using that number as the score, then enqueues the SSE line.
      // The score is the canonical event ID — Last-Event-ID from the client maps
      // directly to the sorted set score, so replay is exact.
      const persistAndSend = async (type: string, data: unknown) => {
        const seq = await redis.incr(`forge:task:${taskId}:seq`)
        const line = `id: ${seq}\nevent: ${type}\ndata: ${JSON.stringify(data)}\n\n`
        redis
          .zadd(`forge:task:${taskId}:history`, seq, JSON.stringify({ type, data }))
          .then(() => redis.expire(`forge:task:${taskId}:history`, 86400))
          .catch((err) => console.error('SSE history write failed:', err))
        controller.enqueue(encoder.encode(line))
      }

      // replaySend: enqueues the SSE line directly WITHOUT writing to the sorted set.
      // Used only during the replay loop to avoid re-persisting already-stored events.
      const replaySend = (seqId: number, type: string, data: unknown) => {
        const line = `id: ${seqId}\nevent: ${type}\ndata: ${JSON.stringify(data)}\n\n`
        controller.enqueue(encoder.encode(line))
      }

      const sendSnapshotEvent = (type: string, data: unknown) => {
        controller.enqueue(encoder.encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`))
      }

      const sendCurrentSnapshot = async () => {
        const [freshTask] = await db
          .select({ status: tasks.status })
          .from(tasks)
          .where(eq(tasks.id, taskId))
          .limit(1)

        if (freshTask) {
          sendSnapshotEvent('task:status', { type: 'task:status', status: freshTask.status })
        }

        const runs = await db
          .select()
          .from(agentRuns)
          .where(eq(agentRuns.taskId, taskId))
          .orderBy(asc(agentRuns.createdAt))

        for (const run of runs) {
          if (run.status !== 'pending') {
            sendSnapshotEvent('run:started', {
              id: run.id,
              runId: run.id,
              taskId,
              agentType: run.agentType,
              modelIdUsed: run.modelIdUsed,
              startedAt: run.startedAt,
            })
          }

          if (run.status === 'completed') {
            sendSnapshotEvent('run:completed', {
              id: run.id,
              runId: run.id,
              inputTokens: run.inputTokens,
              outputTokens: run.outputTokens,
              costUsd: run.costUsd,
              completedAt: run.completedAt,
            })
          } else if (run.status === 'failed') {
            sendSnapshotEvent('run:failed', {
              id: run.id,
              runId: run.id,
              completedAt: run.completedAt,
              errorMessage: run.errorMessage,
            })
          }
        }

        const runIds = runs.map((run) => run.id)
        if (runIds.length === 0) return

        const existingArtifacts = await db
          .select()
          .from(artifacts)
          .where(inArray(artifacts.agentRunId, runIds))

        for (const artifact of existingArtifacts) {
          sendSnapshotEvent('artifact:created', {
            id: artifact.id,
            artifactId: artifact.id,
            agentRunId: artifact.agentRunId,
            artifactType: artifact.artifactType,
            content: artifact.content,
            metadata: artifact.metadata,
          })
        }

        const existingQuestions = await db
          .select()
          .from(taskQuestions)
          .where(eq(taskQuestions.taskId, taskId))
          .orderBy(asc(taskQuestions.createdAt))

        if (existingQuestions.length > 0) {
          sendSnapshotEvent('questions:created', {
            questions: existingQuestions.map((q) => ({
              id: q.id,
              question: q.question,
              suggestions: q.suggestions,
              answer: q.answer,
              status: q.status,
            })),
          })
        }
      }

      controller.enqueue(encoder.encode('retry: 5000\n\n'))

      // Replay missed events if Last-Event-ID was provided
      const lastId = parseInt(request.headers.get('last-event-id') ?? '0', 10)
      if (lastId > 0) {
        try {
          // zrangebyscore with WITHSCORES returns a flat string[] alternating [value, score, value, score, ...]
          const missed = await redis.zrangebyscore(
            `forge:task:${taskId}:history`,
            lastId + 1,
            '+inf',
            'WITHSCORES',
          )
          for (let i = 0; i < missed.length; i += 2) {
            const value = missed[i]
            const score = parseInt(missed[i + 1], 10)
            const { type, data } = JSON.parse(value) as { type: string; data: unknown }
            replaySend(score, type, data)
          }
        } catch (err) {
          console.error('[SSE /api/tasks/:id/runs] Error replaying missed events', err)
        }
      }

      // Create a DEDICATED subscriber client (cannot reuse the singleton for pub/sub)
      const { default: Redis } = await import('ioredis')
      const sub = new Redis(process.env.REDIS_URL!)

      let closed = false
      let heartbeat: ReturnType<typeof setInterval> | null = null

      const cleanup = () => {
        if (closed) return
        closed = true
        if (heartbeat !== null) {
          clearInterval(heartbeat)
        }
        sub.disconnect()
        try {
          controller.close()
        } catch {
          // controller may already be closed
        }
      }

      try {
        await sub.subscribe(`forge:task:${taskId}`)
      } catch (err) {
        console.error('[SSE /api/tasks/:id/runs] Failed to subscribe to Redis channel', err)
        cleanup()
        return
      }

      try {
        await sendCurrentSnapshot()
      } catch (err) {
        console.error('[SSE /api/tasks/:id/runs] Error sending current snapshot', err)
      }

      const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'rejected'])

      sub.on('message', (_channel: string, message: string) => {
        // Guard: if the controller is already closed, discard the event
        if (closed) return
        try {
          const event = JSON.parse(message) as { type: string; status?: string }
          void persistAndSend(event.type, event).then(() => {
            if (event.type === 'task:status' && TERMINAL.has(event.status ?? '')) {
              controller.enqueue(encoder.encode('data: [DONE]\n\n'))
              cleanup()
            }
          }).catch((err) => {
            console.error('[SSE /api/tasks/:id/runs] Error processing message', err)
          })
        } catch (err) {
          console.error('[SSE /api/tasks/:id/runs] Error processing message', err)
        }
      })

      sub.on('error', (err) => {
        console.error('[SSE /api/tasks/:id/runs] Redis subscriber error', err)
        cleanup()
      })

      heartbeat = setInterval(() => {
        if (closed) return
        try {
          // Heartbeats are ephemeral — enqueue directly without persisting
          controller.enqueue(encoder.encode(`event: heartbeat\ndata: ${JSON.stringify({ ts: new Date().toISOString() })}\n\n`))
        } catch {
          cleanup()
        }
      }, 30_000)

      request.signal.addEventListener('abort', cleanup)
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  })
}
