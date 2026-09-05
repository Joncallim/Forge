import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { FakeGitHubClient } from '@/scripts/github-agent-workflow/io/fake-github-client'
import {
  ISSUE_VALIDATION_MARKER_PREFIX,
  validateIssue,
} from '@/scripts/github-agent-workflow/core/issue-validation'
import { runIssueValidation } from '@/scripts/github-agent-workflow/shared/issue-validation-runner'

const FIXTURE_DIR = path.join(process.cwd(), '__tests__', '__fixtures__', 'github-agent-workflow')

async function readFixture(name: string): Promise<string> {
  return await readFile(path.join(FIXTURE_DIR, name), 'utf8')
}

describe('GitHub issue validation', () => {
  it('validates complete Feature, Bug, Other, and Epic issues', async () => {
    const cases = [
      { file: 'feature-h3-form.md', issueType: 'feature' as const },
      { file: 'bug-valid.md', issueType: 'bug' as const },
      { file: 'other-valid.md', issueType: 'other' as const },
      { file: 'epic-h2.md', issueType: 'epic' as const },
    ]

    for (const testCase of cases) {
      const body = await readFixture(testCase.file)
      const result = validateIssue({
        number: 1,
        title: body.split('\n')[0].replace(/^#\s+/, ''),
        body,
      })

      expect(result.issueType).toBe(testCase.issueType)
      expect(result.valid).toBe(true)
      expect(result.missingSections).toEqual([])
      // Structural validation no longer recommends ready-for-agent
      expect(result.recommendedLabels).toEqual([])
      expect(result.commentBody).toBeNull()
    }
  })

  it('flags incomplete Feature, Bug, Other, and Epic issues deterministically', async () => {
    const cases = [
      { file: 'feature-no-response.md', missing: ['desired outcome', 'requirements', 'acceptance criteria', 'implementation scope'], issueType: 'feature' as const },
      { file: 'bug-invalid.md', missing: ['expected behaviour', 'acceptance criteria'], issueType: 'bug' as const },
      { file: 'other-invalid.md', missing: ['desired outcome', 'acceptance criteria'], issueType: 'other' as const },
      { file: 'epic-invalid.md', missing: ['tasks', 'acceptance criteria'], issueType: 'epic' as const },
    ]

    for (const testCase of cases) {
      const body = await readFixture(testCase.file)
      const result = validateIssue({
        number: 1,
        title: body.split('\n')[0].replace(/^#\s+/, ''),
        body,
      })

      expect(result.issueType).toBe(testCase.issueType)
      expect(result.valid).toBe(false)
      expect(result.missingSections).toEqual(testCase.missing)
      expect(result.recommendedLabels).toEqual(['needs-clarification'])
      expect(result.commentBody).toContain(ISSUE_VALIDATION_MARKER_PREFIX)
    }
  })

  it('updates labels and reuses a single marker comment without spam on repeated invalid runs', async () => {
    const body = await readFixture('bug-invalid.md')
    const client = new FakeGitHubClient({
      issues: [{
        number: 142,
        title: '[BUG] Dashboard refresh issue',
        body,
        labels: ['enhancement', 'ready-for-agent'],
        state: 'open',
        htmlUrl: 'https://github.com/Joncallim/Forge/issues/142',
        authorLogin: 'Joncallim',
        isPullRequest: false,
        stateReason: null,
        updatedAt: null,
      }],
    })

    const issue = await client.getIssue(142)
    const firstRun = await runIssueValidation(client, issue, { botLogin: 'github-actions[bot]' })
    expect(firstRun.result.valid).toBe(false)
    // Structural validation removes ready-for-agent and adds needs-clarification
    const labelsAfter = (await client.getIssue(142)).labels
    expect(labelsAfter).toContain('enhancement')
    expect(labelsAfter).toContain('needs-clarification')
    // ready-for-agent may have been removed by the readiness projection
    expect(await client.listComments(142)).toHaveLength(1)

    const secondRun = await runIssueValidation(client, await client.getIssue(142), { botLogin: 'github-actions[bot]' })
    expect(secondRun.result.valid).toBe(false)
    expect(await client.listComments(142)).toHaveLength(1)
  })
})
