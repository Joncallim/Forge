import { describe, it, expect, vi } from 'vitest'

// agent-evaluation pulls in the provider registry (which imports the db) and the
// architect web-research helper. Mock both so we can unit-test the pure parser
// without a database or network.
vi.mock('@/lib/providers/registry', () => ({
  getProvider: vi.fn(),
  getModel: vi.fn(),
  listActiveProviders: vi.fn(),
}))
vi.mock('@/worker/architect-context', () => ({
  buildWebResearchContext: vi.fn(),
}))

import { parseEvaluationResponse } from '@/lib/agent-evaluation'

const VALID = {
  recommendations: [
    {
      agentType: 'backend',
      recommendedProviderConfigId: '11111111-1111-1111-1111-111111111111',
      recommendedModelId: 'claude-sonnet-4-6',
      rationale: 'Strong at multi-file edits and tool use.',
      confidence: 'high',
    },
  ],
}

describe('parseEvaluationResponse', () => {
  it('parses a plain JSON object', () => {
    const recs = parseEvaluationResponse(JSON.stringify(VALID))
    expect(recs).toHaveLength(1)
    expect(recs[0].agentType).toBe('backend')
    expect(recs[0].confidence).toBe('high')
  })

  it('strips a ```json fenced code block', () => {
    const recs = parseEvaluationResponse('```json\n' + JSON.stringify(VALID) + '\n```')
    expect(recs[0].recommendedModelId).toBe('claude-sonnet-4-6')
  })

  it('throws on non-JSON output', () => {
    expect(() => parseEvaluationResponse('not json at all')).toThrow(/parse/i)
  })

  it('throws when the shape does not match the schema', () => {
    expect(() =>
      parseEvaluationResponse(JSON.stringify({ recommendations: [{ agentType: 'backend' }] })),
    ).toThrow(/schema/i)
  })

  it('throws when a null/empty recommendations array is returned', () => {
    expect(() => parseEvaluationResponse(JSON.stringify({ recommendations: [] }))).toThrow(/schema/i)
  })
})
