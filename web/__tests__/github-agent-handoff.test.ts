import { execFile as execFileCallback } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'

import { runHandoff } from '@/scripts/github-agent-workflow/handoff'
import {
  findLatestRunForIssue,
  recordRequested,
  updateRunStatus,
} from '@/scripts/github-agent-workflow/io/agent-run-log'
import { FakeGitHubClient } from '@/scripts/github-agent-workflow/io/fake-github-client'
import type { AgentRuntime } from '@/scripts/github-agent-workflow/contracts/common'
import type { GitHubIssue } from '@/scripts/github-agent-workflow/io/github-client'

const tempRoots: string[] = []
const execFile = promisify(execFileCallback)

const SECRET_TOKEN = `ghp_${'a'.repeat(40)}`
const READY_ISSUE: GitHubIssue = {
  number: 153,
  title: `[FEATURE] Controlled handoff ${SECRET_TOKEN}`,
  body: [
    '## Acceptance Criteria',
    '',
    '- [ ] Claude handoff can be generated.',
    '- [ ] Codex handoff can be generated.',
    '',
    `Do not leak token=${SECRET_TOKEN}`,
  ].join('\n'),
  labels: ['ready-for-agent'],
  state: 'open',
  htmlUrl: 'https://github.com/Joncallim/Forge/issues/153',
  authorLogin: 'Joncallim',
  isPullRequest: false,
}

async function tempRepositoryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-handoff-'))
  tempRoots.push(root)
  return root
}

function localPath(root: string, artifactPath: string): string {
  return path.join(root, ...artifactPath.split('/'))
}

async function seedRun(root: string, runtime: AgentRuntime, status: 'requested' | 'handed-off' = 'handed-off'): Promise<void> {
  await recordRequested({
    runId: 'issue-153-1234567890-1',
    issueNumber: 153,
    issueTitle: READY_ISSUE.title,
    runtime,
    action: 'implement',
    requestedBy: 'Joncallim',
    source: { type: 'issue_comment', commentId: 15301 },
  }, {
    repositoryRoot: root,
    now: new Date('2026-07-06T01:00:00.000Z'),
  })
  if (status === 'handed-off') {
    await updateRunStatus({
      issueNumber: 153,
      runId: 'issue-153-1234567890-1',
      status: 'handed-off',
      branchName: 'agent/issue-153-controlled-handoff',
    }, {
      repositoryRoot: root,
      now: new Date('2026-07-06T01:02:00.000Z'),
    })
  }
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('agent handoff', () => {
  it.each([
    ['claude-code', 'Claude Code'],
    ['codex', 'strongest available Codex model/profile with highest reasoning'],
    ['dry-run', 'Dry run only'],
  ] as const)('generates %s handoff artifacts without starting a runtime', async (runtime, expectedInstruction) => {
    const root = await tempRepositoryRoot()
    await seedRun(root, runtime)
    const client = new FakeGitHubClient({ issues: [READY_ISSUE] })

    const result = await runHandoff({
      client,
      issueNumber: 153,
      runLogRepositoryRoot: root,
      artifactRepositoryRoot: root,
      botLogin: 'github-actions[bot]',
      now: new Date('2026-07-06T01:05:00.000Z'),
      env: { GITHUB_ACTIONS: 'true' } as unknown as NodeJS.ProcessEnv,
    })

    expect(result.status).toBe('generated')
    expect(result.artifacts?.handoffPath).toBe('.forge/runs/153/issue-153-1234567890-1/handoff.md')
    expect(result.artifacts?.promptPath).toBe('.forge/runs/153/issue-153-1234567890-1/prompt.md')
    expect(result.artifacts?.metadataPath).toBe('.forge/runs/153/issue-153-1234567890-1/metadata.json')

    const handoff = await readFile(localPath(root, result.artifacts!.handoffPath), 'utf8')
    const prompt = await readFile(localPath(root, result.artifacts!.promptPath), 'utf8')
    const metadataRaw = await readFile(localPath(root, result.artifacts!.metadataPath), 'utf8')
    const metadata = JSON.parse(metadataRaw)

    expect(handoff).toContain(expectedInstruction)
    expect(handoff).toContain('Expected PR Contract')
    expect(prompt).toContain('Closes #153')
    expect(prompt).toContain('Do not claim validation that was not run')
    expect(prompt).not.toContain(SECRET_TOKEN)
    expect(metadataRaw).not.toContain(SECRET_TOKEN)
    expect(metadata).toMatchObject({
      runId: 'issue-153-1234567890-1',
      issueNumber: 153,
      runtime,
      branchName: 'agent/issue-153-controlled-handoff',
      sourceIssue: { type: 'github-issue', number: 153 },
      safety: { containsSecrets: false, containsTranscripts: false },
    })

    const run = await findLatestRunForIssue(153, { repositoryRoot: root })
    expect(run).toMatchObject({
      status: 'handed-off',
      handoffArtifacts: result.artifacts,
    })
    expect(run?.events.at(-1)?.message).toContain('No runtime execution was started')
    expect((await client.listComments(153))[0]?.body).toContain('uploaded by this workflow run')
  })

  it('refuses handoff when the issue is not ready', async () => {
    const root = await tempRepositoryRoot()
    await seedRun(root, 'codex', 'requested')
    const issue = { ...READY_ISSUE, labels: [] }
    const client = new FakeGitHubClient({ issues: [issue] })

    const result = await runHandoff({
      client,
      issueNumber: 153,
      runLogRepositoryRoot: root,
      artifactRepositoryRoot: root,
      botLogin: 'github-actions[bot]',
    })

    expect(result.status).toBe('blocked')
    expect(result.blockedReason).toContain('ready-for-agent')
    expect((await client.getIssue(153)).labels).toContain('agent-blocked')
    expect((await findLatestRunForIssue(153, { repositoryRoot: root }))?.status).toBe('blocked')
  })

  it('refuses handoff when the latest run is not valid for handoff', async () => {
    const root = await tempRepositoryRoot()
    await seedRun(root, 'codex', 'requested')
    await updateRunStatus({
      issueNumber: 153,
      runId: 'issue-153-1234567890-1',
      status: 'running',
    }, { repositoryRoot: root })
    const client = new FakeGitHubClient({ issues: [READY_ISSUE] })

    const result = await runHandoff({
      client,
      issueNumber: 153,
      runLogRepositoryRoot: root,
      artifactRepositoryRoot: root,
      botLogin: 'github-actions[bot]',
    })

    expect(result.status).toBe('blocked')
    expect(result.blockedReason).toContain('not `requested` or `handed-off`')
  })

  it('uses git-ignored nested artifact paths', async () => {
    const repositoryRoot = path.resolve(process.cwd(), '..')

    await expect(execFile('git', [
      'check-ignore',
      '--quiet',
      '--no-index',
      '.forge/runs/153/issue-153-1234567890-1/handoff.md',
    ], { cwd: repositoryRoot })).resolves.toBeDefined()
  })
})
