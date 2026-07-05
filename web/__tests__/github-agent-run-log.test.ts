import { describe, expect, it } from 'vitest'
import { agentRunRecordSchema } from '@/scripts/github-agent-workflow/contracts/agent-run-record'
import { runIdSchema } from '@/scripts/github-agent-workflow/contracts/common'

describe('agent run log contracts', () => {
  it('round-trips strict records and fills the checkpoint default', () => {
    const parsed = agentRunRecordSchema.parse({
      runId: 'issue-141-1234567890-1',
      issueNumber: 141,
      issueTitle: '[EPIC] GitHub-native agent workflow',
      runtime: 'dry-run',
      action: 'implement',
      requestedBy: 'Joncallim',
      status: 'requested',
      branchName: 'agent/issue-141-foundation',
      blockedReason: null,
      handoffArtifacts: null,
      source: {
        type: 'issue_comment',
        commentId: 99887766,
      },
      prNumber: null,
      validationSummary: {
        issueType: 'epic',
        valid: true,
        missingSections: [],
      },
      createdAt: '2026-07-05T10:00:00.000Z',
      updatedAt: '2026-07-05T10:00:00.000Z',
      events: [
        {
          at: '2026-07-05T10:00:00.000Z',
          status: 'requested',
          message: 'Run record created from an accepted issue command.',
        },
      ],
    })

    const roundTrip = agentRunRecordSchema.parse(JSON.parse(JSON.stringify(parsed)))

    expect(parsed.checkpointIssueRef).toBe(32)
    expect(roundTrip).toEqual(parsed)
  })

  it('rejects date-based run ids that do not match the GitHub/local pattern', () => {
    expect(runIdSchema.safeParse('issue-141-20260703-001').success).toBe(false)
    expect(runIdSchema.safeParse('issue-141-local-deadbee').success).toBe(true)
  })

  it('rejects secret-shaped or transcript-shaped extra fields', () => {
    const withTokenUsage = agentRunRecordSchema.safeParse({
      runId: 'issue-141-1234567890-2',
      issueNumber: 141,
      issueTitle: '[EPIC] GitHub-native agent workflow',
      runtime: 'codex',
      action: 'handoff',
      requestedBy: 'Joncallim',
      status: 'handed-off',
      branchName: null,
      blockedReason: null,
      handoffArtifacts: {
        handoffPath: '.forge/runs/141/issue-141-1234567890-2/handoff.md',
        promptPath: '.forge/runs/141/issue-141-1234567890-2/prompt.md',
        metadataPath: '.forge/runs/141/issue-141-1234567890-2/metadata.json',
      },
      source: {
        type: 'manual',
        commentId: null,
      },
      prNumber: null,
      validationSummary: null,
      createdAt: '2026-07-05T10:05:00.000Z',
      updatedAt: '2026-07-05T10:06:00.000Z',
      events: [
        {
          at: '2026-07-05T10:06:00.000Z',
          status: 'handed-off',
          message: 'Generated runtime handoff artifacts.',
          transcriptPath: '.forge/runs/141/transcript.md',
        },
      ],
      tokenUsage: 1234,
    })

    expect(withTokenUsage.success).toBe(false)
  })
})
