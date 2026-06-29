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
  extractLmStudioNativeModelListing,
  listLmStudioModelIds,
} from '@/lib/providers/model-listing'
import { ACP_AGENTS, acpProviderModelId, getAcpModelSelection, parseAcpProviderModelId } from '@/lib/providers/acp/catalog'

// ---------------------------------------------------------------------------
// POST /api/providers/discover-local
//
// Probes locally-running Ollama, LM Studio, and ACP model-selection presets.
// Discovery is read-only by default; callers can request explicit
// auto-configuration for one or more discovered generation models.
// ---------------------------------------------------------------------------

const OLLAMA_BASE_URL = PROVIDER_CATALOG.ollama.defaultBaseUrl ?? 'http://localhost:11434'
const LMSTUDIO_RUNTIME_BASE_URL =
  normalizeLmStudioRuntimeBaseUrl(PROVIDER_CATALOG.lmstudio.defaultBaseUrl ?? 'http://localhost:1234') ??
  'http://localhost:1234/v1'
const PROBE_TIMEOUT_MS = 1500

type DiscoveredModel = {
  providerType: 'ollama' | 'lmstudio' | 'acp'
  modelId: string
  baseUrl: string | null
  readiness: 'ready' | 'available'
  detail?: string
  guidance?: string
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
  versionLabel?: string
  status: 'reachable' | 'not_reachable' | 'available' | 'added' | 'updated' | 'configured' | 'skipped'
  detail?: string
  guidance?: string
  canConfigure?: boolean
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

type DiscoveryRequest = {
  autoConfigure: boolean
  candidates: { providerType: DiscoveredModel['providerType']; modelId: string }[]
  invalidReason: string | null
}

function discoveredKey(model: Pick<DiscoveredModel, 'providerType' | 'modelId'>): string {
  return `${model.providerType}:${model.modelId}`
}

async function parseDiscoveryRequest(request: NextRequest): Promise<DiscoveryRequest> {
  if (!request.headers.get('content-type')?.toLowerCase().includes('application/json')) {
    return { autoConfigure: false, candidates: [], invalidReason: null }
  }

  try {
    const body = await request.json() as {
      autoConfigure?: unknown
      configure?: unknown
      candidates?: unknown
      providerType?: unknown
      modelId?: unknown
    }
    const candidatesProvided = Object.prototype.hasOwnProperty.call(body, 'candidates')
    const singleCandidateProvided = Object.prototype.hasOwnProperty.call(body, 'providerType') ||
      Object.prototype.hasOwnProperty.call(body, 'modelId')
    const rawCandidateItems = Array.isArray(body.candidates) ? body.candidates : []
    const candidateItems: DiscoveryRequest['candidates'] = Array.isArray(body.candidates)
      ? rawCandidateItems.flatMap((candidate) => {
        if (!candidate || typeof candidate !== 'object') return []
        const item = candidate as { providerType?: unknown; modelId?: unknown }
        if (
          (item.providerType === 'ollama' || item.providerType === 'lmstudio' || item.providerType === 'acp') &&
          typeof item.modelId === 'string' &&
          item.modelId.trim() !== ''
        ) {
          return [{ providerType: item.providerType, modelId: item.modelId.trim() }]
        }
        return []
      })
      : !candidatesProvided &&
        (body.providerType === 'ollama' || body.providerType === 'lmstudio' || body.providerType === 'acp') &&
        typeof body.modelId === 'string' &&
        body.modelId.trim() !== ''
        ? [{ providerType: body.providerType, modelId: body.modelId.trim() } satisfies DiscoveryRequest['candidates'][number]]
        : []
    const hasInvalidCandidates =
      (candidatesProvided && (!Array.isArray(body.candidates) || candidateItems.length !== rawCandidateItems.length || candidateItems.length === 0)) ||
      (singleCandidateProvided && candidateItems.length === 0)

    return {
      autoConfigure: body.autoConfigure === true || body.configure === true,
      candidates: candidateItems,
      invalidReason: hasInvalidCandidates ? 'Auto-configure candidates must include providerType and modelId.' : null,
    }
  } catch {
    return { autoConfigure: false, candidates: [], invalidReason: 'Invalid JSON body' }
  }
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value !== ''))]
}

function normalizeComparableBaseUrl(providerType: DiscoveredModel['providerType'], baseUrl: string | null): string | null {
  const trimmed = baseUrl?.trim()
  if (!trimmed) return null
  if (providerType === 'lmstudio') return normalizeLmStudioRuntimeBaseUrl(trimmed) ?? null
  if (providerType === 'acp') return null
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
    .map((modelId) => ({
      providerType: 'ollama' as const,
      modelId,
      baseUrl: OLLAMA_BASE_URL,
      readiness: 'ready' as const,
    }))
}

function extractOpenAiCompatibleModels(data: unknown | null): string[] {
  return extractOpenAiCompatibleModelIds(data)
}

function extractLmStudioNativeCapabilities(data: unknown | null): {
  generationModels: { modelId: string; loaded: boolean }[]
  auxiliaryCandidates: DiscoveryCandidate[]
} | null {
  const listing = extractLmStudioNativeModelListing(data)
  const models = (data as { models?: unknown[] } | null)?.models
  if (!listing || !Array.isArray(models)) return null

  const loadedIds = new Set(listing.loadedModels)
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

    // Generation models are returned from the normalized listing below; this
    // loop only harvests auxiliary capabilities.
  }

  return {
    generationModels: listing.models.map((modelId) => ({ modelId, loaded: loadedIds.has(modelId) })),
    auxiliaryCandidates,
  }
}

async function discoverLmStudio(): Promise<LmStudioDiscovery> {
  let models: { modelId: string; loaded: boolean }[]
  let auxiliaryCandidates: DiscoveryCandidate[] = []
  try {
    const nativeBaseUrl = normalizeLmStudioNativeApiBaseUrl(LMSTUDIO_RUNTIME_BASE_URL)
    const nativeData = nativeBaseUrl ? await fetchJson(`${nativeBaseUrl}/models`) : null
    const nativeCapabilities = extractLmStudioNativeCapabilities(nativeData)
    if (nativeCapabilities !== null) {
      models = nativeCapabilities.generationModels
      auxiliaryCandidates = nativeCapabilities.auxiliaryCandidates
    } else {
      const listing = await listLmStudioModelIds({
        baseUrl: LMSTUDIO_RUNTIME_BASE_URL,
        timeoutMs: PROBE_TIMEOUT_MS,
      })
      const loadedModels = new Set(listing.loadedModels)
      models = listing.models.map((modelId) => ({
        modelId,
        loaded: listing.source === 'runtime' || loadedModels.has(modelId),
      }))
    }
  } catch {
    models = extractOpenAiCompatibleModels(await fetchJson(`${LMSTUDIO_RUNTIME_BASE_URL}/models`))
      .map((modelId) => ({ modelId, loaded: true }))
  }

  return {
    models: models.map(({ modelId, loaded }) => ({
      providerType: 'lmstudio' as const,
      modelId,
      baseUrl: LMSTUDIO_RUNTIME_BASE_URL,
      readiness: loaded ? 'ready' as const : 'available' as const,
      detail: loaded ? 'LM Studio loaded chat model' : 'LM Studio chat model is installed but not loaded',
      guidance: loaded
        ? undefined
        : 'First use may take longer while LM Studio loads the model.',
    })),
    auxiliaryCandidates,
  }
}

function discoverAcpModels(): DiscoveredModel[] {
  return ACP_AGENTS.flatMap((agent) => {
    if (!agent.modelSelection) return []
    return agent.modelSelection.options.map((option) => ({
      providerType: 'acp' as const,
      modelId: acpProviderModelId(agent.id, option.id),
      baseUrl: null,
      readiness: 'available' as const,
      detail: `${agent.label} ACP model preset: ${option.label}`,
      guidance: agent.modelSelection?.helpText,
    }))
  })
}

function changeStatus(
  model: DiscoveredModel,
  added: DiscoveryChange[],
  updated: DiscoveryChange[],
  configured: DiscoveryChange[],
  skipped: DiscoverySkip[],
): DiscoveryCandidate['status'] {
  if (added.some((change) => change.providerType === model.providerType && change.modelId === model.modelId)) return 'added'
  if (updated.some((change) => change.providerType === model.providerType && change.modelId === model.modelId)) return 'updated'
  if (configured.some((change) => change.providerType === model.providerType && change.modelId === model.modelId)) return 'configured'
  if (skipped.some((change) => change.providerType === model.providerType && change.modelId === model.modelId)) return 'skipped'
  return 'available'
}

function capabilityGroupsFor(input: {
  discovered: DiscoveredModel[]
  added: DiscoveryChange[]
  updated: DiscoveryChange[]
  configured: DiscoveryChange[]
  skipped: DiscoverySkip[]
  lmstudioAuxiliary: DiscoveryCandidate[]
}): {
  capabilityGroups: DiscoveryCapabilityGroup[]
  auxiliaryCapabilityGroups: DiscoveryCapabilityGroup[]
} {
  const candidateFor = (model: DiscoveredModel): DiscoveryCandidate => {
    const parsedAcp = model.providerType === 'acp' ? parseAcpProviderModelId(model.modelId) : null
    const selectedModel = parsedAcp?.selectedModel ?? ''
    const optionLabel = selectedModel
      ? getAcpModelSelection(model.modelId)?.options.find((option) => option.id === selectedModel)?.label
      : null
    return {
      id: `${model.providerType}-${model.modelId}`,
      label: model.providerType === 'acp' ? model.detail?.replace(/ ACP model preset:.*/, '') ?? model.modelId : model.modelId,
      providerType: model.providerType,
      modelId: model.modelId,
      versionLabel: optionLabel ?? (selectedModel || undefined),
      status: changeStatus(model, input.added, input.updated, input.configured, input.skipped),
      detail: model.detail ?? (
        model.providerType === 'acp'
          ? 'ACP model preset'
          : `${model.providerType === 'ollama' ? 'Ollama' : 'LM Studio'} generation model`
      ),
      guidance: model.guidance,
      canConfigure: !input.configured.some((change) => change.providerType === model.providerType && change.modelId === model.modelId) &&
        !input.added.some((change) => change.providerType === model.providerType && change.modelId === model.modelId) &&
        !input.updated.some((change) => change.providerType === model.providerType && change.modelId === model.modelId) &&
        !input.skipped.some((change) => change.providerType === model.providerType && change.modelId === model.modelId),
    }
  }
  const localModels = input.discovered.filter((model) => model.providerType !== 'acp')
  const acpModels = input.discovered.filter((model) => model.providerType === 'acp')

  return {
    capabilityGroups: [
      {
        id: 'local-chat-models',
        title: 'Local Chat Models',
        description: 'Models served by local chat runtimes such as Ollama and LM Studio.',
        candidates: localModels.map(candidateFor),
      },
      {
        id: 'acp-models',
        title: 'ACP Models',
        description: 'ACP-connected coding runtimes. Forge starts these in the configured project repository folder.',
        candidates: acpModels.map(candidateFor),
      },
    ],
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

    const discoveryRequest = await parseDiscoveryRequest(request)
    if (discoveryRequest.autoConfigure && discoveryRequest.invalidReason) {
      return NextResponse.json({ error: discoveryRequest.invalidReason }, { status: 400 })
    }

    const [ollama, lmstudio] = await Promise.all([discoverOllama(), discoverLmStudio()])
    const acp = discoverAcpModels()
    const discovered = [...ollama, ...lmstudio.models, ...acp]
    const selectedForConfiguration = new Set(discoveryRequest.candidates.map(discoveredKey))
    const shouldConfigure = (model: DiscoveredModel) =>
      discoveryRequest.autoConfigure &&
      (selectedForConfiguration.size === 0 || selectedForConfiguration.has(discoveredKey(model)))

    const added: DiscoveryChange[] = []
    const updated: DiscoveryChange[] = []
    const configured: DiscoveryChange[] = []
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
          skipped.push({ providerType: model.providerType, modelId: model.modelId, reason: 'provider_disabled' })
          continue
        }
        if (!existing.isLocal) {
          skipped.push({ providerType: model.providerType, modelId: model.modelId, reason: 'nonlocal_existing_provider' })
          continue
        }

        const existingBaseUrl = normalizeComparableBaseUrl(model.providerType, existing.baseUrl)
        const discoveredBaseUrl = normalizeComparableBaseUrl(model.providerType, model.baseUrl)
        if (existingBaseUrl !== null && existingBaseUrl !== discoveredBaseUrl) {
          skipped.push({ providerType: model.providerType, modelId: model.modelId, reason: 'base_url_conflict' })
          continue
        }

        if (shouldConfigure(model) && existing.baseUrl !== model.baseUrl) {
          await db
            .update(providerConfigs)
            .set({
              baseUrl: model.baseUrl,
              isLocal: true,
              updatedAt: new Date(),
            })
            .where(eq(providerConfigs.id, existing.id))
          updated.push({ providerType: model.providerType, modelId: model.modelId })
        } else {
          configured.push({ providerType: model.providerType, modelId: model.modelId })
        }
        continue
      }

      if (shouldConfigure(model)) {
        await db.insert(providerConfigs).values({
          displayName: `${model.providerType === 'ollama' ? 'Ollama' : model.providerType === 'lmstudio' ? 'LM Studio' : 'ACP'}: ${model.modelId}`,
          providerType: model.providerType,
          modelId: model.modelId,
          baseUrl: model.baseUrl,
          isLocal: true,
        })
        added.push({ providerType: model.providerType, modelId: model.modelId })
      }
    }

    const groups = capabilityGroupsFor({
      discovered,
      added,
      updated,
      configured,
      skipped,
      lmstudioAuxiliary: lmstudio.auxiliaryCandidates,
    })

    return NextResponse.json({
      found: discovered.length,
      added,
      updated,
      configured,
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
