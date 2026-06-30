import { redis } from '../lib/redis'

const APPROVAL_QUEUE_KEY = 'forge:approvals'
const DEDUPE_KEY_PREFIX = 'forge:blocked-handoff-retry:'
const DEFAULT_DEDUPE_TTL_SECONDS = 60
const DEFAULT_AUTO_RETRY_DELAY_MS = 5 * 60 * 1000
const MAX_AUTO_RETRY_ATTEMPTS = 3

type JsonObject = Record<string, unknown>

export type BlockedHandoffRetryEnqueueResult = {
  status: 'already_queued' | 'enqueued'
}

export type BlockedHandoffRetryRow = {
  metadata: unknown
  taskId: string
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

export function buildMcpBrokerBlockMetadata(input: {
  blocked: string[]
  blockedAt: Date
  blockedReason: string
  existingMetadata: unknown
  retryable: boolean
  warnings: string[]
}): JsonObject {
  const existingMetadata = isRecord(input.existingMetadata) ? input.existingMetadata : {}
  const existingBroker = isRecord(existingMetadata.mcpBroker) ? existingMetadata.mcpBroker : {}
  const existingReason = stringValue(existingBroker.blockedReason)
  const existingAttempts = numberValue(existingBroker.autoRetryAttempts) ?? 0
  const autoRetryAttempts = input.retryable && existingReason === input.blockedReason
    ? existingAttempts + 1
    : input.retryable ? 1 : 0
  const nextAutoRetryAt =
    input.retryable && autoRetryAttempts <= MAX_AUTO_RETRY_ATTEMPTS
      ? new Date(input.blockedAt.getTime() + DEFAULT_AUTO_RETRY_DELAY_MS).toISOString()
      : null

  return {
    ...existingMetadata,
    mcpBroker: {
      autoRetryAttempts,
      blocked: input.blocked.slice(0, 20),
      blockedAt: input.blockedAt.toISOString(),
      blockedReason: input.blockedReason,
      nextAutoRetryAt,
      retryable: input.retryable && autoRetryAttempts <= MAX_AUTO_RETRY_ATTEMPTS,
      status: 'blocked',
      warnings: input.warnings.slice(0, 20),
    },
  }
}

export function shouldAutoRetryBlockedHandoff(metadata: unknown, now = new Date()): boolean {
  if (!isRecord(metadata) || !isRecord(metadata.mcpBroker)) return false
  const broker = metadata.mcpBroker
  if (broker.retryable !== true) return false

  const attempts = numberValue(broker.autoRetryAttempts) ?? 0
  if (attempts < 1 || attempts > MAX_AUTO_RETRY_ATTEMPTS) return false

  const nextAutoRetryAt = stringValue(broker.nextAutoRetryAt)
  if (!nextAutoRetryAt) return false
  const nextRetryMs = new Date(nextAutoRetryAt).getTime()
  return Number.isFinite(nextRetryMs) && nextRetryMs <= now.getTime()
}

export async function enqueueBlockedHandoffRetry(
  taskId: string,
  options: { dedupeTtlSeconds?: number; source?: string } = {},
): Promise<BlockedHandoffRetryEnqueueResult> {
  const ttl = options.dedupeTtlSeconds ?? DEFAULT_DEDUPE_TTL_SECONDS
  const key = `${DEDUPE_KEY_PREFIX}${taskId}`
  const marker = JSON.stringify({
    enqueuedAt: new Date().toISOString(),
    source: options.source ?? 'unknown',
    taskId,
  })
  const setResult = await redis.set(key, marker, 'EX', ttl, 'NX')
  if (setResult !== 'OK') return { status: 'already_queued' }

  try {
    await redis.lpush(APPROVAL_QUEUE_KEY, JSON.stringify({ taskId, action: 'approve' }))
  } catch (err) {
    await redis.del(key).catch(() => undefined)
    throw err
  }
  return { status: 'enqueued' }
}

export async function enqueueDueBlockedHandoffRetries(
  rows: BlockedHandoffRetryRow[],
  options: {
    enqueue?: (taskId: string, options?: { source?: string }) => Promise<BlockedHandoffRetryEnqueueResult>
    now?: Date
    source?: string
  } = {},
): Promise<number> {
  const now = options.now ?? new Date()
  const enqueue = options.enqueue ?? ((taskId, enqueueOptions) => enqueueBlockedHandoffRetry(taskId, enqueueOptions))
  const source = options.source ?? 'blocked-handoff-sweep'
  const attemptedTaskIds = new Set<string>()
  let enqueued = 0

  for (const row of rows) {
    if (attemptedTaskIds.has(row.taskId) || !shouldAutoRetryBlockedHandoff(row.metadata, now)) continue
    attemptedTaskIds.add(row.taskId)
    const result = await enqueue(row.taskId, { source })
    if (result.status === 'enqueued') enqueued += 1
  }

  return enqueued
}
