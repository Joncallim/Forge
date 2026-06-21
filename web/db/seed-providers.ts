/**
 * Seed the zero-config local AI provider.
 *
 * Run with: npx tsx db/seed-providers.ts
 * Or via:   npm run db:seed-providers
 *
 * Provisions a single Ollama provider (one small local model) and links every
 * agent to it, so a fresh install can run AI with no API keys and no manual
 * configuration. The macOS installer runs this after pulling the model.
 *
 * Safety:
 *  - No-op if any provider already exists (never clobbers a real configuration).
 *  - Only links agents that have no provider yet.
 *  - Run AFTER db:seed-agents so the agent rows exist to be linked.
 */
import '../lib/load-env'
import { db } from './index'
import { providerConfigs, agentConfigs } from './schema'
import { count, isNull } from 'drizzle-orm'
import { ZERO_CONFIG_MODEL_ID, ZERO_CONFIG_BASE_URL } from '../lib/recommendations'

const MODEL_ID = process.env.FORGE_ZERO_CONFIG_MODEL ?? ZERO_CONFIG_MODEL_ID
const BASE_URL = process.env.FORGE_OLLAMA_BASE_URL ?? ZERO_CONFIG_BASE_URL

async function main(): Promise<void> {
  const [{ value: existing }] = await db.select({ value: count() }).from(providerConfigs)

  if (existing > 0) {
    console.log(
      `[seed-providers] ${existing} provider(s) already configured — skipping zero-config seed.`,
    )
    process.exit(0)
  }

  console.log(`[seed-providers] Provisioning zero-config local provider (ollama / ${MODEL_ID})...`)

  const [provider] = await db
    .insert(providerConfigs)
    .values({
      displayName: `Ollama / ${MODEL_ID}`,
      providerType: 'ollama',
      modelId: MODEL_ID,
      baseUrl: BASE_URL,
      apiKeyEnvVar: null,
      apiKeyCiphertext: null,
      isLocal: true,
    })
    .returning()

  // Link every agent that has no provider yet to the local provider.
  const linked = await db
    .update(agentConfigs)
    .set({ providerConfigId: provider.id, updatedAt: new Date() })
    .where(isNull(agentConfigs.providerConfigId))
    .returning({ agentType: agentConfigs.agentType })

  console.log(`[seed-providers]   ✓ created provider ${provider.id}`)
  console.log(
    `[seed-providers]   ✓ linked ${linked.length} agent(s): ${
      linked.map((r) => r.agentType).join(', ') || '(none — run db:seed-agents first)'
    }`,
  )
  console.log('[seed-providers] Done. Local AI works with no API keys.')
  process.exit(0)
}

main().catch((err) => {
  console.error('[seed-providers] Fatal error:', err)
  process.exit(1)
})
