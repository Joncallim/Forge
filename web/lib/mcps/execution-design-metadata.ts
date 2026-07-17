export type McpExecutionDesignMetadata = {
  proposed: {
    requirements: Array<{
      requirementKey?: string
      sourceRequirementIndex?: number
      mcpId: string
      requirement: 'required' | 'optional'
      reason: string
      confidence: 'low' | 'medium' | 'high'
      scope: { kind: 'project' }
      accessMode: 'planning_instruction'
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
    requirementContexts: Array<{
      requirementKey: string
      sourceRequirementIndex: number
      agent: string
      mcpId: string
      promptOverlay: string
    }>
    mcpAwareSubtasks: Array<{
      id: string
      agent: string
      scope: { kind: 'project' }
      accessMode: 'planning_instruction'
      dependsOn: string[]
      mcpCapabilities: string[]
      capabilityBindings: Array<{ capability: string; requirementKey: string }>
      inputs: string[]
      outputs: string[]
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
    retryable: boolean
    primaryDecision?: { decisionId?: string }
    decisions: Array<{
      requirementKey?: string
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
        schemaVersion?: number
        observed?: boolean
        mcpId?: string
        installState: string
        status: string
        enabled: boolean
        error: string | null
        checkedAt?: string | null
      }
      promptOverlayPresent: boolean
      admissionStatus?: 'allowed' | 'warning' | 'blocked'
      mode: 'planning_only' | 'bounded_context_required' | 'bounded_context_approved' | 'blocked' | 'deferred_live_mcp' | 'unknown_legacy'
      recoveryAction?: string
      grantState?: Record<string, unknown>
      normalizedCapabilities: string[]
      capabilityClasses: Array<{ capability: string; class: string; deliveryKind: string | null }>
      evidenceRefs: string[]
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

function normalizeGrantPresentationState(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined
  if (value.kind === 'not_applicable' && Object.keys(value).length === 1) {
    return { kind: 'not_applicable' }
  }

  const revision = value.grantDecisionRevision
  const validRevision = revision === null || (typeof revision === 'string' && /^[1-9][0-9]*$/u.test(revision))
  const validReason = value.revocationReason === null || [
    'project_grant_removed',
    'project_grant_narrowed',
    'project_root_repoint',
  ].includes(String(value.revocationReason))
  if (
    (value.kind === 'effective_approved' || value.kind === 'operator_hold') &&
    typeof value.grantPhase === 'string' &&
    typeof value.grantConsumed === 'boolean' &&
    validRevision &&
    validReason
  ) {
    return {
      kind: value.kind,
      ...(typeof value.holdKind === 'string' ? { holdKind: value.holdKind } : {}),
      grantPhase: value.grantPhase,
      grantConsumed: value.grantConsumed,
      grantDecisionRevision: revision,
      revocationReason: value.revocationReason,
    }
  }

  // Version-1 decisions remain readable as history but cannot become a current
  // positive or actionable grant presentation without S3 lifecycle identity.
  if (typeof value.phase === 'string') {
    return {
      phase: value.phase.slice(0, 32),
      ...(typeof value.consumed === 'boolean' ? { consumed: value.consumed } : {}),
      ...(validReason && value.revocationReason !== null
        ? { revocationReason: value.revocationReason }
        : {}),
    }
  }
  return undefined
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
    retryable: raw.retryable === true,
    ...(isRecord(raw.primaryDecision) && typeof raw.primaryDecision.decisionId === 'string'
      ? { primaryDecision: { decisionId: raw.primaryDecision.decisionId.slice(0, 80) } }
      : {}),
    decisions: Array.isArray(raw.decisions)
      ? raw.decisions.filter(isRecord).map((item) => {
          const assignment = isRecord(item.assignment) ? item.assignment : {}
          const fallback = isRecord(item.fallback) ? item.fallback : {}
          const health = isRecord(item.health) ? item.health : {}
          const grantState = normalizeGrantPresentationState(item.grantState)
          const validModes = new Set(['planning_only', 'bounded_context_required', 'bounded_context_approved', 'blocked', 'deferred_live_mcp'])
          return {
            ...(typeof item.requirementKey === 'string' ? { requirementKey: item.requirementKey } : {}),
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
              ...(health.schemaVersion === 1 ? { schemaVersion: 1 } : {}),
              ...(typeof health.observed === 'boolean' ? { observed: health.observed } : {}),
              ...(typeof health.mcpId === 'string' ? { mcpId: health.mcpId } : {}),
              installState: typeof health.installState === 'string' ? health.installState : 'unknown',
              status: typeof health.status === 'string' ? health.status : 'unknown',
              enabled: health.enabled === true,
              error: typeof health.error === 'string' ? health.error : null,
              ...(typeof health.checkedAt === 'string' || health.checkedAt === null ? { checkedAt: health.checkedAt } : {}),
            },
            promptOverlayPresent: item.promptOverlayPresent === true,
            ...(item.admissionStatus === 'allowed' || item.admissionStatus === 'warning' || item.admissionStatus === 'blocked'
              ? { admissionStatus: item.admissionStatus }
              : {}),
            mode: validModes.has(item.mode as string) ? item.mode as 'planning_only' | 'bounded_context_required' | 'bounded_context_approved' | 'blocked' | 'deferred_live_mcp' : 'unknown_legacy',
            ...(typeof item.recoveryAction === 'string' ? { recoveryAction: item.recoveryAction } : {}),
            ...(grantState ? { grantState } : {}),
            normalizedCapabilities: normalizeStringArray(item.normalizedCapabilities),
            capabilityClasses: Array.isArray(item.capabilityClasses)
              ? item.capabilityClasses.filter(isRecord).map((classification) => ({
                  capability: typeof classification.capability === 'string' ? classification.capability : '',
                  class: typeof classification.class === 'string' ? classification.class : 'unknown',
                  deliveryKind: typeof classification.deliveryKind === 'string' ? classification.deliveryKind : null,
                }))
              : [],
            evidenceRefs: normalizeStringArray(item.evidenceRefs),
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
                ...(typeof item.requirementKey === 'string' ? { requirementKey: item.requirementKey } : {}),
                ...(typeof item.sourceRequirementIndex === 'number' ? { sourceRequirementIndex: item.sourceRequirementIndex } : {}),
                mcpId: typeof item.mcpId === 'string' ? item.mcpId : '',
                requirement: item.requirement === 'optional' ? 'optional' as const : 'required' as const,
                reason: typeof item.reason === 'string' ? item.reason : '',
                confidence: item.confidence === 'low' || item.confidence === 'high' ? item.confidence as 'low' | 'high' : 'medium' as const,
                scope: { kind: 'project' as const },
                accessMode: 'planning_instruction' as const,
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
          requirementContexts: Array.isArray(rawProposed.requirementContexts)
            ? rawProposed.requirementContexts.filter(isRecord).map((context) => ({
                requirementKey: typeof context.requirementKey === 'string' ? context.requirementKey : '',
                sourceRequirementIndex: typeof context.sourceRequirementIndex === 'number' ? context.sourceRequirementIndex : 0,
                agent: typeof context.agent === 'string' ? context.agent : '',
                mcpId: typeof context.mcpId === 'string' ? context.mcpId : '',
                promptOverlay: typeof context.promptOverlay === 'string' ? context.promptOverlay : '',
              }))
            : [],
          mcpAwareSubtasks: Array.isArray(rawProposed.mcpAwareSubtasks)
            ? rawProposed.mcpAwareSubtasks.filter(isRecord).map((item) => ({
                id: typeof item.id === 'string' ? item.id : '',
                agent: typeof item.agent === 'string' ? item.agent : '',
                scope: { kind: 'project' as const },
                accessMode: 'planning_instruction' as const,
                dependsOn: normalizeStringArray(item.dependsOn),
                mcpCapabilities: normalizeStringArray(item.mcpCapabilities),
                capabilityBindings: Array.isArray(item.capabilityBindings)
                  ? item.capabilityBindings.filter(isRecord).map((binding) => ({
                      capability: typeof binding.capability === 'string' ? binding.capability : '',
                      requirementKey: typeof binding.requirementKey === 'string' ? binding.requirementKey : '',
                    }))
                  : [],
                inputs: normalizeStringArray(item.inputs),
                outputs: normalizeStringArray(item.outputs),
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
