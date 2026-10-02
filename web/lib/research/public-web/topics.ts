export const PUBLIC_RESEARCH_TOPICS = {
  software_engineering_basics: 'software engineering reliability accessibility testing best practices',
  agent_role_evaluation: 'software engineering agent code review security practices',
} as const

export type PublicResearchTopicId = keyof typeof PUBLIC_RESEARCH_TOPICS

export type PublicResearchPurpose = 'architect_planning' | 'agent_role_evaluation'

const TOPICS_BY_PURPOSE: Record<PublicResearchPurpose, readonly PublicResearchTopicId[]> = {
  architect_planning: ['software_engineering_basics'],
  agent_role_evaluation: ['agent_role_evaluation'],
}

export function topicsForPublicResearchPurpose(purpose: PublicResearchPurpose): readonly PublicResearchTopicId[] {
  return TOPICS_BY_PURPOSE[purpose]
}
