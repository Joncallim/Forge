'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { useParams, useRouter } from 'next/navigation'
import {
  ExternalLinkIcon,
  ArrowLeftIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  UsersIcon,
  ListIcon,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { MarkdownView } from '@/components/MarkdownView'
import { PlanDiffView } from '@/components/PlanDiffView'
import { useTaskStream } from '@/hooks/useTaskStream'
import type { AgentRun, Artifact, TaskQuestion } from '@/hooks/useTaskStream'
import { stripKnownFences } from '@/lib/plan-fences'

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

const ARTIFACT_LABELS: Record<string, string> = {
  adr_text: 'Implementation Plan',
  pr_url: 'Pull Request',
  file_diff: 'Code Changes',
  test_report: 'Test Report',
  review_finding: 'Review Finding',
  log_output: 'Log Output',
}

function artifactTypeLabel(type: string): string {
  return ARTIFACT_LABELS[type] ?? type.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

interface PlannedAgent {
  role: string
  tasks: number
  summary: string
  steps: string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function normalizeStepsField(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}

function agentsFromMetadata(metadata: unknown): PlannedAgent[] {
  if (!isRecord(metadata) || !Array.isArray(metadata.agentBreakdown)) return []

  return metadata.agentBreakdown
    .map((item): PlannedAgent | null => {
      if (!isRecord(item) || typeof item.role !== 'string') return null
      const tasks = typeof item.tasks === 'number' && Number.isFinite(item.tasks) ? item.tasks : 1
      return {
        role: item.role.trim(),
        tasks: Math.max(1, Math.floor(tasks)),
        summary: typeof item.summary === 'string' ? item.summary.trim() : '',
        steps: normalizeStepsField(item.steps),
      }
    })
    .filter((item): item is PlannedAgent => item !== null && item.role !== '')
}

function agentsFromPlanText(content: string): PlannedAgent[] {
  const byRole = new Map<string, { role: string; tasks: number; snippets: string[] }>()
  const roleLine = /(?:^|\s)\[([A-Za-z][A-Za-z0-9 /_-]{0,38})\]\s*(.+)$/u

  for (const line of content.split('\n')) {
    const match = roleLine.exec(line)
    if (!match) continue

    const role = match[1].trim()
    const task = match[2].replace(/^[-*]\s*/, '').replace(/^\d+[.)]\s*/, '').trim()
    const existing = byRole.get(role) ?? { role, tasks: 0, snippets: [] }
    existing.tasks += 1
    if (task !== '' && existing.snippets.length < 20) existing.snippets.push(task)
    byRole.set(role, existing)
  }

  return [...byRole.values()].map((agent) => ({
    role: agent.role,
    tasks: agent.tasks,
    summary: agent.snippets.slice(0, 2).join('; '),
    steps: agent.snippets,
  }))
}

function plannedAgentsFromArtifacts(artifacts: Artifact[]): PlannedAgent[] {
  const plans = artifacts.filter((artifact) => artifact.artifactType === 'adr_text')
  for (const plan of [...plans].reverse()) {
    const agents = agentsFromMetadata(plan.metadata)
    if (agents.length > 0) return agents
    const fallback = agentsFromPlanText(plan.content)
    if (fallback.length > 0) return fallback
  }
  return []
}

// ---------------------------------------------------------------------------
// AgentRunRow — expandable row showing a single agent run and its log output
// ---------------------------------------------------------------------------
function AgentRunRow({ run }: { run: AgentRun }) {
  const [expanded, setExpanded] = useState(run.status === 'running')
  const logRef = useRef<HTMLDivElement | null>(null)
  const pinnedToBottomRef = useRef(true)

  useEffect(() => {
    if (run.status === 'running') setExpanded(true)
  }, [run.status])

  useEffect(() => {
    if (!expanded || !pinnedToBottomRef.current || !logRef.current) return
    logRef.current.scrollTop = logRef.current.scrollHeight
  }, [expanded, run.logOutput])

  function handleLogScroll() {
    const node = logRef.current
    if (!node) return
    const distanceFromBottom = node.scrollHeight - node.scrollTop - node.clientHeight
    pinnedToBottomRef.current = distanceFromBottom < 32
  }

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
                ref={logRef}
                onScroll={handleLogScroll}
                className="max-h-96 overflow-y-auto rounded-lg bg-background/80 p-3 ring-1 ring-border"
                aria-label="Agent live Markdown output"
              >
                <MarkdownView content={stripKnownFences(run.logOutput)} compact />
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
  const isLongArtifact = artifact.content.length > 1400 || artifact.content.split('\n').length > 28
  const [expanded, setExpanded] = useState(!isLongArtifact)

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
          <pre className="overflow-x-auto rounded-lg bg-background/80 p-3 font-mono text-xs text-foreground ring-1 ring-border">
            {artifact.content}
          </pre>
        )
      case 'test_report':
        return (
          <pre className="overflow-x-auto rounded-lg bg-background/80 p-3 font-mono text-xs text-foreground ring-1 ring-border">
            {artifact.content}
          </pre>
        )
      case 'adr_text':
        return (
          <div className="rounded-lg bg-muted/40 px-4 py-3">
            <MarkdownView content={stripKnownFences(artifact.content)} />
          </div>
        )
      case 'review_finding':
        return (
          <div className="rounded-lg bg-muted/40 px-4 py-3">
            <MarkdownView content={artifact.content} />
          </div>
        )
      default:
        return (
          <pre className="overflow-x-auto rounded-lg bg-background/80 p-3 font-mono text-xs text-foreground ring-1 ring-border">
            {artifact.content}
          </pre>
        )
    }
  }

  const typeLabel = artifactTypeLabel(artifact.artifactType)

  return (
    <div className="rounded-lg border border-border p-4">
      <p className="mb-2 text-xs font-medium text-muted-foreground uppercase tracking-wide">{typeLabel}</p>
      <div className={isLongArtifact && !expanded ? 'max-h-80 overflow-hidden' : 'max-h-[70vh] overflow-y-auto'}>
        {renderContent()}
      </div>
      {isLongArtifact && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="mt-2 px-0"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
        >
          {expanded ? 'Show less' : 'Show more'}
        </Button>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// QuestionsPanel — answer inputs for open questions, plus resolved Q&A history
// ---------------------------------------------------------------------------
function QuestionsPanel({
  taskId,
  questions,
  onAnswered,
}: {
  taskId: string
  questions: TaskQuestion[]
  onAnswered: () => void
}) {
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [currentIndex, setCurrentIndex] = useState(0)
  const [resolvedExpanded, setResolvedExpanded] = useState(false)

  const openQuestions = questions.filter((q) => q.status !== 'answered')
  const answeredQuestions = questions.filter((q) => q.status === 'answered')

  // Clamp the carousel position if the open-questions list shrinks (e.g. after a submit).
  const safeIndex = openQuestions.length === 0 ? 0 : Math.min(currentIndex, openQuestions.length - 1)
  const currentQuestion = openQuestions[safeIndex] ?? null
  const isLastQuestion = safeIndex === openQuestions.length - 1

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSubmitError(null)

    const answers = openQuestions
      .map((q) => ({ id: q.id, answer: (drafts[q.id] ?? '').trim() }))
      .filter((a) => a.answer.length > 0)

    if (answers.length === 0) {
      setSubmitError('Answer at least one question before submitting.')
      return
    }

    setSubmitting(true)
    try {
      const res = await fetch(`/api/tasks/${taskId}/questions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answers }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? 'Failed to submit answers')
      }
      setDrafts({})
      setCurrentIndex(0)
      onAnswered()
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'An unexpected error occurred')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <section aria-labelledby="questions-heading" className="flex flex-col gap-3">
      <h2 id="questions-heading" className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
        Open Questions
      </h2>

      {openQuestions.length > 0 && currentQuestion !== null && (
        <form onSubmit={handleSubmit} className="rounded-xl border border-border bg-card p-4">
          <div className="mb-3 flex items-center justify-between gap-3">
            <p className="text-sm font-medium text-foreground">
              The architect needs answers to these questions before the plan can be approved.
            </p>
            <span className="shrink-0 text-xs text-muted-foreground" aria-live="polite">
              Question {safeIndex + 1} of {openQuestions.length}
            </span>
          </div>

          {submitError !== null && (
            <p role="alert" aria-live="assertive" className="mb-3 text-sm text-destructive">
              {submitError}
            </p>
          )}

          {(() => {
            const q = currentQuestion
            const suggestions = Array.isArray(q.suggestions) ? q.suggestions.slice(0, 4) : []
            const draft = drafts[q.id] ?? ''
            const hasDraft = draft.trim().length > 0
            return (
              <div className="flex flex-col gap-4">
                <div className="flex flex-col gap-2">
                  <p className="text-sm font-medium text-foreground">{q.question}</p>
                  {suggestions.length > 0 && (
                    <div className="flex flex-wrap gap-2" role="group" aria-label={`Suggested answers for ${q.question}`}>
                      {suggestions.map((suggestion) => {
                        const selected = draft === suggestion
                        return (
                          <button
                            key={suggestion}
                            type="button"
                            onClick={() => setDrafts((prev) => ({ ...prev, [q.id]: suggestion }))}
                            className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50 ${
                              selected
                                ? 'border-primary bg-primary text-primary-foreground'
                                : 'border-border bg-background text-foreground hover:bg-muted'
                            }`}
                            aria-pressed={selected}
                          >
                            {suggestion}
                          </button>
                        )
                      })}
                    </div>
                  )}
                  <label htmlFor={`question-${q.id}`} className="text-xs font-medium text-muted-foreground">
                    {suggestions.length > 0 ? 'Other answer' : 'Your answer'}
                  </label>
                  <textarea
                    id={`question-${q.id}`}
                    rows={2}
                    value={draft}
                    onChange={(e) => setDrafts((prev) => ({ ...prev, [q.id]: e.target.value }))}
                    placeholder={suggestions.length > 0 ? 'Type a different answer…' : 'Your answer…'}
                    className="resize-y rounded-lg border border-input bg-transparent px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                  />
                </div>

                <div className="flex items-center justify-between gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setCurrentIndex((idx) => Math.max(0, idx - 1))}
                    disabled={safeIndex === 0}
                    aria-label="Previous question"
                  >
                    <ChevronLeftIcon aria-hidden="true" />
                    Previous
                  </Button>

                  {isLastQuestion ? (
                    <Button
                      type="submit"
                      size="sm"
                      disabled={submitting}
                      aria-busy={submitting}
                    >
                      {submitting ? 'Submitting…' : 'Submit Answers'}
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      size="sm"
                      onClick={() => setCurrentIndex((idx) => Math.min(openQuestions.length - 1, idx + 1))}
                      disabled={!hasDraft}
                      aria-label="Next question"
                    >
                      Next
                      <ChevronRightIcon aria-hidden="true" />
                    </Button>
                  )}
                </div>
              </div>
            )
          })()}
        </form>
      )}

      {openQuestions.length === 0 && answeredQuestions.length > 0 && (
        <div className="rounded-xl border border-border">
          <button
            type="button"
            onClick={() => setResolvedExpanded((v) => !v)}
            className="flex w-full items-center justify-between gap-3 px-4 py-2 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
            aria-expanded={resolvedExpanded}
            aria-label={`${resolvedExpanded ? 'Collapse' : 'Expand'} resolved questions and answers`}
          >
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              {answeredQuestions.length} {answeredQuestions.length === 1 ? 'question' : 'questions'} answered ✓
            </span>
            {resolvedExpanded ? (
              <ChevronUpIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            ) : (
              <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            )}
          </button>
          {resolvedExpanded && (
            <ul aria-label="Resolved questions and answers" className="border-t border-border">
              {answeredQuestions.map((q) => (
                <li key={q.id} className="border-b border-border px-4 py-3 last:border-0">
                  <p className="text-sm font-medium text-foreground">{q.question}</p>
                  <p className="mt-1 text-sm text-muted-foreground">{q.answer}</p>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {openQuestions.length === 0 && answeredQuestions.length === 0 && (
        <div className="rounded-xl border border-dashed border-border px-4 py-8 text-center">
          <p className="text-sm text-muted-foreground">No open questions.</p>
        </div>
      )}
    </section>
  )
}

// ---------------------------------------------------------------------------
// AgentTasksModal — shows an agent's full task list alongside its system
// prompt ("Instructions"), fetched lazily and cached for the page's lifetime.
// ---------------------------------------------------------------------------
const agentInstructionsCache = new Map<string, string>()

function AgentTasksModal({ agent, open, onOpenChange }: {
  agent: PlannedAgent
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [instructions, setInstructions] = useState<string | null>(null)
  const [loadingInstructions, setLoadingInstructions] = useState(false)
  const [instructionsError, setInstructionsError] = useState<string | null>(null)

  const roleSlug = agent.role.toLowerCase()

  useEffect(() => {
    if (!open) return

    const cached = agentInstructionsCache.get(roleSlug)
    if (cached !== undefined) {
      setInstructions(cached)
      setInstructionsError(null)
      return
    }

    let cancelled = false
    setLoadingInstructions(true)
    setInstructionsError(null)

    fetch(`/api/agents/${roleSlug}`)
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => ({}))
          throw new Error(body.error ?? 'Failed to load agent instructions')
        }
        return res.json()
      })
      .then((data) => {
        if (cancelled) return
        const systemPrompt = typeof data?.agent?.systemPrompt === 'string' ? data.agent.systemPrompt : ''
        agentInstructionsCache.set(roleSlug, systemPrompt)
        setInstructions(systemPrompt)
      })
      .catch((err) => {
        if (cancelled) return
        setInstructionsError(err instanceof Error ? err.message : 'An unexpected error occurred')
      })
      .finally(() => {
        if (!cancelled) setLoadingInstructions(false)
      })

    return () => {
      cancelled = true
    }
  }, [open, roleSlug])

  const taskItems = agent.steps.length > 0 ? agent.steps : (agent.summary !== '' ? [agent.summary] : [])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl" aria-labelledby={`agent-tasks-title-${roleSlug}`}>
        <DialogHeader>
          <DialogTitle id={`agent-tasks-title-${roleSlug}`}>{agent.role} — Tasks &amp; Instructions</DialogTitle>
        </DialogHeader>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="min-w-0">
            <h3 className="mb-2 text-xs font-medium text-muted-foreground uppercase tracking-wide">Tasks</h3>
            {taskItems.length > 0 ? (
              <ul className="flex flex-col gap-1.5 text-sm text-foreground" aria-label={`${agent.role} tasks`}>
                {taskItems.map((item, idx) => (
                  <li key={idx} className="flex gap-2">
                    <span aria-hidden="true" className="text-muted-foreground">•</span>
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">No task details available.</p>
            )}
          </div>

          <div className="min-w-0">
            <h3 className="mb-2 text-xs font-medium text-muted-foreground uppercase tracking-wide">Instructions</h3>
            {loadingInstructions && (
              <p className="text-sm text-muted-foreground" role="status" aria-live="polite">Loading instructions…</p>
            )}
            {instructionsError !== null && (
              <p role="alert" className="text-sm text-destructive">{instructionsError}</p>
            )}
            {!loadingInstructions && instructionsError === null && instructions !== null && (
              <div className="max-h-80 overflow-y-auto rounded-lg bg-muted/40 px-3 py-2">
                <pre className="whitespace-pre-wrap font-mono text-xs text-foreground">{instructions}</pre>
              </div>
            )}
          </div>
        </div>

        <DialogFooter showCloseButton />
      </DialogContent>
    </Dialog>
  )
}

function PlannedAgentsPanel({ agents }: { agents: PlannedAgent[] }) {
  const [openRole, setOpenRole] = useState<string | null>(null)

  if (agents.length === 0) return null

  const totalTasks = agents.reduce((sum, agent) => sum + agent.tasks, 0)
  const activeAgent = agents.find((agent) => agent.role === openRole) ?? null

  return (
    <section aria-labelledby="planned-agents-heading" className="rounded-lg border border-border p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 id="planned-agents-heading" className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
          Planned Agents
        </h2>
        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
          <UsersIcon className="size-3.5" aria-hidden="true" />
          {agents.length} {agents.length === 1 ? 'agent' : 'agents'} · {totalTasks} {totalTasks === 1 ? 'task' : 'tasks'}
        </span>
      </div>
      <ul className="flex flex-col gap-3">
        {agents.map((agent) => (
          <li key={agent.role} className="border-t border-border pt-3 first:border-t-0 first:pt-0">
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm font-medium text-foreground">{agent.role}</p>
              <div className="flex items-center gap-2">
                <Badge variant="outline">
                  {agent.tasks} {agent.tasks === 1 ? 'task' : 'tasks'}
                </Badge>
                <button
                  type="button"
                  onClick={() => setOpenRole(agent.role)}
                  title={`${agent.tasks} ${agent.tasks === 1 ? 'task' : 'tasks'} · ${agent.summary}`}
                  aria-label={`View tasks and instructions for ${agent.role}`}
                  className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                >
                  <ListIcon className="size-3.5" aria-hidden="true" />
                </button>
              </div>
            </div>
            {agent.summary !== '' && (
              <p className="mt-1 text-sm text-muted-foreground">{agent.summary}</p>
            )}
          </li>
        ))}
      </ul>

      {activeAgent !== null && (
        <AgentTasksModal
          agent={activeAgent}
          open={openRole !== null}
          onOpenChange={(value) => setOpenRole(value ? activeAgent.role : null)}
        />
      )}
    </section>
  )
}

function TaskAttemptRow({ attempt, runs }: { attempt: TaskAttempt; runs: AgentRun[] }) {
  const variant: StatusVariant =
    attempt.status === 'completed'
      ? 'secondary'
      : attempt.status === 'failed' || attempt.status === 'dead_lettered'
        ? 'destructive'
        : 'outline'

  const matchedRun = runs.find((run) => run.agentType === attempt.queueName)
  const modelLabel = matchedRun?.modelIdUsed || (attempt.workerId ? 'Model pending' : 'Worker pending')

  return (
    <li className="border-b border-border px-4 py-3 last:border-0">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="font-medium text-foreground">{attempt.queueName}</span>
          <span className="text-muted-foreground">attempt {attempt.attemptNumber}</span>
          <Badge variant={variant}>{statusLabel(attempt.status)}</Badge>
        </div>
        <span className="font-mono text-xs text-muted-foreground" title={attempt.workerId ?? undefined}>
          {modelLabel}
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
  const [initialQuestions, setInitialQuestions] = useState<TaskQuestion[]>([])
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
  const { runs: streamRuns, artifacts: streamArtifacts, taskStatus, error: streamError, questions: streamQuestions } = useTaskStream(taskId)

  // Merge initial data with live stream data
  const mergedRuns: AgentRun[] = streamRuns.length > 0 ? streamRuns : initialRuns
  const mergedArtifacts: Artifact[] = streamArtifacts.length > 0 ? streamArtifacts : initialArtifacts
  // streamQuestions is null until the SSE layer has reported a definitive
  // question set (even an empty one); only fall back to the once-fetched
  // initialQuestions while that hasn't happened yet, so an explicitly-empty
  // stream result isn't overridden by stale data from a prior plan round.
  const mergedQuestions: TaskQuestion[] = streamQuestions ?? initialQuestions
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
      setInitialQuestions(data.questions ?? [])
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
  const plannedAgents = plannedAgentsFromArtifacts(mergedArtifacts)

  const adrArtifacts = mergedArtifacts.filter((artifact) => artifact.artifactType === 'adr_text')
  const otherArtifacts = mergedArtifacts.filter((artifact) => artifact.artifactType !== 'adr_text')
  const sortedAdrArtifacts = [...adrArtifacts].sort((a, b) => {
    const aTime = a.createdAt ? new Date(a.createdAt).getTime() : 0
    const bTime = b.createdAt ? new Date(b.createdAt).getTime() : 0
    return aTime - bTime
  })

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

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(320px,420px)] lg:items-start">
        <div className="min-w-0">
          {/* Task prompt — always shown, so the originating instruction is visible */}
          <section aria-labelledby="prompt-heading" className="mb-6">
            <h2 id="prompt-heading" className="mb-3 text-sm font-medium text-muted-foreground uppercase tracking-wide">
              Prompt
            </h2>
            <div className="rounded-lg border border-border bg-muted/30 px-4 py-3">
              <MarkdownView content={task.prompt} />
            </div>
          </section>

          {/* Approve / Change plan / Restart actions */}
          {isAwaitingApproval && (
            <div className="mb-6 rounded-lg border border-border bg-card p-4">
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
                      The orchestrator will revise the current plan and preserve unaffected sections.
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
              <div className="rounded-lg border border-dashed border-border px-4 py-8 text-center">
                <p className="text-sm text-muted-foreground">No agent runs yet.</p>
              </div>
            ) : (
              <ul
                className="rounded-lg border border-border"
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
              <div className="rounded-lg border border-dashed border-border px-4 py-8 text-center">
                <p className="text-sm text-muted-foreground">No attempts recorded yet.</p>
              </div>
            ) : (
              <ul className="rounded-lg border border-border" aria-label="Task attempt history">
                {attempts.map((attempt) => (
                  <TaskAttemptRow key={attempt.id} attempt={attempt} runs={mergedRuns} />
                ))}
              </ul>
            )}
          </section>
        </div>

        <aside className="flex min-w-0 flex-col gap-6">
          <PlannedAgentsPanel agents={plannedAgents} />

          {/* Open questions — answer before the plan can be approved */}
          {mergedQuestions.length > 0 && (
            <QuestionsPanel taskId={taskId} questions={mergedQuestions} onAnswered={loadTask} />
          )}

          {/* Artifacts */}
          {mergedArtifacts.length > 0 && (
            <section aria-labelledby="artifacts-heading">
              <h2 id="artifacts-heading" className="mb-3 text-sm font-medium text-muted-foreground uppercase tracking-wide">
                Artifacts
              </h2>
              <div className="flex flex-col gap-3">
                {otherArtifacts.map((artifact) => (
                  <ArtifactView key={artifact.id} artifact={artifact} />
                ))}
                {adrArtifacts.length >= 2 ? (
                  <div className="rounded-lg border border-border p-4">
                    <p className="mb-2 text-xs font-medium text-muted-foreground uppercase tracking-wide">
                      Plan Revision
                    </p>
                    <PlanDiffView
                      oldContent={sortedAdrArtifacts[sortedAdrArtifacts.length - 2].content}
                      newContent={sortedAdrArtifacts[sortedAdrArtifacts.length - 1].content}
                    />
                  </div>
                ) : (
                  adrArtifacts.map((artifact) => (
                    <ArtifactView key={artifact.id} artifact={artifact} />
                  ))
                )}
              </div>
            </section>
          )}
        </aside>
      </div>
    </div>
  )
}
