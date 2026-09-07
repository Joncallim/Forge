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
  /** Whether the projection was applied successfully. */
  success: boolean
  /** Error message if the projection failed. */
  error: string | null
  /** Which labels were added. */
  addedLabels: readonly string[]
  /** Which labels were removed. */
  removedLabels: readonly string[]
  /** The effective target set after any last-moment ready confirmation. */
  desiredLabels?: readonly string[]
}>

/**
 * Synchronize readiness projection labels for an issue.
 *
 * Safe ordering:
 * 1. If transitioning ready → non-ready, remove ready-for-agent FIRST.
 * 2. Remove ALL other stale readiness labels.
 * 3. Add non-ready labels (needs-clarification, dependency-blocked, tracking-only).
 * 4. For non-ready → ready, perform a final semantic confirmation immediately
 *    before adding ready-for-agent LAST.
 *
 * If this invocation promoted ready-for-agent but later verification fails, it
 * compensates by removing that promotion before returning failure. A failed
 * projection may leave a false-negative/no-ready state, never a newly-created
 * false-positive ready projection.
 */
export async function syncReadinessLabels(
  client: GitHubClient,
  issue: GitHubIssue,
  readinessResult: IssueReadinessResult,
  options: { confirmReady?: () => Promise<IssueReadinessResult> } = {},
): Promise<ProjectionResult> {
  const addedLabels: string[] = []
  const removedLabels: string[] = []

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

  const fail = async (error: string, compensateReadyPromotion = false): Promise<ProjectionResult> => {
    if (
      compensateReadyPromotion
      && addedLabels.includes('ready-for-agent')
      && !removedLabels.includes('ready-for-agent')
    ) {
      try {
        await client.removeLabel(liveIssue.number, 'ready-for-agent')
        removedLabels.push('ready-for-agent')
      } catch {
        return {
          success: false,
          error: `${error} Forge also failed to retract the ready-for-agent promotion.`,
          addedLabels,
          removedLabels,
        }
      }
    }

    return { success: false, error, addedLabels, removedLabels }
  }

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

  const currentReadinessLabels = currentLabels.filter((l) =>
    ISSUE_READINESS_MANAGED_LABELS.includes(l as typeof ISSUE_READINESS_MANAGED_LABELS[number]),
  )

  // Step 1: If transitioning ready to non-ready, remove ready-for-agent FIRST.
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

  // Step 2: Remove ALL other stale readiness labels.
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
        return await fail(`Failed to remove stale readiness label ${label} from #${issue.number}.`)
      }
    }
  }

  // Step 3: Add non-ready labels (blocking/clarification/tracking).
  for (const label of desiredLabels) {
    if (label !== 'ready-for-agent' && !currentReadinessLabels.includes(label)) {
      const preflightFailure = await preflightLabelMutation()
      if (preflightFailure) return preflightFailure
      if (!desiredLabels.includes(label)) continue
      try {
        await client.addLabel(liveIssue.number, label)
        addedLabels.push(label)
      } catch {
        return await fail(`Failed to add readiness label ${label} to #${issue.number}.`)
      }
    }
  }

  // Step 4: For non-ready → ready, add ready-for-agent LAST.
  if (!currentReadinessLabels.includes('ready-for-agent') && desiredLabels.includes('ready-for-agent')) {
    // Remove/verify stale blockers before the final semantic check. Nothing
    // except the ready add itself should sit between that check and promotion.
    try {
      const labelsAfter = (await client.getIssue(liveIssue.number)).labels
      const staleLabels = labelsAfter.filter((label) => (
        ISSUE_READINESS_MANAGED_LABELS.includes(label as typeof ISSUE_READINESS_MANAGED_LABELS[number])
        && !desiredLabels.includes(label as typeof ISSUE_READINESS_MANAGED_LABELS[number])
      ))
      if (staleLabels.length > 0) {
        return await fail(`Cannot add ready-for-agent: stale readiness labels remain: ${staleLabels.join(', ')}.`)
      }
    } catch {
      return await fail(`Failed to verify label state for #${issue.number} before adding ready-for-agent.`)
    }

    const preflightFailure = await preflightLabelMutation()
    if (preflightFailure) return preflightFailure

    if (desiredLabels.includes('ready-for-agent') && options.confirmReady) {
      try {
        const fresh = await options.confirmReady()
        if (fresh.partial) {
          return await fail(`Fresh readiness confirmation for #${issue.number} is partial.`)
        }
        desiredLabels = fresh.desiredReadinessLabels
      } catch {
        return await fail(`Failed to confirm fresh readiness for #${issue.number} before adding ready-for-agent.`)
      }
    }

    if (!desiredLabels.includes('ready-for-agent')) {
      // Fresh semantics changed after stale blockers were removed. Converge to
      // the new non-ready target without ever publishing ready-for-agent.
      for (const label of desiredLabels) {
        let present = false
        try {
          present = (await client.getIssue(liveIssue.number)).labels.includes(label)
        } catch {
          return await fail(`Failed to verify fresh readiness labels for #${issue.number}.`)
        }
        if (!present) {
          const nonReadyPreflightFailure = await preflightLabelMutation()
          if (nonReadyPreflightFailure) return nonReadyPreflightFailure
          if (!desiredLabels.includes(label)) continue
          try {
            await client.addLabel(liveIssue.number, label)
            addedLabels.push(label)
          } catch {
            return await fail(`Failed to add fresh readiness label ${label} to #${issue.number}.`)
          }
        }
      }
    } else {
      // Final semantic confirmation above was deliberately the last I/O before
      // promotion. The exact-set verification below detects any concurrent
      // label race after the add and compensates the promotion on failure.
      try {
        await client.addLabel(liveIssue.number, 'ready-for-agent')
        addedLabels.push('ready-for-agent')
      } catch {
        return await fail(`Failed to add ready-for-agent to #${issue.number}.`)
      }
    }
  }

  // Catch a close that arrived after all planned writes (including the no-op
  // case) and clean managed labels rather than reporting a stale target.
  try {
    const currentIssue = await client.getIssue(liveIssue.number)
    if (currentIssue.state.toLowerCase() === 'closed') {
      desiredLabels = []
      for (const label of currentIssue.labels.filter((candidate) => (
        ISSUE_READINESS_MANAGED_LABELS.includes(candidate as typeof ISSUE_READINESS_MANAGED_LABELS[number])
      ))) {
        const preflightFailure = await preflightLabelMutation()
        if (preflightFailure) {
          return await fail(preflightFailure.error ?? `Failed to verify closed cleanup for #${issue.number}.`, true)
        }
        try {
          await client.removeLabel(liveIssue.number, label)
          if (!removedLabels.includes(label)) removedLabels.push(label)
        } catch {
          return await fail(`Failed to remove readiness label ${label} from closed issue #${issue.number}.`, true)
        }
      }
    }
  } catch {
    return await fail(
      `Failed to verify current issue state for #${issue.number} before final readiness projection verification.`,
      true,
    )
  }

  // Verify exact convergence, including labels accepted by GitHub but not
  // persisted as expected and concurrent mutations after ready promotion.
  try {
    const finalLabels = (await client.getIssue(liveIssue.number)).labels.filter((label) => (
      ISSUE_READINESS_MANAGED_LABELS.includes(label as typeof ISSUE_READINESS_MANAGED_LABELS[number])
    ))
    if (!setsEqual(new Set(finalLabels), new Set(desiredLabels))) {
      return await fail(
        `Readiness label projection for #${issue.number} did not converge to the requested exact label set.`,
        true,
      )
    }
  } catch {
    return await fail(`Failed to verify final readiness label state for #${issue.number}.`, true)
  }

  return { success: true, error: null, addedLabels, removedLabels, desiredLabels }
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false
  for (const item of a) {
    if (!b.has(item)) return false
  }
  return true
}
