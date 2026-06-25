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
  ShieldCheckIcon,
  GitBranchIcon,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { MarkdownView } from '@/components/MarkdownView'
import { PlanDiffView } from '@/components/PlanDiffView'
import { useTaskStream } from '@/hooks/useTaskStream'
import type { AgentRun, Artifact, TaskQuestion } from '@/hooks/useTaskStream'
import {
  latestCapabilityClassificationFromArtifacts,
  type CapabilityClassificationMetadata,
} from '@/lib/capabilities/classification-metadata'
import { stripKnownFences } from '@/lib/plan-fences'
import {
  latestMcpExecutionDesignFromArtifacts,
  type McpExecutionDesignMetadata,
} from '@/lib/mcps/execution-design-metadata'

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

type WorkforceRecord = Record<string, unknown>
type WorkPackage = WorkforceRecord
type ApprovalGate = WorkforceRecord
type VcsChange = WorkforceRecord

interface TaskDetailResponse {
  task?: Task | null
  runs?: AgentRun[]
  artifacts?: Artifact[]
  questions?: TaskQuestion[]
  attempts?: TaskAttempt[]
  workPackages?: WorkPackage[]
  approvalGates?: ApprovalGate[]
  vcsChanges?: VcsChange[]
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

function stringField(record: WorkforceRecord, keys: string[]): string {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return ''
}

function booleanField(record: WorkforceRecord, keys: string[]): boolean | null {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'boolean') return value
  }
  return null
}

function stringArrayField(record: WorkforceRecord, keys: string[]): string[] {
  for (const key of keys) {
    const value = record[key]
    if (!Array.isArray(value)) continue

    const strings = value.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
    if (strings.length > 0) return strings.map((item) => item.trim())
  }
  return []
}

function recordKey(record: WorkforceRecord, prefix: string, index: number): string {
  return stringField(record, ['id']) || `${prefix}-${index}`
}

function previewList(items: string[], limit = 4): string {
  const visible = items.slice(0, limit)
  const remaining = items.length - visible.length
  return remaining > 0 ? `${visible.join(', ')} +${remaining} more` : visible.join(', ')
}

function jsonArrayField(record: WorkforceRecord, keys: string[]): WorkforceRecord[] {
  for (const key of keys) {
    const value = record[key]
    if (!Array.isArray(value)) continue
    const records = value.filter((item): item is WorkforceRecord => isRecord(item))
    if (records.length > 0) return records
  }
  return []
}

function workPackageBrief(pkg: WorkPackage): string {
  const owner = stringField(pkg, ['assignedRole', 'agentType', 'agent', 'role', 'assignee', 'harnessSlug'])
  const harnessName = stringField(pkg, ['harnessDisplayName', 'harnessRole'])
  const harnessDescription = stringField(pkg, ['harnessDescription'])
  const title = stringField(pkg, ['title', 'name', 'summary']) || 'Work package'
  const summary = stringField(pkg, ['summary', 'description', 'objective'])
  const steps = stringArrayField(pkg, ['steps'])
  const criteria = stringArrayField(pkg, ['acceptanceCriteria', 'criteria'])
  const prompt = stringField(pkg, ['promptOverlay'])
  const capabilities = isRecord(pkg.requiredCapabilities) ? pkg.requiredCapabilities : null

  return [
    owner ? `Role: ${owner}` : null,
    harnessName ? `Harness: ${harnessName}` : null,
    harnessDescription ? `Harness description: ${harnessDescription}` : null,
    `Title: ${title}`,
    summary ? `Summary: ${summary}` : null,
    `Prompt overlay: ${prompt || 'No additional prompt overlay persisted for this package.'}`,
    steps.length > 0 ? `Steps:\n${steps.map((step, index) => `${index + 1}. ${step}`).join('\n')}` : null,
    criteria.length > 0
      ? `Acceptance criteria:\n${criteria.map((criterion, index) => `${index + 1}. ${criterion}`).join('\n')}`
      : null,
    capabilities ? `Required capabilities:\n${JSON.stringify(capabilities, null, 2)}` : null,
  ].filter((part): part is string => part !== null).join('\n\n')
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

function WorkforcePanel({
  workPackages,
  approvalGates,
  vcsChanges,
  fallbackAgents,
}: {
  workPackages: WorkPackage[]
  approvalGates: ApprovalGate[]
  vcsChanges: VcsChange[]
  fallbackAgents: PlannedAgent[]
}) {
  const hasPersistedPlan = workPackages.length > 0 || approvalGates.length > 0
  const hasFallback = fallbackAgents.length > 0
  if (!hasPersistedPlan && !hasFallback && vcsChanges.length === 0) return null

  const fallbackTasks = fallbackAgents.reduce((sum, agent) => sum + agent.tasks, 0)

  return (
    <section aria-labelledby="workforce-heading" className="rounded-lg border border-border p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 id="workforce-heading" className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
          Workforce
        </h2>
        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
          <UsersIcon className="size-3.5" aria-hidden="true" />
          {hasPersistedPlan
            ? `${workPackages.length} packages · ${approvalGates.length} gates`
            : `${fallbackAgents.length} agents · ${fallbackTasks} tasks`}
        </span>
      </div>

      <div className="mb-3 flex items-start gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
        <ShieldCheckIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
        <p>
          Read-only workforce state. This slice only displays persisted planning records and does not write to the repository.
        </p>
      </div>

      {hasPersistedPlan ? (
        <div className="grid gap-4">
          <div>
            <h3 className="mb-2 text-xs font-medium text-muted-foreground uppercase tracking-wide">Work Packages</h3>
            {workPackages.length === 0 ? (
              <p className="text-sm text-muted-foreground">No work packages persisted yet.</p>
            ) : (
              <ul className="flex flex-col gap-3" aria-label="Persisted work packages">
                {workPackages.map((pkg, index) => {
                  const title = stringField(pkg, ['title', 'name', 'summary', 'agentType', 'role']) || `Work package ${index + 1}`
                  const owner = stringField(pkg, ['assignedRole', 'agentType', 'agent', 'role', 'assignee', 'harnessSlug'])
                  const status = stringField(pkg, ['status', 'state'])
                  const summary = stringField(pkg, ['summary', 'description', 'objective'])
                  const criteria = stringArrayField(pkg, ['acceptanceCriteria', 'criteria', 'steps'])
                  const steps = stringArrayField(pkg, ['steps'])
                  const files = stringArrayField(pkg, ['files', 'paths', 'targetFiles'])
                  const prompt = stringField(pkg, ['promptOverlay'])
                  const harnessName = stringField(pkg, ['harnessDisplayName', 'harnessRole'])
                  const mcpRequirements = jsonArrayField(pkg, ['mcpRequirements'])

                  return (
                    <li key={recordKey(pkg, 'work-package', index)} className="border-t border-border pt-3 first:border-t-0 first:pt-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-sm font-medium text-foreground">{title}</p>
                        {owner !== '' && <Badge variant="outline">{owner}</Badge>}
                        {harnessName !== '' && harnessName !== owner && <Badge variant="secondary">{harnessName}</Badge>}
                        {status !== '' && <Badge variant={statusBadgeVariant(status)}>{statusLabel(status)}</Badge>}
                      </div>
                      {summary !== '' && <p className="mt-1 text-sm text-muted-foreground">{summary}</p>}
                      {criteria.length > 0 && (
                        <p className="mt-1 text-xs text-muted-foreground">Acceptance: {previewList(criteria)}</p>
                      )}
                      {files.length > 0 && (
                        <p className="mt-1 break-words font-mono text-xs text-muted-foreground">{previewList(files)}</p>
                      )}
                      <details className="mt-2 rounded-md border border-border bg-muted/20 px-3 py-2">
                        <summary className="cursor-pointer text-xs font-medium text-foreground">
                          Assignment details
                        </summary>
                        <div className="mt-2 grid gap-3 text-xs">
                          {steps.length > 0 && (
                            <div>
                              <p className="font-medium text-muted-foreground">Tasks</p>
                              <ol className="mt-1 list-decimal space-y-1 pl-4 text-foreground">
                                {steps.map((step, stepIndex) => <li key={stepIndex}>{step}</li>)}
                              </ol>
                            </div>
                          )}
                          <div>
                            <p className="font-medium text-muted-foreground">Prompt overlay</p>
                            {prompt !== '' ? (
                              <pre className="mt-1 max-h-56 overflow-auto whitespace-pre-wrap rounded-md bg-background p-2 font-mono text-[11px] text-foreground ring-1 ring-border">
                                {prompt}
                              </pre>
                            ) : (
                              <p className="mt-1 text-muted-foreground">
                                No additional prompt overlay persisted for this package.
                              </p>
                            )}
                          </div>
                          <div>
                            <p className="font-medium text-muted-foreground">Assignment brief</p>
                            <pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap rounded-md bg-background p-2 font-mono text-[11px] text-foreground ring-1 ring-border">
                              {workPackageBrief(pkg)}
                            </pre>
                          </div>
                          {mcpRequirements.length > 0 && (
                            <div>
                              <p className="font-medium text-muted-foreground">MCP requirements</p>
                              <pre className="mt-1 max-h-56 overflow-auto whitespace-pre-wrap rounded-md bg-background p-2 font-mono text-[11px] text-foreground ring-1 ring-border">
                                {JSON.stringify(mcpRequirements, null, 2)}
                              </pre>
                            </div>
                          )}
                        </div>
                      </details>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>

          <div>
            <h3 className="mb-2 text-xs font-medium text-muted-foreground uppercase tracking-wide">Approval Gates</h3>
            {approvalGates.length === 0 ? (
              <p className="text-sm text-muted-foreground">No approval gates persisted yet.</p>
            ) : (
              <ul className="flex flex-col gap-3" aria-label="Persisted approval gates">
                {approvalGates.map((gate, index) => {
                  const title = stringField(gate, ['title', 'name', 'gateType', 'type']) || `Gate ${index + 1}`
                  const status = stringField(gate, ['status', 'state'])
                  const summary = stringField(gate, ['summary', 'description', 'reason', 'instructions'])
                  const required = booleanField(gate, ['required', 'isRequired'])
                  const packageId = stringField(gate, ['workPackageId'])

                  return (
                    <li key={recordKey(gate, 'approval-gate', index)} className="border-t border-border pt-3 first:border-t-0 first:pt-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-sm font-medium text-foreground">{title}</p>
                        {status !== '' && <Badge variant={statusBadgeVariant(status)}>{statusLabel(status)}</Badge>}
                        {required !== null && (
                          <Badge variant={required ? 'outline' : 'secondary'}>{required ? 'required' : 'optional'}</Badge>
                        )}
                      </div>
                      {packageId !== '' && (
                        <p className="mt-1 font-mono text-xs text-muted-foreground">Package {packageId}</p>
                      )}
                      {summary !== '' && <p className="mt-1 text-sm text-muted-foreground">{summary}</p>}
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        </div>
      ) : (
        <div>
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Planner Fallback</h3>
            <Badge variant="outline">planned metadata</Badge>
          </div>
          <p className="mb-3 text-xs text-muted-foreground">
            Persisted workforce records are not available for this task, so Forge is showing the Architect plan metadata.
          </p>
          <ul className="flex flex-col gap-3" aria-label="Planned workforce fallback">
            {fallbackAgents.map((agent) => (
              <li key={agent.role} className="border-t border-border pt-3 first:border-t-0 first:pt-0">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm font-medium text-foreground">{agent.role}</p>
                  <Badge variant="outline">
                    {agent.tasks} {agent.tasks === 1 ? 'task' : 'tasks'}
                  </Badge>
                </div>
                {agent.summary !== '' && <p className="mt-1 text-sm text-muted-foreground">{agent.summary}</p>}
                {agent.steps.length > 0 && (
                  <p className="mt-1 text-xs text-muted-foreground">Tasks: {previewList(agent.steps, 3)}</p>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {vcsChanges.length > 0 && (
        <div className="mt-4 border-t border-border pt-3">
          <div className="mb-2 flex items-center gap-2">
            <GitBranchIcon className="size-3.5 text-muted-foreground" aria-hidden="true" />
            <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">VCS Changes</h3>
          </div>
          <ul className="flex flex-col gap-2" aria-label="Persisted VCS changes">
            {vcsChanges.map((change, index) => {
              const path = stringField(change, [
                'path',
                'filePath',
                'file',
                'branchName',
                'pullRequestUrl',
                'repository',
                'commitSha',
              ]) || `Change ${index + 1}`
              const status = stringField(change, ['status', 'state'])
              const type = stringField(change, ['changeType', 'type', 'operation'])
              const summary = stringField(change, ['summary', 'description', 'diffSummary'])

              return (
                <li key={recordKey(change, 'vcs-change', index)} className="rounded-md border border-border bg-muted/20 px-2.5 py-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="break-all font-mono text-xs text-foreground">{path}</span>
                    {type !== '' && <Badge variant="outline">{type}</Badge>}
                    {status !== '' && <Badge variant={statusBadgeVariant(status)}>{statusLabel(status)}</Badge>}
                  </div>
                  {summary !== '' && <p className="mt-1 text-xs text-muted-foreground">{summary}</p>}
                </li>
              )
            })}
          </ul>
        </div>
      )}
    </section>
  )
}

function CapabilityClassificationPanel({ classification }: { classification: CapabilityClassificationMetadata | null }) {
  if (!classification) return null

  const { proposed, validation } = classification
  const total =
    proposed.required.length +
    proposed.optional.length +
    proposed.excluded.length
  const statusVariant: StatusVariant = validation.status === 'warnings' ? 'outline' : 'secondary'

  return (
    <section aria-labelledby="capability-classification-heading" className="rounded-lg border border-border p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 id="capability-classification-heading" className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
          Capability Classification
        </h2>
        <Badge variant={statusVariant}>{statusLabel(validation.status)}</Badge>
      </div>

      <p className="mb-3 text-xs text-muted-foreground">
        Read-only planning metadata. Agent routing and execution are still driven by the approved plan.
      </p>

      {validation.warnings.length > 0 && (
        <div className="mb-3 rounded-lg border border-amber-300/40 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-700/40 dark:bg-amber-950/30 dark:text-amber-200">
          <p className="font-medium">Warnings</p>
          <ul className="mt-1 list-disc pl-4">
            {validation.warnings.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      )}

      {total === 0 ? (
        <p className="text-sm text-muted-foreground">
          The Architect did not classify any work capabilities for this plan.
        </p>
      ) : (
        <dl className="grid gap-3 text-sm">
          <div>
            <dt className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">Required</dt>
            <dd className="flex flex-wrap gap-1.5">
              {proposed.required.length > 0
                ? proposed.required.map((capability) => (
                    <Badge key={capability} variant="default">{capability}</Badge>
                  ))
                : <span className="text-muted-foreground">None</span>}
            </dd>
          </div>
          <div>
            <dt className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">Optional</dt>
            <dd className="flex flex-wrap gap-1.5">
              {proposed.optional.length > 0
                ? proposed.optional.map((capability) => (
                    <Badge key={capability} variant="outline">{capability}</Badge>
                  ))
                : <span className="text-muted-foreground">None</span>}
            </dd>
          </div>
          <div>
            <dt className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">Excluded</dt>
            <dd>
              {proposed.excluded.length > 0 ? (
                <ul className="grid gap-2">
                  {proposed.excluded.map((item) => (
                    <li key={item.capability}>
                      <Badge variant="secondary">{item.capability}</Badge>
                      <p className="mt-1 text-xs text-muted-foreground">{item.reason}</p>
                    </li>
                  ))}
                </ul>
              ) : (
                <span className="text-muted-foreground">None</span>
              )}
            </dd>
          </div>
        </dl>
      )}
    </section>
  )
}

function McpAccessPlanPanel({ design }: { design: McpExecutionDesignMetadata | null }) {
  if (!design) return null

  const proposed = design.proposed
  const requirements = proposed?.requirements ?? []
  const overlayCount = proposed ? Object.keys(proposed.promptOverlays).length : 0
  const subtaskCount = proposed?.mcpAwareSubtasks.length ?? 0
  const grantPreview = design.grantDecisions
  const statusVariant: StatusVariant =
    design.validation.status === 'blocked'
      ? 'destructive'
      : design.validation.status === 'warnings'
        ? 'outline'
        : 'secondary'

  return (
    <section aria-labelledby="mcp-access-plan-heading" className="rounded-lg border border-border p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 id="mcp-access-plan-heading" className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
          MCP Access Plan
        </h2>
        <Badge variant={statusVariant}>{statusLabel(design.validation.status)}</Badge>
      </div>

      <div className="mb-3 flex items-start gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
        <ShieldCheckIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
        <p>
          Planning recommendation only. Runtime MCP tool issuance and enforcement are not implemented yet.
        </p>
      </div>

      {design.validation.blocked.length > 0 && (
        <div role="alert" className="mb-3 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <p className="font-medium">Blocked recommendations</p>
          <ul className="mt-1 list-disc pl-4">
            {design.validation.blocked.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      )}

      {design.validation.warnings.length > 0 && (
        <div className="mb-3 rounded-lg border border-amber-300/40 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-700/40 dark:bg-amber-950/30 dark:text-amber-200">
          <p className="font-medium">Warnings</p>
          <ul className="mt-1 list-disc pl-4">
            {design.validation.warnings.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      )}

      {grantPreview && grantPreview.decisions.length > 0 && (
        <div className="mb-3 rounded-lg border border-border px-3 py-2">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Grant Decision Preview</p>
            <div className="flex flex-wrap gap-1.5">
              <Badge variant="secondary">{grantPreview.summary.proposed} proposed</Badge>
              <Badge variant="outline">{grantPreview.summary.warning} warning</Badge>
              <Badge variant={grantPreview.summary.blocked > 0 ? 'destructive' : 'secondary'}>
                {grantPreview.summary.blocked} blocked
              </Badge>
            </div>
          </div>
          <ul className="grid gap-2 text-xs">
            {grantPreview.decisions.map((decision) => {
              const variant: StatusVariant =
                decision.status === 'blocked'
                  ? 'destructive'
                  : decision.status === 'warning'
                    ? 'outline'
                    : 'secondary'
              const statusText = decision.status === 'blocked'
                ? 'Do not assign MCP-backed work until this MCP issue is resolved.'
                : decision.status === 'warning'
                  ? 'Optional MCP access is unavailable. Continue using the Architect fallback.'
                  : 'Proposed only. MCP is currently healthy, but no runtime tools are granted.'

              return (
                <li key={decision.decisionId} className="rounded-md border border-border bg-muted/20 px-2.5 py-2">
                  <div className="mb-1 flex flex-wrap items-center gap-2">
                    <Badge variant={variant}>{decision.status}</Badge>
                    <span className="font-medium text-foreground">{decision.agent}</span>
                    <span className="text-muted-foreground">{decision.mcpId}</span>
                    {decision.promptOverlayPresent && <Badge variant="outline">overlay</Badge>}
                  </div>
                  <p className="text-muted-foreground">{statusText}</p>
                  {decision.capabilities.length > 0 && (
                    <p className="mt-1 break-words text-muted-foreground">
                      Capabilities: {decision.capabilities.join(', ')}
                    </p>
                  )}
                  {decision.health.status !== 'healthy' && (
                    <p className="mt-1 text-muted-foreground">
                      Health: {decision.health.installState}/{decision.health.status}
                      {decision.health.error ? `: ${decision.health.error}` : ''}
                    </p>
                  )}
                </li>
              )
            })}
          </ul>
        </div>
      )}

      {requirements.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          The Architect did not request MCP-backed execution for this plan.
        </p>
      ) : (
        <ul className="flex flex-col gap-3" aria-label="MCP requirements">
          {requirements.map((requirement, index) => {
            const permissionEntries = Object.entries(requirement.agentPermissions)
            return (
              <li key={`${requirement.mcpId}-${requirement.assignment.type}-${index}`} className="border-t border-border pt-3 first:border-t-0 first:pt-0">
                <div className="mb-1 flex flex-wrap items-center gap-2">
                  <p className="text-sm font-medium text-foreground">{requirement.mcpId}</p>
                  <Badge variant={requirement.requirement === 'required' ? 'outline' : 'secondary'}>
                    {requirement.requirement}
                  </Badge>
                </div>
                {requirement.reason && (
                  <p className="text-sm text-muted-foreground">{requirement.reason}</p>
                )}
                <dl className="mt-2 grid gap-1 text-xs text-muted-foreground">
                  <div>
                    <dt className="font-medium text-foreground">Assignment</dt>
                    <dd>
                      {requirement.assignment.type}
                      {requirement.assignment.targetAgents.length > 0 ? ` · ${requirement.assignment.targetAgents.join(', ')}` : ''}
                      {requirement.assignment.targetId ? ` · ${requirement.assignment.targetId}` : ''}
                    </dd>
                  </div>
                  {permissionEntries.length > 0 && (
                    <div>
                      <dt className="font-medium text-foreground">Planned Capabilities</dt>
                      <dd>
                        {permissionEntries.map(([agent, permissions]) => (
                          <span key={agent} className="block">
                            {agent}: {permissions.join(', ')}
                          </span>
                        ))}
                      </dd>
                    </div>
                  )}
                  {requirement.prohibitedCapabilities.length > 0 && (
                    <div>
                      <dt className="font-medium text-foreground">Prohibited</dt>
                      <dd>{requirement.prohibitedCapabilities.join(', ')}</dd>
                    </div>
                  )}
                  <div>
                    <dt className="font-medium text-foreground">Fallback</dt>
                    <dd>{requirement.fallback.action}: {requirement.fallback.message}</dd>
                  </div>
                </dl>
              </li>
            )
          })}
        </ul>
      )}

      {(overlayCount > 0 || subtaskCount > 0) && (
        <dl className="mt-3 grid gap-1 border-t border-border pt-3 text-xs text-muted-foreground">
          <div>
            <dt className="font-medium text-foreground">Prompt Overlays</dt>
            <dd>{overlayCount}</dd>
          </div>
          <div>
            <dt className="font-medium text-foreground">MCP-aware Subtasks</dt>
            <dd>{subtaskCount}</dd>
          </div>
        </dl>
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
  const [workPackages, setWorkPackages] = useState<WorkPackage[]>([])
  const [approvalGates, setApprovalGates] = useState<ApprovalGate[]>([])
  const [vcsChanges, setVcsChanges] = useState<VcsChange[]>([])
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
      const data = await res.json() as TaskDetailResponse
      setTask(data.task ?? null)
      setInitialRuns(data.runs ?? [])
      setInitialArtifacts(data.artifacts ?? [])
      setInitialQuestions(data.questions ?? [])
      setAttempts(data.attempts ?? [])
      setWorkPackages(data.workPackages ?? [])
      setApprovalGates(data.approvalGates ?? [])
      setVcsChanges(data.vcsChanges ?? [])
    } catch (err) {
      setFetchError(err instanceof Error ? err.message : 'An unexpected error occurred')
    } finally {
      setLoading(false)
    }
  }, [taskId])

  useEffect(() => {
    loadTask()
  }, [loadTask])

  // Refresh task when SSE reports a state where persisted side data may have changed.
  useEffect(() => {
    const REFRESH_STATUSES = new Set([
      'awaiting_answers',
      'awaiting_approval',
      'completed',
      'failed',
      'cancelled',
      'rejected',
    ])
    if (taskStatus && REFRESH_STATUSES.has(taskStatus)) {
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
  const capabilityClassification = latestCapabilityClassificationFromArtifacts(mergedArtifacts)
  const mcpExecutionDesign = latestMcpExecutionDesignFromArtifacts(mergedArtifacts)

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
          <WorkforcePanel
            workPackages={workPackages}
            approvalGates={approvalGates}
            vcsChanges={vcsChanges}
            fallbackAgents={plannedAgents}
          />
          <CapabilityClassificationPanel classification={capabilityClassification} />
          <McpAccessPlanPanel design={mcpExecutionDesign} />

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
