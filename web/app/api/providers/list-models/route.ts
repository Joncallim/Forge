import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { getSession } from '@/lib/session'
import { PROVIDER_CATALOG } from '@/lib/providers/catalog'
import type { ProviderType } from '@/lib/providers/types'

// ---------------------------------------------------------------------------
// POST /api/providers/list-models
//
// Best-effort: calls the given provider's model-listing endpoint with the
// supplied (not-yet-saved) API key / base URL and returns the available model
// ids, so the Add/Edit Provider form can offer a dropdown instead of asking
// the user to type a model id from memory.
// ---------------------------------------------------------------------------

const FETCH_TIMEOUT_MS = 8000

const requestSchema = z.object({
  providerType: z.string(),
  apiKey: z.string().optional(),
  baseUrl: z.string().optional(),
})

async function fetchJson(url: string, headers: Record<string, string>): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(url, { headers, signal: controller.signal })
    if (!res.ok) {
      throw new Error(`Provider returned ${res.status}`)
    }
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

function extractOpenAiCompatibleIds(data: unknown): string[] {
  const list = (data as { data?: { id?: string }[] } | null)?.data ?? []
  return list
    .map((m) => m.id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0)
}

async function listModels(providerType: ProviderType, apiKey: string, baseUrl?: string): Promise<string[]> {
  switch (providerType) {
    case 'anthropic': {
      const data = await fetchJson('https://api.anthropic.com/v1/models', {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      })
      const list = (data as { data?: { id?: string }[] } | null)?.data ?? []
      return list.map((m) => m.id).filter((id): id is string => typeof id === 'string')
    }
    case 'google': {
      const data = await fetchJson(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`,
        {},
      )
      const list = (data as { models?: { name?: string }[] } | null)?.models ?? []
      return list
        .map((m) => m.name?.replace(/^models\//, ''))
        .filter((name): name is string => typeof name === 'string' && name.length > 0)
    }
    default: {
      // OpenAI-compatible providers: openai, openrouter, xai, deepseek, moonshot,
      // zhipu, litellm, custom — all expose GET {baseUrl}/models.
      const entry = PROVIDER_CATALOG[providerType]
      const resolvedBaseUrl = (baseUrl || entry?.defaultBaseUrl || '').replace(/\/$/, '')
      if (!resolvedBaseUrl) {
        throw new Error('A base URL is required to list models for this provider')
      }
      const data = await fetchJson(`${resolvedBaseUrl}/models`, {
        Authorization: `Bearer ${apiKey}`,
      })
      return extractOpenAiCompatibleIds(data)
    }
  }
}

export async function POST(request: NextRequest) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const parsed = requestSchema.safeParse(await request.json().catch(() => null))
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
    }

    const { providerType, apiKey, baseUrl } = parsed.data
    const entry = PROVIDER_CATALOG[providerType as ProviderType]
    if (!entry) {
      return NextResponse.json({ error: `Unknown provider type: ${providerType}` }, { status: 400 })
    }
    if (entry.requiresApiKey && !apiKey) {
      return NextResponse.json({ error: 'An API key is required to list models' }, { status: 400 })
    }

    try {
      const models = await listModels(providerType as ProviderType, apiKey ?? '', baseUrl)
      return NextResponse.json({ models: [...new Set(models)].sort() })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to list models'
      return NextResponse.json({ error: message }, { status: 502 })
    }
  } catch (err) {
    console.error('[POST /api/providers/list-models] Unexpected error', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
