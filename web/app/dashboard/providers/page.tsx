'use client'

import { useState, useEffect, useCallback } from 'react'
import {
  PlusIcon,
  PencilIcon,
  Trash2Icon,
  RefreshCwIcon,
  ExternalLinkIcon,
  InfoIcon,
  CheckCircle2Icon,
  CircleAlertIcon,
  XCircleIcon,
  WrenchIcon,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogTrigger,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  PROVIDER_TYPE_LABELS,
  PROVIDER_TYPE_OPTIONS,
  type ProviderType,
} from '@/lib/providers/types'
import {
  PROVIDER_CATALOG,
  PROVIDER_CATEGORY_LABELS,
  providerCategory,
  type ProviderCategory,
} from '@/lib/providers/catalog'
import {
  ACP_AGENTS,
  ACP_AGENTS_SOURCE_URL,
  acpProviderDisplay,
  acpProviderModelId,
  getAcpAgent,
  getAcpModelSelection,
  parseAcpProviderModelId,
  type AcpAuthMode,
} from '@/lib/providers/acp/catalog'
import type { ProviderHealthStatus } from '@/lib/providers/health'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ProviderConfig = {
  id: string
  displayName: string
  providerType: ProviderType
  modelId: string
  baseUrl: string | null
  apiKeyEnvVar: string | null
  hasApiKey: boolean
  isLocal: boolean
  isActive: boolean
  createdAt: string
  updatedAt: string
}

type ProviderDeactivationImpact = {
  affectedAssignments?: {
    agentConfigs?: { id: string; role: string; displayName: string }[]
    tasks?: { id: string; title: string; status: string }[]
  }
  hasDefaultProviderFallback?: boolean
  fallbackProvider?: ProviderConfig | null
  setupPrompt?: string | null
  message?: string
}

type ProviderHealth = {
  status: ProviderHealthStatus
  reachable: boolean
  envVarPresent: boolean
  latencyMs: number | null
  error: string | null
  checkedAt: string | null
}

type HealthMap = Record<string, ProviderHealth | 'loading' | 'error'>

type DefaultProviderState = {
  defaultProviderConfigId: string | null
  resolvedProviderId: string | null
}

type DiscoveryCandidateStatus = 'reachable' | 'not_reachable' | 'added' | 'updated' | 'configured' | 'skipped' | 'unknown'

type DiscoveryCandidate = {
  id: string
  label: string
  detail?: string
  providerType?: string
  modelId?: string
  status: DiscoveryCandidateStatus
  guidance?: string
}

type DiscoveryCapabilityGroup = {
  id: string
  title: string
  description?: string
  kind: 'generation' | 'auxiliary'
  candidates: DiscoveryCandidate[]
}

type DiscoveryChange = {
  providerType: string
  modelId: string
}

type DiscoverySkip = DiscoveryChange & {
  reason?: string
}

type LocalDiscoveryResponse = {
  found: number
  added: DiscoveryChange[]
  updated?: DiscoveryChange[]
  skipped?: DiscoverySkip[]
  ollamaReachable: boolean
  lmstudioReachable: boolean
  capabilityGroups?: unknown
  auxiliaryCapabilityGroups?: unknown
}

type LocalDiscoveryState =
  | { status: 'error'; message: string }
  | { status: 'success'; response: LocalDiscoveryResponse; groups: DiscoveryCapabilityGroup[] }

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CATEGORY_COLORS: Record<ProviderCategory, string> = {
  local:  'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
  remote: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300',
  cloud:  'bg-violet-100 text-violet-800 dark:bg-violet-900/30 dark:text-violet-300',
}

const ACP_AUTH_LABELS: Record<AcpAuthMode, string> = {
  web: 'Web login',
  cli: 'CLI login',
  unknown: 'Agent-managed auth',
}

const LMSTUDIO_START_TITLE =
  'LM Studio model must be loaded and started in LM Studio before Forge can reach it.'

const LOCAL_RUNTIME_GUIDANCE: Record<'ollama' | 'lmstudio', string> = {
  ollama: 'Start Ollama and pull a model, then run discovery again.',
  lmstudio: 'Open LM Studio, load a chat model, start the local server, then run discovery again.',
}

const SKIP_REASON_LABELS: Record<string, string> = {
  provider_disabled: 'Previously deactivated provider was left inactive.',
  base_url_conflict: 'Existing provider uses a different endpoint.',
  nonlocal_existing_provider: 'Existing non-local provider was not changed.',
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function discoveryProviderLabel(providerType: string): string {
  return PROVIDER_TYPE_LABELS[providerType as ProviderType] ?? providerType
}

function candidateFromRuntime(
  providerType: 'ollama' | 'lmstudio',
  reachable: boolean,
): DiscoveryCandidate {
  return {
    id: `${providerType}-runtime`,
    label: discoveryProviderLabel(providerType),
    providerType,
    status: reachable ? 'reachable' : 'not_reachable',
    detail: reachable ? 'Runtime responded to local discovery.' : 'No running local runtime detected.',
    guidance: reachable ? undefined : LOCAL_RUNTIME_GUIDANCE[providerType],
  }
}

function candidateFromChange(change: DiscoveryChange, status: 'added' | 'updated' | 'configured'): DiscoveryCandidate {
  return {
    id: `${status}-${change.providerType}-${change.modelId}`,
    label: change.modelId,
    detail: `${discoveryProviderLabel(change.providerType)} model`,
    providerType: change.providerType,
    modelId: change.modelId,
    status,
  }
}

function candidateFromSkip(skip: DiscoverySkip): DiscoveryCandidate {
  return {
    id: `skipped-${skip.providerType}-${skip.modelId}-${skip.reason ?? 'unknown'}`,
    label: skip.modelId,
    detail: `${discoveryProviderLabel(skip.providerType)} model`,
    providerType: skip.providerType,
    modelId: skip.modelId,
    status: 'skipped',
    guidance: skip.reason ? SKIP_REASON_LABELS[skip.reason] ?? skip.reason.replace(/_/g, ' ') : 'Skipped by discovery.',
  }
}

function normalizeCandidate(raw: unknown, fallbackIndex: number): DiscoveryCandidate | null {
  if (!isRecord(raw)) return null
  const label =
    stringValue(raw.label) ||
    stringValue(raw.name) ||
    stringValue(raw.modelId) ||
    stringValue(raw.capability) ||
    stringValue(raw.id)
  if (!label) return null

  const rawStatus = stringValue(raw.status) || stringValue(raw.state)
  const status: DiscoveryCandidateStatus =
    rawStatus === 'reachable' ||
    rawStatus === 'not_reachable' ||
    rawStatus === 'added' ||
    rawStatus === 'updated' ||
    rawStatus === 'configured' ||
    rawStatus === 'skipped'
      ? rawStatus
      : typeof raw.reachable === 'boolean'
        ? raw.reachable ? 'reachable' : 'not_reachable'
        : 'unknown'

  return {
    id: stringValue(raw.id) || `${label}-${fallbackIndex}`,
    label,
    detail: stringValue(raw.detail) || stringValue(raw.description) || undefined,
    providerType: stringValue(raw.providerType) || undefined,
    modelId: stringValue(raw.modelId) || undefined,
    status,
    guidance: stringValue(raw.guidance) || stringValue(raw.setupGuidance) || undefined,
  }
}

function normalizeDiscoveryGroups(raw: unknown, kind: 'generation' | 'auxiliary'): DiscoveryCapabilityGroup[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map((item, index): DiscoveryCapabilityGroup | null => {
      if (!isRecord(item)) return null
      const title = stringValue(item.title) || stringValue(item.label) || stringValue(item.name)
      const rawCandidates = Array.isArray(item.candidates)
        ? item.candidates
        : Array.isArray(item.capabilities)
          ? item.capabilities
          : Array.isArray(item.items)
            ? item.items
            : []
      const candidates = rawCandidates
        .map((candidate, candidateIndex) => normalizeCandidate(candidate, candidateIndex))
        .filter((candidate): candidate is DiscoveryCandidate => candidate !== null)
      if (!title && candidates.length === 0) return null
      return {
        id: stringValue(item.id) || `${kind}-group-${index}`,
        title: title || (kind === 'generation' ? 'Generation capabilities' : 'Auxiliary capabilities'),
        description: stringValue(item.description) || undefined,
        kind,
        candidates,
      }
    })
    .filter((group): group is DiscoveryCapabilityGroup => group !== null)
}

function buildDiscoveryGroups(response: LocalDiscoveryResponse): DiscoveryCapabilityGroup[] {
  const backendGenerationGroups = normalizeDiscoveryGroups(response.capabilityGroups, 'generation')
  const backendAuxiliaryGroups = normalizeDiscoveryGroups(response.auxiliaryCapabilityGroups, 'auxiliary')

  const changedCandidates = [
    ...response.added.map((change) => candidateFromChange(change, 'added')),
    ...(response.updated ?? []).map((change) => candidateFromChange(change, 'updated')),
    ...(response.skipped ?? []).map(candidateFromSkip),
  ]

  const generationFallback: DiscoveryCapabilityGroup = {
    id: 'main-generation',
    title: 'Main generation capabilities',
    description: 'Local chat models Forge can add as generation providers.',
    kind: 'generation',
    candidates: [
      candidateFromRuntime('ollama', response.ollamaReachable),
      candidateFromRuntime('lmstudio', response.lmstudioReachable),
      ...changedCandidates,
    ],
  }

  const auxiliaryFallback: DiscoveryCapabilityGroup = {
    id: 'auxiliary-local',
    title: 'Auxiliary local capabilities',
    description: 'Non-generation local tools are reported separately so they do not change model provider setup.',
    kind: 'auxiliary',
    candidates: [],
  }

  const groups = [
    ...(backendGenerationGroups.length > 0 ? backendGenerationGroups : [generationFallback]),
    ...backendAuxiliaryGroups,
  ]

  if (!groups.some((group) => group.kind === 'auxiliary')) {
    groups.push({ ...auxiliaryFallback, candidates: [] })
  }

  return groups
}

// ---------------------------------------------------------------------------
// Form state
// ---------------------------------------------------------------------------

type ProviderFormState = {
  displayName: string
  providerType: ProviderType
  modelId: string
  baseUrl: string
  apiKey: string
  isLocal: boolean
}

const DEFAULT_FORM: ProviderFormState = {
  displayName: '',
  providerType: 'anthropic',
  modelId: '',
  baseUrl: '',
  apiKey: '',
  isLocal: false,
}

function formFromProvider(p: ProviderConfig): ProviderFormState {
  return {
    displayName: p.displayName,
    providerType: p.providerType,
    modelId: p.modelId,
    baseUrl: p.baseUrl ?? '',
    apiKey: '', // never prefilled — the stored secret is never sent to the client
    isLocal: p.isLocal,
  }
}

// ---------------------------------------------------------------------------
// Health indicator
// ---------------------------------------------------------------------------

function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

function HealthDot({ health }: { health: ProviderHealth | 'loading' | 'error' | undefined }) {
  const checkedDate = typeof health === 'object' && health.checkedAt ? new Date(health.checkedAt) : null
  const lastChecked = checkedDate
    ? isSameDay(checkedDate, new Date())
      ? new Intl.DateTimeFormat(undefined, { timeStyle: 'short' }).format(checkedDate)
      : new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'short' }).format(checkedDate)
    : null

  if (health === undefined || health === 'loading') {
    return (
      <span
        className="inline-flex flex-col gap-0.5"
        aria-label="Checking connection"
        title="Checking connection"
      >
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2 rounded-full bg-gray-300 dark:bg-gray-600 animate-pulse" aria-hidden="true" />
          <span className="text-xs text-muted-foreground">Checking</span>
        </span>
      </span>
    )
  }
  if (health === 'error') {
    return (
      <span className="inline-flex flex-col gap-0.5" aria-label="Connection check failed" title="Connection check failed">
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2 rounded-full bg-gray-400" aria-hidden="true" />
          <span className="text-xs text-muted-foreground">Unknown</span>
        </span>
      </span>
    )
  }
  if (health.checkedAt === null) {
    return (
      <span className="inline-flex flex-col gap-0.5" aria-label="Connection not checked" title={health.error ?? 'Not checked'}>
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2 rounded-full bg-gray-400" aria-hidden="true" />
          <span className="text-xs text-muted-foreground">Not checked</span>
        </span>
      </span>
    )
  }
  if (health.status === 'not_configured') {
    return (
      <span className="inline-flex flex-col gap-0.5" aria-label="Adapter not configured" title={health.error ?? 'Not configured'}>
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2 rounded-full bg-gray-400" aria-hidden="true" />
          <span className="text-xs text-muted-foreground">Not set up</span>
        </span>
        <span className="text-[11px] text-muted-foreground">{lastChecked ?? 'Not checked'}</span>
      </span>
    )
  }
  if (health.status === 'authenticated_unavailable') {
    return (
      <span className="inline-flex flex-col gap-0.5" aria-label="Adapter reachable but not authenticated" title={health.error ?? 'Needs authentication'}>
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2 rounded-full bg-yellow-400" aria-hidden="true" />
          <span className="text-xs text-muted-foreground">Needs login</span>
        </span>
        <span className="text-[11px] text-muted-foreground">{lastChecked ?? 'Not checked'}</span>
      </span>
    )
  }
  if (health.status === 'handshake_failed') {
    return (
      <span className="inline-flex flex-col gap-0.5" aria-label="Adapter handshake failed" title={health.error ?? 'Handshake failed'}>
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2 rounded-full bg-red-500" aria-hidden="true" />
          <span className="text-xs text-muted-foreground">Handshake failed</span>
        </span>
        <span className="text-[11px] text-muted-foreground">{lastChecked ?? 'Not checked'}</span>
      </span>
    )
  }
  if (!health.envVarPresent) {
    return (
      <span className="inline-flex flex-col gap-0.5" aria-label="API key missing" title="API key missing">
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2 rounded-full bg-yellow-400" aria-hidden="true" />
          <span className="text-xs text-muted-foreground">Missing key</span>
        </span>
        <span className="text-[11px] text-muted-foreground">{lastChecked ?? 'Not checked'}</span>
      </span>
    )
  }
  if (!health.reachable) {
    return (
      <span className="inline-flex flex-col gap-0.5" aria-label="Provider is unreachable" title={health.error ?? 'Unreachable'}>
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2 rounded-full bg-red-500" aria-hidden="true" />
          <span className="text-xs text-muted-foreground">Unreachable</span>
        </span>
        <span className="text-[11px] text-muted-foreground">{lastChecked ?? 'Not checked'}</span>
      </span>
    )
  }
  return (
    <span
      className="inline-flex flex-col gap-0.5"
      aria-label={`Reachable${health.latencyMs !== null ? `, ${health.latencyMs} ms` : ''}`}
      title={lastChecked ? `Last checked ${lastChecked}` : 'Reachable'}
    >
      <span className="inline-flex items-center gap-1.5">
        <span className="size-2 rounded-full bg-green-500" aria-hidden="true" />
        <span className="text-xs text-muted-foreground">
          {health.latencyMs !== null ? `${health.latencyMs} ms` : 'OK'}
        </span>
      </span>
      <span className="text-[11px] text-muted-foreground">{lastChecked ?? 'Not checked'}</span>
    </span>
  )
}

function DiscoveryCandidateStatusIcon({ status }: { status: DiscoveryCandidateStatus }) {
  if (status === 'reachable' || status === 'added' || status === 'updated' || status === 'configured') {
    return <CheckCircle2Icon className="size-4 text-green-600 dark:text-green-400" aria-hidden="true" />
  }
  if (status === 'not_reachable') {
    return <XCircleIcon className="size-4 text-red-500" aria-hidden="true" />
  }
  if (status === 'skipped') {
    return <CircleAlertIcon className="size-4 text-amber-600 dark:text-amber-400" aria-hidden="true" />
  }
  return <WrenchIcon className="size-4 text-muted-foreground" aria-hidden="true" />
}

function discoveryStatusLabel(status: DiscoveryCandidateStatus): string {
  const labels: Record<DiscoveryCandidateStatus, string> = {
    reachable: 'Reachable',
    not_reachable: 'Not reachable',
    added: 'Added',
    updated: 'Updated',
    configured: 'Already configured',
    skipped: 'Skipped',
    unknown: 'Unknown',
  }
  return labels[status]
}

function DiscoveryResultsPanel({ state }: { state: LocalDiscoveryState }) {
  if (state.status === 'error') {
    return (
      <div role="alert" className="mb-4 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
        {state.message}
      </div>
    )
  }

  const { response, groups } = state
  const changed = response.added.length + (response.updated?.length ?? 0)

  return (
    <section aria-labelledby="local-discovery-heading" className="mb-4 rounded-xl border border-border bg-card p-4">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="local-discovery-heading" className="text-sm font-medium text-foreground">
            Local discovery results
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {changed > 0
              ? `Updated ${changed} local provider${changed === 1 ? '' : 's'}.`
              : response.found > 0
                ? 'Reachable local models are already represented or were skipped.'
                : 'No local generation models were added.'}
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <span className="inline-flex h-5 items-center rounded-full border border-border px-2 text-xs text-muted-foreground">
            {response.found} found
          </span>
          <span className="inline-flex h-5 items-center rounded-full border border-border px-2 text-xs text-muted-foreground">
            {response.added.length} added
          </span>
          {(response.updated?.length ?? 0) > 0 && (
            <span className="inline-flex h-5 items-center rounded-full border border-border px-2 text-xs text-muted-foreground">
              {response.updated?.length ?? 0} updated
            </span>
          )}
        </div>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        {groups.map((group) => (
          <div key={group.id} className="min-w-0 rounded-lg border border-border bg-muted/20 p-3">
            <div className="mb-2 flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {group.kind === 'generation' ? 'Generation' : 'Auxiliary'}
                </p>
                <h3 className="mt-0.5 text-sm font-medium text-foreground">{group.title}</h3>
              </div>
              <span className="shrink-0 rounded-full bg-background px-2 py-0.5 text-xs text-muted-foreground ring-1 ring-border">
                {group.candidates.length}
              </span>
            </div>
            {group.description && <p className="mb-2 text-xs text-muted-foreground">{group.description}</p>}
            {group.candidates.length === 0 ? (
              <p className="rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
                No auxiliary local capabilities were reported by discovery.
              </p>
            ) : (
              <ul className="grid gap-2" aria-label={`${group.title} candidates`}>
                {group.candidates.map((candidate) => (
                  <li key={candidate.id} className="min-w-0 rounded-md border border-border bg-background px-3 py-2">
                    <div className="flex min-w-0 items-start gap-2">
                      <DiscoveryCandidateStatusIcon status={candidate.status} />
                      <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                          <p className="min-w-0 break-words text-sm font-medium text-foreground">{candidate.label}</p>
                          <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                            {discoveryStatusLabel(candidate.status)}
                          </span>
                        </div>
                        {candidate.detail && <p className="mt-0.5 break-words text-xs text-muted-foreground">{candidate.detail}</p>}
                        {candidate.guidance && (
                          <p className="mt-1 break-words text-xs text-muted-foreground">
                            Setup: {candidate.guidance}
                          </p>
                        )}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------
// Provider form
// ---------------------------------------------------------------------------

interface ProviderFormProps {
  form: ProviderFormState
  onChange: (updated: ProviderFormState) => void
  error: string | null
  submitting: boolean
  onSubmit: (e: React.FormEvent) => void
  submitLabel: string
  keyAlreadySet?: boolean
}

function ProviderForm({ form, onChange, error, submitting, onSubmit, submitLabel, keyAlreadySet = false }: ProviderFormProps) {
  const entry = PROVIDER_CATALOG[form.providerType]
  const isAcp = form.providerType === 'acp'
  const needsApiKey = entry.requiresApiKey
  const showBaseUrl = !isAcp && (entry.requiresBaseUrl || entry.category === 'local')
  const baseUrlRequired = entry.requiresBaseUrl
  const category = providerCategory(form.providerType, form.isLocal)
  const supportsModelFetch = category === 'cloud' || form.providerType === 'lmstudio'
  const parsedAcp = isAcp ? parseAcpProviderModelId(form.modelId) : null
  const selectedAcpAgent = isAcp ? getAcpAgent(form.modelId) : undefined
  const acpModelSelection = isAcp ? getAcpModelSelection(form.modelId) : null
  const [availableModels, setAvailableModels] = useState<string[] | null>(null)
  const [modelsLoading, setModelsLoading] = useState(false)
  const [modelsError, setModelsError] = useState<string | null>(null)

  function set<K extends keyof ProviderFormState>(key: K, value: ProviderFormState[K]) {
    onChange({ ...form, [key]: value })
  }

  async function handleFetchModels() {
    setModelsLoading(true)
    setModelsError(null)
    setAvailableModels(null)
    try {
      const res = await fetch('/api/providers/list-models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          providerType: form.providerType,
          apiKey: form.apiKey.trim() || undefined,
          baseUrl: form.baseUrl.trim() || undefined,
        }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error ?? 'Failed to list models')
      setAvailableModels(body.models ?? [])
    } catch (err) {
      setModelsError(err instanceof Error ? err.message : 'Failed to list models')
    } finally {
      setModelsLoading(false)
    }
  }

  function handleProviderTypeChange(value: string | null) {
    if (!value) return
    const pt = value as ProviderType
    const next = PROVIDER_CATALOG[pt]
    setAvailableModels(null)
    setModelsError(null)
    onChange({
      ...form,
      providerType: pt,
      modelId: pt === 'acp' ? acpProviderModelId(ACP_AGENTS[0]?.id ?? '') : '',
      apiKey: pt === 'acp' ? '' : form.apiKey,
      isLocal: pt === 'acp' ? true : next.category === 'local',
      // Suggest the known base URL for the newly chosen provider.
      baseUrl: pt === 'acp' ? '' : next.defaultBaseUrl ?? '',
    })
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4" autoComplete="off" noValidate>
      {/* Display name */}
      <div className="flex flex-col gap-1.5">
        <label htmlFor="pf-displayName" className="text-sm font-medium text-foreground">
          Name <span aria-hidden="true" className="text-destructive">*</span>
        </label>
        <input
          id="pf-displayName"
          name="forge-provider-name"
          type="text"
          required
          value={form.displayName}
          onChange={(e) => set('displayName', e.target.value)}
          placeholder="Anthropic main model"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="none"
          spellCheck={false}
          data-1p-ignore="true"
          data-lpignore="true"
          data-form-type="other"
          className="rounded-lg border border-input bg-transparent px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
          aria-required="true"
        />
      </div>

      {/* Provider type */}
      <div className="flex flex-col gap-1.5">
        <label htmlFor="pf-providerType" className="text-sm font-medium text-foreground">
          Provider <span aria-hidden="true" className="text-destructive">*</span>
        </label>
        <Select value={form.providerType} onValueChange={handleProviderTypeChange}>
          <SelectTrigger id="pf-providerType" className="w-full" aria-required="true">
            <SelectValue placeholder="Select provider" />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {PROVIDER_TYPE_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          {PROVIDER_CATEGORY_LABELS[category]}
          {entry.helpText ? ` — ${entry.helpText}` : ''}
        </p>
      </div>

      {/* Model ID / ACP agent */}
      <div className="flex flex-col gap-1.5">
        <label htmlFor="pf-modelId" className="text-sm font-medium text-foreground">
          {isAcp ? 'ACP agent' : 'Model'} <span aria-hidden="true" className="text-destructive">*</span>
        </label>
        {isAcp ? (
          <>
            <Select
              value={parsedAcp?.agentId || undefined}
              onValueChange={(v) => v && set('modelId', acpProviderModelId(v, parsedAcp?.selectedModel))}
            >
              <SelectTrigger id="pf-modelId" className="w-full" aria-required="true">
                <SelectValue placeholder="Select ACP agent" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {ACP_AGENTS.map((agent) => (
                    <SelectItem key={agent.id} value={agent.id}>
                      {agent.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="pf-acp-selected-model" className="text-sm font-medium text-foreground">
                Selected model <span className="text-muted-foreground font-normal">(optional)</span>
              </label>
              {acpModelSelection && acpModelSelection.options.length > 0 && (
                <Select
                  value={
                    parsedAcp?.selectedModel && acpModelSelection.options.some((option) => option.id === parsedAcp.selectedModel)
                      ? parsedAcp.selectedModel
                      : undefined
                  }
                  onValueChange={(v) => v && set('modelId', acpProviderModelId(parsedAcp?.agentId ?? '', v))}
                >
                  <SelectTrigger aria-label="ACP model preset" className="w-full">
                    <SelectValue placeholder="Choose a model preset" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {acpModelSelection.options.map((option) => (
                        <SelectItem key={option.id} value={option.id}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              )}
              <input
                id="pf-acp-selected-model"
                type="text"
                value={parsedAcp?.selectedModel ?? ''}
                onChange={(e) => set('modelId', acpProviderModelId(parsedAcp?.agentId ?? '', e.target.value))}
                placeholder={acpModelSelection ? 'Runtime default or custom model id' : 'Runtime default'}
                className="rounded-lg border border-input bg-transparent px-3 py-2 font-mono text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
              />
              <p className="text-xs text-muted-foreground">
                {acpModelSelection
                  ? acpModelSelection.helpText
                  : 'This ACP runtime does not expose model selection through Forge yet; the value is stored for operator clarity but not passed.'}
              </p>
            </div>
            {selectedAcpAgent && (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                <span>{ACP_AUTH_LABELS[selectedAcpAgent.authMode]}</span>
                <a
                  href={selectedAcpAgent.sourceUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-primary underline-offset-2 hover:underline"
                >
                  Source <ExternalLinkIcon className="size-3" aria-hidden="true" />
                </a>
                {selectedAcpAgent.adapterUrl && (
                  <a
                    href={selectedAcpAgent.adapterUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-primary underline-offset-2 hover:underline"
                  >
                    Adapter <ExternalLinkIcon className="size-3" aria-hidden="true" />
                  </a>
                )}
                <a
                  href={ACP_AGENTS_SOURCE_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-primary underline-offset-2 hover:underline"
                >
                  ACP list <ExternalLinkIcon className="size-3" aria-hidden="true" />
                </a>
                {selectedAcpAgent.note && <span>{selectedAcpAgent.note}</span>}
              </div>
            )}
          </>
        ) : (
          <div className="flex gap-2">
            <input
              id="pf-modelId"
              type="text"
              required
              value={form.modelId}
              onChange={(e) => set('modelId', e.target.value)}
              placeholder={entry.modelPlaceholder}
              className="min-w-0 flex-1 rounded-lg border border-input bg-transparent px-3 py-2 font-mono text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
              aria-required="true"
            />
            {supportsModelFetch && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void handleFetchModels()}
                disabled={modelsLoading || (needsApiKey && !form.apiKey.trim() && !keyAlreadySet)}
                aria-label="Fetch available models from this provider"
              >
                {modelsLoading ? 'Fetching…' : 'Fetch models'}
              </Button>
            )}
            {form.providerType === 'lmstudio' && (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={LMSTUDIO_START_TITLE}
                title={LMSTUDIO_START_TITLE}
              >
                <InfoIcon className="size-4 text-muted-foreground" aria-hidden="true" />
              </Button>
            )}
          </div>
        )}
        {modelsError !== null && (
          <p role="alert" className="text-xs text-destructive">{modelsError}</p>
        )}
        {availableModels !== null && (
          <Select value={form.modelId || undefined} onValueChange={(v) => v && set('modelId', v)}>
            <SelectTrigger aria-label="Available models" className="w-full">
              <SelectValue placeholder={availableModels.length > 0 ? 'Choose a model' : 'No models returned'} />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {availableModels.map((id) => (
                  <SelectItem key={id} value={id}>{id}</SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        )}
      </div>

      {/* Base URL — for self-hosted endpoints (required) and local runtimes (optional override) */}
      {showBaseUrl && (
        <div className="flex flex-col gap-1.5">
          <label htmlFor="pf-baseUrl" className="text-sm font-medium text-foreground">
            Endpoint URL{' '}
            {baseUrlRequired
              ? <span aria-hidden="true" className="text-destructive">*</span>
              : <span className="text-muted-foreground font-normal">(optional)</span>}
          </label>
          <input
            id="pf-baseUrl"
            type="url"
            required={baseUrlRequired}
            value={form.baseUrl}
            onChange={(e) => set('baseUrl', e.target.value)}
            placeholder={entry.defaultBaseUrl ?? 'https://api.example.com/v1'}
            className="rounded-lg border border-input bg-transparent px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            aria-required={baseUrlRequired}
          />
        </div>
      )}

      {/* API key — entered here and stored encrypted; no .env editing required */}
      {needsApiKey && (
        <div className="flex flex-col gap-1.5">
          <label htmlFor="pf-apiKey" className="text-sm font-medium text-foreground">
            API key
          </label>
          <input
            id="pf-apiKey"
            type="password"
            autoComplete="off"
            value={form.apiKey}
            onChange={(e) => set('apiKey', e.target.value)}
            placeholder={keyAlreadySet ? '•••••••• stored — leave blank to keep' : 'sk-…'}
            className="rounded-lg border border-input bg-transparent px-3 py-2 font-mono text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
          />
          <p className="text-xs text-muted-foreground">
            Stored encrypted.
            {entry.apiKeyUrl && (
              <>
                {' '}
                <a
                  href={entry.apiKeyUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary underline-offset-2 hover:underline"
                >
                  Get a {PROVIDER_TYPE_LABELS[form.providerType]} API key →
                </a>
              </>
            )}
          </p>
        </div>
      )}

      {error !== null && (
        <p role="alert" aria-live="assertive" className="text-sm text-destructive">
          {error}
        </p>
      )}

      <DialogFooter>
        <Button type="submit" disabled={submitting} aria-busy={submitting}>
          {submitting ? 'Saving…' : submitLabel}
        </Button>
      </DialogFooter>
    </form>
  )
}

// ---------------------------------------------------------------------------
// Delete confirmation popover
// ---------------------------------------------------------------------------

interface DeleteConfirmProps {
  provider: ProviderConfig
  impact: ProviderDeactivationImpact | null
  error: string | null
  onConfirm: (confirmed: boolean) => Promise<boolean>
  deleting: boolean
}

function DeleteConfirm({ provider, impact, error, onConfirm, deleting }: DeleteConfirmProps) {
  const [open, setOpen] = useState(false)
  const agentAssignments = impact?.affectedAssignments?.agentConfigs ?? []
  const taskAssignments = impact?.affectedAssignments?.tasks ?? []
  const requiresConfirmation = impact !== null

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Delete provider ${provider.displayName}`}
            title={`Delete ${provider.displayName}`}
          />
        }
      >
        <Trash2Icon className="size-4 text-muted-foreground" aria-hidden="true" />
      </DialogTrigger>
      <DialogContent aria-labelledby="delete-provider-title">
        <DialogHeader>
          <DialogTitle id="delete-provider-title">Remove provider</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3 text-sm text-muted-foreground">
          <p>
            Remove <strong className="text-foreground">{provider.displayName}</strong>? Forge will deactivate it so new tasks cannot select it.
          </p>
          {impact ? (
            <div className="rounded-lg border border-border bg-muted/30 px-3 py-2">
              <p className="font-medium text-foreground">Impact</p>
              {impact.message && <p className="mt-1">{impact.message}</p>}
              {agentAssignments.length > 0 && (
                <div className="mt-2">
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Agent defaults</p>
                  <ul className="mt-1 list-disc space-y-1 pl-4">
                    {agentAssignments.map((agent) => (
                      <li key={agent.id}>
                        {agent.displayName} <span className="text-xs">({agent.role})</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {taskAssignments.length > 0 && (
                <div className="mt-2">
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Active task overrides</p>
                  <ul className="mt-1 list-disc space-y-1 pl-4">
                    {taskAssignments.map((task) => (
                      <li key={task.id}>
                        {task.title} <span className="text-xs">({task.status})</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {impact.setupPrompt && (
                <p className="mt-2 text-amber-700 dark:text-amber-300">
                  {impact.setupPrompt}
                </p>
              )}
            </div>
          ) : (
            <p>
              Existing history remains readable. If this provider is assigned to agents or active tasks, Forge will show the affected records before deactivation.
            </p>
          )}
          {error && <p role="alert" className="text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button
            variant="destructive"
            disabled={deleting}
            aria-busy={deleting}
            onClick={() => {
              void onConfirm(requiresConfirmation).then((deleted) => {
                if (deleted) setOpen(false)
              })
            }}
          >
            {deleting ? 'Removing…' : requiresConfirmation ? 'Confirm deactivation' : 'Review deactivation'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function ProvidersPage() {
  const [providers, setProviders] = useState<ProviderConfig[]>([])
  const [loading, setLoading] = useState(true)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [healthMap, setHealthMap] = useState<HealthMap>({})
  const [refreshingHealth, setRefreshingHealth] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [deleteImpacts, setDeleteImpacts] = useState<Record<string, ProviderDeactivationImpact | null>>({})
  const [deleteErrors, setDeleteErrors] = useState<Record<string, string | null>>({})
  const [discovering, setDiscovering] = useState(false)
  const [discoveryState, setDiscoveryState] = useState<LocalDiscoveryState | null>(null)
  const [recheckingId, setRecheckingId] = useState<string | null>(null)
  const [defaultState, setDefaultState] = useState<DefaultProviderState>({
    defaultProviderConfigId: null,
    resolvedProviderId: null,
  })
  const [settingDefaultId, setSettingDefaultId] = useState<string | null>(null)
  const [defaultError, setDefaultError] = useState<string | null>(null)

  // Add dialog
  const [addOpen, setAddOpen] = useState(false)
  const [addForm, setAddForm] = useState<ProviderFormState>(DEFAULT_FORM)
  const [addError, setAddError] = useState<string | null>(null)
  const [addSubmitting, setAddSubmitting] = useState(false)

  // Edit dialog
  const [editProvider, setEditProvider] = useState<ProviderConfig | null>(null)
  const [editForm, setEditForm] = useState<ProviderFormState>(DEFAULT_FORM)
  const [editError, setEditError] = useState<string | null>(null)
  const [editSubmitting, setEditSubmitting] = useState(false)

  // ---------------------------------------------------------------------------
  // Load providers
  // ---------------------------------------------------------------------------

  const loadProviders = useCallback(async (): Promise<ProviderConfig[]> => {
    setLoading(true)
    setFetchError(null)
    try {
      const res = await fetch('/api/providers')
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error((body as { error?: string }).error ?? 'Failed to load providers')
      }
      const data = await res.json() as { providers: ProviderConfig[] }
      const nextProviders = data.providers ?? []
      setProviders(nextProviders)
      return nextProviders
    } catch (err) {
      setFetchError(err instanceof Error ? err.message : 'An unexpected error occurred')
      return []
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadProviders()
  }, [loadProviders])

  // ---------------------------------------------------------------------------
  // Health cache — read cached rows by default; live probes only on explicit refresh
  // ---------------------------------------------------------------------------

  const loadHealth = useCallback(async (
    refresh = false,
    silent = false,
    providerList = providers,
  ) => {
    if (providerList.length === 0) {
      setHealthMap({})
      return
    }

    if (!silent) {
      const initial: HealthMap = {}
      for (const p of providerList) initial[p.id] = 'loading'
      setHealthMap(initial)
    }

    await Promise.allSettled(
      providerList.map(async (p) => {
        try {
          const res = await fetch(`/api/providers/${p.id}/health${refresh ? '?refresh=1' : ''}`)
          if (!res.ok) throw new Error('Health check failed')
          const health = await res.json() as ProviderHealth
          setHealthMap((prev) => ({ ...prev, [p.id]: health }))
        } catch {
          setHealthMap((prev) => ({ ...prev, [p.id]: 'error' }))
        }
      })
    )
  }, [providers])

  useEffect(() => {
    void loadHealth(false)
  }, [loadHealth])

  // Background refresh: re-probe reachability periodically so local LLM
  // (e.g. Ollama) status doesn't go stale until the user clicks "Refresh".
  // Silent so rows update in place instead of flashing back to "loading".
  useEffect(() => {
    const interval = setInterval(() => {
      void loadHealth(false, true)
    }, 20_000)
    return () => clearInterval(interval)
  }, [loadHealth])

  async function handleRefreshHealth() {
    setRefreshingHealth(true)
    try {
      await loadHealth(true)
    } finally {
      setRefreshingHealth(false)
    }
  }

  async function handleRecheckOne(providerId: string) {
    setRecheckingId(providerId)
    try {
      const res = await fetch(`/api/providers/${providerId}/health?refresh=1`)
      if (!res.ok) throw new Error('Health check failed')
      const health = await res.json() as ProviderHealth
      setHealthMap((prev) => ({ ...prev, [providerId]: health }))
    } catch {
      setHealthMap((prev) => ({ ...prev, [providerId]: 'error' }))
    } finally {
      setRecheckingId(null)
    }
  }

  // ---------------------------------------------------------------------------
  // Default provider
  // ---------------------------------------------------------------------------

  const loadDefaultProvider = useCallback(async () => {
    try {
      const res = await fetch('/api/providers/default')
      if (!res.ok) return
      const data = await res.json() as { defaultProviderConfigId: string | null; resolvedProvider: { id: string } | null }
      setDefaultState({
        defaultProviderConfigId: data.defaultProviderConfigId,
        resolvedProviderId: data.resolvedProvider?.id ?? null,
      })
    } catch {
      // Non-critical; leave default state as-is.
    }
  }, [])

  useEffect(() => {
    void loadDefaultProvider()
  }, [loadDefaultProvider])

  async function handleSetDefault(providerId: string) {
    setSettingDefaultId(providerId)
    setDefaultError(null)
    try {
      const res = await fetch('/api/providers/default', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providerConfigId: providerId }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error((body as { error?: string }).error ?? 'Failed to set default provider')
      }
      await loadDefaultProvider()
    } catch (err) {
      setDefaultError(err instanceof Error ? err.message : 'Failed to set default provider')
    } finally {
      setSettingDefaultId(null)
    }
  }

  async function handleClearDefault() {
    setSettingDefaultId('__clear__')
    setDefaultError(null)
    try {
      const res = await fetch('/api/providers/default', { method: 'DELETE' })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error((body as { error?: string }).error ?? 'Failed to clear default provider')
      }
      await loadDefaultProvider()
    } catch (err) {
      setDefaultError(err instanceof Error ? err.message : 'Failed to clear default provider')
    } finally {
      setSettingDefaultId(null)
    }
  }

  // ---------------------------------------------------------------------------
  // Add provider
  // ---------------------------------------------------------------------------

  function openAdd() {
    setAddForm(DEFAULT_FORM)
    setAddError(null)
    setAddOpen(true)
  }

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault()
    setAddError(null)

    const entry = PROVIDER_CATALOG[addForm.providerType]
    const isAcp = addForm.providerType === 'acp'
    const displayName = addForm.displayName.trim()
    const modelId = addForm.modelId.trim()
    const baseUrl = isAcp ? null : addForm.baseUrl.trim() || entry.defaultBaseUrl || null
    const apiKey = !isAcp && entry.requiresApiKey ? addForm.apiKey.trim() || null : null

    if (!displayName) { setAddError('Display name is required.'); return }
    if (!modelId) { setAddError(isAcp ? 'ACP agent is required.' : 'Model is required.'); return }
    if (entry.requiresBaseUrl && !baseUrl) {
      setAddError('Endpoint URL is required for this provider.')
      return
    }

    setAddSubmitting(true)
    try {
      const res = await fetch('/api/providers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          displayName,
          providerType: addForm.providerType,
          modelId,
          baseUrl,
          apiKey,
          isLocal: isAcp ? true : addForm.isLocal,
        }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error((body as { error?: string }).error ?? 'Failed to create provider')
      }
      setAddOpen(false)
      await loadProviders()
    } catch (err) {
      setAddError(err instanceof Error ? err.message : 'An unexpected error occurred')
    } finally {
      setAddSubmitting(false)
    }
  }

  // ---------------------------------------------------------------------------
  // Edit provider
  // ---------------------------------------------------------------------------

  function openEdit(provider: ProviderConfig) {
    setEditProvider(provider)
    setEditForm(formFromProvider(provider))
    setEditError(null)
  }

  async function handleEdit(e: React.FormEvent) {
    e.preventDefault()
    if (!editProvider) return
    setEditError(null)

    const entry = PROVIDER_CATALOG[editForm.providerType]
    const isAcp = editForm.providerType === 'acp'
    const displayName = editForm.displayName.trim()
    const modelId = editForm.modelId.trim()
    const baseUrl = isAcp ? null : editForm.baseUrl.trim() || entry.defaultBaseUrl || null
    // Only send apiKey when the user typed one; a blank field keeps the stored key.
    const typedApiKey = !isAcp && entry.requiresApiKey ? editForm.apiKey.trim() : ''

    if (!displayName) { setEditError('Display name is required.'); return }
    if (!modelId) { setEditError(isAcp ? 'ACP agent is required.' : 'Model is required.'); return }
    if (entry.requiresBaseUrl && !baseUrl) {
      setEditError('Endpoint URL is required for this provider.')
      return
    }

    setEditSubmitting(true)
    try {
      const res = await fetch(`/api/providers/${editProvider.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          displayName,
          providerType: editForm.providerType,
          modelId,
          baseUrl,
          ...(typedApiKey !== '' ? { apiKey: typedApiKey } : {}),
          isLocal: isAcp ? true : editForm.isLocal,
        }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error((body as { error?: string }).error ?? 'Failed to update provider')
      }
      setEditProvider(null)
      await loadProviders()
    } catch (err) {
      setEditError(err instanceof Error ? err.message : 'An unexpected error occurred')
    } finally {
      setEditSubmitting(false)
    }
  }

  // ---------------------------------------------------------------------------
  // Delete provider
  // ---------------------------------------------------------------------------

  async function handleDelete(id: string, confirmed = false): Promise<boolean> {
    setDeletingId(id)
    setDeleteErrors((prev) => ({ ...prev, [id]: null }))
    const reviewedImpact = deleteImpacts[id]
    try {
      const res = await fetch(`/api/providers/${id}`, {
        method: 'DELETE',
        ...(confirmed
          ? {
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              confirm: true,
              expectedAgentConfigIds: reviewedImpact?.affectedAssignments?.agentConfigs?.map((agent) => agent.id) ?? [],
              expectedTaskIds: reviewedImpact?.affectedAssignments?.tasks?.map((task) => task.id) ?? [],
            }),
          }
          : {}),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        if (isRecord(body) && body.confirmationRequired === true && isRecord(body.impact)) {
          setDeleteImpacts((prev) => ({ ...prev, [id]: body.impact as ProviderDeactivationImpact }))
          return false
        }
        throw new Error((body as { error?: string }).error ?? 'Failed to remove provider')
      }
      setDeleteImpacts((prev) => ({ ...prev, [id]: null }))
      await loadProviders()
      return true
    } catch (err) {
      // Surface error inline without crashing the table
      setDeleteErrors((prev) => ({ ...prev, [id]: err instanceof Error ? err.message : 'Failed to remove provider' }))
      return false
    } finally {
      setDeletingId(null)
    }
  }

  // ---------------------------------------------------------------------------
  // Detect local models (Ollama / LM Studio)
  // ---------------------------------------------------------------------------

  async function handleDiscoverLocal() {
    setDiscovering(true)
    setDiscoveryState(null)
    try {
      const res = await fetch('/api/providers/discover-local', { method: 'POST' })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error((body as { error?: string }).error ?? 'Local detection failed')
      }
      const data = await res.json() as LocalDiscoveryResponse
      const changed = data.added.length + (data.updated?.length ?? 0)
      setDiscoveryState({ status: 'success', response: data, groups: buildDiscoveryGroups(data) })
      if (data.found > 0 || changed > 0) {
        const nextProviders = await loadProviders()
        await loadHealth(true, true, nextProviders)
      }
    } catch (err) {
      setDiscoveryState({ status: 'error', message: err instanceof Error ? err.message : 'Local detection failed' })
    } finally {
      setDiscovering(false)
    }
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="px-4 py-6 sm:px-6 lg:px-8">
      {/* Page header */}
      <div className="mb-6 flex items-center justify-between gap-4">
        <h1 className="text-xl font-semibold text-foreground">Providers</h1>
        <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={handleDiscoverLocal}
          disabled={discovering}
          aria-busy={discovering}
          aria-label="Find local models from Ollama and LM Studio"
        >
          {discovering ? 'Searching…' : 'Find local models'}
        </Button>
        <Dialog open={addOpen} onOpenChange={setAddOpen}>
          <DialogTrigger
            render={
              <Button size="sm" aria-label="Add provider" onClick={openAdd}>
                <PlusIcon aria-hidden="true" />
                Add provider
              </Button>
            }
          />
          <DialogContent className="sm:max-w-md" aria-labelledby="add-provider-title">
            <DialogHeader>
              <DialogTitle id="add-provider-title">Add provider</DialogTitle>
            </DialogHeader>
            <ProviderForm
              form={addForm}
              onChange={setAddForm}
              error={addError}
              submitting={addSubmitting}
              onSubmit={handleAdd}
              submitLabel="Add provider"
            />
          </DialogContent>
        </Dialog>
        </div>
      </div>

      {/* Discovery feedback */}
      {discoveryState !== null && <DiscoveryResultsPanel state={discoveryState} />}

      {/* Default provider summary */}
      {!loading && providers.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
          <span>
            {defaultState.defaultProviderConfigId
              ? 'A default provider is set. It is used whenever an agent or task has no provider assigned.'
              : defaultState.resolvedProviderId
                ? 'No default provider is set. Forge is falling back to a ready local provider for unassigned work.'
                : 'No default provider is set, and no ready local provider was found to fall back to.'}
          </span>
          {defaultState.defaultProviderConfigId && (
            <Button
              variant="ghost"
              size="sm"
              onClick={handleClearDefault}
              disabled={settingDefaultId === '__clear__'}
              aria-busy={settingDefaultId === '__clear__'}
            >
              {settingDefaultId === '__clear__' ? 'Clearing…' : 'Clear default'}
            </Button>
          )}
        </div>
      )}
      {defaultError !== null && (
        <p role="alert" className="mb-4 text-sm text-destructive">{defaultError}</p>
      )}

      {/* Loading */}
      {loading && (
        <div className="flex items-center justify-center py-16" role="status" aria-live="polite">
          <span className="text-sm text-muted-foreground">Loading providers…</span>
        </div>
      )}

      {/* Fetch error */}
      {!loading && fetchError !== null && (
        <div
          role="alert"
          className="mb-4 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive"
        >
          {fetchError}
          <button
            onClick={loadProviders}
            className="ml-2 underline underline-offset-2 hover:no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Retry
          </button>
        </div>
      )}

      {/* Empty state */}
      {!loading && fetchError === null && providers.length === 0 && (
        <div className="mb-8 flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border py-12 text-center">
          <p className="text-sm text-muted-foreground">
            No providers yet. Add one above, or apply a recommended setup from the Agents page.
          </p>
        </div>
      )}

      {/* Provider table */}
      {!loading && providers.length > 0 && (
        <div className="mb-8 overflow-x-auto rounded-xl border border-border">
          <table className="min-w-full text-sm" role="table" aria-label="Provider list">
            <thead>
              <tr className="border-b border-border bg-muted/40">
                <th scope="col" className="px-4 py-3 text-left font-medium text-muted-foreground">Name</th>
                <th scope="col" className="px-4 py-3 text-left font-medium text-muted-foreground">Provider</th>
                <th scope="col" className="px-4 py-3 text-left font-medium text-muted-foreground">Model or agent</th>
                <th scope="col" className="px-4 py-3 text-left font-medium text-muted-foreground">Category</th>
                <th scope="col" className="px-4 py-3 text-left font-medium text-muted-foreground">Connection</th>
                <th scope="col" className="px-4 py-3 text-left font-medium text-muted-foreground">Default</th>
                <th scope="col" className="px-4 py-3 text-right font-medium text-muted-foreground">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {providers.map((provider) => (
                <tr key={provider.id} className="border-b border-border last:border-0 hover:bg-muted/30">
                  <td className="px-4 py-3 font-medium text-foreground">
                    {provider.displayName}
                  </td>
                  <td className="px-4 py-3">
                    <span className="text-sm text-foreground">
                      {PROVIDER_TYPE_LABELS[provider.providerType] ?? provider.providerType}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span className="flex max-w-[220px] items-center gap-1.5">
                      <span
                        className="min-w-0 truncate font-mono text-xs text-foreground"
                        title={provider.modelId}
                      >
                        {provider.providerType === 'acp'
                          ? acpProviderDisplay(provider.modelId).runtimeLabel
                          : provider.modelId}
                      </span>
                      {provider.providerType === 'lmstudio' && (
                        <span
                          aria-label={LMSTUDIO_START_TITLE}
                          title={LMSTUDIO_START_TITLE}
                        >
                          <InfoIcon
                            className="size-3.5 shrink-0 text-muted-foreground"
                            aria-hidden="true"
                          />
                        </span>
                      )}
                    </span>
                    {provider.providerType === 'acp' && (
                      <span className="mt-1 block max-w-[220px] truncate text-xs text-muted-foreground" title={acpProviderDisplay(provider.modelId).modelSelectionLabel}>
                        {acpProviderDisplay(provider.modelId).modelSelectionLabel}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {(() => {
                      const category = providerCategory(provider.providerType, provider.isLocal)
                      return (
                        <span
                          className={`inline-flex h-5 items-center rounded-full px-2 text-xs font-medium ${CATEGORY_COLORS[category]}`}
                        >
                          {PROVIDER_CATEGORY_LABELS[category]}
                        </span>
                      )
                    })()}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1.5">
                      <HealthDot health={healthMap[provider.id]} />
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => handleRecheckOne(provider.id)}
                        disabled={recheckingId === provider.id}
                        aria-busy={recheckingId === provider.id}
                        aria-label={`Recheck connection for ${provider.displayName}`}
                        title="Recheck connection"
                      >
                        <RefreshCwIcon
                          className={`size-3.5 text-muted-foreground ${recheckingId === provider.id ? 'animate-spin' : ''}`}
                          aria-hidden="true"
                        />
                      </Button>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    {defaultState.defaultProviderConfigId === provider.id ? (
                      <span className="inline-flex h-5 items-center rounded-full bg-blue-100 px-2 text-xs font-medium text-blue-800 dark:bg-blue-900/30 dark:text-blue-300">
                        Default
                      </span>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleSetDefault(provider.id)}
                        disabled={settingDefaultId === provider.id || !provider.isActive}
                        aria-busy={settingDefaultId === provider.id}
                        aria-label={`Set ${provider.displayName} as default provider`}
                      >
                        {settingDefaultId === provider.id ? 'Setting…' : 'Set as default'}
                      </Button>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-1">
                      {/* Edit */}
                      <Dialog
                        open={editProvider?.id === provider.id}
                        onOpenChange={(open) => { if (!open) setEditProvider(null) }}
                      >
                        <DialogTrigger
                          render={
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              aria-label={`Edit provider ${provider.displayName}`}
                              title={`Edit ${provider.displayName}`}
                              onClick={() => openEdit(provider)}
                            />
                          }
                        >
                          <PencilIcon className="size-4 text-muted-foreground" aria-hidden="true" />
                        </DialogTrigger>
                        <DialogContent className="sm:max-w-md" aria-labelledby="edit-provider-title">
                          <DialogHeader>
                            <DialogTitle id="edit-provider-title">Edit provider</DialogTitle>
                          </DialogHeader>
                          <ProviderForm
                            form={editForm}
                            onChange={setEditForm}
                            error={editError}
                            submitting={editSubmitting}
                            onSubmit={handleEdit}
                            submitLabel="Save changes"
                            keyAlreadySet={provider.hasApiKey}
                          />
                        </DialogContent>
                      </Dialog>

                      {/* Delete */}
                      <DeleteConfirm
                        provider={provider}
                        impact={deleteImpacts[provider.id] ?? null}
                        error={deleteErrors[provider.id] ?? null}
                        onConfirm={(confirmed) => handleDelete(provider.id, confirmed)}
                        deleting={deletingId === provider.id}
                      />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Refresh button */}
      {!loading && (
        <div className="mb-10 flex justify-end gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={handleRefreshHealth}
            disabled={refreshingHealth || providers.length === 0}
            aria-busy={refreshingHealth}
            aria-label="Check provider connections"
          >
            <RefreshCwIcon className="size-4" aria-hidden="true" />
            {refreshingHealth ? 'Checking…' : 'Check connections'}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={loadProviders}
            aria-label="Refresh provider list"
          >
            <RefreshCwIcon className="size-4" aria-hidden="true" />
            Refresh
          </Button>
        </div>
      )}

    </div>
  )
}
