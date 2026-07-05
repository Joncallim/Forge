import type { GitHubIssue } from '../io/github-client'
import { issueValidationResultSchema, type IssueValidationResult } from '../contracts/issue-validation-result'
import type { IssueType } from '../contracts/common'
import { parseSections } from './sections'

export const ISSUE_VALIDATION_MARKER_PREFIX = '<!-- forge-issue-validation -->'

export const ISSUE_INTAKE_MANAGED_LABELS = Object.freeze([
  'ready-for-agent',
  'needs-clarification',
] as const)

type IssueTemplateDefinition = Readonly<{
  displayName: string
  requiredSections: readonly string[]
  titlePrefix: string
}>

const ISSUE_TEMPLATE_DEFINITIONS: Readonly<Record<'feature' | 'bug' | 'other' | 'epic', IssueTemplateDefinition>> = {
  feature: {
    displayName: 'Feature',
    requiredSections: ['problem statement', 'desired outcome', 'user story', 'requirements', 'acceptance criteria'],
    titlePrefix: '[FEATURE]',
  },
  bug: {
    displayName: 'Bug',
    requiredSections: ['bug summary', 'current behaviour', 'expected behaviour', 'reproduction steps', 'impact', 'severity', 'acceptance criteria'],
    titlePrefix: '[BUG]',
  },
  other: {
    displayName: 'Other',
    requiredSections: ['issue type', 'context', 'desired outcome', 'tasks', 'acceptance criteria'],
    titlePrefix: '[OTHER]',
  },
  epic: {
    displayName: 'Epic',
    requiredSections: ['issue type', 'context', 'desired outcome', 'tasks', 'acceptance criteria'],
    titlePrefix: '[EPIC]',
  },
}

type ValidationInput = Pick<GitHubIssue, 'number' | 'title' | 'body'> | {
  number: number
  title: string
  body: string | null
}

function normalizeTitle(title: string): string {
  return title.trim()
}

function issueTypeFromTitle(title: string): IssueType {
  const normalized = normalizeTitle(title).toUpperCase()
  if (normalized.startsWith('[FEATURE]')) return 'feature'
  if (normalized.startsWith('[BUG]')) return 'bug'
  if (normalized.startsWith('[OTHER]')) return 'other'
  if (normalized.startsWith('[EPIC]')) return 'epic'
  return 'unknown'
}

function looksLikeFeature(sections: Readonly<Record<string, string>>): boolean {
  return 'user story' in sections || 'problem statement' in sections || 'requirements' in sections
}

function looksLikeBug(sections: Readonly<Record<string, string>>): boolean {
  return 'bug summary' in sections || 'current behaviour' in sections || 'reproduction steps' in sections
}

function looksLikeOther(sections: Readonly<Record<string, string>>): boolean {
  return 'issue type' in sections || 'context' in sections || 'tasks' in sections
}

function issueTypeFromSections(sections: Readonly<Record<string, string>>): IssueType {
  if (looksLikeBug(sections)) return 'bug'
  if (looksLikeFeature(sections)) return 'feature'
  if (looksLikeOther(sections)) {
    const issueTypeValue = sections['issue type']?.trim().toLowerCase() ?? ''
    return issueTypeValue.includes('epic') ? 'epic' : 'other'
  }
  return 'unknown'
}

export function detectIssueType(input: { title: string; body: string | null }): IssueType {
  const fromTitle = issueTypeFromTitle(input.title)
  if (fromTitle !== 'unknown') return fromTitle
  return issueTypeFromSections(parseSections(input.body ?? ''))
}

export function requiredSectionsForIssueType(issueType: IssueType): readonly string[] {
  switch (issueType) {
    case 'feature':
    case 'bug':
    case 'other':
    case 'epic':
      return ISSUE_TEMPLATE_DEFINITIONS[issueType].requiredSections
    default:
      return []
  }
}

function titlePrefixSummary(): string {
  return ['[FEATURE]', '[BUG]', '[OTHER]', '[EPIC]'].join(', ')
}

function displayName(issueType: IssueType): string {
  switch (issueType) {
    case 'feature':
    case 'bug':
    case 'other':
    case 'epic':
      return ISSUE_TEMPLATE_DEFINITIONS[issueType].displayName
    default:
      return 'Unknown'
  }
}

function titlePrefix(issueType: IssueType): string {
  switch (issueType) {
    case 'feature':
    case 'bug':
    case 'other':
    case 'epic':
      return ISSUE_TEMPLATE_DEFINITIONS[issueType].titlePrefix
    default:
      return titlePrefixSummary()
  }
}

function formatSectionName(section: string): string {
  return section.replace(/\b\w/g, (letter) => letter.toUpperCase())
}

export function buildNeedsClarificationComment(result: IssueValidationResult): string {
  const lines = [
    ISSUE_VALIDATION_MARKER_PREFIX,
    '## FORGE issue validation',
    '',
    `This issue is not ready for agent work yet. The validator applied \`needs-clarification\` for this ${displayName(result.issueType)} issue.`,
    '',
  ]

  if (result.issueType === 'unknown') {
    lines.push(`FORGE could not detect the issue type. Use one of these title prefixes: ${titlePrefixSummary()}.`)
    lines.push('If you prefer not to use a title prefix, match one of the supported template section sets exactly.')
  } else if (result.missingSections.length > 0) {
    lines.push('Missing or empty required sections:')
    for (const section of result.missingSections) {
      lines.push(`- ${formatSectionName(section)}`)
    }
    lines.push('')
    lines.push(`Expected title prefix: \`${titlePrefix(result.issueType)}\``)
  } else {
    lines.push('The issue type is recognized, but the body still does not match the required template structure.')
  }

  lines.push('')
  lines.push('Next step: edit the issue body so every required section exists and contains real content. GitHub form placeholders such as `_No response_` do not count.')
  return lines.join('\n')
}

export function buildReadyForAgentComment(result: IssueValidationResult): string {
  return [
    ISSUE_VALIDATION_MARKER_PREFIX,
    '## FORGE issue validation',
    '',
    `This ${displayName(result.issueType)} issue now matches the required FORGE template structure.`,
    'The validator applied `ready-for-agent` and removed `needs-clarification` if it was present.',
  ].join('\n')
}

export function validateIssue(input: ValidationInput): IssueValidationResult {
  const body = input.body ?? ''
  const sections = parseSections(body)
  const issueType = detectIssueType({ title: input.title, body })
  const requiredSections = requiredSectionsForIssueType(issueType)
  const missingSections = requiredSections.filter((section) => !(section in sections) || sections[section] === '')
  const valid = issueType !== 'unknown' && missingSections.length === 0

  return issueValidationResultSchema.parse({
    issueNumber: input.number,
    issueTitle: input.title.trim(),
    issueType,
    valid,
    missingSections,
    detectedSections: Object.keys(sections),
    recommendedLabels: valid ? ['ready-for-agent'] : ['needs-clarification'],
    markerPrefix: ISSUE_VALIDATION_MARKER_PREFIX,
    commentBody: valid ? null : buildNeedsClarificationComment(issueValidationResultSchema.parse({
      issueNumber: input.number,
      issueTitle: input.title.trim(),
      issueType,
      valid,
      missingSections,
      detectedSections: Object.keys(sections),
      recommendedLabels: valid ? ['ready-for-agent'] : ['needs-clarification'],
      markerPrefix: ISSUE_VALIDATION_MARKER_PREFIX,
      commentBody: null,
    })),
  })
}
