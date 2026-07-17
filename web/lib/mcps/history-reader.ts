import postgres from 'postgres'
import { randomUUID } from 'node:crypto'

export class HistoryReaderError extends Error {
  readonly code: 'configuration' | 'conflict' | 'invalid_evidence'

  constructor(code: HistoryReaderError['code'], message: string) {
    super(message)
    this.name = 'HistoryReaderError'
    this.code = code
  }
}

function historyReaderUrl(): string {
  const value = process.env.FORGE_ARCHITECT_PLAN_HISTORY_READER_DATABASE_URL?.trim()
  if (!value) {
    throw new HistoryReaderError(
      'configuration',
      'FORGE_ARCHITECT_PLAN_HISTORY_READER_DATABASE_URL is required.',
    )
  }
  return value
}

export type HistoryReadEntry = {
  requestId: string
  userId: string
  taskId: string
  planVersion: bigint
  readAt: Date
}

export async function recordHistoryRead(input: {
  planVersion: string
  taskId: string
  userId: string
}): Promise<string> {
  const requestId = randomUUID()
  const sql = postgres(historyReaderUrl(), {
    max: 1,
    prepare: true,
    onnotice: () => {},
    transform: { undefined: null },
  })
  try {
    await sql`
      insert into architect_plan_history_reads (id, request_id, user_id, task_id, plan_version, read_at)
      values (
        ${randomUUID()}::uuid,
        ${requestId}::uuid,
        ${input.userId}::uuid,
        ${input.taskId}::uuid,
        ${input.planVersion}::bigint,
        now()
      )
    `
    return requestId
  } catch (error) {
    const code =
      typeof error === 'object' &&
      error !== null &&
      'code' in error
        ? String((error as { code?: unknown }).code)
        : ''
    throw new HistoryReaderError(
      code === '23505' ? 'conflict' : 'invalid_evidence',
      'The protected history read failed closed.',
    )
  } finally {
    await sql.end({ timeout: 5 })
  }
}

export async function readHistoryLog(input: {
  taskId: string
  userId: string
}): Promise<readonly HistoryReadEntry[]> {
  const sql = postgres(historyReaderUrl(), {
    max: 1,
    prepare: true,
    onnotice: () => {},
    transform: { undefined: null },
  })
  try {
    return await sql<HistoryReadEntry[]>`
      select request_id as "requestId",
             user_id as "userId",
             task_id as "taskId",
             plan_version as "planVersion",
             read_at as "readAt"
      from architect_plan_history_reads
      where task_id = ${input.taskId}::uuid
        and user_id = ${input.userId}::uuid
      order by read_at desc
      limit 100
    `
  } catch (error) {
    throw new HistoryReaderError(
      'invalid_evidence',
      'The protected history read failed closed.',
    )
  } finally {
    await sql.end({ timeout: 5 })
  }
}
