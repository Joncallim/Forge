/**
 * Suite — zero-config preset invariants (lib/recommendations.ts)
 *
 * Guards the promise that the zero-config preset runs entirely locally and
 * needs no API keys. If someone edits a model into a cloud provider here, the
 * "works with no keys" guarantee breaks — these tests catch that.
 */
import { describe, it, expect } from 'vitest'
import { PRESETS, ZERO_CONFIG_MODEL_ID, ZERO_CONFIG_BASE_URL } from '@/lib/recommendations'

describe('zero-config preset', () => {
  const preset = PRESETS.find((p) => p.id === 'zero-config')

  it('exists and is listed first as the default starting point', () => {
    expect(preset).toBeDefined()
    expect(PRESETS[0]?.id).toBe('zero-config')
  })

  it('is fully local and requires no API keys for every role', () => {
    const agents = Object.values(preset!.agents)
    expect(agents.length).toBeGreaterThan(0)
    for (const agent of agents) {
      expect(agent.isLocal).toBe(true)
      expect(agent.providerType).toBe('ollama')
      expect(agent.apiKeyEnvVar).toBeUndefined()
      expect(agent.modelId).toBe(ZERO_CONFIG_MODEL_ID)
      expect(agent.baseUrl).toBe(ZERO_CONFIG_BASE_URL)
    }
  })

  it('covers the seeded default delivery roles', () => {
    expect(Object.keys(preset!.agents).sort()).toEqual([
      'architect',
      'backend',
      'devops',
      'frontend',
      'qa',
      'reviewer',
    ])
  })

  it('costs nothing', () => {
    expect(preset!.estimatedMonthlyCost).toMatch(/\$0/)
  })
})
