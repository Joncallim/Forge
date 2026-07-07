import { runMain } from './cli/entrypoint'
import { prContractReportSchema, type PRContractReport, type PrContractCriterion } from './contracts/pr-contract-report'
import { extractAcceptanceCriteria } from './core/acceptance-criteria'
import {
  extractPrContractSection,
  extractSourceIssueReference,
  renderPrContractTemplate,
} from './core/pr-contract'
import { readGitHubEvent } from './io/event'
import { RestGitHubClient, type GitHubClient, type GitHubIssue, type GitHubPullRequest } from './io/github-client'

export const PR_CONTRACT_MARKER_PREFIX = '<!-- forge-pr-contract-check -->'

type PullRequestEvent = {
  pull_request?: {
    number?: unknown
  }
}

type ValidationEntry = Readonly<{
  raw: string
  normalized: string
  evidence: string | null
}>

function parsePositivePullRequestNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value.trim())
  return null
}

function pullRequestNumberFromEventOrEnv(event: PullRequestEvent, env: NodeJS.ProcessEnv): number {
  const candidates = [
    env.PR_NUMBER,
    env.PULL_REQUEST_NUMBER,
    event.pull_request?.number,
  ]
  for (const candidate of candidates) {
    const parsed = parsePositivePullRequestNumber(candidate)
    if (parsed !== null) return parsed
  }
  throw new Error('PR contract check requires a positive pull request number from PR_NUMBER, PULL_REQUEST_NUMBER, or GITHUB_EVENT_PATH.')
}

function botLoginFromEnv(env: NodeJS.ProcessEnv): string {
  return env.GITHUB_BOT_LOGIN?.trim() || 'github-actions[bot]'
}

async function readOptionalEvent(env: NodeJS.ProcessEnv): Promise<PullRequestEvent> {
  if (!env.GITHUB_EVENT_PATH?.trim()) return {}
  return await readGitHubEvent<PullRequestEvent>(env)
}

function normalizeForMatch(text: string): string {
  return text
    .toLowerCase()
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[[^\]]+\]\([^)]+\)/g, (match) => match.replace(/\]\([^)]+\)/, '').replace('[', ''))
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function stripBullet(line: string): string {
  return line
    .replace(/^\s*[-*]\s*/, '')
    .replace(/^\[[ xX]\]\s*/, '')
    .trim()
}

function extractEvidence(line: string): string | null {
  const stripped = stripBullet(line)
  for (const separator of ['—', ' - ', ': ']) {
    const index = stripped.indexOf(separator)
    if (index >= 0) {
      const evidence = stripped.slice(index + separator.length).trim()
      return evidence === '' ? null : evidence
    }
  }
  return null
}

function validationEntries(sectionBody: string): ValidationEntry[] {
  return sectionBody
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line) => ({
      raw: stripBullet(line),
      normalized: normalizeForMatch(stripBullet(line)),
      evidence: extractEvidence(line),
    }))
}

function isWeakEvidence(evidence: string | null): boolean {
  if (evidence === null) return true
  const normalized = normalizeForMatch(evidence)
  if (normalized.length < 8) return true
  return [
    'done',
    'implemented',
    'yes',
    'no',
    'na',
    'n a',
    'none',
    'todo',
    'tbd',
    'evidence notes',
    'evidence note',
    'see summary',
    'covered',
    'verified',
    'passes',
  ].includes(normalized)
}

export function classifyAcceptanceCriterion(criterion: string, entries: readonly ValidationEntry[]): PrContractCriterion {
  const normalizedCriterion = normalizeForMatch(criterion)
  const entry = entries.find((candidate) => (
    candidate.normalized.includes(normalizedCriterion)
    || normalizedCriterion.includes(candidate.normalized)
  ))

  if (!entry) {
    return {
      text: criterion,
      status: 'missing',
      evidence: null,
    }
  }

  return {
    text: criterion,
    status: isWeakEvidence(entry.evidence) ? 'needs-review' : 'claimed',
    evidence: entry.evidence,
  }
}

function summaryFor(criteria: readonly PrContractCriterion[]): PRContractReport['summary'] {
  return {
    claimed: criteria.filter((criterion) => criterion.status === 'claimed').length,
    missing: criteria.filter((criterion) => criterion.status === 'missing').length,
    needsReview: criteria.filter((criterion) => criterion.status === 'needs-review').length,
  }
}

function escapeTableCell(value: string | null): string {
  return (value ?? 'n/a')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, '<br>')
}

export function renderPrContractReport(report: Omit<PRContractReport, 'commentBody'>): string {
  const lines = [
    PR_CONTRACT_MARKER_PREFIX,
    '',
    'PR contract check.',
    '',
    `- Pull request: #${report.pullRequestNumber}`,
    `- Draft: ${report.draft ? 'yes' : 'no'}`,
  ]

  if (report.linkedIssueNumber === null) {
    lines.push(
      '- Linked issue: missing',
      '',
      'Add a `Source Issue` section with one supported link phrase: `Closes #123`, `Fixes #123`, `Resolves #123`, or `Issue: #123`.',
      '',
      'Use this contract:',
      '',
      renderPrContractTemplate().trim(),
      '',
      'This is review support, not proof of correctness.',
    )
    return lines.join('\n')
  }

  lines.push(
    `- Linked issue: #${report.linkedIssueNumber} — ${report.linkedIssueTitle ?? 'untitled'}`,
    `- Summary: ${report.summary.claimed} claimed, ${report.summary.missing} missing, ${report.summary.needsReview} needs review`,
    '',
  )

  if (report.criteria.length === 0) {
    lines.push('No acceptance criteria were found on the linked issue.', '')
  } else {
    lines.push(
      '| Criterion | Status | Evidence / notes |',
      '| --- | --- | --- |',
      ...report.criteria.map((criterion) => (
        `| ${escapeTableCell(criterion.text)} | ${criterion.status} | ${escapeTableCell(criterion.evidence)} |`
      )),
      '',
    )
  }

  lines.push('This is review support, not proof of correctness.')
  return lines.join('\n')
}

export function buildPrContractReport(input: {
  pullRequest: GitHubPullRequest
  linkedIssue: GitHubIssue | null
  now?: Date
}): PRContractReport {
  const reference = extractSourceIssueReference(input.pullRequest.body)
  const acceptanceCriteria = input.linkedIssue ? extractAcceptanceCriteria(input.linkedIssue.body) : []
  const entries = validationEntries(extractPrContractSection(input.pullRequest.body, 'Acceptance Criteria Validation'))
  const criteria = acceptanceCriteria.map((criterion) => classifyAcceptanceCriterion(criterion, entries))
  const summary = summaryFor(criteria)
  const generatedAt = (input.now ?? new Date()).toISOString()
  const withoutComment = {
    pullRequestNumber: input.pullRequest.number,
    pullRequestTitle: input.pullRequest.title,
    draft: input.pullRequest.draft,
    linkedIssueNumber: reference?.issueNumber ?? null,
    linkedIssueTitle: input.linkedIssue?.title ?? null,
    criteria,
    summary,
    generatedAt,
  }
  const commentBody = renderPrContractReport(withoutComment)

  return prContractReportSchema.parse({
    ...withoutComment,
    commentBody,
  })
}

export async function runPrContractCheck(input: {
  client: GitHubClient
  pullRequestNumber: number
  botLogin: string
  now?: Date
}): Promise<PRContractReport> {
  const pullRequest = await input.client.getPullRequest(input.pullRequestNumber)
  const reference = extractSourceIssueReference(pullRequest.body)
  const linkedIssue = reference ? await input.client.getIssue(reference.issueNumber) : null
  const report = buildPrContractReport({ pullRequest, linkedIssue, now: input.now })

  await input.client.upsertComment(pullRequest.number, {
    markerPrefix: PR_CONTRACT_MARKER_PREFIX,
    botLogin: input.botLogin,
    body: report.commentBody,
  })

  return report
}

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const event = await readOptionalEvent(env)
  const client = RestGitHubClient.fromEnv(env)
  const report = await runPrContractCheck({
    client,
    pullRequestNumber: pullRequestNumberFromEventOrEnv(event, env),
    botLogin: botLoginFromEnv(env),
  })

  console.info(JSON.stringify(report, null, 2))
}

runMain(import.meta.url, () => main())
