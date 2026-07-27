import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({ default: {} }))

import { initialMcpReviewItems } from '@/app/dashboard/tasks/[id]/page'
import type { McpExecutionDesignMetadata } from '@/lib/mcps/execution-design-metadata'
import type { McpPlanReviewDisplayRecord } from '@/lib/mcps/plan-review-metadata'

// The approve route rejects an MCP-bearing plan until a valid operator review
// exists, so this is the payload that decides whether such a task can be
// approved at all. It is derived here rather than in the save handler, so these
// cases pin the exact review the task page would submit.

type ProposedDesign = NonNullable<McpExecutionDesignMetadata['proposed']>

function design(overrides: Partial<ProposedDesign> = {}): McpExecutionDesignMetadata {
  return {
    proposed: {
      requirements: [{
        requirementKey: 'requirement-filesystem-0',
        sourceRequirementIndex: 0,
        mcpId: 'filesystem',
        requirement: 'required',
        reason: 'Read project files.',
        confidence: 'high',
        scope: { kind: 'project' },
        accessMode: 'planning_instruction',
        assignment: { type: 'agent', targetAgents: ['backend'], targetId: null },
        agentPermissions: { backend: ['filesystem.project.read', 'filesystem.project.search'] },
        prohibitedCapabilities: ['filesystem.project.write'],
        fallback: { action: 'ask_user', message: 'Ask the operator.' },
      }],
      promptOverlays: { backend: 'Read only what the package needs.' },
      requirementContexts: [{
        requirementKey: 'requirement-filesystem-0',
        sourceRequirementIndex: 0,
        agent: 'backend',
        mcpId: 'filesystem',
        promptOverlay: 'Read only what the package needs.',
      }],
      mcpAwareSubtasks: [],
      ...overrides,
    },
    validation: {
      status: 'valid',
      runtimeEnforcement: 'not_implemented',
      blocked: [],
      warnings: [],
      health: [],
    },
    grantDecisions: null,
  }
}

describe('MCP operator review draft', () => {
  it('derives one reviewable item per proposed requirement', () => {
    const items = initialMcpReviewItems(design(), null)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      requirementKey: 'requirement-filesystem-0',
      decision: 'approved',
      assignment: { type: 'agent', targetAgents: ['backend'], targetId: null },
      agentPermissions: { backend: ['filesystem.project.read', 'filesystem.project.search'] },
      promptOverlays: { backend: 'Read only what the package needs.' },
    })
  })

  it('carries no requirement when the plan proposes no MCP access', () => {
    expect(initialMcpReviewItems(null, null)).toEqual([])
    expect(initialMcpReviewItems({
      proposed: null,
      validation: { status: 'valid', runtimeEnforcement: 'not_implemented', blocked: [], warnings: [], health: [] },
      grantDecisions: null,
    }, null)).toEqual([])
  })

  it('resumes an existing review rather than re-proposing the Architect defaults', () => {
    const existing: McpPlanReviewDisplayRecord = {
      sourceArtifactId: 'plan-artifact-1',
      revision: 3,
      digest: 'a'.repeat(64),
      blockers: [],
      items: [{
        requirementKey: 'requirement-filesystem-0',
        decision: 'denied',
        assignment: { type: 'agent', targetAgents: ['backend'], targetId: null },
        agentPermissions: { backend: ['filesystem.project.read'] },
        promptOverlays: {},
      }],
    }
    const items = initialMcpReviewItems(design(), existing)
    expect(items).toHaveLength(1)
    // The operator's saved denial and narrowed capability set survive a reload;
    // the draft must never silently widen back to what the Architect proposed.
    expect(items[0]).toMatchObject({
      decision: 'denied',
      agentPermissions: { backend: ['filesystem.project.read'] },
    })
  })

  it('copies the resumed review instead of aliasing it', () => {
    const existing: McpPlanReviewDisplayRecord = {
      sourceArtifactId: 'plan-artifact-1',
      revision: 1,
      digest: 'b'.repeat(64),
      blockers: [],
      items: [{
        requirementKey: 'requirement-filesystem-0',
        decision: 'approved',
        assignment: { type: 'agent', targetAgents: ['backend'], targetId: null },
        agentPermissions: { backend: ['filesystem.project.read'] },
        promptOverlays: { backend: 'overlay' },
      }],
    }
    const items = initialMcpReviewItems(design(), existing)
    items[0].assignment.targetAgents.push('frontend')
    items[0].agentPermissions.backend.push('filesystem.project.write')
    // Editing the draft must not mutate the immutable saved revision it resumed.
    expect(existing.items[0].assignment.targetAgents).toEqual(['backend'])
    expect(existing.items[0].agentPermissions.backend).toEqual(['filesystem.project.read'])
  })

  it('falls back to a stable legacy key when a requirement has none', () => {
    const legacy = design({
      requirements: [{
        sourceRequirementIndex: 2,
        mcpId: 'filesystem',
        requirement: 'required',
        reason: '',
        confidence: 'low',
        scope: { kind: 'project' },
        accessMode: 'planning_instruction',
        assignment: { type: 'agent', targetAgents: [], targetId: null },
        agentPermissions: {},
        prohibitedCapabilities: [],
        fallback: { action: 'ask_user', message: '' },
      }],
    })
    const items = initialMcpReviewItems(legacy, null)
    expect(items[0].requirementKey).toBe('legacy-source-2-filesystem')
  })
})
