'use client'

import { useState, useEffect, useCallback } from 'react'
import {
  PlusIcon,
  PencilIcon,
  Trash2Icon,
  RefreshCwIcon,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
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
import { PRESETS } from '@/lib/recommendations'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ProviderType = 'anthropic' | 'openai' | 'google' | 'openrouter' | 'ollama' | 'litellm'

type ProviderConfig = {
  id: string
  displayName: string
  providerType: ProviderType
  modelId: string
  baseUrl: string | null
  apiKeyEnvVar: string | null
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
}

type HealthMap = Record<string, ProviderHealth | 'loading' | 'error'>

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROVIDER_TYPE_OPTIONS: { value: ProviderType; label: string }[] = [
  { value: 'anthropic',  label: 'Anthropic' },
  { value: 'openai',     label: 'OpenAI' },
  { value: 'google',     label: 'Google' },
  { value: 'openrouter', label: 'OpenRouter' },
  { value: 'ollama',     label: 'Ollama' },
  { value: 'litellm',    label: 'LiteLLM' },
]

const LOCAL_PROVIDER_TYPES: ProviderType[] = ['ollama', 'litellm']

const MODEL_PLACEHOLDERS: Record<ProviderType, string> = {
  anthropic:  'claude-opus-4-8',
  openai:     'gpt-4.1',
  google:     'gemini-2.0-flash',
  openrouter: 'moonshotai/kimi-k2',
  ollama:     'devstral-small:24b',
  litellm:    'litellm/claude-opus-4-8',
}

const PROVIDER_TYPE_COLORS: Record<ProviderType, string> = {
  anthropic:  'bg-violet-100 text-violet-800 dark:bg-violet-900/30 dark:text-violet-300',
  openai:     'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300',
  google:     'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300',
  openrouter: 'bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300',
  ollama:     'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
  litellm:    'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300',
}

// ---------------------------------------------------------------------------
// Form state
// ---------------------------------------------------------------------------

type ProviderFormState = {
  displayName: string
  providerType: ProviderType
  modelId: string
  baseUrl: string
  apiKeyEnvVar: string
  isLocal: boolean
}

const DEFAULT_FORM: ProviderFormState = {
  displayName: '',
  providerType: 'anthropic',
  modelId: '',
  baseUrl: '',
  apiKeyEnvVar: '',
  isLocal: false,
}

function formFromProvider(p: ProviderConfig): ProviderFormState {
  return {
    displayName: p.displayName,
    providerType: p.providerType,
    modelId: p.modelId,
    baseUrl: p.baseUrl ?? '',
    apiKeyEnvVar: p.apiKeyEnvVar ?? '',
    isLocal: p.isLocal,
  }
}

// ---------------------------------------------------------------------------
// Health indicator
// ---------------------------------------------------------------------------

function HealthDot({ health }: { health: ProviderHealth | 'loading' | 'error' | undefined }) {
  if (health === undefined || health === 'loading') {
    return (
      <span
        className="inline-flex items-center gap-1.5"
        aria-label="Checking health"
        title="Checking health"
      >
        <span className="size-2 rounded-full bg-gray-300 dark:bg-gray-600 animate-pulse" aria-hidden="true" />
        <span className="text-xs text-muted-foreground">Checking</span>
      </span>
    )
  }
  if (health === 'error') {
    return (
      <span className="inline-flex items-center gap-1.5" aria-label="Health check failed" title="Health check failed">
        <span className="size-2 rounded-full bg-gray-400" aria-hidden="true" />
        <span className="text-xs text-muted-foreground">Unknown</span>
      </span>
    )
  }
  if (!health.envVarPresent) {
    return (
      <span className="inline-flex items-center gap-1.5" aria-label="Environment variable missing" title="Environment variable missing">
        <span className="size-2 rounded-full bg-yellow-400" aria-hidden="true" />
        <span className="text-xs text-muted-foreground">Env var missing</span>
      </span>
    )
  }
  if (!health.reachable) {
    return (
      <span className="inline-flex items-center gap-1.5" aria-label="Provider unreachable" title={health.error ?? 'Unreachable'}>
        <span className="size-2 rounded-full bg-red-500" aria-hidden="true" />
        <span className="text-xs text-muted-foreground">Unreachable</span>
      </span>
    )
  }
  return (
    <span
      className="inline-flex items-center gap-1.5"
      aria-label={`Reachable${health.latencyMs !== null ? `, ${health.latencyMs} ms` : ''}`}
      title={health.latencyMs !== null ? `${health.latencyMs} ms` : 'Reachable'}
    >
      <span className="size-2 rounded-full bg-green-500" aria-hidden="true" />
      <span className="text-xs text-muted-foreground">
        {health.latencyMs !== null ? `${health.latencyMs} ms` : 'OK'}
      </span>
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
}

function ProviderForm({ form, onChange, error, submitting, onSubmit, submitLabel }: ProviderFormProps) {
  const needsBaseUrl = LOCAL_PROVIDER_TYPES.includes(form.providerType)
  const needsApiKey = !form.isLocal

  function set<K extends keyof ProviderFormState>(key: K, value: ProviderFormState[K]) {
    onChange({ ...form, [key]: value })
  }

  function handleProviderTypeChange(value: string | null) {
    if (!value) return
    const pt = value as ProviderType
    const isLocal = pt === 'ollama'
    onChange({ ...form, providerType: pt, isLocal })
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
          Provider type <span aria-hidden="true" className="text-destructive">*</span>
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
      </div>

      {/* Model ID */}
      <div className="flex flex-col gap-1.5">
        <label htmlFor="pf-modelId" className="text-sm font-medium text-foreground">
          Model ID <span aria-hidden="true" className="text-destructive">*</span>
        </label>
        <input
          id="pf-modelId"
          type="text"
          required
          value={form.modelId}
          onChange={(e) => set('modelId', e.target.value)}
          placeholder={MODEL_PLACEHOLDERS[form.providerType]}
          className="rounded-lg border border-input bg-transparent px-3 py-2 font-mono text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
          aria-required="true"
        />
      </div>

      {/* Base URL — shown for ollama / litellm */}
      {needsBaseUrl && (
        <div className="flex flex-col gap-1.5">
          <label htmlFor="pf-baseUrl" className="text-sm font-medium text-foreground">
            Base URL <span aria-hidden="true" className="text-destructive">*</span>
          </label>
          <input
            id="pf-baseUrl"
            type="url"
            required
            value={form.baseUrl}
            onChange={(e) => set('baseUrl', e.target.value)}
            placeholder="http://localhost:11434"
            className="rounded-lg border border-input bg-transparent px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            aria-required="true"
          />
        </div>
      )}

      {/* API key env var — shown for cloud providers */}
      {needsApiKey && (
        <div className="flex flex-col gap-1.5">
          <label htmlFor="pf-apiKeyEnvVar" className="text-sm font-medium text-foreground">
            API key environment variable
          </label>
          <input
            id="pf-apiKeyEnvVar"
            type="text"
            value={form.apiKeyEnvVar}
            onChange={(e) => set('apiKeyEnvVar', e.target.value)}
            placeholder="ANTHROPIC_API_KEY"
            className="rounded-lg border border-input bg-transparent px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
          />
          <p className="text-xs text-muted-foreground">
            Name of the environment variable holding the key, e.g. ANTHROPIC_API_KEY
          </p>
        </div>
      )}

      {/* Is local toggle */}
      <div className="flex items-center gap-3">
        <input
          id="pf-isLocal"
          type="checkbox"
          checked={form.isLocal}
          onChange={(e) => set('isLocal', e.target.checked)}
          className="size-4 rounded border-input accent-primary"
        />
        <label htmlFor="pf-isLocal" className="text-sm font-medium text-foreground">
          Local provider (no API key required)
        </label>
      </div>

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
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [applyingPreset, setApplyingPreset] = useState<string | null>(null)
  const [presetError, setPresetError] = useState<string | null>(null)

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
  // Health checks — run in parallel after providers load
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (providers.length === 0) return

    // Set all to loading
    const initial: HealthMap = {}
    for (const p of providers) initial[p.id] = 'loading'
    setHealthMap(initial)

    void Promise.allSettled(
      providers.map(async (p) => {
        try {
          const res = await fetch(`/api/providers/${p.id}/health`)
          if (!res.ok) throw new Error('Health check failed')
          const health = await res.json() as ProviderHealth
          setHealthMap((prev) => ({ ...prev, [p.id]: health }))
        } catch {
          setHealthMap((prev) => ({ ...prev, [p.id]: 'error' }))
        }
      })
    )
  }, [providers])

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

    const displayName = addForm.displayName.trim()
    const modelId = addForm.modelId.trim()
    const baseUrl = addForm.baseUrl.trim() || null
    const apiKeyEnvVar = addForm.apiKeyEnvVar.trim() || null

    if (!displayName) { setAddError('Display name is required.'); return }
    if (!modelId) { setAddError('Model ID is required.'); return }
    if (LOCAL_PROVIDER_TYPES.includes(addForm.providerType) && !baseUrl) {
      setAddError('Base URL is required for Ollama and LiteLLM providers.')
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
          apiKeyEnvVar,
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

    const displayName = editForm.displayName.trim()
    const modelId = editForm.modelId.trim()
    const baseUrl = editForm.baseUrl.trim() || null
    const apiKeyEnvVar = editForm.apiKeyEnvVar.trim() || null

    if (!displayName) { setEditError('Display name is required.'); return }
    if (!modelId) { setEditError('Model ID is required.'); return }
    if (LOCAL_PROVIDER_TYPES.includes(editForm.providerType) && !baseUrl) {
      setEditError('Base URL is required for Ollama and LiteLLM providers.')
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
          apiKeyEnvVar,
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
  // Apply preset
  // ---------------------------------------------------------------------------

  async function handleApplyPreset(presetId: string) {
    const preset = PRESETS.find((p) => p.id === presetId)
    if (!preset) return

    setApplyingPreset(presetId)
    setPresetError(null)

    try {
      // Refresh providers first so we work with the latest state
      const res = await fetch('/api/providers')
      if (!res.ok) throw new Error('Failed to load providers')
      const data = await res.json() as { providers: ProviderConfig[] }
      const current = data.providers ?? []

      // For each agent in preset: create a providerConfig if one with that
      // providerType+modelId doesn't already exist, then link agentConfig.
      const providerIdByKey: Record<string, string> = {}

      for (const [agentType, spec] of Object.entries(preset.agents)) {
        const key = `${spec.providerType}:${spec.modelId}`

        if (providerIdByKey[key] === undefined) {
          const existing = current.find(
            (p) => p.providerType === spec.providerType && p.modelId === spec.modelId,
          )
          if (existing) {
            providerIdByKey[key] = existing.id
          } else {
            // Create new provider config
            const createRes = await fetch('/api/providers', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                displayName: `${spec.providerType} / ${spec.modelId}`,
                providerType: spec.providerType,
                modelId: spec.modelId,
                baseUrl: spec.baseUrl ?? null,
                apiKeyEnvVar: spec.apiKeyEnvVar ?? null,
                isLocal: spec.isLocal,
              }),
            })
            if (!createRes.ok) {
              const body = await createRes.json().catch(() => ({}))
              throw new Error((body as { error?: string }).error ?? 'Failed to create provider')
            }
            const created = await createRes.json() as { provider: ProviderConfig }
            providerIdByKey[key] = created.provider.id
          }
        }

        // Update agent config
        const updateRes = await fetch(`/api/agents/${agentType}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ providerConfigId: providerIdByKey[key] }),
        })
        if (!updateRes.ok) {
          const body = await updateRes.json().catch(() => ({}))
          throw new Error((body as { error?: string }).error ?? `Failed to update agent config for ${agentType}`)
        }
      }

      await loadProviders()
    } catch (err) {
      setPresetError(err instanceof Error ? err.message : 'Failed to apply preset')
    } finally {
      setApplyingPreset(null)
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
            No providers configured yet. Add one or apply a preset below.
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
                <th scope="col" className="px-4 py-3 text-left font-medium text-muted-foreground">Type</th>
                <th scope="col" className="px-4 py-3 text-left font-medium text-muted-foreground">Model ID</th>
                <th scope="col" className="px-4 py-3 text-left font-medium text-muted-foreground">Source</th>
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
                    <span
                      className={`inline-flex h-5 items-center rounded-full px-2 text-xs font-medium ${PROVIDER_TYPE_COLORS[provider.providerType]}`}
                    >
                      {provider.providerType}
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
                    <Badge variant="outline">
                      {provider.isLocal ? 'Local' : 'Cloud'}
                    </Badge>
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
        <div className="mb-10 flex justify-end">
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

      {/* Recommended configurations */}
      <section aria-labelledby="presets-heading">
        <h2 id="presets-heading" className="mb-4 text-lg font-semibold text-foreground">
          Recommended configurations
        </h2>
        {presetError !== null && (
          <div
            role="alert"
            className="mb-4 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive"
          >
            {presetError}
          </div>
        )}
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {PRESETS.map((preset) => (
            <div
              key={preset.id}
              className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4"
            >
              <div className="flex flex-col gap-1">
                <span className="font-medium text-foreground">{preset.label}</span>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  {preset.description}
                </p>
              </div>
              <p className="text-xs font-medium text-foreground">
                {preset.estimatedMonthlyCost}
              </p>
              <Button
                size="sm"
                variant="outline"
                disabled={applyingPreset !== null}
                aria-busy={applyingPreset === preset.id}
                onClick={() => handleApplyPreset(preset.id)}
                aria-label={`Apply preset ${preset.label}`}
              >
                {applyingPreset === preset.id ? 'Applying…' : 'Apply'}
              </Button>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}
