import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  DISPATCH_STATE_TO_RUN_STATUS,
  DISPATCH_STATE_VALUES,
  RUN_STATUS_VALUES,
  buildRunId,
  handoffArtifactsSchema,
} from '@/scripts/github-agent-workflow/contracts/common'
import { agentBranchNameSchema, AGENT_BRANCH_NAME_PATTERN } from '@/scripts/github-agent-workflow/contracts/branch-name'
import { dispatchRequestSchema } from '@/scripts/github-agent-workflow/contracts/dispatch-request'
import { runtimeHandoffSchema } from '@/scripts/github-agent-workflow/contracts/runtime-handoff'
import { WORK_ORDER_SECTION_TITLES, workOrderSchema } from '@/scripts/github-agent-workflow/contracts/work-order'
import { PR_CONTRACT_SECTION_TITLES } from '@/scripts/github-agent-workflow/contracts/pr-contract-sections'
import { buildAgentBranchName, slugifyIssueTitle } from '@/scripts/github-agent-workflow/core/branch-names'
import { buildWorkOrder, renderWorkOrder } from '@/scripts/github-agent-workflow/core/work-order'
import { extractAcceptanceCriteria } from '@/scripts/github-agent-workflow/core/acceptance-criteria'
import { extractSourceIssueReference } from '@/scripts/github-agent-workflow/core/pr-contract'
import { buildHandoffArtifacts, handoffArtifactDirectory } from '@/scripts/github-agent-workflow/core/handoff'
import {
  DISPATCH_PLACEHOLDER,
  HANDOFF_PLACEHOLDER,
  PR_CONTRACT_PLACEHOLDER,
  architecturePlaceholderMessage,
} from '@/scripts/github-agent-workflow/core/workflow-architecture'
import {
  linkPullRequest,
  recordBlockedReason,
  recordRequested,
  updateRunStatus,
} from '@/scripts/github-agent-workflow/io/agent-run-log'

const tempRoots: string[] = []

async function tempRepositoryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-arch-'))
  tempRoots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('workflow state model', () => {
  it('keeps the run log as the single status source and maps #144 accepted -> handed-off', () => {
    for (const status of ['requested', 'handed-off', 'running', 'blocked', 'pr-opened'] as const) {
      expect(RUN_STATUS_VALUES).toContain(status)
    }
    // #144's dispatch vocabulary uses `accepted`; it must not become a parallel
    // run status, only a mapping onto the existing contract.
    expect(RUN_STATUS_VALUES).not.toContain('accepted')
    expect(DISPATCH_STATE_VALUES).toContain('accepted')
    expect(DISPATCH_STATE_TO_RUN_STATUS.accepted).toBe('handed-off')
    for (const state of DISPATCH_STATE_VALUES) {
      expect(RUN_STATUS_VALUES).toContain(DISPATCH_STATE_TO_RUN_STATUS[state])
    }
  })

  it('supports the requested -> handed-off -> running -> pr-opened progression on the durable run log', async () => {
    const root = await tempRepositoryRoot()
    const runId = buildRunId({ issueNumber: 144, githubRunId: 1234567890, githubRunAttempt: 1 })
    const options = { repositoryRoot: root }

    const requested = await recordRequested({
      runId,
      issueNumber: 144,
      issueTitle: '[FEATURE] Design safe agent dispatch',
      runtime: 'dry-run',
      action: 'implement',
      requestedBy: 'Joncallim',
      source: { type: 'issue_comment', commentId: 501 },
    }, options)
    expect(requested.status).toBe('requested')

    const handedOff = await updateRunStatus({
      issueNumber: 144,
      runId,
      status: DISPATCH_STATE_TO_RUN_STATUS.accepted,
      message: 'Dispatcher generated a bounded work order.',
    }, options)
    expect(handedOff.status).toBe('handed-off')

    const running = await updateRunStatus({ issueNumber: 144, runId, status: 'running' }, options)
    expect(running.status).toBe('running')

    const prOpened = await linkPullRequest({
      issueNumber: 144,
      runId,
      branchName: buildAgentBranchName({ issueNumber: 144, issueTitle: 'Design safe agent dispatch' }),
      prNumber: 200,
    }, options)
    expect(prOpened.status).toBe('pr-opened')
    expect(prOpened.prNumber).toBe(200)
  })

  it('records a blocked reason without implying dispatch or handoff succeeded', async () => {
    const root = await tempRepositoryRoot()
    const runId = buildRunId({ issueNumber: 144, githubRunId: 1234567891, githubRunAttempt: 1 })
    const options = { repositoryRoot: root }

    await recordRequested({
      runId,
      issueNumber: 144,
      issueTitle: '[FEATURE] Design safe agent dispatch',
      runtime: 'dry-run',
      action: 'implement',
      requestedBy: 'Joncallim',
      source: { type: 'issue_comment', commentId: 502 },
    }, options)

    const blocked = await recordBlockedReason({
      issueNumber: 144,
      runId,
      blockedReason: 'Issue is not ready-for-agent.',
    }, options)

    expect(blocked.status).toBe('blocked')
    expect(blocked.status).not.toBe('handed-off')
    expect(blocked.status).not.toBe('running')
    expect(blocked.blockedReason).toBe('Issue is not ready-for-agent.')
  })
})

describe('deterministic agent branch names', () => {
  it('is deterministic and git-ref safe', () => {
    const input = { issueNumber: 144, issueTitle: '[FEATURE] Design safe agent dispatch for GitHub issue work' }
    const first = buildAgentBranchName(input)
    const second = buildAgentBranchName(input)

    expect(first).toBe(second)
    expect(first).toMatch(AGENT_BRANCH_NAME_PATTERN)
    expect(agentBranchNameSchema.safeParse(first).success).toBe(true)
    expect(first.startsWith('agent/issue-144-')).toBe(true)
    expect(first).not.toContain('[')
    expect(first).not.toContain(' ')
    expect(first).not.toContain('--')
  })

  it('degrades cleanly for empty or symbol-only titles', () => {
    expect(buildAgentBranchName({ issueNumber: 7, issueTitle: '[BUG]' })).toBe('agent/issue-7')
    expect(buildAgentBranchName({ issueNumber: 7, issueTitle: '   ***   ' })).toBe('agent/issue-7')
    expect(slugifyIssueTitle('[FEATURE] Añadir soporte!!!')).toBe('a-adir-soporte')
  })

  it('redacts secret-shaped title text before building a branch slug', () => {
    const secret = `ghp_${'a'.repeat(40)}`
    const branch = buildAgentBranchName({ issueNumber: 8, issueTitle: `[FEATURE] Use ${secret}` })

    expect(branch).toBe('agent/issue-8-use-redacted')
    expect(branch).not.toContain('ghp')
  })

  it('bounds long slugs', () => {
    const branch = buildAgentBranchName({
      issueNumber: 12,
      issueTitle: 'A very long issue title that keeps going and going far beyond any reasonable branch length limit',
    })
    expect(branch).toMatch(AGENT_BRANCH_NAME_PATTERN)
    expect(branch.length).toBeLessThanOrEqual('agent/issue-12-'.length + 40)
  })

  it('rejects invalid branch names across dispatch, work-order, and handoff contracts', () => {
    const invalidBranchName = 'Agent/Issue 144 unsafe'
    const base = {
      runId: 'issue-144-1234567890-1',
      issueNumber: 144,
      runtime: 'codex',
      branchName: invalidBranchName,
    }

    expect(dispatchRequestSchema.safeParse({
      ...base,
      issueTitle: 'Safe dispatch',
      action: 'implement',
      requestedBy: 'Joncallim',
      dryRun: false,
      source: { type: 'issue_comment', commentId: 1 },
      requestedAt: '2026-07-06T01:00:00.000Z',
    }).success).toBe(false)

    expect(workOrderSchema.safeParse({
      title: 'FORGE Agent Work Order',
      issueNumber: 144,
      issueTitle: 'Safe dispatch',
      branchName: invalidBranchName,
      sections: WORK_ORDER_SECTION_TITLES.map((title) => ({ title, body: 'x' })),
    }).success).toBe(false)

    expect(runtimeHandoffSchema.safeParse({
      ...base,
      handoffPath: '.forge/runs/144/issue-144-1234567890-1/handoff.md',
      promptPath: '.forge/runs/144/issue-144-1234567890-1/prompt.md',
      metadataPath: '.forge/runs/144/issue-144-1234567890-1/metadata.json',
      generatedAt: '2026-07-06T01:00:00.000Z',
    }).success).toBe(false)
  })
})

describe('work-order prompt sections', () => {
  it('exposes a stable, ordered section list', () => {
    expect(WORK_ORDER_SECTION_TITLES).toEqual([
      'Source Issue',
      'Objective',
      'Acceptance Criteria',
      'Required Constraints',
      'Relevant Repo Rules',
      'Expected Output',
      'Stop Conditions',
    ])
  })

  it('builds every section in order, bounded, and schema-valid', () => {
    const workOrder = buildWorkOrder({
      issueNumber: 144,
      issueTitle: 'Design safe agent dispatch',
      branchName: 'agent/issue-144-design-safe-agent-dispatch',
      sections: {
        Objective: 'Turn an accepted request into a bounded work order.',
        'Acceptance Criteria': 'x'.repeat(5000),
      },
    })

    expect(workOrderSchema.safeParse(workOrder).success).toBe(true)
    expect(workOrder.sections.map((section) => section.title)).toEqual([...WORK_ORDER_SECTION_TITLES])
    for (const section of workOrder.sections) {
      expect(section.body.length).toBeLessThanOrEqual(2000)
    }
    // Unprovided sections get an explicit placeholder rather than being dropped.
    const stopConditions = workOrder.sections.find((section) => section.title === 'Stop Conditions')
    expect(stopConditions?.body).toContain('#144')
    expect(renderWorkOrder(workOrder)).toContain('# FORGE Agent Work Order')
  })
})

describe('PR contract sections', () => {
  it('exposes stable section titles for #152 template and #145 checker', () => {
    expect(PR_CONTRACT_SECTION_TITLES).toEqual([
      'Source Issue',
      'Agent Run',
      'Summary',
      'Acceptance Criteria Validation',
      'Tests / Verification',
      'Risks / Follow-up',
    ])
  })
})

describe('handoff artifacts', () => {
  it('produces predictable paths that satisfy the run-log handoffArtifacts shape', () => {
    const runId = buildRunId({ issueNumber: 153, githubRunId: 1234567890, githubRunAttempt: 2 })
    const artifacts = buildHandoffArtifacts({ issueNumber: 153, runId })

    expect(handoffArtifactsSchema.safeParse(artifacts).success).toBe(true)
    const directory = handoffArtifactDirectory(153, runId)
    expect(directory).toBe(`.forge/runs/153/${runId}`)
    expect(artifacts.handoffPath).toBe(`${directory}/handoff.md`)
    expect(artifacts.promptPath).toBe(`${directory}/prompt.md`)
    expect(artifacts.metadataPath).toBe(`${directory}/metadata.json`)
    // Nested under the run id directory (git-ignored), not the tracked
    // <run-id>.json run record.
    expect(artifacts.metadataPath.startsWith(`.forge/runs/153/${runId}/`)).toBe(true)
  })
})

describe('shared source-issue and acceptance-criteria parsers', () => {
  it.each([
    ['Closes #123', 123, 'closes'],
    ['Fixes #45 and adds tests', 45, 'fixes'],
    ['This resolves #7.', 7, 'resolves'],
    ['Issue: #99', 99, 'issue'],
  ])('extracts a source issue reference from %s', (body, issueNumber, keyword) => {
    const reference = extractSourceIssueReference(body)
    expect(reference?.issueNumber).toBe(issueNumber)
    expect(reference?.keyword).toBe(keyword)
  })

  it('returns null when a PR body links no issue', () => {
    expect(extractSourceIssueReference('No linked issue here.')).toBeNull()
    expect(extractSourceIssueReference(null)).toBeNull()
  })

  it('extracts the acceptance-criteria checklist from an issue body', () => {
    const issueBody = [
      '## Acceptance Criteria',
      '',
      '- [ ] Dispatcher refuses issues that are not ready-for-agent.',
      '- [x] Dispatcher generates a deterministic branch name.',
      '',
      '## Out of Scope',
      '',
      '- Not this.',
    ].join('\n')

    expect(extractAcceptanceCriteria(issueBody)).toEqual([
      'Dispatcher refuses issues that are not ready-for-agent.',
      'Dispatcher generates a deterministic branch name.',
    ])
    expect(extractAcceptanceCriteria('# No criteria section')).toEqual([])
  })
})

describe('fail-closed placeholder CLIs', () => {
  it('name their owning issue and the architecture doc', () => {
    for (const placeholder of [DISPATCH_PLACEHOLDER, PR_CONTRACT_PLACEHOLDER, HANDOFF_PLACEHOLDER]) {
      const message = architecturePlaceholderMessage(placeholder)
      expect(message).toContain(`#${placeholder.issue}`)
      expect(message).toContain('docs/github-native-agent-workflow-architecture.md')
      expect(placeholder.sharedContracts.length).toBeGreaterThan(0)
    }
  })
})
