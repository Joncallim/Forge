/**
 * Full readiness reconciliation CLI.
 *
 * Scans all open issues, computes readiness for each, and projects labels.
 * Uses plan -> validate -> apply phases with safe ordering.
 *
 * Usage: npm run forge:reconcile [--dry-run]
 *
 * No model calls.
 */

import { runMain } from './entrypoint'
import { RestGitHubClient } from '../io/github-client'
import { IssueReadinessResolver } from '../shared/issue-readiness-resolver'
import type { IssueReadinessResult } from '../contracts/issue-readiness-result'
import { ISSUE_READINESS_MANAGED_LABELS } from '../contracts/common'

type ReconcilePlan = {
  scannedIssues: number
  parsedImplementation: number
  parsedTracking: number
  parsedInvalid: number
  readyCount: number
  blockedCount: number
  clarificationCount: number
  trackingOnlyCount: number
  uniqueDependencyFetches: number
  cacheHits: number
  apiFailures: number
  graphLimitFailures: number
  labelTransitions: number
  elapsedMs: number
  errors: string[]
}

type IssueProjectionPlan = {
  issueNumber: number
  currentLabels: string[]
  desiredState: 'ready' | 'needs-clarification' | 'dependency-blocked' | 'tracking-only' | 'closed'
  desiredLabels: string[]
  readinessResult: IssueReadinessResult
}

export async function main(argv: string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): Promise<void> {
  // Parse dry-run: accept --dry-run flag, or DRY_RUN env as true/false/1/0
  const dryRunEnv = (env.DRY_RUN || env.FORGE_RECONCILE_DRY_RUN || '').toLowerCase().trim()
  const dryRun = argv.includes('--dry-run') || dryRunEnv === 'true' || dryRunEnv === '1'
  const startTime = Date.now()
  const plan: ReconcilePlan = {
    scannedIssues: 0,
    parsedImplementation: 0,
    parsedTracking: 0,
    parsedInvalid: 0,
    readyCount: 0,
    blockedCount: 0,
    clarificationCount: 0,
    trackingOnlyCount: 0,
    uniqueDependencyFetches: 0,
    cacheHits: 0,
    apiFailures: 0,
    graphLimitFailures: 0,
    labelTransitions: 0,
    elapsedMs: 0,
    errors: [],
  }

  const client = RestGitHubClient.fromEnv(env)
  const resolver = new IssueReadinessResolver(client)

  // ============================================================
  // Phase 1: Discover/normalize
  // ============================================================
  console.info(JSON.stringify({ phase: 'discover', dryRun }))

  const snapshot = await resolver.loadOpenIssueSnapshot()
  plan.scannedIssues = snapshot.issues.size

  for (const [, parsed] of snapshot.parsedMetadata) {
    if (parsed.metadata.executionMode === 'implementation') plan.parsedImplementation++
    else if (parsed.metadata.executionMode === 'tracking') plan.parsedTracking++
    else plan.parsedInvalid++
  }

  if (snapshot.exceededLimit) {
    plan.errors.push('Open issue scan exceeded configured limit or page cap. Snapshot may be incomplete.')
  }

  // ============================================================
  // Phase 2: Resolve complete semantic plan for ALL issues
  // ============================================================
  console.info(JSON.stringify({ phase: 'resolve-plan', scannedIssues: plan.scannedIssues }))

  const projectionPlan: IssueProjectionPlan[] = []

  for (const [issueNumber, issue] of snapshot.issues) {
    let readiness: IssueReadinessResult
    try {
      readiness = await resolver.resolveFromIssue(issue)
    } catch {
      plan.apiFailures++
      plan.errors.push(`Failed to resolve readiness for #${issueNumber}`)
      continue
    }

    projectionPlan.push({
      issueNumber,
      currentLabels: issue.labels,
      desiredState: readiness.state,
      desiredLabels: readiness.desiredReadinessLabels,
      readinessResult: readiness,
    })
  }

  // Record resolver metrics
  plan.uniqueDependencyFetches = resolver.uniqueDependencyFetches
  plan.cacheHits = resolver.cacheHits
  plan.apiFailures += resolver.apiFailures
  plan.graphLimitFailures = resolver.graphLimitFailures

  // ============================================================
  // Phase 3: Validate global consistency
  // ============================================================
  console.info(JSON.stringify({ phase: 'validate', projectedIssues: projectionPlan.length }))

  // Check for snapshot issues
  if (snapshot.exceededLimit) {
    plan.errors.push('Snapshot incomplete due to scan limit. No bulk mutations performed.')
  }

  // Check for resolver failures
  const failedIssues = projectionPlan.filter((p) => p.readinessResult.partial && p.readinessResult.reasonCodes.includes('queue.issue_dependency_lookup_failed'))
  if (failedIssues.length > 0) {
    plan.errors.push(`Partial/failed resolution for ${failedIssues.length} issues (API errors).`)
  }

  // If any validation errors, abort with zero mutations
  if (plan.errors.length > 0) {
    console.error(JSON.stringify({
      phase: 'aborted',
      reason: 'Validation failed. No bulk mutations applied.',
      errors: plan.errors,
      scannedIssues: plan.scannedIssues,
      projectedIssues: projectionPlan.length,
    }))
    plan.elapsedMs = Date.now() - startTime
    console.info(JSON.stringify(plan, null, 2))
    process.exit(1)
  }

  // ============================================================
  // Phase 4: Apply (only if not dry run)
  // ============================================================
  if (!dryRun) {
    // --- Step 4a: Apply removals first (remove ready-for-agent from non-ready issues) ---
    console.info(JSON.stringify({ phase: 'apply-removals' }))

    for (const item of projectionPlan) {
      if (!item.desiredLabels.includes('ready-for-agent') && item.currentLabels.includes('ready-for-agent')) {
        try {
          await client.removeLabel(item.issueNumber, 'ready-for-agent')
          plan.labelTransitions++
        } catch {
          plan.errors.push(`Failed to remove ready-for-agent from #${item.issueNumber}`)
        }
      }
    }

    // --- Step 4b: Apply non-ready projection changes (needs-clarification, dependency-blocked, tracking-only) ---
    console.info(JSON.stringify({ phase: 'apply-non-ready' }))

    for (const item of projectionPlan) {
      for (const label of item.desiredLabels) {
        if (label !== 'ready-for-agent' && !item.currentLabels.includes(label)) {
          try {
            await client.addLabel(item.issueNumber, label)
            plan.labelTransitions++
          } catch {
            plan.errors.push(`Failed to add ${label} to #${item.issueNumber}`)
          }
        }
      }
    }

    // --- Step 4c: Apply ready-for-agent LAST with fresh targeted re-resolution ---
    console.info(JSON.stringify({ phase: 'apply-ready' }))

    for (const item of projectionPlan) {
      if (!item.desiredLabels.includes('ready-for-agent')) {
        // Count non-ready states
        if (item.desiredState === 'needs-clarification') plan.clarificationCount++
        else if (item.desiredState === 'dependency-blocked') plan.blockedCount++
        else if (item.desiredState === 'tracking-only') plan.trackingOnlyCount++
        continue
      }

      // Final fresh targeted re-resolution before adding ready
      let freshReadiness: IssueReadinessResult
      try {
        const freshClient = RestGitHubClient.fromEnv(env)
        const freshResolver = new IssueReadinessResolver(freshClient)
        const freshIssue = await freshClient.getIssue(item.issueNumber)
        freshReadiness = await freshResolver.resolveFromIssue(freshIssue)
      } catch {
        plan.apiFailures++
        plan.errors.push(`Failed fresh re-resolution for #${item.issueNumber}. Skipping ready promotion.`)
        continue
      }

      if (!freshReadiness.dispatchable) {
        // State changed between plan and apply; skip promotion
        plan.errors.push(`Issue #${item.issueNumber} is no longer dispatchable after fresh re-resolution. Skipping ready promotion.`)
        continue
      }

      // Remove blocker labels before adding ready
      const blockerLabelsToRemove = ['needs-clarification', 'dependency-blocked', 'tracking-only']
      let blockerRemovalFailed = false

      for (const blockerLabel of blockerLabelsToRemove) {
        if (item.currentLabels.includes(blockerLabel)) {
          try {
            await client.removeLabel(item.issueNumber, blockerLabel)
          } catch {
            blockerRemovalFailed = true
            plan.errors.push(`Failed to remove ${blockerLabel} from #${item.issueNumber}. Cannot add ready-for-agent.`)
            break
          }
        }
      }

      if (blockerRemovalFailed) {
        // Must NOT add ready if blocker removal failed
        plan.errors.push(`Blocked ready promotion for #${item.issueNumber} due to blocker removal failure.`)
        continue
      }

      // Re-read labels to verify no stale blockers remain
      try {
        const postRemovalIssue = await client.getIssue(item.issueNumber)
        const staleBlockers = blockerLabelsToRemove.filter((l) => postRemovalIssue.labels.includes(l))
        if (staleBlockers.length > 0) {
          plan.errors.push(`Stale blocker labels remain on #${item.issueNumber}: ${staleBlockers.join(', ')}. Cannot add ready-for-agent.`)
          continue
        }
      } catch {
        plan.errors.push(`Failed to verify label state for #${item.issueNumber}. Skipping ready promotion.`)
        continue
      }

      // Add ready-for-agent LAST
      try {
        await client.addLabel(item.issueNumber, 'ready-for-agent')
        plan.labelTransitions++
        plan.readyCount++
      } catch {
        plan.errors.push(`Failed to add ready-for-agent to #${item.issueNumber}`)
      }
    }

    // --- Step 4d: Closed-issue cleanup lane ---
    // Scan a bounded set of recently closed issues that may carry stale readiness labels
    console.info(JSON.stringify({ phase: 'closed-issue-cleanup' }))

    try {
      const closedPageSize = 100
      for (let page = 1; page <= 5; page++) { // Max 500 closed issues to scan
        const { issues: closedIssues } = await client.listClosedIssues({ page, perPage: closedPageSize })
        if (closedIssues.length === 0) break

        for (const closedIssue of closedIssues) {
          const hasManagedLabel = closedIssue.labels.some((l) =>
            ISSUE_READINESS_MANAGED_LABELS.includes(l as typeof ISSUE_READINESS_MANAGED_LABELS[number]),
          )
          if (hasManagedLabel) {
            // Remove stale readiness labels from closed issues
            for (const label of ISSUE_READINESS_MANAGED_LABELS) {
              if (closedIssue.labels.includes(label)) {
                try {
                  await client.removeLabel(closedIssue.number, label)
                  plan.labelTransitions++
                } catch {
                  plan.errors.push(`Failed to remove stale ${label} from closed #${closedIssue.number}`)
                }
              }
            }
          }
        }
      }
    } catch {
      plan.errors.push('Closed-issue cleanup lane encountered an error. Continuing.')
    }

  } else {
    // Dry run: just count states from the plan
    for (const item of projectionPlan) {
      if (item.desiredState === 'ready') plan.readyCount++
      else if (item.desiredState === 'needs-clarification') plan.clarificationCount++
      else if (item.desiredState === 'dependency-blocked') plan.blockedCount++
      else if (item.desiredState === 'tracking-only') plan.trackingOnlyCount++
    }
  }

  // ============================================================
  // Report
  // ============================================================
  plan.elapsedMs = Date.now() - startTime
  console.info(JSON.stringify(plan, null, 2))

  if (plan.errors.length > 0) {
    process.exit(1)
  }
}

runMain(import.meta.url, () => main())
