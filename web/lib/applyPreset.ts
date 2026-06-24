'use client'

import type { Preset } from '@/lib/recommendations'

type ProviderConfig = {
  id: string
  providerType: string
  modelId: string
}

type AgentConfig = {
  agentType: string
}

async function readJsonError(response: Response, fallback: string): Promise<Error> {
  const body = await response.json().catch(() => ({})) as { error?: string }
  return new Error(body.error ?? fallback)
}

export async function applyPreset(preset: Preset): Promise<void> {
  const [providersRes, agentsRes] = await Promise.all([
    fetch('/api/providers'),
    fetch('/api/agents'),
  ])
  if (!providersRes.ok) throw await readJsonError(providersRes, 'Failed to load providers')
  if (!agentsRes.ok) throw await readJsonError(agentsRes, 'Failed to load agents')

  const data = await providersRes.json() as { providers: ProviderConfig[] }
  const agentsData = await agentsRes.json() as { agents: AgentConfig[] }
  const current = data.providers ?? []
  const existingAgentTypes = new Set((agentsData.agents ?? []).map((agent) => agent.agentType))
  const providerIdByKey: Record<string, string> = {}

  for (const spec of Object.values(preset.agents)) {
    const key = `${spec.providerType}:${spec.modelId}`

    if (providerIdByKey[key] === undefined) {
      const existing = current.find(
        (p) => p.providerType === spec.providerType && p.modelId === spec.modelId,
      )

      if (existing) {
        providerIdByKey[key] = existing.id
      } else {
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

        if (!createRes.ok) throw await readJsonError(createRes, 'Failed to create provider')
        const created = await createRes.json() as { provider: ProviderConfig }
        providerIdByKey[key] = created.provider.id
        current.push(created.provider)
      }
    }
  }

  for (const [agentType, spec] of Object.entries(preset.agents)) {
    if (!existingAgentTypes.has(agentType)) continue

    const key = `${spec.providerType}:${spec.modelId}`

    const updateRes = await fetch(`/api/agents/${agentType}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providerConfigId: providerIdByKey[key] }),
    })

    if (!updateRes.ok) {
      throw await readJsonError(updateRes, `Failed to update agent config for ${agentType}`)
    }
  }
}
