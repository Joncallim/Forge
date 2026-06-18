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
import { ROLE_RECOMMENDATIONS, type RoleRecommendation } from '@/lib/recommendations'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type AgentType = 'architect' | 'backend' | 'frontend' | 'qa' | 'reviewer' | 'devops'

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
  const [systemPrompt, setSystemPrompt] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Sync form when agent changes
  useEffect(() => {
    if (agent) {
      setSelectedProviderId(agent.providerConfigId ?? '')
      setSystemPrompt(agent.systemPrompt)
      setError(null)
    }
  }, [agent])

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
      setSelectedProviderId(match.id)
    } else {
      // No match — inform the user to create it first
      toast.info(`No provider found for ${rec.providerType} / ${rec.modelId}. Create it on the Providers page first.`)
    }
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
      const res = await fetch(`/api/agents/${agent.agentType}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          providerConfigId: selectedProviderId || null,
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
                  value={selectedProviderId}
                  onValueChange={(value) => setSelectedProviderId(value ?? '')}
                >
                  <SelectTrigger id="ea-provider" className="w-full">
                    <SelectValue placeholder="None — use default" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value="">None — use default</SelectItem>
                    </SelectGroup>
                    {providers.length > 0 && <SelectSeparator />}
                    {Array.from(providersByType.entries()).map(([type, group]) => (
                      <SelectGroup key={type}>
                        <SelectLabel>{type}</SelectLabel>
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

      {/* Edit drawer */}
      <EditDrawer
        agent={editingAgent}
        providers={providers}
        onClose={() => setEditingAgent(null)}
        onSaved={loadData}
      />
    </div>
  )
}
