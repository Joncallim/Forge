import { sanitizeLogStructuredValue } from '../lib/task-log-sanitization'
import { containsForbiddenV2EventData, projectV2TaskEventData } from '../lib/mcps/legacy-leakage-scrub'
import { taskEventPublisherRedis } from '../lib/task-event-redis'

export type TaskEventPayload = Record<string, unknown>

export type TaskEventEnvelopeV2 = {
  schemaVersion: 2
  id: number | null
  type: string
  data: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function safeTaskEventType(type: string): string {
  return /^[a-z][a-z0-9:_-]{0,99}$/.test(type) ? type : 'event:unavailable'
}

export function safeTaskEventData(type: string, data: unknown): unknown {
  const sanitized = sanitizeLogStructuredValue(data, {
    maxArrayItems: 100,
    maxDepth: 6,
    maxObjectKeys: 100,
    stringByteLimit: 16 * 1024,
  })
  const protectedArchitectHistory = type === 'artifact:created'
    && isRecord(sanitized)
    && (
      sanitized.historyAvailable === true
      || (isRecord(sanitized.metadata) && sanitized.metadata.historyAvailable === true)
    )
  if (!protectedArchitectHistory) return sanitized
  return {
    ...(typeof sanitized.agentRunId === 'string' ? { agentRunId: sanitized.agentRunId } : {}),
    historyAvailable: true,
  }
}

export function parseTaskEventEnvelopeV2(value: unknown): TaskEventEnvelopeV2 | null {
  if (!isRecord(value) || value.schemaVersion !== 2 || typeof value.type !== 'string'
    || safeTaskEventType(value.type) !== value.type || !Object.hasOwn(value, 'data')) return null
  const id = value.id
  if (id !== null && (!Number.isSafeInteger(id) || (id as number) < 1)) return null
  const projected = projectV2TaskEventData(value.type, value.data)
  if (projected === null || containsForbiddenV2EventData({ type: value.type, data: value.data })) return null
  return { schemaVersion: 2, id: id as number | null, type: value.type, data: projected }
}

const PERSIST_TASK_EVENT_V2 = `
local sequence = redis.call('INCR', KEYS[1])
local envelope = cjson.encode({
  schemaVersion = 2,
  id = sequence,
  type = ARGV[1],
  data = cjson.decode(ARGV[2])
})
redis.call('ZADD', KEYS[2], sequence, envelope)
local history_size = redis.call('ZCARD', KEYS[2])
local history_limit = tonumber(ARGV[4])
if history_size > history_limit then
  redis.call('ZREMRANGEBYRANK', KEYS[2], 0, history_size - history_limit - 1)
end
redis.call('PUBLISH', ARGV[3], envelope)
return sequence
`

const TASK_EVENT_HISTORY_LIMIT = 4096

export async function publishTaskEvent(
  taskId: string,
  type: string,
  payload: TaskEventPayload = {},
): Promise<void> {
  const safeType = safeTaskEventType(type)
  if (safeType !== type) throw new Error('The task-event type is invalid.')
  const safeData = safeTaskEventData(safeType, { type: safeType, ...payload })
  const durableData = projectV2TaskEventData(safeType, safeData)
  if (durableData === null) {
    throw new Error(`Task event '${safeType}' does not match the closed v2 schema.`)
  }
  const redis = taskEventPublisherRedis()
  const rawId = await redis.eval(
    PERSIST_TASK_EVENT_V2,
    2,
    `forge:task-events:v2:${taskId}:seq`,
    `forge:task-events:v2:${taskId}:history`,
    safeType,
    JSON.stringify(durableData),
    `forge:task:${taskId}`,
    String(TASK_EVENT_HISTORY_LIMIT),
  )
  const id = Number(rawId)
  if (!Number.isSafeInteger(id) || id < 1) {
    throw new Error('The durable task-event sequence was invalid.')
  }
}
