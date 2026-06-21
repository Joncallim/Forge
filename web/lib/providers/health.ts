import { generateText } from 'ai'
import type { ProviderConfig } from '@/db/schema'
import { getModel } from './registry'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ProviderHealthResult = {
  reachable: boolean
  envVarPresent: boolean
  latencyMs: number | null
  error: string | null
}

// ---------------------------------------------------------------------------
// checkProviderHealth
// ---------------------------------------------------------------------------

export async function checkProviderHealth(
  config: ProviderConfig,
): Promise<ProviderHealthResult> {
  // A credential is "present" if a key was entered via the UI (stored
  // encrypted), or the configured env var is set, or none is configured
  // (local/keyless providers). `envVarPresent` is kept as the field name for
  // wire compatibility but now means "credential present".
  const envVarPresent =
    !!config.apiKeyCiphertext ||
    (config.apiKeyEnvVar ? !!process.env[config.apiKeyEnvVar] : true)

  if (!envVarPresent) {
    return {
      reachable: false,
      envVarPresent,
      latencyMs: null,
      error: config.apiKeyEnvVar
        ? `No API key set (enter one in the UI, or set ${config.apiKeyEnvVar})`
        : 'No API key set',
    }
  }

  let reachable = false
  let latencyMs: number | null = null
  let error: string | null = null

  try {
    const model = await getModel(config.id)
    if (!model) {
      return { reachable: false, envVarPresent, latencyMs: null, error: 'Provider config not found or inactive' }
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
    const raw = err instanceof Error ? err.message : String(err)
    error = raw.slice(0, 200)
  }

  return { reachable, envVarPresent, latencyMs, error }
}
