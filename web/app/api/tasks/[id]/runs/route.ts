import type { NextRequest } from 'next/server'
import { db } from '@/db'
import { agentRuns, artifacts, taskQuestions, tasks } from '@/db/schema'
import { asc, eq, inArray } from 'drizzle-orm'
import { getSession } from '@/lib/session'
import { redis } from '@/lib/redis'
import type RedisClient from 'ioredis'
import { getAccessibleTask } from '@/lib/task-access'
import {
  parseTaskEventEnvelopeV2,
  safeTaskEventData,
  safeTaskEventType,
  type TaskEventEnvelopeV2,
} from '@/worker/events'
import { taskEventRedisConfiguration } from '@/lib/task-event-redis'

// ---------------------------------------------------------------------------
// SSE stream — GET /api/tasks/:id/runs
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSession(request)
  if (!session) return new Response('Unauthorized', { status: 401 })

  const { id: taskId } = await params

  // Verify task exists and belongs to this operator. Legacy null-owner tasks
  // remain readable so older local installs do not orphan history.
  const task = await getAccessibleTask(taskId, session.userId)
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
      let historyRedis: RedisClient = redis
      let ownsHistoryRedis = false

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
        if (ownsHistoryRedis) historyRedis.disconnect()
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

      const eventHistoryKey = `forge:task-events:v2:${taskId}:history`
      const eventSequenceKey = `forge:task-events:v2:${taskId}:seq`

      // replaySend: enqueues the SSE line directly WITHOUT writing to the sorted set.
      // Used only during the replay loop to avoid re-persisting already-stored events.
      const replaySend = (seqId: number, type: string, data: unknown) => {
        const safeType = safeTaskEventType(type)
        const line = `id: ${seqId}\nevent: ${safeType}\ndata: ${JSON.stringify(safeTaskEventData(safeType, data))}\n\n`
        enqueue(line)
      }

      const sendSnapshotEvent = (type: string, data: unknown) => {
        const safeType = safeTaskEventType(type)
        enqueue(`event: ${safeType}\ndata: ${JSON.stringify(safeTaskEventData(safeType, data))}\n\n`)
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
          const protectedArchitectHistory = artifact.artifactType === 'adr_text'
            && isRecord(artifact.metadata)
            && artifact.metadata.historyAvailable === true
          sendSnapshotEvent('artifact:created', protectedArchitectHistory
            ? {
                agentRunId: artifact.agentRunId,
                historyAvailable: true,
              }
            : {
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

      const lastId = parseInt(request.headers.get('last-event-id') ?? '0', 10)
      let lastDeliveredId = Number.isSafeInteger(lastId) && lastId > 0 ? lastId : 0
      let replaying = true
      const buffered: TaskEventEnvelopeV2[] = []
      const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'rejected'])

      const signalHistoryReset = (nextAvailableId: number) => {
        sendSnapshotEvent('stream:reset', {
          type: 'stream:reset',
          reason: 'retention_gap',
          requestedAfterId: lastDeliveredId,
          nextAvailableId,
        })
      }

      const replayRange = async (afterId: number, throughId: number): Promise<boolean> => {
        if (throughId <= afterId) return true
        const values = await historyRedis.zrangebyscore(
          eventHistoryKey,
          afterId + 1,
          throughId,
          'WITHSCORES',
        )
        let expectedId = afterId + 1
        for (let index = 0; index < values.length; index += 2) {
          const score = Number(values[index + 1])
          let parsed: TaskEventEnvelopeV2 | null = null
          try {
            parsed = parseTaskEventEnvelopeV2(JSON.parse(values[index]))
          } catch {
            parsed = null
          }
          if (!parsed || parsed.id === null || parsed.id !== score || score !== expectedId) return false
          replaySend(score, parsed.type, parsed.data)
          lastDeliveredId = score
          expectedId += 1
        }
        return expectedId > throughId
      }

      const deliverPublished = async (event: TaskEventEnvelopeV2) => {
        if (closed) return
        const safeType = safeTaskEventType(event.type)
        const safeData = safeTaskEventData(safeType, event.data)
        if (event.id !== null) {
          if (!Number.isSafeInteger(event.id) || event.id < 1 || event.id <= lastDeliveredId) return
          if (event.id > lastDeliveredId + 1) {
            const filled = await replayRange(lastDeliveredId, event.id - 1).catch(() => false)
            if (!filled) {
              signalHistoryReset(event.id)
              lastDeliveredId = event.id - 1
            }
          }
          lastDeliveredId = event.id
          replaySend(event.id, safeType, safeData)
        } else {
          enqueue(`event: ${safeType}\ndata: ${JSON.stringify(safeData)}\n\n`)
        }
        const status = isRecord(safeData) && typeof safeData.status === 'string'
          ? safeData.status
          : undefined
        if (safeType === 'task:status' && TERMINAL.has(status ?? '')) {
          enqueue('data: [DONE]\n\n')
          cleanup()
        }
      }

      // Subscribe and buffer first. Anything published before or during replay
      // is either present in durable history or retained here, then de-duplicated
      // by the producer-assigned event ID.
      const { default: Redis } = await import('ioredis')
      let eventRedisConfiguration
      try {
        eventRedisConfiguration = taskEventRedisConfiguration()
      } catch (error) {
        console.error('[SSE /api/tasks/:id/runs] Invalid task-event Redis configuration', error)
        cleanup()
        return
      }
      sub = new Redis(eventRedisConfiguration.subscriberUrl)
      if (eventRedisConfiguration.dedicated) {
        historyRedis = new Redis(eventRedisConfiguration.subscriberUrl)
        ownsHistoryRedis = true
      }
      let publishedQueue = Promise.resolve()
      sub.on('message', (_channel: string, message: string) => {
        try {
          const event = parseTaskEventEnvelopeV2(JSON.parse(message))
          if (!event) return
          if (replaying) buffered.push(event)
          else publishedQueue = publishedQueue.then(() => deliverPublished(event))
        } catch (err) {
          console.error('[SSE /api/tasks/:id/runs] Error processing message', err)
        }
      })
      sub.on('error', (err) => {
        console.error('[SSE /api/tasks/:id/runs] Redis subscriber error', err)
        cleanup()
      })

      try {
        await sub.subscribe(`forge:task:${taskId}`)
      } catch (err) {
        console.error('[SSE /api/tasks/:id/runs] Failed to subscribe to Redis channel', err)
        cleanup()
        return
      }

      if (lastDeliveredId > 0) {
        try {
          const rawSequence = await historyRedis.get(eventSequenceKey)
          const replayUpperBound = Number(rawSequence)
          if (Number.isSafeInteger(replayUpperBound) && replayUpperBound > lastDeliveredId) {
            const filled = await replayRange(lastDeliveredId, replayUpperBound)
            if (!filled) {
              signalHistoryReset(replayUpperBound)
              lastDeliveredId = replayUpperBound
            }
          }
        } catch (err) {
          console.error('[SSE /api/tasks/:id/runs] Error replaying missed events', err)
        }
      } else {
        try {
          const rawSequence = await historyRedis.get(eventSequenceKey)
          const currentSequence = Number(rawSequence)
          if (Number.isSafeInteger(currentSequence) && currentSequence > 0) {
            lastDeliveredId = currentSequence
          }
        } catch (err) {
          console.error('[SSE /api/tasks/:id/runs] Error reading the event baseline', err)
        }
      }
      replaying = false
      for (const event of buffered) await deliverPublished(event)
      buffered.length = 0

      try {
        await sendCurrentSnapshot()
      } catch (err) {
        if (!closed) {
          console.error('[SSE /api/tasks/:id/runs] Error sending current snapshot', err)
        }
      }
      if (closed) return

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
