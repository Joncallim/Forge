/**
 * Pure issue control-metadata parser.
 *
 * Parses the canonical "Execution mode:" and "Depends on:" lines from visible
 * Markdown. Uses the shared visible-markdown-scanner so fenced code, indented
 * code, blockquotes, and HTML comments cannot spoof control metadata.
 *
 * No GitHub calls, no model calls.
 */

import type { IssueType } from '../contracts/common'
import type { IssueControlMetadata } from '../contracts/issue-control-metadata'
import { EMPTY_CONTROL_METADATA, MAX_DEPENDENCIES_PER_ISSUE, executionModeSchema } from '../contracts/issue-control-metadata'
import { scanVisibleMarkdownLines } from './visible-markdown-scanner'

const EXECUTION_MODE_PREFIX = 'Execution mode:'
const DEPENDS_ON_PREFIX = 'Depends on:'
const ISSUE_REFERENCE_PATTERN = /^#(\d+)$/
const NONE_VALUE = 'none'

export type ControlParseResult = Readonly<{
  metadata: IssueControlMetadata
  errors: string[]
  /**
   * True if any duplicate or conflicting declaration was found.
   */
  hasDuplicateDeclaration: boolean
}>

/**
 * Parse control metadata from visible Markdown lines.
 *
 * @param body - The issue body text.
 * @param issueType - The detected issue type (for legacy Epic defaults).
 * @returns Parsed control metadata and any parse errors.
 */
export function parseControlMetadata(
  body: string | null,
  issueType: IssueType,
): ControlParseResult {
  const errors: string[] = []
  const visible = scanVisibleMarkdownLines(body ?? '')

  if (visible.bodyTooLarge) {
    return {
      metadata: {
        ...EMPTY_CONTROL_METADATA,
        explicit: false,
      },
      errors: ['Issue body exceeds maximum size.'],
      hasDuplicateDeclaration: false,
    }
  }

  // Extract lines that look like metadata declarations
  const executionModeLines: Array<{ lineNumber: number; value: string }> = []
  const dependsOnLines: Array<{ lineNumber: number; value: string }> = []

  for (const line of visible.lines) {
    const trimmed = line.text.trim()

    if (trimmed.startsWith(EXECUTION_MODE_PREFIX)) {
      const value = trimmed.slice(EXECUTION_MODE_PREFIX.length).trim()
      executionModeLines.push({ lineNumber: line.lineNumber, value })
    }

    if (trimmed.startsWith(DEPENDS_ON_PREFIX)) {
      const value = trimmed.slice(DEPENDS_ON_PREFIX.length).trim()
      dependsOnLines.push({ lineNumber: line.lineNumber, value })
    }
  }

  const hasDuplicateExecutionMode = executionModeLines.length > 1
  const hasDuplicateDependsOn = dependsOnLines.length > 1
  const hasDuplicateDeclaration = hasDuplicateExecutionMode || hasDuplicateDependsOn

  // Resolve execution mode
  let executionMode: 'implementation' | 'tracking' | null = null
  const explicit = executionModeLines.length > 0 || dependsOnLines.length > 0

  if (executionModeLines.length === 1) {
    const parsed = executionModeSchema.safeParse(executionModeLines[0].value)
    if (parsed.success) {
      executionMode = parsed.data
    } else {
      errors.push(`Invalid execution mode: "${executionModeLines[0].value}". Supported modes: implementation, tracking.`)
    }
  } else if (executionModeLines.length > 1) {
    errors.push('Duplicate Execution mode declaration found.')
  }

  // Legacy Epic default: if body has [EPIC] and no explicit execution mode, default to tracking
  const isLegacyTrackingEpic = issueType === 'epic' && executionModeLines.length === 0 && !hasDuplicateExecutionMode

  if (isLegacyTrackingEpic) {
    executionMode = 'tracking'
    // Legacy Epics get the default even without explicit lines
    // But explicit Depends on is still parsed
  }

  // Check Epic cannot opt into implementation
  if (issueType === 'epic' && executionMode === 'implementation') {
    errors.push('An Epic issue cannot have Execution mode: implementation.')
    executionMode = null
  }

  // Resolve dependencies
  let dependencies: number[] = []
  let dependsOnNone = true

  if (dependsOnLines.length === 1) {
    const value = dependsOnLines[0].value
    if (value.toLowerCase() === NONE_VALUE) {
      dependencies = []
      dependsOnNone = true
    } else {
      dependsOnNone = false
      const parts = value.split(',').map((p) => p.trim()).filter((p) => p !== '')
      const parsed: number[] = []

      for (const part of parts) {
        const match = ISSUE_REFERENCE_PATTERN.exec(part)
        if (match) {
          const num = parseInt(match[1], 10)
          if (Number.isSafeInteger(num) && num > 0) {
            parsed.push(num)
          } else {
            errors.push(`Invalid dependency reference: "${part}". Must be a positive integer issue number.`)
          }
        } else {
          errors.push(`Invalid dependency syntax: "${part}". Use #number format for same-repo issues.`)
        }
      }

      dependencies = parsed
    }
  } else if (dependsOnLines.length > 1) {
    errors.push('Duplicate Depends on declaration found.')
  }

  // Bounds check
  if (dependencies.length > MAX_DEPENDENCIES_PER_ISSUE) {
    errors.push(`Too many dependencies: ${dependencies.length} exceeds maximum of ${MAX_DEPENDENCIES_PER_ISSUE}.`)
    dependencies = dependencies.slice(0, MAX_DEPENDENCIES_PER_ISSUE)
  }

  // Deduplicate dependencies
  const uniqueDeps = [...new Set(dependencies)]
  if (uniqueDeps.length < dependencies.length) {
    errors.push('Duplicate dependency references found.')
  }
  dependencies = uniqueDeps

  return {
    metadata: {
      executionMode,
      dependencies,
      dependsOnNone,
      explicit,
      isLegacyTrackingEpic,
    },
    errors,
    hasDuplicateDeclaration,
  }
}

/**
 * Fast check whether body contains execution mode or dependency lines.
 * Used for quick filtering before full parsing.
 */
export function hasControlMetadata(body: string | null): boolean {
  if (!body) return false
  const visible = scanVisibleMarkdownLines(body)
  if (visible.bodyTooLarge) return false
  return visible.lines.some(
    (l) => l.text.trim().startsWith(EXECUTION_MODE_PREFIX) || l.text.trim().startsWith(DEPENDS_ON_PREFIX),
  )
}
