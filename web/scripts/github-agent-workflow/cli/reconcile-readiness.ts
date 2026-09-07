/** Full readiness reconciliation CLI. */
import { runMain } from './entrypoint'
import { RestGitHubClient, type GitHubClient, type GitHubIssue } from '../io/github-client'
import { IssueReadinessResolver } from '../shared/issue-readiness-resolver'
import { syncReadinessLabels } from '../shared/readiness-projection'
import type { IssueReadinessResult } from '../contracts/issue-readiness-result'
import { ISSUE_READINESS_MANAGED_LABELS } from '../contracts/common'

const CLOSED_SCAN_MAX_PAGES = 50
const ISSUE_PAGE_SIZE = 100
type PlannedIssue = Readonly<{ issue: GitHubIssue; readiness: IssueReadinessResult | null; closedCleanup: boolean }>
type PlannedLabelMutation = Readonly<{ issueNumber: number; add: readonly string[]; remove: readonly string[] }>
type ReconcilePlan = { scannedIssues: number; closedIssuesScanned: number; readyCount: number; blockedCount: number; clarificationCount: number; trackingOnlyCount: number; plannedLabelMutations: PlannedLabelMutation[]; labelTransitions: number; apiFailures: number; elapsedMs: number; errors: string[] }

function managedLabels(labels: readonly string[]): string[] {
  return labels.filter((label) => ISSUE_READINESS_MANAGED_LABELS.includes(label as typeof ISSUE_READINESS_MANAGED_LABELS[number])).sort()
}
function sameLabels(left: readonly string[], right: readonly string[]): boolean { return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort()) }

async function discoverClosedIssues(client: GitHubClient): Promise<{ issues: GitHubIssue[]; incomplete: boolean }> {
  const issues = new Map<number, GitHubIssue>()
  for (const label of ISSUE_READINESS_MANAGED_LABELS) {
    let complete = false
    for (let page = 1; page <= CLOSED_SCAN_MAX_PAGES; page += 1) {
      const result = await client.listClosedIssues({ page, perPage: ISSUE_PAGE_SIZE, maxPages: CLOSED_SCAN_MAX_PAGES, label })
      for (const issue of result.issues) issues.set(issue.number, issue)
      if (!result.hasMore) { complete = true; break }
    }
    // Each label is a distinct bounded inventory. A cap in any one of them
    // makes cleanup unsafe to claim complete, even if other labels completed.
    if (!complete) return { issues: [...issues.values()], incomplete: true }
  }
  return { issues: [...issues.values()], incomplete: false }
}

async function applyClosedCleanup(client: GitHubClient, issue: GitHubIssue): Promise<number> {
  // The bounded discovery snapshot can be stale. A reopened issue belongs to
  // the open semantic plan, never closed-label cleanup.
  const current = await client.getIssue(issue.number)
  if (current.state !== 'closed') return 0
  const labels = managedLabels(current.labels)
  for (const label of labels) await client.removeLabel(issue.number, label)
  if (managedLabels((await client.getIssue(issue.number)).labels).length !== 0) throw new Error(`Closed issue #${issue.number} still has managed readiness labels after cleanup.`)
  return labels.length
}

async function applyOpenProjection(client: GitHubClient, planned: PlannedIssue): Promise<number> {
  if (!planned.readiness) throw new Error(`Open issue #${planned.issue.number} has no readiness plan.`)
  // A planned-ready result is only a candidate for authority. Re-resolve it
  // immediately before its ready projection so a dependency or metadata change
  // during the bounded plan phase cannot promote stale readiness. If it became
  // non-ready, the same shared writer projects that fresh blocked state.
  let issue = planned.issue
  let readiness = planned.readiness
  if (planned.readiness.dispatchable) {
    issue = await client.getIssue(planned.issue.number)
    const freshResolver = new IssueReadinessResolver(client)
    readiness = await freshResolver.resolveFromIssue(issue)
    if (readiness.partial) throw new Error(`Fresh readiness result for #${issue.number} is partial.`)
  }

  const projected = await syncReadinessLabels(client, issue, readiness)
  if (!projected.success) throw new Error(projected.error ?? `Failed to project readiness for #${planned.issue.number}.`)
  // Require exact convergence: writer errors must never be a silent partial bulk run.
  if (!sameLabels(managedLabels((await client.getIssue(issue.number)).labels), readiness.desiredReadinessLabels)) {
    throw new Error(`Readiness projection for #${planned.issue.number} did not converge to the planned labels.`)
  }
  return projected.addedLabels.length + projected.removedLabels.length
}

export async function main(argv: string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const value = (env.DRY_RUN || env.FORGE_RECONCILE_DRY_RUN || '').trim().toLowerCase()
  const dryRun = argv.includes('--dry-run') || value === 'true' || value === '1'
  const start = Date.now()
  const plan: ReconcilePlan = { scannedIssues: 0, closedIssuesScanned: 0, readyCount: 0, blockedCount: 0, clarificationCount: 0, trackingOnlyCount: 0, plannedLabelMutations: [], labelTransitions: 0, apiFailures: 0, elapsedMs: 0, errors: [] }
  const client = RestGitHubClient.fromEnv(env)
  const resolver = new IssueReadinessResolver(client)
  const planned: PlannedIssue[] = []

  console.info(JSON.stringify({ phase: 'discover', dryRun }))
  let snapshot: Awaited<ReturnType<IssueReadinessResolver['loadOpenIssueSnapshot']>>
  let closed: { issues: GitHubIssue[]; incomplete: boolean }
  try { [snapshot, closed] = await Promise.all([resolver.loadOpenIssueSnapshot(), discoverClosedIssues(client)]) }
  catch (error) { throw new Error(`Readiness discovery failed; no labels were changed: ${error instanceof Error ? error.message : String(error)}`) }
  plan.scannedIssues = snapshot.issues.size
  plan.closedIssuesScanned = closed.issues.length
  if (snapshot.exceededLimit) plan.errors.push('Open issue inventory is incomplete.')
  if (closed.incomplete) plan.errors.push('Closed issue inventory is incomplete.')

  console.info(JSON.stringify({ phase: 'plan', openIssues: plan.scannedIssues, closedIssues: plan.closedIssuesScanned }))
  for (const issue of snapshot.issues.values()) {
    try {
      const facts = snapshot.parsedMetadata.get(issue.number)
      if (!facts) throw new Error(`Normalized readiness facts are missing for #${issue.number}.`)
      const readiness = await resolver.resolveFromSnapshot(issue, facts)
      if (readiness.partial) plan.errors.push(`Readiness plan for #${issue.number} is partial.`)
      planned.push({ issue, readiness, closedCleanup: false })
      if (readiness.state === 'ready') plan.readyCount += 1
      else if (readiness.state === 'dependency-blocked') plan.blockedCount += 1
      else if (readiness.state === 'needs-clarification') plan.clarificationCount += 1
      else if (readiness.state === 'tracking-only') plan.trackingOnlyCount += 1
    } catch (error) { plan.apiFailures += 1; plan.errors.push(`Failed to plan #${issue.number}: ${error instanceof Error ? error.message : String(error)}`) }
  }
  for (const issue of closed.issues) planned.push({ issue, readiness: null, closedCleanup: true })
  plan.apiFailures += resolver.apiFailures
  if (resolver.graphLimitFailures > 0) plan.errors.push(`Dependency graph limits were reached for ${resolver.graphLimitFailures} issue(s).`)

  console.info(JSON.stringify({ phase: 'validate', plannedIssues: planned.length }))
  if (planned.length !== plan.scannedIssues + plan.closedIssuesScanned) plan.errors.push('Discovery and plan counts do not match.')
  for (const item of planned) {
    const current = managedLabels(item.issue.labels)
    const desired = item.closedCleanup ? [] : item.readiness?.desiredReadinessLabels ?? []
    const add = desired.filter((label) => !current.includes(label))
    const remove = current.filter((label) => !desired.includes(label as typeof ISSUE_READINESS_MANAGED_LABELS[number]))
    if (add.length > 0 || remove.length > 0) plan.plannedLabelMutations.push({ issueNumber: item.issue.number, add, remove })
  }
  if (plan.errors.length > 0) {
    plan.elapsedMs = Date.now() - start
    console.error(JSON.stringify({ phase: 'aborted', ...plan }))
    throw new Error('Readiness reconciliation validation failed; no labels were changed.')
  }
  if (!dryRun) {
    console.info(JSON.stringify({ phase: 'apply', plannedIssues: planned.length }))
    for (const item of planned) {
      try { plan.labelTransitions += item.closedCleanup ? await applyClosedCleanup(client, item.issue) : await applyOpenProjection(client, item) }
      catch (error) { plan.errors.push(`Apply failed for #${item.issue.number}: ${error instanceof Error ? error.message : String(error)}`); break }
    }
  }
  plan.elapsedMs = Date.now() - start
  console.info(JSON.stringify(plan, null, 2))
  if (plan.errors.length > 0) throw new Error('Readiness reconciliation did not complete.')
}

runMain(import.meta.url, () => main())
