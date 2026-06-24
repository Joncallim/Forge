import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAI } from '@ai-sdk/openai'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import type { LanguageModel } from 'ai'
import { db } from '@/db'
import { providerConfigs } from '@/db/schema'
import type { ProviderConfig } from '@/db/schema'
import { eq, asc } from 'drizzle-orm'
import { requiresProviderBaseUrl } from './types'
import { PROVIDER_CATALOG } from './catalog'
import { decryptSecret } from '@/lib/crypto'
import type { ProviderType } from './types'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ProviderFactory =
  | ReturnType<typeof createAnthropic>
  | ReturnType<typeof createOpenAI>
  | ReturnType<typeof createGoogleGenerativeAI>

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
 * encrypted in `apiKeyCiphertext`) takes precedence; otherwise we fall back to
 * the legacy `apiKeyEnvVar` env-var lookup for backward compatibility.
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

  if (config.apiKeyEnvVar) {
    const fromEnv = process.env[config.apiKeyEnvVar]
    if (fromEnv === undefined) {
      console.warn(
        `[providers/registry] env var "${config.apiKeyEnvVar}" is not set for provider config ${config.id} (${config.displayName}). The provider will be instantiated but calls will likely fail.`,
      )
    }
    return fromEnv
  }

  return undefined
}

function buildProvider(config: ProviderConfig): ProviderFactory {
  const apiKey = resolveApiKey(config)

  switch (config.providerType) {
    case 'acp':
      throw new Error('ACP provider execution is not implemented yet')

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
        baseURL: config.baseUrl ?? PROVIDER_CATALOG[config.providerType].defaultBaseUrl,
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
        baseURL: config.baseUrl ?? PROVIDER_CATALOG.lmstudio.defaultBaseUrl,
      })

    default:
      throw new Error(
        `[providers/registry] Unknown providerType "${config.providerType}" for config ${config.id}`,
      )
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
