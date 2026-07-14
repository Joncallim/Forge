import { redis } from '../lib/redis'
import type { McpBrokerAdmissionCheck } from '../lib/mcps/admission'

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
  blockedAt: Date
  check: McpBrokerAdmissionCheck
  existingMetadata: unknown
}): JsonObject {
  const blockedReason = stringValue(input.check.blockedReason)
  if (input.check.status !== 'blocked' || input.check.blocked.length === 0 || !blockedReason) {
    throw new Error('Canonical MCP broker metadata requires a blocked check with a blocked reason.')
  }
  const existingMetadata = isRecord(input.existingMetadata) ? input.existingMetadata : {}
  const existingBroker = isRecord(existingMetadata.mcpBroker) ? existingMetadata.mcpBroker : {}
  const existingReason = stringValue(existingBroker.blockedReason)
  const existingAttempts = numberValue(existingBroker.autoRetryAttempts) ?? 0
  const autoRetryAttempts = input.check.retryable && existingReason === blockedReason
    ? existingAttempts + 1
    : input.check.retryable ? 1 : 0
  const nextAutoRetryAt =
    input.check.retryable && autoRetryAttempts <= MAX_AUTO_RETRY_ATTEMPTS
      ? new Date(input.blockedAt.getTime() + DEFAULT_AUTO_RETRY_DELAY_MS).toISOString()
      : null
  const decisions = [
    ...input.check.evaluations.map((evaluation) => ({
      kind: 'requirement',
      ...evaluation.decision,
      requirementKey: evaluation.source.requirementKey,
      decisionId: evaluation.source.decisionId,
      sourceRequirementIndex: evaluation.source.sourceRequirementIndex,
    })),
    ...input.check.subtaskDecisions.map((decision) => ({ kind: 'subtask', ...decision })),
  ]
  const evidence = input.check.evaluations.map((evaluation) => ({
    kind: 'requirement',
    requirementKey: evaluation.source.requirementKey,
    decisionId: evaluation.source.decisionId,
    source: { ...evaluation.source },
    health: { ...evaluation.health },
    evidenceRefs: [...evaluation.decision.evidenceRefs],
  }))

  return {
    ...existingMetadata,
    mcpBroker: {
      schemaVersion: 1,
      autoRetryAttempts,
      blocked: [...input.check.blocked],
      blockedAt: input.blockedAt.toISOString(),
      blockedReason,
      decisions,
      evidence,
      mode: input.check.primaryMode ?? null,
      nextAutoRetryAt,
      primaryMode: input.check.primaryMode ?? null,
      primaryDecision: input.check.primaryDecision ? {
        ...input.check.primaryDecision,
        evidenceRefs: [...input.check.primaryDecision.evidenceRefs],
      } : null,
      primaryRecoveryAction: input.check.primaryRecoveryAction ?? null,
      primaryRetryableContribution: input.check.primaryDecision?.retryableContribution ?? null,
      recoveryAction: input.check.primaryRecoveryAction ?? null,
      retryable: input.check.retryable,
      status: 'blocked',
      warnings: [...input.check.warnings],
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
