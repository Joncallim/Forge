import type { ProviderConfig } from '@/db/schema'

/**
 * Provider shape that is safe to return over the API. It never includes the
 * encrypted key material — only a boolean flag indicating whether a key is
 * stored, so the UI can show "key set / not set" without exposing the secret.
 */
export type PublicProviderConfig = Omit<ProviderConfig, 'apiKeyCiphertext'> & {
  hasApiKey: boolean
}

export function toPublicProvider(config: ProviderConfig): PublicProviderConfig {
  const hasApiKey = config.apiKeyCiphertext != null && config.apiKeyCiphertext !== ''
  const rest = { ...config } as Partial<ProviderConfig>
  delete rest.apiKeyCiphertext
  return { ...(rest as Omit<ProviderConfig, 'apiKeyCiphertext'>), hasApiKey }
}
