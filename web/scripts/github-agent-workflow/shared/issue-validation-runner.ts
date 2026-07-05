import type { GitHubComment, GitHubClient, GitHubIssue } from '../io/github-client'
import { diffManagedLabels } from '../core/labels'
import {
  buildReadyForAgentComment,
  ISSUE_INTAKE_MANAGED_LABELS,
  ISSUE_VALIDATION_MARKER_PREFIX,
  validateIssue,
} from '../core/issue-validation'
import type { IssueValidationResult } from '../contracts/issue-validation-result'

type RunIssueValidationOptions = {
  botLogin: string
}

type ValidationExecutionResult = {
  existingMarkerComment: GitHubComment | null
  result: IssueValidationResult
}

function normalizeBotLogin(botLogin: string): string {
  return botLogin.trim().toLowerCase()
}

function markerCommentForIssue(comments: GitHubComment[], botLogin: string): GitHubComment | null {
  const normalizedBotLogin = normalizeBotLogin(botLogin)
  return comments.find((comment) => (
    comment.authorLogin.trim().toLowerCase() === normalizedBotLogin &&
    comment.body.startsWith(ISSUE_VALIDATION_MARKER_PREFIX)
  )) ?? null
}

async function syncLabels(client: GitHubClient, issue: GitHubIssue, result: IssueValidationResult): Promise<void> {
  const diff = diffManagedLabels(issue.labels, result.recommendedLabels, ISSUE_INTAKE_MANAGED_LABELS)
  for (const label of diff.toAdd) {
    await client.addLabel(issue.number, label)
  }
  for (const label of diff.toRemove) {
    await client.removeLabel(issue.number, label)
  }
}

async function syncComment(
  client: GitHubClient,
  issue: GitHubIssue,
  result: IssueValidationResult,
  existingMarkerComment: GitHubComment | null,
  botLogin: string,
): Promise<void> {
  if (!result.valid) {
    if (existingMarkerComment?.body === result.commentBody) return
    if (result.commentBody === null) return
    await client.upsertComment(issue.number, {
      markerPrefix: result.markerPrefix,
      botLogin,
      body: result.commentBody,
    })
    return
  }

  if (!existingMarkerComment) return
  const readyBody = buildReadyForAgentComment(result)
  if (existingMarkerComment.body === readyBody) return
  await client.upsertComment(issue.number, {
    markerPrefix: result.markerPrefix,
    botLogin,
    body: readyBody,
  })
}

export async function runIssueValidation(
  client: GitHubClient,
  issue: GitHubIssue,
  options: RunIssueValidationOptions,
): Promise<ValidationExecutionResult> {
  const result = validateIssue({
    number: issue.number,
    title: issue.title,
    body: issue.body,
  })

  const comments = await client.listComments(issue.number)
  const existingMarkerComment = markerCommentForIssue(comments, options.botLogin)

  await syncLabels(client, issue, result)
  await syncComment(client, issue, result, existingMarkerComment, options.botLogin)

  return { existingMarkerComment, result }
}
