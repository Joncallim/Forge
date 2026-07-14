import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { prepareArchitectArtifact, type PreparedArchitectArtifact } from '@/worker/architect-artifact'
import {
  buildWorkforceMaterializationRows,
  isWorkforceMaterializationEnabled,
} from '@/worker/workforce-materializer'
import { evaluateWorkPackageMcpBroker } from '@/worker/mcp-execution-design'

const prepared: PreparedArchitectArtifact = {
  planText: '# Plan',
  questions: [],
  agents: [
    {
      role: 'Backend',
      tasks: 1,
      summary: 'Implement APIs',
      steps: ['Add database tables'],
    },
    {
      role: 'QA',
      tasks: 1,
      summary: 'Verify behavior',
      steps: ['Add regression tests'],
    },
    {
      role: 'Reviewer',
      tasks: 1,
      summary: 'Review implementation',
      steps: ['Audit the pull request'],
    },
    {
      role: 'Architect',
      tasks: 1,
      summary: 'Already completed',
      steps: ['Write the plan'],
    },
  ],
  agentBreakdownSource: 'fence',
  capabilityClassification: {
    proposed: {
      schemaVersion: 1,
      required: ['database-migration', 'business-logic'],
      optional: ['unit-testing'],
      excluded: [],
    },
    validation: {
      status: 'valid',
      warnings: [],
    },
  },
  mcpExecutionDesign: {
    proposed: {
      schemaVersion: 1,
      requirements: [
        {
          requirementKey: 'mcp-requirement-v1-test-1',
          sourceRequirementIndex: 0,
          mcpId: 'github',
          requirement: 'required',
          reason: 'Read issue context.',
          assignment: {
            type: 'agent',
            targetAgents: ['backend'],
            targetId: null,
          },
          agentPermissions: {
            backend: ['github.issues.read'],
          },
          prohibitedCapabilities: ['github.pull_requests.merge'],
          fallback: {
            action: 'ask_user',
            message: 'Connect GitHub.',
          },
        },
      ],
      promptOverlays: {
        backend: 'Use GitHub read tools only.',
      },
      requirementContexts: [{
        requirementKey: 'mcp-requirement-v1-test-1',
        sourceRequirementIndex: 0,
        agent: 'backend',
        mcpId: 'github',
        promptOverlay: 'Use GitHub read tools only.',
      }],
      mcpAwareSubtasks: [
        {
          id: 'inspect-issue',
          agent: 'backend',
          dependsOn: [],
          mcpCapabilities: ['github.issues.read'],
          capabilityBindings: [{ capability: 'github.issues.read', requirementKey: 'mcp-requirement-v1-test-1' }],
          inputs: ['Task prompt'],
          outputs: ['Issue notes'],
          verification: ['Issue context captured'],
          stoppingCondition: 'Repository context is clear.',
          fallback: 'Ask the user.',
        },
      ],
    },
    validation: {
      status: 'valid',
      runtimeEnforcement: 'not_implemented',
      health: [],
      blocked: [],
      warnings: [],
    },
    grantDecisions: {
      schemaVersion: 1,
      runtimeEnforcement: 'not_implemented',
      summary: { proposed: 1, warning: 0, blocked: 0 },
      decisions: [
        {
          requirementKey: 'mcp-requirement-v1-test-1',
          decisionId: 'grant-1',
          sourceRequirementIndex: 0,
          agent: 'backend',
          mcpId: 'github',
          capabilities: ['github.issues.read'],
          requirement: 'required',
          status: 'proposed',
          reason: 'Read issue context.',
          assignment: {
            type: 'agent',
            targetId: null,
          },
          fallback: {
            action: 'ask_user',
            message: 'Connect GitHub.',
          },
          health: {
            schemaVersion: 1,
            observed: true,
            mcpId: 'github',
            installState: 'installed',
            status: 'healthy',
            enabled: true,
            error: null,
            checkedAt: '2026-07-14T00:00:00.000Z',
          },
          promptOverlayPresent: true,
          admissionStatus: 'allowed',
          mode: 'planning_only',
          grantState: { phase: 'not_issued' },
          normalizedCapabilities: ['github.issues.read'],
          capabilityClasses: [{ capability: 'github.issues.read', class: 'bounded_read_only', deliveryKind: 'planning_context_only' }],
          evidenceRefs: [],
        },
      ],
    },
  },
}

function deterministicIds(): () => string {
  let next = 0
  return () => `00000000-0000-4000-8000-${String(++next).padStart(12, '0')}`
}

describe('workforce materializer', () => {
  it('persists invalid-design normalization blockers for package admission', () => {
    const invalidPrepared = structuredClone(prepared)
    invalidPrepared.agents = [{ role: 'Backend', tasks: 1, summary: 'APIs', steps: ['Add tables'] }]
    invalidPrepared.mcpExecutionDesign.proposed = {
      schemaVersion: 1,
      requirements: [],
      promptOverlays: {},
      requirementContexts: [],
      mcpAwareSubtasks: [],
      normalizationErrors: ['The supplied MCP execution design fence is invalid and must be regenerated.'],
      normalizationEvidence: [{
        schemaVersion: 1,
        category: 'shape',
        code: 'mcp_design_schema_shape_invalid',
        message: 'The supplied MCP execution design fence is invalid and must be regenerated.',
      }],
    }
    invalidPrepared.mcpExecutionDesign.validation = {
      status: 'blocked', runtimeEnforcement: 'not_implemented', health: [],
      blocked: ['The supplied MCP execution design fence is invalid and must be regenerated.'], warnings: [],
    }
    invalidPrepared.mcpExecutionDesign.grantDecisions = {
      schemaVersion: 1, runtimeEnforcement: 'not_implemented', summary: { proposed: 0, warning: 0, blocked: 0 },
      decisions: [], admissionStatus: 'blocked',
      blocked: ['The supplied MCP execution design fence is invalid and must be regenerated.'],
    }

    const rows = buildWorkforceMaterializationRows(
      { taskId: 'task-1', architectRunId: 'run-1', artifactId: 'artifact-1', prepared: invalidPrepared },
      { idFactory: deterministicIds(), activeAgents: [{ agentType: 'backend', displayName: 'Backend' }] },
    )
    const pkg = rows.workPackages[0]
    expect(pkg.metadata).toMatchObject({
      mcpGrantsSchemaVersion: 2,
      mcpNormalizationErrors: ['The supplied MCP execution design fence is invalid and must be regenerated.'],
      mcpNormalizationEvidence: [expect.objectContaining({
        schemaVersion: 1,
        category: 'shape',
        code: 'mcp_design_schema_shape_invalid',
      })],
    })
    expect(evaluateWorkPackageMcpBroker({
      assignedRole: pkg.assignedRole,
      mcpRequirements: pkg.mcpRequirements,
      metadata: pkg.metadata,
      title: pkg.title,
    })).toMatchObject({ status: 'blocked', retryable: false, primaryRecoveryAction: 'revise_plan' })

    const metadataWithEvidenceOnly = {
      ...(pkg.metadata as Record<string, unknown>),
      mcpNormalizationErrors: [],
    }
    expect(evaluateWorkPackageMcpBroker({
      assignedRole: pkg.assignedRole,
      mcpRequirements: pkg.mcpRequirements,
      metadata: metadataWithEvidenceOnly,
      title: pkg.title,
    })).toMatchObject({
      status: 'blocked',
      blocked: [expect.stringContaining('mcp_design_schema_shape_invalid')],
      primaryRecoveryAction: 'revise_plan',
    })
  })

  it('attaches MCP grants/requirements when the design spells the agent with a different separator', () => {
    // Canonical agentType is `backend-dev`; the MCP execution design spells the
    // same agent `backend_dev`. Matching must be separator-insensitive, or the
    // package's MCP requirements/grants are dropped and the broker is bypassed.
    const separatorPrepared = structuredClone(prepared)
    separatorPrepared.agents = [{ role: 'backend-dev', tasks: 1, summary: 'APIs', steps: ['Add tables'] }]
    const design = separatorPrepared.mcpExecutionDesign.proposed!
    design.requirements[0].assignment.targetAgents = ['backend_dev']
    design.requirements[0].agentPermissions = { backend_dev: ['github.issues.read'] }
    design.requirementContexts = [{
      requirementKey: design.requirements[0].requirementKey as string,
      sourceRequirementIndex: 0,
      agent: 'backend_dev',
      mcpId: 'github',
      promptOverlay: 'Use GitHub read tools only.',
    }]
    design.mcpAwareSubtasks[0].agent = 'backend_dev'
    separatorPrepared.mcpExecutionDesign.grantDecisions.decisions[0].agent = 'backend_dev'

    const rows = buildWorkforceMaterializationRows(
      { taskId: 'task-1', architectRunId: 'run-1', artifactId: 'artifact-1', prepared: separatorPrepared },
      { idFactory: deterministicIds(), activeAgents: [{ agentType: 'backend-dev', displayName: 'Backend Dev' }] },
    )

    const pkg = rows.workPackages.find((p) => p.assignedRole === 'backend-dev')
    expect(pkg).toBeDefined()
    expect(pkg!.metadata).toMatchObject({
      mcpGrants: [expect.objectContaining({ decisionId: 'grant-1', mcpId: 'github', agent: 'backend-dev' })],
      requirementContexts: [expect.objectContaining({ agent: 'backend-dev' })],
      mcpAwareSubtasks: [expect.objectContaining({ agent: 'backend-dev' })],
    })
    expect(pkg!.mcpRequirements).toEqual([expect.objectContaining({ mcpId: 'github', agent: 'backend-dev' })])
    expect(evaluateWorkPackageMcpBroker({
      assignedRole: pkg!.assignedRole,
      mcpRequirements: pkg!.mcpRequirements,
      metadata: pkg!.metadata,
      title: pkg!.title,
    }).status).toBe('allowed')
  })

  it('materializes separator aliases into one deny-wins package policy', () => {
    const separatorPrepared = structuredClone(prepared)
    separatorPrepared.agents = [{ role: 'backend-dev', tasks: 1, summary: 'APIs', steps: ['Add tables'] }]
    const first = separatorPrepared.mcpExecutionDesign.proposed!.requirements[0]
    first.assignment.targetAgents = ['backend_dev']
    first.agentPermissions = { backend_dev: ['github.issues.read'] }
    first.prohibitedCapabilities = []
    separatorPrepared.mcpExecutionDesign.proposed!.requirements.push({
      ...structuredClone(first),
      requirementKey: 'mcp-requirement-v1-separator-deny-1',
      sourceRequirementIndex: 1,
      assignment: { ...first.assignment, targetAgents: ['backend-dev'] },
      agentPermissions: {},
      prohibitedCapabilities: ['github.issues.read'],
    })

    const rows = buildWorkforceMaterializationRows(
      { taskId: 'task-1', architectRunId: 'run-1', artifactId: 'artifact-1', prepared: separatorPrepared },
      { idFactory: deterministicIds(), activeAgents: [{ agentType: 'backend-dev', displayName: 'Backend Dev' }] },
    )
    const pkg = rows.workPackages[0]

    expect(pkg.mcpRequirements).toHaveLength(2)
    expect(evaluateWorkPackageMcpBroker({
      assignedRole: pkg.assignedRole,
      mcpRequirements: pkg.mcpRequirements,
      metadata: pkg.metadata,
      title: pkg.title,
    })).toMatchObject({
      status: 'blocked',
      primaryMode: 'blocked',
      primaryRecoveryAction: 'revise_plan',
      blocked: expect.arrayContaining([expect.stringContaining('package-prohibited')]),
    })
  })

  it('keeps genuinely distinct materialized package roles independently partitioned', () => {
    const distinctPrepared = structuredClone(prepared)
    distinctPrepared.agents = [
      { role: 'Backend', tasks: 1, summary: 'Backend APIs', steps: ['Implement APIs'] },
      { role: 'Frontend', tasks: 1, summary: 'Frontend UI', steps: ['Implement UI'] },
    ]
    const first = distinctPrepared.mcpExecutionDesign.proposed!.requirements[0]
    first.assignment.targetAgents = ['backend']
    first.agentPermissions = { backend: ['github.issues.read'] }
    first.prohibitedCapabilities = []
    distinctPrepared.mcpExecutionDesign.proposed!.requirements.push({
      ...structuredClone(first),
      requirementKey: 'mcp-requirement-v1-frontend-read-1',
      sourceRequirementIndex: 1,
      assignment: { ...first.assignment, targetAgents: ['frontend'] },
      agentPermissions: { frontend: ['github.issues.read'] },
      prohibitedCapabilities: [],
    }, {
      ...structuredClone(first),
      requirementKey: 'mcp-requirement-v1-frontend-deny-1',
      sourceRequirementIndex: 2,
      assignment: { ...first.assignment, targetAgents: ['frontend'] },
      agentPermissions: {},
      prohibitedCapabilities: ['github.issues.read'],
    })

    const rows = buildWorkforceMaterializationRows(
      { taskId: 'task-1', architectRunId: 'run-1', artifactId: 'artifact-1', prepared: distinctPrepared },
      {
        idFactory: deterministicIds(),
        activeAgents: [
          { agentType: 'backend', displayName: 'Backend' },
          { agentType: 'frontend', displayName: 'Frontend' },
        ],
      },
    )
    const backend = rows.workPackages.find((pkg) => pkg.assignedRole === 'backend')!
    const frontend = rows.workPackages.find((pkg) => pkg.assignedRole === 'frontend')!

    expect(backend.mcpRequirements).toHaveLength(1)
    expect(frontend.mcpRequirements).toHaveLength(2)
    expect(evaluateWorkPackageMcpBroker({
      assignedRole: backend.assignedRole,
      mcpRequirements: backend.mcpRequirements,
      metadata: backend.metadata,
      title: backend.title,
    }).status).toBe('allowed')
    expect(evaluateWorkPackageMcpBroker({
      assignedRole: frontend.assignedRole,
      mcpRequirements: frontend.mcpRequirements,
      metadata: frontend.metadata,
      title: frontend.title,
    })).toMatchObject({
      status: 'blocked',
      primaryMode: 'blocked',
      primaryRecoveryAction: 'revise_plan',
    })
  })

  it('omits an overflowing unsafe subtask through artifact preparation and materialization', () => {
    const raw = [
      '# Plan',
      '- [Backend] Implement the package safely.',
      '```mcp_execution_design_json',
      JSON.stringify({
        schemaVersion: 1,
        requirements: [{
          mcpId: 'github',
          requirement: 'required',
          reason: 'Read issue context.',
          assignment: { type: 'agent', targetAgents: ['backend'], targetId: null },
          agentPermissions: { backend: ['github.issues.read'] },
          prohibitedCapabilities: [],
          fallback: { action: 'block', message: 'Revise the plan.' },
        }],
        promptOverlays: {},
        requirementContexts: [],
        mcpAwareSubtasks: [{
          id: 'inspect',
          agent: 'backend',
          dependsOn: [],
          mcpCapabilities: [...Array(30).fill('github.issues.read'), 'github.contents.write'],
          inputs: [],
          outputs: [],
          verification: [],
          stoppingCondition: 'Done.',
          fallback: 'Revise the plan.',
        }],
      }),
      '```',
    ].join('\n')
    const artifact = prepareArchitectArtifact(raw, {
      projectId: 'project-1',
      config: { profile: 'default', requiredMcps: [], overrides: {} },
      catalog: [],
      mcpsRoot: '/tmp/mcps',
      statuses: [],
      summary: { label: 'Unavailable', status: 'missing', missing: 0, authRequired: 0, unhealthy: 0, disabled: 0 },
    })
    expect(artifact.mcpExecutionDesign.proposed?.mcpAwareSubtasks).toEqual([])
    expect(artifact.mcpExecutionDesign.proposed?.normalizationErrors).toEqual(expect.arrayContaining([
      expect.stringMatching(/mcpCapabilities exceeds the maximum raw count of 30/),
    ]))

    const rows = buildWorkforceMaterializationRows(
      { taskId: 'task-1', architectRunId: 'run-1', artifactId: 'artifact-1', prepared: artifact },
      { idFactory: deterministicIds(), activeAgents: [{ agentType: 'backend', displayName: 'Backend' }] },
    )
    const pkg = rows.workPackages[0]
    expect(pkg.metadata).toMatchObject({
      mcpAwareSubtasks: [],
      mcpNormalizationEvidence: [expect.objectContaining({ code: 'mcp_design_nested_policy_invalid' })],
    })
    expect((pkg.metadata as { mcpNormalizationErrors: string[] }).mcpNormalizationErrors).toEqual(expect.arrayContaining([
      expect.stringMatching(/mcpCapabilities exceeds the maximum raw count of 30/),
    ]))
    expect(evaluateWorkPackageMcpBroker({
      assignedRole: pkg.assignedRole,
      mcpRequirements: pkg.mcpRequirements,
      metadata: pkg.metadata,
      title: pkg.title,
    })).toMatchObject({ status: 'blocked', retryable: false, primaryRecoveryAction: 'revise_plan' })
  })

  it('inherits project-level filesystem approval for new packages', () => {
    const filesystemPrepared = structuredClone(prepared)
    const design = filesystemPrepared.mcpExecutionDesign.proposed!
    design.requirements = [{
      mcpId: 'filesystem',
      requirement: 'required',
      reason: 'Read project files.',
      assignment: { type: 'agent', targetAgents: ['backend'], targetId: null },
      agentPermissions: { backend: ['filesystem.project.read', 'filesystem.project.search'] },
      prohibitedCapabilities: ['filesystem.project.write'],
      fallback: { action: 'ask_user', message: 'Approve filesystem context.' },
    }]
    design.mcpAwareSubtasks = [{
      id: 'inspect-project',
      agent: 'backend',
      dependsOn: [],
      mcpCapabilities: ['filesystem.project.search'],
      inputs: ['Project files'],
      outputs: ['File map'],
      verification: ['Project inspected'],
      stoppingCondition: 'Context captured.',
      fallback: '',
    }]

    const rows = buildWorkforceMaterializationRows(
      { taskId: 'task-1', architectRunId: 'run-1', artifactId: 'artifact-1', prepared: filesystemPrepared },
      {
        idFactory: deterministicIds(),
        projectMcpConfig: {
          grants: {
            filesystem: {
              schemaVersion: 1,
              mcpId: 'filesystem',
              status: 'approved',
              grantMode: 'always_allow',
              capabilities: ['filesystem.project.read', 'filesystem.project.search'],
              grantApprovalId: 'grant-approval-1',
              approvedAt: '2026-07-05T00:00:00.000Z',
              approvedBy: 'user-1',
              reason: 'Trusted project.',
            },
          },
        },
      },
    )

    expect(rows.workPackages[0].metadata).toMatchObject({
      mcpGrantPhases: {
        effective: {
          source: 'project-filesystem-approval',
          grantMode: 'always_allow',
          grantApprovalId: 'grant-approval-1',
          scope: 'project',
          status: 'approved',
          grants: [expect.objectContaining({
            grantApprovalId: 'grant-approval-1',
            capabilities: ['filesystem.project.read', 'filesystem.project.search'],
          })],
        },
      },
    })
  })

  it('builds pending harnesses, work packages, dependencies, and a plan approval gate', () => {
    const rows = buildWorkforceMaterializationRows(
      {
        taskId: 'task-1',
        architectRunId: 'run-1',
        artifactId: 'artifact-1',
        prepared,
      },
      { idFactory: deterministicIds() },
    )

    expect(rows.harnesses).toHaveLength(3)
    expect(rows.workPackages).toHaveLength(3)
    expect(rows.workPackages.map((pkg) => pkg.assignedRole)).toEqual(['backend', 'qa', 'reviewer'])
    expect(rows.workPackages.every((pkg) => pkg.status === 'pending')).toBe(true)
    expect(rows.harnesses.map((harness) => harness.slug)).toEqual(['backend', 'qa', 'reviewer'])
    expect(rows.harnesses[0]).toMatchObject({
      slug: 'backend',
      role: 'backend',
      systemPrompt: '',
      toolPolicy: {},
    })
    expect(rows.workPackages[0].metadata).toMatchObject({
      harnessSemantics: expect.objectContaining({
        runtimePolicyApplied: false,
        status: 'planning_only',
      }),
      mcpGrants: [
        expect.objectContaining({
          requirementKey: 'mcp-requirement-v1-test-1',
          decisionId: 'grant-1',
          mcpId: 'github',
          mode: 'planning_only',
          grantState: { phase: 'not_issued' },
          status: 'proposed',
        }),
      ],
      mcpGrantPhases: expect.objectContaining({
        approved: null,
        broker: expect.objectContaining({
          runtimeEnforcement: 'not_implemented',
          validationStatus: 'valid',
        }),
        effective: expect.objectContaining({
          runtimeIssued: false,
          status: 'not_issued',
        }),
      }),
      source: 'architect-artifact',
      promptOverlay: 'Use GitHub read tools only.',
      requirementContexts: [expect.objectContaining({ requirementKey: 'mcp-requirement-v1-test-1', agent: 'backend' })],
      mcpAwareSubtasks: [
        expect.objectContaining({
          id: 'inspect-issue',
          agent: 'backend',
          mcpCapabilities: ['github.issues.read'],
          capabilityBindings: [{ capability: 'github.issues.read', requirementKey: 'mcp-requirement-v1-test-1' }],
        }),
      ],
    })
    expect(rows.workPackages[0].requiredCapabilities).toEqual({
      schemaVersion: 1,
      required: ['database-migration', 'business-logic'],
      optional: ['unit-testing'],
      excluded: [],
    })
    expect(rows.dependencies).toEqual([
      expect.objectContaining({
        workPackageId: rows.workPackages[1].id,
        dependsOnWorkPackageId: rows.workPackages[0].id,
      }),
      expect.objectContaining({
        workPackageId: rows.workPackages[2].id,
        dependsOnWorkPackageId: rows.workPackages[1].id,
      }),
    ])
    expect(rows.workPackages.map((pkg) => pkg.reviewRequirement)).toEqual(['both', 'none', 'none'])

    expect(rows.approvalGate).toMatchObject({
      taskId: 'task-1',
      gateType: 'plan_approval',
      status: 'pending',
      sourceAgentRunId: 'run-1',
      sourceArtifactId: 'artifact-1',
    })
  })

  it('does not materialize an unscoped legacy prompt overlay after context normalization rejects it', () => {
    const firstRequirement = prepared.mcpExecutionDesign.proposed!.requirements[0]
    const rows = buildWorkforceMaterializationRows(
      {
        taskId: 'task-1',
        architectRunId: 'run-1',
        artifactId: 'artifact-1',
        prepared: {
          ...prepared,
          mcpExecutionDesign: {
            ...prepared.mcpExecutionDesign,
            proposed: {
              ...prepared.mcpExecutionDesign.proposed!,
              requirements: [
                firstRequirement,
                {
                  ...firstRequirement,
                  requirementKey: 'mcp-requirement-v1-test-2',
                  sourceRequirementIndex: 1,
                },
              ],
              requirementContexts: [],
              promptOverlays: { backend: 'This ambiguous overlay must not reach a worker.' },
              mcpAwareSubtasks: [],
              normalizationErrors: ['Legacy MCP prompt overlay is ambiguous.'],
            },
            validation: {
              ...prepared.mcpExecutionDesign.validation,
              status: 'blocked',
              blocked: ['Legacy MCP prompt overlay is ambiguous.'],
            },
          },
        },
      },
      { idFactory: deterministicIds() },
    )

    expect(rows.workPackages[0].metadata).toMatchObject({
      mcpNormalizationErrors: ['Legacy MCP prompt overlay is ambiguous.'],
      promptOverlay: null,
      requirementContexts: [],
    })
  })

  it('materializes reviewer-only raw policy and derived envelope with the same identity', () => {
    const reviewerPrepared = structuredClone(prepared)
    reviewerPrepared.agents = [{
      role: 'Reviewer',
      tasks: 1,
      summary: 'Review the plan',
      steps: ['Inspect the supplied issue context'],
    }]
    const requirementKey = 'mcp-requirement-v1-reviewer-1'
    reviewerPrepared.mcpExecutionDesign.proposed = {
      schemaVersion: 1,
      requirements: [{
        requirementKey,
        sourceRequirementIndex: 0,
        mcpId: 'github',
        requirement: 'required',
        reason: 'Read issue context.',
        assignment: { type: 'reviewer_only', targetAgents: [], targetId: null },
        agentPermissions: {},
        prohibitedCapabilities: [],
        fallback: { action: 'ask_user', message: 'Ask for context.' },
      }],
      promptOverlays: { reviewer: 'Use the supplied issue context.' },
      requirementContexts: [{
        requirementKey,
        sourceRequirementIndex: 0,
        agent: 'reviewer',
        mcpId: 'github',
        promptOverlay: 'Use the supplied issue context.',
      }],
      mcpAwareSubtasks: [],
      normalizationErrors: [],
    }
    reviewerPrepared.mcpExecutionDesign.grantDecisions.decisions = [{
      ...reviewerPrepared.mcpExecutionDesign.grantDecisions.decisions[0],
      requirementKey,
      decisionId: 'grant-reviewer-1',
      agent: 'reviewer',
      capabilities: [],
      normalizedCapabilities: [],
      capabilityClasses: [],
      assignment: { type: 'reviewer_only', targetId: null },
    }]
    const rows = buildWorkforceMaterializationRows(
      {
        taskId: 'task-1',
        architectRunId: 'run-1',
        artifactId: 'artifact-1',
        prepared: reviewerPrepared,
      },
      {
        activeAgents: [{ agentType: 'reviewer', displayName: 'Reviewer' }],
        idFactory: deterministicIds(),
      },
    )

    expect(rows.workPackages).toHaveLength(1)
    expect(rows.workPackages[0].mcpRequirements).toEqual([
      expect.objectContaining({ requirementKey, agent: 'reviewer' }),
    ])
    expect(rows.workPackages[0].metadata).toMatchObject({
      mcpGrants: [expect.objectContaining({ requirementKey, agent: 'reviewer' })],
    })
    const broker = evaluateWorkPackageMcpBroker({
      assignedRole: 'reviewer',
      mcpOverview: {
        projectId: 'project-1',
        config: { profile: 'default', requiredMcps: ['github'], overrides: {} },
        catalog: [],
        mcpsRoot: '/tmp/mcps',
        statuses: [{
          mcpId: 'github', displayName: 'GitHub', description: '', installPath: '/tmp/mcps/github',
          installState: 'installed', status: 'healthy', enabled: true, error: null,
          checkedAt: '2026-07-14T00:00:00.000Z',
        }],
        summary: { label: 'Healthy', status: 'healthy', missing: 0, authRequired: 0, unhealthy: 0, disabled: 0 },
      },
      mcpRequirements: rows.workPackages[0].mcpRequirements,
      metadata: rows.workPackages[0].metadata,
      title: rows.workPackages[0].title,
    })
    expect(broker.evaluations).toHaveLength(1)
    expect(broker.evaluations[0].decision.mode).not.toBe('unknown_legacy')
  })

  it('keeps manual review gates even when executable QA and Reviewer packages exist', () => {
    const rows = buildWorkforceMaterializationRows(
      {
        taskId: 'task-1',
        architectRunId: 'run-1',
        artifactId: 'artifact-1',
        prepared: {
          ...prepared,
          agents: prepared.agents.map((agent) =>
            agent.role === 'Backend' ? { ...agent, reviewRequirement: 'none' as const } : agent,
          ),
        },
      },
      { idFactory: deterministicIds() },
    )

    expect(rows.workPackages.find((pkg) => pkg.assignedRole === 'backend')?.reviewRequirement).toBe('both')
  })

  it('clamps implementation-role review to both when no executable review package exists', () => {
    const rows = buildWorkforceMaterializationRows(
      {
        taskId: 'task-1',
        architectRunId: 'run-1',
        artifactId: 'artifact-1',
        prepared: {
          ...prepared,
          agents: [
            {
              role: 'Backend',
              tasks: 1,
              summary: 'Implement APIs',
              steps: ['Add database tables'],
              reviewRequirement: 'none',
            },
          ],
        },
      },
      { idFactory: deterministicIds() },
    )

    expect(rows.workPackages).toHaveLength(1)
    expect(rows.workPackages[0].assignedRole).toBe('backend')
    expect(rows.workPackages[0].reviewRequirement).toBe('both')
  })

  it('materializes QA and Reviewer packages but keeps Architect gate roles non-executable', () => {
    const rows = buildWorkforceMaterializationRows(
      {
        taskId: 'task-1',
        architectRunId: 'run-1',
        artifactId: 'artifact-1',
        prepared: {
          ...prepared,
          agents: [
            {
              role: 'Reviewer',
              tasks: 1,
              summary: 'Implement auth/session changes',
              steps: ['Change the session middleware'],
            },
            {
              role: 'QA',
              tasks: 1,
              summary: 'Patch production code before testing',
              steps: ['Edit the API route'],
            },
            {
              role: 'Security',
              tasks: 1,
              summary: 'Change token storage',
              steps: ['Modify credential handling'],
            },
          ],
        },
      },
      {
        activeAgents: [
          { agentType: 'reviewer', displayName: 'Reviewer' },
          { agentType: 'qa', displayName: 'QA' },
          { agentType: 'security', displayName: 'Security' },
        ],
        idFactory: deterministicIds(),
      },
    )

    expect(rows.harnesses.map((harness) => harness.slug)).toEqual(['reviewer', 'qa'])
    expect(rows.workPackages.map((pkg) => pkg.assignedRole)).toEqual(['reviewer', 'qa'])
    expect(rows.workPackages.map((pkg) => pkg.reviewRequirement)).toEqual(['none', 'none'])
    expect(rows.dependencies).toEqual([
      expect.objectContaining({
        workPackageId: rows.workPackages[0].id,
        dependsOnWorkPackageId: rows.workPackages[1].id,
      }),
    ])
  })

  it('resolves Architect display-name roles to active canonical agent slugs', () => {
    const rows = buildWorkforceMaterializationRows(
      {
        taskId: 'task-1',
        architectRunId: 'run-1',
        artifactId: 'artifact-1',
        prepared: {
          ...prepared,
          agents: [
            {
              role: 'Server Team',
              tasks: 1,
              summary: 'Implement APIs',
              steps: ['Add database tables'],
            },
          ],
          mcpExecutionDesign: {
            ...prepared.mcpExecutionDesign,
            proposed: {
              ...prepared.mcpExecutionDesign.proposed!,
              promptOverlays: {
                'Server Team': 'Use GitHub read tools only.',
              },
              requirements: [
                {
                  ...prepared.mcpExecutionDesign.proposed!.requirements[0],
                  assignment: {
                    type: 'agent',
                    targetAgents: ['Server Team'],
                    targetId: null,
                  },
                  agentPermissions: {
                    'Server Team': ['github.issues.read'],
                  },
                },
              ],
              mcpAwareSubtasks: [
                {
                  ...prepared.mcpExecutionDesign.proposed!.mcpAwareSubtasks[0],
                  agent: 'Server Team',
                },
              ],
            },
            grantDecisions: {
              ...prepared.mcpExecutionDesign.grantDecisions,
              decisions: [
                {
                  ...prepared.mcpExecutionDesign.grantDecisions.decisions[0],
                  agent: 'Server Team',
                },
              ],
            },
          },
        },
      },
      {
        activeAgents: [
          { agentType: 'backend', displayName: 'Server Team' },
          { agentType: 'qa', displayName: 'QA' },
        ],
        idFactory: deterministicIds(),
      },
    )

    expect(rows.workPackages).toHaveLength(1)
    expect(rows.workPackages[0].assignedRole).toBe('backend')
    expect(rows.harnesses[0].slug).toBe('backend')
    expect(rows.harnesses[0].toolPolicy).toEqual({})
    expect(rows.workPackages[0].metadata).toMatchObject({
      mcpGrants: [expect.objectContaining({ mcpId: 'github' })],
      promptOverlay: 'Use GitHub read tools only.',
      mcpAwareSubtasks: [expect.objectContaining({ id: 'inspect-issue' })],
    })
    expect(rows.workPackages[0].mcpRequirements).toEqual([
      expect.objectContaining({
        mcpId: 'github',
        permissions: ['github.issues.read'],
      }),
    ])
  })

  it('keeps unknown Architect roles visible as blocked packages', () => {
    const rows = buildWorkforceMaterializationRows(
      {
        taskId: 'task-1',
        architectRunId: 'run-1',
        artifactId: 'artifact-1',
        prepared: {
          ...prepared,
          agents: [
            {
              role: 'New Specialist',
              tasks: 1,
              summary: 'Do specialized work',
              steps: ['Investigate the edge case'],
            },
          ],
        },
      },
      {
        activeAgents: [{ agentType: 'backend', displayName: 'Backend' }],
        idFactory: deterministicIds(),
      },
    )

    expect(rows.harnesses).toHaveLength(0)
    expect(rows.workPackages).toEqual([
      expect.objectContaining({
        assignedRole: 'new-specialist',
        blockedReason: expect.stringMatching(/no active configured agent/i),
        status: 'failed',
        metadata: expect.objectContaining({
          requiresAgentConfiguration: true,
          unresolvedAgentRole: 'New Specialist',
        }),
      }),
    ])
  })

  it('updates materializer-owned harness fields and clears stale harness tool policy when a canonical harness already exists', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'worker', 'workforce-materializer.ts'),
      'utf8',
    )

    expect(source).toContain('.onConflictDoUpdate({')
    expect(source).toContain('target: agentHarnesses.slug')
    expect(source).toContain('toolPolicy: sql`excluded.tool_policy`')
    expect(source).toContain('metadata: sql`excluded.metadata`')
  })

  it('clears stale unresolved-role packages when a plan is materialized again', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'worker', 'workforce-materializer.ts'),
      'utf8',
    )

    expect(source).toContain("metadata}->>'requiresAgentConfiguration' = 'true'")
    expect(source).toContain("eq(workPackages.status, 'failed')")
  })

  it('fails materialization instead of approving a plan with no executable packages', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'worker', 'workforce-materializer.ts'),
      'utf8',
    )

    expect(source).toContain('Architect plan did not produce any executable work packages')
    expect(source).toContain('Architect and Security are planning/review gates')
  })

  it('keeps the materializer feature flag easy to disable', () => {
    expect(isWorkforceMaterializationEnabled({ FORGE_WORKFORCE_MATERIALIZATION: '0' })).toBe(false)
    expect(isWorkforceMaterializationEnabled({ FORGE_WORKFORCE_MATERIALIZATION: 'false' })).toBe(false)
    expect(isWorkforceMaterializationEnabled({ FORGE_WORKFORCE_MATERIALIZATION: '1' })).toBe(true)
    expect(isWorkforceMaterializationEnabled({})).toBe(true)
  })
})
