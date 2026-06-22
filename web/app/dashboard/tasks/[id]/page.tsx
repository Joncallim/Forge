'use client'

import { useState, useEffect, useCallback } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { ExternalLinkIcon, ArrowLeftIcon, ChevronDownIcon, ChevronUpIcon, CircleAlertIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { MarkdownView } from '@/components/MarkdownView'
import { useTaskStream } from '@/hooks/useTaskStream'
import type { AgentRun, Artifact } from '@/hooks/useTaskStream'

interface Task {
  id: string
  projectId: string
  title: string
  prompt: string
  status: string
  githubPrUrl: string | null
  errorMessage: string | null
  createdAt: string
  updatedAt: string
}

interface TaskAttempt {
  id: string
  taskId: string
  queueName: string
  attemptNumber: number
  status: string
  workerId: string | null
  errorMessage: string | null
  claimedAt: string
  startedAt: string | null
  completedAt: string | null
  nextRetryAt: string | null
  createdAt: string
}

type StatusVariant = 'default' | 'secondary' | 'destructive' | 'outline'

function statusBadgeVariant(status: string): StatusVariant {
  switch (status) {
    case 'running': return 'default'
    case 'awaiting_approval': return 'outline'
    case 'approved':
    case 'completed': return 'secondary'
    case 'failed':
    case 'rejected':
    case 'cancelled': return 'destructive'
    default: return 'outline'
  }
}

function statusLabel(status: string): string {
  return status.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

function formatDatetime(iso: string | null): string {
  if (!iso) return '—'
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso))
}

function formatCost(usd: string | null): string {
  if (usd === null) return '—'
  const num = parseFloat(usd)
  if (isNaN(num)) return '—'
  return `$${num.toFixed(4)}`
}

// ---------------------------------------------------------------------------
// AgentRunRow — expandable row showing a single agent run and its log output
// ---------------------------------------------------------------------------
function AgentRunRow({ run }: { run: AgentRun }) {
  const [expanded, setExpanded] = useState(run.status === 'running')

  useEffect(() => {
    if (run.status === 'running') setExpanded(true)
  }, [run.status])

  const runStatusVariant = (): StatusVariant => {
    switch (run.status) {
      case 'running': return 'default'
      case 'completed': return 'secondary'
      case 'failed': return 'destructive'
      default: return 'outline'
    }
  }

  return (
    <li className="border-b border-border last:border-0">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center justify-between gap-4 px-4 py-3 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        aria-expanded={expanded}
        aria-label={`${expanded ? 'Collapse' : 'Expand'} agent run: ${run.agentType}`}
      >
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <span className="font-medium text-foreground capitalize">{run.agentType}</span>
          <Badge variant={runStatusVariant()}>{statusLabel(run.status)}</Badge>
        </div>
        <div className="flex items-center gap-4 text-xs text-muted-foreground">
          {run.inputTokens !== null && (
            <span aria-label={`Input tokens: ${run.inputTokens}`}>{run.inputTokens.toLocaleString()} in</span>
          )}
          {run.outputTokens !== null && (
            <span aria-label={`Output tokens: ${run.outputTokens}`}>{run.outputTokens.toLocaleString()} out</span>
          )}
          {run.costUsd !== null && (
            <span aria-label={`Cost: ${formatCost(run.costUsd)}`}>{formatCost(run.costUsd)}</span>
          )}
          <span className="hidden sm:inline">{run.modelIdUsed}</span>
          {expanded ? (
            <ChevronUpIcon className="size-4 shrink-0" aria-hidden="true" />
          ) : (
            <ChevronDownIcon className="size-4 shrink-0" aria-hidden="true" />
          )}
        </div>
      </button>

      {expanded && (
        <div className="border-t border-border bg-muted/20 px-4 py-3">
          {/* Metadata row */}
          <dl className="mb-3 grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
            <div>
              <dt className="text-muted-foreground">Model</dt>
              <dd className="font-mono">{run.modelIdUsed || '—'}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Started</dt>
              <dd>{formatDatetime(run.startedAt)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Completed</dt>
              <dd>{formatDatetime(run.completedAt)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Cost</dt>
              <dd>{formatCost(run.costUsd)}</dd>
            </div>
          </dl>

          {/* Error message */}
          {run.errorMessage !== null && (
            <div
              role="alert"
              className="mb-3 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
            >
              {run.errorMessage}
            </div>
          )}

          {/* Streaming log output */}
          {run.logOutput !== undefined && run.logOutput !== '' && (
            <div>
              <p className="mb-1 text-xs font-medium text-muted-foreground">Live output</p>
              <div
                className="max-h-96 overflow-y-auto rounded-lg bg-background/80 p-3 ring-1 ring-border"
                aria-label="Agent live Markdown output"
              >
                <MarkdownView content={run.logOutput} compact />
              </div>
            </div>
          )}

          {run.status === 'running' && (run.logOutput === undefined || run.logOutput === '') && (
            <p className="text-xs text-muted-foreground italic">Waiting for output…</p>
          )}
        </div>
      )}
    </li>
  )
}

// ---------------------------------------------------------------------------
// ArtifactView — renders a single artifact based on its type
// ---------------------------------------------------------------------------
function ArtifactView({ artifact }: { artifact: Artifact }) {
  const renderContent = () => {
    switch (artifact.artifactType) {
      case 'pr_url':
        return (
          <a
            href={artifact.content}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-sm text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label="Open pull request"
          >
            {artifact.content}
            <ExternalLinkIcon className="size-3.5" aria-hidden="true" />
          </a>
        )
      case 'file_diff':
        return (
          <pre className="max-h-80 overflow-y-auto rounded-lg bg-background/80 p-3 font-mono text-xs text-foreground ring-1 ring-border">
            {artifact.content}
          </pre>
        )
      case 'test_report':
        return (
          <pre className="max-h-80 overflow-y-auto rounded-lg bg-background/80 p-3 font-mono text-xs text-foreground ring-1 ring-border">
            {artifact.content}
          </pre>
        )
      case 'adr_text':
      case 'review_finding':
        return (
          <div className="rounded-lg bg-muted/40 px-4 py-3">
            <MarkdownView content={artifact.content} />
          </div>
        )
      default:
        return (
          <pre className="max-h-72 overflow-y-auto rounded-lg bg-background/80 p-3 font-mono text-xs text-foreground ring-1 ring-border">
            {artifact.content}
          </pre>
        )
    }
  }

  const typeLabel = artifact.artifactType.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())

  return (
    <div className="rounded-xl border border-border p-4">
      <p className="mb-2 text-xs font-medium text-muted-foreground uppercase tracking-wide">{typeLabel}</p>
      {renderContent()}
    </div>
  )
}

function TaskAttemptRow({ attempt }: { attempt: TaskAttempt }) {
  const variant: StatusVariant =
    attempt.status === 'completed'
      ? 'secondary'
      : attempt.status === 'failed' || attempt.status === 'dead_lettered'
        ? 'destructive'
        : 'outline'

  return (
    <li className="border-b border-border px-4 py-3 last:border-0">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="font-medium text-foreground">{attempt.queueName}</span>
          <span className="text-muted-foreground">attempt {attempt.attemptNumber}</span>
          <Badge variant={variant}>{statusLabel(attempt.status)}</Badge>
        </div>
        <span className="font-mono text-xs text-muted-foreground">
          {attempt.workerId ?? 'worker pending'}
        </span>
      </div>

      <dl className="mt-2 grid gap-x-4 gap-y-1 text-xs sm:grid-cols-3">
        <div>
          <dt className="text-muted-foreground">Started</dt>
          <dd>{formatDatetime(attempt.startedAt ?? attempt.claimedAt)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Completed</dt>
          <dd>{formatDatetime(attempt.completedAt)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Next Retry</dt>
          <dd>{formatDatetime(attempt.nextRetryAt)}</dd>
        </div>
      </dl>

      {attempt.errorMessage !== null && (
        <p className="mt-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {attempt.errorMessage}
        </p>
      )}
    </li>
  )
}

// ---------------------------------------------------------------------------
// TaskDetailPage
// ---------------------------------------------------------------------------
export default function TaskDetailPage() {
  const router = useRouter()
  const params = useParams()
  const taskId = params.id as string

  const [task, setTask] = useState<Task | null>(null)
  const [initialRuns, setInitialRuns] = useState<AgentRun[]>([])
  const [initialArtifacts, setInitialArtifacts] = useState<Artifact[]>([])
  const [attempts, setAttempts] = useState<TaskAttempt[]>([])
  const [loading, setLoading] = useState(true)
  const [fetchError, setFetchError] = useState<string | null>(null)

  // Approve / change-plan / restart state
  const [actionLoading, setActionLoading] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [actionMode, setActionMode] = useState<'none' | 'restart' | 'replan'>('none')
  const [rejectReason, setRejectReason] = useState('')
  const [replanFeedback, setReplanFeedback] = useState('')

  // SSE stream
  const { runs: streamRuns, artifacts: streamArtifacts, taskStatus, error: streamError } = useTaskStream(taskId)

  // Merge initial data with live stream data
  const mergedRuns: AgentRun[] = streamRuns.length > 0 ? streamRuns : initialRuns
  const mergedArtifacts: Artifact[] = streamArtifacts.length > 0 ? streamArtifacts : initialArtifacts
  const currentStatus = taskStatus ?? task?.status ?? null

  const loadTask = useCallback(async () => {
    setLoading(true)
    setFetchError(null)
    try {
      const res = await fetch(`/api/tasks/${taskId}`)
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? 'Failed to load task')
      }
      const data = await res.json()
      setTask(data.task ?? null)
      setInitialRuns(data.runs ?? [])
      setInitialArtifacts(data.artifacts ?? [])
      setAttempts(data.attempts ?? [])
    } catch (err) {
      setFetchError(err instanceof Error ? err.message : 'An unexpected error occurred')
    } finally {
      setLoading(false)
    }
  }, [taskId])

  useEffect(() => {
    loadTask()
  }, [loadTask])

  // Refresh task when SSE reports a terminal status
  useEffect(() => {
    const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'rejected'])
    if (taskStatus && TERMINAL.has(taskStatus)) {
      loadTask()
    }
  }, [taskStatus, loadTask])

  async function handleApprove() {
    setActionLoading(true)
    setActionError(null)
    try {
      const res = await fetch(`/api/tasks/${taskId}/approve`, { method: 'POST' })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? 'Failed to approve task')
      }
      await loadTask()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'An unexpected error occurred')
    } finally {
      setActionLoading(false)
    }
  }

  async function handleReject(e: React.FormEvent) {
    e.preventDefault()
    setActionLoading(true)
    setActionError(null)
    try {
      const res = await fetch(`/api/tasks/${taskId}/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: rejectReason.trim() || undefined }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? 'Failed to restart task')
      }
      setActionMode('none')
      setRejectReason('')
      await loadTask()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'An unexpected error occurred')
    } finally {
      setActionLoading(false)
    }
  }

  async function handleReplan(e: React.FormEvent) {
    e.preventDefault()
    const feedback = replanFeedback.trim()
    if (!feedback) {
      setActionError('Describe what to change before requesting a revised plan.')
      return
    }
    setActionLoading(true)
    setActionError(null)
    try {
      const res = await fetch(`/api/tasks/${taskId}/replan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ feedback }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? 'Failed to request a revised plan')
      }
      setActionMode('none')
      setReplanFeedback('')
      await loadTask()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'An unexpected error occurred')
    } finally {
      setActionLoading(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center px-4 py-16" role="status" aria-live="polite">
        <span className="text-sm text-muted-foreground">Loading task…</span>
      </div>
    )
  }

  if (fetchError !== null) {
    return (
      <div className="px-4 py-6 sm:px-6 lg:px-8">
        <div
          role="alert"
          className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive"
        >
          {fetchError}
          <button
            onClick={loadTask}
            className="ml-2 underline underline-offset-2 hover:no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Retry
          </button>
        </div>
      </div>
    )
  }

  if (task === null) {
    return (
      <div className="px-4 py-6 sm:px-6 lg:px-8">
        <p className="text-sm text-muted-foreground">Task not found.</p>
      </div>
    )
  }

  const isAwaitingApproval = (currentStatus ?? task.status) === 'awaiting_approval'

  return (
    <div className="px-4 py-6 sm:px-6 lg:px-8">
      {/* Back navigation */}
      <Button
        variant="ghost"
        size="sm"
        onClick={() => router.push(`/dashboard/projects/${task.projectId}`)}
        className="mb-4 -ml-2"
        aria-label="Back to project"
      >
        <ArrowLeftIcon aria-hidden="true" />
        Project
      </Button>

      {/* Task header */}
      <div className="mb-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="text-xl font-semibold text-foreground">{task.title}</h1>
              <Badge variant={statusBadgeVariant(currentStatus ?? task.status)}>
                {statusLabel(currentStatus ?? task.status)}
              </Badge>
            </div>

            {/* GitHub PR link */}
            {task.githubPrUrl !== null && (
              <a
                href={task.githubPrUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-2 inline-flex items-center gap-1 text-sm text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label="View pull request on GitHub"
              >
                View Pull Request
                <ExternalLinkIcon className="size-3.5" aria-hidden="true" />
              </a>
            )}
          </div>
        </div>

        {/* Error message */}
        {task.errorMessage !== null && (
          <div
            role="alert"
            className="mt-4 flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive"
          >
            <CircleAlertIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <span>{task.errorMessage}</span>
          </div>
        )}

        {/* SSE connection error */}
        {streamError !== null && (
          <p role="status" aria-live="polite" className="mt-2 text-xs text-muted-foreground">
            {streamError}
          </p>
        )}
      </div>

      {/* Task prompt — always shown, so the originating instruction is visible */}
      <section aria-labelledby="prompt-heading" className="mb-6">
        <h2 id="prompt-heading" className="mb-3 text-sm font-medium text-muted-foreground uppercase tracking-wide">
          Prompt
        </h2>
        <div className="rounded-xl border border-border bg-muted/30 px-4 py-3">
          <MarkdownView content={task.prompt} />
        </div>
      </section>

      {/* Approve / Change plan / Restart actions */}
      {isAwaitingApproval && (
        <div className="mb-6 rounded-xl border border-border bg-card p-4">
          <p className="mb-3 text-sm font-medium text-foreground">
            Review the generated plan. You can approve it, ask for a revised plan, or
            restart the task.
          </p>

          {actionError !== null && (
            <p role="alert" aria-live="assertive" className="mb-3 text-sm text-destructive">
              {actionError}
            </p>
          )}

          {actionMode === 'none' && (
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                onClick={handleApprove}
                disabled={actionLoading}
                aria-busy={actionLoading}
                aria-label="Approve generated plan"
              >
                {actionLoading ? 'Approving…' : 'Approve'}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => { setActionMode('replan'); setActionError(null) }}
                disabled={actionLoading}
                aria-label="Change the plan"
              >
                Change plan
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => { setActionMode('restart'); setActionError(null) }}
                disabled={actionLoading}
                aria-label="Restart task"
              >
                Restart (reject)
              </Button>
            </div>
          )}

          {actionMode === 'replan' && (
            <form onSubmit={handleReplan} className="flex flex-col gap-3">
              <div className="flex flex-col gap-1.5">
                <label htmlFor="replan-feedback" className="text-sm font-medium text-foreground">
                  What should change?
                </label>
                <textarea
                  id="replan-feedback"
                  rows={3}
                  value={replanFeedback}
                  onChange={(e) => setReplanFeedback(e.target.value)}
                  placeholder="Describe the adjustments the orchestrator should make to the plan…"
                  className="resize-y rounded-lg border border-input bg-transparent px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                />
                <p className="text-xs text-muted-foreground">
                  Your notes are appended to the task prompt and the orchestrator re-plans
                  with the full history.
                </p>
              </div>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  type="submit"
                  disabled={actionLoading}
                  aria-busy={actionLoading}
                >
                  {actionLoading ? 'Requesting…' : 'Request revised plan'}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  type="button"
                  onClick={() => { setActionMode('none'); setReplanFeedback('') }}
                  disabled={actionLoading}
                >
                  Cancel
                </Button>
              </div>
            </form>
          )}

          {actionMode === 'restart' && (
            <form onSubmit={handleReject} className="flex flex-col gap-3">
              <div className="flex flex-col gap-1.5">
                <label htmlFor="reject-reason" className="text-sm font-medium text-foreground">
                  Reason <span className="text-muted-foreground font-normal">(optional)</span>
                </label>
                <textarea
                  id="reject-reason"
                  rows={3}
                  value={rejectReason}
                  onChange={(e) => setRejectReason(e.target.value)}
                  placeholder="Explain why the task is being restarted…"
                  className="resize-y rounded-lg border border-input bg-transparent px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                />
              </div>
              <div className="flex gap-2">
                <Button
                  variant="destructive"
                  size="sm"
                  type="submit"
                  disabled={actionLoading}
                  aria-busy={actionLoading}
                >
                  {actionLoading ? 'Restarting…' : 'Confirm restart'}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  type="button"
                  onClick={() => { setActionMode('none'); setRejectReason('') }}
                  disabled={actionLoading}
                >
                  Cancel
                </Button>
              </div>
            </form>
          )}
        </div>
      )}

      {/* Agent run timeline */}
      <section aria-labelledby="runs-heading" className="mb-6">
        <h2 id="runs-heading" className="mb-3 text-sm font-medium text-muted-foreground uppercase tracking-wide">
          Agent Runs
        </h2>
        {mergedRuns.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border px-4 py-8 text-center">
            <p className="text-sm text-muted-foreground">No agent runs yet.</p>
          </div>
        ) : (
          <ul
            className="rounded-xl border border-border"
            aria-label="Agent run timeline"
          >
            {mergedRuns.map((run) => (
              <AgentRunRow key={run.id} run={run} />
            ))}
          </ul>
        )}
      </section>

      {/* Task attempt history */}
      <section aria-labelledby="attempts-heading" className="mb-6">
        <h2 id="attempts-heading" className="mb-3 text-sm font-medium text-muted-foreground uppercase tracking-wide">
          Task Attempts
        </h2>
        {attempts.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border px-4 py-8 text-center">
            <p className="text-sm text-muted-foreground">No attempts recorded yet.</p>
          </div>
        ) : (
          <ul className="rounded-xl border border-border" aria-label="Task attempt history">
            {attempts.map((attempt) => (
              <TaskAttemptRow key={attempt.id} attempt={attempt} />
            ))}
          </ul>
        )}
      </section>

      {/* Artifacts */}
      {mergedArtifacts.length > 0 && (
        <section aria-labelledby="artifacts-heading">
          <h2 id="artifacts-heading" className="mb-3 text-sm font-medium text-muted-foreground uppercase tracking-wide">
            Artifacts
          </h2>
          <div className="flex flex-col gap-3">
            {mergedArtifacts.map((artifact) => (
              <ArtifactView key={artifact.id} artifact={artifact} />
            ))}
          </div>
        </section>
      )}
    </div>
  )
}
