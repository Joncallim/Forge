import { describe, expect, it } from 'vitest'
import {
  assertTargetedPlanRevision,
  assertUsableArchitectPlan,
  prepareArchitectArtifact,
  UnusableArchitectPlanError,
} from '@/worker/architect-artifact'
import { MCP_CATALOG } from '@/lib/mcps/catalog'
import type { ProjectMcpOverview } from '@/lib/mcps/types'

const emptyOverview: ProjectMcpOverview = {
  projectId: 'project-1',
  config: { profile: 'default', requiredMcps: ['filesystem', 'github'], overrides: {} },
  catalog: Object.values(MCP_CATALOG),
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
  it('strips all machine-readable fences and persists planning metadata', () => {
    const raw = [
      '# Plan',
      'Use the repository context.',
      '',
      '```agent_breakdown_json',
      '{"agents":[{"role":"Backend","tasks":1,"summary":"Inspect repository","steps":["Inspect issue context"]}]}',
      '```',
      '',
      '```capability_classification_json',
      '{"schemaVersion":1,"required":["api-implementation"],"optional":["unit-testing"],"excluded":[{"capability":"deployment","reason":"No deployment change."}]}',
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
    expect(prepared.planText).not.toContain('capability_classification_json')
    expect(prepared.planText).not.toContain('mcp_execution_design_json')
    expect(prepared.capabilityClassification.proposed.required).toEqual(['api-implementation'])
    expect(prepared.capabilityClassification.proposed.excluded[0]).toMatchObject({
      capability: 'deployment',
      reason: 'No deployment change.',
    })
    expect(prepared.mcpExecutionDesign.proposed?.requirements[0]).toMatchObject({
      mcpId: 'github',
      requirement: 'required',
    })
    expect(prepared.mcpExecutionDesign.validation.status).toBe('blocked')
    expect(prepared.mcpExecutionDesign.grantDecisions.summary.blocked).toBe(1)
    expect(prepared.mcpExecutionDesign.grantDecisions.decisions[0]).toMatchObject({
      agent: 'backend',
      mcpId: 'github',
      status: 'blocked',
    })
    expect(prepared.agents[0]).toMatchObject({ role: 'Backend', tasks: 1 })
    expect(prepared.agentBreakdownSource).toBe('fence')
  })

  it('marks role-tag agent breakdown as visible fallback metadata', () => {
    const prepared = prepareArchitectArtifact('# Plan\n\n- [Frontend] Update task status labels.', emptyOverview)

    expect(prepared.agents[0]).toMatchObject({ role: 'Frontend', tasks: 1 })
    expect(prepared.agentBreakdownSource).toBe('fallback')
  })
})

describe('assertUsableArchitectPlan', () => {
  const prepare = (raw: string) => prepareArchitectArtifact(raw, emptyOverview)

  it('accepts a normal plan body', () => {
    const raw = '# Plan\n\nImplement the requested change across the backend service and add focused tests covering it.'
    expect(() => assertUsableArchitectPlan(raw, prepare(raw))).not.toThrow()
  })

  it('accepts an output that only asks open questions', () => {
    const raw = [
      'Short.',
      '```open_questions_json',
      '{"questions":[{"id":"q1","question":"Which database should this use?"}]}',
      '```',
    ].join('\n')
    const prepared = prepare(raw)
    expect(prepared.questions.length).toBe(1)
    expect(() => assertUsableArchitectPlan(raw, prepared)).not.toThrow()
  })

  it('rejects empty output', () => {
    expect(() => assertUsableArchitectPlan('   ', prepare('   '))).toThrow(UnusableArchitectPlanError)
  })

  it('rejects a transport/timeout failure leaking in as the plan', () => {
    const raw =
      'Falling back from WebSockets to HTTPS transport. request timed out. I\'ll quickly inspect the repo to anchor this to existing patterns.'
    expect(() => assertUsableArchitectPlan(raw, prepare(raw))).toThrow(/transport failure/i)
  })

  it('rejects a transport dump even if structured agent metadata leaked through', () => {
    const raw = [
      'Falling back from WebSockets to HTTPS transport. request timed out.',
      '```agent_breakdown_json',
      '{"agents":[{"role":"Backend","tasks":1}]}',
      '```',
    ].join('\n')
    expect(() => assertUsableArchitectPlan(raw, prepare(raw))).toThrow(/transport failure/i)
  })

  it('accepts a structured plan that discusses timeout handling', () => {
    const raw = [
      '# Plan',
      '',
      'Handle request timed out responses in the API and explain recovery steps to operators.',
      '```agent_breakdown_json',
      '{"agents":[{"role":"Backend","tasks":1}]}',
      '```',
    ].join('\n')
    expect(() => assertUsableArchitectPlan(raw, prepare(raw))).not.toThrow()
  })

  it('accepts an unstructured plan that discusses rate limiting and HTTP 429 behavior', () => {
    const raw = [
      '# Plan',
      '',
      'Implement API rate limiting for repository actions and add explicit handling for HTTP 429 Too Many Requests responses.',
      'Document retry behavior, expose a clear UI message, and add regression tests for the quota edge cases.',
    ].join('\n')
    expect(() => assertUsableArchitectPlan(raw, prepare(raw))).not.toThrow()
  })

  it('rejects an explicit quota failure leaking in as the plan', () => {
    const raw = 'Request failed with 429 because the provider rate limit was exceeded. Please try again later.'
    expect(() => assertUsableArchitectPlan(raw, prepare(raw))).toThrow(/transport, timeout, or quota/i)
  })

  it('rejects a trivially short non-plan with no questions or agents', () => {
    const raw = 'ok'
    expect(() => assertUsableArchitectPlan(raw, prepare(raw))).toThrow(UnusableArchitectPlanError)
  })
})

describe('assertTargetedPlanRevision', () => {
  const previousPlan = [
    '# Implementation Plan',
    '',
    '## Context',
    'Keep the dashboard state clear for operators reviewing tasks.',
    '',
    '## Decision',
    'Use the existing task status stream and sidebar summary endpoint.',
    '',
    '## Work Packages',
    '- [Frontend] Update the sidebar task status label.',
    '- [Frontend] Add running state indicators to the task detail page.',
    '- [QA] Add focused regression coverage for the visible states.',
    '',
    '## Verification',
    'Run lint, typecheck, tests, and a browser smoke path.',
  ].join('\n')

  it('accepts a revision that keeps most original lines and changes a targeted item', () => {
    const revisedPlan = previousPlan.replace(
      '- [Frontend] Add running state indicators to the task detail page.',
      '- [Frontend] Add running state indicators to the task list and task detail page.',
    )

    expect(() => assertTargetedPlanRevision(previousPlan, revisedPlan)).not.toThrow()
  })

  it('rejects a revised plan that replaces most of the original text', () => {
    const rewrittenPlan = [
      '# New Architecture',
      '',
      'Use a centralized orchestration dashboard with a new event bus.',
      '',
      '## Packages',
      '- [Backend] Create a new status projection service.',
      '- [Frontend] Build a new task shell.',
      '- [DevOps] Add queue monitors.',
      '',
      '## Tests',
      'Add broad integration coverage for the new workflow.',
    ].join('\n')

    expect(() => assertTargetedPlanRevision(previousPlan, rewrittenPlan)).toThrow(/replaced too much/i)
  })

  it('rejects full rewrites even when feedback asks for one', () => {
    const rewrittenPlan = '# New Plan\n\nReplace the entire plan with a fresh architecture.'

    expect(() => assertTargetedPlanRevision(previousPlan, rewrittenPlan)).toThrow(/replaced too much/i)
  })

  it('does not treat ordinary targeted replacement wording as a full rewrite request', () => {
    const rewrittenPlan = '# New Plan\n\nReplace everything with unrelated content.'

    expect(() => assertTargetedPlanRevision(previousPlan, rewrittenPlan)).toThrow(/replaced too much/i)
  })

  it('rejects copied reference appendices that bury old lines after a new plan', () => {
    const revisedPlan = [
      '# Replacement',
      '',
      'Use a different implementation strategy with new owners.',
      'Add unrelated backend orchestration and new provider handling.',
      'Skip the original sidebar-oriented implementation details.',
      '',
      '## Old plan for reference',
      previousPlan,
    ].join('\n')

    expect(() => assertTargetedPlanRevision(previousPlan, revisedPlan)).toThrow(/replaced too much/i)
  })

  it('rejects copied reference appendices even when the original heading is omitted', () => {
    const oldLinesWithoutHeading = previousPlan
      .split('\n')
      .filter((line) => line !== '# Implementation Plan')
      .join('\n')
    const revisedPlan = [
      '# Replacement',
      '',
      'Use a different implementation strategy with new owners.',
      'Add unrelated backend orchestration and new provider handling.',
      'Skip the original sidebar-oriented implementation details.',
      '',
      '## Old plan excerpt for reference',
      oldLinesWithoutHeading,
    ].join('\n')

    expect(() => assertTargetedPlanRevision(previousPlan, revisedPlan)).toThrow(/replaced too much/i)
  })

  it('rejects old-heading anchors followed by replacement text and copied old content', () => {
    const revisedPlan = [
      '# Implementation Plan',
      '',
      'Use a different implementation strategy with new owners.',
      'Add unrelated backend orchestration and new provider handling.',
      'Skip the original sidebar-oriented implementation details.',
      'Change the workforce and MCP assumptions entirely.',
      '',
      '## Context',
      'Keep the dashboard state clear for operators reviewing tasks.',
      '',
      '## Decision',
      'Use the existing task status stream and sidebar summary endpoint.',
      '',
      '## Work Packages',
      '- [Frontend] Update the sidebar task status label.',
      '- [Frontend] Add running state indicators to the task detail page.',
      '- [QA] Add focused regression coverage for the visible states.',
      '',
      '## Verification',
      'Run lint, typecheck, tests, and a browser smoke path.',
    ].join('\n')

    expect(() => assertTargetedPlanRevision(previousPlan, revisedPlan)).toThrow(/replaced too much/i)
  })

  it('allows targeted edits to short but substantive plans', () => {
    const shortPlan = 'Update the task sidebar label when approval is required, add a running indicator for quiet ACP work, and verify the dashboard states with focused tests.'
    const revisedPlan = 'Update the task sidebar label immediately when approval is required, add a running indicator for quiet ACP work, and verify the dashboard states with focused tests.'

    expect(() => assertTargetedPlanRevision(shortPlan, revisedPlan)).not.toThrow()
  })

  it('allows ordinary prose that says the revision updates the previous plan', () => {
    const revisedPlan = previousPlan.replace(
      'Keep the dashboard state clear for operators reviewing tasks.',
      'This revised plan updates the previous plan by keeping dashboard state clear for operators reviewing tasks.',
    )

    expect(() => assertTargetedPlanRevision(previousPlan, revisedPlan)).not.toThrow()
  })

  it('fails closed when the previous plan is too short to compare safely', () => {
    expect(() => assertTargetedPlanRevision('# Plan\n\nShort line.', '# New\n\nDifferent line.')).toThrow(/too short/i)
  })
})
