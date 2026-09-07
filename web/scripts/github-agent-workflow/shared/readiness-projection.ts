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
  options: { confirmReady?: () => Promise<IssueReadinessResult> } = {},
): Promise<ProjectionResult> {
  const addedLabels: string[] = []
  const removedLabels: string[] = []

  // Re-check live state before the first mutation. The semantic result may
  // have been computed from an issue that was closed in the intervening
  // interval; closed issues must only have managed labels cleaned up.
  let liveIssue: GitHubIssue
  try {
    liveIssue = await client.getIssue(issue.number)
  } catch {
    return {
      success: false,
      error: `Failed to verify current issue state for #${issue.number} before readiness projection.`,
      addedLabels,
      removedLabels,
    }
  }

  const currentLabels = liveIssue.labels
  let desiredLabels: readonly string[] = liveIssue.state.toLowerCase() === 'closed'
    ? []
    : readinessResult.desiredReadinessLabels

  // A label operation can be delayed behind another GitHub call. Re-check
  // immediately before every write so a just-closed issue becomes cleanup-only
  // rather than receiving a stale readiness label.
  const preflightLabelMutation = async (): Promise<ProjectionResult | null> => {
    try {
      const currentIssue = await client.getIssue(issue.number)
      if (currentIssue.state.toLowerCase() === 'closed') desiredLabels = []
      return null
    } catch {
      return {
        success: false,
        error: `Failed to verify current issue state for #${issue.number} before readiness label mutation.`,
        addedLabels,
        removedLabels,
      }
    }
  }

  // Determine current readiness labels
  const currentReadinessLabels = currentLabels.filter((l) =>
    ISSUE_READINESS_MANAGED_LABELS.includes(l as typeof ISSUE_READINESS_MANAGED_LABELS[number]),
  )

  // Step 1: If transitioning ready to non-ready, remove ready-for-agent FIRST
  if (currentReadinessLabels.includes('ready-for-agent') && !desiredLabels.includes('ready-for-agent')) {
    const preflightFailure = await preflightLabelMutation()
    if (preflightFailure) return preflightFailure
    if (!desiredLabels.includes('ready-for-agent')) {
      try {
        await client.removeLabel(liveIssue.number, 'ready-for-agent')
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
  }

  // Step 2: Remove ALL other stale readiness labels (converge to exact set).
  // A projection is only truthful when every requested GitHub mutation
  // succeeds, so do not silently continue after a failed write.
  for (const label of currentReadinessLabels) {
    if (label === 'ready-for-agent' && removedLabels.includes(label)) continue
    if (!desiredLabels.includes(label as typeof ISSUE_READINESS_MANAGED_LABELS[number])) {
      const preflightFailure = await preflightLabelMutation()
      if (preflightFailure) return preflightFailure
      if (desiredLabels.includes(label)) continue
      try {
        await client.removeLabel(liveIssue.number, label)
        removedLabels.push(label)
      } catch {
        return {
          success: false,
          error: `Failed to remove stale readiness label ${label} from #${issue.number}.`,
          addedLabels,
          removedLabels,
        }
      }
    }
  }

  // Step 3: Add non-ready labels (blocking/clarification/tracking)
  for (const label of desiredLabels) {
    if (label !== 'ready-for-agent' && !currentReadinessLabels.includes(label)) {
      const preflightFailure = await preflightLabelMutation()
      if (preflightFailure) return preflightFailure
      if (!desiredLabels.includes(label)) continue
      try {
        await client.addLabel(liveIssue.number, label)
        addedLabels.push(label)
      } catch {
        return {
          success: false,
          error: `Failed to add readiness label ${label} to #${issue.number}.`,
          addedLabels,
          removedLabels,
        }
      }
    }
  }

  // Step 4: For non-ready to ready, add ready-for-agent LAST
  if (!currentReadinessLabels.includes('ready-for-agent') && desiredLabels.includes('ready-for-agent')) {
    // Target state preflights alone cannot see a dependency reopening after
    // planning. Re-resolve the complete semantic graph at the exact ready
    // promotion boundary and converge to its fresh non-ready result instead.
    if (options.confirmReady) {
      try {
        const fresh = await options.confirmReady()
        if (fresh.partial) {
          return { success: false, error: `Fresh readiness confirmation for #${issue.number} is partial.`, addedLabels, removedLabels }
        }
        desiredLabels = fresh.desiredReadinessLabels
      } catch {
        return { success: false, error: `Failed to confirm fresh readiness for #${issue.number} before adding ready-for-agent.`, addedLabels, removedLabels }
      }
    }
    if (!desiredLabels.includes('ready-for-agent')) {
      // We have already removed stale labels above. Re-enter the non-ready
      // convergence path without ever emitting a false-ready projection.
      for (const label of desiredLabels) {
        if (!currentReadinessLabels.includes(label)) {
          const preflightFailure = await preflightLabelMutation()
          if (preflightFailure) return preflightFailure
          try { await client.addLabel(liveIssue.number, label); addedLabels.push(label) }
          catch { return { success: false, error: `Failed to add fresh readiness label ${label} to #${issue.number}.`, addedLabels, removedLabels } }
        }
      }
    }

    if (desiredLabels.includes('ready-for-agent')) {
    // Verify no stale blocker labels remain before adding ready
    try {
      const labelsAfter = (await client.getIssue(liveIssue.number)).labels
      const staleLabels = labelsAfter.filter((label) => (
        ISSUE_READINESS_MANAGED_LABELS.includes(label as typeof ISSUE_READINESS_MANAGED_LABELS[number])
        && !desiredLabels.includes(label as typeof ISSUE_READINESS_MANAGED_LABELS[number])
      ))
      if (staleLabels.length > 0) {
        return {
          success: false,
          error: `Cannot add ready-for-agent: stale readiness labels remain: ${staleLabels.join(', ')}.`,
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

    const preflightFailure = await preflightLabelMutation()
    if (preflightFailure) return preflightFailure
    if (desiredLabels.includes('ready-for-agent')) {
      try {
        await client.addLabel(liveIssue.number, 'ready-for-agent')
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
    }
  }

  // Catch a close that arrived after all planned writes (including the
  // no-op case) and clean managed labels rather than reporting a stale target.
  try {
    const currentIssue = await client.getIssue(liveIssue.number)
    if (currentIssue.state.toLowerCase() === 'closed') {
      desiredLabels = []
      for (const label of currentIssue.labels.filter((candidate) => (
        ISSUE_READINESS_MANAGED_LABELS.includes(candidate as typeof ISSUE_READINESS_MANAGED_LABELS[number])
      ))) {
        const preflightFailure = await preflightLabelMutation()
        if (preflightFailure) return preflightFailure
        try {
          await client.removeLabel(liveIssue.number, label)
          if (!removedLabels.includes(label)) removedLabels.push(label)
        } catch {
          return {
            success: false,
            error: `Failed to remove readiness label ${label} from closed issue #${issue.number}.`,
            addedLabels,
            removedLabels,
          }
        }
      }
    }
  } catch {
    return {
      success: false,
      error: `Failed to verify current issue state for #${issue.number} before final readiness projection verification.`,
      addedLabels,
      removedLabels,
    }
  }

  // Verify the exact managed-label projection, including labels that GitHub
  // accepted but did not persist as expected.
  try {
    const finalLabels = (await client.getIssue(liveIssue.number)).labels.filter((label) => (
      ISSUE_READINESS_MANAGED_LABELS.includes(label as typeof ISSUE_READINESS_MANAGED_LABELS[number])
    ))
    if (!setsEqual(new Set(finalLabels), new Set(desiredLabels))) {
      return {
        success: false,
        error: `Readiness label projection for #${issue.number} did not converge to the requested exact label set.`,
        addedLabels,
        removedLabels,
      }
    }
  } catch {
    return {
      success: false,
      error: `Failed to verify final readiness label state for #${issue.number}.`,
      addedLabels,
      removedLabels,
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
