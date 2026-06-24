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
  })

  it('returns null for missing or malformed MCP design metadata', () => {
    expect(latestMcpExecutionDesignFromArtifacts([])).toBeNull()
    expect(latestMcpExecutionDesignFromArtifacts([
      { artifactType: 'adr_text', createdAt: '2026-06-24T10:00:00.000Z', metadata: { mcpExecutionDesign: { proposed: {} } } },
    ])).toBeNull()
  })
})
