import Redis from 'ioredis'
import { getRequiredEnv } from '../lib/env'

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

function redisErrorMessage(err: Error): string {
  const aggregate = err as Error & { code?: string; errors?: { code?: string; message?: string }[] }
  return (
    err.message ||
    aggregate.code ||
    aggregate.errors?.map((nested) => nested.code ?? nested.message).filter(Boolean).join(', ') ||
    err.name
  )
}

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
    this.client.on('error', (err) => {
      console.warn('[worker/queue] Redis connection error:', redisErrorMessage(err))
    })
  }

  protected abstract parse(raw: string): TJob

  async claim(timeoutSeconds: number): Promise<{ raw: string; job: TJob } | null> {
    const raw = await this.client.brpoplpush(
      this.queueKey,
      this.processingQueueKey,
      timeoutSeconds,
    )
    if (raw === null) return null

    try {
      const job = this.parse(raw)
      await this.client.hset(this.claimsKey, raw, String(Date.now()))
      return { raw, job }
    } catch (err) {
      await this.ack(raw)
      console.warn('[worker/queue] Dropped invalid job payload', {
        queueKey: this.queueKey,
        raw,
        err,
      })
      return null
    }
  }

  async ack(raw: string): Promise<void> {
    await Promise.all([
      this.client.lrem(this.processingQueueKey, 1, raw),
      this.client.hdel(this.claimsKey, raw),
    ])
  }

  async retry(raw: string, job: TJob, delayMs: number): Promise<Date> {
    const nextAttempt = (job.attempt ?? 1) + 1
    const nextJob = {
      ...job,
      attempt: nextAttempt,
    }
    const nextRetryAt = new Date(Date.now() + delayMs)

    await Promise.all([
      this.client.zadd(this.retryQueueKey, nextRetryAt.getTime(), JSON.stringify(nextJob)),
      this.ack(raw),
    ])

    return nextRetryAt
  }

  async deadLetter(raw: string, errorMessage: string): Promise<void> {
    await Promise.all([
      this.client.lpush(this.deadQueueKey, JSON.stringify({
        raw,
        errorMessage,
        deadLetteredAt: new Date().toISOString(),
      })),
      this.ack(raw),
    ])
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
      const removed = await this.client.zrem(this.retryQueueKey, raw)
      if (removed > 0) {
        await this.client.lpush(this.queueKey, raw)
        promoted += 1
      }
    }

    return promoted
  }

  async recoverStuckJobs(staleMs: number): Promise<number> {
    const processing = await this.client.lrange(this.processingQueueKey, 0, -1)
    const now = Date.now()
    let recovered = 0

    for (const raw of processing) {
      const claimedAtRaw = await this.client.hget(this.claimsKey, raw)
      const claimedAt = claimedAtRaw ? Number(claimedAtRaw) : 0
      if (Number.isFinite(claimedAt) && claimedAt > 0 && now - claimedAt < staleMs) {
        continue
      }

      const removed = await this.client.lrem(this.processingQueueKey, 1, raw)
      if (removed > 0) {
        await Promise.all([
          this.client.hdel(this.claimsKey, raw),
          this.client.lpush(this.queueKey, raw),
        ])
        recovered += 1
      }
    }

    return recovered
  }

  disconnect(): void {
    this.client.disconnect()
  }
}

function normalizeAttempt(job: Partial<RetryableJob>): number {
  return typeof job.attempt === 'number' && Number.isInteger(job.attempt) && job.attempt > 0
    ? job.attempt
    : 1
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
    const job = JSON.parse(raw) as Partial<TaskJob>
    if (typeof job.taskId !== 'string' || job.taskId.length === 0) {
      throw new Error('taskId is required')
    }

    return { taskId: job.taskId, attempt: normalizeAttempt(job) }
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
    const job = JSON.parse(raw) as Partial<ApprovalJob>
    if (typeof job.taskId !== 'string' || job.taskId.length === 0) {
      throw new Error('taskId is required')
    }
    if (job.action !== 'approve') {
      throw new Error('approval action must be approve')
    }

    return { taskId: job.taskId, action: job.action, attempt: normalizeAttempt(job) }
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
    const job = JSON.parse(raw) as Partial<AnswersJob>
    if (typeof job.taskId !== 'string' || job.taskId.length === 0) {
      throw new Error('taskId is required')
    }

    return { taskId: job.taskId, attempt: normalizeAttempt(job) }
  }

  override async claim(timeoutSeconds: number): Promise<ClaimedAnswersJob | null> {
    return super.claim(timeoutSeconds)
  }
}
