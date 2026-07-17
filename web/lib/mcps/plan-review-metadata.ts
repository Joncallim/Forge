import type { McpExecutionDesignMetadata } from './execution-design-metadata'

export type McpPlanReviewDisplayItem = {
  requirementKey: string
  decision: 'approved' | 'denied'
  assignment: { type: string; targetAgents: string[]; targetId: string | null }
  agentPermissions: Record<string, string[]>
  promptOverlays: Record<string, string>
}

export type McpPlanReviewDisplayRecord = {
  sourceArtifactId: string
  revision: number
  digest: string
  blockers: string[]
  items: McpPlanReviewDisplayItem[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

export function mcpRequirementDisplayKey(
  requirement: NonNullable<McpExecutionDesignMetadata['proposed']>['requirements'][number],
  index: number,
): string {
  return requirement.requirementKey ?? `legacy-source-${requirement.sourceRequirementIndex ?? index}-${requirement.mcpId}`
}

export function mcpPlanOverlayCount(design: McpExecutionDesignMetadata | null): number {
  return design?.proposed?.requirementContexts.filter((context) => context.promptOverlay.trim() !== '').length ?? 0
}

export function latestMcpPlanReviewForDisplay(gate: unknown): McpPlanReviewDisplayRecord | null {
  if (!isRecord(gate) || !isRecord(gate.metadata) || !Array.isArray(gate.metadata.mcpOperatorReviews)) return null
  const raw = [...gate.metadata.mcpOperatorReviews].reverse().find(isRecord)
  if (!raw || typeof raw.sourceArtifactId !== 'string' || typeof raw.revision !== 'number' || typeof raw.digest !== 'string') return null
  const items = Array.isArray(raw.items) ? raw.items.flatMap((item) => {
    if (!isRecord(item) || typeof item.requirementKey !== 'string' || !isRecord(item.assignment)) return []
    const permissions = isRecord(item.agentPermissions)
      ? Object.fromEntries(Object.entries(item.agentPermissions).map(([agent, values]) => [agent, stringArray(values)]))
      : {}
    const overlays = isRecord(item.promptOverlays)
      ? Object.fromEntries(Object.entries(item.promptOverlays).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
      : {}
    return [{
      requirementKey: item.requirementKey,
      decision: item.decision === 'denied' ? 'denied' as const : 'approved' as const,
      assignment: {
        type: typeof item.assignment.type === 'string' ? item.assignment.type : 'agent',
        targetAgents: stringArray(item.assignment.targetAgents),
        targetId: typeof item.assignment.targetId === 'string' ? item.assignment.targetId : null,
      },
      agentPermissions: permissions,
      promptOverlays: overlays,
    }]
  }) : []
  return {
    sourceArtifactId: raw.sourceArtifactId,
    revision: raw.revision,
    digest: raw.digest,
    blockers: stringArray(raw.blockers),
    items,
  }
}

export function approvedGrantsForDisplay(pkg: unknown): Record<string, unknown>[] {
  if (!isRecord(pkg) || !Array.isArray(pkg.approvedGrants)) return []
  return pkg.approvedGrants.filter(isRecord)
}
