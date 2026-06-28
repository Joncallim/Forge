import { generateText } from 'ai'
import { and, eq, isNull, lt, or } from 'drizzle-orm'
import { db } from '@/db'
import { providerConfigs, providerHealthChecks, type ProviderConfig } from '@/db/schema'
import { getModel } from './registry'
import { providerApiKeyEnvVarError, safeProviderApiKeyEnvVar } from './credentials'
import { decryptSecret } from '@/lib/crypto'
import { PROVIDER_CATALOG } from './catalog'
import { listLmStudioModelIds } from './model-listing'
import { checkAcpReadiness } from './acp/handshake'
import { parseAcpProviderModelId } from './acp/catalog'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Fine-grained readiness state. `reachable` is derived from this (true only
 * for `ready`) and kept for wire/back-compat with existing UI and tests.
 */
export type ProviderHealthStatus =
  | 'not_configured'
  | 'available'
  | 'unreachable'
  | 'handshake_failed'
  | 'authenticated_unavailable'
  | 'ready'

export type ProviderHealthResult = {
  status: ProviderHealthStatus
  reachable: boolean
  envVarPresent: boolean
  latencyMs: number | null
  error: string | null
  checkedAt?: string | null
}

function readyResult(envVarPresent: boolean, latencyMs: number | null): ProviderHealthResult {
  return { status: 'ready', reachable: true, envVarPresent, latencyMs, error: null }
}

function unreachableResult(envVarPresent: boolean, error: string): ProviderHealthResult {
  return { status: 'unreachable', reachable: false, envVarPresent, latencyMs: null, error }
}

function availableResult(envVarPresent: boolean, latencyMs: number | null, error: string): ProviderHealthResult {
  return { status: 'available', reachable: false, envVarPresent, latencyMs, error }
}

const DEFAULT_STALE_AFTER_MS = 5 * 60 * 1000
const HEALTH_TIMEOUT_MS = 3000

function truncateProviderError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  return raw.slice(0, 200)
}

function optionalAuthorizationHeaders(config: ProviderConfig): Record<string, string> {
  if (!config.apiKeyCiphertext) return {}
  return { Authorization: `Bearer ${decryptSecret(config.apiKeyCiphertext)}` }
}

function normalizeOllamaNativeApiBaseUrl(baseUrl: string | null | undefined): string | undefined {
  const raw = baseUrl?.trim() || PROVIDER_CATALOG.ollama.defaultBaseUrl
  if (!raw?.trim()) return undefined

  const normalized = raw.trim().replace(/\/+$/, '')
  if (normalized.endsWith('/v1')) return normalized.slice(0, -'/v1'.length)
  return normalized
}

function ollamaModelNames(payload: unknown): string[] {
  if (!payload || typeof payload !== 'object') return []
  const models = (payload as { models?: unknown }).models
  if (!Array.isArray(models)) return []

  return models.flatMap((model) => {
    if (!model || typeof model !== 'object') return []
    const { name, model: modelId } = model as { name?: unknown; model?: unknown }
    return [name, modelId].filter((value): value is string => typeof value === 'string')
  })
}

function ollamaModelIsInstalled(modelNames: string[], modelId: string): boolean {
  return modelNames.includes(modelId) || (!modelId.includes(':') && modelNames.includes(`${modelId}:latest`))
}

async function checkOllamaHealth(
  config: ProviderConfig,
  envVarPresent: boolean,
): Promise<ProviderHealthResult> {
  const nativeBaseUrl = normalizeOllamaNativeApiBaseUrl(config.baseUrl)
  if (!nativeBaseUrl) {
    return unreachableResult(envVarPresent, 'A base URL is required to check Ollama health')
  }

  let timer: ReturnType<typeof setTimeout> | undefined
  let timedOut = false
  const controller = new AbortController()
  const start = Date.now()

  try {
    timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, HEALTH_TIMEOUT_MS)

    const res = await fetch(`${nativeBaseUrl}/api/tags`, {
      method: 'GET',
      headers: optionalAuthorizationHeaders(config),
      signal: controller.signal,
    })

    if (!res.ok) {
      throw new Error(`Ollama returned ${res.status}`)
    }

    const modelNames = ollamaModelNames(await res.json())
    if (!ollamaModelIsInstalled(modelNames, config.modelId)) {
      return {
        status: 'unreachable',
        reachable: false,
        envVarPresent,
        latencyMs: Date.now() - start,
        error: `Ollama is reachable, but model "${config.modelId}" is not installed`,
      }
    }

    return readyResult(envVarPresent, Date.now() - start)
  } catch (err: unknown) {
    return unreachableResult(
      envVarPresent,
      timedOut ? `Health check timed out after ${HEALTH_TIMEOUT_MS}ms` : truncateProviderError(err),
    )
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function checkLmStudioHealth(
  config: ProviderConfig,
  envVarPresent: boolean,
): Promise<ProviderHealthResult> {
  const start = Date.now()

  try {
    const listing = await listLmStudioModelIds({
      baseUrl: config.baseUrl ?? PROVIDER_CATALOG.lmstudio.defaultBaseUrl ?? null,
      apiKey: config.apiKeyCiphertext ? decryptSecret(config.apiKeyCiphertext) : '',
      timeoutMs: HEALTH_TIMEOUT_MS,
    })

    const modelListed = listing.models.includes(config.modelId)
    const modelLoaded = listing.loadedModels.includes(config.modelId)
    if (!modelListed && !modelLoaded) {
      return {
        status: 'unreachable',
        reachable: false,
        envVarPresent,
        latencyMs: Date.now() - start,
        error: `LM Studio is reachable, but model "${config.modelId}" was not returned by the ${listing.source} model list.`,
      }
    }

    if (listing.source === 'native' && !modelLoaded) {
      return availableResult(
        envVarPresent,
        Date.now() - start,
        `LM Studio has model "${config.modelId}" available, but it is not loaded. First use may take longer while LM Studio loads it.`,
      )
    }

    return readyResult(envVarPresent, Date.now() - start)
  } catch (err: unknown) {
    return unreachableResult(envVarPresent, truncateProviderError(err))
  }
}

// ---------------------------------------------------------------------------
// checkProviderHealth
// ---------------------------------------------------------------------------

export async function checkProviderHealth(
  config: ProviderConfig,
): Promise<ProviderHealthResult> {
  if (config.providerType === 'acp') {
    const readiness = await checkAcpReadiness(parseAcpProviderModelId(config.modelId).agentId)
    return {
      status: readiness.status,
      reachable: readiness.status === 'ready',
      envVarPresent: true,
      latencyMs: readiness.latencyMs,
      error: readiness.status === 'ready' ? null : readiness.message,
    }
  }

  // A credential is "present" if a key was entered via the UI (stored
  // encrypted), or the configured env var is set, or none is configured
  // (local/keyless providers). `envVarPresent` is kept as the field name for
  // wire compatibility but now means "credential present".
  const safeEnvVar = safeProviderApiKeyEnvVar(config)
  const unsafeEnvVarError = providerApiKeyEnvVarError(config)
  const envVarPresent =
    !!config.apiKeyCiphertext ||
    (safeEnvVar ? !!process.env[safeEnvVar] : unsafeEnvVarError === null)

  if (!envVarPresent) {
    return unreachableResult(
      envVarPresent,
      unsafeEnvVarError
        ? unsafeEnvVarError
        : safeEnvVar
        ? `No API key set (enter one in the UI, or set ${safeEnvVar})`
        : 'No API key set',
    )
  }

  if (config.providerType === 'lmstudio') {
    return checkLmStudioHealth(config, envVarPresent)
  }

  if (config.providerType === 'ollama') {
    return checkOllamaHealth(config, envVarPresent)
  }

  let reachable = false
  let latencyMs: number | null = null
  let error: string | null = null

  try {
    const model = await getModel(config.id)
    if (!model) {
      return unreachableResult(envVarPresent, 'Provider config not found or inactive')
    }

    const start = Date.now()

    // Race a minimal generateText call against a 3-second timeout
    let timer: ReturnType<typeof setTimeout>
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Health check timed out after 3000ms')), 3000)
    })
    try {
      await Promise.race([
        generateText({
          model,
          prompt: 'Reply with the single word: ok',
          maxOutputTokens: 1,
        }),
        timeout,
      ])
      clearTimeout(timer!)
    } catch (err) {
      clearTimeout(timer!)
      throw err
    }

    latencyMs = Date.now() - start
    reachable = true
  } catch (err: unknown) {
    reachable = false
    latencyMs = null

    // Truncate error to 200 chars. Never include resolved API key values.
    error = truncateProviderError(err)
  }

  return { status: reachable ? 'ready' : 'unreachable', reachable, envVarPresent, latencyMs, error }
}

export async function getCachedProviderHealth(
  providerConfigId: string,
): Promise<ProviderHealthResult | null> {
  const [row] = await db
    .select()
    .from(providerHealthChecks)
    .where(eq(providerHealthChecks.providerConfigId, providerConfigId))
    .limit(1)

  if (!row) return null
  return {
    status: row.status as ProviderHealthStatus,
    reachable: row.reachable,
    envVarPresent: row.envVarPresent,
    latencyMs: row.latencyMs,
    error: row.error,
    checkedAt: row.checkedAt.toISOString(),
  }
}

export async function refreshProviderHealth(
  config: ProviderConfig,
): Promise<ProviderHealthResult> {
  const health = await checkProviderHealth(config)
  const checkedAt = new Date()

  await db
    .insert(providerHealthChecks)
    .values({
      providerConfigId: config.id,
      status: health.status,
      reachable: health.reachable,
      envVarPresent: health.envVarPresent,
      latencyMs: health.latencyMs,
      error: health.error,
      checkedAt,
    })
    .onConflictDoUpdate({
      target: providerHealthChecks.providerConfigId,
      set: {
        status: health.status,
        reachable: health.reachable,
        envVarPresent: health.envVarPresent,
        latencyMs: health.latencyMs,
        error: health.error,
        checkedAt,
      },
    })

  return { ...health, checkedAt: checkedAt.toISOString() }
}

export async function refreshProviderHealthById(
  providerConfigId: string,
): Promise<ProviderHealthResult | null> {
  const [config] = await db
    .select()
    .from(providerConfigs)
    .where(eq(providerConfigs.id, providerConfigId))
    .limit(1)

  if (!config) return null
  return refreshProviderHealth(config)
}

export async function refreshStaleProviderHealth(
  staleAfterMs: number = DEFAULT_STALE_AFTER_MS,
): Promise<number> {
  const staleBefore = new Date(Date.now() - staleAfterMs)
  const staleProviders = await db
    .select({ config: providerConfigs })
    .from(providerConfigs)
    .leftJoin(
      providerHealthChecks,
      eq(providerHealthChecks.providerConfigId, providerConfigs.id),
    )
    .where(
      and(
        eq(providerConfigs.isActive, true),
        or(
          isNull(providerHealthChecks.providerConfigId),
          lt(providerHealthChecks.checkedAt, staleBefore),
        )!,
      ),
    )

  await Promise.allSettled(staleProviders.map(({ config }) => refreshProviderHealth(config)))
  return staleProviders.length
}
