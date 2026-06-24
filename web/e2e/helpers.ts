import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import crypto from 'node:crypto'
import path from 'node:path'
import Redis from 'ioredis'
import postgres from 'postgres'
import type { BrowserContext, TestInfo } from '@playwright/test'
import { seedAgentConfigs } from '../db/seed-agents'

const root = path.resolve(__dirname, '..')
const workerLogs = new WeakMap<ChildProcessWithoutNullStreams, string[]>()
const useProcessGroup = process.platform !== 'win32'

export type SeededSession = {
  userId: string
  sessionId: string
}

export function getBaseUrl(): string {
  return process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:3000'
}

function sqlClient() {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) throw new Error('DATABASE_URL is required for E2E tests')
  return postgres(databaseUrl, { max: 1 })
}

function redisClient() {
  const redisUrl = process.env.REDIS_URL
  if (!redisUrl) throw new Error('REDIS_URL is required for E2E tests')
  return new Redis(redisUrl, { maxRetriesPerRequest: 3 })
}

function isProcessMissing(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ESRCH'
  )
}

function signalWorker(worker: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): boolean {
  if (!worker.pid) return false

  try {
    if (useProcessGroup) {
      process.kill(-worker.pid, signal)
      return true
    }

    return worker.kill(signal)
  } catch (error) {
    if (isProcessMissing(error)) return false
    throw error
  }
}

function isWorkerRunning(worker: ChildProcessWithoutNullStreams): boolean {
  if (!worker.pid) return worker.exitCode === null && worker.signalCode === null

  if (!useProcessGroup) return worker.exitCode === null && worker.signalCode === null

  try {
    process.kill(-worker.pid, 0)
    return true
  } catch (error) {
    if (isProcessMissing(error)) return false
    throw error
  }
}

async function waitForWorkerStop(
  worker: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<void> {
  if (!isWorkerRunning(worker)) return

  await new Promise<void>((resolve) => {
    let settled = false

    const finish = () => {
      if (settled) return
      settled = true
      clearInterval(poll)
      clearTimeout(timeout)
      worker.off('exit', handleExit)
      resolve()
    }

    const handleExit = () => {
      if (!isWorkerRunning(worker)) finish()
    }

    const poll = setInterval(() => {
      if (!isWorkerRunning(worker)) finish()
    }, 100)

    const timeout = setTimeout(finish, timeoutMs)

    worker.once('exit', handleExit)
  })
}

export async function resetState(): Promise<void> {
  const sql = sqlClient()
  const redis = redisClient()

  try {
    await sql`
      truncate table
        artifacts,
        agent_runs,
        tasks,
        projects,
        agent_configs,
        provider_configs,
        sessions,
        credentials,
        users
      restart identity cascade
    `
    await redis.flushdb()
  } finally {
    await sql.end()
    redis.disconnect()
  }

  await seedAgentConfigs()
}

export async function seedSession(displayName = 'E2E Operator'): Promise<SeededSession> {
  const sql = sqlClient()
  const redis = redisClient()
  const userId = crypto.randomUUID()
  const sessionId = crypto.randomUUID()
  const now = Date.now()

  try {
    await sql`
      insert into users (id, display_name)
      values (${userId}, ${displayName})
    `
    await sql`
      insert into sessions (id, user_id, user_agent)
      values (${sessionId}, ${userId}, 'Playwright E2E')
    `
    await redis.set(
      `session:${sessionId}`,
      JSON.stringify({
        userId,
        credentialId: null,
        userAgent: 'Playwright E2E',
        ip: '127.0.0.1',
        lastSeenAt: now,
      }),
      'EX',
      60 * 60,
    )
  } finally {
    await sql.end()
    redis.disconnect()
  }

  return { userId, sessionId }
}

export async function installSessionCookie(
  context: BrowserContext,
  session: SeededSession,
): Promise<void> {
  await context.addCookies([
    {
      name: 'forge_session',
      value: session.sessionId,
      url: getBaseUrl(),
      httpOnly: true,
      sameSite: 'Strict',
    },
  ])
}

export async function startMockWorker(testInfo: TestInfo): Promise<ChildProcessWithoutNullStreams> {
  const worker = spawn('npm', ['run', 'worker'], {
    cwd: root,
    detached: useProcessGroup,
    env: {
      ...process.env,
      FORGE_WORKER_MOCK_ARCHITECT: '1',
      FORGE_WORKER_CLAIM_TIMEOUT_SECONDS: '1',
    },
  })

  const logs: string[] = []
  workerLogs.set(worker, logs)

  const append = (chunk: Buffer) => logs.push(chunk.toString())
  worker.stdout.on('data', append)
  worker.stderr.on('data', append)

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error(`Worker did not start.\n${logs.join('')}`))
    }, 15_000)

    const cleanup = () => {
      clearTimeout(timeout)
      worker.stdout.off('data', handleData)
      worker.stderr.off('data', handleData)
      worker.off('exit', handleExit)
    }

    const handleData = () => {
      if (logs.join('').includes('[worker] Started')) {
        cleanup()
        resolve()
      }
    }

    const handleExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup()
      reject(
        new Error(`Worker exited before startup with code ${code} and signal ${signal}.\n${logs.join('')}`),
      )
    }

    worker.stdout.on('data', handleData)
    worker.stderr.on('data', handleData)
    worker.once('exit', handleExit)
  })

  await testInfo.attach('worker-startup.log', {
    body: logs.join(''),
    contentType: 'text/plain',
  })

  return worker
}

export async function stopWorker(
  worker: ChildProcessWithoutNullStreams | null,
  testInfo?: TestInfo,
): Promise<void> {
  if (!worker) return

  if (isWorkerRunning(worker)) {
    signalWorker(worker, 'SIGTERM')
    await waitForWorkerStop(worker, 5_000)
  }

  if (isWorkerRunning(worker)) {
    signalWorker(worker, 'SIGKILL')
    await waitForWorkerStop(worker, 10_000)
  }

  const logs = workerLogs.get(worker)
  if (testInfo && logs) {
    await testInfo.attach('worker-full.log', {
      body: logs.join(''),
      contentType: 'text/plain',
    })
  }
  workerLogs.delete(worker)
}
