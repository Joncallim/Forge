import type { NextRequest } from 'next/server'
import { getSession } from '@/lib/session'
import { getAccessibleTask } from '@/lib/task-access'
import { taskEventRedisConfiguration } from '@/lib/task-event-redis'
import { parseTaskEventEnvelopeV2 } from '@/worker/events'

// ---------------------------------------------------------------------------
// SSE stream — GET /api/tasks/events
//
// Lightweight dashboard-wide invalidation stream. It listens to Redis task
// status events and tells sidebar/task summary clients to refetch counts.
// The task-specific stream remains the source for run/artifact detail.
// ---------------------------------------------------------------------------

const MAX_CONNECTION_MS = 55_000

export async function GET(request: NextRequest) {
  const session = await getSession(request)
  if (!session) return new Response('Unauthorized', { status: 401 })

  const encoder = new TextEncoder()

  const stream = new ReadableStream({
    async start(controller) {
      const { default: Redis } = await import('ioredis')
      let eventRedisConfiguration
      try {
        eventRedisConfiguration = taskEventRedisConfiguration()
      } catch (error) {
        console.error('[SSE /api/tasks/events] Invalid task-event Redis configuration', error)
        controller.close()
        return
      }
      const sub = new Redis(eventRedisConfiguration.subscriberUrl)
      let closed = false
      let heartbeat: ReturnType<typeof setInterval> | null = null
      let maxAgeTimer: ReturnType<typeof setTimeout> | null = null

      const send = (type: string, data: unknown) => {
        controller.enqueue(encoder.encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`))
      }

      const cleanup = () => {
        if (closed) return
        closed = true
        if (heartbeat !== null) clearInterval(heartbeat)
        if (maxAgeTimer !== null) clearTimeout(maxAgeTimer)
        sub.disconnect()
        try {
          controller.close()
        } catch {
          // controller may already be closed
        }
      }

      controller.enqueue(encoder.encode('retry: 5000\n\n'))

      sub.on('pmessage', (_pattern: string, channel: string, message: string) => {
        if (closed) return
        void (async () => {
          try {
          const event = parseTaskEventEnvelopeV2(JSON.parse(message))
          if (!event || event.type !== 'task:status' || event.id === null) return
          const data = event.data && typeof event.data === 'object' && !Array.isArray(event.data)
            ? event.data as { status?: string; updatedAt?: string }
            : {}
          const taskId = channel.startsWith('forge:task:') ? channel.slice('forge:task:'.length) : null
          if (!taskId || !(await getAccessibleTask(taskId, session.userId))) return
          send('task:status', {
            taskId,
            status: data.status ?? null,
            updatedAt: data.updatedAt ?? null,
          })
          } catch (err) {
            console.error('[SSE /api/tasks/events] Error processing task event', err)
          }
        })()
      })

      sub.on('error', (err) => {
        console.error('[SSE /api/tasks/events] Redis subscriber error', err)
        cleanup()
      })

      try {
        await sub.psubscribe('forge:task:*')
      } catch (err) {
        console.error('[SSE /api/tasks/events] Failed to subscribe to Redis task channels', err)
        cleanup()
        return
      }

      heartbeat = setInterval(() => {
        if (closed) return
        try {
          send('heartbeat', { ts: new Date().toISOString() })
        } catch {
          cleanup()
        }
      }, 30_000)

      maxAgeTimer = setTimeout(() => {
        if (closed) return
        try {
          send('stream:cycling', {})
        } catch {
          // controller may already be closed
        }
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
