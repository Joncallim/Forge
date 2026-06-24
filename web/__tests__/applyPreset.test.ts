import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyPreset } from '@/lib/applyPreset'
import type { Preset } from '@/lib/recommendations'

const preset: Preset = {
  id: 'best-value',
  label: 'Best Value',
  description: 'Test preset',
  estimatedMonthlyCost: '$1',
  agents: {
    architect: {
      providerType: 'anthropic',
      modelId: 'claude-sonnet-4-6',
      apiKeyEnvVar: 'ANTHROPIC_API_KEY',
      isLocal: false,
    },
    backend: {
      providerType: 'openrouter',
      modelId: 'deepseek/deepseek-v4',
      apiKeyEnvVar: 'OPENROUTER_API_KEY',
      isLocal: false,
    },
    reviewer: {
      providerType: 'openrouter',
      modelId: 'deepseek/deepseek-v4',
      apiKeyEnvVar: 'OPENROUTER_API_KEY',
      isLocal: false,
    },
  },
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('applyPreset', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('creates preset providers even before seeded agents exist', async () => {
    const createdProviders: Array<{ providerType: string; modelId: string }> = []
    const agentUpdates: string[] = []

    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'

      if (url === '/api/providers' && method === 'GET') {
        return jsonResponse({ providers: [] })
      }
      if (url === '/api/agents' && method === 'GET') {
        return jsonResponse({ agents: [] })
      }
      if (url === '/api/providers' && method === 'POST') {
        const body = JSON.parse(String(init?.body)) as { providerType: string; modelId: string }
        createdProviders.push({ providerType: body.providerType, modelId: body.modelId })
        return jsonResponse({
          provider: {
            id: `provider-${createdProviders.length}`,
            providerType: body.providerType,
            modelId: body.modelId,
          },
        }, { status: 201 })
      }
      if (url.startsWith('/api/agents/') && method === 'PUT') {
        agentUpdates.push(url)
        return jsonResponse({ agent: {} })
      }

      return jsonResponse({ error: `Unexpected ${method} ${url}` }, { status: 500 })
    }))

    await applyPreset(preset)

    expect(createdProviders).toEqual([
      { providerType: 'anthropic', modelId: 'claude-sonnet-4-6' },
      { providerType: 'openrouter', modelId: 'deepseek/deepseek-v4' },
    ])
    expect(agentUpdates).toEqual([])
  })

  it('assigns providers only to matching existing agents', async () => {
    const updatedAgents: Array<{ url: string; providerConfigId: string }> = []

    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'

      if (url === '/api/providers' && method === 'GET') {
        return jsonResponse({
          providers: [
            { id: 'provider-architect', providerType: 'anthropic', modelId: 'claude-sonnet-4-6' },
            { id: 'provider-worker', providerType: 'openrouter', modelId: 'deepseek/deepseek-v4' },
          ],
        })
      }
      if (url === '/api/agents' && method === 'GET') {
        return jsonResponse({ agents: [{ agentType: 'architect' }] })
      }
      if (url.startsWith('/api/agents/') && method === 'PUT') {
        const body = JSON.parse(String(init?.body)) as { providerConfigId: string }
        updatedAgents.push({ url, providerConfigId: body.providerConfigId })
        return jsonResponse({ agent: {} })
      }

      return jsonResponse({ error: `Unexpected ${method} ${url}` }, { status: 500 })
    }))

    await applyPreset(preset)

    expect(updatedAgents).toEqual([
      { url: '/api/agents/architect', providerConfigId: 'provider-architect' },
    ])
  })
})
