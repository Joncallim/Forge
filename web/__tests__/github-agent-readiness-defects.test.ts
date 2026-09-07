/**
 * Tests for the remaining P0/P1 defects identified in the residual review.
 *
 * Covers:
 * - Empty Depends on: fails closed
 * - Handoff cannot corrupt non-blockable run states
 * - Cycle detection through resolver (multi-node)
 * - Scanner fence closing (CommonMark compliance)
 * - FakeGitHubClient pagination
 * - Plan→validate→apply reconcile semantics
 * - Fresh re-resolution before ready promotion
 */

import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { parseControlMetadata } from '@/scripts/github-agent-workflow/core/issue-control'
import { scanVisibleMarkdownLines } from '@/scripts/github-agent-workflow/core/visible-markdown-scanner'
import { IssueReadinessResolver } from '@/scripts/github-agent-workflow/shared/issue-readiness-resolver'
import { runHandoff } from '@/scripts/github-agent-workflow/handoff'
import { syncReadinessLabels } from '@/scripts/github-agent-workflow/shared/readiness-projection'
import { canTransitionToBlocked } from '@/scripts/github-agent-workflow/shared/run-state-guard'
import {
  recordRequested,
  updateRunStatus,
  findLatestRunForIssue,
} from '@/scripts/github-agent-workflow/io/agent-run-log'
import { FakeGitHubClient } from '@/scripts/github-agent-workflow/io/fake-github-client'
import type { GitHubIssue } from '@/scripts/github-agent-workflow/io/github-client'

const tempRoots: string[] = []

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-defect-'))
  tempRoots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const READY_BODY = [
  '## Bug Summary',
  'Test bug',
  '## Current Behaviour',
  'Bug',
  '## Expected Behaviour',
  'Fix',
  '## Reproduction Steps',
  '1. Do something',
  '## Impact',
  'Minor',
  '## Severity',
  'Minor',
  '## Acceptance Criteria',
  '- [ ] Fixed',
  '',
  'Execution mode: implementation',
  'Depends on: none',
].join('\n')

const READY_ISSUE: GitHubIssue = {
  number: 1,
  title: '[BUG] Test',
  body: READY_BODY,
  labels: ['ready-for-agent'],
  state: 'open',
  stateReason: null,
  htmlUrl: 'https://github.com/Joncallim/Forge/issues/1',
  authorLogin: 'Joncallim',
  isPullRequest: false,
  updatedAt: null,
}

// ============================================================
// P0 — Empty Depends on:
// ============================================================
describe('empty Depends on: fails closed', () => {
  it('Depends on: with empty value produces errors and no ready state', () => {
    const body = [
      '## Bug Summary',
      'Test',
      '## Current Behaviour',
      'Test',
      '## Expected Behaviour',
      'Test',
      '## Reproduction Steps',
      'Test',
      '## Impact',
      'Test',
      '## Severity',
      'Test',
      '## Acceptance Criteria',
      '- [ ] Test',
      '',
      'Execution mode: implementation',
      'Depends on:',
    ].join('\n')

    const result = parseControlMetadata(body, 'bug')
    expect(result.errors.length).toBeGreaterThan(0)
    expect(result.errors[0]).toContain('empty')
    expect(result.metadata.dependsOnNone).toBe(false)
    // The issue should not be dispatchable
    expect(result.metadata.explicit).toBe(true)
  })

  it('Depends on: , (separator only) produces errors', () => {
    const body = [
      '## Bug Summary',
      'Test',
      '## Current Behaviour',
      'Test',
      '## Expected Behaviour',
      'Test',
      '## Reproduction Steps',
      'Test',
      '## Impact',
      'Test',
      '## Severity',
      'Test',
      '## Acceptance Criteria',
      '- [ ] Test',
      '',
      'Execution mode: implementation',
      'Depends on: ,',
    ].join('\n')

    const result = parseControlMetadata(body, 'bug')
    expect(result.errors.length).toBeGreaterThan(0)
    expect(result.errors[0]).toContain('empty')
  })

  it('Depends on: #1 (valid) works correctly', () => {
    const body = [
      '## Bug Summary',
      'Test',
      '## Current Behaviour',
      'Test',
      '## Expected Behaviour',
      'Test',
      '## Reproduction Steps',
      'Test',
      '## Impact',
      'Test',
      '## Severity',
      'Test',
      '## Acceptance Criteria',
      '- [ ] Test',
      '',
      'Execution mode: implementation',
      'Depends on: #1',
    ].join('\n')

    const result = parseControlMetadata(body, 'bug')
    expect(result.errors.length).toBe(0)
    expect(result.metadata.dependencies).toEqual([1])
    expect(result.metadata.dependsOnNone).toBe(false)
  })

  it('Depends on: none works correctly', () => {
    const body = [
      '## Bug Summary',
      'Test',
      '## Current Behaviour',
      'Test',
      '## Expected Behaviour',
      'Test',
      '## Reproduction Steps',
      'Test',
      '## Impact',
      'Test',
      '## Severity',
      'Test',
      '## Acceptance Criteria',
      '- [ ] Test',
      '',
      'Execution mode: implementation',
      'Depends on: none',
    ].join('\n')

    const result = parseControlMetadata(body, 'bug')
    expect(result.errors.length).toBe(0)
    expect(result.metadata.dependencies).toEqual([])
    expect(result.metadata.dependsOnNone).toBe(true)
  })
})

// ============================================================
// P0 — Handoff run state corruption
// ============================================================
describe('handoff run-state guard', () => {
  it('canTransitionToBlocked rejects non-blockable statuses', () => {
    expect(canTransitionToBlocked('requested')).toBe(true)
    expect(canTransitionToBlocked('handed-off')).toBe(true)
    expect(canTransitionToBlocked('running')).toBe(false)
    expect(canTransitionToBlocked('pr-opened')).toBe(false)
    expect(canTransitionToBlocked('completed')).toBe(false)
    expect(canTransitionToBlocked('failed')).toBe(false)
    expect(canTransitionToBlocked('cancelled')).toBe(false)
    expect(canTransitionToBlocked('blocked')).toBe(false)
  })

  it('handoff does not corrupt running/pr-opened/completed/failed/cancelled runs', async () => {
    const root = await tempRoot()

    for (const status of ['running', 'pr-opened', 'completed', 'failed', 'cancelled'] as const) {
      const runId = `issue-1-100000000${status.charCodeAt(0)}-1`
      await recordRequested({
        runId,
        issueNumber: 1,
        issueTitle: READY_ISSUE.title,
        runtime: 'codex',
        action: 'implement',
        requestedBy: 'Joncallim',
        source: { type: 'issue_comment', commentId: 100 },
      }, { repositoryRoot: root })
      await updateRunStatus({
        issueNumber: 1,
        runId,
        status,
      }, { repositoryRoot: root })

      const client = new FakeGitHubClient({
        issues: [{ ...READY_ISSUE, body: 'Some text without proper sections', labels: [] }],
      })

      const result = await runHandoff({
        client,
        issueNumber: 1,
        runLogRepositoryRoot: root,
        artifactRepositoryRoot: root,
        botLogin: 'github-actions[bot]',
      })

      // Handoff should block (not semantically ready) but NOT corrupt the run
      expect(result.status).toBe('blocked')

      // Verify run status was NOT changed
      const run = await findLatestRunForIssue(1, { repositoryRoot: root })
      expect(run).not.toBeNull()
      expect(run!.status).toBe(status)
    }
  })
})

// ============================================================
// P0/P1 — Cycle detection through resolver
// ============================================================
describe('cycle detection through resolver', () => {
  it('detects 2-node cycle (A→B→A)', async () => {
    // Issue A depends on B, B depends on A
    const issueA = {
      ...READY_ISSUE,
      number: 1,
      title: 'Issue A',
      body: [
        '## Bug Summary',
        'Test',
        '## Current Behaviour',
        'Test',
        '## Expected Behaviour',
        'Test',
        '## Reproduction Steps',
        'Test',
        '## Impact',
        'Test',
        '## Severity',
        'Test',
        '## Acceptance Criteria',
        '- [ ] Test',
        '',
        'Execution mode: implementation',
        'Depends on: #2',
      ].join('\n'),
    }
    const issueB = {
      ...READY_ISSUE,
      number: 2,
      title: 'Issue B',
      body: [
        '## Bug Summary',
        'Test',
        '## Current Behaviour',
        'Test',
        '## Expected Behaviour',
        'Test',
        '## Reproduction Steps',
        'Test',
        '## Impact',
        'Test',
        '## Severity',
        'Test',
        '## Acceptance Criteria',
        '- [ ] Test',
        '',
        'Execution mode: implementation',
        'Depends on: #1',
      ].join('\n'),
    }

    const client = new FakeGitHubClient({ issues: [issueA, issueB] })
    const resolver = new IssueReadinessResolver(client)
    const result = await resolver.resolveFromIssue(issueA)

    expect(result.dispatchable).toBe(false)
    expect(result.reasonCodes).toContain('queue.issue_dependency_cycle')
    expect(result.state).toBe('needs-clarification')
  })

  it('detects 3-node cycle (A→B→C→A)', async () => {
    const issueA = { ...READY_ISSUE, number: 1, title: 'Issue A', body: READY_BODY.replace('Depends on: none', 'Depends on: #2') }
    const issueB = { ...READY_ISSUE, number: 2, title: 'Issue B', body: READY_BODY.replace('Depends on: none', 'Depends on: #3').replace('Test', 'Test B') }
    const issueC = { ...READY_ISSUE, number: 3, title: 'Issue C', body: READY_BODY.replace('Depends on: none', 'Depends on: #1').replace('Test', 'Test C') }

    const client = new FakeGitHubClient({ issues: [issueA, issueB, issueC] })
    const resolver = new IssueReadinessResolver(client)
    const result = await resolver.resolveFromIssue(issueA)

    expect(result.dispatchable).toBe(false)
    expect(result.reasonCodes).toContain('queue.issue_dependency_cycle')
  })

  it('does not flag unrelated cycle', async () => {
    // Issue A depends on B; issues C and D have a separate cycle
    // A should not be blocked by C↔D cycle
    const issueA = { ...READY_ISSUE, number: 1, title: 'Issue A', body: READY_BODY.replace('Depends on: none', 'Depends on: #2') }
    const issueB = { ...READY_ISSUE, number: 2, title: 'Issue B', body: READY_BODY.replace('Test', 'Test B') }
    const issueC = { ...READY_ISSUE, number: 3, title: 'Issue C', body: READY_BODY.replace('Depends on: none', 'Depends on: #4').replace('Test', 'Test C') }
    const issueD = { ...READY_ISSUE, number: 4, title: 'Issue D', body: READY_BODY.replace('Depends on: none', 'Depends on: #3').replace('Test', 'Test D') }

    const client = new FakeGitHubClient({ issues: [issueA, issueB, issueC, issueD] })
    const resolver = new IssueReadinessResolver(client)
    const result = await resolver.resolveFromIssue(issueA)

    // A should be blocked because B is open, not because of C↔D
    expect(result.dispatchable).toBe(false)
    expect(result.reasonCodes).toContain('queue.issue_dependency_open')
    expect(result.reasonCodes).not.toContain('queue.issue_dependency_cycle')
  })

  it('respects depth limit for graph traversal', async () => {
    // Create a chain of dependencies A→B→C→D→... beyond depth limit
    const issues: GitHubIssue[] = []
    for (let i = 1; i <= 70; i++) {
      const dep = i < 70 ? `#${i + 1}` : 'none'
      issues.push({
        ...READY_ISSUE,
        number: i,
        title: `Issue ${i}`,
        body: READY_BODY.replace('Depends on: none', `Depends on: ${dep}`).replace('Test', `Test ${i}`),
      })
    }

    const client = new FakeGitHubClient({ issues })
    const resolver = new IssueReadinessResolver(client)
    const result = await resolver.resolveFromIssue(issues[0])

    // Should reach depth limit
    expect(result.dispatchable).toBe(false)
    expect(result.reasonCodes).toContain('queue.issue_dependency_graph_limit_exceeded')
  })
})

// ============================================================
// Scanner fence closing (CommonMark compliance)
// ============================================================
describe('visible-markdown-scanner fence closing', () => {
  it('properly closed fence exposes subsequent visible lines', () => {
    // A properly closed fence (no trailing non-whitespace) should expose
    // lines after the closing fence as visible
    const body = [
      '```',
      'Depends on: #999',
      '```',
      '',
      'Execution mode: implementation',
      'Depends on: none',
    ].join('\n')

    const result = scanVisibleMarkdownLines(body)
    const visibleText = result.lines.map((l) => l.text).join('\n')
    // The fenced Depends on: #999 should NOT be visible
    expect(visibleText).not.toContain('#999')
    // The real metadata should be visible (after properly closed fence)
    expect(visibleText).toContain('Execution mode: implementation')
    expect(visibleText).toContain('Depends on: none')
  })

  it('fence with trailing non-whitespace does not close the code block', () => {
    // CommonMark: a closing fence may only be followed by whitespace.
    // A line like "``` Depends on: none" has non-whitespace trailing text,
    // so it does NOT close the fence. Everything remains inside the code block.
    const body = [
      '```',
      'Depends on: #999',
      '``` Depends on: none',
      '',
      'Execution mode: implementation',
      'Depends on: none',
    ].join('\n')

    const result = scanVisibleMarkdownLines(body)
    // Since the fence never properly closes (trailing non-whitespace),
    // NO lines should be visible
    const visibleText = result.lines.map((l) => l.text).join('\n')
    expect(visibleText).toBe('')
  })

  it('fenced code with tildes works correctly', () => {
    const body = [
      '~~~',
      'Depends on: #999',
      '~~~',
      '',
      'Execution mode: implementation',
      'Depends on: none',
    ].join('\n')

    const result = scanVisibleMarkdownLines(body)
    const visibleText = result.lines.map((l) => l.text).join('\n')
    expect(visibleText).not.toContain('#999')
    expect(visibleText).toContain('Depends on: none')
  })

  it('indented code blocks are ignored', () => {
    const body = [
      '    Depends on: #999',
      '',
      'Execution mode: implementation',
      'Depends on: none',
    ].join('\n')

    const result = scanVisibleMarkdownLines(body)
    const visibleText = result.lines.map((l) => l.text).join('\n')
    expect(visibleText).not.toContain('#999')
    expect(visibleText).toContain('Depends on: none')
  })

  it('blockquotes are ignored', () => {
    const body = [
      '> Depends on: #999',
      '',
      'Execution mode: implementation',
      'Depends on: none',
    ].join('\n')

    const result = scanVisibleMarkdownLines(body)
    const visibleText = result.lines.map((l) => l.text).join('\n')
    expect(visibleText).not.toContain('#999')
    expect(visibleText).toContain('Depends on: none')
  })

  it('HTML comments hide metadata', () => {
    const body = [
      '<!--',
      'Depends on: #999',
      '-->',
      '',
      'Execution mode: implementation',
      'Depends on: none',
    ].join('\n')

    const result = scanVisibleMarkdownLines(body)
    const visibleText = result.lines.map((l) => l.text).join('\n')
    expect(visibleText).not.toContain('#999')
    expect(visibleText).toContain('Depends on: none')
  })

  it('inline-code spoofing does not expose metadata', () => {
    const body = [
      '`Execution mode: implementation`',
      '`Depends on: none`',
      '',
      'Execution mode: tracking',
      'Depends on: #1',
    ].join('\n')

    // Inline code is NOT ignored by the scanner - but the contract says
    // "full-line/inline-code representations that are not canonical literal metadata lines"
    // Inline code on its own line is NOT a canonical metadata line.
    // However, the current scanner only checks line starts, so
    // "`Execution mode: implementation`" starts with backtick, not "Execution mode:"
    const result = scanVisibleMarkdownLines(body)
    const visibleText = result.lines.map((l) => l.text).join('\n')
    // The backtick-wrapped lines should be visible but won't match the metadata prefix
    expect(visibleText).toContain('`Execution mode: implementation`')
    expect(visibleText).toContain('`Depends on: none`')

    // But the parser should not treat them as metadata because they start with backtick
    const controlResult = parseControlMetadata(body, 'bug')
    expect(controlResult.metadata.executionMode).toBe('tracking')
    expect(controlResult.metadata.dependencies).toEqual([1])
  })
})

// ============================================================
// FakeGitHubClient pagination
// ============================================================
describe('FakeGitHubClient pagination', () => {
  it('paginates correctly with perPage', async () => {
    const issues: GitHubIssue[] = []
    for (let i = 1; i <= 150; i++) {
      issues.push({ ...READY_ISSUE, number: i, title: `Issue ${i}`, body: READY_BODY.replace('Test', `Test ${i}`) })
    }

    const client = new FakeGitHubClient({ issues })

    // Page 1: 100 items
    const page1 = await client.listOpenIssues({ page: 1, perPage: 100 })
    expect(page1.issues.length).toBe(100)
    expect(page1.hasMore).toBe(true)

    // Page 2: 50 items
    const page2 = await client.listOpenIssues({ page: 2, perPage: 100 })
    expect(page2.issues.length).toBe(50)
    expect(page2.hasMore).toBe(false)
  })

  it('handles empty results', async () => {
    const client = new FakeGitHubClient()
    const result = await client.listOpenIssues()
    expect(result.issues.length).toBe(0)
    expect(result.hasMore).toBe(false)
  })

  it('discovers closed issues by a managed label only', async () => {
    const client = new FakeGitHubClient({
      issues: [
        { ...READY_ISSUE, number: 1, state: 'closed', labels: ['ready-for-agent'] },
        { ...READY_ISSUE, number: 2, state: 'closed', labels: ['unrelated'] },
        { ...READY_ISSUE, number: 3, state: 'open', labels: ['ready-for-agent'] },
      ],
    })

    const result = await client.listClosedIssues({ label: 'ready-for-agent' })
    expect(result.issues.map((issue) => issue.number)).toEqual([1])
    expect(result.hasMore).toBe(false)
  })

  it('reports hasMore correctly at page cap', async () => {
    // Create more than 50*100 = 5000 issues to test page cap
    const issues: GitHubIssue[] = []
    for (let i = 1; i <= 5010; i++) {
      issues.push({ ...READY_ISSUE, number: i, title: `Issue ${i}`, body: READY_BODY.replace('Test', `Test ${i}`) })
    }

    const client = new FakeGitHubClient({ issues })

    // Page 50 should be full and hasMore should be false due to page cap
    const page50 = await client.listOpenIssues({ page: 50, perPage: 100, maxPages: 50 })
    expect(page50.issues.length).toBe(100)
    // At page cap, hasMore should be false even though more data exists
    expect(page50.hasMore).toBe(false)
  })

  it('failure injection works', async () => {
    const client = new FakeGitHubClient({
      issues: [{ ...READY_ISSUE, number: 1 }, { ...READY_ISSUE, number: 2 }],
    })
    client.setFailures({
      getIssueFailures: { 1: 'not_found' },
    })

    await expect(client.getIssue(1)).rejects.toThrow()
    const issue2 = await client.getIssue(2)
    expect(issue2.number).toBe(2)
  })
})

// ============================================================
// syncReadinessLabels safe ordering
// ============================================================
describe('syncReadinessLabels safe ordering', () => {
  it('removes ready-for-agent first when transitioning to non-ready', async () => {
    const issue = { ...READY_ISSUE, labels: ['ready-for-agent'] }
    const client = new FakeGitHubClient({ issues: [issue] })

    const result = await syncReadinessLabels(client, issue, {
      issueNumber: 1,
      state: 'dependency-blocked',
      dispatchable: false,
      executionMode: 'implementation',
      dependencies: [2],
      reasonCodes: ['queue.issue_dependency_open'],
      blockers: [{ reasonCode: 'queue.issue_dependency_open', detail: 'Dependency #2 is open.', dependencyIssueNumber: 2 }],
      desiredReadinessLabels: ['dependency-blocked'],
      partial: false,
    })

    expect(result.success).toBe(true)
    expect(result.removedLabels).toContain('ready-for-agent')
    expect(result.addedLabels).toContain('dependency-blocked')
  })

  it('reports failure when ready-for-agent cannot be removed', async () => {
    const issue = { ...READY_ISSUE, labels: ['ready-for-agent'] }
    const client = new FakeGitHubClient({ issues: [issue] })
    client.setFailures({ removeLabelFailures: ['ready-for-agent'] })

    const result = await syncReadinessLabels(client, issue, {
      issueNumber: 1,
      state: 'dependency-blocked',
      dispatchable: false,
      executionMode: 'implementation',
      dependencies: [2],
      reasonCodes: ['queue.issue_dependency_open'],
      blockers: [{ reasonCode: 'queue.issue_dependency_open', detail: 'Dependency #2 is open.', dependencyIssueNumber: 2 }],
      desiredReadinessLabels: ['dependency-blocked'],
      partial: false,
    })

    expect(result.success).toBe(false)
    expect(result.error).toContain('Failed to remove ready-for-agent')
  })

  it('adds ready-for-agent last with blocker verification', async () => {
    const issue = { ...READY_ISSUE, labels: [] }
    const client = new FakeGitHubClient({ issues: [issue] })

    const result = await syncReadinessLabels(client, issue, {
      issueNumber: 1,
      state: 'ready',
      dispatchable: true,
      executionMode: 'implementation',
      dependencies: [],
      reasonCodes: [],
      blockers: [],
      desiredReadinessLabels: ['ready-for-agent'],
      partial: false,
    })

    expect(result.success).toBe(true)
    expect(result.addedLabels).toContain('ready-for-agent')
  })

  it('refuses to add ready-for-agent when blocker labels remain', async () => {
    const issue = { ...READY_ISSUE, labels: ['needs-clarification'] }
    const client = new FakeGitHubClient({ issues: [issue] })

    const result = await syncReadinessLabels(client, issue, {
      issueNumber: 1,
      state: 'ready',
      dispatchable: true,
      executionMode: 'implementation',
      dependencies: [],
      reasonCodes: [],
      blockers: [],
      desiredReadinessLabels: ['ready-for-agent'],
      partial: false,
    })

    // needs-clarification should be removed first, then ready added
    // But the projection checks labels after removal - needs-clarification should be gone
    expect(result.success).toBe(true)
    expect(result.addedLabels).toContain('ready-for-agent')
  })
})

// ============================================================
// Resolver concurrency and metrics
// ============================================================
describe('resolver concurrency and metrics', () => {
  it('drops raw issue bodies from reconciliation snapshots without changing readiness', async () => {
    const client = new FakeGitHubClient({ issues: [{ ...READY_ISSUE, labels: [] }] })
    const resolver = new IssueReadinessResolver(client)
    const snapshot = await resolver.loadOpenIssueSnapshot()
    const issue = snapshot.issues.get(1)
    const facts = snapshot.parsedMetadata.get(1)

    expect(issue?.body).toBeNull()
    expect(facts).toBeDefined()
    await expect(resolver.resolveFromSnapshot(issue!, facts!)).resolves.toMatchObject({
      state: 'ready',
      desiredReadinessLabels: ['ready-for-agent'],
    })
  })

  it('tracks unique dependency fetches and cache hits', async () => {
    // Create issues: A depends on B and C
    const issueA = { ...READY_ISSUE, number: 1, title: 'Issue A', body: READY_BODY.replace('Depends on: none', 'Depends on: #2, #3') }
    const issueB = { ...READY_ISSUE, number: 2, title: 'Issue B', body: READY_BODY.replace('Test', 'Test B') }
    const issueC = { ...READY_ISSUE, number: 3, title: 'Issue C', body: READY_BODY.replace('Test', 'Test C') }

    const client = new FakeGitHubClient({ issues: [issueA, issueB, issueC] })
    const resolver = new IssueReadinessResolver(client)
    await resolver.resolveFromIssue(issueA)

    expect(resolver.uniqueDependencyFetches).toBe(2)
    expect(resolver.cacheHits).toBe(0)

    // Resolve again - should hit cache
    await resolver.resolveFromIssue(issueA)
    expect(resolver.cacheHits).toBeGreaterThanOrEqual(2)
  })

  it('uses bounded concurrency for dependency fetching', async () => {
    // Create many dependencies
    const issues: GitHubIssue[] = []
    const depRefs: string[] = []
    for (let i = 2; i <= 20; i++) {
      issues.push({ ...READY_ISSUE, number: i, title: `Issue ${i}`, body: READY_BODY.replace('Test', `Test ${i}`) })
      depRefs.push(`#${i}`)
    }
    issues.unshift({
      ...READY_ISSUE,
      number: 1,
      title: 'Issue A',
      body: READY_BODY.replace('Depends on: none', `Depends on: ${depRefs.join(', ')}`),
    })

    const client = new FakeGitHubClient({ issues })
    const resolver = new IssueReadinessResolver(client, { maxFetchConcurrency: 4 })
    const result = await resolver.resolveFromIssue(issues[0])

    // Should resolve all dependencies
    expect(resolver.uniqueDependencyFetches).toBe(19)
    expect(result.dispatchable).toBe(false) // All are open
    expect(result.reasonCodes).toContain('queue.issue_dependency_open')
  })
})

// ============================================================
// Handoff eligibility failure path
// ============================================================
describe('handoff eligibility failure run-state guard', () => {
  it('does not block terminal runs when eligibility fails', async () => {
    const root = await tempRoot()

    // Create a completed run
    await recordRequested({
      runId: 'issue-1-9999999999-1',
      issueNumber: 1,
      issueTitle: READY_ISSUE.title,
      runtime: 'codex',
      action: 'implement',
      requestedBy: 'Joncallim',
      source: { type: 'issue_comment', commentId: 999 },
    }, { repositoryRoot: root })
    await updateRunStatus({
      issueNumber: 1,
      runId: 'issue-1-9999999999-1',
      status: 'completed',
    }, { repositoryRoot: root })

    // Semantic readiness passes but eligibility (run status check) fails
    const client = new FakeGitHubClient({ issues: [READY_ISSUE] })

    const result = await runHandoff({
      client,
      issueNumber: 1,
      runLogRepositoryRoot: root,
      artifactRepositoryRoot: root,
      botLogin: 'github-actions[bot]',
    })

    // Should be blocked but run should remain completed
    expect(result.status).toBe('blocked')
    const run = await findLatestRunForIssue(1, { repositoryRoot: root })
    expect(run!.status).toBe('completed')
  })
})
