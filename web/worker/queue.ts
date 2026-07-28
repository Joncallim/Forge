import { randomUUID } from 'node:crypto'
import Redis from 'ioredis'
import { getRequiredEnv } from '../lib/env'
import { scanJsonObjectKeys } from '../lib/json-object-key-scan'

const TASK_QUEUE_KEY = 'forge:tasks'
const TASK_PROCESSING_QUEUE_KEY = 'forge:tasks:processing'
const TASK_RETRY_QUEUE_KEY = 'forge:tasks:retry'
const TASK_DEAD_QUEUE_KEY = 'forge:tasks:dead'
const TASK_CLAIMS_KEY = 'forge:tasks:claims'
const APPROVAL_QUEUE_KEY = 'forge:approvals'
const APPROVAL_PROCESSING_QUEUE_KEY = 'forge:approvals:processing'
const APPROVAL_RETRY_QUEUE_KEY = 'forge:approvals:retry'
const APPROVAL_DEAD_QUEUE_KEY = 'forge:approvals:dead'
const APPROVAL_CLAIMS_KEY = 'forge:approvals:claims'
const ANSWERS_QUEUE_KEY = 'forge:answers'
const ANSWERS_PROCESSING_QUEUE_KEY = 'forge:answers:processing'
const ANSWERS_RETRY_QUEUE_KEY = 'forge:answers:retry'
const ANSWERS_DEAD_QUEUE_KEY = 'forge:answers:dead'
const ANSWERS_CLAIMS_KEY = 'forge:answers:claims'

type RetryableJob = {
  attempt?: number
}

const TASK_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const DEAD_LETTER_FAILURE_CATEGORY = 'job_processing_failed'
const STUCK_RECOVERY_SCAN_LIMIT = 100

const CLAIM_JOB_SCRIPT = `
-- forge:queue:claim-v1
local function assert_type(key, expected)
  local actual = redis.call('TYPE', key)['ok']
  if actual ~= 'none' and actual ~= expected then
    error('forge_queue_type_mismatch')
  end
end
assert_type(KEYS[1], 'list')
assert_type(KEYS[2], 'hash')
if not redis.call('LPOS', KEYS[1], ARGV[1]) then
  return 0
end
if redis.call('HEXISTS', KEYS[2], ARGV[1]) == 1 then
  return 0
end
local now = redis.call('TIME')
local claimed_at = (tonumber(now[1]) * 1000) + math.floor(tonumber(now[2]) / 1000)
local marker = tostring(claimed_at) .. ':' .. ARGV[2]
redis.call('HSET', KEYS[2], ARGV[1], marker)
return marker
`

const ACK_JOB_SCRIPT = `
-- forge:queue:ack-v1
local function assert_type(key, expected)
  local actual = redis.call('TYPE', key)['ok']
  if actual ~= 'none' and actual ~= expected then
    error('forge_queue_type_mismatch')
  end
end
assert_type(KEYS[1], 'list')
assert_type(KEYS[2], 'hash')
if redis.call('HGET', KEYS[2], ARGV[1]) ~= ARGV[2] then
  return 0
end
if redis.call('LREM', KEYS[1], 1, ARGV[1]) ~= 1 then
  return 0
end
redis.call('HDEL', KEYS[2], ARGV[1])
return 1
`

const DISCARD_INVALID_JOB_SCRIPT = `
-- forge:queue:discard-invalid-v1
local function assert_type(key, expected)
  local actual = redis.call('TYPE', key)['ok']
  if actual ~= 'none' and actual ~= expected then
    error('forge_queue_type_mismatch')
  end
end
assert_type(KEYS[1], 'list')
assert_type(KEYS[2], 'hash')
if redis.call('LREM', KEYS[1], 1, ARGV[1]) ~= 1 then
  return 0
end
redis.call('HDEL', KEYS[2], ARGV[1])
return 1
`

const RETRY_JOB_SCRIPT = `
-- forge:queue:retry-v1
local function assert_type(key, expected)
  local actual = redis.call('TYPE', key)['ok']
  if actual ~= 'none' and actual ~= expected then
    error('forge_queue_type_mismatch')
  end
end
assert_type(KEYS[1], 'list')
assert_type(KEYS[2], 'hash')
assert_type(KEYS[3], 'zset')
if redis.call('HGET', KEYS[2], ARGV[1]) ~= ARGV[2] then
  return 0
end
if redis.call('LREM', KEYS[1], 1, ARGV[1]) ~= 1 then
  return 0
end
redis.call('HDEL', KEYS[2], ARGV[1])
redis.call('ZADD', KEYS[3], ARGV[3], ARGV[4])
return 1
`

const DEAD_LETTER_JOB_SCRIPT = `
-- forge:queue:dead-letter-v1
local function assert_type(key, expected)
  local actual = redis.call('TYPE', key)['ok']
  if actual ~= 'none' and actual ~= expected then
    error('forge_queue_type_mismatch')
  end
end
assert_type(KEYS[1], 'list')
assert_type(KEYS[2], 'hash')
assert_type(KEYS[3], 'list')
if redis.call('HGET', KEYS[2], ARGV[1]) ~= ARGV[2] then
  return 0
end
if redis.call('LREM', KEYS[1], 1, ARGV[1]) ~= 1 then
  return 0
end
redis.call('HDEL', KEYS[2], ARGV[1])
redis.call('LPUSH', KEYS[3], ARGV[3])
return 1
`

const PROMOTE_RETRY_SCRIPT = `
-- forge:queue:promote-retry-v1
local function assert_type(key, expected)
  local actual = redis.call('TYPE', key)['ok']
  if actual ~= 'none' and actual ~= expected then
    error('forge_queue_type_mismatch')
  end
end
assert_type(KEYS[1], 'zset')
assert_type(KEYS[2], 'list')
if redis.call('ZREM', KEYS[1], ARGV[1]) ~= 1 then
  return 0
end
if not redis.call('LPOS', KEYS[2], ARGV[1]) then
  redis.call('LPUSH', KEYS[2], ARGV[1])
end
return 1
`

const RECOVER_STUCK_JOB_SCRIPT = `
-- forge:queue:recover-stuck-v1
local function assert_type(key, expected)
  local actual = redis.call('TYPE', key)['ok']
  if actual ~= 'none' and actual ~= expected then
    error('forge_queue_type_mismatch')
  end
end
assert_type(KEYS[1], 'list')
assert_type(KEYS[2], 'hash')
assert_type(KEYS[3], 'list')
if not redis.call('LPOS', KEYS[1], ARGV[1]) then
  return 0
end
local now = redis.call('TIME')
local now_ms = (tonumber(now[1]) * 1000) + math.floor(tonumber(now[2]) / 1000)
local claimed_marker = redis.call('HGET', KEYS[2], ARGV[1])
local claimed_at = nil
if claimed_marker then
  claimed_at = tonumber(string.match(claimed_marker, '^(%d+):'))
  if not claimed_at then
    error('forge_queue_claim_marker_invalid')
  end
end
if claimed_at and claimed_at > 0 and (now_ms - claimed_at) < tonumber(ARGV[2]) then
  return 0
end
if redis.call('LREM', KEYS[1], 1, ARGV[1]) ~= 1 then
  return 0
end
redis.call('HDEL', KEYS[2], ARGV[1])
if not redis.call('LPOS', KEYS[3], ARGV[1]) then
  redis.call('LPUSH', KEYS[3], ARGV[1])
end
return 1
`

export interface TaskJob {
  taskId: string
  attempt: number
}

export interface ClaimedTaskJob {
  raw: string
  job: TaskJob
}

export interface ApprovalJob {
  taskId: string
  action: 'approve'
  attempt: number
}

export interface ClaimedApprovalJob {
  raw: string
  job: ApprovalJob
}

export interface AnswersJob {
  taskId: string
  attempt: number
}

export interface ClaimedAnswersJob {
  raw: string
  job: AnswersJob
}

abstract class RedisListQueue<TJob extends RetryableJob> {
  protected readonly client: Redis
  private readonly activeClaimMarkers = new Map<string, string>()

  constructor(
    private readonly queueKey: string,
    private readonly processingQueueKey: string,
    private readonly retryQueueKey: string,
    private readonly deadQueueKey: string,
    private readonly claimsKey: string,
    redisUrl = getRequiredEnv('REDIS_URL'),
  ) {
    this.client = new Redis(redisUrl, {
      maxRetriesPerRequest: null,
      retryStrategy: (times) => Math.min(times * 100, 3000),
    })
    this.client.on('error', () => {
      console.warn('[worker/queue] Redis connection unavailable')
    })
  }

  protected abstract parse(raw: string): TJob

  private async transition(
    script: string,
    keys: readonly string[],
    args: readonly string[],
  ): Promise<boolean> {
    const result = await this.client.call('EVAL', script, keys.length, ...keys, ...args)
    if (result === 0) return false
    if (result === 1) return true
    throw new Error('Queue transition returned an invalid result')
  }

  private async transitionClaimed(
    script: string,
    raw: string,
    keys: readonly string[],
    args: readonly string[] = [],
  ): Promise<boolean> {
    const marker = this.activeClaimMarkers.get(raw)
    if (marker === undefined) return false
    const transitioned = await this.transition(script, keys, [raw, marker, ...args])
    this.activeClaimMarkers.delete(raw)
    return transitioned
  }

  async claim(timeoutSeconds: number): Promise<{ raw: string; job: TJob } | null> {
    const raw = await this.client.brpoplpush(
      this.queueKey,
      this.processingQueueKey,
      timeoutSeconds,
    )
    if (raw === null) return null

    let job: TJob
    try {
      job = this.parse(raw)
    } catch {
      await this.transition(
        DISCARD_INVALID_JOB_SCRIPT,
        [this.processingQueueKey, this.claimsKey],
        [raw],
      )
      console.warn('[worker/queue] Dropped invalid job payload')
      return null
    }

    const claimNonce = randomUUID()
    const marker = await this.client.call(
      'EVAL',
      CLAIM_JOB_SCRIPT,
      2,
      this.processingQueueKey,
      this.claimsKey,
      raw,
      claimNonce,
    )
    if (marker === 0) {
      throw new Error('Queue claim is no longer available')
    }
    if (typeof marker !== 'string' || !marker.endsWith(`:${claimNonce}`)) {
      throw new Error('Queue claim returned an invalid marker')
    }
    this.activeClaimMarkers.set(raw, marker)
    return { raw, job }
  }

  async ack(raw: string): Promise<void> {
    await this.transitionClaimed(
      ACK_JOB_SCRIPT,
      raw,
      [this.processingQueueKey, this.claimsKey],
    )
  }

  async retry(raw: string, job: TJob, delayMs: number): Promise<Date> {
    const canonicalJob = this.parse(JSON.stringify(job))
    const nextAttempt = (canonicalJob.attempt ?? 1) + 1
    const nextJob = this.parse(JSON.stringify({
      ...canonicalJob,
      attempt: nextAttempt,
    }))
    const nextRetryAt = new Date(Date.now() + delayMs)

    await this.transitionClaimed(
      RETRY_JOB_SCRIPT,
      raw,
      [this.processingQueueKey, this.claimsKey, this.retryQueueKey],
      [String(nextRetryAt.getTime()), JSON.stringify(nextJob)],
    )

    return nextRetryAt
  }

  async deadLetter(raw: string, job: TJob): Promise<void> {
    const canonicalJob = this.parse(JSON.stringify(job))
    await this.transitionClaimed(
      DEAD_LETTER_JOB_SCRIPT,
      raw,
      [this.processingQueueKey, this.claimsKey, this.deadQueueKey],
      [JSON.stringify({
        job: canonicalJob,
        failureCategory: DEAD_LETTER_FAILURE_CATEGORY,
        deadLetteredAt: new Date().toISOString(),
      })],
    )
  }

  async promoteDueRetries(limit = 20): Promise<number> {
    const due = await this.client.zrangebyscore(
      this.retryQueueKey,
      0,
      Date.now(),
      'LIMIT',
      0,
      limit,
    )

    let promoted = 0
    for (const raw of due) {
      const transitioned = await this.transition(
        PROMOTE_RETRY_SCRIPT,
        [this.retryQueueKey, this.queueKey],
        [raw],
      )
      if (transitioned) promoted += 1
    }

    return promoted
  }

  async recoverStuckJobs(staleMs: number): Promise<number> {
    if (!Number.isSafeInteger(staleMs) || staleMs < 0) {
      throw new Error('Queue stale interval must be a non-negative safe integer')
    }
    const processing = await this.client.lrange(
      this.processingQueueKey,
      0,
      STUCK_RECOVERY_SCAN_LIMIT - 1,
    )
    let recovered = 0

    for (const raw of processing) {
      const transitioned = await this.transition(
        RECOVER_STUCK_JOB_SCRIPT,
        [this.processingQueueKey, this.claimsKey, this.queueKey],
        [raw, String(staleMs)],
      )
      if (transitioned) {
        this.activeClaimMarkers.delete(raw)
        recovered += 1
      }
    }

    return recovered
  }

  disconnect(): void {
    this.activeClaimMarkers.clear()
    this.client.disconnect()
  }
}

function normalizeAttempt(job: Partial<RetryableJob>): number {
  if (job.attempt === undefined) return 1
  if (typeof job.attempt !== 'number' || !Number.isSafeInteger(job.attempt) || job.attempt < 1) {
    throw new Error('attempt must be a positive safe integer')
  }
  return job.attempt
}

function normalizeTaskId(value: unknown): string {
  if (typeof value !== 'string' || !TASK_ID_PATTERN.test(value)) {
    throw new Error('taskId must be a canonical UUID')
  }
  return value
}

function parseClosedJob(raw: string, allowedKeys: readonly string[]): Record<string, unknown> {
  if (scanJsonObjectKeys(raw) !== 'valid') {
    throw new Error('job payload is not closed JSON')
  }
  const parsed = JSON.parse(raw) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('job payload must be an object')
  }
  const job = parsed as Record<string, unknown>
  if (Object.keys(job).some((key) => !allowedKeys.includes(key))) {
    throw new Error('job payload contains unsupported fields')
  }
  return job
}

export class TaskQueue extends RedisListQueue<TaskJob> {
  constructor(redisUrl = getRequiredEnv('REDIS_URL')) {
    super(
      TASK_QUEUE_KEY,
      TASK_PROCESSING_QUEUE_KEY,
      TASK_RETRY_QUEUE_KEY,
      TASK_DEAD_QUEUE_KEY,
      TASK_CLAIMS_KEY,
      redisUrl,
    )
  }

  protected parse(raw: string): TaskJob {
    const job = parseClosedJob(raw, ['taskId', 'attempt']) as Partial<TaskJob>
    return { taskId: normalizeTaskId(job.taskId), attempt: normalizeAttempt(job) }
  }

  override async claim(timeoutSeconds: number): Promise<ClaimedTaskJob | null> {
    return super.claim(timeoutSeconds)
  }
}

export class ApprovalQueue extends RedisListQueue<ApprovalJob> {
  constructor(redisUrl = getRequiredEnv('REDIS_URL')) {
    super(
      APPROVAL_QUEUE_KEY,
      APPROVAL_PROCESSING_QUEUE_KEY,
      APPROVAL_RETRY_QUEUE_KEY,
      APPROVAL_DEAD_QUEUE_KEY,
      APPROVAL_CLAIMS_KEY,
      redisUrl,
    )
  }

  protected parse(raw: string): ApprovalJob {
    const job = parseClosedJob(raw, ['taskId', 'action', 'attempt']) as Partial<ApprovalJob>
    if (job.action !== 'approve') {
      throw new Error('approval action must be approve')
    }

    return { taskId: normalizeTaskId(job.taskId), action: job.action, attempt: normalizeAttempt(job) }
  }

  override async claim(timeoutSeconds: number): Promise<ClaimedApprovalJob | null> {
    return super.claim(timeoutSeconds)
  }
}

export class AnswersQueue extends RedisListQueue<AnswersJob> {
  constructor(redisUrl = getRequiredEnv('REDIS_URL')) {
    super(
      ANSWERS_QUEUE_KEY,
      ANSWERS_PROCESSING_QUEUE_KEY,
      ANSWERS_RETRY_QUEUE_KEY,
      ANSWERS_DEAD_QUEUE_KEY,
      ANSWERS_CLAIMS_KEY,
      redisUrl,
    )
  }

  protected parse(raw: string): AnswersJob {
    const job = parseClosedJob(raw, ['taskId', 'attempt']) as Partial<AnswersJob>
    return { taskId: normalizeTaskId(job.taskId), attempt: normalizeAttempt(job) }
  }

  override async claim(timeoutSeconds: number): Promise<ClaimedAnswersJob | null> {
    return super.claim(timeoutSeconds)
  }
}
