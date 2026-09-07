import { describe, expect, it } from 'vitest'

import { READINESS_REASON_CODES, type IssueReadinessResult } from '@/scripts/github-agent-workflow/contracts/issue-readiness-result'
import { renderReadinessBlocker, renderReadinessReason } from '@/scripts/github-agent-workflow/core/readiness-reason-renderer'
import { buildReadinessMachineOutput } from '@/scripts/github-agent-workflow/cli/check-readiness'
import { buildReadinessComment } from '@/scripts/github-agent-workflow/shared/issue-validation-runner'
import { reconcileWorkflowRef } from '@/scripts/github-agent-workflow/validate-issue'

describe('readiness output trust boundary', () => {
  it('renders every stable reason code through a bounded fixed renderer', () => {
    for (const reasonCode of READINESS_REASON_CODES) {
      const rendered = renderReadinessReason(reasonCode, 42)
      expect(rendered.length).toBeGreaterThan(0)
      expect(rendered.length).toBeLessThan(256)
    }
  })

  it('never renders arbitrary blocker detail into human-facing or machine readiness output', () => {
    const maliciousDetail = '<script>alert("untrusted")</script> TOKEN=secret-like-text'
    const blocker = {
      reasonCode: 'queue.issue_dependency_open' as const,
      detail: maliciousDetail,
      dependencyIssueNumber: 42,
    }

    expect(renderReadinessBlocker(blocker)).toBe('A declared dependency is still open. Dependency: #42.')
    expect(renderReadinessBlocker(blocker)).not.toContain(maliciousDetail)

    const readiness: IssueReadinessResult = {
      issueNumber: 1,
      state: 'dependency-blocked',
      dispatchable: false,
      executionMode: 'implementation',
      dependencies: [42],
      reasonCodes: ['queue.issue_dependency_open'],
      blockers: [blocker],
      desiredReadinessLabels: ['dependency-blocked'],
      partial: false,
    }
    const comment = buildReadinessComment(readiness, 'blocked')
    const machineOutput = buildReadinessMachineOutput(readiness)

    expect(comment).toContain('queue.issue_dependency_open')
    expect(comment).toContain('Dependency: #42.')
    expect(comment).not.toContain(maliciousDetail)
    expect(JSON.stringify(machineOutput)).not.toContain(maliciousDetail)
    expect(machineOutput.blockers).toEqual([
      { reasonCode: 'queue.issue_dependency_open', dependencyIssueNumber: 42 },
    ])
  })
})

describe('reconcile workflow ref selection', () => {
  it('prefers the event repository default branch over ambient ref state', () => {
    expect(reconcileWorkflowRef(
      { repository: { default_branch: 'trunk' } },
      { GITHUB_REF_NAME: 'stale-event-ref' },
    )).toBe('trunk')
  })

  it('uses GITHUB_REF_NAME only when the event omits default_branch', () => {
    expect(reconcileWorkflowRef({}, { GITHUB_REF_NAME: 'release' })).toBe('release')
  })

  it('fails closed instead of assuming main when no branch authority is available', () => {
    expect(() => reconcileWorkflowRef({}, {})).toThrow('repository default branch is unavailable')
  })
})