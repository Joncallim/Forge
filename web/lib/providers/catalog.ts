import type { ProviderType } from './types'

// ---------------------------------------------------------------------------
// Provider catalog
//
// Single source of truth describing each known provider: how it is reached, what
// the setup form should ask for, where to get an API key, and whether it runs
// locally, on a self-hosted (remote) endpoint, or in the cloud. The setup UI and
// the runtime registry both read from here so adding a provider is one edit.
// ---------------------------------------------------------------------------

export type ProviderCategory = 'local' | 'remote' | 'cloud'

export const PROVIDER_CATEGORY_LABELS: Record<ProviderCategory, string> = {
  local: 'Local',
  remote: 'Remote',
  cloud: 'Cloud',
}

export interface ProviderCatalogEntry {
  type: ProviderType
  category: ProviderCategory
  /** Whether an API key is normally required. */
  requiresApiKey: boolean
  /** Whether the user must supply the base URL (self-hosted / custom). */
  requiresBaseUrl: boolean
  /** Fixed or default base URL for OpenAI-compatible providers. */
  defaultBaseUrl?: string
  /** Where to obtain an API key — rendered as a link in the form. */
  apiKeyUrl?: string
  /** Example model id used as the input placeholder. */
  modelPlaceholder: string
  /** Short hint shown in the setup form. */
  helpText?: string
}

function normalizeBaseUrl(rawBaseUrl: string): string {
  return rawBaseUrl.trim().replace(/\/+$/, '')
}

export function normalizeLmStudioRuntimeBaseUrl(
  baseUrl: string | null | undefined,
): string | undefined {
  if (!baseUrl?.trim()) return undefined

  const normalized = normalizeBaseUrl(baseUrl)
  if (normalized.endsWith('/api/v1')) {
    return `${normalized.slice(0, -'/api/v1'.length)}/v1`
  }
  if (normalized.endsWith('/v1')) return normalized
  return `${normalized}/v1`
}

export function normalizeLmStudioNativeApiBaseUrl(
  baseUrl: string | null | undefined,
): string | undefined {
  if (!baseUrl?.trim()) return undefined

  const normalized = normalizeBaseUrl(baseUrl)
  if (normalized.endsWith('/api/v1')) return normalized
  if (normalized.endsWith('/v1')) {
    return `${normalized.slice(0, -'/v1'.length)}/api/v1`
  }
  return `${normalized}/api/v1`
}

export const PROVIDER_CATALOG: Record<ProviderType, ProviderCatalogEntry> = {
  acp: {
    type: 'acp',
    category: 'local',
    requiresApiKey: false,
    requiresBaseUrl: false,
    modelPlaceholder: 'claude-agent',
    helpText: 'Configures an ACP agent. Task execution is not enabled yet.',
  },
  anthropic: {
    type: 'anthropic',
    category: 'cloud',
    requiresApiKey: true,
    requiresBaseUrl: false,
    apiKeyUrl: 'https://console.anthropic.com/settings/keys',
    modelPlaceholder: 'claude-opus-4-8',
  },
  openai: {
    type: 'openai',
    category: 'cloud',
    requiresApiKey: true,
    requiresBaseUrl: false,
    apiKeyUrl: 'https://platform.openai.com/api-keys',
    modelPlaceholder: 'gpt-4.1',
  },
  google: {
    type: 'google',
    category: 'cloud',
    requiresApiKey: true,
    requiresBaseUrl: false,
    apiKeyUrl: 'https://aistudio.google.com/app/apikey',
    modelPlaceholder: 'gemini-2.0-flash',
  },
  openrouter: {
    type: 'openrouter',
    category: 'cloud',
    requiresApiKey: true,
    requiresBaseUrl: false,
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    apiKeyUrl: 'https://openrouter.ai/keys',
    modelPlaceholder: 'moonshotai/kimi-k2',
    helpText: 'Routes to many models behind one key.',
  },
  xai: {
    type: 'xai',
    category: 'cloud',
    requiresApiKey: true,
    requiresBaseUrl: false,
    defaultBaseUrl: 'https://api.x.ai/v1',
    apiKeyUrl: 'https://console.x.ai',
    modelPlaceholder: 'grok-4',
  },
  deepseek: {
    type: 'deepseek',
    category: 'cloud',
    requiresApiKey: true,
    requiresBaseUrl: false,
    defaultBaseUrl: 'https://api.deepseek.com',
    apiKeyUrl: 'https://platform.deepseek.com/api_keys',
    modelPlaceholder: 'deepseek-chat',
  },
  moonshot: {
    type: 'moonshot',
    category: 'cloud',
    requiresApiKey: true,
    requiresBaseUrl: false,
    defaultBaseUrl: 'https://api.moonshot.ai/v1',
    apiKeyUrl: 'https://platform.moonshot.ai/console/api-keys',
    modelPlaceholder: 'kimi-k2-0905-preview',
  },
  zhipu: {
    type: 'zhipu',
    category: 'cloud',
    requiresApiKey: true,
    requiresBaseUrl: false,
    defaultBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    apiKeyUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
    modelPlaceholder: 'glm-4.6',
  },
  litellm: {
    type: 'litellm',
    category: 'remote',
    requiresApiKey: false,
    requiresBaseUrl: true,
    defaultBaseUrl: 'http://localhost:4000',
    modelPlaceholder: 'gpt-4.1',
    helpText: 'Self-hosted OpenAI-compatible gateway.',
  },
  ollama: {
    type: 'ollama',
    category: 'local',
    requiresApiKey: false,
    requiresBaseUrl: false,
    defaultBaseUrl: 'http://localhost:11434',
    modelPlaceholder: 'qwen2.5-coder:7b',
    helpText: 'Runs locally via Ollama. No API key needed.',
  },
  lmstudio: {
    type: 'lmstudio',
    category: 'local',
    requiresApiKey: false,
    requiresBaseUrl: false,
    defaultBaseUrl: 'http://localhost:1234/v1',
    modelPlaceholder: 'local-model',
    helpText: 'Runs locally via LM Studio. No API key needed.',
  },
  custom: {
    type: 'custom',
    category: 'remote',
    requiresApiKey: false,
    requiresBaseUrl: true,
    modelPlaceholder: 'provider/model',
    helpText: 'Any OpenAI-compatible endpoint.',
  },
}

/** Classify a provider as Local / Remote / Cloud. An explicit local flag wins. */
export function providerCategory(type: ProviderType, isLocal?: boolean): ProviderCategory {
  if (isLocal) return 'local'
  return PROVIDER_CATALOG[type]?.category ?? 'cloud'
}

export function providerSupportsUserBaseUrl(type: ProviderType | string): boolean {
  const entry = PROVIDER_CATALOG[type as ProviderType]
  if (!entry) return false
  return entry.requiresBaseUrl || entry.category === 'local'
}
