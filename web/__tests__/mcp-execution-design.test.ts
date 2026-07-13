import { describe, expect, it } from 'vitest'
import { MCP_CATALOG } from '@/lib/mcps/catalog'
import type { ProjectMcpOverview } from '@/lib/mcps/types'
import {
  deriveMcpGrantDecisions,
  evaluateWorkPackageMcpBroker,
  hasWorkPackageMcpRuntimeInputs,
  parseMcpExecutionDesign,
  validateMcpExecutionDesign,
} from '@/worker/mcp-execution-design'

function overview(statuses: ProjectMcpOverview['statuses']): ProjectMcpOverview {
  return {
    projectId: 'project-1',
    config: { profile: 'default', requiredMcps: ['filesystem', 'github'], overrides: {} },
    catalog: Object.values(MCP_CATALOG),
    mcpsRoot: '/tmp/forge/mcps',
    statuses,
    summary: { label: 'MCPs', status: 'healthy', missing: 0, authRequired: 0, unhealthy: 0, disabled: 0 },
  }
}

const healthyGithub = {
  mcpId: 'github', displayName: 'GitHub', description: 'GitHub MCP', installPath: '/tmp/forge/mcps/github',
  installState: 'installed' as const, status: 'healthy' as const, enabled: true, error: null,
  checkedAt: '2026-07-14T00:00:00.000Z',
}

const healthyFilesystem = {
  mcpId: 'filesystem', displayName: 'Filesystem', description: 'Filesystem MCP', installPath: '/tmp/forge/mcps/filesystem',
  installState: 'installed' as const, status: 'healthy' as const, enabled: true, error: null,
  checkedAt: '2026-07-14T00:00:01.000Z',
}

function fence(value: Record<string, unknown>): string {
  return `\`\`\`mcp_execution_design_json\n${JSON.stringify(value)}\n\`\`\``
}

function requirement(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    mcpId: 'github',
    requirement: 'required',
    reason: 'Read issue context.',
    assignment: { type: 'agent', targetAgents: ['backend'], targetId: null },
    agentPermissions: { backend: ['github.issues.read'] },
    prohibitedCapabilities: ['github.pull_requests.merge'],
    fallback: { action: 'ask_user', message: 'Connect GitHub.' },
    ...overrides,
  }
}

function design(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    requirements: [requirement()],
    promptOverlays: {},
    requirementContexts: [{ sourceRequirementIndex: 0, agent: 'backend', promptOverlay: 'Use supplied issue context.' }],
    mcpAwareSubtasks: [],
    ...overrides,
  }
}

describe('MCP execution design normalization', () => {
  it('parses and removes the design fence', () => {
    const parsed = parseMcpExecutionDesign(`# Plan\n${fence(design())}`)
    expect(parsed.planText).toBe('# Plan')
    expect(parsed.design?.requirements[0].requirementKey).toMatch(/^mcp-requirement-v1-[a-f0-9]{32}-1$/)
  })

  it('generates stable policy keys across prose and ordering changes', () => {
    const first = parseMcpExecutionDesign(fence(design())).design!
    const second = parseMcpExecutionDesign(fence(design({
      requirements: [requirement({
        reason: 'Different prose.',
        assignment: { type: 'agent', targetAgents: ['backend'], targetId: null },
        agentPermissions: { backend: ['github.issues.read'] },
        prohibitedCapabilities: ['github.pull_requests.merge'],
        fallback: { action: 'ask_user', message: 'Different prose.' },
        requirementKey: 'architect-controlled-key',
      })],
    }))).design!
    expect(second.requirements[0].requirementKey).toBe(first.requirements[0].requirementKey)
    expect(second.requirements[0].requirementKey).not.toBe('architect-controlled-key')
  })

  it('keeps exact duplicates independently addressable', () => {
    const parsed = parseMcpExecutionDesign(fence(design({ requirements: [requirement(), requirement()] }))).design!
    expect(parsed.requirements.map((item) => item.requirementKey)).toEqual([
      expect.stringMatching(/-1$/),
      expect.stringMatching(/-2$/),
    ])
    expect(new Set(parsed.requirements.map((item) => item.requirementKey)).size).toBe(2)
  })

  it('converts positional contexts and per-capability references to generated keys', () => {
    const parsed = parseMcpExecutionDesign(fence(design({
      mcpAwareSubtasks: [{
        id: 'inspect', agent: 'backend', dependsOn: [], mcpCapabilities: ['github.issues.read'],
        capabilityRequirements: [{ capability: 'github.issues.read', sourceRequirementIndex: 0 }],
        inputs: [], outputs: [], verification: [], stoppingCondition: 'Done.', fallback: 'Ask user.',
      }],
    }))).design!
    const key = parsed.requirements[0].requirementKey
    expect(parsed.requirementContexts).toEqual([expect.objectContaining({ requirementKey: key, sourceRequirementIndex: 0, agent: 'backend' })])
    expect(parsed.mcpAwareSubtasks[0].capabilityBindings).toEqual([{ capability: 'github.issues.read', requirementKey: key }])
  })

  it('fails closed when explicit subtask bindings omit a declared capability', () => {
    const parsed = parseMcpExecutionDesign(fence(design({
      requirements: [
        requirement(),
        requirement({
          mcpId: 'filesystem',
          agentPermissions: { backend: ['filesystem.project.write'] },
          prohibitedCapabilities: [],
        }),
      ],
      mcpAwareSubtasks: [{
        id: 'inspect', agent: 'backend', dependsOn: [],
        mcpCapabilities: ['github.issues.read', 'filesystem.project.write'],
        capabilityRequirements: [{ capability: 'github.issues.read', sourceRequirementIndex: 0 }],
        inputs: [], outputs: [], verification: [], stoppingCondition: 'Done.', fallback: 'Ask user.',
      }],
    }))).design!

    expect(parsed.normalizationErrors?.join('\n')).toMatch(/filesystem\.project\.write.*exactly one requirement binding/)
    expect(validateMcpExecutionDesign(parsed, overview([healthyGithub])).status).toBe('blocked')
  })

  it.each([null, 'not-an-array', { capability: 'github.issues.read', sourceRequirementIndex: 0 }])(
    'fails closed when explicit subtask bindings use malformed container %j',
    (capabilityRequirements) => {
      const parsed = parseMcpExecutionDesign(fence(design({
        mcpAwareSubtasks: [{
          id: 'inspect', agent: 'backend', dependsOn: [], mcpCapabilities: ['github.issues.read'],
          capabilityRequirements,
          inputs: [], outputs: [], verification: [], stoppingCondition: 'Done.', fallback: 'Ask user.',
        }],
      }))).design!

      expect(parsed.normalizationErrors?.join('\n')).toMatch(/capabilityRequirements must be an array/)
      expect(parsed.mcpAwareSubtasks[0].capabilityBindings).toEqual([])
      expect(validateMcpExecutionDesign(parsed, overview([healthyGithub])).status).toBe('blocked')
    },
  )

  it('records malformed requirements and subtasks instead of silently dropping them', () => {
    const parsed = parseMcpExecutionDesign(fence(design({
      requirements: [{ requirement: 'required', mcpId: '' }],
      requirementContexts: [],
      mcpAwareSubtasks: [{ id: '', agent: '', mcpCapabilities: ['github.contents.write'] }],
    }))).design!

    expect(parsed.requirements).toEqual([])
    expect(parsed.mcpAwareSubtasks).toEqual([])
    expect(parsed.normalizationErrors).toEqual([
      'MCP requirement 0 is malformed and cannot be normalized.',
      'MCP-aware subtask 0 is malformed and cannot be normalized.',
    ])
    expect(validateMcpExecutionDesign(parsed, overview([healthyGithub]))).toMatchObject({
      status: 'blocked',
      blocked: expect.arrayContaining([
        'MCP requirement 0 is malformed and cannot be normalized.',
        'MCP-aware subtask 0 is malformed and cannot be normalized.',
      ]),
    })
  })

  it('blocks nested policy overflow instead of dropping a trailing prohibition', () => {
    const parsed = parseMcpExecutionDesign(fence(design({
      requirements: [requirement({
        mcpId: 'filesystem',
        agentPermissions: {
          backend: [...Array(20).fill('filesystem.project.read'), 'filesystem.project.search'],
        },
        prohibitedCapabilities: [
          ...Array(30).fill('filesystem.project.search'),
          'filesystem.project.read',
        ],
      })],
      requirementContexts: [],
    }))).design!

    expect(parsed.normalizationErrors).toEqual(expect.arrayContaining([
      expect.stringMatching(/permissions.*exceeds the maximum of 20/),
      expect.stringMatching(/prohibitedCapabilities exceeds the maximum of 30/),
    ]))
    expect(validateMcpExecutionDesign(parsed, overview([healthyFilesystem])).status).toBe('blocked')
  })

  it('fails closed instead of assigning an ambiguous legacy overlay', () => {
    const parsed = parseMcpExecutionDesign(fence(design({
      requirements: [requirement(), requirement({ fallback: { action: 'block', message: 'Required.' } })],
      promptOverlays: { backend: 'Ambiguous context.' },
      requirementContexts: undefined,
    }))).design!
    expect(parsed.requirementContexts).toEqual([])
    expect(parsed.normalizationErrors?.join('\n')).toMatch(/ambiguous/i)
    expect(validateMcpExecutionDesign(parsed, overview([healthyGithub])).status).toBe('blocked')
  })

  it('fails closed when a requirement has no materializable agent package', () => {
    const parsed = parseMcpExecutionDesign(fence(design({
      requirements: [requirement({
        assignment: { type: 'agent', targetAgents: [], targetId: null },
        agentPermissions: {},
      })],
      requirementContexts: [],
    }))).design!

    expect(parsed.normalizationErrors).toEqual([
      "MCP 'github' requirement does not target any valid agent.",
    ])
    expect(validateMcpExecutionDesign(parsed, overview([healthyGithub]))).toMatchObject({
      status: 'blocked',
      blocked: [expect.stringMatching(/does not target any valid agent/)],
    })
  })
})

describe('canonical admission adapters', () => {
  it('uses the same canonical envelope for validation and preview', () => {
    const parsed = parseMcpExecutionDesign(fence(design())).design!
    const validation = validateMcpExecutionDesign(parsed, overview([healthyGithub]))
    const preview = deriveMcpGrantDecisions(parsed, overview([healthyGithub]))
    expect(validation.status).toBe('valid')
    expect(preview.admissionStatus).toBe('allowed')
    expect(preview.decisions[0]).toMatchObject({
      requirementKey: parsed.requirements[0].requirementKey,
      mode: 'planning_only',
      admissionStatus: 'allowed',
      health: { schemaVersion: 1, observed: true, checkedAt: healthyGithub.checkedAt },
      grantState: { phase: 'not_issued' },
    })
  })

  it('keeps multi-MCP subtask bindings distinct and blocks missing coverage', () => {
    const parsed = parseMcpExecutionDesign(fence(design({
      requirements: [
        requirement(),
        requirement({
          mcpId: 'filesystem',
          agentPermissions: { backend: ['filesystem.project.read'] },
          prohibitedCapabilities: [],
        }),
      ],
      requirementContexts: [{ sourceRequirementIndex: 0, agent: 'backend', promptOverlay: 'Issue context.' }],
      mcpAwareSubtasks: [{
        id: 'inspect', agent: 'backend', dependsOn: [],
        mcpCapabilities: ['github.issues.read', 'filesystem.project.read'],
        capabilityRequirements: [
          { capability: 'github.issues.read', sourceRequirementIndex: 0 },
          { capability: 'filesystem.project.read', sourceRequirementIndex: 1 },
        ],
        inputs: [], outputs: [], verification: [], stoppingCondition: 'Done.', fallback: 'Ask user.',
      }],
    }))).design!
    expect(parsed.mcpAwareSubtasks[0].capabilityBindings?.map((binding) => binding.requirementKey)).toEqual([
      parsed.requirements[0].requirementKey,
      parsed.requirements[1].requirementKey,
    ])
    expect(validateMcpExecutionDesign(parsed, overview([healthyGithub])).status).toBe('blocked')
  })

  it('uses the same project filesystem grant in preview and handoff', () => {
    const parsed = parseMcpExecutionDesign(fence(design({
      requirements: [requirement({
        mcpId: 'filesystem',
        agentPermissions: { backend: ['filesystem.project.read'] },
        prohibitedCapabilities: [],
      })],
      requirementContexts: [],
    }))).design!
    const projectMcpConfig: ProjectMcpOverview['config'] = {
      profile: 'default',
      requiredMcps: ['filesystem'],
      overrides: {},
      grants: {
        filesystem: {
          schemaVersion: 1,
          mcpId: 'filesystem',
          status: 'approved',
          grantMode: 'always_allow',
          capabilities: ['filesystem.project.read'],
          grantApprovalId: 'grant-1',
          approvedAt: '2026-07-14T00:00:00.000Z',
          approvedBy: 'user-1',
          reason: 'Approved for this project.',
        },
      },
    }
    const mcpOverview = { ...overview([healthyFilesystem]), config: projectMcpConfig }
    const preview = deriveMcpGrantDecisions(parsed, mcpOverview)
    const requirementKey = parsed.requirements[0].requirementKey as string
    const rawPolicy = {
      requirementKey,
      sourceRequirementIndex: 0,
      agent: 'backend',
      mcpId: 'filesystem',
      requirement: 'required',
      permissions: ['filesystem.project.read'],
      prohibitedCapabilities: [],
      assignment: { type: 'agent', targetId: null },
      fallback: parsed.requirements[0].fallback,
    }
    const broker = evaluateWorkPackageMcpBroker({
      assignedRole: 'backend',
      mcpOverview,
      mcpRequirements: [rawPolicy],
      metadata: { mcpGrants: preview.decisions },
      projectMcpConfig,
      title: 'Backend package',
    })

    expect(preview.decisions[0]).toMatchObject({
      mode: 'bounded_context_approved',
      admissionStatus: 'allowed',
    })
    expect(broker.evaluations[0].decision).toMatchObject({
      mode: 'bounded_context_approved',
      status: 'allowed',
    })
    expect(broker.status).toBe('allowed')
  })

  it('does not treat an empty requirement context record as materialized prompt evidence', () => {
    const requirementKey = 'mcp-requirement-v1-empty-context-1'
    const broker = evaluateWorkPackageMcpBroker({
      assignedRole: 'backend',
      mcpOverview: overview([healthyGithub]),
      mcpRequirements: [{
        requirementKey,
        sourceRequirementIndex: 0,
        agent: 'backend',
        mcpId: 'github',
        requirement: 'required',
        permissions: ['github.issues.read'],
        assignment: { type: 'agent', targetId: null },
        fallback: { action: 'block', message: '' },
      }],
      metadata: {
        requirementContexts: [{ requirementKey, agent: 'backend', mcpId: 'github' }],
      },
    })

    expect(broker.status).toBe('blocked')
    expect(broker.evaluations[0].decision).toMatchObject({
      mode: 'blocked',
      recoveryAction: 'revise_plan',
    })
  })

  it('strictly pairs a legacy raw policy and derived envelope once', () => {
    const broker = evaluateWorkPackageMcpBroker({
      assignedRole: 'backend',
      mcpOverview: overview([healthyGithub]),
      mcpRequirements: [{
        sourceRequirementIndex: 0, mcpId: 'github', requirement: 'required',
        permissions: ['github.issues.read'], fallback: { action: 'ask_user' },
      }],
      metadata: {
        promptOverlay: 'Use issue context.',
        mcpGrants: [{
          decisionId: 'legacy-grant', sourceRequirementIndex: 0, agent: 'backend', mcpId: 'github',
          requirement: 'required', capabilities: ['github.issues.read'], fallback: { action: 'ask_user' },
          status: 'proposed',
        }],
      },
    })
    expect(broker.evaluations).toHaveLength(1)
    expect(broker.status).not.toBe('blocked')
  })

  it('does not repair a keyed policy that is missing its persisted agent identity', () => {
    const requirementKey = 'mcp-requirement-v1-missing-agent-1'
    const broker = evaluateWorkPackageMcpBroker({
      assignedRole: 'backend',
      mcpOverview: overview([healthyGithub]),
      mcpRequirements: [{
        requirementKey,
        sourceRequirementIndex: 0,
        mcpId: 'github',
        requirement: 'required',
        permissions: ['github.issues.read'],
        assignment: { type: 'agent', targetId: null },
        fallback: { action: 'block', message: '' },
      }],
      metadata: {
        requirementContexts: [{
          requirementKey,
          agent: 'backend',
          mcpId: 'github',
          promptOverlay: 'Use supplied issue context.',
        }],
      },
    })

    expect(broker.status).toBe('blocked')
    expect(broker.blockedReason).toMatch(/explicit agent identity/)
  })

  it('does not apply legacy agent or binding repair to current-schema subtasks', () => {
    const requirementKey = 'mcp-requirement-v1-current-subtask-1'
    const broker = evaluateWorkPackageMcpBroker({
      assignedRole: 'backend',
      mcpOverview: overview([healthyGithub]),
      mcpRequirements: [{
        requirementKey,
        sourceRequirementIndex: 0,
        agent: 'backend',
        mcpId: 'github',
        requirement: 'required',
        permissions: ['github.issues.read'],
        assignment: { type: 'agent', targetId: null },
        fallback: { action: 'block', message: '' },
      }],
      metadata: {
        mcpGrantsSchemaVersion: 2,
        requirementContexts: [{
          requirementKey,
          agent: 'backend',
          mcpId: 'github',
          promptOverlay: 'Use supplied issue context.',
        }],
        mcpAwareSubtasks: [{ id: 'inspect', mcpCapabilities: ['github.issues.read'] }],
      },
    })

    expect(broker.status).toBe('blocked')
    expect(broker.blockedReason).toMatch(/explicit agent identity/)
  })

  it('requires explicit bindings and scoped policy identity across the schema-v2 package', () => {
    const requirementKey = 'mcp-requirement-v1-current-subtask-2'
    const missingBindings = evaluateWorkPackageMcpBroker({
      assignedRole: 'backend',
      mcpOverview: overview([healthyGithub]),
      mcpRequirements: [{
        requirementKey,
        sourceRequirementIndex: 0,
        agent: 'backend',
        mcpId: 'github',
        requirement: 'required',
        permissions: ['github.issues.read'],
        assignment: { type: 'agent', targetId: null },
        fallback: { action: 'block', message: '' },
      }],
      metadata: {
        mcpGrantsSchemaVersion: 2,
        requirementContexts: [{
          requirementKey,
          agent: 'backend',
          mcpId: 'github',
          promptOverlay: 'Use supplied issue context.',
        }],
        mcpAwareSubtasks: [{
          id: 'inspect',
          agent: 'backend',
          mcpCapabilities: ['github.issues.read'],
        }],
      },
    })
    expect(missingBindings).toMatchObject({
      status: 'blocked',
      blocked: expect.arrayContaining([expect.stringMatching(/persist explicit capabilityBindings/)]),
    })

    const keylessPolicy = evaluateWorkPackageMcpBroker({
      assignedRole: 'backend',
      mcpOverview: overview([healthyGithub]),
      mcpRequirements: [{
        mcpId: 'github',
        requirement: 'required',
        permissions: ['github.issues.read'],
        fallback: { action: 'block', message: '' },
      }],
      metadata: {
        mcpGrantsSchemaVersion: 2,
        promptOverlay: 'This unscoped legacy overlay must not authorize context.',
      },
    })
    expect(keylessPolicy).toMatchObject({
      status: 'blocked',
      blocked: expect.arrayContaining([
        expect.stringMatching(/persist a requirementKey/),
        expect.stringMatching(/explicit agent identity/),
        expect.stringMatching(/scoped by requirement identity/),
      ]),
    })
  })

  it('blocks malformed schema-v2 policy, grant, context, subtask, and error containers', () => {
    const metadata = {
      mcpGrantsSchemaVersion: 2,
      mcpGrants: { requirementKey: 'not-an-array' },
      mcpAwareSubtasks: { id: 'not-an-array' },
      requirementContexts: { requirementKey: 'not-an-array' },
      mcpNormalizationErrors: { error: 'not-an-array' },
    }
    const input = {
      assignedRole: 'backend',
      mcpRequirements: { mcpId: 'github', permissions: ['github.issues.read'] },
      metadata,
      title: 'Backend package',
    }
    expect(hasWorkPackageMcpRuntimeInputs(input)).toBe(true)
    expect(evaluateWorkPackageMcpBroker(input)).toMatchObject({
      status: 'blocked',
      primaryRecoveryAction: 'revise_plan',
      retryable: false,
      blocked: expect.arrayContaining([
        expect.stringMatching(/policies must be stored as an array/),
        expect.stringMatching(/grant envelopes must be stored as an array/),
        expect.stringMatching(/requirement contexts must be stored as an array/),
        expect.stringMatching(/subtasks must be stored as an array/),
        expect.stringMatching(/normalization errors must be stored as an array/),
      ]),
    })
  })

  it('keeps persisted normalization blockers active for approval and handoff adapters', () => {
    const metadata = {
      mcpGrantsSchemaVersion: 2,
      mcpNormalizationErrors: ['MCP requirement 0 is malformed and cannot be normalized.'],
    }
    expect(hasWorkPackageMcpRuntimeInputs({ metadata })).toBe(true)
    expect(evaluateWorkPackageMcpBroker({
      assignedRole: 'backend',
      metadata,
      title: 'Backend package',
    })).toMatchObject({
      status: 'blocked',
      primaryRecoveryAction: 'revise_plan',
      retryable: false,
      blocked: ['MCP requirement 0 is malformed and cannot be normalized.'],
    })
  })

  it('blocks grant-only data as unknown_legacy', () => {
    const broker = evaluateWorkPackageMcpBroker({
      assignedRole: 'backend',
      metadata: { mcpGrants: [{ decisionId: 'stale', mcpId: 'github', capabilities: ['github.issues.read'] }] },
    })
    expect(broker.status).toBe('blocked')
    expect(broker.evaluations[0].decision).toMatchObject({ mode: 'unknown_legacy', recoveryAction: 'revise_plan' })
    expect(broker.retryable).toBe(false)
  })
})
