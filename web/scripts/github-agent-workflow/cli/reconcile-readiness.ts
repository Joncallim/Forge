/**
 * Full readiness reconciliation CLI.
 *
 * Scans all open issues, computes readiness for each, and projects labels.
 * Uses plan -> validate -> apply phases.
 *
 * Usage: npm run forge:reconcile [--dry-run]
 *
 * No model calls.
 */

import { runMain } from './entrypoint'
import { RestGitHubClient } from '../io/github-client'
import { IssueReadinessResolver } from '../shared/issue-readiness-resolver'
import type { IssueReadinessResult } from '../contracts/issue-readiness-result'

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

export async function main(argv: string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const dryRun = argv.includes('--dry-run') || env.DRY_RUN === '1' || env.FORGE_RECONCILE_DRY_RUN === '1'
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

  // Phase 1: Discover/normalize
  console.info(JSON.stringify({ phase: 'discover', dryRun }))

  const snapshot = await resolver.loadOpenIssueSnapshot()
  plan.scannedIssues = snapshot.issues.size

  for (const [, parsed] of snapshot.parsedMetadata) {
    if (parsed.metadata.executionMode === 'implementation') plan.parsedImplementation++
    else if (parsed.metadata.executionMode === 'tracking') plan.parsedTracking++
    else plan.parsedInvalid++
  }

  if (snapshot.exceededLimit) {
    plan.errors.push('Open issue scan exceeded configured limit.')
  }

  // Phase 2: Validate that we have a consistent snapshot
  console.info(JSON.stringify({ phase: 'validate', scannedIssues: plan.scannedIssues }))

  if (snapshot.exceededLimit || plan.errors.length > 0) {
    console.error(JSON.stringify({
      phase: 'aborted',
      reason: 'Snapshot incomplete or validation failed. No bulk mutations applied.',
      errors: plan.errors,
    }))
    plan.elapsedMs = Date.now() - startTime
    console.info(JSON.stringify(plan, null, 2))
    process.exit(1)
  }

  // Phase 3: Apply (only if not dry run)
  if (!dryRun) {
    console.info(JSON.stringify({ phase: 'apply-removals' }))

    // Apply removals first: remove ready-for-agent from non-ready issues
    for (const [issueNumber, issue] of snapshot.issues) {
      const parsed = snapshot.parsedMetadata.get(issueNumber)
      if (!parsed) continue

      let readiness: IssueReadinessResult
      try {
        readiness = await resolver.resolveFromIssue(issue)
      } catch {
        plan.apiFailures++
        continue
      }

      const currentLabels = issue.labels
      const desiredLabels = readiness.desiredReadinessLabels

      // Remove stale ready-for-agent first
      if (currentLabels.includes('ready-for-agent') && !desiredLabels.includes('ready-for-agent')) {
        try {
          await client.removeLabel(issueNumber, 'ready-for-agent')
          plan.labelTransitions++
        } catch {
          plan.errors.push(`Failed to remove ready-for-agent from #${issueNumber}`)
        }
      }
    }

    // Apply non-ready projection changes
    console.info(JSON.stringify({ phase: 'apply-non-ready' }))
    for (const [issueNumber, issue] of snapshot.issues) {
      const parsed = snapshot.parsedMetadata.get(issueNumber)
      if (!parsed) continue

      let readiness: IssueReadinessResult
      try {
        readiness = await resolver.resolveFromIssue(issue)
      } catch {
        continue
      }

      const currentLabels = issue.labels
      const desiredLabels = readiness.desiredReadinessLabels

      for (const label of desiredLabels) {
        if (label !== 'ready-for-agent' && !currentLabels.includes(label)) {
          try {
            await client.addLabel(issueNumber, label)
            plan.labelTransitions++
          } catch {
            plan.errors.push(`Failed to add ${label} to #${issueNumber}`)
          }
        }
      }
    }

    // Apply ready-for-agent last (with fresh re-resolution)
    console.info(JSON.stringify({ phase: 'apply-ready' }))
    for (const [issueNumber, issue] of snapshot.issues) {
      const parsed = snapshot.parsedMetadata.get(issueNumber)
      if (!parsed) continue

      // Re-resolve fresh before adding ready
      let readiness: IssueReadinessResult
      try {
        const freshIssue = await client.getIssue(issueNumber)
        readiness = await resolver.resolveFromIssue(freshIssue)
      } catch {
        plan.apiFailures++
        continue
      }

      if (readiness.dispatchable) {
        const currentLabels = issue.labels
        if (!currentLabels.includes('ready-for-agent')) {
          // Remove blocking labels first
          for (const blockingLabel of ['needs-clarification', 'dependency-blocked', 'tracking-only']) {
            if (currentLabels.includes(blockingLabel)) {
              try {
                await client.removeLabel(issueNumber, blockingLabel)
              } catch {
                // Non-critical
              }
            }
          }
          // Add ready last
          try {
            await client.addLabel(issueNumber, 'ready-for-agent')
            plan.labelTransitions++
            plan.readyCount++
          } catch {
            plan.errors.push(`Failed to add ready-for-agent to #${issueNumber}`)
          }
        } else {
          plan.readyCount++
        }
      } else {
        if (readiness.state === 'needs-clarification') plan.clarificationCount++
        else if (readiness.state === 'dependency-blocked') plan.blockedCount++
        else if (readiness.state === 'tracking-only') plan.trackingOnlyCount++
      }
    }
  } else {
    // Dry run: just count
    for (const [issueNumber, issue] of snapshot.issues) {
      const parsed = snapshot.parsedMetadata.get(issueNumber)
      if (!parsed) continue

      let readiness: IssueReadinessResult
      try {
        readiness = await resolver.resolveFromIssue(issue)
      } catch {
        continue
      }

      if (readiness.dispatchable) plan.readyCount++
      else if (readiness.state === 'needs-clarification') plan.clarificationCount++
      else if (readiness.state === 'dependency-blocked') plan.blockedCount++
      else if (readiness.state === 'tracking-only') plan.trackingOnlyCount++
    }
  }

  plan.elapsedMs = Date.now() - startTime
  console.info(JSON.stringify(plan, null, 2))

  if (plan.errors.length > 0) {
    process.exit(1)
  }
}

runMain(import.meta.url, () => main())
