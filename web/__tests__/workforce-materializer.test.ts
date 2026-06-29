import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
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
      systemPrompt: '',
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
      promptOverlay: 'Use GitHub read tools only.',
      mcpAwareSubtasks: [
        expect.objectContaining({
          id: 'inspect-issue',
          mcpCapabilities: ['github.issues.read'],
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

  it('clamps implementation-role review to both even when the Architect requests less', () => {
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

    // The planning model cannot downgrade review for an implementation package.
    expect(rows.workPackages.find((pkg) => pkg.assignedRole === 'backend')?.reviewRequirement).toBe('both')
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
    expect(rows.harnesses[0].toolPolicy).toMatchObject({
      mcpGrants: [expect.objectContaining({ mcpId: 'github' })],
    })
    expect(rows.workPackages[0].metadata).toMatchObject({
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

  it('updates materializer-owned harness fields when a canonical harness already exists', () => {
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

  it('keeps the materializer feature flag easy to disable', () => {
    expect(isWorkforceMaterializationEnabled({ FORGE_WORKFORCE_MATERIALIZATION: '0' })).toBe(false)
    expect(isWorkforceMaterializationEnabled({ FORGE_WORKFORCE_MATERIALIZATION: 'false' })).toBe(false)
    expect(isWorkforceMaterializationEnabled({ FORGE_WORKFORCE_MATERIALIZATION: '1' })).toBe(true)
    expect(isWorkforceMaterializationEnabled({})).toBe(true)
  })
})
