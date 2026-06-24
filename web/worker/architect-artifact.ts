import type { ProjectMcpOverview } from '@/lib/mcps/types'
import { parseAgentBreakdown, type PlannedAgent } from './agent-breakdown'
import { parseCapabilityClassification, type CapabilityClassificationMetadata } from './capability-classification'
import {
  deriveMcpGrantDecisions,
  parseMcpExecutionDesign,
  type McpExecutionDesign,
  type McpExecutionValidation,
  type McpGrantDecisions,
  validateMcpExecutionDesign,
} from './mcp-execution-design'
import { parseOpenQuestions, type OpenQuestion } from './open-questions'

export type PreparedArchitectArtifact = {
  planText: string
  questions: OpenQuestion[]
  agents: PlannedAgent[]
  capabilityClassification: CapabilityClassificationMetadata
  mcpExecutionDesign: {
    proposed: McpExecutionDesign | null
    validation: McpExecutionValidation
    grantDecisions: McpGrantDecisions
  }
}

export function prepareArchitectArtifact(
  rawText: string,
  mcpOverview: ProjectMcpOverview,
): PreparedArchitectArtifact {
  const { planText: planWithoutQuestions, questions } = parseOpenQuestions(rawText)
  const { planText: planWithoutMcpDesign, design } = parseMcpExecutionDesign(planWithoutQuestions)
  const { planText: planWithoutCapabilities, capabilityClassification } = parseCapabilityClassification(planWithoutMcpDesign)
  const { planText, agents } = parseAgentBreakdown(planWithoutCapabilities)

  return {
    planText,
    questions,
    agents,
    capabilityClassification,
    mcpExecutionDesign: {
      proposed: design,
      validation: validateMcpExecutionDesign(design, mcpOverview),
      grantDecisions: deriveMcpGrantDecisions(design, mcpOverview),
    },
  }
}
