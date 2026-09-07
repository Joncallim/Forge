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
import {
  ISSUE_VALIDATION_MARKER_PREFIX,
  validateIssue,
} from '../core/issue-validation'
import { IssueReadinessResolver } from './issue-readiness-resolver'
import { syncReadinessLabels } from './readiness-projection'
import type { IssueValidationResult } from '../contracts/issue-validation-result'
import type { IssueReadinessResult } from '../contracts/issue-readiness-result'

type RunIssueValidationOptions = {
  botLogin: string
  /**
   * Graph-changing issue events need a marker refresh even if labels are
   * already correct. Label self-heal events can avoid a full comment-history
   * scan unless this run actually changed the readiness projection.
   */
  markerCommentPolicy?: 'always' | 'on-projection-change'
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
  // The event payload is only a routing hint. Always obtain the live issue
  // before calculating semantic authority or mutating its label projection.
  const projectionIssue = await client.getIssue(issue.number)

  // Structural validation
  const result = validateIssue({
    number: projectionIssue.number,
    title: projectionIssue.title,
    body: projectionIssue.body,
  })

  // Resolve the same freshly fetched issue for every state, including stale
  // blocked event payloads that have become ready since delivery.
  const readinessResult = await new IssueReadinessResolver(client).resolveFromIssue(projectionIssue)

  const projection = await syncReadinessLabels(client, projectionIssue, readinessResult)
  if (!projection.success) {
    throw new Error(projection.error ?? `Failed to project readiness labels for #${issue.number}.`)
  }

  const projectionChanged = projection.addedLabels.length > 0 || projection.removedLabels.length > 0
  const shouldSyncMarkerComment = options.markerCommentPolicy !== 'on-projection-change' || projectionChanged
  let existingMarkerComment: GitHubComment | null = null
  if (shouldSyncMarkerComment) {
    const comments = await client.listComments(issue.number)
    existingMarkerComment = markerCommentForIssue(comments, options.botLogin)
    await syncComment(client, projectionIssue, result, readinessResult, existingMarkerComment, options.botLogin)
  }

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
