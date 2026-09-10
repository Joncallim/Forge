import { afterEach, describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/providers/registry', () => ({
  getProvider: vi.fn(),
  getModel: vi.fn(),
  listActiveProviders: vi.fn(),
}))
vi.mock('ai', () => ({ generateText: vi.fn() }))

import { evaluateAgentRoles, parseEvaluationResponse } from '@/lib/agent-evaluation'
import { getModel, getProvider } from '@/lib/providers/registry'
import { generateText } from 'ai'

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

const SENTINEL = 'PRIVATE_EVALUATION_PROVIDER_AGENT_PROMPT_SENTINEL'
const PROVIDER_ID = '11111111-1111-1111-1111-111111111111'
const originalFetch = globalThis.fetch

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  globalThis.fetch = originalFetch
  vi.clearAllMocks()
})

function evaluationOptions() {
  return {
    agentConfigs: [{
      agentType: 'architect',
      providerConfigId: PROVIDER_ID,
      systemPrompt: `system ${SENTINEL}`,
    }],
    activeProviders: [{
      id: PROVIDER_ID,
      displayName: SENTINEL,
      providerType: 'openai',
      modelId: 'test-model',
    }],
  } as never
}

function mockEvaluationDependencies() {
  vi.mocked(getProvider).mockResolvedValue({ config: { id: PROVIDER_ID } } as never)
  vi.mocked(getModel).mockResolvedValue({} as never)
  vi.mocked(generateText).mockResolvedValue({
    text: JSON.stringify(VALID),
    usage: { inputTokens: 1, outputTokens: 1 },
  } as never)
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

describe('evaluateAgentRoles public-web boundary', () => {
  it('does not make an outbound public-search request while disabled', async () => {
    vi.stubEnv('FORGE_AGENT_WEB_SEARCH', '0')
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    mockEvaluationDependencies()

    await evaluateAgentRoles(evaluationOptions())

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(vi.mocked(generateText).mock.calls[0]?.[0]?.prompt).toContain('disabled')
  })

  it('uses only the closed evaluation topic when public research is explicitly enabled', async () => {
    vi.stubEnv('FORGE_AGENT_WEB_SEARCH', '1')
    const fetchSpy = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      AbstractText: 'public evidence',
      AbstractURL: 'https://example.test/reference',
    }), { headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchSpy)
    mockEvaluationDependencies()

    await evaluateAgentRoles(evaluationOptions())

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url] = fetchSpy.mock.calls[0] as [URL]
    expect(url.searchParams.get('q')).toBe('software engineering agent code review security practices')
    expect(url.toString()).not.toContain(SENTINEL)
    expect(vi.mocked(generateText).mock.calls[0]?.[0]?.prompt).toContain('UNTRUSTED DATA')
  })
})
