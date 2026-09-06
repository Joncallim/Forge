/**
 * Shared run-state transition guard.
 *
 * Centralized helper to prevent #354 from corrupting durable run-log state.
 * Only `requested` and `handed-off` runs may be transitioned to `blocked`
 * by readiness-admission paths (dispatch, handoff).
 *
 * Active (running, pr-opened) and terminal (completed, failed, cancelled)
 * runs must never be retroactively rewritten by admission-time readiness
 * checks.
 */

import type { RunStatus } from '../contracts/common'

/**
 * Run statuses that #354's readiness-admission paths may transition to blocked.
 */
const BLOCKABLE_STATUSES: ReadonlySet<RunStatus> = new Set(['requested', 'handed-off'])

/**
 * Whether the given run status may be transitioned to `blocked` by a
 * readiness-admission path (dispatch or handoff).
 */
export function canTransitionToBlocked(status: RunStatus): boolean {
  return BLOCKABLE_STATUSES.has(status)
}

/**
 * Whether admission may publish a blocked projection for this run. A missing
 * run is not durable authority for a blocked state.
 */
export function canProjectBlockedRun(status: RunStatus | null): boolean {
  return status !== null && canTransitionToBlocked(status)
}

/**
 * Error message for an attempt to block a non-blockable run status.
 */
export function nonBlockableRunMessage(status: RunStatus): string {
  return `Cannot transition run with status \`${status}\` to blocked. Only \`requested\` and \`handed-off\` runs may be blocked by readiness admission.`
}
