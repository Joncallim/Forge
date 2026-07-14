import { describe, expect, it } from 'vitest'
import { latestMcpExecutionDesignFromArtifacts } from '@/lib/mcps/execution-design-metadata'

function artifact(createdAt: string, mcpId: string, status: 'valid' | 'blocked' | 'warnings' = 'valid') {
  return {
    artifactType: 'adr_text',
    createdAt,
    metadata: {
      mcpExecutionDesign: {
        proposed: {
          requirements: [{
            mcpId,
            requirement: 'required',
            reason: 'Need MCP context.',
            assignment: { type: 'agent', targetAgents: ['backend'], targetId: null },
            agentPermissions: { backend: [`${mcpId}.read`] },
            prohibitedCapabilities: [],
            fallback: { action: 'ask_user', message: 'Configure MCP.' },
          }],
          promptOverlays: { backend: 'Use scoped MCP access only.' },
          mcpAwareSubtasks: [],
        },
        validation: {
          status,
          runtimeEnforcement: 'not_implemented',
          blocked: status === 'blocked' ? ['Blocked'] : [],
          warnings: status === 'warnings' ? ['Warning'] : [],
          health: [],
        },
        grantDecisions: {
          schemaVersion: 1,
          runtimeEnforcement: 'not_implemented',
          summary: { proposed: status === 'valid' ? 1 : 0, warning: status === 'warnings' ? 1 : 0, blocked: status === 'blocked' ? 1 : 0 },
          decisions: [{
            decisionId: `req-0:backend:${mcpId}`,
            sourceRequirementIndex: 0,
            agent: 'backend',
            mcpId,
            capabilities: [`${mcpId}.read`],
            requirement: 'required',
            status: status === 'blocked' ? 'blocked' : status === 'warnings' ? 'warning' : 'proposed',
            reason: 'Need MCP context.',
            assignment: { type: 'agent', targetId: null },
            fallback: { action: 'ask_user', message: 'Configure MCP.' },
            health: { installState: 'installed', status: 'healthy', enabled: true, error: null },
            promptOverlayPresent: true,
          }],
        },
      },
    },
  }
}

describe('latestMcpExecutionDesignFromArtifacts', () => {
  it('selects the newest architect artifact by createdAt regardless of array order', () => {
    const newer = artifact('2026-06-24T10:00:00.000Z', 'github', 'warnings')
    const older = artifact('2026-06-24T09:00:00.000Z', 'filesystem', 'valid')

    const result = latestMcpExecutionDesignFromArtifacts([newer, older])

    expect(result?.validation.status).toBe('warnings')
    expect(result?.proposed?.requirements[0].mcpId).toBe('github')
    expect(result?.grantDecisions?.summary.warning).toBe(1)
    expect(result?.grantDecisions?.decisions[0]).toMatchObject({
      decisionId: 'req-0:backend:github',
      mode: 'unknown_legacy',
      status: 'warning',
      promptOverlayPresent: true,
    })
  })

  it('returns null for missing or malformed MCP design metadata', () => {
    expect(latestMcpExecutionDesignFromArtifacts([])).toBeNull()
    expect(latestMcpExecutionDesignFromArtifacts([
      { artifactType: 'adr_text', createdAt: '2026-06-24T10:00:00.000Z', metadata: { mcpExecutionDesign: { proposed: {} } } },
    ])).toBeNull()
  })

  it('keeps older MCP design artifacts readable when grant decisions are absent', () => {
    const older = artifact('2026-06-24T10:00:00.000Z', 'github', 'valid')
    delete (older.metadata.mcpExecutionDesign as { grantDecisions?: unknown }).grantDecisions

    const result = latestMcpExecutionDesignFromArtifacts([older])

    expect(result?.validation.status).toBe('valid')
    expect(result?.proposed?.requirements[0].mcpId).toBe('github')
    expect(result?.grantDecisions).toBeNull()
  })

  it('preserves canonical identity, observation, and scoped context metadata', () => {
    const current = artifact('2026-07-14T00:00:00.000Z', 'github', 'valid')
    const mcp = current.metadata.mcpExecutionDesign
    const proposed = mcp.proposed as Record<string, unknown>
    ;(proposed.requirements as Array<Record<string, unknown>>)[0].requirementKey = 'mcp-requirement-v1-test-1'
    ;(proposed.requirements as Array<Record<string, unknown>>)[0].sourceRequirementIndex = 0
    proposed.requirementContexts = [{ requirementKey: 'mcp-requirement-v1-test-1', sourceRequirementIndex: 0, agent: 'backend', mcpId: 'github', promptOverlay: 'Scoped.' }]
    const decision = (mcp.grantDecisions.decisions as Array<Record<string, unknown>>)[0]
    decision.requirementKey = 'mcp-requirement-v1-test-1'
    decision.mode = 'planning_only'
    decision.admissionStatus = 'allowed'
    decision.grantState = { phase: 'not_issued' }
    decision.health = { schemaVersion: 1, observed: false, mcpId: 'github', installState: 'unknown', status: 'unknown', enabled: false, error: null, checkedAt: null }

    const result = latestMcpExecutionDesignFromArtifacts([current])
    expect(result?.proposed?.requirementContexts[0]).toMatchObject({ requirementKey: 'mcp-requirement-v1-test-1', agent: 'backend' })
    expect(result?.grantDecisions?.decisions[0]).toMatchObject({
      requirementKey: 'mcp-requirement-v1-test-1',
      mode: 'planning_only',
      grantState: { phase: 'not_issued' },
      health: { observed: false, checkedAt: null },
    })
  })
})
