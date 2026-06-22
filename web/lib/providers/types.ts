export const PROVIDER_TYPES = [
  'anthropic',
  'openai',
  'google',
  'openrouter',
  'xai',
  'deepseek',
  'moonshot',
  'zhipu',
  'litellm',
  'ollama',
  'lmstudio',
  'custom',
] as const

export type ProviderType = (typeof PROVIDER_TYPES)[number]

export const PROVIDER_TYPE_LABELS: Record<ProviderType, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google (Gemini)',
  openrouter: 'OpenRouter',
  xai: 'xAI (Grok)',
  deepseek: 'DeepSeek',
  moonshot: 'Moonshot (Kimi)',
  zhipu: 'Zhipu (GLM)',
  litellm: 'LiteLLM',
  ollama: 'Ollama',
  lmstudio: 'LM Studio',
  custom: 'Custom (OpenAI-compatible)',
}

export const PROVIDER_TYPE_OPTIONS = PROVIDER_TYPES.map((value) => ({
  value,
  label: PROVIDER_TYPE_LABELS[value],
}))

// Provider types that need a user-supplied base URL (self-hosted / custom
// endpoints). Cloud providers below have a fixed, known base URL; local
// providers default to localhost but the URL can be overridden.
const BASE_URL_REQUIRED_PROVIDER_TYPES = new Set<ProviderType>([
  'custom',
  'litellm',
])

export function requiresProviderBaseUrl(providerType: string): boolean {
  return BASE_URL_REQUIRED_PROVIDER_TYPES.has(providerType as ProviderType)
}
