import type { BlockerRecord, ReadinessReasonCode } from '../contracts/issue-readiness-result'

/**
 * Fixed, bounded human-readable rendering for semantic readiness reasons.
 *
 * External bot output must never depend on BlockerRecord.detail: that field is
 * internal diagnostic evidence and is deliberately excluded from this trust
 * boundary. Only the typed reason code and optional positive dependency issue
 * number may affect rendered text.
 */
export function renderReadinessReason(
  reasonCode: ReadinessReasonCode,
  dependencyIssueNumber: number | null = null,
): string {
  const dependency = dependencyIssueNumber === null ? '' : ` Dependency: #${dependencyIssueNumber}.`

  switch (reasonCode) {
    case 'queue.issue_template_invalid':
      return 'The issue does not satisfy the required template structure.'
    case 'queue.issue_control_missing':
      return 'Required Forge control metadata is missing.'
    case 'queue.issue_control_duplicate':
      return 'Forge control metadata contains duplicate declarations.'
    case 'queue.issue_execution_mode_invalid':
      return 'The execution mode is missing or invalid.'
    case 'queue.issue_tracking_only':
      return 'This is a tracking-only issue and cannot be dispatched.'
    case 'queue.issue_closed':
      return 'The source issue is closed.'
    case 'queue.issue_dependency_syntax_invalid':
      return `Dependency metadata has invalid syntax.${dependency}`
    case 'queue.issue_dependency_self':
      return `An issue cannot depend on itself.${dependency}`
    case 'queue.issue_dependency_duplicate':
      return `A dependency is declared more than once.${dependency}`
    case 'queue.issue_dependency_is_pull_request':
      return `A declared dependency is a pull request, not an issue.${dependency}`
    case 'queue.issue_dependency_tracking':
      return `A declared dependency is tracking-only and cannot be an implementation dependency.${dependency}`
    case 'queue.issue_dependency_not_found':
      return `A declared dependency was not found.${dependency}`
    case 'queue.issue_dependency_open':
      return `A declared dependency is still open.${dependency}`
    case 'queue.issue_dependency_terminal_unsatisfied':
      return `A declared dependency closed without successful completion.${dependency}`
    case 'queue.issue_dependency_state_unknown':
      return `A dependency state could not be classified safely.${dependency}`
    case 'queue.issue_dependency_inaccessible':
      return `A declared dependency could not be accessed.${dependency}`
    case 'queue.issue_dependency_lookup_failed':
      return `A dependency lookup could not be completed safely.${dependency}`
    case 'queue.issue_dependency_cycle':
      return 'The reachable dependency graph contains a cycle.'
    case 'queue.issue_dependency_graph_limit_exceeded':
      return 'Dependency graph resolution exceeded a configured safety limit.'
    case 'queue.issue_body_too_large':
      return 'The issue body exceeds the supported parsing limit.'
    case 'queue.issue_projection_update_failed':
      return 'The readiness label projection could not be updated safely.'
  }
}

export function renderReadinessBlocker(blocker: BlockerRecord): string {
  return renderReadinessReason(blocker.reasonCode, blocker.dependencyIssueNumber)
}
