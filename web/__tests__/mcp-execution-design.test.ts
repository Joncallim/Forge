import { describe, expect, it } from 'vitest'
import {
  deriveMcpGrantDecisions,
  evaluateWorkPackageMcpBroker,
  isRetryableMcpBrokerBlock,
  parseMcpExecutionDesign,
  validateMcpExecutionDesign,
} from '@/worker/mcp-execution-design'
import type { ProjectMcpOverview } from '@/lib/mcps/types'

function overview(statuses: ProjectMcpOverview['statuses']): ProjectMcpOverview {
  return {
    projectId: 'project-1',
    config: { profile: 'default', requiredMcps: ['filesystem', 'github'], overrides: {} },
    catalog: [
      {
        id: 'filesystem',
        displayName: 'Filesystem',
        description: 'Filesystem MCP',
        recommended: true,
        requiresAuth: false,
      },
      {
        id: 'github',
        displayName: 'GitHub',
        description: 'GitHub MCP',
        recommended: true,
        requiresAuth: true,
      },
    ],
    mcpsRoot: '/tmp/forge/mcps',
    statuses,
    summary: {
      label: 'MCPs',
      status: 'healthy',
      missing: 0,
      authRequired: 0,
      unhealthy: 0,
      disabled: 0,
    },
  }
}

const healthyGithub = {
  mcpId: 'github',
  displayName: 'GitHub',
  description: 'GitHub MCP',
  installPath: '/tmp/forge/mcps/github',
  installState: 'installed' as const,
  status: 'healthy' as const,
  enabled: true,
  error: null,
  checkedAt: new Date().toISOString(),
}

const unhealthyGithub = {
  ...healthyGithub,
  status: 'auth_required' as const,
  error: 'Connect GitHub in Settings before using this MCP.',
}

const healthyFilesystem = {
  mcpId: 'filesystem',
  displayName: 'Filesystem',
  description: 'Filesystem MCP',
  installPath: '/tmp/forge/mcps/filesystem',
  installState: 'installed' as const,
  status: 'healthy' as const,
  enabled: true,
  error: null,
  checkedAt: new Date().toISOString(),
}

describe('parseMcpExecutionDesign', () => {
  it('parses and removes a tagged MCP execution design fence', () => {
    const text = [
      '# Plan',
      'Use GitHub for repository context.',
      '',
      '```mcp_execution_design_json',
      JSON.stringify({
        schemaVersion: 1,
        requirements: [{
          mcpId: 'github',
          requirement: 'required',
          reason: 'Inspect issue context.',
          assignment: { type: 'agent', targetAgents: ['backend'], targetId: null },
          agentPermissions: { backend: ['github.issues.read'] },
          prohibitedCapabilities: ['github.pull_requests.merge'],
          fallback: { action: 'ask_user', message: 'Connect GitHub first.' },
        }],
        promptOverlays: { backend: 'Use GitHub read tools only.' },
        mcpAwareSubtasks: [{
          id: 'inspect-issue',
          agent: 'backend',
          dependsOn: [],
          mcpCapabilities: ['github.issues.read'],
          inputs: ['Task prompt'],
          outputs: ['Issue context'],
          verification: ['Issue context captured'],
          stoppingCondition: 'Context is available.',
          fallback: 'Ask the user for context.',
        }],
      }),
      '```',
    ].join('\n')

    const parsed = parseMcpExecutionDesign(text)
    expect(parsed.planText).toBe('# Plan\nUse GitHub for repository context.')
    expect(parsed.design?.requirements[0]).toMatchObject({
      mcpId: 'github',
      requirement: 'required',
      assignment: { type: 'agent', targetAgents: ['backend'] },
    })
    expect(parsed.design?.promptOverlays.backend).toBe('Use GitHub read tools only.')
    expect(parsed.design?.mcpAwareSubtasks[0].mcpCapabilities).toEqual(['github.issues.read'])
  })

  it('falls back to a generic json fence with the expected shape', () => {
    const parsed = parseMcpExecutionDesign([
      '# Plan',
      '```json',
      '{"schemaVersion":1,"requirements":[],"promptOverlays":{},"mcpAwareSubtasks":[]}',
      '```',
    ].join('\n'))

    expect(parsed.planText).toBe('# Plan')
    expect(parsed.design).toMatchObject({ schemaVersion: 1, requirements: [] })
  })

  it('returns null design for malformed or missing fences', () => {
    expect(parseMcpExecutionDesign('# Plan only').design).toBeNull()
    expect(parseMcpExecutionDesign('```mcp_execution_design_json\nnot-json\n```').design).toBeNull()
  })
})

describe('validateMcpExecutionDesign', () => {
  it('accepts a required healthy MCP assignment', () => {
    const { design } = parseMcpExecutionDesign([
      '```mcp_execution_design_json',
      '{"schemaVersion":1,"requirements":[{"mcpId":"github","requirement":"required","reason":"Need issue context","assignment":{"type":"workforce","targetAgents":["architect","backend"]},"agentPermissions":{"architect":["github.issues.read"],"backend":["github.contents.read"]},"prohibitedCapabilities":["github.pull_requests.merge"],"fallback":{"action":"ask_user","message":"Connect GitHub first."}}],"promptOverlays":{"backend":"Use scoped GitHub tools."},"mcpAwareSubtasks":[]}',
      '```',
    ].join('\n'))

    const result = validateMcpExecutionDesign(design, overview([healthyGithub]))
    expect(result.status).toBe('valid')
    expect(result.runtimeEnforcement).toBe('not_implemented')
    expect(result.blocked).toEqual([])
  })

  it('blocks capabilities outside the safe beta allowlist during validation', () => {
    const { design } = parseMcpExecutionDesign([
      '```mcp_execution_design_json',
      '{"schemaVersion":1,"requirements":[{"mcpId":"github","requirement":"required","reason":"Need issue context","assignment":{"type":"agent","targetAgents":["backend"]},"agentPermissions":{"backend":["github.contents.write"]},"prohibitedCapabilities":[],"fallback":{"action":"ask_user","message":"Connect GitHub first."}}],"promptOverlays":{},"mcpAwareSubtasks":[]}',
      '```',
    ].join('\n'))

    const result = validateMcpExecutionDesign(design, overview([healthyGithub]))

    expect(result.status).toBe('blocked')
    expect(result.blocked.join('\n')).toMatch(/outside the allowed beta scope/)
  })

  it('blocks unsafe or uncovered MCP-aware subtask capabilities during validation', () => {
    const { design: unsafeDesign } = parseMcpExecutionDesign([
      '```mcp_execution_design_json',
      '{"schemaVersion":1,"requirements":[{"mcpId":"github","requirement":"required","reason":"Need issue context","assignment":{"type":"agent","targetAgents":["backend"]},"agentPermissions":{"backend":["github.issues.read"]},"prohibitedCapabilities":[],"fallback":{"action":"ask_user","message":"Connect GitHub first."}}],"promptOverlays":{},"mcpAwareSubtasks":[{"id":"write-repo","agent":"backend","mcpCapabilities":["github.contents.write"],"inputs":[],"outputs":[],"verification":[],"stoppingCondition":"Done.","fallback":"Ask user."}]}',
      '```',
    ].join('\n'))
    const unsafe = validateMcpExecutionDesign(unsafeDesign, overview([healthyGithub]))

    expect(unsafe.status).toBe('blocked')
    expect(unsafe.blocked.join('\n')).toMatch(/outside the allowed beta scope/)

    const { design: uncoveredDesign } = parseMcpExecutionDesign([
      '```mcp_execution_design_json',
      '{"schemaVersion":1,"requirements":[{"mcpId":"github","requirement":"required","reason":"Need issue context","assignment":{"type":"agent","targetAgents":["backend"]},"agentPermissions":{"backend":["github.issues.read"]},"prohibitedCapabilities":[],"fallback":{"action":"ask_user","message":"Connect GitHub first."}}],"promptOverlays":{},"mcpAwareSubtasks":[{"id":"read-repo","agent":"backend","mcpCapabilities":["github.repository.read"],"inputs":[],"outputs":[],"verification":[],"stoppingCondition":"Done.","fallback":"Ask user."}]}',
      '```',
    ].join('\n'))
    const uncovered = validateMcpExecutionDesign(uncoveredDesign, overview([healthyGithub]))

    expect(uncovered.status).toBe('blocked')
    expect(uncovered.blocked.join('\n')).toMatch(/not covered by an explicit approved grant/)

    const { design: crossAgentDesign } = parseMcpExecutionDesign([
      '```mcp_execution_design_json',
      '{"schemaVersion":1,"requirements":[{"mcpId":"github","requirement":"required","reason":"Need issue context","assignment":{"type":"agent","targetAgents":["backend"]},"agentPermissions":{"backend":["github.issues.read"]},"prohibitedCapabilities":[],"fallback":{"action":"ask_user","message":"Connect GitHub first."}}],"promptOverlays":{},"mcpAwareSubtasks":[{"id":"frontend-read","agent":"frontend","mcpCapabilities":["github.issues.read"],"inputs":[],"outputs":[],"verification":[],"stoppingCondition":"Done.","fallback":"Ask user."}]}',
      '```',
    ].join('\n'))
    const crossAgent = validateMcpExecutionDesign(crossAgentDesign, overview([healthyGithub]))

    expect(crossAgent.status).toBe('blocked')
    expect(crossAgent.blocked.join('\n')).toMatch(/not covered by an explicit approved grant/)
  })

  it('lets broad filesystem grants cover explicit project filesystem subtasks during validation', () => {
    const { design: projectSubtaskDesign } = parseMcpExecutionDesign([
      '```mcp_execution_design_json',
      '{"schemaVersion":1,"requirements":[{"mcpId":"filesystem","requirement":"required","reason":"Search project files.","assignment":{"type":"agent","targetAgents":["backend"]},"agentPermissions":{"backend":["filesystem.search"]},"prohibitedCapabilities":[],"fallback":{"action":"ask_user","message":"Enable filesystem MCP."}}],"promptOverlays":{},"mcpAwareSubtasks":[{"id":"search-project","agent":"backend","mcpCapabilities":["filesystem.project.search"],"inputs":[],"outputs":[],"verification":[],"stoppingCondition":"Done.","fallback":"Ask user."}]}',
      '```',
    ].join('\n'))
    const projectSubtask = validateMcpExecutionDesign(projectSubtaskDesign, overview([healthyFilesystem]))

    expect(projectSubtask.status).toBe('valid')
    expect(projectSubtask.blocked).toEqual([])

    const { design: projectGrantDesign } = parseMcpExecutionDesign([
      '```mcp_execution_design_json',
      '{"schemaVersion":1,"requirements":[{"mcpId":"filesystem","requirement":"required","reason":"Search project files.","assignment":{"type":"agent","targetAgents":["backend"]},"agentPermissions":{"backend":["filesystem.project.search"]},"prohibitedCapabilities":[],"fallback":{"action":"ask_user","message":"Enable filesystem MCP."}}],"promptOverlays":{},"mcpAwareSubtasks":[{"id":"search-files","agent":"backend","mcpCapabilities":["filesystem.search"],"inputs":[],"outputs":[],"verification":[],"stoppingCondition":"Done.","fallback":"Ask user."}]}',
      '```',
    ].join('\n'))
    const projectGrant = validateMcpExecutionDesign(projectGrantDesign, overview([healthyFilesystem]))

    expect(projectGrant.status).toBe('blocked')
    expect(projectGrant.blocked.join('\n')).toMatch(/not covered by an explicit approved grant/)
  })

  it('blocks unknown or unhealthy required MCPs', () => {
    const { design } = parseMcpExecutionDesign([
      '```mcp_execution_design_json',
      '{"schemaVersion":1,"requirements":[{"mcpId":"github","requirement":"required","assignment":{"type":"agent","targetAgents":["backend"]},"agentPermissions":{"backend":["github.issues.read"]},"fallback":{"action":"block","message":"GitHub required."}},{"mcpId":"slack","requirement":"required","assignment":{"type":"agent","targetAgents":["qa"]},"agentPermissions":{"qa":["slack.read"]},"fallback":{"action":"block","message":"Slack required."}}],"promptOverlays":{},"mcpAwareSubtasks":[]}',
      '```',
    ].join('\n'))

    const result = validateMcpExecutionDesign(design, overview([unhealthyGithub]))
    expect(result.status).toBe('blocked')
    expect(result.blocked.join('\n')).toMatch(/auth_required/)
    expect(result.blocked.join('\n')).toMatch(/Unknown MCP 'slack'/)
  })

  it('warns for unavailable optional MCPs and missing design blocks', () => {
    const { design } = parseMcpExecutionDesign([
      '```mcp_execution_design_json',
      '{"schemaVersion":1,"requirements":[{"mcpId":"github","requirement":"optional","assignment":{"type":"agent","targetAgents":["reviewer"]},"agentPermissions":{"reviewer":["github.pull_requests.read"]},"fallback":{"action":"continue_without_mcp","message":"Review local diff instead."}}],"promptOverlays":{},"mcpAwareSubtasks":[]}',
      '```',
    ].join('\n'))

    expect(validateMcpExecutionDesign(design, overview([unhealthyGithub])).status).toBe('warnings')
    expect(validateMcpExecutionDesign(null, overview([]))).toMatchObject({
      status: 'warnings',
      runtimeEnforcement: 'not_implemented',
    })
  })

  it('blocks required known MCPs that are absent from the project overview', () => {
    const { design } = parseMcpExecutionDesign([
      '```mcp_execution_design_json',
      '{"schemaVersion":1,"requirements":[{"mcpId":"github","requirement":"required","assignment":{"type":"agent","targetAgents":["backend"]},"agentPermissions":{"backend":["github.issues.read"]},"fallback":{"action":"block","message":"GitHub required."}}],"promptOverlays":{},"mcpAwareSubtasks":[]}',
      '```',
    ].join('\n'))

    const result = validateMcpExecutionDesign(design, overview([]))
    expect(result.status).toBe('blocked')
    expect(result.blocked.join('\n')).toMatch(/not configured/)
  })

  it('warns for optional known MCPs that are absent from the project overview', () => {
    const { design } = parseMcpExecutionDesign([
      '```mcp_execution_design_json',
      '{"schemaVersion":1,"requirements":[{"mcpId":"github","requirement":"optional","assignment":{"type":"agent","targetAgents":["reviewer"]},"agentPermissions":{"reviewer":["github.pull_requests.read"]},"fallback":{"action":"continue_without_mcp","message":"Use local context."}}],"promptOverlays":{},"mcpAwareSubtasks":[]}',
      '```',
    ].join('\n'))

    const result = validateMcpExecutionDesign(design, overview([]))
    expect(result.status).toBe('warnings')
    expect(result.warnings.join('\n')).toMatch(/not configured/)
  })
})

describe('deriveMcpGrantDecisions', () => {
  it('creates proposed decisions for healthy MCP permissions', () => {
    const { design } = parseMcpExecutionDesign([
      '```mcp_execution_design_json',
      '{"schemaVersion":1,"requirements":[{"mcpId":"github","requirement":"required","reason":"Need issue context","assignment":{"type":"agent","targetAgents":["backend"]},"agentPermissions":{"backend":["github.issues.read"]},"fallback":{"action":"ask_user","message":"Connect GitHub first."}}],"promptOverlays":{"backend":"Use scoped GitHub tools."},"mcpAwareSubtasks":[]}',
      '```',
    ].join('\n'))

    const result = deriveMcpGrantDecisions(design, overview([healthyGithub]))

    expect(result.summary).toEqual({ proposed: 1, warning: 0, blocked: 0 })
    expect(result.decisions[0]).toMatchObject({
      decisionId: 'req-0:backend:github',
      agent: 'backend',
      mcpId: 'github',
      capabilities: ['github.issues.read'],
      status: 'proposed',
      promptOverlayPresent: true,
    })
    expect(result.runtimeEnforcement).toBe('not_implemented')
  })

  it('creates one decision per permitted agent', () => {
    const { design } = parseMcpExecutionDesign([
      '```mcp_execution_design_json',
      '{"schemaVersion":1,"requirements":[{"mcpId":"github","requirement":"required","assignment":{"type":"workforce","targetAgents":["architect","backend"]},"agentPermissions":{"architect":["github.issues.read"],"backend":["github.contents.read"]},"fallback":{"action":"ask_user","message":"Connect GitHub first."}}],"promptOverlays":{},"mcpAwareSubtasks":[]}',
      '```',
    ].join('\n'))

    const result = deriveMcpGrantDecisions(design, overview([healthyGithub]))

    expect(result.summary.proposed).toBe(2)
    expect(result.decisions.map((decision) => decision.agent)).toEqual(['architect', 'backend'])
  })

  it('blocks required unhealthy or unknown MCP requirements', () => {
    const { design } = parseMcpExecutionDesign([
      '```mcp_execution_design_json',
      '{"schemaVersion":1,"requirements":[{"mcpId":"github","requirement":"required","assignment":{"type":"agent","targetAgents":["backend"]},"agentPermissions":{"backend":["github.issues.read"]},"fallback":{"action":"ask_user","message":"Connect GitHub."}},{"mcpId":"slack","requirement":"required","assignment":{"type":"agent","targetAgents":["qa"]},"agentPermissions":{"qa":["slack.read"]},"fallback":{"action":"block","message":"Slack required."}}],"promptOverlays":{},"mcpAwareSubtasks":[]}',
      '```',
    ].join('\n'))

    const result = deriveMcpGrantDecisions(design, overview([unhealthyGithub]))

    expect(result.summary).toEqual({ proposed: 0, warning: 0, blocked: 2 })
    expect(result.decisions.map((decision) => decision.status)).toEqual(['blocked', 'blocked'])
    expect(result.decisions[0].health.status).toBe('auth_required')
    expect(result.decisions[1].health.status).toBe('unknown')
  })

  it('warns for optional unavailable MCP access with a non-blocking fallback', () => {
    const { design } = parseMcpExecutionDesign([
      '```mcp_execution_design_json',
      '{"schemaVersion":1,"requirements":[{"mcpId":"github","requirement":"optional","assignment":{"type":"agent","targetAgents":["reviewer"]},"agentPermissions":{"reviewer":["github.pull_requests.read"]},"fallback":{"action":"continue_without_mcp","message":"Review local diff instead."}}],"promptOverlays":{},"mcpAwareSubtasks":[]}',
      '```',
    ].join('\n'))

    const result = deriveMcpGrantDecisions(design, overview([]))

    expect(result.summary).toEqual({ proposed: 0, warning: 1, blocked: 0 })
    expect(result.decisions[0]).toMatchObject({
      agent: 'reviewer',
      status: 'warning',
      fallback: { action: 'continue_without_mcp' },
    })
  })

  it('blocks optional unavailable MCP access with ask_user fallback', () => {
    const { design } = parseMcpExecutionDesign([
      '```mcp_execution_design_json',
      '{"schemaVersion":1,"requirements":[{"mcpId":"github","requirement":"optional","assignment":{"type":"agent","targetAgents":["reviewer"]},"agentPermissions":{"reviewer":["github.pull_requests.read"]},"fallback":{"action":"ask_user","message":"Connect GitHub first."}}],"promptOverlays":{},"mcpAwareSubtasks":[]}',
      '```',
    ].join('\n'))

    const validation = validateMcpExecutionDesign(design, overview([]))
    const decisions = deriveMcpGrantDecisions(design, overview([]))

    expect(validation.status).toBe('blocked')
    expect(validation.blocked).toEqual(["MCP 'github' is not configured for this project."])
    expect(decisions.summary).toEqual({ proposed: 0, warning: 0, blocked: 1 })
    expect(decisions.decisions[0]).toMatchObject({
      agent: 'reviewer',
      status: 'blocked',
      fallback: { action: 'ask_user' },
    })
  })

  it('blocks unknown MCPs even when they are optional with a non-blocking fallback', () => {
    const { design } = parseMcpExecutionDesign([
      '```mcp_execution_design_json',
      '{"schemaVersion":1,"requirements":[{"mcpId":"slack","requirement":"optional","assignment":{"type":"agent","targetAgents":["reviewer"]},"agentPermissions":{"reviewer":["slack.read"]},"fallback":{"action":"continue_without_mcp","message":"Review without Slack."}}],"promptOverlays":{},"mcpAwareSubtasks":[]}',
      '```',
    ].join('\n'))

    const result = deriveMcpGrantDecisions(design, overview([]))

    expect(result.summary).toEqual({ proposed: 0, warning: 0, blocked: 1 })
    expect(result.decisions[0]).toMatchObject({
      mcpId: 'slack',
      status: 'blocked',
    })
  })

  it('does not propose healthy MCP access without explicit agent capabilities', () => {
    const { design } = parseMcpExecutionDesign([
      '```mcp_execution_design_json',
      '{"schemaVersion":1,"requirements":[{"mcpId":"github","requirement":"required","assignment":{"type":"agent","targetAgents":["backend"]},"agentPermissions":{},"fallback":{"action":"ask_user","message":"Connect GitHub first."}}],"promptOverlays":{},"mcpAwareSubtasks":[]}',
      '```',
    ].join('\n'))

    const result = deriveMcpGrantDecisions(design, overview([healthyGithub]))

    expect(result.summary).toEqual({ proposed: 0, warning: 0, blocked: 1 })
    expect(result.decisions[0]).toMatchObject({
      agent: 'backend',
      capabilities: [],
      status: 'blocked',
    })
  })

  it('blocks grant decisions for capabilities outside the safe beta allowlist', () => {
    const { design } = parseMcpExecutionDesign([
      '```mcp_execution_design_json',
      '{"schemaVersion":1,"requirements":[{"mcpId":"github","requirement":"required","assignment":{"type":"agent","targetAgents":["backend"]},"agentPermissions":{"backend":["github.contents.write"]},"fallback":{"action":"ask_user","message":"Connect GitHub first."}}],"promptOverlays":{},"mcpAwareSubtasks":[]}',
      '```',
    ].join('\n'))

    const result = deriveMcpGrantDecisions(design, overview([healthyGithub]))

    expect(result.summary).toEqual({ proposed: 0, warning: 0, blocked: 1 })
    expect(result.decisions[0]).toMatchObject({
      agent: 'backend',
      mcpId: 'github',
      status: 'blocked',
    })
  })

  it('blocks overlay-only MCP instructions that have no explicit grant decision', () => {
    const result = evaluateWorkPackageMcpBroker({
      assignedRole: 'backend',
      metadata: {
        promptOverlay: 'GitHub MCP is granted; inspect the repository.',
      },
      title: 'Backend package',
    })

    expect(result.status).toBe('blocked')
    expect(result.blocked.join('\n')).toMatch(/require at least one explicit/)
  })

  it('blocks work-package optional unavailable MCP access unless fallback is non-blocking', () => {
    const result = evaluateWorkPackageMcpBroker({
      assignedRole: 'reviewer',
      mcpOverview: overview([]),
      mcpRequirements: [{
        mcpId: 'github',
        requirement: 'optional',
        permissions: ['github.pull_requests.read'],
        fallback: { action: 'ask_user' },
      }],
      metadata: {},
      title: 'Reviewer package',
    })

    expect(result.status).toBe('blocked')
    expect(result.blockedReason).toMatch(/not configured/i)
  })

  it('blocks optional unknown MCP ids even when fallback says continue without MCP', () => {
    const result = evaluateWorkPackageMcpBroker({
      mcpRequirements: [{
        mcpId: 'slack',
        requirement: 'optional',
        permissions: ['slack.messages.read'],
        fallback: { action: 'continue_without_mcp' },
      }],
      title: 'Backend package',
    })

    expect(result.status).toBe('blocked')
    expect(result.blocked.join('\n')).toMatch(/Unknown MCP 'slack'/)
  })

  it('blocks denied or prohibited capabilities even for healthy MCPs', () => {
    const result = evaluateWorkPackageMcpBroker({
      mcpOverview: overview([healthyGithub]),
      mcpRequirements: [{
        mcpId: 'github',
        requirement: 'required',
        capabilities: ['github.pull_requests.merge'],
        prohibitedCapabilities: ['github.pull_requests.merge'],
        fallback: { action: 'block' },
      }],
      title: 'Backend package',
    })

    expect(result.status).toBe('blocked')
    expect(result.blocked.join('\n')).toMatch(/outside the allowed beta scope/)
  })

  it('allows only explicit safe read/list/search beta capabilities', () => {
    const allowed = evaluateWorkPackageMcpBroker({
      mcpOverview: overview([healthyGithub]),
      mcpRequirements: [{
        mcpId: 'github',
        requirement: 'required',
        capabilities: ['github.issues.read', 'github.repository.search'],
        fallback: { action: 'block' },
      }],
      title: 'Backend package',
    })
    expect(allowed.status).toBe('allowed')

    const blocked = evaluateWorkPackageMcpBroker({
      mcpOverview: overview([healthyGithub]),
      mcpRequirements: [{
        mcpId: 'github',
        requirement: 'required',
        capabilities: ['GitHub.Repository.Write', 'github.actions.write', 'github.secrets.write'],
        fallback: { action: 'block' },
      }],
      title: 'Backend package',
    })
    expect(blocked.status).toBe('blocked')
    expect(blocked.blocked.join('\n')).toMatch(/github\.repository\.write/)
    expect(blocked.blocked.join('\n')).toMatch(/github\.actions\.write/)
    expect(blocked.blocked.join('\n')).toMatch(/github\.secrets\.write/)
  })

  it('re-evaluates stale blocked grant snapshots against current MCP health', () => {
    const result = evaluateWorkPackageMcpBroker({
      mcpOverview: overview([healthyGithub]),
      metadata: {
        mcpGrants: [{
          mcpId: 'github',
          requirement: 'required',
          status: 'blocked',
          capabilities: ['github.issues.read'],
          fallback: { action: 'block' },
        }],
      },
      title: 'Backend package',
    })

    expect(result.status).toBe('warnings')
    expect(result.blocked).toEqual([])
    expect(result.warnings.join('\n')).toMatch(/previously blocked/)
  })

  it('does not let stale global harness grants satisfy package-local MCP instructions', () => {
    const result = evaluateWorkPackageMcpBroker({
      harnessToolPolicy: {
        mcpGrants: [{
          mcpId: 'github',
          requirement: 'required',
          capabilities: ['github.issues.read'],
          fallback: { action: 'block' },
        }],
      },
      metadata: {
        promptOverlay: 'Use GitHub MCP for issue context.',
      },
      title: 'Backend package',
    })

    expect(result.status).toBe('blocked')
    expect(result.blocked.join('\n')).toMatch(/require at least one explicit/)
  })

  it('blocks unsafe or uncovered MCP-aware subtask capabilities', () => {
    const unsafe = evaluateWorkPackageMcpBroker({
      mcpOverview: overview([healthyGithub]),
      mcpRequirements: [{
        mcpId: 'github',
        requirement: 'required',
        capabilities: ['github.issues.read'],
        fallback: { action: 'block' },
      }],
      metadata: {
        mcpAwareSubtasks: [{
          id: 'merge-pr',
          mcpCapabilities: ['github.pull_requests.merge'],
        }],
      },
      title: 'Backend package',
    })
    expect(unsafe.status).toBe('blocked')
    expect(unsafe.blocked.join('\n')).toMatch(/outside the allowed beta scope/)

    const uncovered = evaluateWorkPackageMcpBroker({
      mcpOverview: overview([healthyGithub]),
      mcpRequirements: [{
        mcpId: 'github',
        requirement: 'required',
        capabilities: ['github.issues.read'],
        fallback: { action: 'block' },
      }],
      metadata: {
        mcpAwareSubtasks: [{
          id: 'read-repo',
          mcpCapabilities: ['github.repository.read'],
        }],
      },
      title: 'Backend package',
    })
    expect(uncovered.status).toBe('blocked')
    expect(uncovered.blocked.join('\n')).toMatch(/not covered by an explicit approved grant/)
  })

  it('allows package MCP-aware subtasks covered by broad project-root filesystem grants', () => {
    const projectSubtask = evaluateWorkPackageMcpBroker({
      mcpOverview: overview([healthyFilesystem]),
      mcpRequirements: [{
        mcpId: 'filesystem',
        requirement: 'required',
        capabilities: ['filesystem.search'],
        fallback: { action: 'block' },
      }],
      metadata: {
        mcpAwareSubtasks: [{
          id: 'search-project',
          mcpCapabilities: ['filesystem.project.search'],
        }],
      },
      title: 'Backend package',
    })
    expect(projectSubtask.status).toBe('allowed')
    expect(projectSubtask.blocked).toEqual([])

    const projectGrant = evaluateWorkPackageMcpBroker({
      mcpOverview: overview([healthyFilesystem]),
      mcpRequirements: [{
        mcpId: 'filesystem',
        requirement: 'required',
        capabilities: ['filesystem.project.read'],
        fallback: { action: 'block' },
      }],
      metadata: {
        mcpAwareSubtasks: [{
          id: 'read-files',
          mcpCapabilities: ['filesystem.read'],
        }],
      },
      title: 'Backend package',
    })
    expect(projectGrant.status).toBe('blocked')
    expect(projectGrant.blocked.join('\n')).toMatch(/not covered by an explicit approved grant/)
  })

  it('applies filesystem project/non-project aliases to prohibited capabilities', () => {
    const result = evaluateWorkPackageMcpBroker({
      mcpOverview: overview([healthyFilesystem]),
      mcpRequirements: [{
        mcpId: 'filesystem',
        requirement: 'required',
        capabilities: ['filesystem.project.search'],
        prohibitedCapabilities: ['filesystem.search'],
        fallback: { action: 'block' },
      }],
      title: 'Backend package',
    })

    expect(result.status).toBe('blocked')
    expect(result.blocked.join('\n')).toMatch(/filesystem\.project\.search/)
  })

  it('blocks (does not throw on) prototype-polluting capability ids', () => {
    const viaSubtask = evaluateWorkPackageMcpBroker({
      mcpOverview: overview([healthyGithub]),
      mcpRequirements: [{
        mcpId: 'github',
        requirement: 'required',
        capabilities: ['github.issues.read'],
        fallback: { action: 'block' },
      }],
      metadata: {
        mcpAwareSubtasks: [{ id: 'evil', mcpCapabilities: ['constructor.read'] }],
      },
      title: 'Backend package',
    })
    expect(viaSubtask.status).toBe('blocked')
    expect(viaSubtask.blocked.join('\n')).toMatch(/does not name a known MCP/)

    const viaRequirement = evaluateWorkPackageMcpBroker({
      mcpOverview: overview([healthyGithub]),
      mcpRequirements: [{
        mcpId: '__proto__',
        requirement: 'required',
        capabilities: ['__proto__.read'],
        fallback: { action: 'block' },
      }],
      title: 'Backend package',
    })
    expect(viaRequirement.status).toBe('blocked')
    expect(viaRequirement.blocked.join('\n')).toMatch(/Unknown MCP/)
  })

  it('returns an empty preview when the Architect omitted the design block', () => {
    const result = deriveMcpGrantDecisions(null, overview([]))

    expect(result.summary).toEqual({ proposed: 0, warning: 0, blocked: 0 })
    expect(result.decisions).toEqual([])
  })

  it('classifies only transient MCP health/configuration blocks as auto-retryable', () => {
    expect(isRetryableMcpBrokerBlock(["MCP 'github' is not configured for this project."])).toBe(true)
    expect(isRetryableMcpBrokerBlock(["MCP 'github' capability 'github.contents.write' is outside the allowed beta scope."])).toBe(false)
    expect(isRetryableMcpBrokerBlock(["Unknown MCP 'slack' was requested."])).toBe(false)
    expect(isRetryableMcpBrokerBlock([
      "MCP 'github' is not configured for this project.",
      "MCP-aware subtask capability 'github.contents.write' is outside the allowed beta scope.",
    ])).toBe(false)
  })
})
