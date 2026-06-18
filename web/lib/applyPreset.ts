'use client'

import type { Preset } from '@/lib/recommendations'

type ProviderConfig = {
  id: string
  providerType: string
  modelId: string
}

async function readJsonError(response: Response, fallback: string): Promise<Error> {
  const body = await response.json().catch(() => ({})) as { error?: string }
  return new Error(body.error ?? fallback)
}

export async function applyPreset(preset: Preset): Promise<void> {
  const res = await fetch('/api/providers')
  if (!res.ok) throw await readJsonError(res, 'Failed to load providers')

  const data = await res.json() as { providers: ProviderConfig[] }
  const current = data.providers ?? []
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
