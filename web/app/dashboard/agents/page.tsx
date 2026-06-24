'use client'

import { useState, useEffect, useCallback } from 'react'
import { PencilIcon } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
} from '@/components/ui/sheet'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { PRESETS, ROLE_RECOMMENDATIONS, type RoleRecommendation } from '@/lib/recommendations'
import { applyPreset } from '@/lib/applyPreset'
import {
  PROVIDER_TYPE_LABELS,
  PROVIDER_TYPE_OPTIONS,
  requiresProviderBaseUrl,
  type ProviderType,
} from '@/lib/providers/types'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type AgentType = 'architect' | 'backend' | 'frontend' | 'qa' | 'reviewer' | 'devops'

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

type AgentConfig = {
  id: string
  agentType: AgentType
  providerConfigId: string | null
  systemPrompt: string
  frontmatterOverrides: Record<string, unknown> | null
  updatedAt: string
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const AGENT_TYPES: AgentType[] = ['architect', 'backend', 'frontend', 'qa', 'reviewer', 'devops']

const AGENT_ICONS: Record<AgentType, string> = {
  architect: '🏛',
  backend:   '⚙️',
  frontend:  '🎨',
  reviewer:  '🔍',
  qa:        '🧪',
  devops:    '😢',
}

const AGENT_DESCRIPTIONS: Record<AgentType, string> = {
  architect: 'Designs systems, defines API contracts, authors ADRs, and decomposes features into tasks.',
  backend:   'Implements APIs, database migrations, business logic, and background services.',
  frontend:  'Builds UI components, wires up state management, and integrates with backend APIs.',
  reviewer:  'Audits pull requests for correctness, security vulnerabilities, and performance.',
  qa:        'Writes tests, analyses coverage gaps, and validates implementations against their spec.',
  devops:    'Manages Docker, CI/CD pipelines, infrastructure config, and deployment scripts.',
}

const LAYER_ORDER: RoleRecommendation['layer'][] = [
  'Anthropic API',
  'OpenAI API',
  'OpenRouter',
  'LiteLLM',
  'Ollama',
]

const CUSTOM_PROVIDER_VALUE = '__custom_provider__'
const ASSIGNABLE_PROVIDER_TYPE_OPTIONS = PROVIDER_TYPE_OPTIONS.filter((opt) => opt.value !== 'acp')

type CustomProviderFormState = {
  displayName: string
  providerType: ProviderType
  modelId: string
  baseUrl: string
  apiKeyEnvVar: string
  isLocal: boolean
}

const DEFAULT_CUSTOM_PROVIDER_FORM: CustomProviderFormState = {
  displayName: '',
  providerType: 'custom',
  modelId: '',
  baseUrl: '',
  apiKeyEnvVar: '',
  isLocal: false,
}

// Group recommendations by layer
function groupByLayer(recs: RoleRecommendation[]): Map<RoleRecommendation['layer'], RoleRecommendation[]> {
  const map = new Map<RoleRecommendation['layer'], RoleRecommendation[]>()
  for (const layer of LAYER_ORDER) {
    const items = recs.filter((r) => r.layer === layer)
    if (items.length > 0) map.set(layer, items)
  }
  return map
}

// ---------------------------------------------------------------------------
// Edit drawer
// ---------------------------------------------------------------------------

interface EditDrawerProps {
  agent: AgentConfig | null
  providers: ProviderConfig[]
  onClose: () => void
  onSaved: () => void
}

function EditDrawer({ agent, providers, onClose, onSaved }: EditDrawerProps) {
  const [selectedProviderId, setSelectedProviderId] = useState<string>('')
  const [isCustomProvider, setIsCustomProvider] = useState(false)
  const [customProviderForm, setCustomProviderForm] = useState<CustomProviderFormState>(DEFAULT_CUSTOM_PROVIDER_FORM)
  const [systemPrompt, setSystemPrompt] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Sync form when agent changes
  useEffect(() => {
    if (agent) {
      const assignableProviderId = providers.some((provider) => provider.id === agent.providerConfigId)
        ? agent.providerConfigId
        : ''
      setSelectedProviderId(assignableProviderId ?? '')
      setIsCustomProvider(false)
      setCustomProviderForm({
        ...DEFAULT_CUSTOM_PROVIDER_FORM,
        displayName: `Custom ${agent.agentType === 'architect' ? 'Orchestrator' : agent.agentType}`,
      })
      setSystemPrompt(agent.systemPrompt)
      setError(null)
    }
  }, [agent, providers])

  const agentType = agent?.agentType
  const recs = agentType ? ROLE_RECOMMENDATIONS[agentType] ?? [] : []
  const recsByLayer = groupByLayer(recs)

  // Group providers by providerType for the select
  const providersByType = providers.reduce<Map<ProviderType, ProviderConfig[]>>((acc, p) => {
    const existing = acc.get(p.providerType) ?? []
    acc.set(p.providerType, [...existing, p])
    return acc
  }, new Map())

  function handleUseRecommendation(rec: RoleRecommendation) {
    // Find a provider that matches providerType + modelId
    const match = providers.find(
      (p) => p.providerType === rec.providerType && p.modelId === rec.modelId,
    )
    if (match) {
      setIsCustomProvider(false)
      setSelectedProviderId(match.id)
    } else {
      // No match — inform the user to create it first
      toast.info(`No provider found for ${rec.providerType} / ${rec.modelId}. Create it on the Providers page first.`)
    }
  }

  function setCustomProviderValue<K extends keyof CustomProviderFormState>(
    key: K,
    value: CustomProviderFormState[K],
  ) {
    setCustomProviderForm((current) => ({ ...current, [key]: value }))
  }

  function handleProviderSelection(value: string | null) {
    if (value === CUSTOM_PROVIDER_VALUE) {
      setIsCustomProvider(true)
      setSelectedProviderId('')
      return
    }

    setIsCustomProvider(false)
    setSelectedProviderId(value ?? '')
  }

  function handleCustomProviderTypeChange(value: string | null) {
    if (!value) return
    const providerType = value as ProviderType
    setCustomProviderForm((current) => ({
      ...current,
      providerType,
      isLocal: providerType === 'ollama',
    }))
  }

  async function createCustomProvider(agentType: AgentType): Promise<ProviderConfig> {
    const displayName = customProviderForm.displayName.trim()
    const modelId = customProviderForm.modelId.trim()
    const baseUrl = customProviderForm.baseUrl.trim() || null
    const apiKeyEnvVar = customProviderForm.isLocal ? null : customProviderForm.apiKeyEnvVar.trim() || null

    if (!displayName) {
      throw new Error('Display name is required for custom providers.')
    }
    if (!modelId) {
      throw new Error('Model ID is required for custom providers.')
    }
    if (requiresProviderBaseUrl(customProviderForm.providerType) && !baseUrl) {
      throw new Error('Base URL is required for this provider type.')
    }

    const res = await fetch('/api/providers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        displayName,
        providerType: customProviderForm.providerType,
        modelId,
        baseUrl,
        apiKeyEnvVar,
        isLocal: customProviderForm.isLocal,
      }),
    })

    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      throw new Error((body as { error?: string }).error ?? `Failed to create custom provider for ${agentType}`)
    }

    const created = await res.json() as { provider: ProviderConfig }
    return created.provider
  }

  async function handleSave() {
    if (!agent) return
    setError(null)

    const trimmedPrompt = systemPrompt.trim()
    if (!trimmedPrompt) {
      setError('System prompt cannot be empty.')
      return
    }

    setSubmitting(true)
    try {
      const providerConfigId = isCustomProvider
        ? (await createCustomProvider(agent.agentType)).id
        : selectedProviderId || null

      const res = await fetch(`/api/agents/${agent.agentType}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          providerConfigId,
          systemPrompt: trimmedPrompt,
        }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error((body as { error?: string }).error ?? 'Failed to save agent config')
      }
      toast.success('Saved — synced to disk')
      onSaved()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An unexpected error occurred')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Sheet open={agent !== null} onOpenChange={(open) => { if (!open) onClose() }}>
      <SheetContent
        side="right"
        className="flex w-full flex-col sm:max-w-[480px]"
        aria-labelledby="edit-agent-title"
      >
        {agent && agentType && (
          <>
            <SheetHeader>
              <SheetTitle id="edit-agent-title">
                <span aria-hidden="true">{AGENT_ICONS[agentType]} </span>
                {agentType.charAt(0).toUpperCase() + agentType.slice(1)} Agent
              </SheetTitle>
              <SheetDescription>{AGENT_DESCRIPTIONS[agentType]}</SheetDescription>
            </SheetHeader>

            <div className="flex flex-1 flex-col gap-5 overflow-y-auto px-4 py-2">
              {/* Provider dropdown */}
              <div className="flex flex-col gap-1.5">
                <label htmlFor="ea-provider" className="text-sm font-medium text-foreground">
                  Provider
                </label>
                <Select
                  value={isCustomProvider ? CUSTOM_PROVIDER_VALUE : selectedProviderId}
                  onValueChange={handleProviderSelection}
                >
                  <SelectTrigger id="ea-provider" className="w-full">
                    <SelectValue placeholder="None — use default" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value="">None — use default</SelectItem>
                      <SelectItem value={CUSTOM_PROVIDER_VALUE}>Custom</SelectItem>
                    </SelectGroup>
                    {providers.length > 0 && <SelectSeparator />}
                    {Array.from(providersByType.entries()).map(([type, group]) => (
                      <SelectGroup key={type}>
                        <SelectLabel>{PROVIDER_TYPE_LABELS[type]}</SelectLabel>
                        {group.map((p) => (
                          <SelectItem key={p.id} value={p.id}>
                            {p.displayName} ({p.modelId})
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {isCustomProvider && (
                <div className="grid gap-3 rounded-xl border border-border bg-muted/30 p-3">
                  <div className="flex flex-col gap-1.5">
                    <label htmlFor="ea-customDisplayName" className="text-sm font-medium text-foreground">
                      Display name
                    </label>
                    <input
                      id="ea-customDisplayName"
                      type="text"
                      value={customProviderForm.displayName}
                      onChange={(e) => setCustomProviderValue('displayName', e.target.value)}
                      className="rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                    />
                  </div>

                  <div className="flex flex-col gap-1.5">
                    <label htmlFor="ea-customProviderType" className="text-sm font-medium text-foreground">
                      Provider type
                    </label>
                    <Select
                      value={customProviderForm.providerType}
                      onValueChange={handleCustomProviderTypeChange}
                    >
                      <SelectTrigger id="ea-customProviderType" className="w-full">
                        <SelectValue placeholder="Select provider type" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          {ASSIGNABLE_PROVIDER_TYPE_OPTIONS.map((opt) => (
                            <SelectItem key={opt.value} value={opt.value}>
                              {opt.label}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="flex flex-col gap-1.5">
                    <label htmlFor="ea-customModelId" className="text-sm font-medium text-foreground">
                      Model ID
                    </label>
                    <input
                      id="ea-customModelId"
                      type="text"
                      value={customProviderForm.modelId}
                      onChange={(e) => setCustomProviderValue('modelId', e.target.value)}
                      placeholder="gpt-5.5 or provider/model"
                      className="rounded-lg border border-input bg-background px-3 py-2 font-mono text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                    />
                  </div>

                  {requiresProviderBaseUrl(customProviderForm.providerType) && (
                    <div className="flex flex-col gap-1.5">
                      <label htmlFor="ea-customBaseUrl" className="text-sm font-medium text-foreground">
                        Base URL
                      </label>
                      <input
                        id="ea-customBaseUrl"
                        type="url"
                        value={customProviderForm.baseUrl}
                        onChange={(e) => setCustomProviderValue('baseUrl', e.target.value)}
                        placeholder={customProviderForm.providerType === 'ollama' ? 'http://localhost:11434' : 'https://api.example.com/v1'}
                        className="rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                      />
                    </div>
                  )}

                  {!customProviderForm.isLocal && (
                    <div className="flex flex-col gap-1.5">
                      <label htmlFor="ea-customApiKeyEnvVar" className="text-sm font-medium text-foreground">
                        API key environment variable
                      </label>
                      <input
                        id="ea-customApiKeyEnvVar"
                        type="text"
                        value={customProviderForm.apiKeyEnvVar}
                        onChange={(e) => setCustomProviderValue('apiKeyEnvVar', e.target.value)}
                        placeholder="OPENAI_API_KEY"
                        className="rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                      />
                    </div>
                  )}

                  <div className="flex items-center gap-3">
                    <input
                      id="ea-customIsLocal"
                      type="checkbox"
                      checked={customProviderForm.isLocal}
                      onChange={(e) => setCustomProviderValue('isLocal', e.target.checked)}
                      className="size-4 rounded border-input accent-primary"
                    />
                    <label htmlFor="ea-customIsLocal" className="text-sm font-medium text-foreground">
                      Local provider
                    </label>
                  </div>
                </div>
              )}

              {/* Recommendations */}
              {recsByLayer.size > 0 && (
                <div className="rounded-xl border border-border bg-muted/30 p-3">
                  <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Recommended providers
                  </p>
                  <div className="flex flex-col gap-3">
                    {Array.from(recsByLayer.entries()).map(([layer, items]) => (
                      <div key={layer}>
                        <p className="mb-1.5 text-xs font-medium text-foreground">{layer}</p>
                        <div className="flex flex-col gap-1.5">
                          {items.map((rec) => (
                            <div
                              key={`${rec.providerType}:${rec.modelId}`}
                              className="flex items-start justify-between gap-2 rounded-lg border border-border bg-background px-3 py-2"
                            >
                              <div className="flex min-w-0 flex-col gap-0.5">
                                <span className="flex items-center gap-1.5">
                                  <span className="font-mono text-xs text-foreground truncate">
                                    {rec.modelId}
                                  </span>
                                  <span
                                    className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
                                      rec.tier === 'Best'
                                        ? 'bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-300'
                                        : 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300'
                                    }`}
                                  >
                                    {rec.tier}
                                  </span>
                                </span>
                                <span className="text-[11px] text-muted-foreground leading-relaxed">
                                  {rec.note}
                                </span>
                              </div>
                              <Button
                                size="xs"
                                variant="outline"
                                className="shrink-0"
                                onClick={() => handleUseRecommendation(rec)}
                                aria-label={`Use ${rec.modelId} for this agent`}
                              >
                                Use this
                              </Button>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* System prompt */}
              <div className="flex flex-col gap-1.5">
                <label htmlFor="ea-systemPrompt" className="text-sm font-medium text-foreground">
                  System prompt
                </label>
                <textarea
                  id="ea-systemPrompt"
                  value={systemPrompt}
                  onChange={(e) => setSystemPrompt(e.target.value)}
                  rows={12}
                  className="min-h-[300px] resize-y rounded-lg border border-input bg-transparent px-3 py-2 font-mono text-xs leading-relaxed text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                  aria-label="System prompt for this agent"
                />
              </div>

              {error !== null && (
                <p role="alert" aria-live="assertive" className="text-sm text-destructive">
                  {error}
                </p>
              )}
            </div>

            <SheetFooter>
              <Button
                onClick={handleSave}
                disabled={submitting}
                aria-busy={submitting}
                className="w-full"
              >
                {submitting ? 'Saving…' : 'Save'}
              </Button>
            </SheetFooter>
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function AgentsPage() {
  const [agents, setAgents] = useState<AgentConfig[]>([])
  const [providers, setProviders] = useState<ProviderConfig[]>([])
  const [loading, setLoading] = useState(true)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [editingAgent, setEditingAgent] = useState<AgentConfig | null>(null)
  const [applyingPreset, setApplyingPreset] = useState<string | null>(null)
  const [presetError, setPresetError] = useState<string | null>(null)

  // ---------------------------------------------------------------------------
  // Load data
  // ---------------------------------------------------------------------------

  const loadData = useCallback(async () => {
    setLoading(true)
    setFetchError(null)
    try {
      const [agentsRes, providersRes] = await Promise.all([
        fetch('/api/agents'),
        fetch('/api/providers'),
      ])

      if (!agentsRes.ok) {
        const body = await agentsRes.json().catch(() => ({}))
        throw new Error((body as { error?: string }).error ?? 'Failed to load agents')
      }
      if (!providersRes.ok) {
        const body = await providersRes.json().catch(() => ({}))
        throw new Error((body as { error?: string }).error ?? 'Failed to load providers')
      }

      const agentsData = await agentsRes.json() as { agents: AgentConfig[] }
      const providersData = await providersRes.json() as { providers: ProviderConfig[] }

      // Ensure all six agent types are represented, inserting stubs if absent
      const byType = new Map<AgentType, AgentConfig>()
      for (const a of agentsData.agents ?? []) byType.set(a.agentType, a)

      const full: AgentConfig[] = AGENT_TYPES.map((type) =>
        byType.get(type) ?? {
          id: '',
          agentType: type,
          providerConfigId: null,
          systemPrompt: '',
          frontmatterOverrides: null,
          updatedAt: '',
        },
      )

      setAgents(full)
      setProviders(providersData.providers ?? [])
    } catch (err) {
      setFetchError(err instanceof Error ? err.message : 'An unexpected error occurred')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadData()
  }, [loadData])

  // ---------------------------------------------------------------------------
  // Provider lookup
  // ---------------------------------------------------------------------------

  const providerById = useCallback(
    (id: string | null): ProviderConfig | undefined => {
      if (!id) return undefined
      return providers.find((p) => p.id === id)
    },
    [providers],
  )
  const assignableProviders = providers.filter((provider) => provider.providerType !== 'acp')

  // ---------------------------------------------------------------------------
  // Apply recommended configuration (preset) — configures providers + agents
  // ---------------------------------------------------------------------------

  async function handleApplyPreset(presetId: string) {
    const preset = PRESETS.find((p) => p.id === presetId)
    if (!preset) return

    setApplyingPreset(presetId)
    setPresetError(null)

    try {
      await applyPreset(preset)
      await loadData()
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
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-foreground">Agent Configs</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Configure which model each agent role uses and customise its system prompt.
        </p>
      </div>

      {/* Loading */}
      {loading && (
        <div className="flex items-center justify-center py-16" role="status" aria-live="polite">
          <span className="text-sm text-muted-foreground">Loading agent configs…</span>
        </div>
      )}

      {/* Error */}
      {!loading && fetchError !== null && (
        <div
          role="alert"
          className="mb-4 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive"
        >
          {fetchError}
          <button
            onClick={loadData}
            className="ml-2 underline underline-offset-2 hover:no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Retry
          </button>
        </div>
      )}

      {/* Table */}
      {!loading && fetchError === null && (
        <div className="overflow-x-auto rounded-xl border border-border">
          <table className="min-w-full text-sm" role="table" aria-label="Agent configurations">
            <thead>
              <tr className="border-b border-border bg-muted/40">
                <th scope="col" className="px-4 py-3 text-left font-medium text-muted-foreground">Agent</th>
                <th scope="col" className="px-4 py-3 text-left font-medium text-muted-foreground">Assigned provider</th>
                <th scope="col" className="px-4 py-3 text-left font-medium text-muted-foreground">Model ID</th>
                <th scope="col" className="px-4 py-3 text-right font-medium text-muted-foreground">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {agents.map((agent) => {
                const provider = providerById(agent.providerConfigId)
                return (
                  <tr key={agent.agentType} className="border-b border-border last:border-0 hover:bg-muted/30">
                    <td className="px-4 py-3">
                      <span className="flex items-center gap-2 font-medium text-foreground">
                        <span aria-hidden="true">{AGENT_ICONS[agent.agentType]}</span>
                        {agent.agentType.charAt(0).toUpperCase() + agent.agentType.slice(1)}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {provider ? provider.displayName : '—'}
                    </td>
                    <td className="px-4 py-3">
                      {provider ? (
                        <span
                          className="block max-w-[200px] truncate font-mono text-xs text-foreground"
                          title={provider.modelId}
                        >
                          {provider.modelId}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end">
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Edit ${agent.agentType} agent config`}
                          title={`Edit ${agent.agentType}`}
                          onClick={() => setEditingAgent(agent)}
                        >
                          <PencilIcon className="size-4 text-muted-foreground" aria-hidden="true" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Recommended configurations — apply a vetted provider + agent setup */}
      {!loading && fetchError === null && (
        <section aria-labelledby="presets-heading" className="mt-10">
          <h2 id="presets-heading" className="mb-1 text-lg font-semibold text-foreground">
            Recommended configurations
          </h2>
          <p className="mb-4 text-sm text-muted-foreground">
            Apply a vetted setup to configure providers and assign a model to every agent
            in one step.
          </p>
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
      )}

      {/* Edit drawer */}
      <EditDrawer
        agent={editingAgent}
        providers={assignableProviders}
        onClose={() => setEditingAgent(null)}
        onSaved={loadData}
      />
    </div>
  )
}
