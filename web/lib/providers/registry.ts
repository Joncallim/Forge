import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAI } from '@ai-sdk/openai'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import type { LanguageModel } from 'ai'
import { db } from '@/db'
import { providerConfigs } from '@/db/schema'
import type { ProviderConfig } from '@/db/schema'
import { eq, asc } from 'drizzle-orm'
import { requiresProviderBaseUrl } from './types'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ProviderFactory =
  | ReturnType<typeof createAnthropic>
  | ReturnType<typeof createOpenAI>
  | ReturnType<typeof createGoogleGenerativeAI>

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

function buildProvider(config: ProviderConfig): ProviderFactory {
  const apiKey = config.apiKeyEnvVar ? process.env[config.apiKeyEnvVar] : undefined

  if (config.apiKeyEnvVar && apiKey === undefined) {
    console.warn(
      `[providers/registry] env var "${config.apiKeyEnvVar}" is not set for provider config ${config.id} (${config.displayName}). The provider will be instantiated but calls will likely fail.`,
    )
  }

  switch (config.providerType) {
    case 'anthropic':
      return createAnthropic({ apiKey })

    case 'openai':
      return createOpenAI({ apiKey })

    case 'google':
      return createGoogleGenerativeAI({ apiKey })

    case 'openrouter':
      return createOpenAI({
        apiKey,
        baseURL: 'https://openrouter.ai/api/v1',
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
        baseURL: config.baseUrl ?? undefined,
      })

    case 'ollama':
      return createOpenAI({
        apiKey: apiKey ?? 'ollama',
        baseURL: normalizeOllamaBaseUrl(config.baseUrl),
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
