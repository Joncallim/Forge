import type { ProviderConfig } from '@/db/schema'
import type { ProviderType } from './types'
import { PROVIDER_TYPE_LABELS } from './types'
import { PROVIDER_CATALOG, providerSupportsUserBaseUrl } from './catalog'

const PROVIDER_API_KEY_ENV_VARS: Partial<Record<ProviderType, readonly string[]>> = {
  anthropic: ['ANTHROPIC_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  google: ['GOOGLE_GENERATIVE_AI_API_KEY', 'GOOGLE_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY'],
  xai: ['XAI_API_KEY'],
  deepseek: ['DEEPSEEK_API_KEY'],
  moonshot: ['MOONSHOT_API_KEY'],
  zhipu: ['ZHIPU_API_KEY'],
}

function allowedEnvVars(providerType: string): readonly string[] {
  return PROVIDER_API_KEY_ENV_VARS[providerType as ProviderType] ?? []
}

export function validateProviderApiKeyEnvVar(
  providerType: string,
  rawEnvVar: string | null | undefined,
): string | null {
  const envVar = rawEnvVar?.trim()
  if (!envVar) return null

  const allowed = allowedEnvVars(providerType)
  if (allowed.includes(envVar)) return null

  const label = PROVIDER_TYPE_LABELS[providerType as ProviderType] ?? providerType
  if (allowed.length === 0) {
    return `${label} providers cannot read API keys from server environment variables. Enter the key in the UI instead.`
  }

  return `${label} providers may only use these server environment variables: ${allowed.join(', ')}`
}

export function safeProviderApiKeyEnvVar(config: ProviderConfig): string | null {
  const envVar = config.apiKeyEnvVar?.trim()
  if (!envVar) return null
  return validateProviderApiKeyEnvVar(config.providerType, envVar) === null ? envVar : null
}

export function providerApiKeyEnvVarError(config: ProviderConfig): string | null {
  return validateProviderApiKeyEnvVar(config.providerType, config.apiKeyEnvVar)
}

function normalizeBaseUrl(rawBaseUrl: string): string {
  return rawBaseUrl.trim().replace(/\/+$/, '')
}

export function validateProviderBaseUrl(
  providerType: string,
  rawBaseUrl: string | null | undefined,
): string | null {
  const baseUrl = rawBaseUrl?.trim()
  if (!baseUrl) return null

  if (providerSupportsUserBaseUrl(providerType as ProviderType)) return null

  const defaultBaseUrl = PROVIDER_CATALOG[providerType as ProviderType]?.defaultBaseUrl
  if (defaultBaseUrl && normalizeBaseUrl(baseUrl) === normalizeBaseUrl(defaultBaseUrl)) {
    return null
  }

  const label = PROVIDER_TYPE_LABELS[providerType as ProviderType] ?? providerType
  return `${label} providers use Forge's fixed endpoint and cannot store a custom baseUrl.`
}

export function providerBaseUrlForStorage(
  providerType: string,
  rawBaseUrl: string | null | undefined,
): string | null {
  const baseUrl = rawBaseUrl?.trim()
  if (!baseUrl) return null
  return providerSupportsUserBaseUrl(providerType as ProviderType) ? baseUrl : null
}
