'use client'

import { useEffect, useRef, useState, useCallback } from 'react'

export interface AgentRun {
  id: string
  taskId: string
  agentType: string
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
}

interface UseTaskStreamResult {
  runs: AgentRun[]
  artifacts: Artifact[]
  taskStatus: string | null
  error: string | null
}

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'rejected'])

export function useTaskStream(taskId: string): UseTaskStreamResult {
  const [runs, setRuns] = useState<AgentRun[]>([])
  const [artifacts, setArtifacts] = useState<Artifact[]>([])
  const [taskStatus, setTaskStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Store streaming log chunks outside React state to avoid excessive re-renders.
  // Key: runId, Value: accumulated log string
  const chunkBufferRef = useRef<Map<string, string>>(new Map())
  const flushTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const esRef = useRef<EventSource | null>(null)

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

  useEffect(() => {
    if (!taskId) return

    const es = new EventSource(`/api/tasks/${taskId}/runs`)
    esRef.current = es

    // Flush buffered log chunks every 500ms to avoid excessive re-renders
    flushTimerRef.current = setInterval(flushChunks, 500)

    es.addEventListener('run:started', (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data)
        const run: AgentRun = {
          id: data.runId ?? data.id,
          taskId,
          agentType: data.agentType ?? '',
          modelIdUsed: data.modelIdUsed ?? '',
          status: 'running',
          inputTokens: null,
          outputTokens: null,
          costUsd: null,
          startedAt: data.startedAt ?? new Date().toISOString(),
          completedAt: null,
          errorMessage: null,
          logOutput: '',
        }
        setRuns((prev) => {
          // Avoid duplicates if event replays
          if (prev.some((r) => r.id === run.id)) return prev
          return [...prev, run]
        })
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
        const data = JSON.parse((e as MessageEvent).data)
        const runId: string = data.runId ?? data.id
        setRuns((prev) =>
          prev.map((r) =>
            r.id === runId
              ? {
                  ...r,
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
        const data = JSON.parse((e as MessageEvent).data)
        const runId: string = data.runId ?? data.id
        setRuns((prev) =>
          prev.map((r) =>
            r.id === runId
              ? {
                  ...r,
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
        const artifact: Artifact = {
          id: data.id ?? data.artifactId,
          agentRunId: data.agentRunId,
          artifactType: data.artifactType,
          content: data.content,
          metadata: data.metadata ?? null,
        }
        setArtifacts((prev) => {
          if (prev.some((a) => a.id === artifact.id)) return prev
          return [...prev, artifact]
        })
      } catch {
        // Ignore malformed event
      }
    })

    es.addEventListener('task:status', (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data)
        const status: string = data.status ?? data
        setTaskStatus(status)
        if (TERMINAL_STATUSES.has(status)) {
          // Flush any remaining chunks before closing
          flushChunks()
          es.close()
        }
      } catch {
        // Ignore malformed event
      }
    })

    es.onerror = () => {
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
  }, [taskId, flushChunks])

  return { runs, artifacts, taskStatus, error }
}
