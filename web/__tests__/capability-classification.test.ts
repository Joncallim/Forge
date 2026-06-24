import { describe, expect, it } from 'vitest'
import {
  CAPABILITY_TAXONOMY,
  parseCapabilityClassification,
} from '@/worker/capability-classification'

describe('parseCapabilityClassification', () => {
  it('parses and removes a tagged capability classification fence', () => {
    const parsed = parseCapabilityClassification([
      '# Plan',
      'Implement the API.',
      '',
      '```capability_classification_json',
      '{"schemaVersion":1,"required":["api-implementation"],"optional":["integration-testing"],"excluded":[{"capability":"deployment","reason":"No infrastructure changes."}]}',
      '```',
    ].join('\n'))

    expect(parsed.planText).toBe('# Plan\nImplement the API.')
    expect(parsed.capabilityClassification).toMatchObject({
      proposed: {
        schemaVersion: 1,
        required: ['api-implementation'],
        optional: ['integration-testing'],
        excluded: [{ capability: 'deployment', reason: 'No infrastructure changes.' }],
      },
      validation: { status: 'valid', warnings: [] },
    })
  })

  it('falls back to a generic json fence with the expected shape', () => {
    const parsed = parseCapabilityClassification([
      '# Plan',
      '```json',
      '{"schemaVersion":1,"required":["unit-testing"],"optional":[],"excluded":[]}',
      '```',
    ].join('\n'))

    expect(parsed.planText).toBe('# Plan')
    expect(parsed.capabilityClassification.proposed.required).toEqual(['unit-testing'])
  })

  it('warns and uses an empty classification for missing or malformed fences', () => {
    expect(parseCapabilityClassification('# Plan only').capabilityClassification).toMatchObject({
      proposed: { required: [], optional: [], excluded: [] },
      validation: { status: 'warnings' },
    })

    expect(parseCapabilityClassification('```capability_classification_json\nnot-json\n```').capabilityClassification).toMatchObject({
      proposed: { required: [], optional: [], excluded: [] },
      validation: { status: 'warnings' },
    })
  })

  it('drops unknown capabilities and excluded entries without reasons', () => {
    const parsed = parseCapabilityClassification([
      '```capability_classification_json',
      '{"schemaVersion":1,"required":["api-implementation","unknown"],"optional":["made-up"],"excluded":[{"capability":"deployment","reason":""},{"capability":"security-review","reason":"Handled later."}]}',
      '```',
    ].join('\n'))

    expect(parsed.capabilityClassification.proposed.required).toEqual(['api-implementation'])
    expect(parsed.capabilityClassification.proposed.optional).toEqual([])
    expect(parsed.capabilityClassification.proposed.excluded).toEqual([
      { capability: 'security-review', reason: 'Handled later.' },
    ])
    expect(parsed.capabilityClassification.validation.status).toBe('warnings')
    expect(parsed.capabilityClassification.validation.warnings.join('\n')).toMatch(/Unknown required capability/)
    expect(parsed.capabilityClassification.validation.warnings.join('\n')).toMatch(/did not include a reason/)
  })

  it('deduplicates with required before optional before excluded precedence', () => {
    const parsed = parseCapabilityClassification([
      '```capability_classification_json',
      '{"schemaVersion":1,"required":["api-implementation","api-implementation"],"optional":["api-implementation","unit-testing"],"excluded":[{"capability":"unit-testing","reason":"Duplicate lower precedence."},{"capability":"deployment","reason":"No deploy."}]}',
      '```',
    ].join('\n'))

    expect(parsed.capabilityClassification.proposed).toMatchObject({
      required: ['api-implementation'],
      optional: ['unit-testing'],
      excluded: [{ capability: 'deployment', reason: 'No deploy.' }],
    })
  })

  it('documents the fixed taxonomy size used by the prompt and parser', () => {
    expect(CAPABILITY_TAXONOMY).toHaveLength(22)
    expect(CAPABILITY_TAXONOMY).toContain('system-design')
    expect(CAPABILITY_TAXONOMY).toContain('deployment')
  })
})
