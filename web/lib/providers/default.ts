import { and, desc, eq } from 'drizzle-orm'
import { db } from '@/db'
import { appSettings, providerConfigs, providerHealthChecks, type ProviderConfig } from '@/db/schema'

// ---------------------------------------------------------------------------
// Workspace default provider (issue #88)
//
// Stored as a single key in the generic `app_settings` table (same pattern
// as the GitHub PAT in lib/github.ts) rather than a dedicated column/table,
// since it's just one nullable foreign key.
// ---------------------------------------------------------------------------

export const DEFAULT_PROVIDER_SETTING_KEY = 'default_provider_config_id'

export async function getDefaultProviderConfigId(): Promise<string | null> {
  const [row] = await db
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, DEFAULT_PROVIDER_SETTING_KEY))
    .limit(1)

  return row?.value ?? null
}

export async function setDefaultProviderConfigId(providerConfigId: string): Promise<void> {
  await db
    .insert(appSettings)
    .values({ key: DEFAULT_PROVIDER_SETTING_KEY, value: providerConfigId })
    .onConflictDoUpdate({
      target: appSettings.key,
      set: { value: providerConfigId, updatedAt: new Date() },
    })
}

export async function clearDefaultProviderConfigId(): Promise<void> {
  await db.delete(appSettings).where(eq(appSettings.key, DEFAULT_PROVIDER_SETTING_KEY))
}

// ---------------------------------------------------------------------------
// resolveDefaultProvider
//
// Fallback chain (issue #88):
//   1. the configured default, if it's still an active provider config
//   2. the zero-config local model (Ollama/LM Studio) with the most recent
//      "ready" health check, if any
//   3. null — callers must treat this as "no provider available", not a
//      stale reference
// ---------------------------------------------------------------------------

export async function resolveDefaultProvider(): Promise<ProviderConfig | null> {
  const defaultId = await getDefaultProviderConfigId()
  if (defaultId) {
    const [config] = await db
      .select()
      .from(providerConfigs)
      .where(eq(providerConfigs.id, defaultId))
      .limit(1)
    if (config && config.isActive) return config
  }

  // Fall back to the local (zero-config) provider whose most recent health check
  // is `ready`. Health checks are appended over time, so we sort newest-first and
  // consider only each provider's latest row — a provider that was ready hours
  // ago but whose latest check is now unreachable must not be returned.
  const localCandidates = await db
    .select({ config: providerConfigs, status: providerHealthChecks.status })
    .from(providerConfigs)
    .innerJoin(providerHealthChecks, eq(providerHealthChecks.providerConfigId, providerConfigs.id))
    .where(and(eq(providerConfigs.isActive, true), eq(providerConfigs.isLocal, true)))
    .orderBy(desc(providerHealthChecks.checkedAt))

  const seen = new Set<string>()
  for (const row of localCandidates) {
    if (seen.has(row.config.id)) continue
    seen.add(row.config.id)
    if (row.status === 'ready') return row.config
  }

  return null
}
