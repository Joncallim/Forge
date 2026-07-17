'use client'

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
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
  DownloadIcon,
  SquareIcon,
  Trash2Icon,
  LoaderCircleIcon,
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
import { mergeAgentRun, useTaskStream } from '@/hooks/useTaskStream'
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
  approvedGrantsForDisplay,
  latestMcpPlanReviewForDisplay,
  mcpCapabilityCeilingForAgent,
  mcpPlanOverlayCount,
  mcpRequirementDisplayKey,
  type McpPlanReviewDisplayItem,
} from '@/lib/mcps/plan-review-metadata'
import {
  artifactArrayField,
  mergeArtifacts,
  taskLevelArtifactsForWorkPackages,
  type WorkforceRecord,
} from '@/lib/task-artifacts'
import { acpProviderDisplay } from '@/lib/providers/acp/catalog'

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

function providerModelLabel(provider: ProviderConfig): string {
  if (provider.providerType !== 'acp') return provider.modelId
  const display = acpProviderDisplay(provider.modelId)
  return `${display.runtimeLabel} · ${display.modelSelectionLabel}`
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

interface TaskLog {
  id: string
  sequence: number
  taskId: string
  taskAttemptId: string | null
  agentRunId: string | null
  workPackageId: string | null
  artifactId: string | null
  approvalGateId: string | null
  level: string
  eventType: string
  source: string
  title: string
  message: string
  frontMatter: Record<string, unknown>
  metadata: Record<string, unknown>
  occurredAt: string
  createdAt: string
}

type WorkPackage = WorkforceRecord
type ApprovalGate = WorkforceRecord
type VcsChange = WorkforceRecord
type CommandAudit = WorkforceRecord
type FilesystemAudit = WorkforceRecord
type RetryHandoffResultStatus = 'retry_already_queued' | 'retry_enqueued'
type GateDecisionResponseWarning = {
  error?: unknown
}
type WorkforceExecutionMode =
  | 'disabled_handoff'
  | 'opt_in_sandbox'
  | 'running_package'
  | 'sandbox_output'
  | 'fallback_plan'

interface TaskDetailResponse {
  task?: Task | null
  runs?: AgentRun[]
  artifacts?: Artifact[]
  questions?: TaskQuestion[]
  attempts?: TaskAttempt[]
  workPackages?: WorkPackage[]
  approvalGates?: ApprovalGate[]
  commandAudits?: CommandAudit[]
  filesystemAudits?: FilesystemAudit[]
  vcsChanges?: VcsChange[]
}

type ProjectFilesystemGrantState = {
  capabilities: string[]
  enabled: boolean
}

function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    awaiting_answers: 'Needs answers',
    awaiting_approval: 'Needs approval',
    dead_lettered: 'Stopped after retries',
    pending: 'Pending execution',
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
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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

function parseJsonRecord(value: string): WorkforceRecord | null {
  try {
    const parsed: unknown = JSON.parse(value)
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
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

function duplicateSafeKey(prefix: string, value: string, index: number): string {
  return `${prefix}-${index}-${value.slice(0, 80)}`
}

function isActiveExecutionStatus(status: string): boolean {
  return status === 'running' || status === 'approved'
}

function ExecutionIndicator({ label = 'Execution in progress' }: { label?: string }) {
  return (
    <span
      role="status"
      aria-live="polite"
      className="inline-flex items-center gap-1.5 text-xs font-medium text-sky-700 dark:text-sky-300"
    >
      <LoaderCircleIcon className="size-3.5 animate-spin" aria-hidden="true" />
      {label}
    </span>
  )
}

function previewList(items: string[], limit = 4): string {
  const visible = items.slice(0, limit)
  const remaining = items.length - visible.length
  return remaining > 0 ? `${visible.join(', ')} +${remaining} more` : visible.join(', ')
}

const FILESYSTEM_CAPABILITY_OPTIONS = [
  'filesystem.project.read',
  'filesystem.project.list',
  'filesystem.project.search',
] as const

function canonicalFilesystemCapability(value: string): string | null {
  const normalized = value.trim().toLowerCase().replace(/\s+/g, '_')
  const match = normalized.match(/^filesystem\.(?:project\.)?(read|list|search)$/)
  return match ? `filesystem.project.${match[1]}` : null
}

function filesystemCapabilitiesFromValues(values: string[]): string[] {
  const capabilities = new Set<string>()
  for (const value of values) {
    const capability = canonicalFilesystemCapability(value)
    if (capability) capabilities.add(capability)
  }
  return [...capabilities].sort()
}

function filesystemPackageCapabilitySummary(pkg: WorkPackage): {
  blockingCapabilities: string[]
  requestedCapabilities: string[]
} {
  const requested = new Set<string>()
  const blocking = new Set<string>()
  for (const requirement of jsonArrayField(pkg, ['mcpRequirements'])) {
    if (stringField(requirement, ['mcpId', 'id']) !== 'filesystem') continue
    const capabilities = filesystemCapabilitiesFromValues([
      ...stringArrayField(requirement, ['capabilities']),
      ...stringArrayField(requirement, ['permissions']),
      ...stringArrayField(requirement, ['mcpCapabilities']),
    ])
    for (const capability of capabilities) requested.add(capability)
    const fallback = recordField(requirement, ['fallback'])
    const fallbackAction = fallback ? stringField(fallback, ['action']) : ''
    if (stringField(requirement, ['requirement']) === 'optional' && fallbackAction === 'continue_without_mcp') {
      continue
    }
    for (const capability of capabilities) blocking.add(capability)
  }

  const metadata = recordField(pkg, ['metadata'])
  for (const subtask of metadata ? jsonArrayField(metadata, ['mcpAwareSubtasks', 'mcpSubtasks']) : []) {
    for (const capability of filesystemCapabilitiesFromValues(stringArrayField(subtask, ['mcpCapabilities', 'capabilities']))) {
      requested.add(capability)
    }
  }
  if (requested.size > 0) requested.add('filesystem.project.read')
  if (blocking.size > 0) blocking.add('filesystem.project.read')

  return {
    blockingCapabilities: [...blocking].sort(),
    requestedCapabilities: [...requested].sort(),
  }
}

function projectFilesystemGrantCoversPackage(
  projectFilesystemGrant: ProjectFilesystemGrantState | null,
  pkg: WorkPackage,
): boolean {
  if (!projectFilesystemGrant?.enabled) return false
  const summary = filesystemPackageCapabilitySummary(pkg)
  const requiredCapabilities = summary.blockingCapabilities.length > 0
    ? summary.blockingCapabilities
    : summary.requestedCapabilities
  return requiredCapabilities.length > 0 && requiredCapabilities.every((capability) => (
    projectFilesystemGrant.capabilities.includes(capability)
  ))
}

export function unresolvedRequiredFilesystemGrants(
  workPackages: WorkPackage[],
  projectFilesystemGrant: ProjectFilesystemGrantState | null = null,
): Array<{
  missingCapabilities: string[]
  packageId: string
  title: string
}> {
  return workPackages.flatMap((pkg, index) => {
    const summary = filesystemPackageCapabilitySummary(pkg)
    if (summary.blockingCapabilities.length === 0) return []
    if (projectFilesystemGrantCoversPackage(projectFilesystemGrant, pkg)) return []

    const effective = filesystemEffectiveState(pkg)
    if (effective.status === 'denied') return []
    const missingCapabilities = summary.blockingCapabilities.filter((capability) => (
      effective.status !== 'approved' || !effective.capabilities.includes(capability)
    ))
    if (missingCapabilities.length === 0) return []

    return [{
      missingCapabilities,
      packageId: stringField(pkg, ['id']),
      title: stringField(pkg, ['title', 'name', 'summary', 'agentType', 'role']) || `Work package ${index + 1}`,
    }]
  })
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

function mcpGrantPhasesFromGate(gate: ApprovalGate): WorkforceRecord | null {
  const metadata = recordField(gate, ['metadata'])
  if (!metadata) return null
  const direct = recordField(metadata, ['mcpGrantPhases'])
  if (direct) return direct

  const chunks = metadata.queryChunks
  if (!Array.isArray(chunks)) return null
  for (const chunk of chunks) {
    if (typeof chunk !== 'string' || !chunk.includes('mcpGrantPhases')) continue
    const parsed = parseJsonRecord(chunk)
    if (!parsed) continue
    const phases = recordField(parsed, ['mcpGrantPhases'])
    if (phases) return phases
  }
  return null
}

export function approvedGrantPackagesFromGate(gate: ApprovalGate): WorkforceRecord[] {
  const phases = mcpGrantPhasesFromGate(gate)
  if (!phases) return []
  const approved = recordField(phases, ['approved'])
  return approved ? jsonArrayField(approved, ['packages']) : []
}

function hasOwn(record: WorkforceRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key)
}

function artifactMetadata(artifact: Artifact): WorkforceRecord | null {
  return isRecord(artifact.metadata) ? artifact.metadata : null
}

function artifactShowsDisabledHandoff(artifact: Artifact): boolean {
  const metadata = artifactMetadata(artifact)
  const source = metadata ? stringField(metadata, ['source']) : ''
  return (
    (metadata !== null && booleanField(metadata, ['repositoryWrites']) === false && source === 'work-package-handoff') ||
    artifact.content.includes('Repository writes and specialist model execution are disabled') ||
    artifact.content.includes('Specialist model execution is disabled')
  )
}

type SandboxOutputSummary = {
  artifactId: string
  commandCount: number
  fileCount: number
  files: string[]
  hostRepositoryWritePaths: string[]
  hostRepositoryWrites: boolean
  sandboxPath: string
  validationStatus: string
}

function sandboxOutputFromArtifact(artifact: Artifact): SandboxOutputSummary | null {
  const metadata = artifactMetadata(artifact)
  if (!metadata) return null

  const sandboxPath = stringField(metadata, ['sandboxPath', 'sandboxRoot', 'outputPath'])
  const files = stringArrayField(metadata, ['files', 'generatedFiles', 'paths'])
  const generatedBy = stringField(metadata, ['generatedBy'])
  const hostRepositoryWritePaths = stringArrayField(metadata, ['hostRepositoryWritePaths'])
  const hostRepositoryWrites = booleanField(metadata, ['hostRepositoryWrites', 'repositoryWrites']) === true
  const commandResults = jsonArrayField(metadata, ['commandResults', 'commands'])
  const fileCount = Math.max(0, numberField(metadata, ['fileCount']) ?? files.length)
  const validationStatus = stringField(metadata, ['validationStatus'])

  if (sandboxPath === '' && files.length === 0 && generatedBy !== 'work-package-executor') return null

  return {
    artifactId: artifact.id,
    commandCount: commandResults.length,
    fileCount,
    files,
    hostRepositoryWritePaths,
    hostRepositoryWrites,
    sandboxPath,
    validationStatus,
  }
}

export function sandboxOutputsForPackage(pkg: WorkPackage, allArtifacts: Artifact[]): SandboxOutputSummary[] {
  return packageArtifactsFor(pkg, allArtifacts)
    .map(sandboxOutputFromArtifact)
    .filter((output): output is SandboxOutputSummary => output !== null)
}

function runWorkPackageId(run: AgentRun): string {
  return stringField(run as unknown as WorkforceRecord, ['workPackageId'])
}

function runAttemptNumber(run: AgentRun): number | null {
  return numberField(run as unknown as WorkforceRecord, ['attemptNumber'])
}

function runsForPackage(pkg: WorkPackage, runs: AgentRun[]): AgentRun[] {
  const pkgId = stringField(pkg, ['id'])
  if (pkgId === '') return []
  return runs.filter((run) => runWorkPackageId(run) === pkgId)
}

export function mergeTaskRuns(initialRuns: AgentRun[], streamRuns: AgentRun[]): AgentRun[] {
  const byId = new Map<string, AgentRun>()
  const order: string[] = []

  for (const run of initialRuns) {
    if (!byId.has(run.id)) order.push(run.id)
    byId.set(run.id, run)
  }

  for (const run of streamRuns) {
    const existing = byId.get(run.id)
    if (!existing) {
      order.push(run.id)
      byId.set(run.id, run)
      continue
    }
    byId.set(run.id, mergeAgentRun(existing, run))
  }

  return order
    .map((id) => byId.get(id))
    .filter((run): run is AgentRun => run !== undefined)
}

export function workforceExecutionSummary(input: {
  artifacts: Artifact[]
  runs: AgentRun[]
  workPackages: WorkPackage[]
}): { detail: string; label: string; mode: WorkforceExecutionMode; status: string } {
  if (input.workPackages.length === 0) {
    return {
      detail: 'No persisted work packages exist yet; this view is showing the Architect plan only.',
      label: 'Planning only',
      mode: 'fallback_plan',
      status: 'planned',
    }
  }

  const disabledHandoff = input.artifacts.some(artifactShowsDisabledHandoff) ||
    [...input.runs].reverse().some((run) => run.agentType === 'handoff' && run.modelIdUsed === 'forge-handoff/no-op')
  if (disabledHandoff) {
    return {
      detail: 'Package handoff is disabled in this run. Forge produced reviewable handoff artifacts only; no specialist package model ran and no sandbox files were generated.',
      label: 'Disabled handoff',
      mode: 'disabled_handoff',
      status: 'warning',
    }
  }

  const runningPackage = input.workPackages.some((pkg) => stringField(pkg, ['status', 'state']) === 'running')
  const runningImplementationRun = input.runs.some((run) => {
    const runRecord = run as unknown as WorkforceRecord
    return run.status === 'running' && (stringField(runRecord, ['stage']) === 'implementation' || runWorkPackageId(run) !== '')
  })
  if (runningPackage || runningImplementationRun) {
    return {
      detail: 'A package execution run is active. Forge writes sandbox artifacts first and may apply successful output to the local project.',
      label: 'Running sandbox package',
      mode: 'running_package',
      status: 'running',
    }
  }

  const sandboxOutputCount = input.workPackages.reduce(
    (count, pkg) => count + sandboxOutputsForPackage(pkg, input.artifacts).length,
    0,
  )
  if (sandboxOutputCount > 0) {
    return {
      detail: `${pluralize(sandboxOutputCount, 'sandbox output')} generated under .forge/task-runs. Review generated files, host-write metadata, and validation artifacts before approving gates.`,
      label: 'Sandbox output generated',
      mode: 'sandbox_output',
      status: 'completed',
    }
  }

  return {
    detail: 'Ready packages execute by default. Forge keeps generated files under .forge/task-runs and applies successful repository-affecting output to the local project unless host repository writes are disabled.',
    label: 'Executable packages',
    mode: 'opt_in_sandbox',
    status: 'ready',
  }
}

function mcpBrokerMetadata(pkg: WorkPackage): WorkforceRecord | null {
  const metadata = recordField(pkg, ['metadata'])
  return metadata ? recordField(metadata, ['mcpBroker']) : null
}

type SecurityFinding = {
  confidence: string
  description: string
  key: string
  location: string
  recommendation: string
  severity: string
  status: string
  title: string
}

export type SecurityReviewPayload = {
  findings: SecurityFinding[]
  state: 'findings' | 'no_findings'
  summary: string
}

type SecurityFindingSubmission = {
  reviewSurface: string
  asset: string
  trustBoundary: string
  exploitPath: string
  impact: string
  requiredFix: string
  evidenceRefs: string[]
  severity: string
  confidence: string
  verificationState: string
}

type SecurityReviewSubmissionPayload = {
  schemaVersion: 1
  findings: SecurityFindingSubmission[]
  noFindings?: {
    reviewSurface: string
    evidenceRefs: string[]
    verificationState: string
  }
  summary?: string
  verdict: 'findings' | 'no_findings'
}

type SecurityReviewFormState = {
  asset: string
  confidence: string
  evidenceRefs: string
  exploitPath: string
  impact: string
  mode: 'no_findings' | 'finding'
  requiredFix: string
  reviewSurface: string
  severity: string
  trustBoundary: string
  verificationState: string
}

type GateDecisionAction = 'approve' | 'changes' | 'reject'

type ReviewGateDecisionRequestBody = {
  decision: 'completed' | 'needs_rework'
  reason: string
  securityReview?: SecurityReviewSubmissionPayload
  sourceArtifactId: string
}

const DEFAULT_SECURITY_REVIEW_SURFACE = 'Security review gate'
const DEFAULT_SECURITY_REVIEW_VERIFICATION = 'Reviewed the source artifact and found no security findings.'

function defaultSecurityReviewForm(sourceArtifactId: string): SecurityReviewFormState {
  return {
    asset: '',
    confidence: 'medium',
    evidenceRefs: sourceArtifactId,
    exploitPath: '',
    impact: '',
    mode: 'no_findings',
    requiredFix: '',
    reviewSurface: DEFAULT_SECURITY_REVIEW_SURFACE,
    severity: 'medium',
    trustBoundary: '',
    verificationState: '',
  }
}

function securityEvidenceRefs(value: string, fallbackRef: string): string[] {
  const fallback = fallbackRef.trim()
  const refs = value
    .split(/[\n,]/u)
    .map((item) => item.trim())
    .filter((item) => item !== '')
  const deduped = new Set<string>()
  const orderedRefs = [
    ...(fallback !== '' ? [fallback] : []),
    ...refs,
  ].filter((item) => {
    if (deduped.has(item)) return false
    deduped.add(item)
    return true
  })
  return orderedRefs.slice(0, 20)
}

function securityReviewSurface(value: string): string {
  return value.trim() || DEFAULT_SECURITY_REVIEW_SURFACE
}

export function securityReviewSubmissionPayloadFromForm({
  fallbackVerification,
  form,
  sourceArtifactId,
}: {
  fallbackVerification: string
  form: SecurityReviewFormState
  sourceArtifactId: string
}): { error: string | null; payload: SecurityReviewSubmissionPayload | null } {
  const reviewSurface = securityReviewSurface(form.reviewSurface)
  const evidenceRefs = securityEvidenceRefs(form.evidenceRefs, sourceArtifactId)
  const verificationState = form.verificationState.trim() || fallbackVerification.trim() || DEFAULT_SECURITY_REVIEW_VERIFICATION

  if (evidenceRefs.length === 0) {
    return { error: 'Security review evidence is required.', payload: null }
  }

  if (form.mode === 'no_findings') {
    return {
      error: null,
      payload: {
        schemaVersion: 1,
        findings: [],
        noFindings: {
          reviewSurface,
          evidenceRefs,
          verificationState,
        },
        summary: verificationState,
        verdict: 'no_findings',
      },
    }
  }

  const asset = form.asset.trim()
  const trustBoundary = form.trustBoundary.trim()
  const exploitPath = form.exploitPath.trim()
  const impact = form.impact.trim()
  const requiredFix = form.requiredFix.trim()
  const missing = [
    asset === '' ? 'asset' : null,
    trustBoundary === '' ? 'trust boundary' : null,
    exploitPath === '' ? 'exploit path' : null,
    impact === '' ? 'impact' : null,
    requiredFix === '' ? 'required fix' : null,
  ].filter((item): item is string => item !== null)
  if (missing.length > 0) {
    return { error: `Security finding requires ${missing.join(', ')}.`, payload: null }
  }

  return {
    error: null,
    payload: {
      schemaVersion: 1,
      findings: [{
        reviewSurface,
        asset,
        trustBoundary,
        exploitPath,
        impact,
        requiredFix,
        evidenceRefs,
        severity: form.severity.trim().toLowerCase() || 'medium',
        confidence: form.confidence.trim().toLowerCase() || 'medium',
        verificationState,
      }],
      summary: '1 structured security finding recorded.',
      verdict: 'findings',
    },
  }
}

export function buildReviewGateDecisionRequestBody({
  action,
  gateType,
  reason,
  securityReviewForm,
  sourceArtifactId,
}: {
  action: GateDecisionAction
  gateType: string
  reason: string
  securityReviewForm?: SecurityReviewFormState
  sourceArtifactId: string
}): { body: ReviewGateDecisionRequestBody | null; error: string | null } {
  const trimmedReason = reason.trim()
  if (trimmedReason === '') {
    return { body: null, error: 'Decision reason is required.' }
  }

  const decision = action === 'approve' ? 'completed' : 'needs_rework'
  const reasonPrefix = action === 'reject' ? 'Rejected: ' : ''
  const body: ReviewGateDecisionRequestBody = {
    decision,
    reason: `${reasonPrefix}${trimmedReason}`,
    sourceArtifactId,
  }

  if (gateType === 'security_review') {
    if (action === 'approve' && securityReviewForm?.mode === 'finding') {
      return { body: null, error: 'Security findings require requesting changes, not approval.' }
    }
    if (action !== 'approve' && securityReviewForm?.mode !== 'finding') {
      return { body: null, error: 'Security rework requires a structured finding.' }
    }
    const securityReview = securityReviewSubmissionPayloadFromForm({
      fallbackVerification: trimmedReason,
      form: securityReviewForm ?? defaultSecurityReviewForm(sourceArtifactId),
      sourceArtifactId,
    })
    if (!securityReview.payload) {
      return { body: null, error: securityReview.error ?? 'Security review payload is invalid.' }
    }
    body.securityReview = securityReview.payload
  }

  return { body, error: null }
}

function securityReviewRecords(record: WorkforceRecord): WorkforceRecord[] {
  return [
    record,
    recordField(record, ['securityReview', 'security', 'review']),
  ].filter((item): item is WorkforceRecord => item !== null)
}

function normalizeSecurityFinding(value: unknown, index: number): SecurityFinding | null {
  if (typeof value === 'string' && value.trim() !== '') {
    return {
      confidence: '',
      description: value.trim(),
      key: `security-finding-${index + 1}`,
      location: '',
      recommendation: '',
      severity: 'info',
      status: '',
      title: `Finding ${index + 1}`,
    }
  }
  if (!isRecord(value)) return null

  const title = stringField(value, ['title', 'summary', 'name', 'ruleId', 'reviewSurface', 'asset']) || `Finding ${index + 1}`
  const evidenceRefs = stringArrayField(value, ['evidenceRefs'])
  const path = stringField(value, ['path', 'file', 'filePath', 'location']) || stringField(value, ['asset'])
  const line = numberField(value, ['line', 'startLine'])
  const impact = stringField(value, ['impact'])
  const exploitPath = stringField(value, ['exploitPath'])
  const trustBoundary = stringField(value, ['trustBoundary'])
  const description = stringField(value, ['description', 'detail', 'message', 'evidence']) || [
    impact !== '' ? `Impact: ${impact}` : null,
    exploitPath !== '' ? `Exploit path: ${exploitPath}` : null,
    trustBoundary !== '' ? `Trust boundary: ${trustBoundary}` : null,
  ].filter((part): part is string => part !== null).join(' ')
  return {
    confidence: stringField(value, ['confidence']),
    description,
    key: stringField(value, ['id', 'ruleId', 'key']) || `security-finding-${index + 1}`,
    location: line !== null && path !== '' ? `${path}:${line}` : path || previewList(evidenceRefs, 3),
    recommendation: stringField(value, ['recommendation', 'remediation', 'fix', 'mitigation', 'requiredFix']),
    severity: stringField(value, ['severity', 'level', 'risk']) || 'info',
    status: stringField(value, ['status', 'state', 'disposition', 'verificationState']),
    title,
  }
}

function findingArray(record: WorkforceRecord): { explicitEmpty: boolean; findings: SecurityFinding[] } {
  const keys = ['securityFindings', 'findings', 'vulnerabilities', 'issues']
  for (const key of keys) {
    if (!hasOwn(record, key) || !Array.isArray(record[key])) continue
    const findings = (record[key] as unknown[])
      .map(normalizeSecurityFinding)
      .filter((finding): finding is SecurityFinding => finding !== null)
    return { explicitEmpty: findings.length === 0, findings }
  }
  return { explicitEmpty: false, findings: [] }
}

function explicitNoSecurityFindings(record: WorkforceRecord): boolean {
  if (booleanField(record, ['noFindings', 'noSecurityFindings']) === true) return true
  const verdict = stringField(record, ['verdict', 'result', 'status', 'state']).toLowerCase()
  return ['no_findings', 'no findings', 'clean', 'passed'].includes(verdict)
}

export function securityReviewPayloadFromMetadata(...sources: unknown[]): SecurityReviewPayload | null {
  for (const source of sources) {
    if (!isRecord(source)) continue
    for (const record of securityReviewRecords(source)) {
      const summary = stringField(record, ['summary', 'conclusion', 'message', 'notes'])
      const findings = findingArray(record)
      if (findings.findings.length > 0) {
        return { findings: findings.findings, state: 'findings', summary }
      }
      if (findings.explicitEmpty || explicitNoSecurityFindings(record)) {
        return { findings: [], state: 'no_findings', summary }
      }
    }
  }
  return null
}

function firstMetadataText(record: WorkforceRecord | null, keys: string[]): string {
  if (!record) return ''
  for (const key of keys) {
    const value = stringField(record, [key])
    if (value !== '') return value
  }
  return ''
}

function compactReviewText(value: string, maxLength = 900): string {
  return value.trim().replace(/\s+/g, ' ').slice(0, maxLength)
}

function reviewFindingsText(record: WorkforceRecord | null): string {
  if (!record) return ''
  const findings = jsonArrayField(record, ['findings', 'reviewFindings', 'issues'])
    .map((finding, index) => {
      if (typeof finding === 'string') return compactReviewText(finding, 240)
      if (!isRecord(finding)) return ''
      const title = stringField(finding, ['title', 'summary', 'message', 'description']) || `Finding ${index + 1}`
      const recommendation = stringField(finding, ['recommendation', 'requiredFix', 'fix'])
      return compactReviewText([title, recommendation].filter(Boolean).join(': '), 320)
    })
    .filter(Boolean)
  return findings.length > 0 ? findings.join('\n') : ''
}

export function reviewDecisionSuggestionFromArtifact(input: {
  gateType: string
  securityPayload: SecurityReviewPayload | null
  sourceArtifact: Artifact | null
}): { reason: string; requiresHumanTradeoff: boolean } {
  const requiresHumanSecurityDecision = input.securityPayload?.findings.some((finding) =>
    ['critical', 'high'].includes(finding.severity.toLowerCase())
  ) ?? false
  if (requiresHumanSecurityDecision) {
    return { reason: '', requiresHumanTradeoff: true }
  }

  if (input.securityPayload?.findings.length) {
    const reason = input.securityPayload.findings
      .map((finding) => compactReviewText(`${finding.title}: ${finding.recommendation || finding.description}`))
      .filter(Boolean)
      .join('\n')
    return { reason, requiresHumanTradeoff: false }
  }

  if (input.securityPayload?.state === 'no_findings' && input.securityPayload.summary !== '') {
    return { reason: compactReviewText(input.securityPayload.summary), requiresHumanTradeoff: false }
  }

  const artifact = input.sourceArtifact
  const metadata = artifact ? artifactMetadata(artifact) : null
  const explicit = firstMetadataText(metadata, [
    'reviewComment',
    'reviewComments',
    'reviewerComment',
    'reviewerComments',
    'decisionReason',
    'recommendation',
    'conclusion',
    'summary',
    'notes',
  ])
  if (explicit !== '') return { reason: compactReviewText(explicit), requiresHumanTradeoff: false }

  const findings = reviewFindingsText(metadata)
  if (findings !== '') return { reason: findings, requiresHumanTradeoff: false }

  if (artifact && input.gateType === 'reviewer_review') {
    const content = compactReviewText(artifact.content)
    if (content !== '') return { reason: content, requiresHumanTradeoff: false }
  }

  return { reason: '', requiresHumanTradeoff: false }
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
    `### ${title}`,
    owner ? `**Role:** ${owner}` : null,
    harnessName ? `**Planning harness:** ${harnessName}` : null,
    harnessDescription ? `**Planning harness description:** ${harnessDescription}` : null,
    summary ? `**Summary:** ${summary}` : null,
    `**Prompt overlay:**\n\n${prompt || 'No additional prompt overlay persisted for this package.'}`,
    steps.length > 0 ? `**Steps**\n\n${steps.map((step, index) => `${index + 1}. ${step}`).join('\n')}` : null,
    criteria.length > 0
      ? `**Acceptance criteria**\n\n${criteria.map((criterion, index) => `${index + 1}. ${criterion}`).join('\n')}`
      : null,
    capabilities ? formatRequiredCapabilitiesMarkdown(capabilities) : null,
  ].filter((part): part is string => part !== null).join('\n\n')
}

function asStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

// Renders the requiredCapabilities object as a readable list rather than a raw
// JSON block. Falls back to nothing if there is no meaningful content.
function formatRequiredCapabilitiesMarkdown(capabilities: Record<string, unknown>): string | null {
  const required = asStringList(capabilities.required)
  const optional = asStringList(capabilities.optional)
  const excluded = Array.isArray(capabilities.excluded)
    ? capabilities.excluded
        .map((entry) => {
          if (typeof entry === 'string') return entry
          if (isRecord(entry)) {
            const cap = typeof entry.capability === 'string' ? entry.capability : ''
            const reason = typeof entry.reason === 'string' ? entry.reason : ''
            return cap ? (reason ? `${cap} (${reason})` : cap) : ''
          }
          return ''
        })
        .filter((entry) => entry !== '')
    : []

  const lines = [
    required.length > 0 ? `- **Required:** ${required.join(', ')}` : null,
    optional.length > 0 ? `- **Optional:** ${optional.join(', ')}` : null,
    excluded.length > 0 ? `- **Excluded:** ${excluded.join('; ')}` : null,
  ].filter((line): line is string => line !== null)

  if (lines.length === 0) return null
  return ['**Required capabilities**', '', ...lines].join('\n')
}

function describeMcpAssignment(value: unknown): string {
  if (typeof value === 'string') return value
  if (!isRecord(value)) return ''
  const type = typeof value.type === 'string' ? value.type.replace(/_/g, ' ') : ''
  const targets = asStringList(value.targetAgents)
  const targetId = typeof value.targetId === 'string' ? value.targetId : ''
  const destination = targets.length > 0 ? targets.join(', ') : targetId
  return [type, destination ? `→ ${destination}` : ''].filter(Boolean).join(' ')
}

function describeMcpFallback(value: unknown): string {
  if (typeof value === 'string') return value
  if (!isRecord(value)) return ''
  const action = typeof value.action === 'string' ? value.action.replace(/_/g, ' ') : ''
  const message = typeof value.message === 'string' ? value.message : ''
  return [action, message].filter(Boolean).join(' — ')
}

function mcpPermissionChips(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string')
  if (isRecord(value)) {
    return Object.entries(value).flatMap(([agent, caps]) =>
      asStringList(caps).map((cap) => `${agent}: ${cap}`),
    )
  }
  return []
}

function mcpRequirementLabel(requirement: WorkforceRecord): string {
  return stringField(requirement, ['mcpId', 'id', 'name', 'server', 'connectorId']) || 'MCP requirement'
}

function McpRequirementCards({ requirements }: { requirements: WorkforceRecord[] }) {
  if (requirements.length === 0) return null

  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {requirements.map((requirement, index) => {
        const label = mcpRequirementLabel(requirement)
        const requirementLevel = stringField(requirement, ['requirement', 'level', 'status'])
        const reason = stringField(requirement, ['reason', 'rationale', 'description'])
        const assignment = describeMcpAssignment(requirement.assignment)
        const permissions = mcpPermissionChips(
          requirement.agentPermissions ?? requirement.permissions ?? requirement.capabilities,
        )
        const fallback = describeMcpFallback(requirement.fallback)

        return (
          <div key={`${label}-${index}`} className="min-w-0 rounded-md border border-border bg-background p-3">
            <div className="flex flex-wrap items-center gap-2">
              <p className="min-w-0 break-words font-mono text-sm font-medium text-foreground">{label}</p>
              {requirementLevel !== '' && <Badge variant="outline">{requirementLevel}</Badge>}
            </div>
            {reason !== '' && <p className="mt-1 break-words text-xs text-muted-foreground">{reason}</p>}
            <dl className="mt-2 grid gap-2 text-xs">
              {assignment !== '' && (
                <div className="flex flex-wrap items-baseline gap-1.5">
                  <dt className="font-medium text-muted-foreground">Assignment</dt>
                  <dd className="break-words text-foreground">{assignment}</dd>
                </div>
              )}
              {permissions.length > 0 && (
                <div>
                  <dt className="font-medium text-muted-foreground">Permissions</dt>
                  <dd className="mt-1 flex flex-wrap gap-1">
                    {permissions.map((permission, permissionIndex) => (
                      <span
                        key={`${permission}-${permissionIndex}`}
                        className="rounded-full bg-muted px-2 py-0.5 font-mono text-[11px] text-muted-foreground"
                      >
                        {permission}
                      </span>
                    ))}
                  </dd>
                </div>
              )}
              {fallback !== '' && (
                <div className="flex flex-wrap items-baseline gap-1.5">
                  <dt className="font-medium text-muted-foreground">Fallback</dt>
                  <dd className="break-words text-foreground">{fallback}</dd>
                </div>
              )}
            </dl>
          </div>
        )
      })}
    </div>
  )
}

function isReviewGateType(gateType: string): boolean {
  return gateType === 'qa_review' || gateType === 'reviewer_review' || gateType === 'security_review'
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
    case 'info':
    case 'updated':
      return 'border-sky-200 bg-sky-50 text-sky-800 dark:border-sky-900/50 dark:bg-sky-950/30 dark:text-sky-300'
    case 'awaiting_review':
    case 'awaiting_approval':
    case 'awaiting_answers':
    case 'submitted':
    case 'pending':
    case 'skipped':
    case 'validation_skipped':
    case 'warning':
      return 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-200'
    case 'completed':
    case 'success':
    case 'approved':
    case 'complete':
    case 'merged':
    case 'passed':
    case 'valid':
      return 'border-green-200 bg-green-50 text-green-800 dark:border-green-900/50 dark:bg-green-950/30 dark:text-green-300'
    case 'needs_rework':
    case 'error':
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
  if (gateType === 'security_review') return 'Security review'
  return statusLabel(gateType)
}

function GateDecisionControls({
  gateType,
  gateId,
  onDecided,
  requiresHumanTradeoff = false,
  sourceArtifactId,
  suggestedReason = '',
  taskId,
  compact = false,
}: {
  gateType: string
  gateId: string
  onDecided: () => Promise<void>
  requiresHumanTradeoff?: boolean
  sourceArtifactId: string
  suggestedReason?: string
  taskId: string
  compact?: boolean
}) {
  const [reason, setReason] = useState(suggestedReason)
  const [reasonTouched, setReasonTouched] = useState(false)
  const [securityReviewForm, setSecurityReviewForm] = useState<SecurityReviewFormState>(() =>
    defaultSecurityReviewForm(sourceArtifactId),
  )
  const [submitting, setSubmitting] = useState<'approve' | 'changes' | 'reject' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [warning, setWarning] = useState<string | null>(null)
  const isSecurityGate = gateType === 'security_review'

  useEffect(() => {
    setSecurityReviewForm((current) => {
      const nextEvidenceRefs = securityEvidenceRefs(current.evidenceRefs, sourceArtifactId).join(', ')
      if (nextEvidenceRefs === current.evidenceRefs) return current
      return { ...current, evidenceRefs: nextEvidenceRefs }
    })
  }, [sourceArtifactId])

  useEffect(() => {
    if (reasonTouched) return
    setReason(suggestedReason)
  }, [reasonTouched, suggestedReason])

  function updateSecurityReviewForm<K extends keyof SecurityReviewFormState>(
    key: K,
    value: SecurityReviewFormState[K],
  ) {
    setSecurityReviewForm((current) => ({ ...current, [key]: value }))
  }

  async function submitDecision(action: GateDecisionAction) {
    const requestBody = buildReviewGateDecisionRequestBody({
      action,
      gateType,
      reason,
      securityReviewForm,
      sourceArtifactId,
    })
    if (!requestBody.body) {
      setError(requestBody.error ?? 'Decision payload is invalid.')
      return
    }

    setSubmitting(action)
    setError(null)
    setWarning(null)
    try {
      const res = await fetch(`/api/tasks/${taskId}/approval-gates/${gateId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody.body),
      })
      const body = await res.json().catch(() => ({})) as GateDecisionResponseWarning
      if (!res.ok) {
        throw new Error(typeof body.error === 'string' ? body.error : 'Failed to update review gate')
      }
      if (res.status === 202 && typeof body.error === 'string' && body.error.trim() !== '') {
        setWarning(body.error)
        await onDecided()
        return
      }
      setReason('')
      setReasonTouched(false)
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
        onChange={(event) => {
          setReasonTouched(true)
          setReason(event.target.value)
        }}
        placeholder={requiresHumanTradeoff ? 'High or critical issue: write the trade-off decision here' : 'Decision reason'}
        rows={compact ? 3 : 2}
        className="min-h-16 resize-y rounded-md border border-input bg-background px-2 py-1.5 text-xs text-foreground shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
      <p className="text-xs text-muted-foreground">
        {requiresHumanTradeoff
          ? 'High and critical findings need a human-written decision reason because accepting or deferring them means choosing a trade-off.'
          : 'Forge may prefill this from reviewer output when available. Treat it as suggested wording and edit it before deciding.'}
      </p>
      {isSecurityGate && (
        <fieldset className="grid gap-2 rounded-md border border-border bg-background/80 p-2 text-xs">
          <legend className="px-1 font-medium text-foreground">Security review</legend>
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Security review result">
            <label className="flex items-center gap-1.5 rounded-md border border-border px-2 py-1">
              <input
                type="radio"
                name={`security-review-mode-${gateId}`}
                value="no_findings"
                checked={securityReviewForm.mode === 'no_findings'}
                onChange={() => updateSecurityReviewForm('mode', 'no_findings')}
              />
              No findings
            </label>
            <label className="flex items-center gap-1.5 rounded-md border border-border px-2 py-1">
              <input
                type="radio"
                name={`security-review-mode-${gateId}`}
                value="finding"
                checked={securityReviewForm.mode === 'finding'}
                onChange={() => updateSecurityReviewForm('mode', 'finding')}
              />
              Structured finding
            </label>
          </div>
          <label className="grid gap-1">
            <span className="font-medium text-muted-foreground">Review surface</span>
            <input
              type="text"
              value={securityReviewForm.reviewSurface}
              onChange={(event) => updateSecurityReviewForm('reviewSurface', event.target.value)}
              className="rounded-md border border-input bg-background px-2 py-1.5 text-foreground shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </label>
          <label className="grid gap-1">
            <span className="font-medium text-muted-foreground">Evidence refs</span>
            <input
              type="text"
              value={securityReviewForm.evidenceRefs}
              onChange={(event) => updateSecurityReviewForm('evidenceRefs', event.target.value)}
              placeholder="artifact id, file path, test name"
              className="rounded-md border border-input bg-background px-2 py-1.5 font-mono text-[11px] text-foreground shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </label>
          <label className="grid gap-1">
            <span className="font-medium text-muted-foreground">Verification</span>
            <textarea
              value={securityReviewForm.verificationState}
              onChange={(event) => updateSecurityReviewForm('verificationState', event.target.value)}
              placeholder="Defaults to the decision reason"
              rows={2}
              className="min-h-14 resize-y rounded-md border border-input bg-background px-2 py-1.5 text-foreground shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </label>
          {securityReviewForm.mode === 'finding' && (
            <div className="grid gap-2">
              <label className="grid gap-1">
                <span className="font-medium text-muted-foreground">Asset</span>
                <input
                  type="text"
                  value={securityReviewForm.asset}
                  onChange={(event) => updateSecurityReviewForm('asset', event.target.value)}
                  placeholder="file, route, workflow, or integration"
                  className="rounded-md border border-input bg-background px-2 py-1.5 text-foreground shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
              </label>
              <label className="grid gap-1">
                <span className="font-medium text-muted-foreground">Trust boundary</span>
                <input
                  type="text"
                  value={securityReviewForm.trustBoundary}
                  onChange={(event) => updateSecurityReviewForm('trustBoundary', event.target.value)}
                  placeholder="input to privileged operation"
                  className="rounded-md border border-input bg-background px-2 py-1.5 text-foreground shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
              </label>
              <label className="grid gap-1">
                <span className="font-medium text-muted-foreground">Exploit path</span>
                <textarea
                  value={securityReviewForm.exploitPath}
                  onChange={(event) => updateSecurityReviewForm('exploitPath', event.target.value)}
                  rows={2}
                  className="min-h-14 resize-y rounded-md border border-input bg-background px-2 py-1.5 text-foreground shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
              </label>
              <label className="grid gap-1">
                <span className="font-medium text-muted-foreground">Impact</span>
                <textarea
                  value={securityReviewForm.impact}
                  onChange={(event) => updateSecurityReviewForm('impact', event.target.value)}
                  rows={2}
                  className="min-h-14 resize-y rounded-md border border-input bg-background px-2 py-1.5 text-foreground shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
              </label>
              <label className="grid gap-1">
                <span className="font-medium text-muted-foreground">Required fix</span>
                <textarea
                  value={securityReviewForm.requiredFix}
                  onChange={(event) => updateSecurityReviewForm('requiredFix', event.target.value)}
                  rows={2}
                  className="min-h-14 resize-y rounded-md border border-input bg-background px-2 py-1.5 text-foreground shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
              </label>
              <div className="grid gap-2 sm:grid-cols-2">
                <label className="grid gap-1">
                  <span className="font-medium text-muted-foreground">Severity</span>
                  <select
                    value={securityReviewForm.severity}
                    onChange={(event) => updateSecurityReviewForm('severity', event.target.value)}
                    className="rounded-md border border-input bg-background px-2 py-1.5 text-foreground shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <option value="low">Low</option>
                    <option value="medium">Medium</option>
                    <option value="high">High</option>
                    <option value="critical">Critical</option>
                  </select>
                </label>
                <label className="grid gap-1">
                  <span className="font-medium text-muted-foreground">Confidence</span>
                  <select
                    value={securityReviewForm.confidence}
                    onChange={(event) => updateSecurityReviewForm('confidence', event.target.value)}
                    className="rounded-md border border-input bg-background px-2 py-1.5 text-foreground shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <option value="low">Low</option>
                    <option value="medium">Medium</option>
                    <option value="high">High</option>
                  </select>
                </label>
              </div>
            </div>
          )}
        </fieldset>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
      {warning && <p className="text-xs text-amber-600 dark:text-amber-400">{warning}</p>}
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

export function retryHandoffMessage(status: RetryHandoffResultStatus): string {
  return status === 'retry_already_queued'
    ? 'Recovery is already queued. The worker will re-evaluate this handoff.'
    : 'Recovery queued. The worker will re-evaluate this handoff.'
}

export function canRetryHandoffForTaskStatus(status: string, hasBlockedPackage: boolean): boolean {
  return (status === 'approved' || status === 'running') && !hasBlockedPackage
}

const TERMINAL_TASK_STATUSES = new Set(['completed', 'failed', 'cancelled', 'rejected'])

export function canStopTaskStatus(status: string): boolean {
  return !TERMINAL_TASK_STATUSES.has(status)
}

export function canDeleteTaskStatus(status: string): boolean {
  return TERMINAL_TASK_STATUSES.has(status)
}

// ---------------------------------------------------------------------------
// RetryHandoffControls — re-enqueues a handoff for a package the MCP/capability
// broker blocked (e.g. a temporarily-unhealthy MCP). Available to the operator
// once the underlying issue is resolved; the worker re-runs the broker, so a
// still-unresolved block simply re-blocks.
// ---------------------------------------------------------------------------
function RetryHandoffControls({
  blockedReason,
  onRetried,
  taskId,
  title = 'Handoff blocked',
}: {
  blockedReason: string
  onRetried: () => Promise<void>
  taskId: string
  title?: string
}) {
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [retryStatus, setRetryStatus] = useState<RetryHandoffResultStatus | null>(null)

  async function retry() {
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch(`/api/tasks/${taskId}/retry-handoff`, { method: 'POST' })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? 'Failed to queue handoff recovery')
      }
      const body = await res.json().catch(() => ({}))
      const status = body?.result?.status === 'retry_already_queued' ? 'retry_already_queued' : 'retry_enqueued'
      setRetryStatus(status)
      await onRetried()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An unexpected error occurred')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="mt-3 min-w-0 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3">
      <p className="text-sm font-medium text-foreground">{title}</p>
      {blockedReason !== '' && (
        <p className="mt-1 text-xs text-muted-foreground">{blockedReason}</p>
      )}
      <p className="mt-1 text-[11px] text-muted-foreground">
        Use this only if the handoff worker stalled or disconnected. It re-checks the task and
        continues any packages that are ready — it does not approve pending filesystem access or
        skip review gates, so it will not unblock a package that is waiting on your approval.
      </p>
      {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={submitting}
          onClick={() => void retry()}
          title="Re-run a handoff that stalled because the worker stopped — not for approving access."
        >
          {submitting ? 'Queueing…' : 'Re-run stalled handoff'}
        </Button>
        {retryStatus && !error && (
          <span className="text-xs text-muted-foreground">{retryHandoffMessage(retryStatus)}</span>
        )}
      </div>
    </div>
  )
}

function SandboxOutputList({ outputs }: { outputs: SandboxOutputSummary[] }) {
  if (outputs.length === 0) return null
  const hostWriteCount = outputs.reduce((count, output) => count + output.hostRepositoryWritePaths.length, 0)

  return (
    <div className="mt-3 rounded-md border border-border bg-muted/20 px-3 py-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Generated files</p>
        <Badge variant="outline" className={statusBadgeClass('completed')}>{outputs.length}</Badge>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        Forge keeps package output under <span className="font-mono">.forge/task-runs</span>
        {hostWriteCount > 0
          ? ' and applied the listed host repository files to the local project.'
          : '. No host repository files were recorded for these artifacts.'}
      </p>
      <ul className="mt-2 grid gap-2">
        {outputs.map((output) => (
          <li key={output.artifactId} className="rounded-md bg-background px-2 py-1.5 ring-1 ring-border">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="font-medium text-foreground">{pluralize(output.fileCount, 'file')}</span>
              <span className="text-muted-foreground">{pluralize(output.commandCount, 'command')}</span>
              {output.validationStatus !== '' && (
                <Badge variant="outline" className={statusBadgeClass(output.validationStatus)}>
                  Validation: {statusLabel(output.validationStatus)}
                </Badge>
              )}
              {output.hostRepositoryWrites && (
                <Badge variant="outline" className={statusBadgeClass('completed')}>host writes</Badge>
              )}
            </div>
            {output.sandboxPath !== '' && (
              <p className="mt-1 break-all font-mono text-[11px] text-muted-foreground">{output.sandboxPath}</p>
            )}
            {output.files.length > 0 && (
              <p className="mt-1 break-words font-mono text-[11px] text-muted-foreground">
                {previewList(output.files, 5)}
              </p>
            )}
            {output.hostRepositoryWritePaths.length > 0 && (
              <p className="mt-1 break-words font-mono text-[11px] text-foreground">
                Host: {previewList(output.hostRepositoryWritePaths, 5)}
              </p>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}

function BrokerRetrySummary({ broker }: { broker: WorkforceRecord | null }) {
  if (!broker) return null

  const retryable = booleanField(broker, ['retryable'])
  const attempts = numberField(broker, ['autoRetryAttempts'])
  const nextAutoRetryAt = stringField(broker, ['nextAutoRetryAt'])
  const blocked = stringArrayField(broker, ['blocked'])
  const warnings = stringArrayField(broker, ['warnings'])

  return (
    <div className="mt-2 rounded-md border border-border bg-background/70 px-2.5 py-2 text-xs">
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {retryable !== null && (
          <span><span className="font-medium text-foreground">Retryable:</span> {retryable ? 'yes' : 'no'}</span>
        )}
        {attempts !== null && (
          <span><span className="font-medium text-foreground">Auto retries:</span> {attempts}</span>
        )}
        {nextAutoRetryAt !== '' && (
          <span><span className="font-medium text-foreground">Next auto retry:</span> {formatDatetime(nextAutoRetryAt)}</span>
        )}
      </div>
      {blocked.length > 0 && (
        <p className="mt-1 break-words text-destructive">{previewList(blocked, 3)}</p>
      )}
      {warnings.length > 0 && (
        <p className="mt-1 break-words text-muted-foreground">Warnings: {previewList(warnings, 3)}</p>
      )}
    </div>
  )
}

function McpGrantCards({ grants }: { grants: WorkforceRecord[] }) {
  if (grants.length === 0) return null

  return (
    <div>
      <p className="font-medium text-muted-foreground">Brokered MCP grant decisions</p>
      <p className="mt-1 text-muted-foreground">
        No live MCP tool handles are issued in beta. These brokered decisions only shape run-scoped package instructions.
      </p>
      <div className="mt-2 grid gap-2">
        {grants.map((grant, index) => {
          const mcpId = stringField(grant, ['mcpId', 'id']) || 'MCP'
          const status = stringField(grant, ['status', 'state']) || 'proposed'
          const requirement = stringField(grant, ['requirement'])
          const reason = stringField(grant, ['reason'])
          const capabilities = stringArrayField(grant, ['capabilities', 'permissions'])
          const fallback = describeMcpFallback(grant.fallback)
          return (
            <div key={recordKey(grant, 'mcp-grant', index)} className="rounded-md border border-border bg-background px-2 py-1.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-xs font-medium text-foreground">{mcpId}</span>
                <Badge variant="outline" className={statusBadgeClass(status)}>{statusLabel(status)}</Badge>
                {requirement !== '' && <Badge variant="secondary">{requirement}</Badge>}
              </div>
              {reason !== '' && <p className="mt-1 text-muted-foreground">{reason}</p>}
              {capabilities.length > 0 && (
                <p className="mt-1 break-words font-mono text-[11px] text-muted-foreground">{capabilities.join(', ')}</p>
              )}
              {fallback !== '' && <p className="mt-1 text-muted-foreground">Fallback: {fallback}</p>}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function filesystemEffectiveState(pkg: WorkPackage): {
  capabilities: string[]
  grantMode: string
  grantApprovalId: string
  reason: string
  status: string
} {
  const metadata = recordField(pkg, ['metadata'])
  const phases = metadata ? recordField(metadata, ['mcpGrantPhases']) : null
  const effective = phases ? recordField(phases, ['effective']) : null
  if (!effective) {
    return { capabilities: [], grantApprovalId: '', grantMode: '', reason: '', status: 'not_issued' }
  }
  const grants = jsonArrayField(effective, ['grants'])
  return {
    capabilities: filesystemCapabilitiesFromValues(grants.flatMap((grant) => stringArrayField(grant, ['capabilities', 'permissions']))),
    grantMode: stringField(effective, ['grantMode', 'mode', 'scope']),
    grantApprovalId: stringField(effective, ['grantApprovalId']),
    reason: stringField(effective, ['reason']),
    status: stringField(effective, ['status']) || 'not_issued',
  }
}

function FilesystemGrantControls({
  onUpdated,
  pkg,
  taskId,
  taskStatus,
}: {
  onUpdated: () => Promise<void>
  pkg: WorkPackage
  taskId: string
  taskStatus: string | null
}) {
  const summary = useMemo(() => filesystemPackageCapabilitySummary(pkg), [pkg])
  const effective = useMemo(() => filesystemEffectiveState(pkg), [pkg])
  const [selected, setSelected] = useState<string[]>(effective.capabilities.length > 0 ? effective.capabilities : summary.requestedCapabilities)
  const [reason, setReason] = useState(effective.reason)
  const [saving, setSaving] = useState<'allow_once' | 'always_allow' | 'denied' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const packageId = stringField(pkg, ['id'])
  const packageStatus = stringField(pkg, ['status'])

  useEffect(() => {
    setSelected(effective.capabilities.length > 0 ? effective.capabilities : summary.requestedCapabilities)
    setReason(effective.reason)
  }, [effective, summary])

  if (summary.requestedCapabilities.length === 0 || packageId === '') return null

  const canEdit = (
    (taskStatus === 'awaiting_approval' || taskStatus === 'approved') &&
    ['pending', 'ready', 'blocked', 'needs_rework'].includes(packageStatus)
  ) || (taskStatus === 'failed' && ['failed', 'blocked'].includes(packageStatus))
  const approveDisabled = selected.length === 0 || !selected.includes('filesystem.project.read')
  const deniedRequired = effective.status === 'denied' && summary.blockingCapabilities.length > 0

  async function submit(decision: 'approved' | 'denied', grantMode: 'allow_once' | 'always_allow' = 'always_allow') {
    setSaving(decision === 'approved' ? grantMode : 'denied')
    setError(null)
    try {
      const res = await fetch(`/api/tasks/${taskId}/filesystem-grants`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          schemaVersion: 1,
          grants: [{
            workPackageId: packageId,
            decision,
            capabilities: decision === 'approved' ? selected : [],
            grantMode,
            reason: reason.trim() || undefined,
          }],
        }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(body.error ?? 'Failed to save filesystem grant')
      }
      await onUpdated()
      if (res.status === 202) {
        setError(body.error ?? 'Filesystem grant saved, but Forge could not requeue the recovered task. Retry handoff manually.')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An unexpected error occurred')
    } finally {
      setSaving(null)
    }
  }

  return (
    <div className="rounded-md border border-border bg-background px-2.5 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <p className="font-medium text-muted-foreground">Filesystem context grant</p>
        <Badge variant="outline" className={statusBadgeClass(effective.status)}>{statusLabel(effective.status)}</Badge>
        {effective.grantMode !== '' && <Badge variant="secondary">{statusLabel(effective.grantMode)}</Badge>}
        {summary.blockingCapabilities.length > 0 && <Badge variant="secondary">required</Badge>}
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        {FILESYSTEM_CAPABILITY_OPTIONS.filter((capability) => summary.requestedCapabilities.includes(capability)).map((capability) => (
          <label key={capability} className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 font-mono text-[11px] text-foreground">
            <input
              checked={selected.includes(capability)}
              disabled={!canEdit}
              onChange={(event) => {
                setSelected((current) => event.target.checked
                  ? [...new Set([...current, capability])].sort()
                  : current.filter((item) => item !== capability))
              }}
              type="checkbox"
            />
            {capability.replace('filesystem.project.', '')}
          </label>
        ))}
      </div>
      {deniedRequired && (
        <p className="mt-2 text-xs text-destructive">
          Required filesystem access is denied; this package will block at execution.
        </p>
      )}
      {canEdit && (
        <div className="mt-2 grid gap-2">
          <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-xs text-muted-foreground">
            <p>
              Always allow saves this filesystem approval for the project, so future packages with the same or narrower filesystem needs can run without asking again.
            </p>
            <p className="mt-1">
              Forge still sends only a bounded read-only context packet. It does not issue live filesystem tools or write access.
            </p>
          </div>
          <textarea
            className="min-h-16 w-full rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground"
            onChange={(event) => setReason(event.target.value)}
            placeholder="Reason"
            value={reason}
          />
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={saving !== null || approveDisabled}
              onClick={() => void submit('approved', 'allow_once')}
              size="sm"
              type="button"
              variant="outline"
            >
              {saving === 'allow_once' ? 'Saving...' : 'Allow once'}
            </Button>
            <Button
              disabled={saving !== null || approveDisabled}
              onClick={() => void submit('approved', 'always_allow')}
              size="sm"
              type="button"
              variant="outline"
            >
              {saving === 'always_allow' ? 'Saving...' : 'Always allow'}
            </Button>
            <Button
              disabled={saving !== null}
              onClick={() => void submit('denied')}
              size="sm"
              type="button"
              variant="outline"
            >
              {saving === 'denied' ? 'Saving...' : 'Deny'}
            </Button>
          </div>
        </div>
      )}
      {effective.grantApprovalId !== '' && (
        <p className="mt-2 break-all font-mono text-[11px] text-muted-foreground">Grant {effective.grantApprovalId}</p>
      )}
      {error !== null && <p role="alert" className="mt-2 text-xs text-destructive">{error}</p>}
    </div>
  )
}

function ApprovedGrantSnapshot({ packages }: { packages: WorkforceRecord[] }) {
  if (packages.length === 0) return null

  return (
    <div className="mt-2 rounded-md border border-border bg-background/70 px-2.5 py-2 text-xs">
      <p className="font-medium text-muted-foreground">Operator-approved capability snapshot</p>
      <p className="mt-1 text-muted-foreground">
        This records approval-time grants only. No live MCP tool handles are issued in beta.
      </p>
      <div className="mt-2 grid gap-2">
        {packages.map((pkg, index) => {
          const packageId = stringField(pkg, ['workPackageId', 'id']) || `Package ${index + 1}`
          const assignedRole = stringField(pkg, ['assignedRole', 'role'])
          const approvedGrants = approvedGrantsForDisplay(pkg)
          const proposedRequirements = jsonArrayField(pkg, ['approvedRequirements', 'proposedRequirements', 'requirements'])
          return (
            <div key={recordKey(pkg, 'approved-grant-package', index)} className="rounded-md border border-border bg-background px-2 py-1.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="break-all font-mono text-[11px] text-foreground">{packageId}</span>
                {assignedRole !== '' && <Badge variant="secondary">{assignedRole}</Badge>}
              </div>
              {approvedGrants.length > 0 && (
                <p className="mt-1 text-muted-foreground">
                  Grants: {approvedGrants.map((grant) => stringField(grant, ['mcpId', 'id']) || 'MCP').join(', ')}
                </p>
              )}
              {proposedRequirements.length > 0 && (
                <p className="mt-1 text-muted-foreground">
                  Requirements: {proposedRequirements.map((requirement) => stringField(requirement, ['mcpId', 'id']) || 'MCP').join(', ')}
                </p>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function McpSubtaskCards({ subtasks }: { subtasks: WorkforceRecord[] }) {
  if (subtasks.length === 0) return null

  return (
    <div>
      <p className="font-medium text-muted-foreground">Effective MCP-aware run instructions</p>
      <p className="mt-1 text-muted-foreground">
        These subtasks are prompt instructions for the sandbox package run; they are not proof that live MCP tools were attached.
      </p>
      <ul className="mt-2 grid gap-2">
        {subtasks.map((subtask, index) => {
          const id = stringField(subtask, ['id', 'title', 'name']) || `Subtask ${index + 1}`
          const capabilities = stringArrayField(subtask, ['mcpCapabilities', 'capabilities'])
          const verification = stringArrayField(subtask, ['verification'])
          const fallback = stringField(subtask, ['fallback'])
          return (
            <li key={recordKey(subtask, 'mcp-subtask', index)} className="rounded-md border border-border bg-background px-2 py-1.5">
              <p className="font-medium text-foreground">{id}</p>
              {capabilities.length > 0 && (
                <p className="mt-1 break-words font-mono text-[11px] text-muted-foreground">{capabilities.join(', ')}</p>
              )}
              {verification.length > 0 && <p className="mt-1 text-muted-foreground">Verify: {previewList(verification, 3)}</p>}
              {fallback !== '' && <p className="mt-1 text-muted-foreground">Fallback: {fallback}</p>}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function SecurityFindingsPanel({ payload }: { payload: SecurityReviewPayload | null }) {
  if (!payload) return null

  if (payload.state === 'no_findings') {
    return (
      <div className="mt-3 rounded-md border border-green-200 bg-green-50 px-3 py-2 text-xs text-green-900 dark:border-green-900/50 dark:bg-green-950/30 dark:text-green-200">
        <p className="font-medium">Security findings: none reported</p>
        {payload.summary !== '' && <p className="mt-1">{payload.summary}</p>}
      </div>
    )
  }

  return (
    <div className="mt-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs">
      <p className="font-medium text-foreground">Structured security findings</p>
      {payload.summary !== '' && <p className="mt-1 text-muted-foreground">{payload.summary}</p>}
      <ul className="mt-2 grid gap-2">
        {payload.findings.map((finding) => (
          <li key={finding.key} className="rounded-md bg-background px-2 py-1.5 ring-1 ring-border">
            <div className="flex flex-wrap items-center gap-2">
              <p className="font-medium text-foreground">{finding.title}</p>
              <Badge variant="outline">{finding.severity}</Badge>
              {finding.confidence !== '' && <Badge variant="outline">Confidence: {finding.confidence}</Badge>}
              {finding.status !== '' && <Badge variant="secondary">{finding.status}</Badge>}
            </div>
            {finding.location !== '' && <p className="mt-1 break-all font-mono text-[11px] text-muted-foreground">{finding.location}</p>}
            {finding.description !== '' && <p className="mt-1 text-muted-foreground">{finding.description}</p>}
            {finding.recommendation !== '' && <p className="mt-1 text-muted-foreground">Fix: {finding.recommendation}</p>}
          </li>
        ))}
      </ul>
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
          {run.status === 'running' && <LoaderCircleIcon className="size-3.5 animate-spin text-sky-600" aria-hidden="true" />}
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
            <div className="rounded-lg border border-sky-200 bg-sky-50/70 px-3 py-2 dark:border-sky-900/50 dark:bg-sky-950/20">
              <ExecutionIndicator label="Runtime is working; waiting for output" />
              <p className="mt-1 text-xs text-muted-foreground">
                Some ACP runtimes stay quiet until a turn completes.
              </p>
            </div>
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
    <div className="min-w-0 rounded-lg border border-border p-4">
      <p className="mb-2 text-xs font-medium text-muted-foreground uppercase tracking-wide">{typeLabel}</p>
      <div className={`min-w-0 ${isLongArtifact && !expanded ? 'max-h-80 overflow-hidden' : 'max-h-[70vh] overflow-y-auto'}`}>
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
  commandAudits,
  filesystemAudits,
  fallbackAgents,
  onGateDecided,
  taskId,
  taskStatus,
  artifacts,
  runs,
}: {
  workPackages: WorkPackage[]
  approvalGates: ApprovalGate[]
  vcsChanges: VcsChange[]
  commandAudits: CommandAudit[]
  filesystemAudits: FilesystemAudit[]
  fallbackAgents: PlannedAgent[]
  onGateDecided: () => Promise<void>
  taskId: string
  taskStatus: string | null
  artifacts: Artifact[]
  runs: AgentRun[]
}) {
  const hasPersistedPlan = workPackages.length > 0 || approvalGates.length > 0
  const hasFallback = fallbackAgents.length > 0
  if (!hasPersistedPlan && !hasFallback && vcsChanges.length === 0) return null

  const fallbackTasks = fallbackAgents.reduce((sum, agent) => sum + agent.tasks, 0)
  const persistedTaskCount = workPackages.reduce((sum, pkg) => (
    sum + Math.max(1, Math.trunc(metadataNumberField(pkg, ['plannedTasks', 'taskCount', 'tasks']) ?? stringArrayField(pkg, ['steps']).length))
  ), 0)
  const executionSummary = workforceExecutionSummary({ artifacts, runs, workPackages })

  return (
    <section aria-labelledby="workforce-heading" className="min-w-0 rounded-lg border border-border p-4 overflow-x-hidden">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h2 id="workforce-heading" className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
          Workforce
        </h2>
        <span className="inline-flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
          <UsersIcon className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="min-w-0 break-words">
            {hasPersistedPlan
              ? `${pluralize(workPackages.length, 'package')} · ${pluralize(persistedTaskCount, 'task')} · ${pluralize(approvalGates.length, 'approval checkpoint')}`
              : `${pluralize(fallbackAgents.length, 'agent')} · ${pluralize(fallbackTasks, 'task')}`}
          </span>
        </span>
      </div>

      <div className="mb-3 flex items-start gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
        <ShieldCheckIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
        <div className="min-w-0">
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <p className="font-medium text-foreground">{executionSummary.label}</p>
            <Badge variant="outline" className={statusBadgeClass(executionSummary.status)}>
              {statusLabel(executionSummary.status)}
            </Badge>
          </div>
          <p>{executionSummary.detail}</p>
        </div>
      </div>

      {hasPersistedPlan ? (
        <div className="grid min-w-0 gap-4">
          <div className="min-w-0">
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
                  const pkgMetadata = recordField(pkg, ['metadata'])
                  const mcpGrants = pkgMetadata ? jsonArrayField(pkgMetadata, ['mcpGrants', 'grants']) : []
                  const mcpSubtasks = pkgMetadata ? jsonArrayField(pkgMetadata, ['mcpAwareSubtasks', 'mcpSubtasks']) : []
                  const broker = mcpBrokerMetadata(pkg)
                  const packageArtifacts = packageArtifactsFor(pkg, artifacts)
                  const sandboxOutputs = sandboxOutputsForPackage(pkg, artifacts)
                  const latestPackageArtifact = packageArtifacts[packageArtifacts.length - 1] ?? null
                  const pkgRuns = runsForPackage(pkg, runs)
                  const attemptNumbers = pkgRuns
                    .map(runAttemptNumber)
                    .filter((attempt): attempt is number => attempt !== null)
                  const latestAttempt = attemptNumbers.length > 0 ? Math.max(...attemptNumbers) : pkgRuns.length
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
                  const securityPayload = pendingReviewGate && stringField(pendingReviewGate, ['gateType', 'type']) === 'security_review'
                    ? securityReviewPayloadFromMetadata(recordField(pendingReviewGate, ['metadata']), reviewArtifact?.metadata ?? null)
                    : null
                  const pendingGateType = pendingReviewGate ? stringField(pendingReviewGate, ['gateType', 'type']) : ''
                  const reviewDecisionSuggestion = reviewDecisionSuggestionFromArtifact({
                    gateType: pendingGateType,
                    securityPayload,
                    sourceArtifact: reviewArtifact,
                  })
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
                        {status === 'running' && <LoaderCircleIcon className="size-3.5 animate-spin text-sky-600" aria-hidden="true" />}
                        {status !== '' && statusBadge(status)}
                        <Badge variant="outline">{pluralize(taskCount, 'task')}</Badge>
                        {latestAttempt > 0 && <Badge variant="outline">attempt {latestAttempt}</Badge>}
                      </div>
                      {status === 'running' && (
                        <div className="mt-2">
                          <ExecutionIndicator label="Work package is executing" />
                        </div>
                      )}
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
                      <SandboxOutputList outputs={sandboxOutputs} />
                      {status === 'needs_rework' && (
                        <div className="mt-3 rounded-md border border-amber-200 bg-amber-50/70 px-3 py-2 text-xs text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/20 dark:text-amber-200">
                          <p className="font-medium">Rework requested</p>
                          <p className="mt-1">
                            The next worker pass should create a fresh package attempt. Previous sandbox output remains visible for review history.
                          </p>
                        </div>
                      )}
                      {status === 'awaiting_review' && (
                        <div className="mt-3 min-w-0 rounded-lg border border-amber-200 bg-amber-50/70 p-3 dark:border-amber-900/50 dark:bg-amber-950/20">
                          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                            <p className="text-sm font-medium text-foreground">Package review</p>
                            {pendingReviewGate
                              ? statusBadge(stringField(pendingReviewGate, ['status', 'state']) || 'pending')
                              : <Badge variant="outline">No pending gate</Badge>}
                          </div>
                          {reviewArtifact ? (
                            <div className="min-w-0 max-h-[32rem] overflow-auto rounded-md bg-background/80 p-2 ring-1 ring-border">
                              <ArtifactView artifact={reviewArtifact} />
                            </div>
                          ) : (
                            <p className="rounded-md border border-dashed border-border bg-background/70 px-3 py-2 text-sm text-muted-foreground">
                              {pendingReviewGate
                                ? 'The review gate source artifact is not available in this view.'
                                : 'No package output has been attached yet.'}
                            </p>
                          )}
                          <SecurityFindingsPanel payload={securityPayload} />
                          {pendingReviewGate && reviewArtifact ? (
                            <GateDecisionControls
                              gateType={pendingGateType}
                              gateId={stringField(pendingReviewGate, ['id'])}
                              requiresHumanTradeoff={reviewDecisionSuggestion.requiresHumanTradeoff}
                              sourceArtifactId={reviewArtifact.id}
                              suggestedReason={reviewDecisionSuggestion.reason}
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
                              Review actions appear when a pending QA, Reviewer, or Security gate exists for this package.
                            </p>
                          )}
                        </div>
                      )}
                      {status === 'blocked' && (
                        <>
                          <BrokerRetrySummary broker={broker} />
                          <RetryHandoffControls
                            blockedReason={stringField(pkg, ['blockedReason'])}
                            taskId={taskId}
                            onRetried={onGateDecided}
                          />
                        </>
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
                          {harnessName !== '' && (
                            <div>
                              <p className="font-medium text-muted-foreground">Planning harness</p>
                              <p className="mt-1 text-muted-foreground">
                                {harnessName} identifies the planned role and package prompt context. It does not imply live tool grants.
                              </p>
                            </div>
                          )}
                          <div>
                            <p className="font-medium text-muted-foreground">Effective run instructions</p>
                            {prompt !== '' ? (
                              <div className="mt-1 max-h-56 overflow-auto rounded-md bg-background p-2 ring-1 ring-border">
                                <MarkdownView content={prompt} compact />
                              </div>
                            ) : (
                              <p className="mt-1 text-muted-foreground">
                                No additional run-scoped prompt overlay persisted for this package.
                              </p>
                            )}
                            <p className="mt-1 text-muted-foreground">
                              Run instructions are scoped to this package attempt and do not change the permanent harness prompt.
                            </p>
                          </div>
                          <div>
                            <p className="font-medium text-muted-foreground">Assignment brief</p>
                            <div className="mt-1 max-h-72 overflow-auto rounded-md bg-background p-2 ring-1 ring-border">
                              <MarkdownView content={workPackageBrief(pkg)} compact />
                            </div>
                          </div>
                          {mcpRequirements.length > 0 && (
                            <div>
                              <p className="font-medium text-muted-foreground">MCP requirements</p>
                              <div className="mt-2">
                                <McpRequirementCards requirements={mcpRequirements} />
                              </div>
                            </div>
                          )}
                          <FilesystemGrantControls
                            onUpdated={onGateDecided}
                            pkg={pkg}
                            taskId={taskId}
                            taskStatus={taskStatus}
                          />
                          <McpGrantCards grants={mcpGrants} />
                          <McpSubtaskCards subtasks={mcpSubtasks} />
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

          <div className="min-w-0">
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
                  const sourceArtifactId = stringField(gate, ['sourceArtifactId']) || metadataStringField(gate, ['sourceArtifactId'])
                  const sourceArtifact = sourceArtifactId !== ''
                    ? artifacts.find((artifact) => artifact.id === sourceArtifactId) ?? null
                    : null
                  const decisionReason = metadataStringField(gate, ['decisionReason'])
                  const decidedAt = stringField(gate, ['decidedAt'])
                  const approvedGrantPackages = approvedGrantPackagesFromGate(gate)
                  const securityPayload = gateType === 'security_review'
                    ? securityReviewPayloadFromMetadata(recordField(gate, ['metadata']), sourceArtifact?.metadata ?? null)
                    : null

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
                      {sourceArtifactId !== '' && (
                        <p className="mt-1 break-all font-mono text-xs text-muted-foreground">Artifact {sourceArtifactId}</p>
                      )}
                      {summary !== '' && <p className="mt-1 text-sm text-muted-foreground">{summary}</p>}
                      <ApprovedGrantSnapshot packages={approvedGrantPackages} />
                      <SecurityFindingsPanel payload={securityPayload} />
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
            <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Repository readiness evidence</h3>
          </div>
          <p className="mb-2 text-xs text-muted-foreground">
            Host repository evidence is a readiness/status check for sandbox execution. It is not branch, commit, or pull request output from this beta flow.
          </p>
          <ul className="flex flex-col gap-2" aria-label="Repository readiness evidence">
            {vcsChanges.map((change, index) => {
              const status = stringField(change, ['status', 'state'])
              const type = stringField(change, ['changeType', 'type', 'operation'])
              const summary = stringField(change, ['summary', 'description', 'diffSummary'])
              const metadata = recordField(change, ['metadata'])
              const evidenceStatus = metadata ? stringField(metadata, ['evidenceStatus', 'status']) : ''
              const repositoryPath = stringField(change, ['repository']) || (metadata ? stringField(metadata, ['projectLocalPath']) : '') || `Evidence ${index + 1}`
              const currentBranch = stringField(change, ['currentBranch']) || (metadata ? stringField(metadata, ['currentBranch']) : '')
              const baseBranch = stringField(change, ['baseBranch']) || (metadata ? stringField(metadata, ['baseBranch']) : '')
              const intendedBranch = stringField(change, ['branchName']) || (metadata ? stringField(metadata, ['intendedTaskBranch']) : '')
              const validationStatus = metadata ? stringField(metadata, ['validationStatus']) : ''
              const blockedReason = metadata ? stringField(metadata, ['blockedReason']) : ''
              const dirty = metadata ? booleanField(metadata, ['isDirty']) : null
              const hasRemote = metadata ? booleanField(metadata, ['hasRemote']) : null
              const collision = metadata ? booleanField(metadata, ['branchCollision']) : null

              return (
                <li key={recordKey(change, 'vcs-change', index)} className="rounded-md border border-border bg-muted/20 px-2.5 py-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="break-all font-mono text-xs text-foreground">{repositoryPath}</span>
                    {type !== '' && <Badge variant="outline">{type}</Badge>}
                    {status !== '' && statusBadge(status)}
                    {evidenceStatus !== '' && evidenceStatus !== status && statusBadge(evidenceStatus)}
                  </div>
                  <dl className="mt-2 grid gap-x-3 gap-y-1 text-xs text-muted-foreground sm:grid-cols-2 lg:grid-cols-3">
                    {currentBranch !== '' && (
                      <div><dt className="font-medium text-foreground">Current</dt><dd className="break-all font-mono">{currentBranch}</dd></div>
                    )}
                    {baseBranch !== '' && (
                      <div><dt className="font-medium text-foreground">Base</dt><dd className="break-all font-mono">{baseBranch}</dd></div>
                    )}
                    {intendedBranch !== '' && (
                      <div><dt className="font-medium text-foreground">Intended branch check</dt><dd className="break-all font-mono">{intendedBranch}</dd></div>
                    )}
                    {dirty !== null && (
                      <div><dt className="font-medium text-foreground">Working tree</dt><dd>{dirty ? 'Dirty' : 'Clean'}</dd></div>
                    )}
                    {hasRemote !== null && (
                      <div><dt className="font-medium text-foreground">Remote</dt><dd>{hasRemote ? 'Configured' : 'Missing'}</dd></div>
                    )}
                    {collision !== null && (
                      <div><dt className="font-medium text-foreground">Branch collision</dt><dd>{collision ? 'Yes' : 'No'}</dd></div>
                    )}
                    {validationStatus !== '' && (
                      <div><dt className="font-medium text-foreground">Validation</dt><dd>{statusLabel(validationStatus)}</dd></div>
                    )}
                  </dl>
                  {blockedReason !== '' && (
                    <p className="mt-2 rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1 text-xs text-destructive">
                      {blockedReason}
                    </p>
                  )}
                  {summary !== '' && <p className="mt-1 text-xs text-muted-foreground">{summary}</p>}
                </li>
              )
            })}
          </ul>
          {commandAudits.length > 0 && (
            <details className="mt-3 rounded-md border border-border bg-muted/20 px-3 py-2">
              <summary className="cursor-pointer text-xs font-medium text-foreground">
                Readiness command audit
              </summary>
              <ul className="mt-2 grid gap-2" aria-label="Repository readiness command audits">
                {commandAudits.map((audit, index) => {
                  const command = stringField(audit, ['command'])
                  const argv = stringArrayField(audit, ['argv'])
                  const riskClass = stringField(audit, ['riskClass'])
                  const exitCode = numberField(audit, ['exitCode'])
                  const output = stringField(audit, ['outputSummary'])
                  const artifactId = stringField(audit, ['artifactId'])
                  return (
                    <li key={recordKey(audit, 'command-audit', index)} className="rounded-md bg-background px-2 py-1.5 ring-1 ring-border">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="break-all font-mono text-xs text-foreground">
                          {[command, ...argv].filter(Boolean).join(' ')}
                        </span>
                        {riskClass !== '' && <Badge variant="outline">{riskClass.replace(/_/g, ' ')}</Badge>}
                        {exitCode !== null && (
                          <Badge variant="outline" className={exitCode === 0 ? statusBadgeClass('completed') : statusBadgeClass('failed')}>
                            exit {exitCode}
                          </Badge>
                        )}
                      </div>
                      {artifactId !== '' && <p className="mt-1 break-all font-mono text-[11px] text-muted-foreground">Artifact {artifactId}</p>}
                      {output !== '' && <p className="mt-1 whitespace-pre-wrap break-words text-xs text-muted-foreground">{output}</p>}
                    </li>
                  )
                })}
              </ul>
            </details>
          )}
          {filesystemAudits.length > 0 && (
            <details className="mt-3 rounded-md border border-border bg-muted/20 px-3 py-2">
              <summary className="cursor-pointer text-xs font-medium text-foreground">
                Filesystem MCP audit
              </summary>
              <ul className="mt-2 grid gap-2" aria-label="Filesystem MCP runtime audits">
                {filesystemAudits.map((audit, index) => {
                  const status = stringField(audit, ['status'])
                  const operation = stringField(audit, ['operation'])
                  const packageId = stringField(audit, ['workPackageId'])
                  const capabilities = stringArrayField(audit, ['capabilities'])
                  const requested = stringArrayField(audit, ['requestedCapabilities'])
                  const fileCount = numberField(audit, ['fileCount'])
                  const byteCount = numberField(audit, ['byteCount'])
                  const omittedCount = numberField(audit, ['omittedCount'])
                  const reason = stringField(audit, ['reason'])
                  const root = stringField(audit, ['root'])
                  return (
                    <li key={recordKey(audit, 'filesystem-audit', index)} className="rounded-md bg-background px-2 py-1.5 ring-1 ring-border">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-xs text-foreground">{operation || 'context_packet'}</span>
                        {status !== '' && <Badge variant="outline" className={statusBadgeClass(status)}>{statusLabel(status)}</Badge>}
                        {fileCount !== null && <Badge variant="outline">{pluralize(fileCount, 'file')}</Badge>}
                        {byteCount !== null && <Badge variant="outline">{byteCount} bytes</Badge>}
                        {omittedCount !== null && omittedCount > 0 && <Badge variant="outline">{omittedCount} omitted</Badge>}
                      </div>
                      {packageId !== '' && <p className="mt-1 break-all font-mono text-[11px] text-muted-foreground">Package {packageId}</p>}
                      {capabilities.length > 0 && <p className="mt-1 break-words font-mono text-[11px] text-muted-foreground">Approved: {capabilities.join(', ')}</p>}
                      {requested.length > 0 && <p className="mt-1 break-words font-mono text-[11px] text-muted-foreground">Requested: {requested.join(', ')}</p>}
                      {root !== '' && <p className="mt-1 break-all font-mono text-[11px] text-muted-foreground">Root {root}</p>}
                      {reason !== '' && <p className="mt-1 whitespace-pre-wrap break-words text-xs text-muted-foreground">{reason}</p>}
                    </li>
                  )
                })}
              </ul>
            </details>
          )}
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
          Architect-selected agents and resources
        </h2>
        <span className="flex items-center gap-1.5">
          <span
            aria-label="This panel summarizes which agents and resources the architect selected for the plan."
            title="This panel summarizes which agents and resources the architect selected for the plan."
          >
            <InfoIcon className="size-3.5 text-muted-foreground" aria-hidden="true" />
          </span>
          <Badge variant="outline" className={statusBadgeClass(effectiveStatus)}>{statusLabelText}</Badge>
        </span>
      </div>

      <p className="mb-3 text-xs text-muted-foreground">
        Planning view only. These are the architect&apos;s selected agent/resource needs for routing the work.
      </p>

      {validation.warnings.length > 0 && !missingClassificationOnly && (
        <div className="mb-3 rounded-lg border border-amber-300/40 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-700/40 dark:bg-amber-950/30 dark:text-amber-200">
          <p className="font-medium">Warnings</p>
          <ul className="mt-1 list-disc pl-4">
            {validation.warnings.map((item, index) => (
              <li key={duplicateSafeKey('capability-warning', item, index)}>{item}</li>
            ))}
          </ul>
        </div>
      )}

      {total === 0 ? (
        <p className="text-sm text-muted-foreground">
          {missingClassificationOnly
            ? 'No structured agent/resource list was provided. Use the implementation plan and visible assignments.'
            : 'No agent/resource needs were listed for this plan.'}
        </p>
      ) : (
        <dl className="grid gap-3 text-sm">
          <div>
            <dt className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">Required by architect</dt>
            <dd className="flex flex-wrap gap-1.5">
              {proposed.required.length > 0
                ? proposed.required.map((capability, index) => (
                    <Badge key={duplicateSafeKey('required-capability', capability, index)} variant="default">{capability}</Badge>
                  ))
                : <span className="text-muted-foreground">None</span>}
            </dd>
          </div>
          {(proposed.optional.length > 0 || proposed.excluded.length > 0) && (
            <div>
              <dt className="sr-only">Recommended additions and exclusions</dt>
              <dd>
                <details className="rounded-md border border-border bg-muted/20 px-3 py-2">
                  <summary className="cursor-pointer text-xs font-medium text-foreground">
                    Recommended additional capabilities
                  </summary>
                  <div className="mt-3 grid gap-3">
                    <div>
                      <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                        Could be created or added later
                      </p>
                      <div className="flex flex-wrap gap-1.5">
                        {proposed.optional.length > 0
                          ? proposed.optional.map((capability, index) => (
                              <Badge key={duplicateSafeKey('optional-capability', capability, index)} variant="outline">{capability}</Badge>
                            ))
                          : <span className="text-muted-foreground">None</span>}
                      </div>
                    </div>
                    {proposed.excluded.length > 0 && (
                      <div>
                        <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                          Not selected for this plan
                        </p>
                        <ul className="grid gap-2">
                          {proposed.excluded.map((item, index) => (
                            <li key={duplicateSafeKey('excluded-capability', item.capability, index)}>
                              <Badge variant="secondary">{item.capability}</Badge>
                              <p className="mt-1 text-xs text-muted-foreground">{item.reason}</p>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                </details>
              </dd>
            </div>
          )}
        </dl>
      )}
    </section>
  )
}

function initialMcpReviewItems(
  design: McpExecutionDesignMetadata | null,
  existing: ReturnType<typeof latestMcpPlanReviewForDisplay>,
): McpPlanReviewDisplayItem[] {
  if (existing && existing.items.length > 0) {
    return existing.items.map((item) => ({
      ...item,
      assignment: { ...item.assignment, targetAgents: [...item.assignment.targetAgents] },
      agentPermissions: Object.fromEntries(Object.entries(item.agentPermissions).map(([agent, capabilities]) => [agent, [...capabilities]])),
      promptOverlays: { ...item.promptOverlays },
    }))
  }
  const proposed = design?.proposed
  if (!proposed) return []
  return proposed.requirements.map((requirement, index) => {
    const key = mcpRequirementDisplayKey(requirement, index)
    const promptOverlays = Object.fromEntries(proposed.requirementContexts
      .filter((context) => context.requirementKey === key)
      .map((context) => [context.agent, context.promptOverlay]))
    return {
      requirementKey: key,
      decision: 'approved',
      assignment: { ...requirement.assignment, targetAgents: [...requirement.assignment.targetAgents] },
      agentPermissions: Object.fromEntries(Object.entries(requirement.agentPermissions).map(([agent, capabilities]) => [agent, [...capabilities]])),
      promptOverlays,
    }
  })
}

function McpAccessPlanPanel({
  approvalGate,
  design,
  onSaved,
  status,
  workPackages,
}: {
  approvalGate: ApprovalGate | null
  design: McpExecutionDesignMetadata | null
  onSaved: () => Promise<void>
  status: string
  workPackages: WorkPackage[]
}) {
  const proposed = design?.proposed
  const requirements = proposed?.requirements ?? []
  const overlayCount = mcpPlanOverlayCount(design)
  const subtaskCount = proposed?.mcpAwareSubtasks.length ?? 0
  const grantPreview = design?.grantDecisions
  const existingReview = useMemo(() => latestMcpPlanReviewForDisplay(approvalGate), [approvalGate])
  const [draftItems, setDraftItems] = useState<McpPlanReviewDisplayItem[]>(() => initialMcpReviewItems(design, existingReview))
  const [reviewSaving, setReviewSaving] = useState(false)
  const [reviewError, setReviewError] = useState<string | null>(null)
  const sourceArtifactId = approvalGate ? stringField(approvalGate, ['sourceArtifactId']) : ''
  const packageAgents = [...new Set(workPackages.map((pkg) => stringField(pkg, ['assignedRole'])).filter(Boolean))].sort()
  const reviewEnabled = status === 'awaiting_approval' && sourceArtifactId !== '' && requirements.length > 0

  useEffect(() => {
    setDraftItems(initialMcpReviewItems(design, existingReview))
  }, [design, existingReview])

  const updateDraft = (index: number, update: (item: McpPlanReviewDisplayItem) => McpPlanReviewDisplayItem) => {
    setDraftItems((items) => items.map((item, itemIndex) => itemIndex === index ? update(item) : item))
  }

  const saveReview = async () => {
    setReviewSaving(true)
    setReviewError(null)
    try {
      const response = await fetch(`/api/tasks/${stringField(approvalGate ?? {}, ['taskId'])}/mcp-plan-review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourceArtifactId,
          baseRevision: existingReview?.revision ?? 0,
          baseDigest: existingReview?.digest ?? null,
          items: draftItems,
        }),
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : 'Failed to save MCP access review.')
      await onSaved()
    } catch (error) {
      setReviewError(error instanceof Error ? error.message : 'Failed to save MCP access review.')
    } finally {
      setReviewSaving(false)
    }
  }
  if (!design) return null
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
          MCP access is beta-planned only. Forge records proposed requirements and brokered decisions, but no live MCP tool handles are issued to package runs; approved inputs become run-scoped prompt instructions.
        </p>
      </div>

      {existingReview && (
        <div className="mb-3 rounded-lg border border-border px-3 py-2 text-xs text-muted-foreground">
          <p className="font-medium text-foreground">Operator review revision {existingReview.revision}</p>
          <p className="mt-1 break-all font-mono text-[11px]">{existingReview.digest}</p>
          {existingReview.blockers.length > 0 && (
            <ul role="alert" className="mt-2 list-disc pl-4 text-destructive">
              {existingReview.blockers.map((blocker, index) => <li key={duplicateSafeKey('mcp-review-blocker', blocker, index)}>{blocker}</li>)}
            </ul>
          )}
        </div>
      )}

      {design.validation.blocked.length > 0 && (
        <div role="alert" className="mb-3 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <p className="font-medium">Blocked recommendations</p>
          <ul className="mt-1 list-disc pl-4">
            {design.validation.blocked.map((item, index) => (
              <li key={duplicateSafeKey('mcp-blocked', item, index)}>{item}</li>
            ))}
          </ul>
        </div>
      )}

      {design.validation.warnings.length > 0 && !missingDesignOnly && (
        <div className="mb-3 rounded-lg border border-amber-300/40 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-700/40 dark:bg-amber-950/30 dark:text-amber-200">
          <p className="font-medium">Warnings</p>
          <ul className="mt-1 list-disc pl-4">
            {design.validation.warnings.map((item, index) => (
              <li key={duplicateSafeKey('mcp-warning', item, index)}>{item}</li>
            ))}
          </ul>
        </div>
      )}

      {grantPreview && grantPreview.decisions.length > 0 && (
        <div className="mb-3 rounded-lg border border-border px-3 py-2">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Brokered grant preview</p>
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
                  : 'Plan-approved for prompt context only. Forge does not attach live MCP tools in beta.'

              return (
                <li key={decision.decisionId} className="rounded-md border border-border bg-muted/20 px-2.5 py-2">
                  <div className="mb-1 flex flex-wrap items-center gap-2">
                    <Badge variant="outline" className={statusBadgeClass(decision.status)}>{decision.status}</Badge>
                    <span className="font-medium text-foreground">{decision.agent}</span>
                    <span className="text-muted-foreground">{decision.mcpId}</span>
                  </div>
                  <p className="text-muted-foreground">{statusText}</p>
                  {decision.capabilities.length > 0 && (
                    <p className="mt-1 break-words text-muted-foreground">
                      Proposed capabilities: {decision.capabilities.join(', ')}
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
            const draft = draftItems[index]
            const selectedAgents = draft?.assignment.type === 'architect_only'
              ? ['architect']
              : draft?.assignment.type === 'reviewer_only'
                ? ['reviewer']
                : draft?.assignment.targetAgents ?? []
            return (
              <li key={`${requirement.mcpId}-${requirement.assignment.type}-${index}`} className="border-t border-border pt-3 first:border-t-0 first:pt-0">
                <div className="mb-1 flex flex-wrap items-center gap-2">
                  <p className="text-sm font-medium text-foreground">{requirement.mcpId}</p>
                  <Badge variant={requirement.requirement === 'required' ? 'outline' : 'secondary'}>
                    {requirement.requirement}
                  </Badge>
                  <Badge variant="outline">Confidence: {requirement.confidence}</Badge>
                  <Badge variant="secondary">Project scope · planning instruction</Badge>
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
                      <dt className="font-medium text-foreground">Proposed capabilities</dt>
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
                {reviewEnabled && draft && (
                  <div className="mt-3 grid gap-3 rounded-md border border-border bg-muted/20 p-3 text-xs">
                    <div className="flex flex-wrap gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant={draft.decision === 'approved' ? 'default' : 'outline'}
                        onClick={() => updateDraft(index, (item) => ({ ...item, decision: 'approved' }))}
                      >Approve requirement</Button>
                      <Button
                        type="button"
                        size="sm"
                        variant={draft.decision === 'denied' ? 'destructive' : 'outline'}
                        onClick={() => updateDraft(index, (item) => ({ ...item, decision: 'denied' }))}
                      >Deny requirement</Button>
                    </div>
                    {draft.decision === 'approved' && (
                      <>
                        <label className="grid gap-1 font-medium text-foreground">
                          Assignment
                          <select
                            className="h-9 rounded-md border border-input bg-background px-2 font-normal"
                            value={draft.assignment.type}
                            onChange={(event) => updateDraft(index, (item) => {
                              const type = event.target.value
                              const targets = type === 'architect_only'
                                ? ['architect']
                                : type === 'reviewer_only'
                                  ? ['reviewer']
                                  : item.assignment.targetAgents.filter((agent) => packageAgents.includes(agent))
                              const fallbackTargets = targets.length > 0 ? targets : packageAgents.slice(0, type === 'multiple_agents' ? 2 : 1)
                              return {
                                ...item,
                                assignment: { ...item.assignment, type, targetAgents: fallbackTargets },
                                agentPermissions: Object.fromEntries(fallbackTargets.map((agent) => [agent, item.agentPermissions[agent] ?? []])),
                                promptOverlays: Object.fromEntries(fallbackTargets.flatMap((agent) => item.promptOverlays[agent] ? [[agent, item.promptOverlays[agent]]] : [])),
                              }
                            })}
                          >
                            <option value="agent">Single agent</option>
                            <option value="multiple_agents">Multiple agents</option>
                            <option value="workforce">Workforce</option>
                            <option value="architect_only">Architect only</option>
                            <option value="reviewer_only">Reviewer only</option>
                          </select>
                        </label>
                        {draft.assignment.type === 'workforce' && (
                          <label className="grid gap-1 font-medium text-foreground">
                            Workforce id
                            <input
                              className="h-9 rounded-md border border-input bg-background px-2 font-normal"
                              value={draft.assignment.targetId ?? ''}
                              onChange={(event) => updateDraft(index, (item) => ({ ...item, assignment: { ...item.assignment, targetId: event.target.value } }))}
                            />
                          </label>
                        )}
                        {!['architect_only', 'reviewer_only'].includes(draft.assignment.type) && (
                          <fieldset className="grid gap-1">
                            <legend className="font-medium text-foreground">Assigned package agents</legend>
                            <div className="flex flex-wrap gap-3">
                              {packageAgents.map((agent) => (
                                <label key={agent} className="flex items-center gap-1.5">
                                  <input
                                    type="checkbox"
                                    checked={selectedAgents.includes(agent)}
                                    onChange={(event) => updateDraft(index, (item) => {
                                      const nextTargets = event.target.checked
                                        ? item.assignment.type === 'agent' ? [agent] : [...new Set([...item.assignment.targetAgents, agent])]
                                        : item.assignment.targetAgents.filter((candidate) => candidate !== agent)
                                      return {
                                        ...item,
                                        assignment: { ...item.assignment, targetAgents: nextTargets },
                                        agentPermissions: Object.fromEntries(nextTargets.map((target) => [target, item.agentPermissions[target] ?? []])),
                                        promptOverlays: Object.fromEntries(nextTargets.flatMap((target) => item.promptOverlays[target] ? [[target, item.promptOverlays[target]]] : [])),
                                      }
                                    })}
                                  />
                                  {agent}
                                </label>
                              ))}
                            </div>
                          </fieldset>
                        )}
                        {selectedAgents.map((agent) => (
                          <fieldset key={agent} className="grid gap-2 rounded-md border border-border bg-background p-2">
                            <legend className="px-1 font-medium text-foreground">{agent}</legend>
                            <div className="flex flex-wrap gap-3">
                              {mcpCapabilityCeilingForAgent(requirement, agent).map((capability) => (
                                <label key={capability} className="flex items-center gap-1.5 font-mono text-[11px]">
                                  <input
                                    type="checkbox"
                                    checked={(draft.agentPermissions[agent] ?? []).includes(capability)}
                                    onChange={(event) => updateDraft(index, (item) => ({
                                      ...item,
                                      agentPermissions: {
                                        ...item.agentPermissions,
                                        [agent]: event.target.checked
                                          ? [...new Set([...(item.agentPermissions[agent] ?? []), capability])].sort()
                                          : (item.agentPermissions[agent] ?? []).filter((candidate) => candidate !== capability),
                                      },
                                    }))}
                                  />
                                  {capability}
                                </label>
                              ))}
                              {mcpCapabilityCeilingForAgent(requirement, agent).length === 0 && (
                                <span className="text-muted-foreground">No Architect-proposed capabilities are available for this assignee.</span>
                              )}
                            </div>
                            <label className="grid gap-1 font-medium text-foreground">
                              Package prompt overlay
                              <textarea
                                className="min-h-20 rounded-md border border-input bg-background px-2 py-1.5 font-normal"
                                maxLength={1000}
                                value={draft.promptOverlays[agent] ?? ''}
                                onChange={(event) => updateDraft(index, (item) => ({ ...item, promptOverlays: { ...item.promptOverlays, [agent]: event.target.value } }))}
                              />
                            </label>
                          </fieldset>
                        ))}
                      </>
                    )}
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}

      {proposed && proposed.requirementContexts.length > 0 && (
        <div className="mt-3 border-t border-border pt-3 text-xs">
          <p className="font-medium text-foreground">Requirement-scoped package context</p>
          <ul className="mt-2 grid gap-2">
            {proposed.requirementContexts.map((context, index) => (
              <li key={duplicateSafeKey('mcp-context', `${context.requirementKey}-${context.agent}`, index)} className="rounded-md border border-border px-2 py-1.5">
                <p className="font-medium text-foreground">{context.agent} · {context.mcpId}</p>
                <p className="mt-1 text-muted-foreground">{context.promptOverlay}</p>
              </li>
            ))}
          </ul>
        </div>
      )}

      {proposed && proposed.mcpAwareSubtasks.length > 0 && (
        <div className="mt-3 border-t border-border pt-3 text-xs">
          <p className="font-medium text-foreground">Full MCP-aware subtask instructions</p>
          <ul className="mt-2 grid gap-2">
            {proposed.mcpAwareSubtasks.map((subtask) => (
              <li key={subtask.id} className="rounded-md border border-border px-2 py-2">
                <p className="font-medium text-foreground">{subtask.id} · {subtask.agent}</p>
                <p className="mt-1 font-mono text-[11px] text-muted-foreground">{subtask.mcpCapabilities.join(', ')}</p>
                <dl className="mt-2 grid gap-1 text-muted-foreground">
                  <div><dt className="font-medium text-foreground">Depends on</dt><dd>{subtask.dependsOn.join(', ') || 'None'}</dd></div>
                  <div><dt className="font-medium text-foreground">Inputs</dt><dd>{subtask.inputs.join(', ') || 'None'}</dd></div>
                  <div><dt className="font-medium text-foreground">Outputs</dt><dd>{subtask.outputs.join(', ') || 'None'}</dd></div>
                  <div><dt className="font-medium text-foreground">Verification</dt><dd>{subtask.verification.join(', ') || 'None'}</dd></div>
                  <div><dt className="font-medium text-foreground">Stopping condition</dt><dd>{subtask.stoppingCondition || 'Not specified'}</dd></div>
                  <div><dt className="font-medium text-foreground">Fallback</dt><dd>{subtask.fallback || 'Not specified'}</dd></div>
                </dl>
              </li>
            ))}
          </ul>
        </div>
      )}

      {reviewEnabled && (
        <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-border pt-3">
          <Button type="button" size="sm" disabled={reviewSaving} onClick={() => void saveReview()}>
            {reviewSaving ? 'Saving review…' : existingReview ? 'Save new review revision' : 'Save MCP access review'}
          </Button>
          <p className="text-xs text-muted-foreground">Saving records a new immutable revision. Task approval admits this reviewed version.</p>
          {reviewError && <p role="alert" className="w-full text-xs text-destructive">{reviewError}</p>}
        </div>
      )}

      {(overlayCount > 0 || subtaskCount > 0) && (
        <dl className="mt-3 grid gap-1 border-t border-border pt-3 text-xs text-muted-foreground">
          <div>
            <dt className="font-medium text-foreground">Run instruction overlays</dt>
            <dd>{overlayCount}</dd>
          </div>
          <div>
            <dt className="font-medium text-foreground">Plan-approved MCP-aware subtasks</dt>
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

function frontMatterText(frontMatter: Record<string, unknown>, key: string): string {
  const value = frontMatter[key]
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : ''
}

function logSequence(log: TaskLog): number {
  return Number.isFinite(log.sequence) ? log.sequence : 0
}

function mergeTaskLogs(existing: TaskLog[], incoming: TaskLog[]): TaskLog[] {
  const byId = new Map(existing.map((log) => [log.id, log]))
  for (const log of incoming) byId.set(log.id, log)
  return [...byId.values()].sort((a, b) => {
    const sequenceDelta = logSequence(a) - logSequence(b)
    if (sequenceDelta !== 0) return sequenceDelta
    return new Date(a.occurredAt).getTime() - new Date(b.occurredAt).getTime()
  })
}

function TypingLogMessage({ active, message }: { active: boolean; message: string }) {
  const [displayed, setDisplayed] = useState(active ? '' : message)

  useEffect(() => {
    if (!active) {
      setDisplayed(message)
      return
    }

    setDisplayed('')
    if (message.length === 0) return

    const step = Math.max(6, Math.ceil(message.length / 18))
    let index = 0
    const timer = window.setInterval(() => {
      index = Math.min(message.length, index + step)
      setDisplayed(message.slice(0, index))
      if (index >= message.length) window.clearInterval(timer)
    }, 18)

    return () => window.clearInterval(timer)
  }, [active, message])

  return (
    <p className="mt-2 whitespace-pre-wrap break-words text-sm text-muted-foreground">
      {displayed}
      {active && displayed.length < message.length && (
        <span aria-hidden="true" className="ml-0.5 inline-block h-4 w-px translate-y-0.5 animate-pulse bg-current" />
      )}
    </p>
  )
}

function TaskLogsPanel({
  error,
  liveLogIds,
  loading,
  logs,
  taskId,
}: {
  error: string | null
  liveLogIds: Set<string>
  loading: boolean
  logs: TaskLog[]
  taskId: string
}) {
  const exportBase = `/api/tasks/${taskId}/logs/export`
  const listRef = useRef<HTMLOListElement | null>(null)

  useEffect(() => {
    if (liveLogIds.size === 0) return
    const list = listRef.current
    if (!list) return
    list.scrollTo({ top: list.scrollHeight, behavior: 'smooth' })
  }, [liveLogIds, logs.length])

  return (
    <section aria-labelledby="task-logs-heading" className="mb-6">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h2 id="task-logs-heading" className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
          Task logs
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex h-7 items-center gap-1.5 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2 text-[0.75rem] font-medium text-emerald-700 dark:text-emerald-300">
            <span className="relative flex size-2">
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-50" />
              <span className="relative inline-flex size-2 rounded-full bg-emerald-500" />
            </span>
            Live
          </span>
          <a
            href={`${exportBase}?format=markdown`}
            className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-background px-2.5 text-[0.8rem] font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <DownloadIcon className="size-3.5" aria-hidden="true" />
            Markdown
          </a>
          <a
            href={`${exportBase}?format=jsonl`}
            className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-background px-2.5 text-[0.8rem] font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <DownloadIcon className="size-3.5" aria-hidden="true" />
            JSONL
          </a>
        </div>
      </div>

      {loading ? (
        <div className="rounded-lg border border-dashed border-border px-4 py-6 text-center">
          <span className="text-sm text-muted-foreground">Loading logs...</span>
        </div>
      ) : error !== null ? (
        <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      ) : logs.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border px-4 py-6 text-center">
          <p className="text-sm text-muted-foreground">No task logs recorded yet.</p>
        </div>
      ) : (
        <ol ref={listRef} className="max-h-[32rem] overflow-auto rounded-lg border border-border" aria-label="Task log entries" aria-live="polite">
          {logs.map((log) => {
            const model = frontMatterText(log.frontMatter, 'model')
            const connector = frontMatterText(log.frontMatter, 'connector')
            const live = liveLogIds.has(log.id)
            return (
              <li
                key={log.id}
                className={[
                  'border-b border-border px-4 py-3 transition-colors duration-300 last:border-0',
                  live ? 'bg-emerald-500/5' : '',
                ].filter(Boolean).join(' ')}
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <Badge variant="outline" className={statusBadgeClass(log.level)}>{statusLabel(log.level)}</Badge>
                    <span className="font-medium text-foreground">{log.title}</span>
                    <span className="font-mono text-[11px] text-muted-foreground">{log.eventType}</span>
                  </div>
                  <span className="shrink-0 text-xs text-muted-foreground">{formatDatetime(log.occurredAt)}</span>
                </div>
                <TypingLogMessage active={live} message={log.message} />
                {(model !== '' || connector !== '') && (
                  <dl className="mt-2 grid gap-x-4 gap-y-1 text-xs text-muted-foreground sm:grid-cols-2">
                    {model !== '' && <div><dt className="font-medium text-foreground">Model</dt><dd className="break-all font-mono">{model}</dd></div>}
                    {connector !== '' && <div><dt className="font-medium text-foreground">Connector</dt><dd className="break-all font-mono">{connector}</dd></div>}
                  </dl>
                )}
              </li>
            )
          })}
        </ol>
      )}
    </section>
  )
}

function runStage(run: AgentRun): string {
  const stage = (run as unknown as WorkforceRecord).stage
  return typeof stage === 'string' && stage.trim() !== '' ? stage.trim() : ''
}

function hasExecutionDisabledEvidence(runs: AgentRun[], artifacts: Artifact[]): boolean {
  const latestHandoff = [...runs].reverse().find((run) => run.agentType === 'handoff')
  if (latestHandoff) return latestHandoff.modelIdUsed === 'forge-handoff/no-op'

  return [...artifacts].reverse().some(artifactShowsDisabledHandoff)
}

export function taskProgressSummary(input: {
  status: string
  workPackages: WorkPackage[]
  approvalGates: ApprovalGate[]
  runs: AgentRun[]
  questions: TaskQuestion[]
  artifacts: Artifact[]
}): { stage: string; nextAction: string; detail: string } {
  const openQuestions = input.questions.filter((question) => question.status !== 'answered').length
  const runningPackage = input.workPackages.find((pkg) => stringField(pkg, ['status', 'state']) === 'running')
  const blockedPackage = input.workPackages.find((pkg) => stringField(pkg, ['status', 'state']) === 'blocked')
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

  if (blockedPackage) {
    const title = stringField(blockedPackage, ['title', 'name']) || 'work package'
    const reason = stringField(blockedPackage, ['blockedReason'])
    return {
      stage: `Blocked: ${title}`,
      nextAction: 'Resolve the block, then queue handoff recovery from the blocked package.',
      detail: reason || 'A package is blocked before execution can continue.',
    }
  }

  if (awaitingReviewPackage) {
    return {
      stage: `Review: ${stringField(awaitingReviewPackage, ['title', 'name']) || 'work package'}`,
      nextAction: 'Review package output, then approve, request changes, or reject it.',
      detail: executionDisabled
        ? 'Execution is disabled; this review covers handoff output and no repository files were changed.'
        : 'Review gates cover generated output, host-write metadata, and validation evidence.',
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
        ? 'Execution is disabled; Forge is creating reviewable handoff output without sandbox files or host repository writes.'
        : 'A specialist package is running. Forge will keep sandbox artifacts and apply successful local repository edits when enabled.',
    }
  }

  if (readyPackage) {
    return {
      stage: `Ready: ${stringField(readyPackage, ['title', 'name']) || 'work package'}`,
      nextAction: 'Worker handoff is ready for the next package.',
      detail: 'Dependencies are satisfied. The worker can run this package unless execution is explicitly disabled.',
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
    return { stage: 'Completed', nextAction: 'Review artifacts and generated output.', detail: 'All required gates are complete.' }
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
  const runningPackage = workPackages.find((pkg) => stringField(pkg, ['status', 'state']) === 'running')
  const runningRun = [...runs].reverse().find((run) => run.status === 'running')
  const executionActive = isActiveExecutionStatus(status) || runningPackage !== undefined || runningRun !== undefined
  const executionLabel = runningPackage
    ? `Running ${stringField(runningPackage, ['title', 'name']) || 'work package'}`
    : runningRun
      ? `Running ${statusLabel(runningRun.agentType)}`
      : status === 'approved'
        ? 'Handoff in progress'
        : 'Execution in progress'

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
          {executionActive && (
            <div className="mt-2">
              <ExecutionIndicator label={executionLabel} />
            </div>
          )}
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
  const [commandAudits, setCommandAudits] = useState<CommandAudit[]>([])
  const [filesystemAudits, setFilesystemAudits] = useState<FilesystemAudit[]>([])
  const [taskLogs, setTaskLogs] = useState<TaskLog[]>([])
  const [liveLogIds, setLiveLogIds] = useState<Set<string>>(new Set())
  const [projectFilesystemGrant, setProjectFilesystemGrant] = useState<ProjectFilesystemGrantState | null>(null)
  const [providers, setProviders] = useState<ProviderConfig[]>([])
  const [loading, setLoading] = useState(true)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [logsLoading, setLogsLoading] = useState(true)
  const [logsError, setLogsError] = useState<string | null>(null)

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
  const [optimisticTaskStatus, setOptimisticTaskStatus] = useState<string | null>(null)
  const [retryCardCollapsing, setRetryCardCollapsing] = useState(false)
  const [retrySubmitted, setRetrySubmitted] = useState(false)
  const liveLogTimersRef = useRef<Map<string, number>>(new Map())
  const lastLogSequenceRef = useRef(0)

  // SSE stream
  const {
    runs: streamRuns,
    artifacts: streamArtifacts,
    taskStatus,
    error: streamError,
    questions: streamQuestions,
    refreshRevision: streamRefreshRevision,
    taskLogRevision,
  } = useTaskStream(taskId)

  // Merge initial data with live stream data
  const mergedRuns: AgentRun[] = mergeTaskRuns(initialRuns, streamRuns)
  const mergedArtifacts: Artifact[] = mergeArtifacts(initialArtifacts, streamArtifacts)
  // streamQuestions is null until the SSE layer has reported a definitive
  // question set (even an empty one); only fall back to the once-fetched
  // initialQuestions while that hasn't happened yet, so an explicitly-empty
  // stream result isn't overridden by stale data from a prior plan round.
  const mergedQuestions: TaskQuestion[] = streamQuestions ?? initialQuestions
  const currentStatus = optimisticTaskStatus ?? taskStatus ?? task?.status ?? null

  const loadProjectFilesystemGrant = useCallback(async (projectId: string | null | undefined) => {
    const normalizedProjectId = typeof projectId === 'string' ? projectId.trim() : ''
    if (normalizedProjectId === '') {
      setProjectFilesystemGrant(null)
      return
    }

    try {
      const res = await fetch(`/api/projects/${normalizedProjectId}/filesystem-grant`)
      const body = await res.json().catch(() => ({}))
      if (!res.ok || !isRecord(body.grant)) {
        throw new Error('Failed to load project filesystem grant')
      }
      setProjectFilesystemGrant({
        enabled: body.grant.enabled === true,
        capabilities: filesystemCapabilitiesFromValues(Array.isArray(body.grant.capabilities) ? body.grant.capabilities : []),
      })
    } catch {
      setProjectFilesystemGrant(null)
    }
  }, [])

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
      void loadProjectFilesystemGrant(data.task?.projectId)
      setRetryProviderId(data.task?.pmProviderConfigId ?? null)
      setInitialRuns(data.runs ?? [])
      setInitialArtifacts(data.artifacts ?? [])
      setInitialQuestions(data.questions ?? [])
      setAttempts(data.attempts ?? [])
      setWorkPackages(data.workPackages ?? [])
      setApprovalGates(data.approvalGates ?? [])
      setVcsChanges(data.vcsChanges ?? [])
      setCommandAudits(data.commandAudits ?? [])
      setFilesystemAudits(data.filesystemAudits ?? [])
    } catch (err) {
      setFetchError(err instanceof Error ? err.message : 'An unexpected error occurred')
    } finally {
      setLoading(false)
    }
  }, [loadProjectFilesystemGrant, taskId])

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

  const markLogsLive = useCallback((ids: string[]) => {
    if (ids.length === 0) return

    setLiveLogIds((prev) => {
      const next = new Set(prev)
      for (const id of ids) next.add(id)
      return next
    })

    for (const id of ids) {
      const existingTimer = liveLogTimersRef.current.get(id)
      if (existingTimer) window.clearTimeout(existingTimer)
      const timer = window.setTimeout(() => {
        setLiveLogIds((prev) => {
          if (!prev.has(id)) return prev
          const next = new Set(prev)
          next.delete(id)
          return next
        })
        liveLogTimersRef.current.delete(id)
      }, 1200)
      liveLogTimersRef.current.set(id, timer)
    }
  }, [])

  useEffect(() => () => {
    for (const timer of liveLogTimersRef.current.values()) window.clearTimeout(timer)
    liveLogTimersRef.current.clear()
  }, [])

  const loadLogs = useCallback(async (options: { append?: boolean } = {}) => {
    const append = options.append === true
    if (!append) setLogsLoading(true)
    setLogsError(null)
    try {
      const search = new URLSearchParams({ limit: append ? '250' : '100' })
      if (append && lastLogSequenceRef.current > 0) {
        search.set('afterSequence', String(lastLogSequenceRef.current))
      }
      const res = await fetch(`/api/tasks/${taskId}/logs?${search.toString()}`)
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? 'Failed to load task logs')
      }
      const data = await res.json() as { logs?: TaskLog[] }
      const incoming = data.logs ?? []
      setTaskLogs((prev) => {
        const existingIds = new Set(prev.map((log) => log.id))
        const next = append ? mergeTaskLogs(prev, incoming) : incoming
        lastLogSequenceRef.current = next.reduce((max, log) => Math.max(max, logSequence(log)), 0)
        if (append) {
          const newIds = incoming
            .filter((log) => !existingIds.has(log.id))
            .map((log) => log.id)
          if (newIds.length > 0) window.setTimeout(() => markLogsLive(newIds), 0)
        }
        return next
      })
    } catch (err) {
      setLogsError(err instanceof Error ? err.message : 'An unexpected error occurred')
    } finally {
      if (!append) setLogsLoading(false)
    }
  }, [markLogsLive, taskId])

  useEffect(() => {
    loadTask()
    loadLogs()
    loadProviders()
  }, [loadLogs, loadProviders, loadTask])

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
      loadLogs()
    }
  }, [taskStatus, loadLogs, loadTask])

  useEffect(() => {
    if (streamRefreshRevision > 0) {
      loadTask()
    }
  }, [streamRefreshRevision, loadTask])

  useEffect(() => {
    if (taskLogRevision > 0) {
      loadLogs({ append: true })
    }
  }, [taskLogRevision, loadLogs])

  // Auto-expand the plan once it's awaiting approval, so reviewers see it
  // without an extra click; stays expanded afterward unless collapsed manually.
  useEffect(() => {
    if (currentStatus === 'awaiting_approval') {
      setPlanExpanded(true)
    }
  }, [currentStatus])

  useEffect(() => {
    const actualStatus = taskStatus ?? task?.status ?? null
    if (optimisticTaskStatus === null || actualStatus === null) return
    // Clear the optimistic status once the server has caught up. The optimistic
    // value can move the task either toward a terminal state (Stop → cancelled)
    // or away from one (Retry → pending), so we keep it until the real status
    // either matches it or lands on the same side of the terminal boundary;
    // clearing on any non-matching status wipes the optimistic feedback before
    // it can render.
    const settled = actualStatus === optimisticTaskStatus ||
      TERMINAL_TASK_STATUSES.has(actualStatus) === TERMINAL_TASK_STATUSES.has(optimisticTaskStatus)
    if (settled) {
      setOptimisticTaskStatus(null)
    }
  }, [optimisticTaskStatus, taskStatus, task?.status])

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
      setRetrySubmitted(true)
      setRetryCardCollapsing(true)
      setOptimisticTaskStatus('pending')
      window.setTimeout(() => {
        void loadTask().finally(() => {
          setRetryCardCollapsing(false)
          setRetrySubmitted(false)
        })
      }, 900)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'An unexpected error occurred')
    } finally {
      setActionLoading(false)
    }
  }

  async function handleStopTask() {
    if (!window.confirm('Stop this task now? Running package work will be marked cancelled.')) return
    setActionLoading(true)
    setActionError(null)
    try {
      const res = await fetch(`/api/tasks/${taskId}`, { method: 'DELETE' })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? 'Failed to stop task')
      }
      setOptimisticTaskStatus('cancelled')
      await loadTask()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'An unexpected error occurred')
    } finally {
      setActionLoading(false)
    }
  }

  async function handleDeleteTask() {
    if (!window.confirm('Delete this task and its run history? This cannot be undone.')) return
    setActionLoading(true)
    setActionError(null)
    try {
      const res = await fetch(`/api/tasks/${taskId}?mode=delete`, { method: 'DELETE' })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? 'Failed to delete task')
      }
      router.push('/dashboard/tasks')
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

  const effectiveTaskStatus = currentStatus ?? task.status
  const isAwaitingApproval = effectiveTaskStatus === 'awaiting_approval'
  const hasBlockedPackage = workPackages.some((pkg) => stringField(pkg, ['status', 'state']) === 'blocked')
  const unresolvedFilesystemGrants = unresolvedRequiredFilesystemGrants(workPackages, projectFilesystemGrant)
  const hasUnresolvedFilesystemGrants = unresolvedFilesystemGrants.length > 0
  const canRetryHandoff = canRetryHandoffForTaskStatus(effectiveTaskStatus, hasBlockedPackage)
  const canRetryTask = ['failed', 'cancelled', 'rejected'].includes(effectiveTaskStatus)
  const canShowRetryTask = canRetryTask || retryCardCollapsing
  const canStopTask = canStopTaskStatus(effectiveTaskStatus)
  const canDeleteTask = canDeleteTaskStatus(effectiveTaskStatus)
  const plannedAgents = plannedAgentsFromArtifacts(mergedArtifacts)
  const capabilityClassification = latestCapabilityClassificationFromArtifacts(mergedArtifacts)
  const planApprovalGate = approvalGates.find((gate) => (
    stringField(gate, ['gateType', 'type']) === 'plan_approval' &&
    stringField(gate, ['status', 'state']) === 'pending'
  )) ?? approvalGates.find((gate) => stringField(gate, ['gateType', 'type']) === 'plan_approval') ?? null
  const planSourceArtifactId = planApprovalGate ? stringField(planApprovalGate, ['sourceArtifactId']) : ''
  const planSourceArtifact = planSourceArtifactId === ''
    ? null
    : mergedArtifacts.find((artifact) => artifact.id === planSourceArtifactId) ?? null
  const mcpExecutionDesign = latestMcpExecutionDesignFromArtifacts(planSourceArtifact ? [planSourceArtifact] : mergedArtifacts)

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
              {statusBadge(effectiveTaskStatus)}
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
          <div className="flex flex-wrap items-center gap-2">
            {canStopTask && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => void handleStopTask()}
                disabled={actionLoading}
                aria-busy={actionLoading}
              >
                <SquareIcon aria-hidden="true" />
                Stop
              </Button>
            )}
            {canDeleteTask && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => void handleDeleteTask()}
                disabled={actionLoading}
                aria-busy={actionLoading}
              >
                <Trash2Icon aria-hidden="true" />
                Delete
              </Button>
            )}
          </div>
        </div>

        {/* Error message */}
        {task.errorMessage !== null && optimisticTaskStatus === null && (
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

      {/* Filesystem access approval — surfaced prominently OUTSIDE the awaiting-
          approval flow too. A grant block happens at handoff time and lands the
          task in `failed`/`blocked`, where the approval controls would otherwise
          only live inside a collapsed per-package section. Without this the
          operator is told to "approve filesystem context" with nowhere obvious to
          do it, and "Re-run stalled handoff" just re-blocks on the same gate. */}
      {hasUnresolvedFilesystemGrants && !isAwaitingApproval && (
        <section aria-label="Filesystem access approval" className="mb-6 rounded-lg border border-amber-500/40 bg-amber-500/10 p-4">
          <p className="text-sm font-medium text-foreground">Filesystem access needs your approval</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {unresolvedFilesystemGrants.length === 1
              ? 'A work package needs read-only project filesystem access before it can run.'
              : `${unresolvedFilesystemGrants.length} work packages need read-only project filesystem access before they can run.`}
            {' '}Approve it here and Forge continues the task automatically — you do not need to re-run the handoff.
          </p>
          <div className="mt-3 grid gap-2">
            {unresolvedFilesystemGrants.map((grant) => {
              const pkg = workPackages.find((item) => stringField(item, ['id']) === grant.packageId)
              if (!pkg) return null
              return (
                <div key={grant.packageId || grant.title} className="rounded-md border border-border bg-background/80 p-2">
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <span className="text-xs font-medium text-foreground">{grant.title}</span>
                    <Badge variant="outline" className={statusBadgeClass('blocked')}>missing grant</Badge>
                  </div>
                  <p className="mb-2 break-words font-mono text-[11px] text-muted-foreground">
                    {grant.missingCapabilities.join(', ')}
                  </p>
                  <FilesystemGrantControls
                    onUpdated={loadTask}
                    pkg={pkg}
                    taskId={taskId}
                    taskStatus={effectiveTaskStatus}
                  />
                </div>
              )
            })}
          </div>
          <p className="mt-2 text-[11px] text-muted-foreground">
            Access is issued as a bounded, read-only project context packet — no files are written and no live filesystem tools are exposed.
          </p>
        </section>
      )}

      {canRetryHandoff && !hasUnresolvedFilesystemGrants && (
        <section aria-label={effectiveTaskStatus === 'running' ? 'Handoff recovery' : 'Start handoff recovery'} className="mb-6">
          <RetryHandoffControls
            blockedReason={effectiveTaskStatus === 'running'
              ? 'The task is running. If the handoff worker stalled or disconnected, this safely continues eligible packages.'
              : 'The task is approved. If the handoff worker has not picked it up, this safely re-enqueues the approval job.'}
            taskId={taskId}
            onRetried={loadTask}
            title={effectiveTaskStatus === 'running' ? 'Handoff worker stalled?' : 'Start handoff'}
          />
        </section>
      )}

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

              {hasUnresolvedFilesystemGrants && (
                <div className="mb-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3">
                  <p className="text-sm font-medium text-foreground">Filesystem grants required</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Approve required filesystem context before approving the plan.
                  </p>
                  <div className="mt-3 grid gap-2">
                    {unresolvedFilesystemGrants.map((grant) => {
                      const pkg = workPackages.find((item) => stringField(item, ['id']) === grant.packageId)
                      if (!pkg) return null
                      return (
                        <div key={grant.packageId || grant.title} className="rounded-md border border-border bg-background/80 p-2">
                          <div className="mb-2 flex flex-wrap items-center gap-2">
                            <span className="text-xs font-medium text-foreground">{grant.title}</span>
                            <Badge variant="outline" className={statusBadgeClass('blocked')}>missing grant</Badge>
                          </div>
                          <p className="mb-2 break-words font-mono text-[11px] text-muted-foreground">
                            {grant.missingCapabilities.join(', ')}
                          </p>
                          <FilesystemGrantControls
                            onUpdated={loadTask}
                            pkg={pkg}
                            taskId={taskId}
                            taskStatus={effectiveTaskStatus}
                          />
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}

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
                    disabled={actionLoading || hasUnresolvedFilesystemGrants}
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

          {canShowRetryTask && (
            <>
              {retrySubmitted && actionError === null && (
                <p role="status" aria-live="polite" className="mb-3 text-sm text-muted-foreground">
                  Retry submitted. Forge is waiting for a worker to pick up the task.
                </p>
              )}
              <form
                onSubmit={handleRetry}
                aria-label="Retry task"
                className={[
                  'mb-6 overflow-hidden rounded-lg border border-border bg-card transition-all duration-300 ease-out',
                  retryCardCollapsing ? 'max-h-0 border-transparent p-0 opacity-0' : 'max-h-[18rem] p-4 opacity-100',
                ].join(' ')}
                aria-hidden={retryCardCollapsing}
              >
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
                            {provider.displayName} · {providerModelLabel(provider)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <Button type="submit" size="sm" disabled={actionLoading || retryCardCollapsing} aria-busy={actionLoading}>
                    {actionLoading ? 'Requeueing…' : 'Retry task'}
                  </Button>
                </div>
                {actionError !== null && (
                  <p role="alert" aria-live="assertive" className="mt-3 text-sm text-destructive">
                    {actionError}
                  </p>
                )}
              </form>
            </>
          )}

          {/* Architect-selected agents/resources and MCP access, grouped with
              the prompt rather than the workforce execution column. */}
          <div className="mb-6 grid gap-6">
            <CapabilityClassificationPanel classification={capabilityClassification} />
            <McpAccessPlanPanel
              approvalGate={planApprovalGate}
              design={mcpExecutionDesign}
              onSaved={loadTask}
              status={effectiveTaskStatus}
              workPackages={workPackages}
            />
          </div>

          <TaskLogsPanel
            error={logsError}
            liveLogIds={liveLogIds}
            loading={logsLoading}
            logs={taskLogs}
            taskId={taskId}
          />

          {/* Agent run timeline */}
          <section aria-labelledby="runs-heading" className="mb-6">
            <h2 id="runs-heading" className="mb-3 text-sm font-medium text-muted-foreground uppercase tracking-wide">
              Agent history
            </h2>
            {mergedRuns.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border px-4 py-8 text-center">
                <p className="text-sm text-muted-foreground">No agent history yet.</p>
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
            {attempts.length > 0 && (
              <details className="mt-3 rounded-lg border border-border bg-muted/20 px-3 py-2">
                <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
                  Queue attempts
                </summary>
                <ul className="mt-2 rounded-lg border border-border bg-background" aria-label="Queue attempt history">
                  {attempts.map((attempt) => (
                    <TaskAttemptRow key={attempt.id} attempt={attempt} runs={mergedRuns} />
                  ))}
                </ul>
              </details>
            )}
          </section>
        </div>

        <aside className="flex min-w-0 flex-col gap-6">
          <WorkforcePanel
            workPackages={workPackages}
            approvalGates={approvalGates}
            vcsChanges={vcsChanges}
            commandAudits={commandAudits}
            filesystemAudits={filesystemAudits}
            fallbackAgents={plannedAgents}
            taskId={taskId}
            taskStatus={currentStatus}
            onGateDecided={loadTask}
            artifacts={mergedArtifacts}
            runs={mergedRuns}
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
