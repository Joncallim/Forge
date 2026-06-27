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
  InfoIcon,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from '@/components/ui/select'
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
import {
  artifactArrayField,
  mergeArtifacts,
  taskLevelArtifactsForWorkPackages,
  type WorkforceRecord,
} from '@/lib/task-artifacts'

interface Task {
  id: string
  projectId: string
  title: string
  prompt: string
  status: string
  pmProviderConfigId: string | null
  githubPrUrl: string | null
  errorMessage: string | null
  createdAt: string
  updatedAt: string
}

type ProviderConfig = {
  id: string
  displayName: string
  providerType: string
  modelId: string
  isActive: boolean
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

function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    awaiting_answers: 'Needs answers',
    awaiting_approval: 'Needs approval',
    dead_lettered: 'Stopped after retries',
  }
  if (labels[status]) return labels[status]
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

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`
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

function recordField(record: WorkforceRecord, keys: string[]): WorkforceRecord | null {
  for (const key of keys) {
    const value = record[key]
    if (isRecord(value)) return value
  }
  return null
}

function metadataStringField(record: WorkforceRecord, keys: string[]): string {
  const metadata = recordField(record, ['metadata'])
  return metadata ? stringField(metadata, keys) : ''
}

function numberField(record: WorkforceRecord, keys: string[]): number | null {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return null
}

function metadataNumberField(record: WorkforceRecord, keys: string[]): number | null {
  const metadata = recordField(record, ['metadata'])
  return metadata ? numberField(metadata, keys) : null
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

function uniqueArtifacts(artifacts: Artifact[]): Artifact[] {
  const byId = new Map<string, Artifact>()
  for (const artifact of artifacts) byId.set(artifact.id, artifact)
  return [...byId.values()]
}

function packageArtifactsFor(pkg: WorkPackage, allArtifacts: Artifact[]): Artifact[] {
  const packageId = stringField(pkg, ['id'])
  return uniqueArtifacts([
    ...artifactArrayField<Artifact>(pkg, ['artifacts', 'packageArtifacts']),
    ...allArtifacts.filter((artifact) => artifact.workPackageId === packageId),
  ])
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

function isReviewGateType(gateType: string): boolean {
  return gateType === 'qa_review' || gateType === 'reviewer_review'
}

// Semantic color buckets shared by every status badge on this page, so the
// same color always means the same thing regardless of which entity
// (task, run, work package, approval gate, vcs change) the status belongs
// to: blue = ready to start, sky = actively running, amber = waiting on
// someone, green = finished successfully, red = stopped/failed.
function statusBadgeClass(status: string): string {
  switch (status) {
    case 'ready':
    case 'planned':
    case 'created':
    case 'proposed':
      return 'border-blue-200 bg-blue-50 text-blue-800 dark:border-blue-900/50 dark:bg-blue-950/30 dark:text-blue-300'
    case 'running':
    case 'updated':
      return 'border-sky-200 bg-sky-50 text-sky-800 dark:border-sky-900/50 dark:bg-sky-950/30 dark:text-sky-300'
    case 'awaiting_review':
    case 'awaiting_approval':
    case 'awaiting_answers':
    case 'submitted':
    case 'pending':
    case 'warning':
      return 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-200'
    case 'completed':
    case 'approved':
    case 'merged':
    case 'valid':
      return 'border-green-200 bg-green-50 text-green-800 dark:border-green-900/50 dark:bg-green-950/30 dark:text-green-300'
    case 'needs_rework':
    case 'failed':
    case 'rejected':
    case 'cancelled':
    case 'abandoned':
    case 'dead_lettered':
    case 'blocked':
      return 'border-destructive/30 bg-destructive/10 text-destructive'
    case 'warnings':
      return 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-200'
    default:
      return ''
  }
}

function statusBadge(status: string) {
  return (
    <Badge variant="outline" className={statusBadgeClass(status)}>
      {statusLabel(status)}
    </Badge>
  )
}

function progressStatusLabel(status: string): string {
  return `Status: ${statusLabel(status)}`
}

function reviewGateLabel(gateType: string): string {
  if (gateType === 'qa_review') return 'QA review'
  if (gateType === 'reviewer_review') return 'Reviewer review'
  return statusLabel(gateType)
}

function GateDecisionControls({
  gateId,
  onDecided,
  sourceArtifactId,
  taskId,
  compact = false,
}: {
  gateId: string
  onDecided: () => Promise<void>
  sourceArtifactId: string
  taskId: string
  compact?: boolean
}) {
  const [reason, setReason] = useState('')
  const [submitting, setSubmitting] = useState<'approve' | 'changes' | 'reject' | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function submitDecision(action: 'approve' | 'changes' | 'reject') {
    const trimmedReason = reason.trim()
    if (trimmedReason === '') {
      setError('Decision reason is required.')
      return
    }

    const decision = action === 'approve' ? 'completed' : 'needs_rework'
    const reasonPrefix = action === 'reject' ? 'Rejected: ' : ''

    setSubmitting(action)
    setError(null)
    try {
      const res = await fetch(`/api/tasks/${taskId}/approval-gates/${gateId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision, reason: `${reasonPrefix}${trimmedReason}`, sourceArtifactId }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? 'Failed to update review gate')
      }
      setReason('')
      await onDecided()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An unexpected error occurred')
    } finally {
      setSubmitting(null)
    }
  }

  return (
    <div className={`${compact ? 'mt-3' : 'mt-2'} grid gap-2 rounded-md border border-border bg-muted/20 p-2`}>
      <textarea
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        placeholder="Decision reason"
        rows={compact ? 3 : 2}
        className="min-h-16 resize-y rounded-md border border-input bg-background px-2 py-1.5 text-xs text-foreground shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
      {error && <p className="text-xs text-destructive">{error}</p>}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={submitting !== null}
          onClick={() => void submitDecision('approve')}
        >
          {submitting === 'approve' ? 'Saving...' : 'Approve'}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={submitting !== null}
          onClick={() => void submitDecision('changes')}
        >
          {submitting === 'changes' ? 'Saving...' : 'Request changes'}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="destructive"
          disabled={submitting !== null}
          onClick={() => void submitDecision('reject')}
        >
          {submitting === 'reject' ? 'Saving...' : 'Reject'}
        </Button>
      </div>
    </div>
  )
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
          {statusBadge(run.status)}
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
  onGateDecided,
  taskId,
  artifacts,
}: {
  workPackages: WorkPackage[]
  approvalGates: ApprovalGate[]
  vcsChanges: VcsChange[]
  fallbackAgents: PlannedAgent[]
  onGateDecided: () => Promise<void>
  taskId: string
  artifacts: Artifact[]
}) {
  const hasPersistedPlan = workPackages.length > 0 || approvalGates.length > 0
  const hasFallback = fallbackAgents.length > 0
  if (!hasPersistedPlan && !hasFallback && vcsChanges.length === 0) return null

  const fallbackTasks = fallbackAgents.reduce((sum, agent) => sum + agent.tasks, 0)
  const persistedTaskCount = workPackages.reduce((sum, pkg) => (
    sum + Math.max(1, Math.trunc(metadataNumberField(pkg, ['plannedTasks', 'taskCount', 'tasks']) ?? stringArrayField(pkg, ['steps']).length))
  ), 0)

  return (
    <section aria-labelledby="workforce-heading" className="min-w-0 rounded-lg border border-border p-4 overflow-x-hidden">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 id="workforce-heading" className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
          Workforce
        </h2>
        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
          <UsersIcon className="size-3.5" aria-hidden="true" />
          {hasPersistedPlan
            ? `${pluralize(workPackages.length, 'package')} · ${pluralize(persistedTaskCount, 'task')} · ${pluralize(approvalGates.length, 'approval checkpoint')}`
            : `${pluralize(fallbackAgents.length, 'agent')} · ${pluralize(fallbackTasks, 'task')}`}
        </span>
      </div>

      <div className="mb-3 flex items-start gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
        <ShieldCheckIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
        <p>
          Planning view only. This panel shows saved assignments and approval checkpoints; it will not change repository files.
        </p>
      </div>

      {hasPersistedPlan ? (
        <div className="grid gap-4">
          <div>
            <h3 className="mb-2 text-xs font-medium text-muted-foreground uppercase tracking-wide">Work packages</h3>
            {workPackages.length === 0 ? (
              <p className="text-sm text-muted-foreground">No work packages saved yet.</p>
            ) : (
              <ul className="flex flex-col gap-3" aria-label="Persisted work packages">
                {workPackages.map((pkg, index) => {
                  const pkgId = stringField(pkg, ['id'])
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
                  const packageArtifacts = packageArtifactsFor(pkg, artifacts)
                  const latestPackageArtifact = packageArtifacts[packageArtifacts.length - 1] ?? null
                  const packageReviewGates = approvalGates.filter((gate) => {
                    const gatePackageId = stringField(gate, ['workPackageId']) || metadataStringField(gate, ['sourcePackageId'])
                    const gateType = stringField(gate, ['gateType', 'type'])
                    return gatePackageId === pkgId && isReviewGateType(gateType)
                  })
                  const pendingReviewGate = packageReviewGates.find((gate) => stringField(gate, ['status', 'state']) === 'pending') ?? null
                  const pendingSourceArtifactId = pendingReviewGate
                    ? stringField(pendingReviewGate, ['sourceArtifactId']) || metadataStringField(pendingReviewGate, ['sourceArtifactId'])
                    : ''
                  const reviewArtifact = pendingReviewGate
                    ? packageArtifacts.find((artifact) => artifact.id === pendingSourceArtifactId) ?? null
                    : latestPackageArtifact
                  const taskCount = Math.max(1, Math.trunc(metadataNumberField(pkg, ['plannedTasks', 'taskCount', 'tasks']) ?? steps.length))

                  return (
                    <li key={recordKey(pkg, 'work-package', index)} className="min-w-0 border-t border-border pt-3 first:border-t-0 first:pt-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="min-w-0 break-words text-sm font-medium text-foreground">{title}</p>
                        {owner !== '' && (
                          <Badge variant="outline" className="max-w-[12rem] truncate" title={owner}>{owner}</Badge>
                        )}
                        {harnessName !== '' && harnessName !== owner && (
                          <Badge variant="secondary" className="max-w-[12rem] truncate" title={harnessName}>{harnessName}</Badge>
                        )}
                        {status !== '' && statusBadge(status)}
                        <Badge variant="outline">{pluralize(taskCount, 'task')}</Badge>
                      </div>
                      {summary !== '' && <p className="mt-1 text-sm text-muted-foreground">{summary}</p>}
                      {packageReviewGates.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-1.5" aria-label={`Review states for ${title}`}>
                          {packageReviewGates.map((gate, gateIndex) => {
                            const gateType = stringField(gate, ['gateType', 'type'])
                            const gateStatus = stringField(gate, ['status', 'state']) || 'pending'
                            return (
                              <Badge
                                key={recordKey(gate, 'package-review-gate', gateIndex)}
                                variant="outline"
                                className={statusBadgeClass(gateStatus)}
                              >
                                {reviewGateLabel(gateType)}: {statusLabel(gateStatus)}
                              </Badge>
                            )
                          })}
                        </div>
                      )}
                      {criteria.length > 0 && (
                        <p className="mt-1 text-xs text-muted-foreground">Acceptance: {previewList(criteria)}</p>
                      )}
                      {files.length > 0 && (
                        <p className="mt-1 break-words font-mono text-xs text-muted-foreground">{previewList(files)}</p>
                      )}
                      {status === 'awaiting_review' && (
                        <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50/70 p-3 dark:border-amber-900/50 dark:bg-amber-950/20">
                          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                            <p className="text-sm font-medium text-foreground">Package review</p>
                            {pendingReviewGate
                              ? statusBadge(stringField(pendingReviewGate, ['status', 'state']) || 'pending')
                              : <Badge variant="outline">No pending gate</Badge>}
                          </div>
                          {reviewArtifact ? (
                            <div className="max-h-[32rem] overflow-auto rounded-md bg-background/80 p-2 ring-1 ring-border">
                              <ArtifactView artifact={reviewArtifact} />
                            </div>
                          ) : (
                            <p className="rounded-md border border-dashed border-border bg-background/70 px-3 py-2 text-sm text-muted-foreground">
                              {pendingReviewGate
                                ? 'The review gate source artifact is not available in this view.'
                                : 'No package output has been attached yet.'}
                            </p>
                          )}
                          {pendingReviewGate && reviewArtifact ? (
                            <GateDecisionControls
                              gateId={stringField(pendingReviewGate, ['id'])}
                              sourceArtifactId={reviewArtifact.id}
                              taskId={taskId}
                              onDecided={onGateDecided}
                              compact
                            />
                          ) : pendingReviewGate ? (
                            <p className="mt-2 text-xs text-muted-foreground">
                              Review actions are disabled until the exact gate artifact is available.
                            </p>
                          ) : (
                            <p className="mt-2 text-xs text-muted-foreground">
                              Review actions appear when a pending QA or Reviewer gate exists for this package.
                            </p>
                          )}
                        </div>
                      )}
                      <details className="mt-2 rounded-md border border-border bg-muted/20 px-3 py-2">
                        <summary className="cursor-pointer text-xs font-medium text-foreground">
                          Assignment details
                        </summary>
                        <div className="mt-2 grid min-w-0 gap-3 text-xs">
                          {steps.length > 0 && (
                            <div>
                              <p className="font-medium text-muted-foreground">Tasks</p>
                              <ol className="mt-1 list-decimal space-y-1 pl-4 text-foreground">
                                {steps.map((step, stepIndex) => <li key={stepIndex} className="break-words">{step}</li>)}
                              </ol>
                            </div>
                          )}
                          <div>
                            <p className="font-medium text-muted-foreground">Prompt overlay</p>
                            {prompt !== '' ? (
                              <pre className="mt-1 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-md bg-background p-2 font-mono text-[11px] text-foreground ring-1 ring-border">
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
                            <pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md bg-background p-2 font-mono text-[11px] text-foreground ring-1 ring-border">
                              {workPackageBrief(pkg)}
                            </pre>
                          </div>
                          {mcpRequirements.length > 0 && (
                            <div>
                              <p className="font-medium text-muted-foreground">MCP requirements</p>
                              <pre className="mt-1 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-md bg-background p-2 font-mono text-[11px] text-foreground ring-1 ring-border">
                                {JSON.stringify(mcpRequirements, null, 2)}
                              </pre>
                            </div>
                          )}
                          {packageArtifacts.length > 0 && (
                            <div>
                              <p className="font-medium text-muted-foreground">Package artifacts</p>
                              <div className="mt-2 grid gap-2">
                                {packageArtifacts.map((artifact) => (
                                  <ArtifactView key={artifact.id} artifact={artifact} />
                                ))}
                              </div>
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
            <h3 className="mb-2 text-xs font-medium text-muted-foreground uppercase tracking-wide">Approval checkpoints</h3>
            {approvalGates.length === 0 ? (
              <p className="text-sm text-muted-foreground">No approval checkpoints saved yet.</p>
            ) : (
              <ul className="flex flex-col gap-3" aria-label="Persisted approval gates">
                {approvalGates.map((gate, index) => {
                  const gateId = stringField(gate, ['id'])
                  const gateType = stringField(gate, ['gateType', 'type'])
                  const title = stringField(gate, ['title', 'name', 'gateType', 'type']) || `Gate ${index + 1}`
                  const status = stringField(gate, ['status', 'state'])
                  const summary = stringField(gate, ['summary', 'description', 'reason', 'instructions'])
                  const required = booleanField(gate, ['required', 'isRequired'])
                  const requiredRole = metadataStringField(gate, ['requiredRole'])
                  const packageId = stringField(gate, ['workPackageId']) || metadataStringField(gate, ['sourcePackageId'])
                  const sourceRunId = stringField(gate, ['sourceAgentRunId']) || metadataStringField(gate, ['sourceRunId'])
                  const decisionReason = metadataStringField(gate, ['decisionReason'])
                  const decidedAt = stringField(gate, ['decidedAt'])

                  return (
                    <li key={recordKey(gate, 'approval-gate', index)} className="min-w-0 border-t border-border pt-3 first:border-t-0 first:pt-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="min-w-0 break-words text-sm font-medium text-foreground">{title}</p>
                        {status !== '' && statusBadge(status)}
                        {gateType !== '' && isReviewGateType(gateType) && (
                          <Badge variant="outline">{statusLabel(gateType)}</Badge>
                        )}
                        {requiredRole !== '' && (
                          <Badge variant="secondary" className="max-w-[12rem] truncate" title={requiredRole}>{requiredRole}</Badge>
                        )}
                        {required !== null && (
                          <Badge variant={required ? 'outline' : 'secondary'}>{required ? 'required' : 'optional'}</Badge>
                        )}
                      </div>
                      {packageId !== '' && (
                        <p className="mt-1 break-all font-mono text-xs text-muted-foreground">Package {packageId}</p>
                      )}
                      {sourceRunId !== '' && (
                        <p className="mt-1 break-all font-mono text-xs text-muted-foreground">Run {sourceRunId}</p>
                      )}
                      {summary !== '' && <p className="mt-1 text-sm text-muted-foreground">{summary}</p>}
                      {decisionReason !== '' && (
                        <p className="mt-1 text-sm text-muted-foreground">Decision: {decisionReason}</p>
                      )}
                      {decidedAt !== '' && (
                        <p className="mt-1 text-xs text-muted-foreground">Decided {formatDatetime(decidedAt)}</p>
                      )}
                      {gateId !== '' && isReviewGateType(gateType) && status === 'pending' && (
                        <p className="mt-2 text-xs text-muted-foreground">
                          Decide this gate from the matching package review box, where Forge shows the exact source artifact.
                        </p>
                      )}
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
            <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Plan summary</h3>
            <Badge variant="outline">from plan</Badge>
          </div>
          <p className="mb-3 text-xs text-muted-foreground">
            Forge has not saved workforce records for this task, so this view is using the Architect plan.
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
            <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Repository changes</h3>
          </div>
          <ul className="flex flex-col gap-2" aria-label="Saved repository changes">
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
                    {status !== '' && statusBadge(status)}
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
  const missingClassificationOnly =
    validation.warnings.length === 1 &&
    validation.warnings[0] === 'Architect did not provide a machine-readable capability classification.'
  const effectiveStatus = missingClassificationOnly ? 'valid' : validation.status
  const statusLabelText = missingClassificationOnly ? 'Not classified' : statusLabel(validation.status)

  return (
    <section aria-labelledby="capability-classification-heading" className="rounded-lg border border-border p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 id="capability-classification-heading" className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
          Required capabilities
        </h2>
        <span className="flex items-center gap-1.5">
          <span
            aria-label="Capability classification is machine-readable routing metadata. If it is missing, use the visible implementation plan as the source of truth."
            title="Capability classification is machine-readable routing metadata. If it is missing, use the visible implementation plan as the source of truth."
          >
            <InfoIcon className="size-3.5 text-muted-foreground" aria-hidden="true" />
          </span>
          <Badge variant="outline" className={statusBadgeClass(effectiveStatus)}>{statusLabelText}</Badge>
        </span>
      </div>

      <p className="mb-3 text-xs text-muted-foreground">
        Planning view only. The approved plan still controls which agents run.
      </p>

      {validation.warnings.length > 0 && !missingClassificationOnly && (
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
          {missingClassificationOnly
            ? 'No machine-readable capability list was provided. Use the implementation plan and visible assignments.'
            : 'No capabilities were listed for this plan.'}
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
  const missingDesignOnly =
    requirements.length === 0 &&
    design.validation.blocked.length === 0 &&
    design.validation.warnings.length === 1 &&
    design.validation.warnings[0] === 'Architect did not provide a machine-readable MCP execution design.'
  const effectiveDesignStatus = missingDesignOnly ? 'valid' : design.validation.status
  const statusText = missingDesignOnly ? 'Not requested' : statusLabel(design.validation.status)

  return (
    <section aria-labelledby="mcp-access-plan-heading" className="rounded-lg border border-border p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 id="mcp-access-plan-heading" className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
          MCP tool access
        </h2>
        <span className="flex items-center gap-1.5">
          <span
            aria-label="This panel only tracks machine-readable MCP requests. If the plan says no external services, no MCP execution design is required."
            title="This panel only tracks machine-readable MCP requests. If the plan says no external services, no MCP execution design is required."
          >
            <InfoIcon className="size-3.5 text-muted-foreground" aria-hidden="true" />
          </span>
          <Badge variant="outline" className={statusBadgeClass(effectiveDesignStatus)}>{statusText}</Badge>
        </span>
      </div>

      <div className="mb-3 flex items-start gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
        <ShieldCheckIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
        <p>
          Planning view only. Forge does not grant MCP tools at runtime yet.
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

      {design.validation.warnings.length > 0 && !missingDesignOnly && (
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
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Access decision preview</p>
            <div className="flex flex-wrap gap-1.5">
              <Badge variant="outline" className={statusBadgeClass('proposed')}>{grantPreview.summary.proposed} proposed</Badge>
              <Badge variant="outline" className={statusBadgeClass('warning')}>{grantPreview.summary.warning} warning</Badge>
              <Badge variant="outline" className={statusBadgeClass(grantPreview.summary.blocked > 0 ? 'blocked' : 'valid')}>
                {grantPreview.summary.blocked} blocked
              </Badge>
            </div>
          </div>
          <ul className="grid gap-2 text-xs">
            {grantPreview.decisions.map((decision) => {
              const statusText = decision.status === 'blocked'
                ? 'Do not assign MCP-backed work until this MCP issue is resolved.'
                : decision.status === 'warning'
                  ? 'Optional MCP access is unavailable. Continue using the Architect fallback.'
                  : 'Proposed only. MCP is available, but Forge has not granted runtime tools.'

              return (
                <li key={decision.decisionId} className="rounded-md border border-border bg-muted/20 px-2.5 py-2">
                  <div className="mb-1 flex flex-wrap items-center gap-2">
                    <Badge variant="outline" className={statusBadgeClass(decision.status)}>{decision.status}</Badge>
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
                      Status: {decision.health.installState}/{decision.health.status}
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
          The plan does not request MCP-backed execution.
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
            <dt className="font-medium text-foreground">Prompt instructions</dt>
            <dd>{overlayCount}</dd>
          </div>
          <div>
            <dt className="font-medium text-foreground">MCP-aware subtasks</dt>
            <dd>{subtaskCount}</dd>
          </div>
        </dl>
      )}
    </section>
  )
}

function TaskAttemptRow({ attempt, runs }: { attempt: TaskAttempt; runs: AgentRun[] }) {
  const matchedRun = runs.find((run) => run.agentType === attempt.queueName)
  const modelLabel = matchedRun?.modelIdUsed || (attempt.workerId ? 'Model pending' : 'Worker pending')

  return (
    <li className="border-b border-border px-4 py-3 last:border-0">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="font-medium text-foreground">{attempt.queueName}</span>
          <span className="text-muted-foreground">attempt {attempt.attemptNumber}</span>
          {statusBadge(attempt.status)}
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
          <dt className="text-muted-foreground">Next retry</dt>
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

function runStage(run: AgentRun): string {
  const stage = (run as unknown as WorkforceRecord).stage
  return typeof stage === 'string' && stage.trim() !== '' ? stage.trim() : ''
}

function hasExecutionDisabledEvidence(runs: AgentRun[], artifacts: Artifact[]): boolean {
  for (const artifact of [...artifacts].reverse()) {
    if (isRecord(artifact.metadata) && typeof artifact.metadata.repositoryWrites === 'boolean') {
      return artifact.metadata.repositoryWrites === false
    }
  }

  const latestHandoff = [...runs].reverse().find((run) => run.agentType === 'handoff')
  if (latestHandoff) return latestHandoff.modelIdUsed === 'forge-handoff/no-op'

  return [...artifacts].reverse().some((artifact) =>
    artifact.content.includes('Repository writes and specialist model execution are disabled'),
  )
}

function taskProgressSummary(input: {
  status: string
  workPackages: WorkPackage[]
  approvalGates: ApprovalGate[]
  runs: AgentRun[]
  questions: TaskQuestion[]
  artifacts: Artifact[]
}): { stage: string; nextAction: string; detail: string } {
  const openQuestions = input.questions.filter((question) => question.status !== 'answered').length
  const runningPackage = input.workPackages.find((pkg) => stringField(pkg, ['status', 'state']) === 'running')
  const awaitingReviewPackage = input.workPackages.find((pkg) => stringField(pkg, ['status', 'state']) === 'awaiting_review')
  const needsReworkPackage = input.workPackages.find((pkg) => stringField(pkg, ['status', 'state']) === 'needs_rework')
  const readyPackage = input.workPackages.find((pkg) => stringField(pkg, ['status', 'state']) === 'ready')
  const latestRun = [...input.runs].reverse().find((run) => run.status === 'running') ?? input.runs[input.runs.length - 1] ?? null
  const latestStage = latestRun ? runStage(latestRun) : ''
  const executionDisabled = hasExecutionDisabledEvidence(input.runs, input.artifacts)

  if (openQuestions > 0 || input.status === 'awaiting_answers') {
    return {
      stage: 'Architect questions',
      nextAction: 'Answer the open questions.',
      detail: `${pluralize(openQuestions, 'question')} blocking plan approval.`,
    }
  }

  if (input.status === 'awaiting_approval') {
    return {
      stage: 'Plan approval',
      nextAction: 'Approve the plan or request changes.',
      detail: 'No specialist package execution starts until the plan is approved.',
    }
  }

  if (awaitingReviewPackage) {
    return {
      stage: `Review: ${stringField(awaitingReviewPackage, ['title', 'name']) || 'work package'}`,
      nextAction: 'Review package output, then approve, request changes, or reject it.',
      detail: executionDisabled
        ? 'Execution is disabled; this review covers handoff output and no repository files were changed.'
        : 'Review gates must pass before the package is marked complete.',
    }
  }

  if (needsReworkPackage) {
    return {
      stage: `Rework queued: ${stringField(needsReworkPackage, ['title', 'name']) || 'work package'}`,
      nextAction: 'Wait for the package to be picked up again or inspect the review reason.',
      detail: 'The previous review sent this package back for changes.',
    }
  }

  if (runningPackage) {
    return {
      stage: `Implementation: ${stringField(runningPackage, ['title', 'name']) || 'work package'}`,
      nextAction: 'Wait for output and review gates.',
      detail: executionDisabled
        ? 'Execution is disabled; Forge is creating reviewable handoff output without repository writes.'
        : 'A specialist package is currently running.',
    }
  }

  if (readyPackage) {
    return {
      stage: `Ready: ${stringField(readyPackage, ['title', 'name']) || 'work package'}`,
      nextAction: 'Worker handoff is ready for the next package.',
      detail: 'Dependencies are satisfied for this package.',
    }
  }

  if (input.status === 'running') {
    return {
      stage: latestStage ? statusLabel(latestStage) : 'Worker running',
      nextAction: input.workPackages.length > 0 ? 'Monitor package progress.' : 'Wait for the architect output.',
      detail: executionDisabled
        ? 'Execution is disabled for package handoff; status reflects orchestration progress, not direct file writes.'
        : 'Forge is processing the task.',
    }
  }

  if (input.status === 'completed') {
    return { stage: 'Completed', nextAction: 'Review artifacts or pull request output.', detail: 'All required gates are complete.' }
  }

  if (input.status === 'failed') {
    return { stage: 'Failed', nextAction: 'Read the error and retry when ready.', detail: 'The task stopped before completion.' }
  }

  if (input.status === 'rejected' || input.status === 'cancelled') {
    return { stage: statusLabel(input.status), nextAction: 'Retry the task if this should run again.', detail: 'No active worker action is pending.' }
  }

  return {
    stage: statusLabel(input.status),
    nextAction: 'Wait for the next worker update.',
    detail: 'No blocking operator action is visible yet.',
  }
}

function TaskProgressPanel({
  status,
  workPackages,
  approvalGates,
  runs,
  questions,
  artifacts,
}: {
  status: string
  workPackages: WorkPackage[]
  approvalGates: ApprovalGate[]
  runs: AgentRun[]
  questions: TaskQuestion[]
  artifacts: Artifact[]
}) {
  const summary = taskProgressSummary({ status, workPackages, approvalGates, runs, questions, artifacts })
  const packageCounts = workPackages.reduce<Record<string, number>>((counts, pkg) => {
    const packageStatus = stringField(pkg, ['status', 'state']) || 'unknown'
    counts[packageStatus] = (counts[packageStatus] ?? 0) + 1
    return counts
  }, {})
  const reviewCounts = approvalGates.reduce<Record<string, number>>((counts, gate) => {
    const gateType = stringField(gate, ['gateType', 'type'])
    if (!isReviewGateType(gateType)) return counts
    const gateStatus = stringField(gate, ['status', 'state']) || 'pending'
    counts[gateStatus] = (counts[gateStatus] ?? 0) + 1
    return counts
  }, {})

  return (
    <section aria-labelledby="task-progress-heading" className="mb-6 rounded-lg border border-border bg-card p-4">
      <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(220px,0.45fr)]">
        <div className="min-w-0">
          <h2 id="task-progress-heading" className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
            Progress
          </h2>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <p className="break-words text-lg font-semibold text-foreground">{summary.stage}</p>
            <Badge variant="outline" className={statusBadgeClass(status)}>
              {progressStatusLabel(status)}
            </Badge>
          </div>
          <p className="mt-2 text-sm text-foreground">{summary.nextAction}</p>
          <p className="mt-1 text-xs text-muted-foreground">{summary.detail}</p>
        </div>
        <div className="grid gap-3 text-xs">
          <div>
            <p className="mb-1 font-medium text-muted-foreground uppercase tracking-wide">Packages</p>
            {Object.keys(packageCounts).length === 0 ? (
              <p className="text-muted-foreground">No packages yet.</p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {Object.entries(packageCounts).map(([packageStatus, count]) => (
                  <Badge key={packageStatus} variant="outline" className={statusBadgeClass(packageStatus)}>
                    {statusLabel(packageStatus)}: {count}
                  </Badge>
                ))}
              </div>
            )}
          </div>
          <div>
            <p className="mb-1 font-medium text-muted-foreground uppercase tracking-wide">Reviews</p>
            {Object.keys(reviewCounts).length === 0 ? (
              <p className="text-muted-foreground">No review gates yet.</p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {Object.entries(reviewCounts).map(([reviewStatus, count]) => (
                  <Badge key={reviewStatus} variant="outline" className={statusBadgeClass(reviewStatus)}>
                    {statusLabel(reviewStatus)}: {count}
                  </Badge>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
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
  const [providers, setProviders] = useState<ProviderConfig[]>([])
  const [loading, setLoading] = useState(true)
  const [fetchError, setFetchError] = useState<string | null>(null)

  // Implementation Plan — collapsed by default to save space; expands to
  // show the full plan text or a revision diff when there are 2+ versions
  const [planExpanded, setPlanExpanded] = useState(false)

  // Approve / change-plan / restart state
  const [actionLoading, setActionLoading] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [actionMode, setActionMode] = useState<'none' | 'restart' | 'replan'>('none')
  const [rejectReason, setRejectReason] = useState('')
  const [replanFeedback, setReplanFeedback] = useState('')
  const [retryProviderId, setRetryProviderId] = useState<string | null>(null)

  // SSE stream
  const {
    runs: streamRuns,
    artifacts: streamArtifacts,
    taskStatus,
    error: streamError,
    questions: streamQuestions,
    refreshRevision: streamRefreshRevision,
  } = useTaskStream(taskId)

  // Merge initial data with live stream data
  const mergedRuns: AgentRun[] = streamRuns.length > 0 ? streamRuns : initialRuns
  const mergedArtifacts: Artifact[] = mergeArtifacts(initialArtifacts, streamArtifacts)
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
      setRetryProviderId(data.task?.pmProviderConfigId ?? null)
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

  const loadProviders = useCallback(async () => {
    try {
      const res = await fetch('/api/providers')
      if (!res.ok) return
      const data = await res.json() as { providers?: ProviderConfig[] }
      setProviders(data.providers ?? [])
    } catch {
      setProviders([])
    }
  }, [])

  useEffect(() => {
    loadTask()
    loadProviders()
  }, [loadProviders, loadTask])

  // Refresh task when SSE reports a state where persisted side data may have changed.
  useEffect(() => {
    const REFRESH_STATUSES = new Set([
      'awaiting_answers',
      'awaiting_approval',
      'running',
      'completed',
      'failed',
      'cancelled',
      'rejected',
    ])
    if (taskStatus && REFRESH_STATUSES.has(taskStatus)) {
      loadTask()
    }
  }, [taskStatus, loadTask])

  useEffect(() => {
    if (streamRefreshRevision > 0) {
      loadTask()
    }
  }, [streamRefreshRevision, loadTask])

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

  async function handleRetry(e: React.FormEvent) {
    e.preventDefault()
    setActionLoading(true)
    setActionError(null)
    try {
      const res = await fetch(`/api/tasks/${taskId}/retry`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pmProviderConfigId: retryProviderId }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? 'Failed to retry task')
      }
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
  const canRetryTask = ['failed', 'cancelled', 'rejected'].includes(currentStatus ?? task.status)
  const plannedAgents = plannedAgentsFromArtifacts(mergedArtifacts)
  const capabilityClassification = latestCapabilityClassificationFromArtifacts(mergedArtifacts)
  const mcpExecutionDesign = latestMcpExecutionDesignFromArtifacts(mergedArtifacts)

  const taskLevelArtifacts = taskLevelArtifactsForWorkPackages(mergedArtifacts, workPackages)
  const adrArtifacts = taskLevelArtifacts.filter((artifact) => artifact.artifactType === 'adr_text')
  const otherArtifacts = taskLevelArtifacts.filter((artifact) => artifact.artifactType !== 'adr_text')
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
              {statusBadge(currentStatus ?? task.status)}
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

      <TaskProgressPanel
        status={currentStatus ?? task.status}
        workPackages={workPackages}
        approvalGates={approvalGates}
        runs={mergedRuns}
        questions={mergedQuestions}
        artifacts={mergedArtifacts}
      />

      {/* Implementation Plan — full width, above the two-column layout below,
          collapsed by default so it doesn't dominate the page */}
      <section aria-labelledby="implementation-plan-heading" className="mb-6 rounded-lg border border-border bg-card p-4">
        <button
          type="button"
          onClick={() => setPlanExpanded((value) => !value)}
          className="flex w-full items-center justify-between gap-3 text-left focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          aria-expanded={planExpanded}
          aria-controls="implementation-plan-content"
        >
          <h2 id="implementation-plan-heading" className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
            Implementation Plan
          </h2>
          {planExpanded ? (
            <ChevronUpIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          ) : (
            <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          )}
        </button>
        {planExpanded && (
          <div id="implementation-plan-content" className="mt-3 min-w-0">
            {adrArtifacts.length === 0 ? (
              <p className="text-sm text-muted-foreground">No implementation plan has been generated for this task yet.</p>
            ) : adrArtifacts.length >= 2 ? (
              <PlanDiffView
                oldContent={sortedAdrArtifacts[sortedAdrArtifacts.length - 2].content}
                newContent={sortedAdrArtifacts[sortedAdrArtifacts.length - 1].content}
              />
            ) : (
              <div className="min-w-0 rounded-lg bg-muted/40 px-4 py-3">
                <MarkdownView content={stripKnownFences(sortedAdrArtifacts[0].content)} />
              </div>
            )}
          </div>
        )}
      </section>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:items-start">
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

          {/* Open questions — answer before the plan can be approved; placed
              right under the prompt since it can block progress */}
          {mergedQuestions.length > 0 && (
            <div className="mb-6">
              <QuestionsPanel taskId={taskId} questions={mergedQuestions} onAnswered={loadTask} />
            </div>
          )}

          {/* Approve / Change plan / Restart actions */}
          {isAwaitingApproval && (
            <div className="mb-6 rounded-lg border border-border bg-card p-4">
              <p className="mb-3 text-sm font-medium text-foreground">
                Review the plan. You can approve it, request changes, or restart the task.
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
                    aria-label="Request changes to the plan"
                  >
                    Request changes
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
                      placeholder="Describe what Forge should change in the plan…"
                      className="resize-y rounded-lg border border-input bg-transparent px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                    />
                    <p className="text-xs text-muted-foreground">
                      Forge will revise the current plan and keep unaffected sections.
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

          {canRetryTask && (
            <form onSubmit={handleRetry} className="mb-6 rounded-lg border border-border bg-card p-4">
              <div className="mb-3 flex items-start gap-2 text-sm text-muted-foreground">
                <CircleAlertIcon className="mt-0.5 size-4 shrink-0 text-amber-600" aria-hidden="true" />
                <p>
                  Retry requeues this task from the beginning. Switching models can change the plan output; use it when the previous provider is offline or unsuitable.
                </p>
              </div>
              <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
                <div className="flex flex-col gap-1.5">
                  <label htmlFor="retry-provider" className="text-sm font-medium text-foreground">
                    Model
                  </label>
                  <Select
                    value={retryProviderId ?? 'task-default'}
                    onValueChange={(value) => setRetryProviderId(value === 'task-default' ? null : value)}
                    disabled={actionLoading}
                  >
                    <SelectTrigger id="retry-provider" className="w-full">
                      <span data-slot="select-value" className="truncate">
                        {retryProviderId
                          ? providers.find((provider) => provider.id === retryProviderId)?.displayName ?? 'Selected provider'
                          : 'Task default'}
                      </span>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="task-default">Task default</SelectItem>
                      {providers.map((provider) => (
                        <SelectItem key={provider.id} value={provider.id}>
                          {provider.displayName} · {provider.modelId}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <Button type="submit" size="sm" disabled={actionLoading} aria-busy={actionLoading}>
                  {actionLoading ? 'Retrying…' : 'Retry task'}
                </Button>
              </div>
              {actionError !== null && (
                <p role="alert" aria-live="assertive" className="mt-3 text-sm text-destructive">
                  {actionError}
                </p>
              )}
            </form>
          )}

          {/* Required capabilities and MCP tool access — reference/routing
              metadata, grouped with the prompt rather than the workforce
              execution column */}
          <div className="mb-6 grid gap-6">
            <CapabilityClassificationPanel classification={capabilityClassification} />
            <McpAccessPlanPanel design={mcpExecutionDesign} />
          </div>

          {/* Agent run timeline */}
          <section aria-labelledby="runs-heading" className="mb-6">
            <h2 id="runs-heading" className="mb-3 text-sm font-medium text-muted-foreground uppercase tracking-wide">
              Agent activity
            </h2>
            {mergedRuns.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border px-4 py-8 text-center">
                <p className="text-sm text-muted-foreground">No agent activity yet.</p>
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
              Retry history
            </h2>
            {attempts.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border px-4 py-8 text-center">
                <p className="text-sm text-muted-foreground">No retry history yet.</p>
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
            taskId={taskId}
            onGateDecided={loadTask}
            artifacts={mergedArtifacts}
          />

          {/* Artifacts — Implementation Plan now lives in its own top-level
              section above; this keeps only other artifact types (file
              diffs, test reports, PR links, review findings) */}
          {otherArtifacts.length > 0 && (
            <section aria-labelledby="artifacts-heading">
              <h2 id="artifacts-heading" className="mb-3 text-sm font-medium text-muted-foreground uppercase tracking-wide">
                Artifacts
              </h2>
              <div className="flex flex-col gap-3">
                {otherArtifacts.map((artifact) => (
                  <ArtifactView key={artifact.id} artifact={artifact} />
                ))}
              </div>
            </section>
          )}
        </aside>
      </div>
    </div>
  )
}
