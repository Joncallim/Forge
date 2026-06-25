import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { getSession } from '@/lib/session'
import {
  normalizeLmStudioNativeApiBaseUrl,
  normalizeLmStudioRuntimeBaseUrl,
  PROVIDER_CATALOG,
  providerSupportsUserBaseUrl,
} from '@/lib/providers/catalog'
import { validateProviderBaseUrl } from '@/lib/providers/credentials'
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
  baseUrl: z.string().nullable().optional(),
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

function extractLmStudioNativeIds(data: unknown): string[] | null {
  const list = (data as { models?: unknown[] } | null)?.models
  if (!Array.isArray(list)) return null

  return list.flatMap((model) => {
    const item = model as {
      key?: unknown
      type?: unknown
      loaded_instances?: { id?: unknown }[]
    }
    if (item.type === 'embedding') return []

    return [
      item.key,
      ...(Array.isArray(item.loaded_instances)
        ? item.loaded_instances.map((instance) => instance.id)
        : []),
    ].filter((id): id is string => typeof id === 'string' && id.length > 0)
  })
}

function optionalBearerHeaders(apiKey: string): Record<string, string> {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {}
}

function baseUrlForModelListing(providerType: ProviderType, baseUrl?: string | null): string {
  if (providerSupportsUserBaseUrl(providerType)) {
    return (baseUrl?.trim() || PROVIDER_CATALOG[providerType]?.defaultBaseUrl || '').replace(/\/+$/, '')
  }

  if (providerType === 'openai') {
    return 'https://api.openai.com/v1'
  }

  return (PROVIDER_CATALOG[providerType]?.defaultBaseUrl || '').replace(/\/+$/, '')
}

async function listModels(
  providerType: ProviderType,
  apiKey: string,
  baseUrl?: string | null,
): Promise<string[]> {
  switch (providerType) {
    case 'acp':
      throw new Error('ACP providers do not expose model listing through this endpoint')

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
    case 'lmstudio': {
      const configuredBaseUrl = baseUrl?.trim() || PROVIDER_CATALOG.lmstudio.defaultBaseUrl || ''
      const nativeBaseUrl = normalizeLmStudioNativeApiBaseUrl(configuredBaseUrl)
      const runtimeBaseUrl = normalizeLmStudioRuntimeBaseUrl(configuredBaseUrl)
      if (!nativeBaseUrl || !runtimeBaseUrl) {
        throw new Error('A base URL is required to list models for this provider')
      }

      const headers = optionalBearerHeaders(apiKey)
      try {
        const data = await fetchJson(`${nativeBaseUrl}/models`, headers)
        const nativeIds = extractLmStudioNativeIds(data)
        if (nativeIds !== null) return nativeIds
      } catch {
        // Fall through to the OpenAI-compatible endpoint for older LM Studio servers.
      }

      const data = await fetchJson(`${runtimeBaseUrl}/models`, headers)
      return extractOpenAiCompatibleIds(data)
    }
    default: {
      // OpenAI-compatible providers: openai, openrouter, xai, deepseek, moonshot,
      // zhipu, litellm, custom, ollama — all expose GET {baseUrl}/models.
      const resolvedBaseUrl = baseUrlForModelListing(providerType, baseUrl)
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
    const baseUrlError = validateProviderBaseUrl(providerType, baseUrl)
    if (baseUrlError) {
      return NextResponse.json({ error: baseUrlError }, { status: 400 })
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
