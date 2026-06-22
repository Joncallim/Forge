import { generateText } from 'ai'
import type { LanguageModel } from 'ai'
import { z } from 'zod'
import type { AgentConfig, ProviderConfig, tasks } from '@/db/schema'
import { getProvider } from '@/lib/providers/registry'
import { buildWebResearchContext } from '@/worker/architect-context'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AgentRoleRecommendation = {
  agentType: string
  recommendedProviderConfigId: string | null
  recommendedModelId: string
  rationale: string
  confidence: 'low' | 'medium' | 'high'
}

export type AgentEvaluationResult = {
  recommendations: AgentRoleRecommendation[]
  raw: string
  usage: { inputTokens: number; outputTokens: number }
}

export type EvaluateAgentRolesOptions = {
  agentConfigs: AgentConfig[]
  activeProviders: ProviderConfig[]
  enableWebResearch?: boolean
}

// ---------------------------------------------------------------------------
// Validation schema for the model's response
// ---------------------------------------------------------------------------

const recommendationSchema = z.object({
  agentType: z.string().min(1),
  recommendedProviderConfigId: z.string().uuid().nullable(),
  recommendedModelId: z.string().min(1),
  rationale: z.string().min(1).max(500),
  confidence: z.enum(['low', 'medium', 'high']),
})

const evaluationResponseSchema = z.object({
  recommendations: z.array(recommendationSchema).min(1),
})

const ARCHITECT_AGENT = 'architect'
const PROMPT_SYSTEM_PROMPT_CAP = 400

// ---------------------------------------------------------------------------
// parseEvaluationResponse
// ---------------------------------------------------------------------------

export function parseEvaluationResponse(raw: string): AgentRoleRecommendation[] {
  const stripped = raw
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim()

  let parsedJson: unknown
  try {
    parsedJson = JSON.parse(stripped)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(`Failed to parse evaluation response as JSON: ${message}`)
  }

  const result = evaluationResponseSchema.safeParse(parsedJson)
  if (!result.success) {
    throw new Error(
      `Evaluation response did not match expected schema: ${result.error.message}`,
    )
  }

  return result.data.recommendations
}

// ---------------------------------------------------------------------------
// buildEvaluationPrompt
// ---------------------------------------------------------------------------

function truncateSystemPrompt(systemPrompt: string): string {
  if (systemPrompt.length <= PROMPT_SYSTEM_PROMPT_CAP) return systemPrompt
  return `${systemPrompt.slice(0, PROMPT_SYSTEM_PROMPT_CAP)}…`
}

export function buildEvaluationPrompt(
  agentConfigs: AgentConfig[],
  activeProviders: ProviderConfig[],
  webResearchContext: string,
): string {
  const providerById = new Map(activeProviders.map((p) => [p.id, p]))

  const agentLines = agentConfigs.map((config) => {
    const assigned = config.providerConfigId ? providerById.get(config.providerConfigId) : undefined
    const assignedDescription = assigned
      ? `${assigned.displayName} (${assigned.providerType}, model: ${assigned.modelId}, id: ${assigned.id})`
      : config.providerConfigId
        ? `unknown/inactive provider (id: ${config.providerConfigId})`
        : 'none assigned'

    return [
      `- agentType: ${config.agentType}`,
      `  currently assigned provider: ${assignedDescription}`,
      `  system prompt (truncated): ${truncateSystemPrompt(config.systemPrompt)}`,
    ].join('\n')
  })

  const providerLines = activeProviders.map(
    (p) => `- displayName: ${p.displayName}, providerType: ${p.providerType}, modelId: ${p.modelId}, id: ${p.id}`,
  )

  return [
    'You are evaluating which AI provider/model is best suited for each Forge agent role.',
    '',
    'Forge agent roles to evaluate:',
    ...agentLines,
    '',
    'Active provider configs available to assign:',
    providerLines.length > 0 ? providerLines.join('\n') : '- (no active providers configured)',
    '',
    webResearchContext,
    '',
    'For each agent role listed above, recommend the best-fit provider config (by id) and model id from the',
    'active provider configs list. If no active provider is suitable, set recommendedProviderConfigId to null',
    'and still suggest a recommendedModelId that would be ideal in principle.',
    '',
    'Respond with ONLY a JSON object matching this shape, no markdown fences, no commentary:',
    '{',
    '  "recommendations": [',
    '    {',
    '      "agentType": "...",',
    '      "recommendedProviderConfigId": "<uuid or null>",',
    '      "recommendedModelId": "...",',
    '      "rationale": "...",',
    '      "confidence": "low|medium|high"',
    '    }',
    '  ]',
    '}',
  ].join('\n')
}

// ---------------------------------------------------------------------------
// evaluateAgentRoles
// ---------------------------------------------------------------------------

export async function evaluateAgentRoles(
  options: EvaluateAgentRolesOptions,
): Promise<AgentEvaluationResult> {
  const architectConfig = options.agentConfigs.find((c) => c.agentType === ARCHITECT_AGENT)
  if (!architectConfig || !architectConfig.providerConfigId) {
    throw new Error('No orchestrator provider configured. Assign a provider to the Architect agent first.')
  }

  const providerResult = await getProvider(architectConfig.providerConfigId)
  if (!providerResult) {
    throw new Error(`Provider config ${architectConfig.providerConfigId} is missing or inactive`)
  }

  const model = (providerResult.provider as (modelId: string) => LanguageModel)(
    providerResult.config.modelId,
  )

  let webResearchContext: string
  if (options.enableWebResearch !== false && process.env.FORGE_AGENT_WEB_SEARCH !== '0') {
    const researchProfile = {
      type: 'agent_role_evaluation',
      persona: 'Evaluating which AI models/providers best fit each Forge agent role.',
      specialists: [],
      searchQueries: ['best LLM for coding agents 2026', 'best LLM for code review and security audit'],
    }
    const syntheticTask = { title: 'Agent role self-evaluation', prompt: '' } as Pick<
      typeof tasks.$inferSelect,
      'title' | 'prompt'
    >
    webResearchContext = await buildWebResearchContext(
      researchProfile,
      syntheticTask as typeof tasks.$inferSelect,
    )
  } else {
    webResearchContext = 'Web research: disabled.'
  }

  const prompt = buildEvaluationPrompt(options.agentConfigs, options.activeProviders, webResearchContext)

  async function attempt(attemptPrompt: string): Promise<{ recommendations: AgentRoleRecommendation[]; raw: string; usage: { inputTokens: number; outputTokens: number } }> {
    const result = await generateText({
      model,
      system: architectConfig!.systemPrompt,
      prompt: attemptPrompt,
      temperature: 0.2,
    })

    const recommendations = parseEvaluationResponse(result.text)
    const usage = {
      inputTokens: result.usage?.inputTokens ?? 0,
      outputTokens: result.usage?.outputTokens ?? 0,
    }

    return { recommendations, raw: result.text, usage }
  }

  let outcome: { recommendations: AgentRoleRecommendation[]; raw: string; usage: { inputTokens: number; outputTokens: number } }
  try {
    outcome = await attempt(prompt)
  } catch {
    const retryPrompt = `${prompt}\n\nYour previous response could not be parsed as JSON matching the schema. Reply with raw JSON only.`
    outcome = await attempt(retryPrompt)
  }

  const activeProviderIds = new Set(options.activeProviders.map((p) => p.id))
  const recommendations = outcome.recommendations.map((rec) =>
    rec.recommendedProviderConfigId && !activeProviderIds.has(rec.recommendedProviderConfigId)
      ? { ...rec, recommendedProviderConfigId: null }
      : rec,
  )

  return { recommendations, raw: outcome.raw, usage: outcome.usage }
}
