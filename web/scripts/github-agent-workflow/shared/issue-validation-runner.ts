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

/**
 * Sync readiness projection labels for an issue.
 *
 * Safe ordering:
 * - ready → non-ready: remove ready-for-agent before adding blocking label
 * - non-ready → ready: remove blocking labels before adding ready-for-agent last
 * - GitHub write failure must never leave a false-positive ready label
 * - Labels are guaranteed mutually exclusive (exactly one readiness label at a time)
 */
async function syncReadinessLabels(
  client: GitHubClient,
  issue: GitHubIssue,
  readinessResult: IssueReadinessResult,
): Promise<void> {
  const currentLabels = issue.labels
  const desiredLabels = readinessResult.desiredReadinessLabels

  // Determine current readiness labels
  const currentReadinessLabels = currentLabels.filter((l) =>
    ISSUE_READINESS_MANAGED_LABELS.includes(l as typeof ISSUE_READINESS_MANAGED_LABELS[number]),
  )

  // If nothing to change, skip
  if (setsEqual(new Set(currentReadinessLabels), new Set(desiredLabels))) return

  // Determine what to remove and add
  const toRemove = currentReadinessLabels.filter((l) => !desiredLabels.includes(l as typeof ISSUE_READINESS_MANAGED_LABELS[number]))
  const toAdd = desiredLabels.filter((l) => !currentReadinessLabels.includes(l))

  // Step 1: If transitioning ready to non-ready, remove ready-for-agent FIRST
  if (currentReadinessLabels.includes('ready-for-agent') && !desiredLabels.includes('ready-for-agent')) {
    await client.removeLabel(issue.number, 'ready-for-agent')
  }

  // Step 2: Remove ALL stale readiness labels (converge to exact set)
  for (const label of toRemove) {
    if (label !== 'ready-for-agent') {
      await client.removeLabel(issue.number, label)
    }
  }

  // Step 3: Add non-ready labels (blocking/clarification/tracking)
  for (const label of toAdd) {
    if (label !== 'ready-for-agent') {
      await client.addLabel(issue.number, label)
    }
  }

  // Step 4: For non-ready to ready, add ready-for-agent LAST
  // If any blocker removal failed, we must NOT add ready-for-agent
  if (!currentReadinessLabels.includes('ready-for-agent') && desiredLabels.includes('ready-for-agent')) {
    // Verify no stale blocker labels remain before adding ready
    const labelsAfter = (await client.getIssue(issue.number)).labels
    const staleBlockers = ['needs-clarification', 'dependency-blocked', 'tracking-only'].filter(
      (l) => labelsAfter.includes(l),
    )
    if (staleBlockers.length > 0) {
      throw new Error(
        `Cannot add ready-for-agent: stale blocker labels remain: ${staleBlockers.join(', ')}. ` +
        `Reason: ${readinessResult.reasonCodes.join(', ')}`,
      )
    }
    await client.addLabel(issue.number, 'ready-for-agent')
  }
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

  // Sync readiness labels (use readiness result if available, otherwise structural)
  if (readinessResult) {
    await syncReadinessLabels(client, issue, readinessResult)
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

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false
  for (const item of a) {
    if (!b.has(item)) return false
  }
  return true
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
