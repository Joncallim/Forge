import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAI } from '@ai-sdk/openai'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import type { LanguageModel } from 'ai'
import { db } from '@/db'
import { providerConfigs } from '@/db/schema'
import type { ProviderConfig } from '@/db/schema'
import { eq, asc } from 'drizzle-orm'
import { requiresProviderBaseUrl } from './types'
import { normalizeLmStudioNativeApiBaseUrl, normalizeLmStudioRuntimeBaseUrl, PROVIDER_CATALOG } from './catalog'
import { decryptSecret } from '@/lib/crypto'
import { providerApiKeyEnvVarError, safeProviderApiKeyEnvVar } from './credentials'
import type { ProviderType } from './types'
import { AcpLanguageModel } from './acp/language-model'
import { listLmStudioModelIds } from './model-listing'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ProviderFactory =
  | ReturnType<typeof createAnthropic>
  | ReturnType<typeof createOpenAI>
  | ReturnType<typeof createGoogleGenerativeAI>
  | ((modelId: string) => AcpLanguageModel)

const CHAT_COMPLETIONS_PROVIDER_TYPES = new Set<ProviderType>([
  'openrouter',
  'xai',
  'deepseek',
  'moonshot',
  'zhipu',
  'litellm',
  'custom',
  'ollama',
  'lmstudio',
])

export type ProviderResult = {
  provider: ProviderFactory
  config: ProviderConfig
}

// ---------------------------------------------------------------------------
// Internal: build a provider factory from a DB row
// ---------------------------------------------------------------------------

function normalizeOllamaBaseUrl(baseUrl: string | null): string | undefined {
  if (!baseUrl) return undefined

  const trimmed = baseUrl.replace(/\/+$/, '')
  return trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`
}

/**
 * Resolve the API key for a provider. A key entered via the UI (stored
 * encrypted in `apiKeyCiphertext`) takes precedence; otherwise we allow only
 * fixed, provider-specific env-var names for cloud providers.
 */
function resolveApiKey(config: ProviderConfig): string | undefined {
  if (config.apiKeyCiphertext) {
    try {
      return decryptSecret(config.apiKeyCiphertext)
    } catch (err) {
      console.error(
        `[providers/registry] failed to decrypt stored key for provider config ${config.id} (${config.displayName}):`,
        err instanceof Error ? err.message : err,
      )
      // Fall through to the env-var path rather than failing hard.
    }
  }

  const safeEnvVar = safeProviderApiKeyEnvVar(config)
  if (safeEnvVar) {
    const fromEnv = process.env[safeEnvVar]
    if (fromEnv === undefined) {
      console.warn(
        `[providers/registry] env var "${safeEnvVar}" is not set for provider config ${config.id} (${config.displayName}). The provider will be instantiated but calls will likely fail.`,
      )
    }
    return fromEnv
  }

  const unsafeEnvVarError = providerApiKeyEnvVarError(config)
  if (unsafeEnvVarError) {
    console.warn(
      `[providers/registry] ignored unsafe apiKeyEnvVar "${config.apiKeyEnvVar}" for provider config ${config.id} (${config.displayName}): ${unsafeEnvVarError}`,
    )
  }

  return undefined
}

function buildProvider(config: ProviderConfig): ProviderFactory {
  const apiKey = resolveApiKey(config)

  switch (config.providerType) {
    case 'acp':
      // ACP agents are spawned per-call (see lib/providers/acp/language-model.ts),
      // not authenticated with an apiKey, so just return a callable factory
      // matching the other 'local' provider types (ollama, lmstudio).
      return (modelId: string) => new AcpLanguageModel(modelId)

    case 'anthropic':
      return createAnthropic({ apiKey })

    case 'openai':
      return createOpenAI({ apiKey })

    case 'google':
      return createGoogleGenerativeAI({ apiKey })

    case 'openrouter':
    case 'xai':
    case 'deepseek':
    case 'moonshot':
    case 'zhipu':
      // OpenAI-compatible cloud providers with a known, fixed base URL.
      return createOpenAI({
        apiKey,
        baseURL: PROVIDER_CATALOG[config.providerType].defaultBaseUrl,
      })

    case 'litellm':
    case 'custom':
      if (requiresProviderBaseUrl(config.providerType) && !config.baseUrl) {
        throw new Error(
          `[providers/registry] baseUrl is required for ${config.providerType} provider config ${config.id}`,
        )
      }

      return createOpenAI({
        apiKey,
        baseURL: config.baseUrl ?? PROVIDER_CATALOG[config.providerType].defaultBaseUrl,
      })

    case 'ollama':
      return createOpenAI({
        apiKey: apiKey ?? 'ollama',
        baseURL: normalizeOllamaBaseUrl(config.baseUrl ?? PROVIDER_CATALOG.ollama.defaultBaseUrl ?? null),
      })

    case 'lmstudio':
      // OpenAI-compatible local server (LM Studio). No real key required.
      return createOpenAI({
        apiKey: apiKey ?? 'lm-studio',
        baseURL: normalizeLmStudioRuntimeBaseUrl(
          config.baseUrl ?? PROVIDER_CATALOG.lmstudio.defaultBaseUrl ?? null,
        ),
      })

    default:
      throw new Error(
        `[providers/registry] Unknown providerType "${config.providerType}" for config ${config.id}`,
      )
  }
}

function isLoopbackHttpUrl(rawUrl: string | undefined): boolean {
  if (!rawUrl) return false
  try {
    const url = new URL(rawUrl)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
    return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname)
  } catch {
    return false
  }
}

async function ensureLmStudioModelLoaded(config: ProviderConfig): Promise<void> {
  if (!config.isLocal) return
  const nativeBaseUrl = normalizeLmStudioNativeApiBaseUrl(
    config.baseUrl ?? PROVIDER_CATALOG.lmstudio.defaultBaseUrl ?? null,
  )
  if (!isLoopbackHttpUrl(nativeBaseUrl)) return

  const apiKey = resolveApiKey(config)
  const listing = await listLmStudioModelIds({
    baseUrl: config.baseUrl ?? PROVIDER_CATALOG.lmstudio.defaultBaseUrl ?? null,
    apiKey,
    timeoutMs: 3000,
  })

  if (listing.source !== 'native' || listing.loadedModels.includes(config.modelId)) return
  if (!listing.models.includes(config.modelId)) return

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 120_000)
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`
    const res = await fetch(`${nativeBaseUrl}/models/load`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: config.modelId }),
      signal: controller.signal,
    })
    if (!res.ok) {
      const message = await res.text().catch(() => '')
      throw new Error(`LM Studio could not load "${config.modelId}" (${res.status})${message ? `: ${message.slice(0, 200)}` : ''}`)
    }
  } finally {
    clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------
// getProvider
// ---------------------------------------------------------------------------

export async function getProvider(configId: string): Promise<ProviderResult | null> {
  const [config] = await db
    .select()
    .from(providerConfigs)
    .where(eq(providerConfigs.id, configId))
    .limit(1)

  if (!config || !config.isActive) {
    return null
  }

  const provider = buildProvider(config)
  return { provider, config }
}

// ---------------------------------------------------------------------------
// getModel
// ---------------------------------------------------------------------------

export async function getModel(configId: string): Promise<LanguageModel | null> {
  const result = await getProvider(configId)
  if (!result) return null

  const { provider, config } = result
  if (config.providerType === 'lmstudio') {
    await ensureLmStudioModelLoaded(config)
  }
  if (CHAT_COMPLETIONS_PROVIDER_TYPES.has(config.providerType as ProviderType)) {
    return (provider as { chat: (modelId: string) => LanguageModel }).chat(config.modelId)
  }

  // All Vercel AI SDK provider factories are callable with a model ID.
  // The return type is LanguageModelV1 / LanguageModelV3 which satisfy LanguageModel.
  return (provider as (modelId: string) => LanguageModel)(config.modelId)
}

// ---------------------------------------------------------------------------
// listActiveProviders
// ---------------------------------------------------------------------------

export async function listActiveProviders(): Promise<ProviderConfig[]> {
  return db
    .select()
    .from(providerConfigs)
    .where(eq(providerConfigs.isActive, true))
    .orderBy(asc(providerConfigs.createdAt))
}
