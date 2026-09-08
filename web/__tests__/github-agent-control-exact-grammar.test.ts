import { describe, expect, it } from 'vitest'

import { IssueReadinessResolver } from '@/scripts/github-agent-workflow/shared/issue-readiness-resolver'
import { FakeGitHubClient } from '@/scripts/github-agent-workflow/io/fake-github-client'
import type { GitHubIssue } from '@/scripts/github-agent-workflow/io/github-client'

function validBugBody(dependsOn: string): string {
  return [
    '## Bug Summary',
    'Test bug',
    '## Current Behaviour',
    'Current',
    '## Expected Behaviour',
    'Expected',
    '## Reproduction Steps',
    '1. Reproduce',
    '## Impact',
    'Low',
    '## Severity',
    'Minor',
    '## Acceptance Criteria',
    '- [ ] Complete',
    '',
    'Execution mode: implementation',
    `Depends on: ${dependsOn}`,
  ].join('\n')
}

function issue(dependsOn: string): GitHubIssue {
  return {
    number: 1,
    title: '[BUG] Exact control grammar',
    body: validBugBody(dependsOn),
    labels: [],
    state: 'open',
    stateReason: null,
    htmlUrl: 'https://example.test/issues/1',
    authorLogin: 'test',
    isPullRequest: false,
    updatedAt: null,
  }
}

function withoutControlBlock(body: string): string {
  return body.replace('\nExecution mode: implementation\nDepends on: none', '')
}

describe('exact control metadata grammar', () => {
  it.each(['NONE', 'None', 'nOnE'])('rejects non-canonical empty dependency sentinel %s at the resolver boundary', async (sentinel) => {
    const target = issue(sentinel)
    const result = await new IssueReadinessResolver(new FakeGitHubClient({ issues: [target] })).resolveFromIssue(target)

    expect(result).toMatchObject({
      dispatchable: false,
      state: 'needs-clarification',
      dependencies: [],
    })
    expect(result.reasonCodes).toContain('queue.issue_dependency_syntax_invalid')
  })

  it.each([
    'Depends on:\u00a0none',
    'Depends on:\tnone',
    'Depends on:  none',
    'Depends on:none',
  ])('does not widen the literal Depends on grammar: %s', async (dependsOn) => {
    const target = { ...issue('none'), body: validBugBody('none').replace('Depends on: none', dependsOn) }
    const result = await new IssueReadinessResolver(new FakeGitHubClient({ issues: [target] })).resolveFromIssue(target)

    expect(result.dispatchable).toBe(false)
    expect(result.reasonCodes).not.toHaveLength(0)
  })

  it('does not authorize controls inside nested HTML blocks', async () => {
    const target = {
      ...issue('none'),
      body: [withoutControlBlock(validBugBody('none')), '<div>', '<section>', 'Execution mode: implementation', 'Depends on: none', '</section>', '</div>'].join('\r\n'),
    }
    const result = await new IssueReadinessResolver(new FakeGitHubClient({ issues: [target] })).resolveFromIssue(target)

    expect(result.dispatchable).toBe(false)
    expect(result.reasonCodes).toContain('queue.issue_control_missing')
  })

  it.each([
    ['same-line comment before fence', ['<!-- harmless -->```', 'Execution mode: implementation', 'Depends on: none', '```']],
    ['multiline comment close before fence', ['<!-- comment begins', '-->```', 'Execution mode: implementation', 'Depends on: none', '```']],
    ['multiline comment close before details', ['<!-- comment begins', '--><details>', 'Execution mode: implementation', 'Depends on: none', '</details>']],
    ['multiline inline-code span', ['`example metadata', 'Execution mode: implementation', 'Depends on: none', '`']],
    ['multiline triple-backtick code span', ['```language`invalid', 'Execution mode: implementation', 'Depends on: none', '```']],
  ])('does not authorize controls hidden by %s', async (_name, hiddenControls) => {
    const target = {
      ...issue('none'),
      body: [withoutControlBlock(validBugBody('none')), ...hiddenControls].join('\n'),
    }
    const result = await new IssueReadinessResolver(new FakeGitHubClient({ issues: [target] })).resolveFromIssue(target)

    expect(result.dispatchable).toBe(false)
    expect(result.reasonCodes).toContain('queue.issue_control_missing')
  })

  it('keeps a comment-bearing physical control line non-authoritative', async () => {
    const target = {
      ...issue('none'),
      body: [
        withoutControlBlock(validBugBody('none')),
        '<!-- explanatory text -->Execution mode: implementation',
        'Depends on: none',
      ].join('\n'),
    }
    const result = await new IssueReadinessResolver(new FakeGitHubClient({ issues: [target] })).resolveFromIssue(target)

    expect(result.dispatchable).toBe(false)
    expect(result.reasonCodes).toContain('queue.issue_control_missing')
  })

  it.each([
    '<!-- <details> -->',
    '<!-- </details><details> -->',
    '<!-- ``` -->',
  ])('does not let HTML-comment contents suppress later canonical controls: %s', async (comment) => {
    const target = {
      ...issue('none'),
      body: validBugBody('none').replace(
        'Execution mode: implementation',
        `${comment}\nExecution mode: implementation`,
      ),
    }
    const result = await new IssueReadinessResolver(new FakeGitHubClient({ issues: [target] })).resolveFromIssue(target)

    expect(result).toMatchObject({
      dispatchable: true,
      state: 'ready',
      reasonCodes: [],
    })
  })

  it.each([
    ['fenced code', ['```', '</details>', '```']],
    ['inline code span', ['`', '</details>', '`']],
    ['HTML comment', ['<!-- </details> -->']],
  ])('does not let %s inside details escape the collapsed authority boundary', async (_name, falseCloser) => {
    const target = {
      ...issue('none'),
      body: [
        withoutControlBlock(validBugBody('none')),
        '<details>',
        ...falseCloser,
        'Execution mode: implementation',
        'Depends on: none',
        '</details>',
      ].join('\n'),
    }
    const result = await new IssueReadinessResolver(new FakeGitHubClient({ issues: [target] })).resolveFromIssue(target)

    expect(result.dispatchable).toBe(false)
    expect(result.reasonCodes).toContain('queue.issue_control_missing')
  })
})
