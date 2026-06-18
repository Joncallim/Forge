import Redis from 'ioredis'
import { getRequiredEnv } from '../lib/env'

const TASK_QUEUE_KEY = 'forge:tasks'
const TASK_PROCESSING_QUEUE_KEY = 'forge:tasks:processing'
const APPROVAL_QUEUE_KEY = 'forge:approvals'
const APPROVAL_PROCESSING_QUEUE_KEY = 'forge:approvals:processing'

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
}

export interface ClaimedTaskJob {
  raw: string
  job: TaskJob
}

export interface ApprovalJob {
  taskId: string
  action: 'approve'
}

export interface ClaimedApprovalJob {
  raw: string
  job: ApprovalJob
}

export class TaskQueue {
  private readonly client: Redis

  constructor(redisUrl = getRequiredEnv('REDIS_URL')) {
    this.client = new Redis(redisUrl, {
      maxRetriesPerRequest: null,
      retryStrategy: (times) => Math.min(times * 100, 3000),
    })
    this.client.on('error', (err) => {
      console.warn('[worker/queue] Redis connection error:', redisErrorMessage(err))
    })
  }

  async claim(timeoutSeconds: number): Promise<ClaimedTaskJob | null> {
    const raw = await this.client.brpoplpush(
      TASK_QUEUE_KEY,
      TASK_PROCESSING_QUEUE_KEY,
      timeoutSeconds,
    )

    if (raw === null) return null

    try {
      const job = JSON.parse(raw) as Partial<TaskJob>
      if (typeof job.taskId !== 'string' || job.taskId.length === 0) {
        throw new Error('taskId is required')
      }

      return { raw, job: { taskId: job.taskId } }
    } catch (err) {
      await this.ack(raw)
      console.warn('[worker/queue] Dropped invalid job payload', { raw, err })
      return null
    }
  }

  async ack(raw: string): Promise<void> {
    await this.client.lrem(TASK_PROCESSING_QUEUE_KEY, 1, raw)
  }

  disconnect(): void {
    this.client.disconnect()
  }
}

export class ApprovalQueue {
  private readonly client: Redis

  constructor(redisUrl = getRequiredEnv('REDIS_URL')) {
    this.client = new Redis(redisUrl, {
      maxRetriesPerRequest: null,
      retryStrategy: (times) => Math.min(times * 100, 3000),
    })
    this.client.on('error', (err) => {
      console.warn('[worker/queue] Redis connection error:', redisErrorMessage(err))
    })
  }

  async claim(timeoutSeconds: number): Promise<ClaimedApprovalJob | null> {
    const raw = await this.client.brpoplpush(
      APPROVAL_QUEUE_KEY,
      APPROVAL_PROCESSING_QUEUE_KEY,
      timeoutSeconds,
    )

    if (raw === null) return null

    try {
      const job = JSON.parse(raw) as Partial<ApprovalJob>
      if (typeof job.taskId !== 'string' || job.taskId.length === 0) {
        throw new Error('taskId is required')
      }
      if (job.action !== 'approve') {
        throw new Error('approval action must be approve')
      }

      return { raw, job: { taskId: job.taskId, action: job.action } }
    } catch (err) {
      await this.ack(raw)
      console.warn('[worker/queue] Dropped invalid approval payload', { raw, err })
      return null
    }
  }

  async ack(raw: string): Promise<void> {
    await this.client.lrem(APPROVAL_PROCESSING_QUEUE_KEY, 1, raw)
  }

  disconnect(): void {
    this.client.disconnect()
  }
}
