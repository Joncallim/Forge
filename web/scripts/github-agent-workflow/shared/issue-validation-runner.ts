/**
 * Readiness projection runner.
 *
 * Synchronizes GitHub labels and marker comments to reflect the computed
 * semantic readiness state. Labels are projections only — never authority.
 *
 * This runner is called by:
 *   - issue-intake (validate-issue.ts) for target-only projection
 *   - full reconciliation workflow for bulk projection
 */

import type { GitHubComment, GitHubClient, GitHubIssue } from '../io/github-client'
import { diffManagedLabels } from '../core/labels'
import {
  ISSUE_VALIDATION_MARKER_PREFIX,
  validateIssue,
} from '../core/issue-validation'
import { IssueReadinessResolver } from './issue-readiness-resolver'
import { syncReadinessLabels } from './readiness-projection'
import type { IssueValidationResult } from '../contracts/issue-validation-result'
import type { IssueReadinessResult } from '../contracts/issue-readiness-result'
import { ISSUE_READINESS_MANAGED_LABELS } from '../contracts/common'

type RunIssueValidationOptions = {
  botLogin: string
}

type ValidationExecutionResult = {
  existingMarkerComment: GitHubComment | null
  result: IssueValidationResult
  readinessResult: IssueReadinessResult | null
}

function normalizeBotLogin(botLogin: string): string {
  return botLogin.trim().toLowerCase()
}

function markerCommentForIssue(comments: GitHubComment[], botLogin: string): GitHubComment | null {
  const normalized = normalizeBotLogin(botLogin)
  return comments.find((comment) => (
    comment.authorLogin.trim().toLowerCase() === normalized
    && comment.body.startsWith(ISSUE_VALIDATION_MARKER_PREFIX)
  )) ?? null
}

async function syncComment(
  client: GitHubClient,
  issue: GitHubIssue,
  result: IssueValidationResult,
  readinessResult: IssueReadinessResult | null,
  existingMarkerComment: GitHubComment | null,
  botLogin: string,
): Promise<void> {
  // Build comment from readiness result if available, otherwise from structural validation
  let commentBody: string | null = null

  if (readinessResult) {
    if (readinessResult.dispatchable) {
      commentBody = buildReadinessComment(readinessResult, 'ready')
    } else if (readinessResult.state !== 'closed') {
      commentBody = buildReadinessComment(readinessResult, 'blocked')
    }
  } else if (!result.valid) {
    commentBody = result.commentBody
  }

  if (commentBody === null) {
    if (existingMarkerComment) {
      const readyBody = [
        ISSUE_VALIDATION_MARKER_PREFIX,
        '## FORGE issue validation',
        '',
        readinessResult?.dispatchable
          ? 'This issue is semantically ready for agent work.'
          : 'This issue has been validated.',
      ].join('\n')
      await client.upsertComment(issue.number, {
        markerPrefix: ISSUE_VALIDATION_MARKER_PREFIX,
        botLogin,
        body: readyBody,
      })
    }
    return
  }

  if (existingMarkerComment?.body === commentBody) return
  await client.upsertComment(issue.number, {
    markerPrefix: ISSUE_VALIDATION_MARKER_PREFIX,
    botLogin,
    body: commentBody,
  })
}

export async function runIssueValidation(
  client: GitHubClient,
  issue: GitHubIssue,
  options: RunIssueValidationOptions,
): Promise<ValidationExecutionResult> {
  // Structural validation
  const result = validateIssue({
    number: issue.number,
    title: issue.title,
    body: issue.body,
  })

  // Semantic readiness resolution
  const resolver = new IssueReadinessResolver(client)
  let readinessResult: IssueReadinessResult | null = null
  try {
    readinessResult = await resolver.resolveFromIssue(issue)
  } catch {
    readinessResult = null
  }

  const comments = await client.listComments(issue.number)
  const existingMarkerComment = markerCommentForIssue(comments, options.botLogin)

  // Sync readiness labels
  if (readinessResult) {
    // Use shared projection writer
    const projection = await syncReadinessLabels(client, issue, readinessResult)

    // If projection failed for a ready promotion, try final fresh re-resolution
    if (!projection.success && readinessResult.dispatchable) {
      // A stale blocker may have been present; perform fresh re-resolution
      try {
        const freshResolver = new IssueReadinessResolver(client)
        const freshIssue = await client.getIssue(issue.number)
        const freshResult = await freshResolver.resolveFromIssue(freshIssue)

        if (freshResult.dispatchable) {
          // Re-attempt projection with fresh result
          const retryProjection = await syncReadinessLabels(client, freshIssue, freshResult)
          if (retryProjection.success && retryProjection.addedLabels.includes('ready-for-agent')) {
            readinessResult = freshResult
          }
        }
      } catch {
        // Fresh re-resolution failed; keep original result
      }
    }
  } else {
    const diff = diffManagedLabels(issue.labels, result.recommendedLabels, ISSUE_READINESS_MANAGED_LABELS)
    for (const label of diff.toAdd) {
      await client.addLabel(issue.number, label)
    }
    for (const label of diff.toRemove) {
      await client.removeLabel(issue.number, label)
    }
  }

  // Sync marker comment
  await syncComment(client, issue, result, readinessResult, existingMarkerComment, options.botLogin)

  return {
    existingMarkerComment,
    result,
    readinessResult,
  }
}

function buildReadinessComment(readinessResult: IssueReadinessResult, status: 'ready' | 'blocked'): string {
  const lines = [
    ISSUE_VALIDATION_MARKER_PREFIX,
    '## FORGE issue validation',
    '',
  ]

  if (status === 'ready') {
    lines.push('This issue is semantically ready for agent work.')
  } else {
    lines.push('This issue is not semantically dispatchable.')
    lines.push('')
    lines.push('| Reason | Detail |')
    lines.push('| --- | --- |')
    for (const blocker of readinessResult.blockers) {
      lines.push(`| \`${blocker.reasonCode}\` | ${blocker.detail} |`)
    }
  }

  lines.push('')
  lines.push('> Readiness labels are projections, not authority. Command, dispatch, and handoff always re-resolve current semantic truth.')

  return lines.join('\n')
}
