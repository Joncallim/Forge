import { describe, expect, it } from 'vitest'
import type { PreparedArchitectArtifact } from '@/worker/architect-artifact'
import {
  buildWorkforceMaterializationRows,
  isWorkforceMaterializationEnabled,
} from '@/worker/workforce-materializer'

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
      mcpAwareSubtasks: [
        {
          id: 'inspect-issue',
          agent: 'backend',
          dependsOn: [],
          mcpCapabilities: ['github.issues.read'],
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
            installState: 'installed',
            status: 'healthy',
            enabled: true,
            error: null,
          },
          promptOverlayPresent: true,
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
    expect(rows.harnesses[0]).toMatchObject({
      slug: 'backend',
      role: 'backend',
      systemPrompt: 'Use GitHub read tools only.',
      toolPolicy: {
        mcpGrants: [
          expect.objectContaining({
            decisionId: 'grant-1',
            mcpId: 'github',
            status: 'proposed',
          }),
        ],
      },
    })
    expect(rows.workPackages[0].metadata).toMatchObject({
      source: 'architect-artifact',
      mcpAwareSubtasks: [
        expect.objectContaining({
          id: 'inspect-issue',
          mcpCapabilities: ['github.issues.read'],
        }),
      ],
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
    expect(rows.approvalGate).toMatchObject({
      taskId: 'task-1',
      gateType: 'plan_approval',
      status: 'pending',
      sourceAgentRunId: 'run-1',
      sourceArtifactId: 'artifact-1',
    })
  })

  it('keeps the materializer feature flag easy to disable', () => {
    expect(isWorkforceMaterializationEnabled({ FORGE_WORKFORCE_MATERIALIZATION: '0' })).toBe(false)
    expect(isWorkforceMaterializationEnabled({ FORGE_WORKFORCE_MATERIALIZATION: 'false' })).toBe(false)
    expect(isWorkforceMaterializationEnabled({ FORGE_WORKFORCE_MATERIALIZATION: '1' })).toBe(true)
    expect(isWorkforceMaterializationEnabled({})).toBe(true)
  })
})
