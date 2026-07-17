import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import crypto from 'node:crypto'
import path from 'node:path'
import Redis from 'ioredis'
import postgres from 'postgres'
import type { BrowserContext, TestInfo } from '@playwright/test'
import { seedAgentConfigs } from '../db/seed-agents'
import { resolveDestructiveE2EEnvironment } from './destructive-environment'

const root = path.resolve(__dirname, '..')
const workerLogs = new WeakMap<ChildProcessWithoutNullStreams, string[]>()
const useProcessGroup = process.platform !== 'win32'

export type SeededSession = {
  userId: string
  sessionId: string
}

export type SeededTask = {
  projectId: string
  taskId: string
}

export type SeededWorkPackage = {
  packageId: string
}

export type SeededProject = {
  projectId: string
}

export function getBaseUrl(): string {
  return process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:3000'
}

function installedE2EEnvironment() {
  const environment = resolveDestructiveE2EEnvironment()
  // Playwright hooks and dynamically imported seed modules can run in separate
  // processes. Install only the already validated, dedicated test identities.
  process.env.DATABASE_URL = environment.databaseUrl
  process.env.REDIS_URL = environment.redisUrl
  return environment
}

function sqlClient() {
  const { databaseUrl } = installedE2EEnvironment()
  return postgres(databaseUrl, { max: 1 })
}

function redisClient() {
  const { redisUrl } = installedE2EEnvironment()
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
    // Epic 172 retains project, task, execution, and immutable grant history in
    // the dedicated E2E database. Hide prior project fixtures through the same
    // archive boundary as the product. Random fixture identities isolate all
    // retained S3 authority rows, so reset never needs elevated TRUNCATE rights.
    await sql.begin(async (tx) => {
      await tx`
        update projects
        set archived_at = coalesce(archived_at, now()), updated_at = now()
        where archived_at is null
      `
      await tx`delete from provider_configs`
      await tx`delete from sessions`
      await tx`delete from credentials`
    })
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

export async function seedProjectTask(input: {
  prompt?: string
  status: string
  title: string
  userId: string
}): Promise<SeededTask> {
  const sql = sqlClient()
  const projectId = crypto.randomUUID()
  const taskId = crypto.randomUUID()

  try {
    await sql`
      insert into projects (id, name, github_repo, default_branch, submitted_by)
      values (
        ${projectId},
        ${`${input.title} Project`},
        ${'owner/forge-controls'},
        ${'main'},
        ${input.userId}
      )
    `
    await sql`
      insert into tasks (id, project_id, submitted_by, title, prompt, status)
      values (
        ${taskId},
        ${projectId},
        ${input.userId},
        ${input.title},
        ${input.prompt ?? 'Seeded task detail controls prompt.'},
        ${input.status}
      )
    `
  } finally {
    await sql.end()
  }

  return { projectId, taskId }
}

export async function seedRequiredFilesystemPackage(input: {
  taskId: string
  title?: string
}): Promise<SeededWorkPackage> {
  const sql = sqlClient()
  const packageId = crypto.randomUUID()
  const title = input.title ?? 'Filesystem context package'
  const mcpRequirements = [{
    mcpId: 'filesystem',
    requirement: 'required',
    capabilities: ['filesystem.project.read', 'filesystem.project.search'],
    reason: 'Read and search project files for implementation context.',
  }]
  const metadata = {
    mcpGrantPhases: {
      proposed: {
        schemaVersion: 1,
        phase: 'proposed',
        status: 'proposed',
        grants: mcpRequirements,
      },
      effective: {
        schemaVersion: 1,
        phase: 'effective',
        status: 'not_issued',
      },
    },
  }

  try {
    await sql`
      insert into work_packages (
        id,
        task_id,
        assigned_role,
        title,
        summary,
        status,
        sequence,
        steps,
        required_capabilities,
        acceptance_criteria,
        mcp_requirements,
        review_requirement,
        metadata
      )
      values (
        ${packageId},
        ${input.taskId},
        ${'frontend'},
        ${title},
        ${'Needs bounded project filesystem context before execution.'},
        ${'pending'},
        ${1},
        ${JSON.stringify(['Review the project files.'])}::jsonb,
        ${JSON.stringify({ frontend: true })}::jsonb,
        ${JSON.stringify(['Context is available to the package.'])}::jsonb,
        ${JSON.stringify(mcpRequirements)}::jsonb,
        ${'qa_only'},
        ${JSON.stringify(metadata)}::jsonb
      )
    `
  } finally {
    await sql.end()
  }

  return { packageId }
}

export async function seedProject(input: {
  defaultBranch?: string
  githubRepo?: string | null
  name: string
  userId: string
}): Promise<SeededProject> {
  const sql = sqlClient()
  const projectId = crypto.randomUUID()

  try {
    await sql`
      insert into projects (id, name, github_repo, default_branch, submitted_by)
      values (
        ${projectId},
        ${input.name},
        ${input.githubRepo ?? 'owner/forge-composer'},
        ${input.defaultBranch ?? 'main'},
        ${input.userId}
      )
    `
  } finally {
    await sql.end()
  }

  return { projectId }
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
      FORGE_WORK_PACKAGE_EXECUTION: '0',
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
