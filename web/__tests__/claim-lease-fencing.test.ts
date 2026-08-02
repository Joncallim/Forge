import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ClaimLeaseFence,
  ClaimLeaseLostError,
} from '@/worker/claim-lease-fence'

const TASK_ID = '11111111-1111-4111-8111-111111111111'
const repoRoot = path.resolve(__dirname, '..')

function query(rows: unknown[]) {
  const chain: Record<string, unknown> = {
    then: (
      resolve: (value: unknown[]) => unknown,
      reject?: (reason: unknown) => unknown,
    ) => Promise.resolve(rows).then(resolve, reject),
  }
  for (const method of ['from', 'innerJoin', 'where', 'limit']) chain[method] = () => chain
  return chain
}

function installRuntimeSupportMocks(
  selectTaskRows: () => Record<string, unknown> = () => query([{ id: TASK_ID }]),
): void {
  vi.doMock('@/db', () => ({
    db: { select: vi.fn(selectTaskRows) },
  }))
  vi.doMock('@/db/schema', () => ({
    tasks: { id: 'tasks.id', status: 'tasks.status' },
    workPackages: {
      metadata: 'work_packages.metadata',
      status: 'work_packages.status',
      taskId: 'work_packages.task_id',
    },
  }))
  vi.doMock('drizzle-orm', () => ({ and: vi.fn(), eq: vi.fn() }))
  vi.doMock('@/worker/blocked-handoff-retry', () => ({
    enqueueDueBlockedHandoffRetries: vi.fn().mockResolvedValue(0),
  }))
  vi.doMock('@/lib/mcps/filesystem-grant-reconciliation', () => ({
    convergeRecognizedOperatorHolds: vi.fn().mockResolvedValue(0),
  }))
  vi.doMock('@/worker/work-package-handoff', () => ({
    reconcilePendingS4CompletionHandoffs: vi.fn().mockResolvedValue(0),
  }))
  vi.doMock('@/lib/session', () => ({
    reconcilePendingSessionCacheInvalidations: vi.fn().mockResolvedValue({
      claimed: 0,
      completed: 0,
      deferred: 0,
      stale: 0,
    }),
  }))
}

describe('queue claim lease fencing', () => {
  const envNames = [
    'FORGE_WORKER_CLAIM_TIMEOUT_SECONDS',
    'FORGE_WORKER_STUCK_JOB_RECOVERY_SECONDS',
    'FORGE_PROVIDER_HEALTH_INTERVAL_SECONDS',
    'FORGE_BLOCKED_HANDOFF_SWEEP_INTERVAL_SECONDS',
    'FORGE_SESSION_CACHE_PURGE_INTERVAL_SECONDS',
  ] as const
  const previousEnv = Object.fromEntries(envNames.map((name) => [name, process.env[name]]))

  afterEach(() => {
    vi.restoreAllMocks()
    vi.resetModules()
    delete (globalThis as typeof globalThis & { forgeWorkerRuntime?: unknown }).forgeWorkerRuntime
    for (const name of envNames) {
      const value = previousEnv[name]
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })

  it('keeps one stable signal and aborts in-flight provider work with a typed loss', async () => {
    const fence = new ClaimLeaseFence()
    const signal = fence.signal
    const provider = new Promise<void>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    })

    expect(fence.signal).toBe(signal)
    expect(fence.markLost()).toBe(true)
    expect(fence.markLost()).toBe(false)
    expect(fence.signal).toBe(signal)
    await expect(provider).rejects.toBeInstanceOf(ClaimLeaseLostError)
    expect(() => fence.assertOwned()).toThrow(ClaimLeaseLostError)
    expect(() => fence.throwIfLost()).toThrow('Queue claim lease ownership was lost.')
  })

  it('fences the stale worker for task, answers, and approval business and terminal boundaries', async () => {
    process.env.FORGE_WORKER_CLAIM_TIMEOUT_SECONDS = '1'
    process.env.FORGE_WORKER_STUCK_JOB_RECOVERY_SECONDS = '1'
    process.env.FORGE_PROVIDER_HEALTH_INTERVAL_SECONDS = '0'
    process.env.FORGE_BLOCKED_HANDOFF_SWEEP_INTERVAL_SECONDS = '0'
    process.env.FORGE_SESSION_CACHE_PURGE_INTERVAL_SECONDS = '0'

    for (const position of ['approval', 'answers', 'task'] as const) {
      vi.resetModules()
      delete (globalThis as typeof globalThis & { forgeWorkerRuntime?: unknown }).forgeWorkerRuntime
      const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const error = vi.spyOn(console, 'error').mockImplementation(() => {})
      vi.spyOn(console, 'info').mockImplementation(() => {})

      let claimCount = 0
      let renewalCount = 0
      let releaseBusiness!: () => void
      let signalBusinessStarted!: () => void
      const businessGate = new Promise<void>((resolve) => {
        releaseBusiness = resolve
      })
      const businessStarted = new Promise<void>((resolve) => {
        signalBusinessStarted = resolve
      })
      const oldWorkerMutation = vi.fn()
      const recoveredWorkerMutation = vi.fn()
      const targetJob = position === 'approval'
        ? { taskId: TASK_ID, action: 'approve' as const, attempt: 1 }
        : { taskId: TASK_ID, attempt: 1 }
      const targetRaw = JSON.stringify({
        schemaVersion: 1,
        occurrenceId: randomUUID(),
        job: targetJob,
      })
      const targetQueueCalls = {
        ack: vi.fn(),
        deadLetter: vi.fn(),
        retry: vi.fn(),
      }

      const queueClass = (kind: typeof position) => class {
        ack = kind === position ? targetQueueCalls.ack : vi.fn()
        claim = vi.fn(async () => {
          if (kind !== position) return null
          claimCount += 1
          if (claimCount === 1) {
            return {
              job: targetJob,
              occurrenceId: JSON.parse(targetRaw).occurrenceId as string,
              raw: targetRaw,
            }
          }
          return await new Promise<null>((resolve) => setTimeout(() => resolve(null), 5))
        })
        deadLetter = kind === position ? targetQueueCalls.deadLetter : vi.fn()
        disconnect = vi.fn()
        promoteDueRetries = vi.fn().mockResolvedValue(0)
        recoverStuckJobs = vi.fn().mockResolvedValue(0)
        release = vi.fn()
        renewClaim = vi.fn(async () => {
          if (kind !== position) return 'renewed' as const
          renewalCount += 1
          return renewalCount === 1 ? 'renewed' as const : 'stale_not_owner' as const
        })
        retry = kind === position ? targetQueueCalls.retry : vi.fn()
      }
      vi.doMock('@/worker/queue', () => ({
        AnswersQueue: queueClass('answers'),
        ApprovalQueue: queueClass('approval'),
        RetryPromotionConflictError: class RetryPromotionConflictError extends Error {},
        TaskQueue: queueClass('task'),
      }))

      const guardedBusiness = vi.fn(async (
        _taskId: string,
        options: { claimLeaseFence: ClaimLeaseFence },
      ) => {
        signalBusinessStarted()
        await businessGate
        options.claimLeaseFence.assertOwned()
        oldWorkerMutation()
      })
      const processAnsweredQuestions = position === 'answers' ? guardedBusiness : vi.fn()
      const processApproval = position === 'approval' ? guardedBusiness : vi.fn()
      const processTask = position === 'task' ? guardedBusiness : vi.fn()
      vi.doMock('@/worker/orchestrator', () => ({
        processAnsweredQuestions,
        processApproval,
        processTask,
      }))
      const finishTaskAttempt = vi.fn()
      const startTaskAttempt = vi.fn().mockResolvedValue({
        attemptId: `${position}-attempt`,
        recoveredOccurrence: false,
      })
      vi.doMock('@/worker/task-attempts', () => ({
        finishTaskAttempt,
        startTaskAttempt,
      }))
      installRuntimeSupportMocks()

      const { startWorker } = await import('@/worker/runtime')
      const handle = await startWorker('standalone')
      await businessStarted
      await vi.waitFor(() => {
        expect(warning).toHaveBeenCalledWith(
          '[worker] Queue claim lease lost',
          expect.objectContaining({
            phase: 'claim_lease_lost',
            queueName: position,
            taskId: TASK_ID,
          }),
        )
      }, { timeout: 3_000 })

      const recoveredFence = new ClaimLeaseFence()
      recoveredFence.assertOwned()
      recoveredWorkerMutation()
      releaseBusiness()

      await vi.waitFor(() => expect(guardedBusiness).toHaveBeenCalledOnce())
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(oldWorkerMutation).not.toHaveBeenCalled()
      expect(recoveredWorkerMutation).toHaveBeenCalledOnce()
      expect(startTaskAttempt).toHaveBeenCalledOnce()
      expect(finishTaskAttempt).not.toHaveBeenCalled()
      expect(targetQueueCalls.ack).not.toHaveBeenCalled()
      expect(targetQueueCalls.retry).not.toHaveBeenCalled()
      expect(targetQueueCalls.deadLetter).not.toHaveBeenCalled()
      expect(error).not.toHaveBeenCalledWith(
        '[worker] Queue infrastructure failure',
        expect.objectContaining({ phase: 'claim_renewal_periodic' }),
      )
      await handle.stop()
      await expect(handle.done).resolves.toBeUndefined()
      vi.restoreAllMocks()
    }
  }, 15_000)

  it('does not report a pre-attempt lease loss as an attempt persistence failure', async () => {
    process.env.FORGE_WORKER_CLAIM_TIMEOUT_SECONDS = '1'
    process.env.FORGE_WORKER_STUCK_JOB_RECOVERY_SECONDS = '1'
    process.env.FORGE_PROVIDER_HEALTH_INTERVAL_SECONDS = '0'
    process.env.FORGE_BLOCKED_HANDOFF_SWEEP_INTERVAL_SECONDS = '0'
    process.env.FORGE_SESSION_CACHE_PURGE_INTERVAL_SECONDS = '0'

    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const taskJob = { taskId: TASK_ID, attempt: 1 }
    const taskRaw = JSON.stringify({
      schemaVersion: 1,
      occurrenceId: randomUUID(),
      job: taskJob,
    })
    let claimCount = 0
    let renewalCount = 0
    const taskQueueCalls = {
      ack: vi.fn(),
      deadLetter: vi.fn(),
      retry: vi.fn(),
    }
    class EmptyQueue {
      ack = vi.fn()
      claim = vi.fn().mockResolvedValue(null)
      deadLetter = vi.fn()
      disconnect = vi.fn()
      promoteDueRetries = vi.fn().mockResolvedValue(0)
      recoverStuckJobs = vi.fn().mockResolvedValue(0)
      release = vi.fn()
      renewClaim = vi.fn().mockResolvedValue('renewed')
      retry = vi.fn()
    }
    class TargetQueue {
      ack = taskQueueCalls.ack
      claim = vi.fn(async () => {
        claimCount += 1
        if (claimCount === 1) {
          return {
            job: taskJob,
            occurrenceId: JSON.parse(taskRaw).occurrenceId as string,
            raw: taskRaw,
          }
        }
        return await new Promise<null>((resolve) => setTimeout(() => resolve(null), 5))
      })
      deadLetter = taskQueueCalls.deadLetter
      disconnect = vi.fn()
      promoteDueRetries = vi.fn().mockResolvedValue(0)
      recoverStuckJobs = vi.fn().mockResolvedValue(0)
      release = vi.fn()
      renewClaim = vi.fn(async () => {
        renewalCount += 1
        return renewalCount === 1 ? 'renewed' as const : 'stale_not_owner' as const
      })
      retry = taskQueueCalls.retry
    }
    vi.doMock('@/worker/queue', () => ({
      AnswersQueue: EmptyQueue,
      ApprovalQueue: EmptyQueue,
      RetryPromotionConflictError: class RetryPromotionConflictError extends Error {},
      TaskQueue: TargetQueue,
    }))
    const processTask = vi.fn()
    vi.doMock('@/worker/orchestrator', () => ({
      processAnsweredQuestions: vi.fn(),
      processApproval: vi.fn(),
      processTask,
    }))
    const finishTaskAttempt = vi.fn()
    const startTaskAttempt = vi.fn()
    vi.doMock('@/worker/task-attempts', () => ({
      finishTaskAttempt,
      startTaskAttempt,
    }))
    installRuntimeSupportMocks(() => {
      const chain = query([{ id: TASK_ID }])
      chain.then = (
        resolve: (value: unknown[]) => unknown,
        reject?: (reason: unknown) => unknown,
      ) => new Promise((settle) => setTimeout(settle, 475))
        .then(() => [{ id: TASK_ID }])
        .then(resolve, reject)
      return chain
    })

    const { startWorker } = await import('@/worker/runtime')
    const handle = await startWorker('standalone')
    await vi.waitFor(() => {
      expect(warning).toHaveBeenCalledWith(
        '[worker] Queue claim lease lost',
        expect.objectContaining({
          phase: 'claim_lease_lost',
          queueName: 'task',
          taskId: TASK_ID,
        }),
      )
    }, { timeout: 3_000 })
    await new Promise((resolve) => setTimeout(resolve, 100))

    expect(startTaskAttempt).not.toHaveBeenCalled()
    expect(finishTaskAttempt).not.toHaveBeenCalled()
    expect(processTask).not.toHaveBeenCalled()
    expect(taskQueueCalls.ack).not.toHaveBeenCalled()
    expect(taskQueueCalls.retry).not.toHaveBeenCalled()
    expect(taskQueueCalls.deadLetter).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalledWith(
      '[worker] Attempt persistence failure',
      expect.objectContaining({ phase: 'start' }),
    )
    await handle.stop()
    await expect(handle.done).resolves.toBeUndefined()
  })

  it('guards provider cancellation and every post-await persistence boundary in source', () => {
    const runtimeSource = fs.readFileSync(path.join(repoRoot, 'worker/runtime.ts'), 'utf8')
    const orchestratorSource = fs.readFileSync(path.join(repoRoot, 'worker/orchestrator.ts'), 'utf8')
    const handoffSource = fs.readFileSync(path.join(repoRoot, 'worker/work-package-handoff.ts'), 'utf8')
    const materializerSource = fs.readFileSync(
      path.join(repoRoot, 'worker/workforce-materializer.ts'),
      'utf8',
    )

    expect(runtimeSource).toContain('fence.markLost()')
    expect(runtimeSource).toContain("return 'lost'")
    expect(runtimeSource).toMatch(
      /await input\.processBusiness\(\s+finalAttempt,\s+claimLeaseFence,\s+executionContext,\s+\)\s+claimLeaseFence\.assertOwned\(\)/,
    )
    expect(runtimeSource).toMatch(
      /claimRenewal\.startDisposition !== 'established'[\s\S]{0,80}return/,
    )
    expect(orchestratorSource).toContain(
      "claimLeaseFence.signal.addEventListener('abort', abortForClaimLoss, { once: true })",
    )
    expect(orchestratorSource).toMatch(
      /streamText\(\{\s+abortSignal: controller\.signal/,
    )
    expect(orchestratorSource.indexOf('if (claimLeaseFence.lost || isClaimLeaseLostError(err))'))
      .toBeLessThan(orchestratorSource.indexOf('if (timedOut)'))
    const artifactWrite = orchestratorSource.indexOf(
      'const artifact = await createArchitectPlanArtifact',
    )
    const postArtifactGuard = orchestratorSource.indexOf(
      'claimLeaseFence.assertOwned()',
      artifactWrite,
    )
    const questionWrite = orchestratorSource.indexOf(
      'const openQuestionCount = await persistOpenQuestions',
      artifactWrite,
    )
    expect(artifactWrite).toBeGreaterThan(-1)
    expect(postArtifactGuard).toBeGreaterThan(artifactWrite)
    expect(questionWrite).toBeGreaterThan(postArtifactGuard)
    const architectResult = orchestratorSource.indexOf(
      'const { openQuestionCount, checkpoint } = await runArchitect',
    )
    const postArchitectGuard = orchestratorSource.indexOf(
      'claimLeaseFence.assertOwned()',
      architectResult,
    )
    const postArchitectStatus = orchestratorSource.indexOf(
      'updateTaskStatusIfCurrent(task.id, \'running\', nextStatus)',
      architectResult,
    )
    expect(architectResult).toBeGreaterThan(-1)
    expect(postArchitectGuard).toBeGreaterThan(architectResult)
    expect(postArchitectStatus).toBeGreaterThan(postArchitectGuard)
    expect(handoffSource).toContain('claimLeaseFence?: ClaimLeaseFence')
    expect(handoffSource).toContain('rethrowQueueClaimLoss(err, options)')
    expect(handoffSource).toMatch(
      /const execution = await executeWorkPackage\([\s\S]{0,240}assertQueueClaimOwned\(options\)/,
    )
    expect(orchestratorSource).toContain(
      'assertClaimOwned: () => claimLeaseFence.assertOwned()',
    )
    expect(materializerSource).toContain('input.assertClaimOwned?.()')
    expect(materializerSource).toMatch(
      /input\.assertClaimOwned\?\.\(\)\s+await db\.transaction/,
    )
  })
})
