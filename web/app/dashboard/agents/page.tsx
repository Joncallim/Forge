'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { BotIcon, PencilIcon, PlusIcon, Trash2Icon, UsersIcon } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
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

type ProviderConfig = {
  id: string
  displayName: string
  providerType: ProviderType
  modelId: string
  baseUrl: string | null
  apiKeyEnvVar: string | null
  isLocal: boolean
  isActive: boolean
}

type AgentConfig = {
  id: string
  agentType: string
  displayName: string
  description: string
  isSystem: boolean
  isActive: boolean
  providerConfigId: string | null
  systemPrompt: string
  frontmatterOverrides: Record<string, unknown> | null
  updatedAt: string
}

type WorkforceMember = {
  id: string
  workforceId: string
  agentConfigId: string
  roleLabel: string | null
  sequence: number
  isRequired: boolean
  agentType: string
  displayName: string
  description: string
  isActive: boolean
}

type Workforce = {
  id: string
  slug: string
  displayName: string
  description: string
  isDefault: boolean
  isActive: boolean
  members: WorkforceMember[]
}

type CustomProviderFormState = {
  displayName: string
  providerType: ProviderType
  modelId: string
  baseUrl: string
  apiKey: string
  isLocal: boolean
}

type AgentDraft = {
  agentType: string
  displayName: string
  description: string
  providerConfigId: string
  systemPrompt: string
  isActive: boolean
}

type WorkforceDraft = {
  slug: string
  displayName: string
  description: string
  isDefault: boolean
  isActive: boolean
  memberIds: string[]
  roleLabels: Record<string, string>
}

const CUSTOM_PROVIDER_VALUE = '__custom_provider__'
const ASSIGNABLE_PROVIDER_TYPE_OPTIONS = PROVIDER_TYPE_OPTIONS.filter((opt) => opt.value !== 'acp')
const LAYER_ORDER: RoleRecommendation['layer'][] = [
  'Anthropic API',
  'OpenAI API',
  'OpenRouter',
  'LiteLLM',
  'Ollama',
]

const DEFAULT_CUSTOM_PROVIDER_FORM: CustomProviderFormState = {
  displayName: '',
  providerType: 'custom',
  modelId: '',
  baseUrl: '',
  apiKey: '',
  isLocal: false,
}

const EMPTY_AGENT_DRAFT: AgentDraft = {
  agentType: '',
  displayName: '',
  description: '',
  providerConfigId: '',
  systemPrompt: '',
  isActive: true,
}

const EMPTY_WORKFORCE_DRAFT: WorkforceDraft = {
  slug: '',
  displayName: '',
  description: '',
  isDefault: false,
  isActive: true,
  memberIds: [],
  roleLabels: {},
}

function titleize(value: string): string {
  return value
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function groupByLayer(recs: RoleRecommendation[]): Map<RoleRecommendation['layer'], RoleRecommendation[]> {
  const map = new Map<RoleRecommendation['layer'], RoleRecommendation[]>()
  for (const layer of LAYER_ORDER) {
    const items = recs.filter((r) => r.layer === layer)
    if (items.length > 0) map.set(layer, items)
  }
  return map
}

function providerOptionLabel(provider: ProviderConfig): string {
  return `${provider.displayName} (${provider.modelId})`
}

async function readJsonError(response: Response, fallback: string): Promise<Error> {
  const body = await response.json().catch(() => ({})) as { error?: string }
  return new Error(body.error ?? fallback)
}

function AgentEditor({
  agent,
  providers,
  onClose,
  onSaved,
}: {
  agent: AgentConfig | 'new' | null
  providers: ProviderConfig[]
  onClose: () => void
  onSaved: () => void | Promise<void>
}) {
  const isOpen = agent !== null
  const isNew = agent === 'new'
  const [draft, setDraft] = useState<AgentDraft>(EMPTY_AGENT_DRAFT)
  const [isCustomProvider, setIsCustomProvider] = useState(false)
  const [customProviderForm, setCustomProviderForm] = useState<CustomProviderFormState>(DEFAULT_CUSTOM_PROVIDER_FORM)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!agent) return
    if (agent === 'new') {
      setDraft(EMPTY_AGENT_DRAFT)
      setCustomProviderForm(DEFAULT_CUSTOM_PROVIDER_FORM)
    } else {
      setDraft({
        agentType: agent.agentType,
        displayName: agent.displayName || titleize(agent.agentType),
        description: agent.description,
        providerConfigId: agent.providerConfigId ?? '',
        systemPrompt: agent.systemPrompt,
        isActive: agent.isActive,
      })
      setCustomProviderForm({
        ...DEFAULT_CUSTOM_PROVIDER_FORM,
        displayName: `Custom ${agent.displayName || agent.agentType}`,
      })
    }
    setIsCustomProvider(false)
    setError(null)
  }, [agent])

  const recsByLayer = groupByLayer(ROLE_RECOMMENDATIONS[draft.agentType] ?? [])
  const providersByType = providers.reduce<Map<ProviderType, ProviderConfig[]>>((acc, p) => {
    const existing = acc.get(p.providerType) ?? []
    acc.set(p.providerType, [...existing, p])
    return acc
  }, new Map())
  const selectedProvider = providers.find((provider) => provider.id === draft.providerConfigId)

  function setDraftValue<K extends keyof AgentDraft>(key: K, value: AgentDraft[K]) {
    setDraft((current) => {
      const next = { ...current, [key]: value }
      if (key === 'displayName' && isNew && current.agentType.trim() === '') {
        next.agentType = slugify(String(value))
      }
      return next
    })
  }

  function setCustomProviderValue<K extends keyof CustomProviderFormState>(
    key: K,
    value: CustomProviderFormState[K],
  ) {
    setCustomProviderForm((current) => ({ ...current, [key]: value }))
  }

  function handleUseRecommendation(rec: RoleRecommendation) {
    const match = providers.find(
      (p) => p.providerType === rec.providerType && p.modelId === rec.modelId,
    )
    if (match) {
      setIsCustomProvider(false)
      setDraftValue('providerConfigId', match.id)
    } else {
      toast.info(`No provider found for ${rec.providerType} / ${rec.modelId}. Create it on the Providers page first.`)
    }
  }

  async function createCustomProvider(): Promise<ProviderConfig> {
    const displayName = customProviderForm.displayName.trim()
    const modelId = customProviderForm.modelId.trim()
    const baseUrl = customProviderForm.baseUrl.trim() || null
    const apiKey = customProviderForm.isLocal ? null : customProviderForm.apiKey.trim() || null

    if (!displayName) throw new Error('Display name is required for custom providers.')
    if (!modelId) throw new Error('Model ID is required for custom providers.')
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
        apiKey,
        isLocal: customProviderForm.isLocal,
      }),
    })

    if (!res.ok) throw await readJsonError(res, 'Failed to create custom provider')
    const created = await res.json() as { provider: ProviderConfig }
    return created.provider
  }

  async function handleSave() {
    const agentType = draft.agentType.trim()
    const displayName = draft.displayName.trim()
    const systemPrompt = draft.systemPrompt.trim()

    setError(null)
    if (!agentType) {
      setError('Agent slug is required.')
      return
    }
    if (!displayName) {
      setError('Display name is required.')
      return
    }
    if (!systemPrompt) {
      setError('System prompt cannot be empty.')
      return
    }

    setSubmitting(true)
    try {
      const providerConfigId = isCustomProvider
        ? (await createCustomProvider()).id
        : draft.providerConfigId || null

      const payload = {
        agentType,
        displayName,
        description: draft.description.trim(),
        providerConfigId,
        systemPrompt,
        isActive: draft.isActive,
      }

      const res = await fetch(isNew ? '/api/agents' : `/api/agents/${encodeURIComponent(agentType)}`, {
        method: isNew ? 'POST' : 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })

      if (!res.ok) throw await readJsonError(res, 'Failed to save agent')
      toast.success(isNew ? 'Agent created' : 'Agent saved')
      onClose()
      await onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An unexpected error occurred')
    } finally {
      setSubmitting(false)
    }
  }

  async function handleArchive() {
    if (agent === null || agent === 'new') return
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch(`/api/agents/${encodeURIComponent(agent.agentType)}`, { method: 'DELETE' })
      if (!res.ok) throw await readJsonError(res, 'Failed to archive agent')
      toast.success('Agent archived')
      onClose()
      await onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An unexpected error occurred')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Sheet open={isOpen} onOpenChange={(open) => { if (!open) onClose() }}>
      <SheetContent side="right" className="flex w-full flex-col sm:max-w-[560px]">
        <SheetHeader>
          <SheetTitle>{isNew ? 'Add Agent' : 'Edit Agent'}</SheetTitle>
          <SheetDescription>
            Agents are reusable worker identities. Add specialists here, then assign them to one or more workforces.
          </SheetDescription>
        </SheetHeader>

        <div className="flex flex-1 flex-col gap-5 overflow-y-auto px-4 py-2">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="agent-display-name" className="text-sm font-medium text-foreground">
                Display name
              </label>
              <input
                id="agent-display-name"
                value={draft.displayName}
                onChange={(e) => setDraftValue('displayName', e.target.value)}
                className="rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="agent-slug" className="text-sm font-medium text-foreground">
                Agent slug
              </label>
              <input
                id="agent-slug"
                value={draft.agentType}
                disabled={!isNew}
                onChange={(e) => setDraftValue('agentType', slugify(e.target.value))}
                className="rounded-lg border border-input bg-background px-3 py-2 font-mono text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-60"
              />
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="agent-description" className="text-sm font-medium text-foreground">
              Description
            </label>
            <textarea
              id="agent-description"
              value={draft.description}
              onChange={(e) => setDraftValue('description', e.target.value)}
              rows={3}
              className="resize-y rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="agent-provider" className="text-sm font-medium text-foreground">
              Provider
            </label>
            <Select
              value={isCustomProvider ? CUSTOM_PROVIDER_VALUE : draft.providerConfigId}
              onValueChange={(value) => {
                if (value === CUSTOM_PROVIDER_VALUE) {
                  setIsCustomProvider(true)
                  setDraftValue('providerConfigId', '')
                  return
                }
                setIsCustomProvider(false)
                setDraftValue('providerConfigId', value ?? '')
              }}
            >
              <SelectTrigger id="agent-provider" className="w-full">
                <SelectValue placeholder="None - use default">
                  {isCustomProvider
                    ? 'Custom'
                    : selectedProvider
                      ? providerOptionLabel(selectedProvider)
                      : 'None - use default'}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="">None - use default</SelectItem>
                  <SelectItem value={CUSTOM_PROVIDER_VALUE}>Custom</SelectItem>
                </SelectGroup>
                {providers.length > 0 && <SelectSeparator />}
                {Array.from(providersByType.entries()).map(([type, group]) => (
                  <SelectGroup key={type}>
                    <SelectLabel>{PROVIDER_TYPE_LABELS[type]}</SelectLabel>
                    {group.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {providerOptionLabel(p)}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                ))}
              </SelectContent>
            </Select>
          </div>

          {isCustomProvider && (
            <div className="grid gap-3 rounded-lg border border-border bg-muted/30 p-3">
              <input
                aria-label="Custom provider display name"
                value={customProviderForm.displayName}
                onChange={(e) => setCustomProviderValue('displayName', e.target.value)}
                placeholder="Display name"
                className="rounded-lg border border-input bg-background px-3 py-2 text-sm"
              />
              <Select
                value={customProviderForm.providerType}
                onValueChange={(value) => {
                  const providerType = value as ProviderType
                  setCustomProviderForm((current) => ({
                    ...current,
                    providerType,
                    isLocal: providerType === 'ollama',
                  }))
                }}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Provider type" />
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
              <input
                aria-label="Custom provider model id"
                value={customProviderForm.modelId}
                onChange={(e) => setCustomProviderValue('modelId', e.target.value)}
                placeholder="Model ID"
                className="rounded-lg border border-input bg-background px-3 py-2 font-mono text-sm"
              />
              {requiresProviderBaseUrl(customProviderForm.providerType) && (
                <input
                  aria-label="Custom provider base URL"
                  value={customProviderForm.baseUrl}
                  onChange={(e) => setCustomProviderValue('baseUrl', e.target.value)}
                  placeholder="Base URL"
                  className="rounded-lg border border-input bg-background px-3 py-2 text-sm"
                />
              )}
              {!customProviderForm.isLocal && (
                <input
                  aria-label="Custom provider API key"
                  type="password"
                  value={customProviderForm.apiKey}
                  onChange={(e) => setCustomProviderValue('apiKey', e.target.value)}
                  placeholder="API key"
                  className="rounded-lg border border-input bg-background px-3 py-2 text-sm"
                />
              )}
            </div>
          )}

          {recsByLayer.size > 0 && (
            <div className="rounded-lg border border-border bg-muted/30 p-3">
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
                          <div className="min-w-0">
                            <p className="truncate font-mono text-xs text-foreground">{rec.modelId}</p>
                            <p className="text-[11px] leading-relaxed text-muted-foreground">{rec.note}</p>
                          </div>
                          <Button size="xs" variant="outline" onClick={() => handleUseRecommendation(rec)}>
                            Use
                          </Button>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="flex flex-col gap-1.5">
            <label htmlFor="agent-prompt" className="text-sm font-medium text-foreground">
              System prompt
            </label>
            <textarea
              id="agent-prompt"
              value={draft.systemPrompt}
              onChange={(e) => setDraftValue('systemPrompt', e.target.value)}
              rows={14}
              className="min-h-[320px] resize-y rounded-lg border border-input bg-background px-3 py-2 font-mono text-xs leading-relaxed outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            />
          </div>

          <label className="flex items-center gap-3 text-sm font-medium text-foreground">
            <input
              type="checkbox"
              checked={draft.isActive}
              onChange={(e) => setDraftValue('isActive', e.target.checked)}
              className="size-4 rounded border-input accent-primary"
            />
            Active
          </label>

          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
        </div>

        <SheetFooter className="gap-2">
          {!isNew && agent !== null && (
            <Button variant="outline" onClick={handleArchive} disabled={submitting}>
              <Trash2Icon className="size-4" aria-hidden="true" />
              Archive
            </Button>
          )}
          <Button onClick={handleSave} disabled={submitting}>
            {submitting ? 'Saving...' : 'Save'}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}

function WorkforceEditor({
  workforce,
  agents,
  onClose,
  onSaved,
}: {
  workforce: Workforce | 'new' | null
  agents: AgentConfig[]
  onClose: () => void
  onSaved: () => void | Promise<void>
}) {
  const isOpen = workforce !== null
  const isNew = workforce === 'new'
  const [draft, setDraft] = useState<WorkforceDraft>(EMPTY_WORKFORCE_DRAFT)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!workforce) return
    if (workforce === 'new') {
      setDraft(EMPTY_WORKFORCE_DRAFT)
    } else {
      setDraft({
        slug: workforce.slug,
        displayName: workforce.displayName,
        description: workforce.description,
        isDefault: workforce.isDefault,
        isActive: workforce.isActive,
        memberIds: workforce.members.map((member) => member.agentConfigId),
        roleLabels: Object.fromEntries(
          workforce.members.map((member) => [member.agentConfigId, member.roleLabel ?? '']),
        ),
      })
    }
    setError(null)
  }, [workforce])

  function setDraftValue<K extends keyof WorkforceDraft>(key: K, value: WorkforceDraft[K]) {
    setDraft((current) => {
      const next = { ...current, [key]: value }
      if (key === 'displayName' && isNew && current.slug.trim() === '') {
        next.slug = slugify(String(value))
      }
      return next
    })
  }

  function toggleMember(agentId: string, checked: boolean) {
    setDraft((current) => ({
      ...current,
      memberIds: checked
        ? [...current.memberIds, agentId]
        : current.memberIds.filter((id) => id !== agentId),
    }))
  }

  async function handleSave() {
    const displayName = draft.displayName.trim()
    const slug = draft.slug.trim()
    setError(null)
    if (!displayName) {
      setError('Display name is required.')
      return
    }
    if (!slug) {
      setError('Slug is required.')
      return
    }

    setSubmitting(true)
    try {
      const members = draft.memberIds.map((agentConfigId, index) => ({
        agentConfigId,
        roleLabel: draft.roleLabels[agentConfigId]?.trim() || null,
        sequence: index + 1,
        isRequired: true,
      }))

      const res = await fetch(isNew ? '/api/workforces' : `/api/workforces/${(workforce as Workforce).id}`, {
        method: isNew ? 'POST' : 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          slug,
          displayName,
          description: draft.description.trim(),
          isDefault: draft.isDefault,
          isActive: draft.isActive,
          members,
        }),
      })

      if (!res.ok) throw await readJsonError(res, 'Failed to save workforce')
      toast.success(isNew ? 'Workforce created' : 'Workforce saved')
      onClose()
      await onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An unexpected error occurred')
    } finally {
      setSubmitting(false)
    }
  }

  async function handleArchive() {
    if (workforce === null || workforce === 'new') return
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch(`/api/workforces/${workforce.id}`, { method: 'DELETE' })
      if (!res.ok) throw await readJsonError(res, 'Failed to archive workforce')
      toast.success('Workforce archived')
      onClose()
      await onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An unexpected error occurred')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Sheet open={isOpen} onOpenChange={(open) => { if (!open) onClose() }}>
      <SheetContent side="right" className="flex w-full flex-col sm:max-w-[560px]">
        <SheetHeader>
          <SheetTitle>{isNew ? 'Add Workforce' : 'Edit Workforce'}</SheetTitle>
          <SheetDescription>
            Workforces are reusable teams of agents. Assign any active agent to any workforce.
          </SheetDescription>
        </SheetHeader>

        <div className="flex flex-1 flex-col gap-5 overflow-y-auto px-4 py-2">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="workforce-display-name" className="text-sm font-medium text-foreground">
                Display name
              </label>
              <input
                id="workforce-display-name"
                value={draft.displayName}
                onChange={(e) => setDraftValue('displayName', e.target.value)}
                className="rounded-lg border border-input bg-background px-3 py-2 text-sm"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="workforce-slug" className="text-sm font-medium text-foreground">
                Slug
              </label>
              <input
                id="workforce-slug"
                value={draft.slug}
                onChange={(e) => setDraftValue('slug', slugify(e.target.value))}
                className="rounded-lg border border-input bg-background px-3 py-2 font-mono text-sm"
              />
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="workforce-description" className="text-sm font-medium text-foreground">
              Description
            </label>
            <textarea
              id="workforce-description"
              value={draft.description}
              onChange={(e) => setDraftValue('description', e.target.value)}
              rows={3}
              className="resize-y rounded-lg border border-input bg-background px-3 py-2 text-sm"
            />
          </div>

          <div className="flex gap-5">
            <label className="flex items-center gap-3 text-sm font-medium text-foreground">
              <input
                type="checkbox"
                checked={draft.isDefault}
                onChange={(e) => setDraftValue('isDefault', e.target.checked)}
                className="size-4 rounded border-input accent-primary"
              />
              Default
            </label>
            <label className="flex items-center gap-3 text-sm font-medium text-foreground">
              <input
                type="checkbox"
                checked={draft.isActive}
                onChange={(e) => setDraftValue('isActive', e.target.checked)}
                className="size-4 rounded border-input accent-primary"
              />
              Active
            </label>
          </div>

          <div className="flex flex-col gap-2">
            <p className="text-sm font-medium text-foreground">Agents</p>
            {agents.length === 0 ? (
              <p className="rounded-lg border border-border px-3 py-2 text-sm text-muted-foreground">
                Add an agent before building a workforce.
              </p>
            ) : (
              <div className="flex flex-col gap-2">
                {agents.map((agent) => {
                  const selected = draft.memberIds.includes(agent.id)
                  return (
                    <div key={agent.id} className="rounded-lg border border-border p-3">
                      <label className="flex items-start gap-3">
                        <input
                          type="checkbox"
                          checked={selected}
                          onChange={(e) => toggleMember(agent.id, e.target.checked)}
                          className="mt-1 size-4 rounded border-input accent-primary"
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block font-medium text-foreground">
                            {agent.displayName || titleize(agent.agentType)}
                          </span>
                          <span className="block truncate font-mono text-xs text-muted-foreground">
                            {agent.agentType}
                          </span>
                        </span>
                      </label>
                      {selected && (
                        <input
                          aria-label={`Role label for ${agent.displayName || agent.agentType}`}
                          value={draft.roleLabels[agent.id] ?? ''}
                          onChange={(e) => {
                            setDraft((current) => ({
                              ...current,
                              roleLabels: { ...current.roleLabels, [agent.id]: e.target.value },
                            }))
                          }}
                          placeholder="Optional role label in this workforce"
                          className="mt-3 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm"
                        />
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
        </div>

        <SheetFooter className="gap-2">
          {!isNew && workforce !== null && (
            <Button variant="outline" onClick={handleArchive} disabled={submitting}>
              <Trash2Icon className="size-4" aria-hidden="true" />
              Archive
            </Button>
          )}
          <Button onClick={handleSave} disabled={submitting}>
            {submitting ? 'Saving...' : 'Save'}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}

export default function AgentsPage() {
  const [agents, setAgents] = useState<AgentConfig[]>([])
  const [workforces, setWorkforces] = useState<Workforce[]>([])
  const [providers, setProviders] = useState<ProviderConfig[]>([])
  const [loading, setLoading] = useState(true)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [editingAgent, setEditingAgent] = useState<AgentConfig | 'new' | null>(null)
  const [editingWorkforce, setEditingWorkforce] = useState<Workforce | 'new' | null>(null)
  const [applyingPreset, setApplyingPreset] = useState<string | null>(null)
  const [presetError, setPresetError] = useState<string | null>(null)

  const loadData = useCallback(async () => {
    setLoading(true)
    setFetchError(null)
    try {
      const [agentsRes, providersRes, workforcesRes] = await Promise.all([
        fetch('/api/agents'),
        fetch('/api/providers'),
        fetch('/api/workforces'),
      ])

      if (!agentsRes.ok) throw await readJsonError(agentsRes, 'Failed to load agents')
      if (!providersRes.ok) throw await readJsonError(providersRes, 'Failed to load providers')
      if (!workforcesRes.ok) throw await readJsonError(workforcesRes, 'Failed to load workforces')

      const agentsData = await agentsRes.json() as { agents: AgentConfig[] }
      const providersData = await providersRes.json() as { providers: ProviderConfig[] }
      const workforcesData = await workforcesRes.json() as { workforces: Workforce[] }

      setAgents(agentsData.agents ?? [])
      setProviders(providersData.providers ?? [])
      setWorkforces(workforcesData.workforces ?? [])
    } catch (err) {
      setFetchError(err instanceof Error ? err.message : 'An unexpected error occurred')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadData()
  }, [loadData])

  const assignableProviders = providers.filter((provider) => provider.providerType !== 'acp')
  const activeAgents = useMemo(() => agents.filter((agent) => agent.isActive), [agents])

  const providerById = useCallback(
    (id: string | null): ProviderConfig | undefined => {
      if (!id) return undefined
      return providers.find((p) => p.id === id)
    },
    [providers],
  )

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

  return (
    <div className="px-4 py-6 sm:px-6 lg:px-8">
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold text-foreground">Agents And Workforces</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Add any specialist agent, assign providers and prompts, then group agents into editable workforces.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => setEditingWorkforce('new')}>
            <UsersIcon className="size-4" aria-hidden="true" />
            Add Workforce
          </Button>
          <Button onClick={() => setEditingAgent('new')}>
            <PlusIcon className="size-4" aria-hidden="true" />
            Add Agent
          </Button>
        </div>
      </div>

      {loading && (
        <div className="flex items-center justify-center py-16" role="status" aria-live="polite">
          <span className="text-sm text-muted-foreground">Loading agents and workforces...</span>
        </div>
      )}

      {!loading && fetchError && (
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

      {!loading && !fetchError && (
        <div className="grid gap-8">
          <section aria-labelledby="agents-heading">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <h2 id="agents-heading" className="text-lg font-semibold text-foreground">
                  Agents
                </h2>
                <p className="text-sm text-muted-foreground">
                  These records drive provider assignment and prompt configuration.
                </p>
              </div>
            </div>

            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full min-w-[760px] table-fixed text-sm" aria-label="Agent configurations">
                <thead>
                  <tr className="border-b border-border bg-muted/40">
                    <th scope="col" className="w-[52%] px-4 py-3 text-left font-medium text-muted-foreground">Agent</th>
                    <th scope="col" className="w-[25%] px-4 py-3 text-left font-medium text-muted-foreground">Provider</th>
                    <th scope="col" className="w-[15%] px-4 py-3 text-left font-medium text-muted-foreground">Status</th>
                    <th scope="col" className="w-[8%] px-4 py-3 text-right font-medium text-muted-foreground">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {agents.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="px-4 py-8 text-center text-muted-foreground">
                        No agents configured.
                      </td>
                    </tr>
                  ) : (
                    agents.map((agent) => {
                      const provider = providerById(agent.providerConfigId)
                      return (
                        <tr key={agent.id} className="border-b border-border last:border-0 hover:bg-muted/30">
                          <td className="px-4 py-3">
                            <div className="flex min-w-0 items-start gap-3">
                              <BotIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                              <div className="min-w-0">
                                <p className="font-medium text-foreground">
                                  {agent.displayName || titleize(agent.agentType)}
                                </p>
                                <p className="break-all font-mono text-xs text-muted-foreground">{agent.agentType}</p>
                                {agent.description && (
                                  <p className="mt-1 max-w-xl break-words text-xs text-muted-foreground">
                                    {agent.description}
                                  </p>
                                )}
                              </div>
                            </div>
                          </td>
                          <td className="px-4 py-3">
                            {provider ? (
                              <div className="min-w-0">
                                <p className="break-words leading-snug text-foreground">{provider.displayName}</p>
                                <p className="break-all font-mono text-xs leading-snug text-muted-foreground">
                                  {provider.modelId}
                                </p>
                              </div>
                            ) : (
                              <span className="text-muted-foreground">None</span>
                            )}
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex flex-wrap gap-1.5">
                              <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                                {agent.isActive ? 'Active' : 'Archived'}
                              </span>
                              {agent.isSystem && (
                                <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                                  Seeded
                                </span>
                              )}
                            </div>
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex justify-end">
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                aria-label={`Edit ${agent.displayName || agent.agentType}`}
                                onClick={() => setEditingAgent(agent)}
                              >
                                <PencilIcon className="size-4 text-muted-foreground" aria-hidden="true" />
                              </Button>
                            </div>
                          </td>
                        </tr>
                      )
                    })
                  )}
                </tbody>
              </table>
            </div>
          </section>

          <section aria-labelledby="workforces-heading">
            <div className="mb-3">
              <h2 id="workforces-heading" className="text-lg font-semibold text-foreground">
                Workforces
              </h2>
              <p className="text-sm text-muted-foreground">
                Workforces are reusable teams. Execution routing will use these templates in later workforce slices.
              </p>
            </div>

            <div className="grid gap-3 lg:grid-cols-2">
              {workforces.length === 0 ? (
                <div className="rounded-lg border border-border p-4 text-sm text-muted-foreground">
                  No workforces configured.
                </div>
              ) : (
                workforces.map((workforce) => (
                  <article key={workforce.id} className="rounded-lg border border-border p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="break-words font-medium text-foreground">{workforce.displayName}</h3>
                          {workforce.isDefault && (
                            <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                              Default
                            </span>
                          )}
                          {!workforce.isActive && (
                            <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                              Archived
                            </span>
                          )}
                        </div>
                        <p className="break-all font-mono text-xs text-muted-foreground">{workforce.slug}</p>
                        {workforce.description && (
                          <p className="mt-2 break-words text-sm text-muted-foreground">{workforce.description}</p>
                        )}
                      </div>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Edit ${workforce.displayName}`}
                        onClick={() => setEditingWorkforce(workforce)}
                      >
                        <PencilIcon className="size-4 text-muted-foreground" aria-hidden="true" />
                      </Button>
                    </div>

                    <div className="mt-4">
                      {workforce.members.length === 0 ? (
                        <span className="text-sm text-muted-foreground">No agents assigned</span>
                      ) : (
                        <ul className="grid gap-2" aria-label={`${workforce.displayName} assigned agents`}>
                          {workforce.members.map((member) => {
                            const roleName = member.roleLabel || member.displayName || titleize(member.agentType)
                            return (
                              <li key={member.id} className="rounded-md border border-border bg-muted/20 px-3 py-2">
                                <div className="flex flex-wrap items-center justify-between gap-2">
                                  <span className="text-sm font-medium text-foreground">{roleName}</span>
                                  <span className="font-mono text-xs text-muted-foreground">{member.agentType}</span>
                                </div>
                                {member.description && (
                                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{member.description}</p>
                                )}
                                <p className="mt-2 text-xs text-muted-foreground">
                                  Prompt is managed on the agent profile above.
                                </p>
                              </li>
                            )
                          })}
                        </ul>
                      )}
                    </div>
                  </article>
                ))
              )}
            </div>
          </section>

          <section aria-labelledby="presets-heading">
            <h2 id="presets-heading" className="mb-1 text-lg font-semibold text-foreground">
              Recommended Configurations
            </h2>
            <p className="mb-4 text-sm text-muted-foreground">
              Presets assign providers to matching seeded agents. Custom agents stay unchanged.
            </p>
            {presetError && (
              <div
                role="alert"
                className="mb-4 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive"
              >
                {presetError}
              </div>
            )}
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {PRESETS.map((preset) => (
                <div key={preset.id} className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4">
                  <div className="flex flex-col gap-1">
                    <span className="font-medium text-foreground">{preset.label}</span>
                    <p className="text-xs leading-relaxed text-muted-foreground">{preset.description}</p>
                  </div>
                  <p className="text-xs font-medium text-foreground">{preset.estimatedMonthlyCost}</p>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={applyingPreset !== null}
                    aria-busy={applyingPreset === preset.id}
                    onClick={() => handleApplyPreset(preset.id)}
                    aria-label={`Apply preset ${preset.label}`}
                  >
                    {applyingPreset === preset.id ? 'Applying...' : 'Apply'}
                  </Button>
                </div>
              ))}
            </div>
          </section>
        </div>
      )}

      <AgentEditor
        agent={editingAgent}
        providers={assignableProviders}
        onClose={() => setEditingAgent(null)}
        onSaved={loadData}
      />
      <WorkforceEditor
        workforce={editingWorkforce}
        agents={activeAgents}
        onClose={() => setEditingWorkforce(null)}
        onSaved={loadData}
      />
    </div>
  )
}
