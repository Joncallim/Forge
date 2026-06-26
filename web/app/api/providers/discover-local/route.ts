import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { db } from '@/db'
import { providerConfigs } from '@/db/schema'
import { and, eq } from 'drizzle-orm'
import { getSession } from '@/lib/session'
import {
  normalizeLmStudioNativeApiBaseUrl,
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

type DiscoveryCandidate = {
  id: string
  label: string
  providerType?: string
  modelId?: string
  status: 'reachable' | 'not_reachable' | 'added' | 'updated' | 'configured' | 'skipped'
  detail?: string
  guidance?: string
}

type DiscoveryCapabilityGroup = {
  id: string
  title: string
  description: string
  candidates: DiscoveryCandidate[]
}

type LmStudioDiscovery = {
  models: DiscoveredModel[]
  auxiliaryCandidates: DiscoveryCandidate[]
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value !== ''))]
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

function extractLmStudioNativeCapabilities(data: unknown | null): {
  generationModelIds: string[]
  auxiliaryCandidates: DiscoveryCandidate[]
} | null {
  const models = (data as { models?: unknown[] } | null)?.models
  if (!Array.isArray(models)) return null

  const generationModelIds: string[] = []
  const auxiliaryCandidates: DiscoveryCandidate[] = []

  for (const model of models) {
    const item = model as {
      id?: unknown
      key?: unknown
      type?: unknown
      loaded_instances?: { id?: unknown; model?: unknown }[]
    }
    const ids = uniqueStrings([
      typeof item.key === 'string' ? item.key : '',
      typeof item.id === 'string' ? item.id : '',
      ...(Array.isArray(item.loaded_instances)
        ? item.loaded_instances.flatMap((instance) => [
          typeof instance.id === 'string' ? instance.id : '',
          typeof instance.model === 'string' ? instance.model : '',
        ])
        : []),
    ])
    if (ids.length === 0) continue

    if (item.type === 'embedding') {
      for (const modelId of ids) {
        auxiliaryCandidates.push({
          id: `lmstudio-embedding-${modelId}`,
          label: modelId,
          providerType: 'lmstudio',
          modelId,
          status: 'reachable',
          detail: 'LM Studio embedding model',
          guidance: 'Embeddings are detected separately and are not added as generation providers.',
        })
      }
      continue
    }

    generationModelIds.push(...ids)
  }

  return {
    generationModelIds: uniqueStrings(generationModelIds),
    auxiliaryCandidates,
  }
}

async function discoverLmStudio(): Promise<LmStudioDiscovery> {
  let models: string[]
  let auxiliaryCandidates: DiscoveryCandidate[] = []
  try {
    const nativeBaseUrl = normalizeLmStudioNativeApiBaseUrl(LMSTUDIO_RUNTIME_BASE_URL)
    const nativeData = nativeBaseUrl ? await fetchJson(`${nativeBaseUrl}/models`) : null
    const nativeCapabilities = extractLmStudioNativeCapabilities(nativeData)
    if (nativeCapabilities !== null) {
      models = nativeCapabilities.generationModelIds
      auxiliaryCandidates = nativeCapabilities.auxiliaryCandidates
    } else {
      const listing = await listLmStudioModelIds({
        baseUrl: LMSTUDIO_RUNTIME_BASE_URL,
        timeoutMs: PROBE_TIMEOUT_MS,
      })
      models = listing.models
    }
  } catch {
    models = extractOpenAiCompatibleModels(await fetchJson(`${LMSTUDIO_RUNTIME_BASE_URL}/models`))
  }

  return {
    models: models.map((modelId) => ({ providerType: 'lmstudio' as const, modelId, baseUrl: LMSTUDIO_RUNTIME_BASE_URL })),
    auxiliaryCandidates,
  }
}

function changeStatus(
  model: DiscoveredModel,
  added: DiscoveryChange[],
  updated: DiscoveryChange[],
  skipped: DiscoverySkip[],
): DiscoveryCandidate['status'] {
  if (added.some((change) => change.providerType === model.providerType && change.modelId === model.modelId)) return 'added'
  if (updated.some((change) => change.providerType === model.providerType && change.modelId === model.modelId)) return 'updated'
  if (skipped.some((change) => change.providerType === model.providerType && change.modelId === model.modelId)) return 'skipped'
  return 'configured'
}

function capabilityGroupsFor(input: {
  discovered: DiscoveredModel[]
  added: DiscoveryChange[]
  updated: DiscoveryChange[]
  skipped: DiscoverySkip[]
  lmstudioAuxiliary: DiscoveryCandidate[]
}): {
  capabilityGroups: DiscoveryCapabilityGroup[]
  auxiliaryCapabilityGroups: DiscoveryCapabilityGroup[]
} {
  return {
    capabilityGroups: [{
      id: 'main-generation',
      title: 'Main generation capabilities',
      description: 'Local chat models Forge can add as generation providers.',
      candidates: input.discovered.map((model) => ({
        id: `${model.providerType}-${model.modelId}`,
        label: model.modelId,
        providerType: model.providerType,
        modelId: model.modelId,
        status: changeStatus(model, input.added, input.updated, input.skipped),
        detail: `${model.providerType === 'ollama' ? 'Ollama' : 'LM Studio'} generation model`,
      })),
    }],
    auxiliaryCapabilityGroups: [{
      id: 'auxiliary-local',
      title: 'Auxiliary local capabilities',
      description: 'Local non-generation capabilities detected during discovery.',
      candidates: input.lmstudioAuxiliary,
    }],
  }
}

export async function POST(request: NextRequest) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const [ollama, lmstudio] = await Promise.all([discoverOllama(), discoverLmStudio()])
    const discovered = [...ollama, ...lmstudio.models]

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

    const groups = capabilityGroupsFor({
      discovered,
      added,
      updated,
      skipped,
      lmstudioAuxiliary: lmstudio.auxiliaryCandidates,
    })

    return NextResponse.json({
      found: discovered.length,
      added,
      updated,
      skipped,
      ollamaReachable: ollama.length > 0,
      lmstudioReachable: lmstudio.models.length > 0 || lmstudio.auxiliaryCandidates.length > 0,
      capabilityGroups: groups.capabilityGroups,
      auxiliaryCapabilityGroups: groups.auxiliaryCapabilityGroups,
    })
  } catch (err) {
    console.error('[POST /api/providers/discover-local] Unexpected error', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
