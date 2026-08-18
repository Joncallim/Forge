/**
 * Verification goal run lifecycle, outcome, and event contracts
 * (issue #187 sections 21, 25, 36).
 *
 * These constants and types are intentionally pure: they describe the closed
 * state space used by the run table and evidence stream without importing any
 * DB write path.
 */

export const VERIFICATION_GOAL_RUN_LIFECYCLE_STATUSES = [
  'queued',
  'running',
  'recovery_required',
  'completed',
  'expired',
] as const

export type VerificationGoalRunStatus =
  typeof VERIFICATION_GOAL_RUN_LIFECYCLE_STATUSES[number]

export const VERIFICATION_GOAL_RUN_RESULTS = [
  'passed',
  'failed',
  'inconclusive',
] as const

export type VerificationGoalRunResult =
  typeof VERIFICATION_GOAL_RUN_RESULTS[number]

export const VERIFICATION_GOAL_RUN_FAILURE_CLASSES = [
  'functional',
  'policy',
  'authority',
  'infrastructure',
  'evidence',
  'cancelled',
] as const

export type VerificationGoalRunFailureClass =
  typeof VERIFICATION_GOAL_RUN_FAILURE_CLASSES[number]

/**
 * Closed terminal codes for a verification goal run. A terminal code is only
 * meaningful once the run has reached a completed or expired state.
 */
export const VERIFICATION_GOAL_RUN_TERMINAL_CODES = [
  'passed',
  'functional_operation_failed',
  'functional_verification_failed',
  'repository_dirty',
  'repository_changed',
  'root_changed',
  'registry_content_changed',
  'registry_superseded',
  'registry_authority_changed',
  'policy_changed',
  'filesystem_authority_changed',
  'operation_contract_changed',
  'required_verifier_unavailable',
  'linked_worktree_unsupported',
  'unsupported_git_metadata_layout',
  'unsupported_git_config',
  'partial_clone_unsupported',
  'incomplete_object_store',
  'sparse_checkout_unsupported',
  'split_index_unsupported',
  'grafts_unsupported',
  'goal_definition_untracked',
  'git_version_unsupported',
  'git_executable_untrusted',
  'submodule_repository_unsupported',
  'unsupported_repository_identity',
  'missing_required_evidence',
  'operation_infrastructure_failed',
  'operation_evidence_failed',
  'execution_deadline_exceeded',
  'lease_lost',
  'system_execution_disabled',
  'internal_infrastructure_error',
  'dispatch_expired',
] as const

export type VerificationGoalRunTerminalCode =
  typeof VERIFICATION_GOAL_RUN_TERMINAL_CODES[number]

export const VERIFICATION_GOAL_EVENT_PHASES = [
  'admitted',
  'claimed',
  'repository_captured',
  'environment_captured',
  'child_begun',
  'child_completed',
  'terminalized',
  'expired',
  'recovered',
] as const

export type VerificationGoalEventPhase =
  typeof VERIFICATION_GOAL_EVENT_PHASES[number]

export const VERIFICATION_GOAL_EVENT_STATUSES = [
  'ok',
  'blocked',
  'failed',
  'inconclusive',
] as const

export type VerificationGoalEventStatus =
  typeof VERIFICATION_GOAL_EVENT_STATUSES[number]

export type VerificationGoalEventKind =
  | 'run_admitted'
  | 'run_claimed'
  | 'repository_captured'
  | 'environment_captured'
  | 'child_begun'
  | 'child_completed'
  | 'run_terminalized'
  | 'run_expired'
  | 'run_recovered'

export class VerificationGoalRunContractError extends Error {
  readonly code: 'invalid_run_state'

  constructor(message: string) {
    super(message)
    this.name = 'VerificationGoalRunContractError'
    this.code = 'invalid_run_state'
  }
}

function invalid(message: string): never {
  throw new VerificationGoalRunContractError(message)
}

export function assertVerificationGoalRunStatus(
  value: unknown,
): asserts value is VerificationGoalRunStatus {
  if (!VERIFICATION_GOAL_RUN_LIFECYCLE_STATUSES.includes(value as VerificationGoalRunStatus)) {
    invalid(`Invalid verification goal run status: ${String(value)}`)
  }
}

export function assertVerificationGoalRunResult(
  value: unknown,
): asserts value is VerificationGoalRunResult {
  if (!VERIFICATION_GOAL_RUN_RESULTS.includes(value as VerificationGoalRunResult)) {
    invalid(`Invalid verification goal run result: ${String(value)}`)
  }
}

export function assertVerificationGoalRunTerminalCode(
  value: unknown,
): asserts value is VerificationGoalRunTerminalCode {
  if (!VERIFICATION_GOAL_RUN_TERMINAL_CODES.includes(value as VerificationGoalRunTerminalCode)) {
    invalid(`Invalid verification goal run terminal code: ${String(value)}`)
  }
}

export function assertVerificationGoalRunFailureClass(
  value: unknown,
): asserts value is VerificationGoalRunFailureClass {
  if (!VERIFICATION_GOAL_RUN_FAILURE_CLASSES.includes(value as VerificationGoalRunFailureClass)) {
    invalid(`Invalid verification goal run failure class: ${String(value)}`)
  }
}
