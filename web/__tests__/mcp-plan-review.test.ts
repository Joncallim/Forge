import { describe, expect, it } from 'vitest'
import { MCP_CATALOG } from '@/lib/mcps/catalog'
import type { ProjectMcpOverview } from '@/lib/mcps/types'
import { latestMcpExecutionDesignFromArtifacts } from '@/lib/mcps/execution-design-metadata'
import {
  approvedGrantsForDisplay,
  latestMcpPlanReviewForDisplay,
  mcpCapabilityCeilingForAgent,
  mcpPlanOverlayCount,
} from '@/lib/mcps/plan-review-metadata'
import { parseMcpExecutionDesign } from '@/worker/mcp-execution-design'
import {
  buildMcpOperatorReview,
  isValidMcpOperatorReview,
  MAX_MCP_OPERATOR_REVIEW_REVISIONS,
  mcpOperatorReviewSummary,
  projectReviewedMcpPlanToPackages,
  validateMcpOperatorReviewHistory,
  type McpPlanReviewItemInput,
} from '@/worker/mcp-plan-review'

function parsedDesign(requirements: Record<string, unknown>[], contexts: Record<string, unknown>[] = [], subtasks: Record<string, unknown>[] = []) {
  const raw = { schemaVersion: 1, requirements, promptOverlays: {}, requirementContexts: contexts, mcpAwareSubtasks: subtasks }
  return parseMcpExecutionDesign(`\`\`\`mcp_execution_design_json\n${JSON.stringify(raw)}\n\`\`\``).design!
}

function requirement(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    mcpId: 'github',
    requirement: 'required',
    reason: 'Read project issue context.',
    assignment: { type: 'agent', targetAgents: ['backend'], targetId: null },
    agentPermissions: { backend: ['github.issues.read', 'github.contents.read'] },
    prohibitedCapabilities: ['github.pull_requests.merge'],
    fallback: { action: 'ask_user', message: 'Ask for repository context.' },
    ...overrides,
  }
}

function overview(status: 'healthy' | 'unhealthy' = 'healthy'): ProjectMcpOverview {
  return {
    projectId: 'project-1',
    config: { profile: 'default', requiredMcps: ['filesystem', 'github'], overrides: {} },
    catalog: Object.values(MCP_CATALOG),
    mcpsRoot: '/tmp/mcps',
    statuses: [{
      mcpId: 'github', displayName: 'GitHub', description: 'GitHub MCP', installPath: '/tmp/mcps/github',
      installState: 'installed', status, enabled: true, error: status === 'healthy' ? null : 'offline',
      checkedAt: '2026-07-17T00:00:00.000Z',
    }, {
      mcpId: 'filesystem', displayName: 'Filesystem', description: 'Filesystem MCP', installPath: '/tmp/mcps/filesystem',
      installState: 'installed', status: 'healthy', enabled: true, error: null,
      checkedAt: '2026-07-17T00:00:00.000Z',
    }],
    summary: { label: 'MCPs', status, missing: 0, authRequired: 0, unhealthy: status === 'healthy' ? 0 : 1, disabled: 0 },
  }
}

function approvedItem(design: ReturnType<typeof parsedDesign>, index: number): McpPlanReviewItemInput {
  const requirement = design.requirements[index]
  return {
    requirementKey: requirement.requirementKey!,
    decision: 'approved',
    assignment: requirement.assignment,
    agentPermissions: requirement.agentPermissions,
    promptOverlays: {},
  }
}

function reviewMetadata(history: ReturnType<typeof buildMcpOperatorReview>[], summary = history.at(-1)) {
  return {
    mcpOperatorReviews: history,
    ...(summary ? { mcpOperatorReview: mcpOperatorReviewSummary(summary) } : {}),
  }
}

function reviewChain(count: number, design = parsedDesign([requirement()])) {
  const history: ReturnType<typeof buildMcpOperatorReview>[] = []
  for (let index = 0; index < count; index += 1) {
    const previous = history.at(-1) ?? null
    history.push(buildMcpOperatorReview({
      proposedDesign: design,
      plannedAgents: ['backend'],
      previous,
      createdBy: 'user-1',
      review: {
        sourceArtifactId: 'artifact-1',
        baseRevision: previous?.revision ?? 0,
        baseDigest: previous?.digest ?? null,
        items: [approvedItem(design, 0)],
      },
      createdAt: new Date(1_752_710_400_000 + index * 1_000),
    }))
  }
  return history
}

describe('MCP operator plan review', () => {
  it('supports single, multiple-agent, and workforce assignments while preventing capability widening', () => {
    const design = parsedDesign([
      requirement(),
      requirement({
        mcpId: 'filesystem', requirement: 'optional',
        assignment: { type: 'multiple_agents', targetAgents: ['backend', 'frontend'], targetId: null },
        agentPermissions: { backend: ['filesystem.project.read'], frontend: ['filesystem.project.read'] },
        prohibitedCapabilities: ['filesystem.project.write'],
        fallback: { action: 'continue_without_mcp', message: 'Use supplied files.' },
      }),
      requirement({
        requirement: 'optional',
        assignment: { type: 'workforce', targetAgents: ['backend', 'frontend'], targetId: 'delivery' },
        agentPermissions: { backend: ['github.repository.search'], frontend: ['github.repository.search'] },
        fallback: { action: 'continue_without_mcp', message: 'Use local search.' },
      }),
    ])
    const items = design.requirements.map((_, index) => approvedItem(design, index))
    items[0] = {
      ...items[0],
      assignment: { type: 'agent', targetAgents: ['backend'], targetId: null },
      agentPermissions: { backend: ['github.issues.read'] },
      promptOverlays: { backend: 'Use only the approved issue context.' },
    }
    const review = buildMcpOperatorReview({
      proposedDesign: design, plannedAgents: ['backend', 'frontend'],
      review: { sourceArtifactId: 'artifact-1', baseRevision: 0, baseDigest: null, items },
      previous: null, createdBy: 'user-1', createdAt: new Date('2026-07-17T00:00:00.000Z'),
    })
    expect(review.reviewedDesign.requirements.map((item) => item.assignment.type)).toEqual(['agent', 'multiple_agents', 'workforce'])
    expect(review.reviewedDesign.requirements[0].agentPermissions).toEqual({ backend: ['github.issues.read'] })
    expect(() => buildMcpOperatorReview({
      proposedDesign: design, plannedAgents: ['backend'], previous: null, createdBy: 'user-1',
      review: { sourceArtifactId: 'artifact-1', baseRevision: 0, baseDigest: null, items: [{ ...approvedItem(design, 0), agentPermissions: { backend: ['github.pull_requests.write'] } }, ...items.slice(1)] },
    })).toThrow(/widens the Architect proposal/)
  })

  it('preserves asymmetric original-agent ceilings and requires explicit capabilities for a new planned workforce assignee', () => {
    const design = parsedDesign([requirement({
      assignment: { type: 'workforce', targetAgents: ['backend', 'frontend'], targetId: 'delivery' },
      agentPermissions: {
        backend: ['github.contents.read', 'github.repository.search'],
        frontend: ['github.issues.read'],
      },
    })])
    expect(mcpCapabilityCeilingForAgent(design.requirements[0] as never, 'backend')).toEqual(['github.contents.read', 'github.repository.search'])
    expect(mcpCapabilityCeilingForAgent(design.requirements[0] as never, 'frontend')).toEqual(['github.issues.read'])
    expect(mcpCapabilityCeilingForAgent(design.requirements[0] as never, 'qa')).toEqual([
      'github.contents.read',
      'github.issues.read',
      'github.repository.search',
    ])
    const base = approvedItem(design, 0)
    expect(() => buildMcpOperatorReview({
      proposedDesign: design, plannedAgents: ['backend', 'frontend', 'qa'], previous: null, createdBy: 'user-1',
      review: {
        sourceArtifactId: 'artifact-1', baseRevision: 0, baseDigest: null,
        items: [{
          ...base,
          assignment: { type: 'agent', targetAgents: ['frontend'], targetId: null },
          agentPermissions: { frontend: ['github.contents.read'] },
        }],
      },
    })).toThrow(/for 'frontend'/)
    expect(() => buildMcpOperatorReview({
      proposedDesign: design, plannedAgents: ['backend', 'frontend', 'qa'], previous: null, createdBy: 'user-1',
      review: {
        sourceArtifactId: 'artifact-1', baseRevision: 0, baseDigest: null,
        items: [{
          ...base,
          assignment: { type: 'agent', targetAgents: ['qa'], targetId: null },
          agentPermissions: { qa: [] },
        }],
      },
    })).toThrow(/must specify reduced capabilities/)
    expect(() => buildMcpOperatorReview({
      proposedDesign: design, plannedAgents: ['backend', 'frontend', 'qa'], previous: null, createdBy: 'user-1',
      review: {
        sourceArtifactId: 'artifact-1', baseRevision: 0, baseDigest: null,
        items: [{
          ...base,
          assignment: { type: 'agent', targetAgents: ['qa'], targetId: null },
          agentPermissions: { qa: ['github.pull_requests.write'] },
        }],
      },
    })).toThrow(/for 'qa'/)
    const safe = buildMcpOperatorReview({
      proposedDesign: design, plannedAgents: ['backend', 'frontend', 'qa'], previous: null, createdBy: 'user-1',
      review: {
        sourceArtifactId: 'artifact-1', baseRevision: 0, baseDigest: null,
        items: [{
          ...base,
          assignment: { type: 'workforce', targetAgents: ['backend', 'qa'], targetId: 'delivery-v2' },
          agentPermissions: {
            backend: ['github.contents.read'],
            qa: ['github.issues.read'],
          },
        }],
      },
    })
    expect(safe.reviewedDesign.requirements[0].agentPermissions).toEqual({
      backend: ['github.contents.read'],
      qa: ['github.issues.read'],
    })
  })

  it('persists non-filesystem denial decisions and blocks approval unless the optional fallback permits continuation', () => {
    const required = parsedDesign([requirement()])
    const deniedRequired = { ...approvedItem(required, 0), decision: 'denied' as const }
    const blocked = buildMcpOperatorReview({
      proposedDesign: required, plannedAgents: ['backend'], previous: null, createdBy: 'user-1',
      review: { sourceArtifactId: 'artifact-1', baseRevision: 0, baseDigest: null, items: [deniedRequired] },
    })
    expect(blocked.items[0].decision).toBe('denied')
    expect(blocked.blockers[0]).toMatch(/requires plan revision/)

    const optional = parsedDesign([requirement({ requirement: 'optional', fallback: { action: 'continue_without_mcp', message: 'Use pasted issue context.' } })])
    const allowed = buildMcpOperatorReview({
      proposedDesign: optional, plannedAgents: ['backend'], previous: null, createdBy: 'user-1',
      review: { sourceArtifactId: 'artifact-1', baseRevision: 0, baseDigest: null, items: [{ ...approvedItem(optional, 0), decision: 'denied' }] },
    })
    expect(allowed.blockers).toEqual([])
    expect(allowed.reviewedDesign.requirements).toEqual([])
  })

  it('rejects review of a normalized partial design and preserves existing package blockers during projection', () => {
    const design = parsedDesign([requirement()])
    const normalizationErrors = ['A duplicate context was omitted during normalization.']
    const normalizationEvidence: NonNullable<typeof design.normalizationEvidence> = [{
      schemaVersion: 1,
      category: 'normalization',
      code: 'duplicate_context',
      message: normalizationErrors[0],
    }]
    expect(() => buildMcpOperatorReview({
      proposedDesign: { ...design, normalizationErrors, normalizationEvidence },
      plannedAgents: ['backend'],
      previous: null,
      createdBy: 'user-1',
      review: {
        sourceArtifactId: 'artifact-1',
        baseRevision: 0,
        baseDigest: null,
        items: [approvedItem(design, 0)],
      },
    })).toThrow(/unresolved normalization blockers/)

    const review = buildMcpOperatorReview({
      proposedDesign: design,
      plannedAgents: ['backend'],
      previous: null,
      createdBy: 'user-1',
      review: {
        sourceArtifactId: 'artifact-1',
        baseRevision: 0,
        baseDigest: null,
        items: [approvedItem(design, 0)],
      },
    })
    const [projected] = projectReviewedMcpPlanToPackages({
      review,
      overview: overview(),
      packages: [{
        id: 'pkg-normalization-blocked',
        assignedRole: 'backend',
        title: 'Backend',
        metadata: { mcpNormalizationErrors: normalizationErrors, mcpNormalizationEvidence: normalizationEvidence },
      }],
    })
    expect(projected.metadata.mcpNormalizationErrors).toEqual(normalizationErrors)
    expect(projected.metadata.mcpNormalizationEvidence).toEqual(normalizationEvidence)
  })

  it('chains immutable revisions, detects conflicts, and rejects digest tampering', () => {
    const design = parsedDesign([requirement()])
    const first = buildMcpOperatorReview({
      proposedDesign: design, plannedAgents: ['backend'], previous: null, createdBy: 'user-1',
      review: { sourceArtifactId: 'artifact-1', baseRevision: 0, baseDigest: null, items: [approvedItem(design, 0)] },
      createdAt: new Date('2026-07-17T00:00:00.000Z'),
    })
    const second = buildMcpOperatorReview({
      proposedDesign: design, plannedAgents: ['backend'], previous: first, createdBy: 'user-1',
      review: { sourceArtifactId: 'artifact-1', baseRevision: 1, baseDigest: first.digest, items: [approvedItem(design, 0)] },
      createdAt: new Date('2026-07-17T00:01:00.000Z'),
    })
    expect(second).toMatchObject({ revision: 2, previousDigest: first.digest })
    expect(isValidMcpOperatorReview(second)).toBe(true)
    expect(isValidMcpOperatorReview({ ...second, blockers: ['tampered'] })).toBe(false)
    expect(() => buildMcpOperatorReview({
      proposedDesign: design, plannedAgents: ['backend'], previous: first, createdBy: 'user-1',
      review: { sourceArtifactId: 'artifact-1', baseRevision: 0, baseDigest: null, items: [approvedItem(design, 0)] },
    })).toThrow(/revision conflict/)
  })

  it.each([
    ['invalid suffix', (history: ReturnType<typeof reviewChain>) => [history[0], { ...history[1], blockers: ['tampered'] }]],
    ['missing middle', (history: ReturnType<typeof reviewChain>) => [history[0], history[2]]],
    ['reordered history', (history: ReturnType<typeof reviewChain>) => [history[1], history[0], history[2]]],
    ['duplicate revision', (history: ReturnType<typeof reviewChain>) => [history[0], history[0], history[2]]],
  ])('fails closed for %s', (_label, mutate) => {
    const history = reviewChain(3)
    expect(validateMcpOperatorReviewHistory(reviewMetadata(mutate(history) as typeof history), 'artifact-1')).toMatchObject({ valid: false })
  })

  it('rejects wrong-source histories and summary/head mismatches', () => {
    const history = reviewChain(2)
    expect(validateMcpOperatorReviewHistory(reviewMetadata(history), 'artifact-2')).toMatchObject({ valid: false })
    const mixedSourceHead = buildMcpOperatorReview({
      proposedDesign: parsedDesign([requirement()]), plannedAgents: ['backend'], previous: history[0], createdBy: 'user-1',
      review: {
        sourceArtifactId: 'artifact-2', baseRevision: history[0].revision, baseDigest: history[0].digest,
        items: history[0].items,
      },
    })
    expect(validateMcpOperatorReviewHistory(reviewMetadata([history[0], mixedSourceHead]))).toMatchObject({ valid: false })
    expect(validateMcpOperatorReviewHistory({
      ...reviewMetadata(history),
      mcpOperatorReview: { ...mcpOperatorReviewSummary(history[1]), revision: 1 },
    }, 'artifact-1')).toMatchObject({ valid: false })
  })

  it('canonicalizes denied reviews to a closed minimal record and bounds revision volume', () => {
    const design = parsedDesign([requirement({ requirement: 'optional', fallback: { action: 'continue_without_mcp', message: 'Continue.' } })])
    const denied = buildMcpOperatorReview({
      proposedDesign: design, plannedAgents: ['backend'], previous: null, createdBy: 'user-1',
      review: {
        sourceArtifactId: 'artifact-1', baseRevision: 0, baseDigest: null,
        items: [{
          ...approvedItem(design, 0), decision: 'denied',
          assignment: { type: 'workforce', targetAgents: ['unknown'], targetId: 'malicious' },
          agentPermissions: { unknown: ['github.pull_requests.write'] },
          promptOverlays: { unknown: 'untrusted' },
        }],
      },
    })
    expect(denied.items[0]).toEqual({
      requirementKey: design.requirements[0].requirementKey,
      decision: 'denied',
      assignment: { type: 'agent', targetAgents: [], targetId: null },
      agentPermissions: {},
      promptOverlays: {},
    })
    const full = reviewChain(MAX_MCP_OPERATOR_REVIEW_REVISIONS)
    expect(() => buildMcpOperatorReview({
      proposedDesign: parsedDesign([requirement()]), plannedAgents: ['backend'], previous: full.at(-1)!, createdBy: 'user-1',
      review: {
        sourceArtifactId: 'artifact-1', baseRevision: full.length, baseDigest: full.at(-1)!.digest,
        items: full[0].items,
      },
    })).toThrow(/revision limit/)
    expect(validateMcpOperatorReviewHistory({
      mcpOperatorReviews: [...full, full[0]],
      mcpOperatorReview: mcpOperatorReviewSummary(full.at(-1)!),
    }, 'artifact-1')).toMatchObject({ valid: false })
  })

  it.each([
    ['chain', [
      { id: 'removed', dependsOn: [], capability: 'github.issues.read' },
      { id: 'retained', dependsOn: ['removed'], capability: 'github.contents.read' },
    ], ["MCP-aware subtask 'retained' depends on unavailable subtask 'removed'"]],
    ['diamond', [
      { id: 'removed', dependsOn: [], capability: 'github.issues.read' },
      { id: 'left', dependsOn: ['removed'], capability: 'github.contents.read' },
      { id: 'right', dependsOn: ['removed'], capability: 'github.contents.read' },
      { id: 'join', dependsOn: ['left', 'right'], capability: 'github.contents.read' },
    ], ["MCP-aware subtask 'left' depends on unavailable subtask 'removed'", "MCP-aware subtask 'right' depends on unavailable subtask 'removed'"]],
    ['pre-existing missing dependency', [
      { id: 'retained', dependsOn: ['never-existed'], capability: 'github.contents.read' },
    ], ["MCP-aware subtask 'retained' depends on unavailable subtask 'never-existed'"]],
  ])('blocks a retained %s graph with removed dependencies', (_label, graph, expected) => {
    const design = parsedDesign(
      [requirement()],
      [],
      graph.map((subtask) => ({
        id: subtask.id,
        agent: 'backend',
        dependsOn: subtask.dependsOn,
        mcpCapabilities: [subtask.capability],
        capabilityRequirements: [{ capability: subtask.capability, sourceRequirementIndex: 0 }],
        inputs: ['Input'], outputs: ['Output'], verification: ['Verified'],
        stoppingCondition: 'Done.', fallback: 'Stop.',
      })),
    )
    const review = buildMcpOperatorReview({
      proposedDesign: design, plannedAgents: ['backend'], previous: null, createdBy: 'user-1',
      review: {
        sourceArtifactId: 'artifact-1', baseRevision: 0, baseDigest: null,
        items: [{ ...approvedItem(design, 0), agentPermissions: { backend: ['github.contents.read'] } }],
      },
    })
    expect(review.blockers).toEqual(expected.map((message) => expect.stringContaining(message)))
  })

  it('projects the reviewed version with canonical health, overlay composition, and no live handles', () => {
    const design = parsedDesign(
      [requirement()],
      [{ sourceRequirementIndex: 0, agent: 'backend', promptOverlay: 'Original overlay.' }],
      [{
        id: 'inspect', agent: 'backend', dependsOn: [], mcpCapabilities: ['github.issues.read'],
        capabilityRequirements: [{ capability: 'github.issues.read', sourceRequirementIndex: 0 }],
        inputs: ['Issue'], outputs: ['Context'], verification: ['Issue captured'],
        stoppingCondition: 'Context captured.', fallback: 'Ask user.',
      }],
    )
    const item = { ...approvedItem(design, 0), promptOverlays: { backend: 'Reviewed overlay.' } }
    const review = buildMcpOperatorReview({
      proposedDesign: design, plannedAgents: ['backend'], previous: null, createdBy: 'user-1',
      review: { sourceArtifactId: 'artifact-1', baseRevision: 0, baseDigest: null, items: [item] },
    })
    const [projected] = projectReviewedMcpPlanToPackages({
      review, overview: overview('unhealthy'), packages: [{ id: 'pkg-1', assignedRole: 'backend', title: 'Backend', metadata: {} }],
    })
    expect(projected.metadata.promptOverlay).toBe('Reviewed overlay.')
    expect(projected.metadata.mcpAwareSubtasks).toEqual([expect.objectContaining({ id: 'inspect', accessMode: 'planning_instruction' })])
    expect(projected.metadata.mcpGrants).toEqual([expect.objectContaining({ health: expect.objectContaining({ status: 'unhealthy' }) })])
    expect(JSON.stringify(projected)).not.toContain('toolHandle')
  })

  it('defaults legacy planning records to explicit confidence, project scope, and planning access mode', () => {
    const design = parsedDesign([requirement()])
    expect(design.requirements[0]).toMatchObject({ confidence: 'medium', scope: { kind: 'project' }, accessMode: 'planning_instruction' })
  })

  it('renders canonical context counts, the latest review, and actual approved grants', () => {
    const design = parsedDesign([requirement()], [{ sourceRequirementIndex: 0, agent: 'backend', promptOverlay: 'Scoped context.' }])
    const review = buildMcpOperatorReview({
      proposedDesign: design, plannedAgents: ['backend'], previous: null, createdBy: 'user-1',
      review: { sourceArtifactId: 'artifact-1', baseRevision: 0, baseDigest: null, items: [approvedItem(design, 0)] },
    })
    const displayDesign = latestMcpExecutionDesignFromArtifacts([{
      artifactType: 'adr_text',
      metadata: { mcpExecutionDesign: {
        proposed: design,
        validation: { status: 'valid', blocked: [], warnings: [], health: [] },
        grantDecisions: null,
      } },
    }])
    expect(mcpPlanOverlayCount(displayDesign)).toBe(1)
    expect(latestMcpPlanReviewForDisplay({
      mcpOperatorReviewIntegrity: 'valid',
      validatedMcpOperatorReview: review,
    })).toMatchObject({ revision: 1, digest: review.digest })
    expect(latestMcpPlanReviewForDisplay({ metadata: reviewMetadata([review]) })).toBeNull()
    expect(approvedGrantsForDisplay({ proposedGrants: [{ mcpId: 'wrong' }], approvedGrants: [{ mcpId: 'github' }] })).toEqual([{ mcpId: 'github' }])
  })
})
