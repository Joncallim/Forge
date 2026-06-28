import {
  normalizeLmStudioNativeApiBaseUrl,
  normalizeLmStudioRuntimeBaseUrl,
} from './catalog'

type FetchJsonOptions = {
  headers?: Record<string, string>
  timeoutMs: number
}

export type LmStudioModelListing = {
  models: string[]
  loadedModels: string[]
  source: 'native' | 'runtime'
}

function uniqueModelIds(ids: string[]): string[] {
  return [...new Set(ids.filter((id) => id.trim() !== '').map((id) => id.trim()))]
}

async function fetchJsonWithTimeout(url: string, options: FetchJsonOptions): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs)
  try {
    const res = await fetch(url, {
      headers: options.headers ?? {},
      signal: controller.signal,
    })
    if (!res.ok) {
      throw new Error(`Provider returned ${res.status}`)
    }
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

export function extractOpenAiCompatibleModelIds(data: unknown): string[] {
  const list = (data as { data?: unknown[] } | null)?.data
  if (!Array.isArray(list)) return []

  return uniqueModelIds(
    list
      .map((item) => (item as { id?: unknown }).id)
      .filter((id): id is string => typeof id === 'string'),
  )
}

export function extractLmStudioNativeModelListing(data: unknown): { models: string[]; loadedModels: string[] } | null {
  const nativeModels = (data as { models?: unknown[] } | null)?.models
  if (Array.isArray(nativeModels)) {
    const models: string[] = []
    const loadedModels: string[] = []

    for (const model of nativeModels) {
      const item = model as {
        id?: unknown
        key?: unknown
        type?: unknown
        loaded_instances?: { id?: unknown; model?: unknown }[]
      }
      if (item.type === 'embedding') continue

      models.push(...[
        item.key,
        item.id,
      ].filter((id): id is string => typeof id === 'string'))

      if (Array.isArray(item.loaded_instances) && item.loaded_instances.length > 0) {
        loadedModels.push(...[
          item.key,
          item.id,
          ...item.loaded_instances.flatMap((instance) => [instance.id, instance.model]),
        ].filter((id): id is string => typeof id === 'string'))
      }
    }

    return {
      models: uniqueModelIds(models),
      loadedModels: uniqueModelIds(loadedModels),
    }
  }

  const openAiData = (data as { data?: unknown[] } | null)?.data
  if (Array.isArray(openAiData)) {
    const models = extractOpenAiCompatibleModelIds(data)
    return { models, loadedModels: models }
  }

  return null
}

export function extractLmStudioNativeModelIds(data: unknown): string[] | null {
  return extractLmStudioNativeModelListing(data)?.models ?? null
}

export function extractLmStudioNativeLoadedModelIds(data: unknown): string[] | null {
  return extractLmStudioNativeModelListing(data)?.loadedModels ?? null
}

function normalizeRuntimeListing(data: unknown): { models: string[]; loadedModels: string[] } {
  const models = extractOpenAiCompatibleModelIds(data)
  return { models, loadedModels: models }
}

export async function listLmStudioModelIds({
  baseUrl,
  apiKey = '',
  timeoutMs,
}: {
  baseUrl: string | null | undefined
  apiKey?: string
  timeoutMs: number
}): Promise<LmStudioModelListing> {
  const nativeBaseUrl = normalizeLmStudioNativeApiBaseUrl(baseUrl)
  const runtimeBaseUrl = normalizeLmStudioRuntimeBaseUrl(baseUrl)
  if (!nativeBaseUrl || !runtimeBaseUrl) {
    throw new Error('A base URL is required to list models for this provider')
  }

  const headers: Record<string, string> = apiKey ? { Authorization: `Bearer ${apiKey}` } : {}

  try {
    const data = await fetchJsonWithTimeout(`${nativeBaseUrl}/models`, { headers, timeoutMs })
    const nativeListing = extractLmStudioNativeModelListing(data)
    if (nativeListing !== null) {
      return { ...nativeListing, source: 'native' }
    }
  } catch {
    // Fall through to the OpenAI-compatible endpoint for older LM Studio servers.
  }

  const data = await fetchJsonWithTimeout(`${runtimeBaseUrl}/models`, { headers, timeoutMs })
  return { ...normalizeRuntimeListing(data), source: 'runtime' }
}
