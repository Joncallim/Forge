/**
 * Pure readiness evaluator.
 *
 * Classifies an issue's semantic readiness from structural validity + control
 * metadata + resolved dependency facts. No GitHub calls, no model calls.
 *
 * This is the single deterministic readiness authority.
 */

import type { IssueType } from '../contracts/common'
import type { IssueControlMetadata } from '../contracts/issue-control-metadata'
import type { ControlDiagnostic } from '../contracts/issue-control-metadata'
import {
  type IssueReadinessResult,
  type BlockerRecord,
  type ReadinessReasonCode,
  type SemanticReadinessState,
  STATE_TO_LABEL,
} from '../contracts/issue-readiness-result'

/**
 * Resolved dependency fact: the outcome of looking up a single dependency.
 */
export type ResolvedDependencyFact = Readonly<{
  issueNumber: number
  state: 'open' | 'closed_completed' | 'closed_not_planned' | 'closed_duplicate' | 'closed_unknown' | 'not_found' | 'inaccessible' | 'lookup_failed' | 'is_pull_request' | 'tracking_only'
  reasonCode: ReadinessReasonCode
  /**
   * The dependency's own dependency issue numbers (for cycle detection).
   * Empty for unresolved/API-error dependencies and terminal closed states.
   * Parsed from the dependency's control metadata.
   */
  transitiveDependencyIssueNumbers?: readonly number[]
  /** Typed diagnostics parsed from this dependency's control metadata. */
  controlDiagnostics?: readonly ControlDiagnostic[]
}>

/**
 * Inputs needed for a pure readiness evaluation.
 *
 * All dependency facts are pre-resolved before calling this function.
 */
export type ReadinessEvaluationInput = Readonly<{
  issueNumber: number
  issueState: 'open' | 'closed' | 'unknown'
  issueType: IssueType
  controlMetadata: IssueControlMetadata
  structuralValid: boolean
  structuralErrors: readonly string[]
  /**
   * Resolved facts for each declared dependency.
   * Empty if no dependencies or unresolved.
   */
  dependencyFacts: readonly ResolvedDependencyFact[]
  /**
   * Whether the dependency graph has a cycle involving this issue.
   */
  hasCycle: boolean
  /**
   * Whether graph traversal limits were exceeded.
   */
  graphLimitExceeded: boolean
  /**
   * Whether body size exceeded limits.
   */
  bodyTooLarge: boolean
  /**
   * Control metadata parse errors.
   */
  controlParseErrors: readonly string[]
  /** Typed parser authority. Legacy prose is presentation-only. */
  controlDiagnostics?: readonly ControlDiagnostic[]
  /**
   * Whether duplicate declarations were found.
   */
  hasDuplicateDeclaration: boolean
  /**
   * Whether the issue state is unknown/unrecognized.
   */
  stateUnknown: boolean
}>

/**
 * Evaluate semantic readiness from pre-resolved inputs.
 *
 * This function is pure: all GitHub I/O must be done before calling it.
 *
 * @returns The canonical readiness result.
 */
export function evaluateReadiness(input: ReadinessEvaluationInput): IssueReadinessResult {
  const blockers: BlockerRecord[] = []
  const reasonCodes: ReadinessReasonCode[] = []

  // Check body size first
  if (input.bodyTooLarge) {
    reasonCodes.push('queue.issue_body_too_large')
    return buildResult(input.issueNumber, 'needs-clarification', input.controlMetadata, reasonCodes, blockers, true)
  }

  // Check if issue state is unknown (must fail closed)
  if (input.stateUnknown) {
    reasonCodes.push('queue.issue_dependency_state_unknown')
    blockers.push({
      reasonCode: 'queue.issue_dependency_state_unknown',
      detail: 'Issue state is unknown or unrecognized.',
      dependencyIssueNumber: null,
    })
    return buildResult(input.issueNumber, 'needs-clarification', input.controlMetadata, reasonCodes, blockers, true)
  }

  // Check if issue is closed
  if (input.issueState === 'closed') {
    reasonCodes.push('queue.issue_closed')
    return buildResult(input.issueNumber, 'closed', input.controlMetadata, reasonCodes, blockers, false)
  }

  // Check structural validity
  if (!input.structuralValid) {
    reasonCodes.push('queue.issue_template_invalid')
    blockers.push({
      reasonCode: 'queue.issue_template_invalid',
      detail: input.structuralErrors.length > 0
        ? input.structuralErrors.join('; ')
        : 'Issue does not satisfy the required template structure.',
      dependencyIssueNumber: null,
    })
    return buildResult(input.issueNumber, 'needs-clarification', input.controlMetadata, reasonCodes, blockers, false)
  }

  // Check control metadata errors
  const cm = input.controlMetadata

  // Check for duplicate declarations first (most severe)
  if (input.hasDuplicateDeclaration) {
    reasonCodes.push('queue.issue_control_duplicate')
    blockers.push({
      reasonCode: 'queue.issue_control_duplicate',
      detail: 'Duplicate or conflicting Execution mode or Depends on declarations found.',
      dependencyIssueNumber: null,
    })
    return buildResult(input.issueNumber, 'needs-clarification', input.controlMetadata, reasonCodes, blockers, false)
  }

  const diagnostics = input.controlDiagnostics ?? []
  const firstDiagnostic = diagnostics[0]

  if (firstDiagnostic?.reasonCode === 'queue.issue_body_too_large') {
    reasonCodes.push(firstDiagnostic.reasonCode)
    return buildResult(input.issueNumber, 'needs-clarification', input.controlMetadata, reasonCodes, blockers, true)
  }

  if (diagnostics.some((diagnostic) => diagnostic.reasonCode === 'queue.issue_control_duplicate')) {
    reasonCodes.push('queue.issue_control_duplicate')
    blockers.push({ reasonCode: 'queue.issue_control_duplicate', detail: 'Duplicate control declarations found.', dependencyIssueNumber: null })
    return buildResult(input.issueNumber, 'needs-clarification', input.controlMetadata, reasonCodes, blockers, false)
  }

  if (diagnostics.some((diagnostic) => diagnostic.reasonCode === 'queue.issue_control_missing') || (!cm.explicit && !cm.isLegacyTrackingEpic)) {
    // Missing control metadata on non-legacy issues
    reasonCodes.push('queue.issue_control_missing')
    blockers.push({
      reasonCode: 'queue.issue_control_missing',
      detail: 'Issue is missing required Execution mode and/or Depends on metadata.',
      dependencyIssueNumber: null,
    })
    return buildResult(input.issueNumber, 'needs-clarification', input.controlMetadata, reasonCodes, blockers, false)
  }

  if (diagnostics.some((diagnostic) => diagnostic.reasonCode === 'queue.issue_execution_mode_invalid') || (cm.executionMode === null && !cm.isLegacyTrackingEpic)) {
    // Invalid execution mode
    reasonCodes.push('queue.issue_execution_mode_invalid')
    blockers.push({
      reasonCode: 'queue.issue_execution_mode_invalid',
      detail: 'Execution mode is missing or invalid. Must be "implementation" or "tracking".',
      dependencyIssueNumber: null,
    })
    return buildResult(input.issueNumber, 'needs-clarification', input.controlMetadata, reasonCodes, blockers, false)
  }

  // Add any remaining control parse errors as blockers and TERMINATE
  // Any parse error on an implementation issue must return needs-clarification,
  // never continue toward ready with a silently truncated/fixed dependency set.
  if (diagnostics.length > 0) {
    for (const diagnostic of diagnostics) {
      if (reasonCodes.includes(diagnostic.reasonCode)) continue
      reasonCodes.push(diagnostic.reasonCode)
      blockers.push({
        reasonCode: diagnostic.reasonCode,
        detail: detailForControlDiagnostic(diagnostic.reasonCode),
        dependencyIssueNumber: diagnostic.dependencyIssueNumber ?? null,
      })
    }
    return buildResult(
      input.issueNumber,
      'needs-clarification',
      input.controlMetadata,
      reasonCodes,
      blockers,
      diagnostics.some((diagnostic) => diagnostic.reasonCode === 'queue.issue_dependency_graph_limit_exceeded'),
    )
  }

  // Tracking issues are never dispatchable
  if (cm.executionMode === 'tracking') {
    reasonCodes.push('queue.issue_tracking_only')
    return buildResult(input.issueNumber, 'tracking-only', input.controlMetadata, reasonCodes, blockers, false)
  }

  // A malformed reachable dependency is just as authoritative as a malformed
  // direct declaration.  It must never be treated as a traversable success.
  const downstreamDiagnostics = input.dependencyFacts.flatMap((fact) =>
    (fact.controlDiagnostics ?? []).map((diagnostic) => ({ fact, diagnostic })),
  )
  if (downstreamDiagnostics.length > 0) {
    for (const { fact, diagnostic } of downstreamDiagnostics) {
      reasonCodes.push(diagnostic.reasonCode)
      blockers.push({
        reasonCode: diagnostic.reasonCode,
        detail: detailForControlDiagnostic(diagnostic.reasonCode),
        dependencyIssueNumber: fact.issueNumber,
      })
    }
    return buildResult(input.issueNumber, 'needs-clarification', input.controlMetadata, reasonCodes, blockers, false)
  }

  // Check dependency syntax errors
  const hasSyntaxErrors = input.dependencyFacts.some(
    (f) => f.reasonCode === 'queue.issue_dependency_syntax_invalid' ||
         f.reasonCode === 'queue.issue_dependency_self' ||
         f.reasonCode === 'queue.issue_dependency_duplicate' ||
         f.reasonCode === 'queue.issue_dependency_is_pull_request' ||
         f.reasonCode === 'queue.issue_dependency_tracking',
  )

  if (hasSyntaxErrors) {
    for (const fact of input.dependencyFacts) {
      if (fact.reasonCode.startsWith('queue.issue_dependency_syntax') ||
          fact.reasonCode === 'queue.issue_dependency_self' ||
          fact.reasonCode === 'queue.issue_dependency_duplicate' ||
          fact.reasonCode === 'queue.issue_dependency_is_pull_request' ||
          fact.reasonCode === 'queue.issue_dependency_tracking') {
        reasonCodes.push(fact.reasonCode)
        blockers.push({
          reasonCode: fact.reasonCode,
          detail: detailForDependencyFact(fact),
          dependencyIssueNumber: fact.issueNumber,
        })
      }
    }
    return buildResult(input.issueNumber, 'needs-clarification', input.controlMetadata, reasonCodes, blockers, false)
  }

  // Check graph limits
  if (input.graphLimitExceeded || input.hasCycle) {
    if (input.hasCycle) {
      reasonCodes.push('queue.issue_dependency_cycle')
      blockers.push({
        reasonCode: 'queue.issue_dependency_cycle',
        detail: 'Issue participates in a dependency cycle.',
        dependencyIssueNumber: null,
      })
    }
    if (input.graphLimitExceeded) {
      reasonCodes.push('queue.issue_dependency_graph_limit_exceeded')
      blockers.push({
        reasonCode: 'queue.issue_dependency_graph_limit_exceeded',
        detail: 'Dependency graph traversal exceeded the configured limit.',
        dependencyIssueNumber: null,
      })
    }
    return buildResult(input.issueNumber, 'needs-clarification', input.controlMetadata, reasonCodes, blockers, input.graphLimitExceeded)
  }

  // Check dependency states
  const openDeps = input.dependencyFacts.filter((f) => f.state === 'open')
  const unsatisfiedDeps = input.dependencyFacts.filter(
    (f) => f.state === 'closed_not_planned' || f.state === 'closed_duplicate',
  )
  if (openDeps.length > 0) {
    reasonCodes.push('queue.issue_dependency_open')
    for (const dep of openDeps) {
      blockers.push({
        reasonCode: 'queue.issue_dependency_open',
        detail: `Dependency #${dep.issueNumber} is open.`,
        dependencyIssueNumber: dep.issueNumber,
      })
    }
    return buildResult(input.issueNumber, 'dependency-blocked', input.controlMetadata, reasonCodes, blockers, false)
  }

  if (unsatisfiedDeps.length > 0) {
    reasonCodes.push('queue.issue_dependency_terminal_unsatisfied')
    for (const dep of unsatisfiedDeps) {
      blockers.push({
        reasonCode: 'queue.issue_dependency_terminal_unsatisfied',
        detail: `Dependency #${dep.issueNumber} was closed without completion (${dep.state}).`,
        dependencyIssueNumber: dep.issueNumber,
      })
    }
    return buildResult(input.issueNumber, 'needs-clarification', input.controlMetadata, reasonCodes, blockers, false)
  }

  // not_found is a definitive invalid graph → needs-clarification
  const notFoundDeps = input.dependencyFacts.filter((f) => f.state === 'not_found')
  if (notFoundDeps.length > 0) {
    for (const dep of notFoundDeps) {
      reasonCodes.push(dep.reasonCode)
      blockers.push({
        reasonCode: dep.reasonCode,
        detail: detailForDependencyFact(dep),
        dependencyIssueNumber: dep.issueNumber,
      })
    }
    return buildResult(input.issueNumber, 'needs-clarification', input.controlMetadata, reasonCodes, blockers, false)
  }

  // Other unknown/inaccessible/lookup-failed → dependency-blocked (may resolve)
  const otherUnknownDeps = input.dependencyFacts.filter(
    (f) => f.state === 'closed_unknown' || f.state === 'inaccessible' || f.state === 'lookup_failed',
  )
  if (otherUnknownDeps.length > 0) {
    for (const dep of otherUnknownDeps) {
      reasonCodes.push(dep.reasonCode)
      blockers.push({
        reasonCode: dep.reasonCode,
        detail: detailForDependencyFact(dep),
        dependencyIssueNumber: dep.issueNumber,
      })
    }
    return buildResult(input.issueNumber, 'dependency-blocked', input.controlMetadata, reasonCodes, blockers, true)
  }

  // All dependencies satisfied (or none) → ready
  return buildResult(input.issueNumber, 'ready', input.controlMetadata, reasonCodes, blockers, false)
}

function detailForControlDiagnostic(reasonCode: ReadinessReasonCode): string {
  switch (reasonCode) {
    case 'queue.issue_dependency_syntax_invalid': return 'Dependency syntax is invalid.'
    case 'queue.issue_dependency_duplicate': return 'Duplicate dependency declarations found.'
    case 'queue.issue_dependency_self': return 'Issue cannot depend on itself.'
    case 'queue.issue_dependency_graph_limit_exceeded': return 'Dependency declaration exceeds the supported limit.'
    default: return 'Issue control metadata is invalid.'
  }
}

function buildResult(
  issueNumber: number,
  state: SemanticReadinessState,
  controlMetadata: IssueControlMetadata,
  reasonCodes: ReadinessReasonCode[],
  blockers: BlockerRecord[],
  partial: boolean,
): IssueReadinessResult {
  const desiredLabel = STATE_TO_LABEL[state]

  return {
    issueNumber,
    state,
    dispatchable: state === 'ready',
    executionMode: controlMetadata.executionMode,
    dependencies: controlMetadata.dependencies,
    reasonCodes: deduplicateCodes(reasonCodes),
    blockers,
    desiredReadinessLabels: desiredLabel ? [desiredLabel] : [],
    partial,
  }
}

function deduplicateCodes(codes: ReadonlyArray<ReadinessReasonCode>): ReadinessReasonCode[] {
  return [...new Set(codes)]
}

function detailForDependencyFact(fact: ResolvedDependencyFact): string {
  switch (fact.reasonCode) {
    case 'queue.issue_dependency_self':
      return 'Issue cannot depend on itself.'
    case 'queue.issue_dependency_duplicate':
      return `Duplicate dependency #${fact.issueNumber}.`
    case 'queue.issue_dependency_is_pull_request':
      return `Dependency #${fact.issueNumber} is a pull request, not an issue.`
    case 'queue.issue_dependency_tracking':
      return `Dependency #${fact.issueNumber} is a tracking issue and cannot be an implementation dependency.`
    case 'queue.issue_dependency_not_found':
      return `Dependency #${fact.issueNumber} was not found.`
    case 'queue.issue_dependency_inaccessible':
      return `Dependency #${fact.issueNumber} is inaccessible (permission denied).`
    case 'queue.issue_dependency_lookup_failed':
      return `Dependency #${fact.issueNumber} lookup failed (API error).`
    case 'queue.issue_dependency_state_unknown':
      return `Dependency #${fact.issueNumber} state is unknown.`
    default:
      return `Dependency #${fact.issueNumber}: ${fact.state}`
  }
}
