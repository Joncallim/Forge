import { describe, expect, it } from 'vitest'
import { latestCapabilityClassificationFromArtifacts } from '@/lib/capabilities/classification-metadata'

function artifact(createdAt: string, capability: string, status: 'valid' | 'warnings' = 'valid') {
  return {
    artifactType: 'adr_text',
    createdAt,
    metadata: {
      capabilityClassification: {
        proposed: {
          schemaVersion: 1,
          required: [capability],
          optional: [],
          excluded: [{ capability: 'deployment', reason: 'No deployment change.' }],
        },
        validation: {
          status,
          warnings: status === 'warnings' ? ['Warning'] : [],
        },
      },
    },
  }
}

describe('latestCapabilityClassificationFromArtifacts', () => {
  it('selects the newest architect artifact by createdAt regardless of array order', () => {
    const newer = artifact('2026-06-24T10:00:00.000Z', 'api-implementation', 'warnings')
    const older = artifact('2026-06-24T09:00:00.000Z', 'ui-implementation')

    const result = latestCapabilityClassificationFromArtifacts([newer, older])

    expect(result?.validation.status).toBe('warnings')
    expect(result?.proposed.required).toEqual(['api-implementation'])
  })

  it('returns null for missing or malformed capability metadata', () => {
    expect(latestCapabilityClassificationFromArtifacts([])).toBeNull()
    expect(latestCapabilityClassificationFromArtifacts([
      { artifactType: 'adr_text', createdAt: '2026-06-24T10:00:00.000Z', metadata: { capabilityClassification: { proposed: {} } } },
    ])).toBeNull()
  })
})
