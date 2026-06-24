export type McpExecutionDesignMetadata = {
  proposed: {
    requirements: Array<{
      mcpId: string
      requirement: 'required' | 'optional'
      reason: string
      assignment: {
        type: string
        targetAgents: string[]
        targetId: string | null
      }
      agentPermissions: Record<string, string[]>
      prohibitedCapabilities: string[]
      fallback: {
        action: string
        message: string
      }
    }>
    promptOverlays: Record<string, string>
    mcpAwareSubtasks: Array<{
      id: string
      agent: string
      mcpCapabilities: string[]
      verification: string[]
      stoppingCondition: string
      fallback: string
    }>
  } | null
  validation: {
    status: 'valid' | 'blocked' | 'warnings'
    runtimeEnforcement: 'not_implemented'
    blocked: string[]
    warnings: string[]
    health: Array<{
      mcpId: string
      installState: string
      status: string
      enabled: boolean
      error: string | null
    }>
  }
  grantDecisions: {
    schemaVersion: 1
    runtimeEnforcement: 'not_implemented'
    summary: {
      proposed: number
      warning: number
      blocked: number
    }
    decisions: Array<{
      decisionId: string
      sourceRequirementIndex: number
      agent: string
      mcpId: string
      capabilities: string[]
      requirement: 'required' | 'optional'
      status: 'proposed' | 'warning' | 'blocked'
      reason: string
      assignment: {
        type: string
        targetId: string | null
      }
      fallback: {
        action: string
        message: string
      }
      health: {
        installState: string
        status: string
        enabled: boolean
        error: string | null
      }
      promptOverlayPresent: boolean
    }>
  } | null
}

export type McpExecutionDesignArtifact = {
  artifactType: string
  metadata: unknown
  createdAt?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}

function artifactTime(artifact: McpExecutionDesignArtifact): number {
  if (!artifact.createdAt) return 0
  const timestamp = new Date(artifact.createdAt).getTime()
  return Number.isFinite(timestamp) ? timestamp : 0
}

function normalizeGrantDecisions(raw: unknown): McpExecutionDesignMetadata['grantDecisions'] {
  if (!isRecord(raw) || raw.schemaVersion !== 1) return null
  const summary = isRecord(raw.summary) ? raw.summary : {}
  return {
    schemaVersion: 1,
    runtimeEnforcement: 'not_implemented',
    summary: {
      proposed: typeof summary.proposed === 'number' ? summary.proposed : 0,
      warning: typeof summary.warning === 'number' ? summary.warning : 0,
      blocked: typeof summary.blocked === 'number' ? summary.blocked : 0,
    },
    decisions: Array.isArray(raw.decisions)
      ? raw.decisions.filter(isRecord).map((item) => {
          const assignment = isRecord(item.assignment) ? item.assignment : {}
          const fallback = isRecord(item.fallback) ? item.fallback : {}
          const health = isRecord(item.health) ? item.health : {}
          return {
            decisionId: typeof item.decisionId === 'string' ? item.decisionId : '',
            sourceRequirementIndex: typeof item.sourceRequirementIndex === 'number' ? item.sourceRequirementIndex : 0,
            agent: typeof item.agent === 'string' ? item.agent : '',
            mcpId: typeof item.mcpId === 'string' ? item.mcpId : '',
            capabilities: normalizeStringArray(item.capabilities),
            requirement: item.requirement === 'optional' ? 'optional' as const : 'required' as const,
            status: item.status === 'blocked' ? 'blocked' as const : item.status === 'warning' ? 'warning' as const : 'proposed' as const,
            reason: typeof item.reason === 'string' ? item.reason : '',
            assignment: {
              type: typeof assignment.type === 'string' ? assignment.type : 'agent',
              targetId: typeof assignment.targetId === 'string' ? assignment.targetId : null,
            },
            fallback: {
              action: typeof fallback.action === 'string' ? fallback.action : 'ask_user',
              message: typeof fallback.message === 'string' ? fallback.message : '',
            },
            health: {
              installState: typeof health.installState === 'string' ? health.installState : 'unknown',
              status: typeof health.status === 'string' ? health.status : 'unknown',
              enabled: health.enabled === true,
              error: typeof health.error === 'string' ? health.error : null,
            },
            promptOverlayPresent: item.promptOverlayPresent === true,
          }
        })
      : [],
  }
}

export function latestMcpExecutionDesignFromArtifacts(
  artifacts: McpExecutionDesignArtifact[],
): McpExecutionDesignMetadata | null {
  const plans = artifacts
    .filter((artifact) => artifact.artifactType === 'adr_text')
    .sort((a, b) => artifactTime(a) - artifactTime(b))

  for (const artifact of [...plans].reverse()) {
    if (!isRecord(artifact.metadata) || !isRecord(artifact.metadata.mcpExecutionDesign)) continue
    const design = artifact.metadata.mcpExecutionDesign
    if (!isRecord(design.validation)) continue
    const validation = design.validation
    const rawProposed = isRecord(design.proposed) ? design.proposed : null
    const proposed = rawProposed
      ? {
          requirements: Array.isArray(rawProposed.requirements)
            ? rawProposed.requirements
              .filter(isRecord)
              .map((item) => ({
                mcpId: typeof item.mcpId === 'string' ? item.mcpId : '',
                requirement: item.requirement === 'optional' ? 'optional' as const : 'required' as const,
                reason: typeof item.reason === 'string' ? item.reason : '',
                assignment: isRecord(item.assignment)
                  ? {
                      type: typeof item.assignment.type === 'string' ? item.assignment.type : 'agent',
                      targetAgents: normalizeStringArray(item.assignment.targetAgents),
                      targetId: typeof item.assignment.targetId === 'string' ? item.assignment.targetId : null,
                    }
                  : { type: 'agent', targetAgents: [], targetId: null },
                agentPermissions: isRecord(item.agentPermissions)
                  ? Object.fromEntries(
                    Object.entries(item.agentPermissions)
                      .filter(([, value]) => Array.isArray(value))
                      .map(([agent, value]) => [agent, normalizeStringArray(value)]),
                  )
                  : {},
                prohibitedCapabilities: normalizeStringArray(item.prohibitedCapabilities),
                fallback: isRecord(item.fallback)
                  ? {
                      action: typeof item.fallback.action === 'string' ? item.fallback.action : 'ask_user',
                      message: typeof item.fallback.message === 'string' ? item.fallback.message : '',
                    }
                  : { action: 'ask_user', message: '' },
              }))
            : [],
          promptOverlays: isRecord(rawProposed.promptOverlays)
            ? Object.fromEntries(
              Object.entries(rawProposed.promptOverlays)
                .filter(([, value]) => typeof value === 'string')
                .map(([agent, value]) => [agent, value as string]),
            )
            : {},
          mcpAwareSubtasks: Array.isArray(rawProposed.mcpAwareSubtasks)
            ? rawProposed.mcpAwareSubtasks.filter(isRecord).map((item) => ({
                id: typeof item.id === 'string' ? item.id : '',
                agent: typeof item.agent === 'string' ? item.agent : '',
                mcpCapabilities: normalizeStringArray(item.mcpCapabilities),
                verification: normalizeStringArray(item.verification),
                stoppingCondition: typeof item.stoppingCondition === 'string' ? item.stoppingCondition : '',
                fallback: typeof item.fallback === 'string' ? item.fallback : '',
              }))
            : [],
        }
      : null

    return {
      proposed,
      validation: {
        status: validation.status === 'blocked' ? 'blocked' : validation.status === 'warnings' ? 'warnings' : 'valid',
        runtimeEnforcement: 'not_implemented',
        blocked: normalizeStringArray(validation.blocked),
        warnings: normalizeStringArray(validation.warnings),
        health: Array.isArray(validation.health)
          ? validation.health.filter(isRecord).map((item) => ({
              mcpId: typeof item.mcpId === 'string' ? item.mcpId : '',
              installState: typeof item.installState === 'string' ? item.installState : 'unknown',
              status: typeof item.status === 'string' ? item.status : 'unknown',
              enabled: item.enabled === true,
              error: typeof item.error === 'string' ? item.error : null,
            }))
          : [],
      },
      grantDecisions: normalizeGrantDecisions(design.grantDecisions),
    }
  }

  return null
}
