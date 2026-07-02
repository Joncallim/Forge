import type { NextRequest } from 'next/server'
import { db } from '@/db'
import { agentRuns, artifacts, taskQuestions, tasks } from '@/db/schema'
import { asc, eq, inArray } from 'drizzle-orm'
import { getSession } from '@/lib/session'
import { redis } from '@/lib/redis'
import type RedisClient from 'ioredis'

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

  // Cap how long a single SSE connection stays open. Next.js dev mode evicts
  // and recompiles inactive route chunks in the background (on-demand-entries
  // GC); a request held open far longer than that window can race a
  // concurrent recompile and surface a transient ENOENT on a dev build
  // manifest for an unrelated route (see issue #86). EventSource already
  // auto-reconnects using Last-Event-ID, so periodically closing and letting
  // the client reopen is invisible to the user but keeps any single
  // connection short-lived enough to avoid the race.
  const MAX_CONNECTION_MS = 55_000

  const stream = new ReadableStream({
    async start(controller) {
      let closed = false
      let heartbeat: ReturnType<typeof setInterval> | null = null
      let maxAgeTimer: ReturnType<typeof setTimeout> | null = null
      let sub: RedisClient | null = null

      const cleanup = () => {
        if (closed) return
        closed = true
        if (heartbeat !== null) {
          clearInterval(heartbeat)
        }
        if (maxAgeTimer !== null) {
          clearTimeout(maxAgeTimer)
        }
        sub?.disconnect()
        try {
          controller.close()
        } catch {
          // controller may already be closed
        }
      }

      const enqueue = (line: string): boolean => {
        if (closed) return false
        try {
          controller.enqueue(encoder.encode(line))
          return true
        } catch {
          cleanup()
          return false
        }
      }

      // persistAndSend: allocates a global monotonic sequence number, writes to the
      // sorted set using that number as the score, then enqueues the SSE line.
      // The score is the canonical event ID — Last-Event-ID from the client maps
      // directly to the sorted set score, so replay is exact.
      const persistAndSend = async (type: string, data: unknown) => {
        if (closed) return
        const seq = await redis.incr(`forge:task:${taskId}:seq`)
        const line = `id: ${seq}\nevent: ${type}\ndata: ${JSON.stringify(data)}\n\n`
        redis
          .zadd(`forge:task:${taskId}:history`, seq, JSON.stringify({ type, data }))
          .then(() => redis.expire(`forge:task:${taskId}:history`, 86400))
          .catch((err) => console.error('SSE history write failed:', err))
        enqueue(line)
      }

      // replaySend: enqueues the SSE line directly WITHOUT writing to the sorted set.
      // Used only during the replay loop to avoid re-persisting already-stored events.
      const replaySend = (seqId: number, type: string, data: unknown) => {
        const line = `id: ${seqId}\nevent: ${type}\ndata: ${JSON.stringify(data)}\n\n`
        enqueue(line)
      }

      const sendSnapshotEvent = (type: string, data: unknown) => {
        enqueue(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`)
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
              attemptNumber: run.attemptNumber,
              modelIdUsed: run.modelIdUsed,
              stage: run.stage,
              startedAt: run.startedAt,
              workPackageId: run.workPackageId,
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
              attemptNumber: run.attemptNumber,
              stage: run.stage,
              workPackageId: run.workPackageId,
            })
          } else if (run.status === 'failed') {
            sendSnapshotEvent('run:failed', {
              id: run.id,
              runId: run.id,
              completedAt: run.completedAt,
              errorMessage: run.errorMessage,
              attemptNumber: run.attemptNumber,
              stage: run.stage,
              workPackageId: run.workPackageId,
            })
          }
        }

        const runIds = runs.map((run) => run.id)
        const workPackageIdByRunId = new Map(
          runs
            .filter((run) => typeof run.workPackageId === 'string' && run.workPackageId.length > 0)
            .map((run) => [run.id, run.workPackageId as string]),
        )
        if (runIds.length === 0) return

        const existingArtifacts = await db
          .select()
          .from(artifacts)
          .where(inArray(artifacts.agentRunId, runIds))
          .orderBy(asc(artifacts.createdAt))

        for (const artifact of existingArtifacts) {
          sendSnapshotEvent('artifact:created', {
            id: artifact.id,
            artifactId: artifact.id,
            agentRunId: artifact.agentRunId,
            artifactType: artifact.artifactType,
            content: artifact.content,
            metadata: artifact.metadata,
            createdAt: artifact.createdAt,
            workPackageId: workPackageIdByRunId.get(artifact.agentRunId),
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

      enqueue('retry: 5000\n\n')

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
      sub = new Redis(process.env.REDIS_URL!)

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
        if (!closed) {
          console.error('[SSE /api/tasks/:id/runs] Error sending current snapshot', err)
        }
      }
      if (closed) return

      const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'rejected'])

      sub.on('message', (_channel: string, message: string) => {
        // Guard: if the controller is already closed, discard the event
        if (closed) return
        try {
          const event = JSON.parse(message) as { type: string; status?: string }
          void persistAndSend(event.type, event).then(() => {
            if (event.type === 'task:status' && TERMINAL.has(event.status ?? '')) {
              enqueue('data: [DONE]\n\n')
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
        // Heartbeats are ephemeral — enqueue directly without persisting
        enqueue(`event: heartbeat\ndata: ${JSON.stringify({ ts: new Date().toISOString() })}\n\n`)
      }, 30_000)

      // Close cleanly before the connection gets old enough to risk the dev
      // build-manifest race above. No [DONE] sentinel here — that's reserved
      // for genuine task completion. The `stream:cycling` event lets the
      // client distinguish this planned recycle from a real dropped
      // connection so it doesn't flash a "lost connection" message; the
      // EventSource still auto-reconnects via Last-Event-ID either way.
      maxAgeTimer = setTimeout(() => {
        if (closed) return
        enqueue('event: stream:cycling\ndata: {}\n\n')
        cleanup()
      }, MAX_CONNECTION_MS)

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
