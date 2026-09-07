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
import type { ControlDiagnostic, IssueControlMetadata } from '../contracts/issue-control-metadata'
import { EMPTY_CONTROL_METADATA, MAX_CONTROL_DIAGNOSTICS, MAX_DEPENDENCIES_PER_ISSUE, executionModeSchema } from '../contracts/issue-control-metadata'
import { scanVisibleMarkdownLines } from './visible-markdown-scanner'

const EXECUTION_MODE_PREFIX = 'Execution mode:'
const DEPENDS_ON_PREFIX = 'Depends on:'
const ISSUE_REFERENCE_PATTERN = /^#(\d+)$/
const NONE_VALUE = 'none'

export type ControlParseResult = Readonly<{
  metadata: IssueControlMetadata
  diagnostics: readonly ControlDiagnostic[]
  /** @deprecated Diagnostics, not prose, are semantic authority. */
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
  const diagnostics: ControlDiagnostic[] = []
  const diagnosticKeys = new Set<string>()
  const errorMessages = new Set<string>()
  const diagnose = (reasonCode: ControlDiagnostic['reasonCode'], field: ControlDiagnostic['field'], message: string, dependencyIssueNumber?: number) => {
    const diagnosticKey = `${reasonCode}\u0000${field}\u0000${dependencyIssueNumber ?? ''}`
    if (!diagnosticKeys.has(diagnosticKey) && diagnostics.length < MAX_CONTROL_DIAGNOSTICS) {
      diagnosticKeys.add(diagnosticKey)
      diagnostics.push({ reasonCode, field, ...(dependencyIssueNumber === undefined ? {} : { dependencyIssueNumber }) })
    }
    if (!errorMessages.has(message) && errors.length < MAX_CONTROL_DIAGNOSTICS) {
      errorMessages.add(message)
      errors.push(message)
    }
  }
  const visible = scanVisibleMarkdownLines(body ?? '')

  if (visible.bodyTooLarge) {
    return {
      metadata: {
        ...EMPTY_CONTROL_METADATA,
        explicit: false,
      },
      diagnostics: [{ reasonCode: 'queue.issue_body_too_large', field: 'body' }],
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
      diagnose('queue.issue_execution_mode_invalid', 'execution_mode', 'Invalid execution mode. Must be implementation or tracking.')
    }
  } else if (executionModeLines.length > 1) {
    diagnose('queue.issue_control_duplicate', 'execution_mode', 'Duplicate Execution mode declaration found.')
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
    diagnose('queue.issue_execution_mode_invalid', 'execution_mode', 'An Epic issue cannot use implementation mode.')
    executionMode = null
  }

  // Resolve dependencies
  let dependencies: number[] = []
  let dependsOnNone = true

  if (dependsOnLines.length === 1) {
    const value = dependsOnLines[0].value
    if (value === NONE_VALUE) {
      dependencies = []
      dependsOnNone = true
    } else {
      // A present Depends on line must be exactly 'none' or a non-empty comma-separated list
      // Empty value or separator-only (',', ' , ') is invalid and must fail closed
      dependsOnNone = false
      const trimmedValue = value.trim()
      if (trimmedValue === '' || trimmedValue === ',' || /^[,\s]+$/.test(trimmedValue)) {
        diagnose('queue.issue_dependency_syntax_invalid', 'depends_on', 'Depends on value is empty.')
        dependencies = []
      } else {
        // Do not silently normalize malformed separators. `#1,,#2` is not
        // equivalent to `#1,#2`: every comma-separated position is part of
        // the external control contract and an empty position fails closed.
        const parsed: number[] = []

        // Parse positions incrementally.  An untrusted 256 KiB separator
        // bomb must not allocate one string/object per comma before this
        // contract can reject it.
        let positionStart = 0
        for (let index = 0; ; index++) {
          // Each comma-separated position is a declared dependency position.
          // Do not scan an attacker-controlled separator bomb after the
          // maximum legal dependency contract is already exceeded.
          if (index >= MAX_DEPENDENCIES_PER_ISSUE) {
            diagnose('queue.issue_dependency_graph_limit_exceeded', 'depends_on', 'Dependency count exceeds the supported limit.')
            break
          }
          const separatorIndex = value.indexOf(',', positionStart)
          const part = value.slice(positionStart, separatorIndex === -1 ? value.length : separatorIndex).trim()
          if (part === '') {
            diagnose('queue.issue_dependency_syntax_invalid', 'depends_on', 'Dependency syntax contains an empty reference.')
          } else {
            const match = ISSUE_REFERENCE_PATTERN.exec(part)
            if (match) {
              const num = parseInt(match[1], 10)
              if (Number.isSafeInteger(num) && num > 0) {
                parsed.push(num)
              } else {
                diagnose('queue.issue_dependency_syntax_invalid', 'depends_on', 'Dependency reference is invalid.')
              }
            } else {
              diagnose('queue.issue_dependency_syntax_invalid', 'depends_on', 'Dependency syntax is invalid.')
            }
          }

          if (separatorIndex === -1) break
          positionStart = separatorIndex + 1
        }

        dependencies = parsed
      }
    }
  } else if (dependsOnLines.length > 1) {
    diagnose('queue.issue_control_duplicate', 'depends_on', 'Duplicate Depends on declaration found.')
  }

  // Bounds check
  if (dependencies.length > MAX_DEPENDENCIES_PER_ISSUE) {
    diagnose('queue.issue_dependency_graph_limit_exceeded', 'depends_on', 'Dependency count exceeds the supported limit.')
  }

  // Deduplicate dependencies
  const uniqueDeps = [...new Set(dependencies)]
  if (uniqueDeps.length < dependencies.length) {
    diagnose('queue.issue_dependency_duplicate', 'depends_on', 'Duplicate dependency references found.')
  }
  dependencies = uniqueDeps

  // For non-legacy, non-Epic issues, both Execution mode and Depends on must be present
  // to be considered fully explicit. Missing either field is a parse error.
  const isImplementationIssue = !isLegacyTrackingEpic && issueType !== 'epic'
  const hasExecutionModeLine = executionModeLines.length > 0
  const hasDependsOnLine = dependsOnLines.length > 0

  if (isImplementationIssue && !hasExecutionModeLine) {
    diagnose('queue.issue_control_missing', 'execution_mode', 'Execution mode declaration is required.')
  }
  if (isImplementationIssue && !hasDependsOnLine) {
    diagnose('queue.issue_control_missing', 'depends_on', 'Depends on declaration is required.')
  }

  // Override explicit: for non-Epic issues, both fields must be present
  const resolvedExplicit = isImplementationIssue ? (hasExecutionModeLine && hasDependsOnLine) : explicit

  return {
    metadata: {
      executionMode,
      dependencies,
      dependsOnNone,
      explicit: resolvedExplicit,
      isLegacyTrackingEpic,
    },
    diagnostics,
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