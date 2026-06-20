export const PROVIDER_TYPES = [
  'anthropic',
  'openai',
  'google',
  'openrouter',
  'ollama',
  'litellm',
  'custom',
] as const

export type ProviderType = (typeof PROVIDER_TYPES)[number]

export const PROVIDER_TYPE_LABELS: Record<ProviderType, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
  openrouter: 'OpenRouter',
  ollama: 'Ollama',
  litellm: 'LiteLLM',
  custom: 'Custom',
}

export const PROVIDER_TYPE_OPTIONS = PROVIDER_TYPES.map((value) => ({
  value,
  label: PROVIDER_TYPE_LABELS[value],
}))

const BASE_URL_REQUIRED_PROVIDER_TYPES = new Set<ProviderType>([
  'custom',
  'ollama',
  'litellm',
])

export function requiresProviderBaseUrl(providerType: string): boolean {
  return BASE_URL_REQUIRED_PROVIDER_TYPES.has(providerType as ProviderType)
}
