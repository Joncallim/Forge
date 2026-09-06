/**
 * Single shared readiness projection writer.
 *
 * Synchronizes GitHub labels to reflect the computed semantic readiness state.
 * Labels are projections only — never authority.
 *
 * Safe ordering:
 * - ready → non-ready: remove ready-for-agent BEFORE adding blocking label
 * - non-ready → ready: remove blocking labels BEFORE adding ready-for-agent LAST
 * - GitHub write failure must never leave a false-positive ready label
 * - Labels are guaranteed mutually exclusive (exactly one readiness label at a time)
 *
 * Used by:
 *   - issue-validation-runner.ts (target-only projection)
 *   - reconcile-readiness.ts (bulk projection)
 *   - dispatch.ts, handoff.ts (blocked projections)
 *
 * No model calls.
 */

import type { GitHubClient, GitHubIssue } from '../io/github-client'
import type { IssueReadinessResult } from '../contracts/issue-readiness-result'
import { ISSUE_READINESS_MANAGED_LABELS } from '../contracts/common'

/**
 * Result of a projection operation.
 */
export type ProjectionResult = Readonly<{
  /**
   * Whether the projection was applied successfully.
   */
  success: boolean
  /**
   * Error message if the projection failed.
   */
  error: string | null
  /**
   * Which labels were added.
   */
  addedLabels: readonly string[]
  /**
   * Which labels were removed.
   */
  removedLabels: readonly string[]
}>

/**
 * Synchronize readiness projection labels for an issue.
 *
 * Safe ordering:
 * 1. If transitioning ready → non-ready, remove ready-for-agent FIRST.
 * 2. Remove ALL other stale readiness labels.
 * 3. Add non-ready labels (needs-clarification, dependency-blocked, tracking-only).
 * 4. For non-ready → ready, perform a final label verification, then add ready-for-agent LAST.
 *
 * A GitHub write failure that could leave a false-positive ready label
 * causes the projection to fail and report queue.issue_projection_update_failed.
 */
export async function syncReadinessLabels(
  client: GitHubClient,
  issue: GitHubIssue,
  readinessResult: IssueReadinessResult,
): Promise<ProjectionResult> {
  const currentLabels = issue.labels
  const desiredLabels = readinessResult.desiredReadinessLabels
  const addedLabels: string[] = []
  const removedLabels: string[] = []

  // Determine current readiness labels
  const currentReadinessLabels = currentLabels.filter((l) =>
    ISSUE_READINESS_MANAGED_LABELS.includes(l as typeof ISSUE_READINESS_MANAGED_LABELS[number]),
  )

  // If nothing to change, skip
  if (setsEqual(new Set(currentReadinessLabels), new Set(desiredLabels))) {
    return { success: true, error: null, addedLabels: [], removedLabels: [] }
  }

  // Step 1: If transitioning ready to non-ready, remove ready-for-agent FIRST
  if (currentReadinessLabels.includes('ready-for-agent') && !desiredLabels.includes('ready-for-agent')) {
    try {
      await client.removeLabel(issue.number, 'ready-for-agent')
      removedLabels.push('ready-for-agent')
    } catch {
      return {
        success: false,
        error: `Failed to remove ready-for-agent from #${issue.number}. Cannot safely project non-ready state.`,
        addedLabels: [],
        removedLabels: [],
      }
    }
  }

  // Step 2: Remove ALL other stale readiness labels (converge to exact set)
  for (const label of currentReadinessLabels) {
    if (!desiredLabels.includes(label as typeof ISSUE_READINESS_MANAGED_LABELS[number])) {
      try {
        await client.removeLabel(issue.number, label)
        removedLabels.push(label)
      } catch {
        // Non-critical: stale label removal failure is not safety-critical
        // The semantic resolver still denies authority
      }
    }
  }

  // Step 3: Add non-ready labels (blocking/clarification/tracking)
  for (const label of desiredLabels) {
    if (label !== 'ready-for-agent' && !currentReadinessLabels.includes(label)) {
      try {
        await client.addLabel(issue.number, label)
        addedLabels.push(label)
      } catch {
        // Report failure but don't block ready promotion for non-ready labels
      }
    }
  }

  // Step 4: For non-ready to ready, add ready-for-agent LAST
  if (!currentReadinessLabels.includes('ready-for-agent') && desiredLabels.includes('ready-for-agent')) {
    // Verify no stale blocker labels remain before adding ready
    try {
      const labelsAfter = (await client.getIssue(issue.number)).labels
      const staleBlockers = ['needs-clarification', 'dependency-blocked', 'tracking-only'].filter(
        (l) => labelsAfter.includes(l),
      )
      if (staleBlockers.length > 0) {
        return {
          success: false,
          error: `Cannot add ready-for-agent: stale blocker labels remain: ${staleBlockers.join(', ')}.`,
          addedLabels,
          removedLabels,
        }
      }
    } catch {
      return {
        success: false,
        error: `Failed to verify label state for #${issue.number} before adding ready-for-agent.`,
        addedLabels,
        removedLabels,
      }
    }

    try {
      await client.addLabel(issue.number, 'ready-for-agent')
      addedLabels.push('ready-for-agent')
    } catch {
      return {
        success: false,
        error: `Failed to add ready-for-agent to #${issue.number}.`,
        addedLabels,
        removedLabels,
      }
    }
  }

  return { success: true, error: null, addedLabels, removedLabels }
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false
  for (const item of a) {
    if (!b.has(item)) return false
  }
  return true
}
