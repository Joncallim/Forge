'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import { TASK_STATUS_REFRESH_EVENT } from '@/lib/task-events'

export interface AgentRun {
  id: string
  taskId: string
  workPackageId?: string | null
  agentType: string
  stage?: string | null
  attemptNumber?: number | null
  modelIdUsed: string
  status: string
  inputTokens: number | null
  outputTokens: number | null
  costUsd: string | null
  startedAt: string | null
  completedAt: string | null
  errorMessage: string | null
  logOutput?: string
}

export interface Artifact {
  id: string
  agentRunId: string
  artifactType: string
  content: string
  metadata: unknown
  createdAt?: string
  workPackageId?: string
}

export interface TaskQuestion {
  id: string
  question: string
  suggestions?: string[]
  answer: string | null
  status: string
}

interface UseTaskStreamResult {
  runs: AgentRun[]
  artifacts: Artifact[]
  taskStatus: string | null
  error: string | null
  refreshRevision: number
  // null means no questions:created/questions:answered event has been
  // received yet this session — callers should fall back to initial data
  // fetched on mount. Once an event arrives (even with an empty array), this
  // is trusted as the definitive current state.
  questions: TaskQuestion[] | null
}

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'rejected'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function nullableStringValue(value: unknown): string | null | undefined {
  if (value === null) return null
  return stringValue(value)
}

function nullableNumberValue(value: unknown): number | null | undefined {
  if (value === null) return null
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string' || value.trim() === '') return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function runIdFromStreamEventData(data: Record<string, unknown>): string {
  return stringValue(data.runId) ?? stringValue(data.id) ?? ''
}

function runLifecycleMetadataFromStreamEventData(data: unknown): Pick<AgentRun, 'attemptNumber' | 'stage' | 'workPackageId'> {
  if (!isRecord(data)) return {}
  return {
    attemptNumber: nullableNumberValue(data.attemptNumber),
    stage: nullableStringValue(data.stage),
    workPackageId: nullableStringValue(data.workPackageId),
  }
}

export function agentRunFromStartedStreamEventData(
  data: unknown,
  taskId: string,
  fallbackStartedAt: string,
): AgentRun | null {
  if (!isRecord(data)) return null
  const runId = runIdFromStreamEventData(data)
  if (runId === '') return null
  return {
    id: runId,
    taskId,
    ...runLifecycleMetadataFromStreamEventData(data),
    agentType: stringValue(data.agentType) ?? '',
    modelIdUsed: stringValue(data.modelIdUsed) ?? '',
    status: stringValue(data.status) ?? 'running',
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
    startedAt: stringValue(data.startedAt) ?? fallbackStartedAt,
    completedAt: null,
    errorMessage: null,
    logOutput: '',
  }
}

export function mergeAgentRun(existing: AgentRun, incoming: AgentRun): AgentRun {
  return {
    ...existing,
    ...incoming,
    workPackageId: incoming.workPackageId ?? existing.workPackageId ?? null,
    stage: incoming.stage ?? existing.stage ?? null,
    attemptNumber: incoming.attemptNumber ?? existing.attemptNumber ?? null,
    inputTokens: incoming.inputTokens ?? existing.inputTokens,
    outputTokens: incoming.outputTokens ?? existing.outputTokens,
    costUsd: incoming.costUsd ?? existing.costUsd,
    startedAt: incoming.startedAt ?? existing.startedAt,
    completedAt: incoming.completedAt ?? existing.completedAt,
    errorMessage: incoming.errorMessage ?? existing.errorMessage,
    logOutput: incoming.logOutput && incoming.logOutput !== ''
      ? incoming.logOutput
      : existing.logOutput ?? incoming.logOutput,
  }
}

export function mergeStreamAgentRun(runs: AgentRun[], incoming: AgentRun): AgentRun[] {
  const index = runs.findIndex((run) => run.id === incoming.id)
  if (index === -1) return [...runs, incoming]
  const next = [...runs]
  next[index] = mergeAgentRun(next[index], incoming)
  return next
}

export function artifactFromStreamEventData(data: unknown): Artifact {
  const value = data as Record<string, unknown>
  const metadata = value.metadata ?? null
  const metadataWorkPackageId = (
    typeof metadata === 'object' &&
    metadata !== null &&
    !Array.isArray(metadata) &&
    typeof (metadata as Record<string, unknown>).workPackageId === 'string'
  )
    ? (metadata as Record<string, unknown>).workPackageId as string
    : undefined
  return {
    id: typeof value.id === 'string' ? value.id : value.artifactId as string,
    agentRunId: value.agentRunId as string,
    artifactType: value.artifactType as string,
    content: value.content as string,
    metadata,
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : undefined,
    workPackageId: typeof value.workPackageId === 'string' ? value.workPackageId : metadataWorkPackageId,
  }
}

export function shouldRefreshTaskDetailsForArtifact(artifact: Artifact): boolean {
  return typeof artifact.workPackageId === 'string' && artifact.workPackageId.length > 0
}

export function useTaskStream(taskId: string): UseTaskStreamResult {
  const [runs, setRuns] = useState<AgentRun[]>([])
  const [artifacts, setArtifacts] = useState<Artifact[]>([])
  const [taskStatus, setTaskStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [questions, setQuestions] = useState<TaskQuestion[] | null>(null)
  const [refreshRevision, setRefreshRevision] = useState(0)

  // Store streaming log chunks outside React state to avoid excessive re-renders.
  // Key: runId, Value: accumulated log string
  //
  // Live Output lag (issue #90): the worker publishes each model-stream delta
  // to Redis immediately (see `result.textStream` loop in worker/orchestrator.ts)
  // and this 500ms buffer is the only deliberate batching on the client side.
  // Any remaining visible lag traces back to the upstream provider's own
  // token-streaming cadence (how often the model SDK yields chunks), which
  // Forge doesn't control and varies per provider/model. That's a
  // non-deterministic, external constraint, not a bug here — left unchanged
  // per the issue's own fallback acceptance criterion.
  const chunkBufferRef = useRef<Map<string, string>>(new Map())
  const flushTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const esRef = useRef<EventSource | null>(null)
  // Set when the server intentionally recycles the connection (see
  // `stream:cycling` in the SSE route) so the next onerror — the browser
  // closing and auto-reconnecting — isn't mistaken for a real drop.
  const expectingCycleRef = useRef(false)

  const flushChunks = useCallback(() => {
    const buffer = chunkBufferRef.current
    if (buffer.size === 0) return

    setRuns((prev) => {
      let changed = false
      const next = prev.map((run) => {
        const buffered = buffer.get(run.id)
        if (buffered === undefined) return run
        changed = true
        return { ...run, logOutput: (run.logOutput ?? '') + buffered }
      })
      buffer.clear()
      return changed ? next : prev
    })
  }, [])

  const requestDetailRefresh = useCallback(() => {
    setRefreshRevision((revision) => revision + 1)
  }, [])

  const requestGlobalTaskStatusRefresh = useCallback(() => {
    if (typeof window === 'undefined') return
    window.dispatchEvent(new Event(TASK_STATUS_REFRESH_EVENT))
  }, [])

  useEffect(() => {
    if (!taskId) return

    const es = new EventSource(`/api/tasks/${taskId}/runs`)
    esRef.current = es

    // Flush buffered log chunks every 500ms to avoid excessive re-renders
    flushTimerRef.current = setInterval(flushChunks, 500)

    es.addEventListener('run:started', (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data)
        const run = agentRunFromStartedStreamEventData(data, taskId, new Date().toISOString())
        if (!run) return
        setRuns((prev) => mergeStreamAgentRun(prev, run))
        requestGlobalTaskStatusRefresh()
      } catch {
        // Ignore malformed event
      }
    })

    es.addEventListener('run:chunk', (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data)
        const runId: string = data.runId ?? data.id
        const delta: string = data.delta ?? data.chunk ?? ''
        if (!runId || !delta) return
        // Accumulate in buffer; flush timer will commit to state
        chunkBufferRef.current.set(
          runId,
          (chunkBufferRef.current.get(runId) ?? '') + delta,
        )
      } catch {
        // Ignore malformed event
      }
    })

    es.addEventListener('run:completed', (e) => {
      try {
        flushChunks()
        const data = JSON.parse((e as MessageEvent).data)
        const runId: string = data.runId ?? data.id
        const lifecycleMetadata = runLifecycleMetadataFromStreamEventData(data)
        setRuns((prev) =>
          prev.map((r) =>
            r.id === runId
              ? {
                  ...r,
                  workPackageId: lifecycleMetadata.workPackageId ?? r.workPackageId ?? null,
                  stage: lifecycleMetadata.stage ?? r.stage ?? null,
                  attemptNumber: lifecycleMetadata.attemptNumber ?? r.attemptNumber ?? null,
                  status: 'completed',
                  inputTokens: data.inputTokens ?? r.inputTokens,
                  outputTokens: data.outputTokens ?? r.outputTokens,
                  costUsd: data.costUsd ?? r.costUsd,
                  completedAt: data.completedAt ?? new Date().toISOString(),
                }
              : r,
          ),
        )
      } catch {
        // Ignore malformed event
      }
    })

    es.addEventListener('run:failed', (e) => {
      try {
        flushChunks()
        const data = JSON.parse((e as MessageEvent).data)
        const runId: string = data.runId ?? data.id
        const lifecycleMetadata = runLifecycleMetadataFromStreamEventData(data)
        setRuns((prev) =>
          prev.map((r) =>
            r.id === runId
              ? {
                  ...r,
                  workPackageId: lifecycleMetadata.workPackageId ?? r.workPackageId ?? null,
                  stage: lifecycleMetadata.stage ?? r.stage ?? null,
                  attemptNumber: lifecycleMetadata.attemptNumber ?? r.attemptNumber ?? null,
                  status: 'failed',
                  completedAt: data.completedAt ?? new Date().toISOString(),
                  errorMessage: data.errorMessage ?? data.error ?? null,
                }
              : r,
          ),
        )
      } catch {
        // Ignore malformed event
      }
    })

    es.addEventListener('artifact:created', (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data)
        const artifact = artifactFromStreamEventData(data)
        setArtifacts((prev) => {
          if (prev.some((a) => a.id === artifact.id)) return prev
          return [...prev, artifact]
        })
        if (shouldRefreshTaskDetailsForArtifact(artifact)) {
          requestDetailRefresh()
        }
      } catch {
        // Ignore malformed event
      }
    })

    for (const eventType of [
      'approval_gate:created',
      'approval_gate:decided',
      'task:handoff',
      'work_package:handoff',
      'work_package:status',
    ]) {
      es.addEventListener(eventType, requestDetailRefresh)
    }

    es.addEventListener('questions:created', (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data)
        const incoming: TaskQuestion[] = Array.isArray(data.questions) ? data.questions : []
        // A fresh architect run replaces the prior question set for the task.
        setQuestions(incoming)
      } catch {
        // Ignore malformed event
      }
    })

    es.addEventListener('questions:answered', (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data)
        const answered: TaskQuestion[] = Array.isArray(data.questions) ? data.questions : []
        setQuestions((prev) =>
          (prev ?? []).map((q) => answered.find((a) => a.id === q.id) ?? q),
        )
      } catch {
        // Ignore malformed event
      }
    })

    es.addEventListener('task:status', (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data)
        const status: string = data.status ?? data
        setTaskStatus(status)
        requestGlobalTaskStatusRefresh()
        if (TERMINAL_STATUSES.has(status)) {
          // Flush any remaining chunks before closing
          flushChunks()
          es.close()
        }
      } catch {
        // Ignore malformed event
      }
    })

    es.addEventListener('stream:cycling', () => {
      expectingCycleRef.current = true
    })

    es.onerror = () => {
      if (expectingCycleRef.current) {
        expectingCycleRef.current = false
        return
      }
      // Only surface an error if the stream hasn't reached a terminal state
      setError((prev) => {
        if (prev) return prev
        return 'Lost connection to the task stream. Attempting to reconnect…'
      })
    }

    return () => {
      if (flushTimerRef.current !== null) {
        clearInterval(flushTimerRef.current)
        flushTimerRef.current = null
      }
      flushChunks()
      es.close()
      esRef.current = null
    }
  }, [taskId, flushChunks, requestDetailRefresh, requestGlobalTaskStatusRefresh])

  return { runs, artifacts, taskStatus, error, questions, refreshRevision }
}
