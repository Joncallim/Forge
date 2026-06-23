import { generateText } from 'ai'
import { and, eq, isNull, lt, or } from 'drizzle-orm'
import { db } from '@/db'
import { providerConfigs, providerHealthChecks, type ProviderConfig } from '@/db/schema'
import { getModel } from './registry'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ProviderHealthResult = {
  reachable: boolean
  envVarPresent: boolean
  latencyMs: number | null
  error: string | null
  checkedAt?: string | null
}

const DEFAULT_STALE_AFTER_MS = 5 * 60 * 1000

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
      reachable: health.reachable,
      envVarPresent: health.envVarPresent,
      latencyMs: health.latencyMs,
      error: health.error,
      checkedAt,
    })
    .onConflictDoUpdate({
      target: providerHealthChecks.providerConfigId,
      set: {
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
