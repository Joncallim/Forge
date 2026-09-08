import { describe, expect, it } from 'vitest'

import {
  issueControlMetadataSchema,
  MAX_DEPENDENCIES_PER_ISSUE,
} from '@/scripts/github-agent-workflow/contracts/issue-control-metadata'
import {
  issueReadinessResultSchema,
  MAX_BLOCKER_DETAIL_LENGTH,
  MAX_READINESS_BLOCKERS,
} from '@/scripts/github-agent-workflow/contracts/issue-readiness-result'

function dependencies(count: number): number[] {
  return Array.from({ length: count }, (_, index) => index + 1)
}

function blockers(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    reasonCode: 'queue.issue_dependency_open' as const,
    detail: `Dependency #${index + 1} is open.`,
    dependencyIssueNumber: index + 1,
  }))
}

describe('readiness contract bounds', () => {
  it('enforces the dependency cap in the canonical control-metadata schema', () => {
    const base = {
      executionMode: 'implementation' as const,
      dependsOnNone: false,
      explicit: true,
      isLegacyTrackingEpic: false,
    }

    expect(issueControlMetadataSchema.safeParse({
      ...base,
      dependencies: dependencies(MAX_DEPENDENCIES_PER_ISSUE),
    }).success).toBe(true)
    expect(issueControlMetadataSchema.safeParse({
      ...base,
      dependencies: dependencies(MAX_DEPENDENCIES_PER_ISSUE + 1),
    }).success).toBe(false)
  })

  it('enforces dependency and blocker caps in the canonical readiness schema', () => {
    const base = {
      issueNumber: 1,
      state: 'dependency-blocked' as const,
      dispatchable: false,
      executionMode: 'implementation' as const,
      reasonCodes: ['queue.issue_dependency_open' as const],
      desiredReadinessLabels: ['dependency-blocked' as const],
      partial: false,
    }

    expect(issueReadinessResultSchema.safeParse({
      ...base,
      dependencies: dependencies(MAX_DEPENDENCIES_PER_ISSUE),
      blockers: blockers(MAX_READINESS_BLOCKERS),
    }).success).toBe(true)

    expect(issueReadinessResultSchema.safeParse({
      ...base,
      dependencies: dependencies(MAX_DEPENDENCIES_PER_ISSUE + 1),
      blockers: blockers(MAX_READINESS_BLOCKERS),
    }).success).toBe(false)

    expect(issueReadinessResultSchema.safeParse({
      ...base,
      dependencies: dependencies(MAX_DEPENDENCIES_PER_ISSUE),
      blockers: blockers(MAX_READINESS_BLOCKERS + 1),
    }).success).toBe(false)
  })

  it('rejects incomplete ready states, duplicate reason codes, and oversized detail', () => {
    const base = {
      issueNumber: 1,
      state: 'ready' as const,
      dispatchable: true,
      executionMode: 'implementation' as const,
      dependencies: [],
      reasonCodes: [],
      blockers: [],
      desiredReadinessLabels: ['ready-for-agent' as const],
      partial: false,
    }
    expect(issueReadinessResultSchema.safeParse({ ...base, partial: true }).success).toBe(false)
    expect(issueReadinessResultSchema.safeParse({ ...base, reasonCodes: ['queue.issue_dependency_open', 'queue.issue_dependency_open'] }).success).toBe(false)
    expect(issueReadinessResultSchema.safeParse({
      ...base,
      state: 'dependency-blocked',
      dispatchable: false,
      desiredReadinessLabels: ['dependency-blocked'],
      blockers: [{ reasonCode: 'queue.issue_dependency_open', detail: 'x'.repeat(MAX_BLOCKER_DETAIL_LENGTH + 1), dependencyIssueNumber: 2 }],
    }).success).toBe(false)
  })
})
