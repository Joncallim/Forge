import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { db } from '@/db'
import { providerConfigs } from '@/db/schema'
import { and, eq } from 'drizzle-orm'
import { getSession } from '@/lib/session'
import { PROVIDER_CATALOG } from '@/lib/providers/catalog'

// ---------------------------------------------------------------------------
// POST /api/providers/discover-local
//
// Probes locally-running Ollama and LM Studio installations for installed models
// and registers any that are not already configured as providers. Returns what
// was discovered and what was added. Probes are best-effort with short timeouts
// so a missing local runtime never blocks the request.
// ---------------------------------------------------------------------------

const OLLAMA_BASE_URL = PROVIDER_CATALOG.ollama.defaultBaseUrl ?? 'http://localhost:11434'
const LMSTUDIO_BASE_URL = PROVIDER_CATALOG.lmstudio.defaultBaseUrl ?? 'http://localhost:1234/v1'
const PROBE_TIMEOUT_MS = 1500

type DiscoveredModel = {
  providerType: 'ollama' | 'lmstudio'
  modelId: string
  baseUrl: string
}

async function fetchJson(url: string): Promise<unknown | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
  try {
    const res = await fetch(url, { signal: controller.signal })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

async function discoverOllama(): Promise<DiscoveredModel[]> {
  const data = await fetchJson(`${OLLAMA_BASE_URL}/api/tags`)
  const models = (data as { models?: { name?: string }[] } | null)?.models ?? []
  return models
    .map((m) => m.name)
    .filter((name): name is string => typeof name === 'string' && name.length > 0)
    .map((modelId) => ({ providerType: 'ollama' as const, modelId, baseUrl: OLLAMA_BASE_URL }))
}

async function discoverLmStudio(): Promise<DiscoveredModel[]> {
  const data = await fetchJson(`${LMSTUDIO_BASE_URL}/models`)
  const models = (data as { data?: { id?: string }[] } | null)?.data ?? []
  return models
    .map((m) => m.id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0)
    .map((modelId) => ({ providerType: 'lmstudio' as const, modelId, baseUrl: LMSTUDIO_BASE_URL }))
}

export async function POST(request: NextRequest) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const [ollama, lmstudio] = await Promise.all([discoverOllama(), discoverLmStudio()])
    const discovered = [...ollama, ...lmstudio]

    const added: { providerType: string; modelId: string }[] = []
    for (const model of discovered) {
      // Skip if a provider of the same type already serves this exact model id.
      const existing = await db
        .select({ id: providerConfigs.id })
        .from(providerConfigs)
        .where(
          and(
            eq(providerConfigs.providerType, model.providerType),
            eq(providerConfigs.modelId, model.modelId),
          ),
        )
        .limit(1)

      if (existing.length > 0) continue

      await db.insert(providerConfigs).values({
        displayName: `${model.providerType === 'ollama' ? 'Ollama' : 'LM Studio'}: ${model.modelId}`,
        providerType: model.providerType,
        modelId: model.modelId,
        baseUrl: model.baseUrl,
        isLocal: true,
      })
      added.push({ providerType: model.providerType, modelId: model.modelId })
    }

    return NextResponse.json({
      found: discovered.length,
      added,
      ollamaReachable: ollama.length > 0,
      lmstudioReachable: lmstudio.length > 0,
    })
  } catch (err) {
    console.error('[POST /api/providers/discover-local] Unexpected error', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
