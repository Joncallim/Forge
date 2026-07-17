import { describe, expect, it } from 'vitest'
import {
  EPIC_172_S6_SUITE_COMMANDS,
  epic172S6SuiteManifest,
  parseEpic172S6SuiteManifest,
} from '@/lib/mcps/epic-172-s6-suite-contract'

describe('Epic 172 S6 suite contract', () => {
  it('[scenarioId=epic-172.suite-manifest-exact] validates the exact six-partition manifest', () => {
    expect(epic172S6SuiteManifest.partitions.map((partition) => partition.id).sort()).toEqual([
      'contract',
      'host-boundary',
      'issuance',
      'operator-desktop',
      'operator-mobile',
      'postgres',
    ])
    expect(EPIC_172_S6_SUITE_COMMANDS['operator-desktop']).toBe('e2e:mcp-operator')
    expect(EPIC_172_S6_SUITE_COMMANDS['operator-mobile']).toBe('e2e:mcp-operator')
  })

  it.each([
    ['empty partition', (manifest: Record<string, unknown>) => {
      const partitions = structuredClone(manifest.partitions) as Array<Record<string, unknown>>
      partitions[0].expectedCount = 0
      partitions[0].executionKeys = []
      manifest.partitions = partitions
    }],
    ['wildcard', (manifest: Record<string, unknown>) => {
      const partitions = structuredClone(manifest.partitions) as Array<Record<string, unknown>>
      partitions[0].executionKeys = ['vitest::*']
      partitions[0].expectedCount = 1
      manifest.partitions = partitions
    }],
    ['count drift', (manifest: Record<string, unknown>) => {
      const partitions = structuredClone(manifest.partitions) as Array<Record<string, unknown>>
      partitions[0].expectedCount = Number(partitions[0].expectedCount) + 1
      manifest.partitions = partitions
    }],
    ['missing partition', (manifest: Record<string, unknown>) => {
      manifest.partitions = (structuredClone(manifest.partitions) as Array<Record<string, unknown>>).slice(1)
    }],
  ])('rejects %s instead of silently changing release coverage', (_label, mutate) => {
    const candidate = structuredClone(epic172S6SuiteManifest) as unknown as Record<string, unknown>
    mutate(candidate)
    expect(() => parseEpic172S6SuiteManifest(candidate)).toThrow()
  })
})
