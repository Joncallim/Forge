import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { db } from '@/db'
import { providerConfigs } from '@/db/schema'
import { and, eq } from 'drizzle-orm'
import { getSession } from '@/lib/session'
import {
  normalizeLmStudioRuntimeBaseUrl,
  PROVIDER_CATALOG,
} from '@/lib/providers/catalog'
import {
  extractOpenAiCompatibleModelIds,
  listLmStudioModelIds,
} from '@/lib/providers/model-listing'

// ---------------------------------------------------------------------------
// POST /api/providers/discover-local
//
// Probes locally-running Ollama and LM Studio installations for installed models
// and registers any that are not already configured as providers. Returns what
// was discovered and what was added. Probes are best-effort with short timeouts
// so a missing local runtime never blocks the request.
// ---------------------------------------------------------------------------

const OLLAMA_BASE_URL = PROVIDER_CATALOG.ollama.defaultBaseUrl ?? 'http://localhost:11434'
const LMSTUDIO_RUNTIME_BASE_URL =
  normalizeLmStudioRuntimeBaseUrl(PROVIDER_CATALOG.lmstudio.defaultBaseUrl ?? 'http://localhost:1234') ??
  'http://localhost:1234/v1'
const PROBE_TIMEOUT_MS = 1500

type DiscoveredModel = {
  providerType: 'ollama' | 'lmstudio'
  modelId: string
  baseUrl: string
}

type DiscoveryChange = {
  providerType: string
  modelId: string
}

type DiscoverySkip = DiscoveryChange & {
  reason: 'provider_disabled' | 'base_url_conflict' | 'nonlocal_existing_provider'
}

function normalizeComparableBaseUrl(providerType: DiscoveredModel['providerType'], baseUrl: string | null): string | null {
  const trimmed = baseUrl?.trim()
  if (!trimmed) return null
  if (providerType === 'lmstudio') return normalizeLmStudioRuntimeBaseUrl(trimmed) ?? null
  return trimmed.replace(/\/+$/g, '')
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

function extractOpenAiCompatibleModels(data: unknown | null): string[] {
  return extractOpenAiCompatibleModelIds(data)
}

async function discoverLmStudio(): Promise<DiscoveredModel[]> {
  let models: string[]
  try {
    const listing = await listLmStudioModelIds({
      baseUrl: LMSTUDIO_RUNTIME_BASE_URL,
      timeoutMs: PROBE_TIMEOUT_MS,
    })
    models = listing.models
  } catch {
    models = extractOpenAiCompatibleModels(await fetchJson(`${LMSTUDIO_RUNTIME_BASE_URL}/models`))
  }

  return models
    .map((modelId) => ({ providerType: 'lmstudio' as const, modelId, baseUrl: LMSTUDIO_RUNTIME_BASE_URL }))
}

export async function POST(request: NextRequest) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const [ollama, lmstudio] = await Promise.all([discoverOllama(), discoverLmStudio()])
    const discovered = [...ollama, ...lmstudio]

    const added: DiscoveryChange[] = []
    const updated: DiscoveryChange[] = []
    const skipped: DiscoverySkip[] = []
    for (const model of discovered) {
      const [existing] = await db
        .select({
          id: providerConfigs.id,
          displayName: providerConfigs.displayName,
          baseUrl: providerConfigs.baseUrl,
          isLocal: providerConfigs.isLocal,
          isActive: providerConfigs.isActive,
        })
        .from(providerConfigs)
        .where(
          and(
            eq(providerConfigs.providerType, model.providerType),
            eq(providerConfigs.modelId, model.modelId),
          ),
        )
        .limit(1)

      if (existing) {
        if (!existing.isActive) {
          skipped.push({
            providerType: model.providerType,
            modelId: model.modelId,
            reason: 'provider_disabled',
          })
          continue
        }
        if (!existing.isLocal) {
          skipped.push({
            providerType: model.providerType,
            modelId: model.modelId,
            reason: 'nonlocal_existing_provider',
          })
          continue
        }

        const existingBaseUrl = normalizeComparableBaseUrl(model.providerType, existing.baseUrl)
        const discoveredBaseUrl = normalizeComparableBaseUrl(model.providerType, model.baseUrl)
        if (existingBaseUrl !== null && existingBaseUrl !== discoveredBaseUrl) {
          skipped.push({
            providerType: model.providerType,
            modelId: model.modelId,
            reason: 'base_url_conflict',
          })
          continue
        }

        if (existing.baseUrl !== model.baseUrl || !existing.isLocal) {
          await db
            .update(providerConfigs)
            .set({
              baseUrl: model.baseUrl,
              isLocal: true,
              updatedAt: new Date(),
            })
            .where(eq(providerConfigs.id, existing.id))
          updated.push({ providerType: model.providerType, modelId: model.modelId })
        }
        continue
      }

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
      updated,
      skipped,
      ollamaReachable: ollama.length > 0,
      lmstudioReachable: lmstudio.length > 0,
    })
  } catch (err) {
    console.error('[POST /api/providers/discover-local] Unexpected error', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
