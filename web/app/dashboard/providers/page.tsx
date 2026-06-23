'use client'

import { useState, useEffect, useCallback } from 'react'
import {
  PlusIcon,
  PencilIcon,
  Trash2Icon,
  RefreshCwIcon,
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

type ProviderHealth = {
  reachable: boolean
  envVarPresent: boolean
  latencyMs: number | null
  error: string | null
  checkedAt: string | null
}

type HealthMap = Record<string, ProviderHealth | 'loading' | 'error'>

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CATEGORY_COLORS: Record<ProviderCategory, string> = {
  local:  'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
  remote: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300',
  cloud:  'bg-violet-100 text-violet-800 dark:bg-violet-900/30 dark:text-violet-300',
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

function HealthDot({ health }: { health: ProviderHealth | 'loading' | 'error' | undefined }) {
  const lastChecked =
    typeof health === 'object' && health.checkedAt
      ? new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'short' }).format(new Date(health.checkedAt))
      : null

  if (health === undefined || health === 'loading') {
    return (
      <span
        className="inline-flex flex-col gap-0.5"
        aria-label="Checking health"
        title="Checking health"
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
      <span className="inline-flex flex-col gap-0.5" aria-label="Health check failed" title="Health check failed">
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2 rounded-full bg-gray-400" aria-hidden="true" />
          <span className="text-xs text-muted-foreground">Unknown</span>
        </span>
      </span>
    )
  }
  if (health.checkedAt === null) {
    return (
      <span className="inline-flex flex-col gap-0.5" aria-label="Provider health not checked" title={health.error ?? 'Not checked'}>
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2 rounded-full bg-gray-400" aria-hidden="true" />
          <span className="text-xs text-muted-foreground">Not checked</span>
        </span>
      </span>
    )
  }
  if (!health.envVarPresent) {
    return (
      <span className="inline-flex flex-col gap-0.5" aria-label="Environment variable missing" title="Environment variable missing">
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2 rounded-full bg-yellow-400" aria-hidden="true" />
          <span className="text-xs text-muted-foreground">Env var missing</span>
        </span>
        <span className="text-[11px] text-muted-foreground">{lastChecked ?? 'Not checked'}</span>
      </span>
    )
  }
  if (!health.reachable) {
    return (
      <span className="inline-flex flex-col gap-0.5" aria-label="Provider unreachable" title={health.error ?? 'Unreachable'}>
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
  const needsApiKey = entry.requiresApiKey
  const showBaseUrl = entry.requiresBaseUrl || entry.category === 'local'
  const baseUrlRequired = entry.requiresBaseUrl
  const category = providerCategory(form.providerType, form.isLocal)
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
    onChange({
      ...form,
      providerType: pt,
      isLocal: next.category === 'local',
      // Suggest the known base URL for the newly chosen provider.
      baseUrl: next.defaultBaseUrl ?? '',
    })
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
      {/* Display name */}
      <div className="flex flex-col gap-1.5">
        <label htmlFor="pf-displayName" className="text-sm font-medium text-foreground">
          Display name <span aria-hidden="true" className="text-destructive">*</span>
        </label>
        <input
          id="pf-displayName"
          type="text"
          required
          value={form.displayName}
          onChange={(e) => set('displayName', e.target.value)}
          placeholder="My Anthropic Provider"
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

      {/* Model ID */}
      <div className="flex flex-col gap-1.5">
        <label htmlFor="pf-modelId" className="text-sm font-medium text-foreground">
          Model ID <span aria-hidden="true" className="text-destructive">*</span>
        </label>
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
          {category === 'cloud' && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void handleFetchModels()}
              disabled={modelsLoading || (needsApiKey && !form.apiKey.trim() && !keyAlreadySet)}
              aria-label="Fetch available models from provider API"
            >
              {modelsLoading ? 'Fetching…' : 'Fetch models'}
            </Button>
          )}
        </div>
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
            Base URL{' '}
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
            Stored encrypted in the database.
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
  onConfirm: () => void
  deleting: boolean
}

function DeleteConfirm({ provider, onConfirm, deleting }: DeleteConfirmProps) {
  const [open, setOpen] = useState(false)

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
        <p className="text-sm text-muted-foreground">
          Remove <strong className="text-foreground">{provider.displayName}</strong>? This will deactivate it and unlink it from any agent that references it. This action cannot be undone.
        </p>
        <DialogFooter>
          <Button
            variant="destructive"
            disabled={deleting}
            aria-busy={deleting}
            onClick={() => { onConfirm(); setOpen(false) }}
          >
            {deleting ? 'Removing…' : 'Remove provider'}
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
  const [discovering, setDiscovering] = useState(false)
  const [discoverMsg, setDiscoverMsg] = useState<string | null>(null)

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

  const loadProviders = useCallback(async () => {
    setLoading(true)
    setFetchError(null)
    try {
      const res = await fetch('/api/providers')
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error((body as { error?: string }).error ?? 'Failed to load providers')
      }
      const data = await res.json() as { providers: ProviderConfig[] }
      setProviders(data.providers ?? [])
    } catch (err) {
      setFetchError(err instanceof Error ? err.message : 'An unexpected error occurred')
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

  const loadHealth = useCallback(async (refresh = false) => {
    if (providers.length === 0) {
      setHealthMap({})
      return
    }

    const initial: HealthMap = {}
    for (const p of providers) initial[p.id] = 'loading'
    setHealthMap(initial)

    await Promise.allSettled(
      providers.map(async (p) => {
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

  async function handleRefreshHealth() {
    setRefreshingHealth(true)
    try {
      await loadHealth(true)
    } finally {
      setRefreshingHealth(false)
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
    const displayName = addForm.displayName.trim()
    const modelId = addForm.modelId.trim()
    const baseUrl = addForm.baseUrl.trim() || entry.defaultBaseUrl || null
    const apiKey = entry.requiresApiKey ? addForm.apiKey.trim() || null : null

    if (!displayName) { setAddError('Display name is required.'); return }
    if (!modelId) { setAddError('Model ID is required.'); return }
    if (entry.requiresBaseUrl && !baseUrl) {
      setAddError('Base URL is required for this provider type.')
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
          isLocal: addForm.isLocal,
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
    const displayName = editForm.displayName.trim()
    const modelId = editForm.modelId.trim()
    const baseUrl = editForm.baseUrl.trim() || entry.defaultBaseUrl || null
    // Only send apiKey when the user typed one; a blank field keeps the stored key.
    const typedApiKey = entry.requiresApiKey ? editForm.apiKey.trim() : ''

    if (!displayName) { setEditError('Display name is required.'); return }
    if (!modelId) { setEditError('Model ID is required.'); return }
    if (entry.requiresBaseUrl && !baseUrl) {
      setEditError('Base URL is required for this provider type.')
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
          isLocal: editForm.isLocal,
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

  async function handleDelete(id: string) {
    setDeletingId(id)
    try {
      const res = await fetch(`/api/providers/${id}`, { method: 'DELETE' })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error((body as { error?: string }).error ?? 'Failed to remove provider')
      }
      await loadProviders()
    } catch (err) {
      // Surface error inline without crashing the table
      setFetchError(err instanceof Error ? err.message : 'Failed to remove provider')
    } finally {
      setDeletingId(null)
    }
  }

  // ---------------------------------------------------------------------------
  // Detect local models (Ollama / LM Studio)
  // ---------------------------------------------------------------------------

  async function handleDiscoverLocal() {
    setDiscovering(true)
    setDiscoverMsg(null)
    try {
      const res = await fetch('/api/providers/discover-local', { method: 'POST' })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error((body as { error?: string }).error ?? 'Local detection failed')
      }
      const data = await res.json() as {
        found: number
        added: { providerType: string; modelId: string }[]
        ollamaReachable: boolean
        lmstudioReachable: boolean
      }
      if (data.added.length > 0) {
        setDiscoverMsg(`Added ${data.added.length} local model${data.added.length === 1 ? '' : 's'}.`)
        await loadProviders()
      } else if (data.found > 0) {
        setDiscoverMsg('Local models found are already configured.')
      } else if (!data.ollamaReachable && !data.lmstudioReachable) {
        setDiscoverMsg('No running Ollama or LM Studio detected on localhost.')
      } else {
        setDiscoverMsg('No local models found.')
      }
    } catch (err) {
      setDiscoverMsg(err instanceof Error ? err.message : 'Local detection failed')
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
          aria-label="Detect local models from Ollama and LM Studio"
        >
          {discovering ? 'Detecting…' : 'Detect local models'}
        </Button>
        <Dialog open={addOpen} onOpenChange={setAddOpen}>
          <DialogTrigger
            render={
              <Button size="sm" aria-label="Add provider" onClick={openAdd}>
                <PlusIcon aria-hidden="true" />
                Add Provider
              </Button>
            }
          />
          <DialogContent className="sm:max-w-md" aria-labelledby="add-provider-title">
            <DialogHeader>
              <DialogTitle id="add-provider-title">Add Provider</DialogTitle>
            </DialogHeader>
            <ProviderForm
              form={addForm}
              onChange={setAddForm}
              error={addError}
              submitting={addSubmitting}
              onSubmit={handleAdd}
              submitLabel="Add Provider"
            />
          </DialogContent>
        </Dialog>
        </div>
      </div>

      {/* Discovery feedback */}
      {discoverMsg !== null && (
        <p role="status" aria-live="polite" className="mb-4 text-sm text-muted-foreground">
          {discoverMsg}
        </p>
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
            No providers configured yet. Add one above, or apply a recommended
            configuration from the Agents page.
          </p>
        </div>
      )}

      {/* Provider table */}
      {!loading && providers.length > 0 && (
        <div className="mb-8 overflow-x-auto rounded-xl border border-border">
          <table className="min-w-full text-sm" role="table" aria-label="Provider configurations">
            <thead>
              <tr className="border-b border-border bg-muted/40">
                <th scope="col" className="px-4 py-3 text-left font-medium text-muted-foreground">Display name</th>
                <th scope="col" className="px-4 py-3 text-left font-medium text-muted-foreground">Provider</th>
                <th scope="col" className="px-4 py-3 text-left font-medium text-muted-foreground">Model ID</th>
                <th scope="col" className="px-4 py-3 text-left font-medium text-muted-foreground">Category</th>
                <th scope="col" className="px-4 py-3 text-left font-medium text-muted-foreground">Health</th>
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
                    <span
                      className="max-w-[180px] truncate font-mono text-xs text-foreground block"
                      title={provider.modelId}
                    >
                      {provider.modelId}
                    </span>
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
                    <HealthDot health={healthMap[provider.id]} />
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
                            <DialogTitle id="edit-provider-title">Edit Provider</DialogTitle>
                          </DialogHeader>
                          <ProviderForm
                            form={editForm}
                            onChange={setEditForm}
                            error={editError}
                            submitting={editSubmitting}
                            onSubmit={handleEdit}
                            submitLabel="Save Changes"
                            keyAlreadySet={provider.hasApiKey}
                          />
                        </DialogContent>
                      </Dialog>

                      {/* Delete */}
                      <DeleteConfirm
                        provider={provider}
                        onConfirm={() => handleDelete(provider.id)}
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
            aria-label="Refresh provider health"
          >
            <RefreshCwIcon className="size-4" aria-hidden="true" />
            {refreshingHealth ? 'Checking…' : 'Refresh health'}
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
