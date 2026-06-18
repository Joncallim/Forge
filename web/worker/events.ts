import { redis } from '../lib/redis'

export type TaskEventPayload = Record<string, unknown>

export async function publishTaskEvent(
  taskId: string,
  type: string,
  payload: TaskEventPayload = {},
): Promise<void> {
  await redis.publish(
    `forge:task:${taskId}`,
    JSON.stringify({
      type,
      ...payload,
    }),
  )
}
