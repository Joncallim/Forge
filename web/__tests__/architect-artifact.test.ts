import { describe, expect, it } from 'vitest'
import { prepareArchitectArtifact } from '@/worker/architect-artifact'
import type { ProjectMcpOverview } from '@/lib/mcps/types'

const emptyOverview: ProjectMcpOverview = {
  projectId: 'project-1',
  config: { profile: 'default', requiredMcps: ['filesystem', 'github'], overrides: {} },
  mcpsRoot: '/tmp/forge/mcps',
  statuses: [],
  summary: {
    label: 'MCPs',
    status: 'missing',
    missing: 2,
    authRequired: 0,
    unhealthy: 0,
    disabled: 0,
  },
}

describe('prepareArchitectArtifact', () => {
  it('strips all machine-readable fences and persists MCP execution design metadata', () => {
    const raw = [
      '# Plan',
      'Use the repository context.',
      '',
      '```agent_breakdown_json',
      '{"agents":[{"role":"Backend","tasks":1,"summary":"Inspect repository","steps":["Inspect issue context"]}]}',
      '```',
      '',
      '```mcp_execution_design_json',
      '{"schemaVersion":1,"requirements":[{"mcpId":"github","requirement":"required","reason":"Need issue context","assignment":{"type":"agent","targetAgents":["backend"]},"agentPermissions":{"backend":["github.issues.read"]},"prohibitedCapabilities":["github.pull_requests.merge"],"fallback":{"action":"ask_user","message":"Connect GitHub."}}],"promptOverlays":{"backend":"Use GitHub read tools only."},"mcpAwareSubtasks":[]}',
      '```',
      '',
      '```open_questions_json',
      '{"questions":[]}',
      '```',
    ].join('\n')

    const prepared = prepareArchitectArtifact(raw, emptyOverview)

    expect(prepared.planText).toBe('# Plan\nUse the repository context.')
    expect(prepared.planText).not.toContain('agent_breakdown_json')
    expect(prepared.planText).not.toContain('mcp_execution_design_json')
    expect(prepared.mcpExecutionDesign.proposed?.requirements[0]).toMatchObject({
      mcpId: 'github',
      requirement: 'required',
    })
    expect(prepared.mcpExecutionDesign.validation.status).toBe('blocked')
    expect(prepared.agents[0]).toMatchObject({ role: 'Backend', tasks: 1 })
  })
})
