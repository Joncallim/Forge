/** Full readiness reconciliation CLI. */
import { runMain } from './entrypoint'
import { RestGitHubClient, type GitHubClient, type GitHubIssue } from '../io/github-client'
import { IssueReadinessResolver } from '../shared/issue-readiness-resolver'
import { syncReadinessLabels } from '../shared/readiness-projection'
import type { IssueReadinessResult } from '../contracts/issue-readiness-result'
import { ISSUE_READINESS_MANAGED_LABELS } from '../contracts/common'

const CLOSED_SCAN_MAX_PAGES = 50
const ISSUE_PAGE_SIZE = 100
export type PlannedIssue = Readonly<{ issue: GitHubIssue; readiness: IssueReadinessResult | null; closedCleanup: boolean }>
type PlannedLabelMutation = Readonly<{ issueNumber: number; add: readonly string[]; remove: readonly string[] }>
type ReconcilePlan = { scannedIssues: number; closedIssuesScanned: number; readyCount: number; blockedCount: number; clarificationCount: number; trackingOnlyCount: number; plannedLabelMutations: PlannedLabelMutation[]; labelTransitions: number; apiFailures: number; uniqueDependencyFetches: number; dependencyCacheHits: number; graphLimitFailures: number; apiFailureClasses: Record<string, number>; elapsedMs: number; errors: string[] }

function managedLabels(labels: readonly string[]): string[] {
  return labels.filter((label) => ISSUE_READINESS_MANAGED_LABELS.includes(label as typeof ISSUE_READINESS_MANAGED_LABELS[number])).sort()
}
function sameLabels(left: readonly string[], right: readonly string[]): boolean { return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort()) }

/** Reject a non-atomic open/closed inventory before the apply phase. */
export function inventoryOverlap(openIssues: ReadonlyMap<number, GitHubIssue>, closedIssues: readonly GitHubIssue[]): number[] {
  return closedIssues.filter((issue) => openIssues.has(issue.number)).map((issue) => issue.number)
}

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

export async function applyClosedCleanup(client: GitHubClient, issue: GitHubIssue): Promise<number> {
  // The bounded discovery snapshot can be stale. A reopened issue belongs to
  // the open semantic plan, never closed-label cleanup.
  const current = await client.getIssue(issue.number)
  if (current.state !== 'closed') {
    // The closed-lane snapshot is stale. Re-enter the current open semantic
    // path rather than silently leaving labels unprojected after a reopen.
    const freshResolver = new IssueReadinessResolver(client)
    const readiness = await freshResolver.resolveFromIssue(current)
    if (readiness.partial) throw new Error(`Fresh readiness result for reopened #${current.number} is partial.`)
    return await applyOpenProjection(client, { issue: current, readiness, closedCleanup: false })
  }
  const labels = managedLabels(current.labels)
  for (const label of labels) await client.removeLabel(issue.number, label)
  if (managedLabels((await client.getIssue(issue.number)).labels).length !== 0) throw new Error(`Closed issue #${issue.number} still has managed readiness labels after cleanup.`)
  return labels.length
}

/** First frozen apply lane: never add a non-ready projection while another
 * planned non-ready target still advertises ready-for-agent. */
async function removePlannedStaleReady(client: GitHubClient, item: PlannedIssue): Promise<number> {
  if (!item.closedCleanup && item.readiness?.state === 'ready') return 0
  const current = await client.getIssue(item.issue.number)
  if (current.labels.includes('ready-for-agent')) {
    await client.removeLabel(item.issue.number, 'ready-for-agent')
    return 1
  }
  return 0
}

export async function applyOpenProjection(client: GitHubClient, planned: PlannedIssue): Promise<number> {
  if (!planned.readiness) throw new Error(`Open issue #${planned.issue.number} has no readiness plan.`)
  // Every open-plan item is re-read immediately before writes. In particular,
  // a close event between discovery and apply must use terminal cleanup, never
  // project a stale blocked/ready label set onto a closed issue.
  const issue = await client.getIssue(planned.issue.number)
  if (issue.state === 'closed') return await applyClosedCleanup(client, issue)

  // The plan is advisory only: fresh semantics are authoritative for both
  // planned-ready and planned-non-ready targets. This prevents a blocked plan
  // from overwriting a newly-ready issue, and vice versa.
  const freshResolver = new IssueReadinessResolver(client)
  const readiness = await freshResolver.resolveFromIssue(issue)
  if (readiness.partial) throw new Error(`Fresh readiness result for #${issue.number} is partial.`)

  const projected = await syncReadinessLabels(client, issue, readiness, {
    // This callback is deliberately no-cache: it is the final semantic gate
    // immediately before ready-for-agent can be added.
    confirmReady: async () => await new IssueReadinessResolver(client).resolveReadiness(issue.number),
  })
  if (!projected.success) throw new Error(projected.error ?? `Failed to project readiness for #${planned.issue.number}.`)
  // Require exact convergence: writer errors must never be a silent partial bulk run.
  if (!sameLabels(managedLabels((await client.getIssue(issue.number)).labels), projected.desiredLabels ?? readiness.desiredReadinessLabels)) {
    throw new Error(`Readiness projection for #${planned.issue.number} did not converge to the effective labels.`)
  }
  return projected.addedLabels.length + projected.removedLabels.length
}

export async function main(argv: string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env, clientOverride?: GitHubClient): Promise<void> {
  const value = (env.DRY_RUN || env.FORGE_RECONCILE_DRY_RUN || '').trim().toLowerCase()
  const dryRun = argv.includes('--dry-run') || value === 'true' || value === '1'
  const start = Date.now()
  const plan: ReconcilePlan = { scannedIssues: 0, closedIssuesScanned: 0, readyCount: 0, blockedCount: 0, clarificationCount: 0, trackingOnlyCount: 0, plannedLabelMutations: [], labelTransitions: 0, apiFailures: 0, uniqueDependencyFetches: 0, dependencyCacheHits: 0, graphLimitFailures: 0, apiFailureClasses: {}, elapsedMs: 0, errors: [] }
  const client = clientOverride ?? RestGitHubClient.fromEnv(env)
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
  plan.uniqueDependencyFetches = resolver.uniqueDependencyFetches
  plan.dependencyCacheHits = resolver.cacheHits
  plan.graphLimitFailures = resolver.graphLimitFailures
  plan.apiFailureClasses = { ...resolver.apiFailureClasses }
  if (resolver.graphLimitFailures > 0) plan.errors.push(`Dependency graph limits were reached for ${resolver.graphLimitFailures} issue(s).`)

  console.info(JSON.stringify({ phase: 'validate', plannedIssues: planned.length }))
  if (planned.length !== plan.scannedIssues + plan.closedIssuesScanned) plan.errors.push('Discovery and plan counts do not match.')
  const overlappingInventory = inventoryOverlap(snapshot.issues, closed.issues)
  if (overlappingInventory.length > 0) {
    plan.errors.push(`Open and closed inventories overlap for issue(s): ${overlappingInventory.map((number) => `#${number}`).join(', ')}.`)
  }
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
    // Freeze globally: clear every stale ready label before any target can be
    // promoted. Only targets with a planned mutation need a fresh apply; this
    // keeps unchanged backlog items out of the per-target GET amplification.
    const changed = new Set(plan.plannedLabelMutations.map((mutation) => mutation.issueNumber))
    const nonReady = planned.filter((item) => item.closedCleanup || item.readiness?.state !== 'ready')
    const ready = planned.filter((item) => !item.closedCleanup && item.readiness?.state === 'ready')
    try {
      for (const item of nonReady) {
        if (changed.has(item.issue.number)) plan.labelTransitions += await removePlannedStaleReady(client, item)
      }
    } catch (error) {
      plan.errors.push(`Apply failed while removing stale ready labels: ${error instanceof Error ? error.message : String(error)}`)
    }
    for (const item of [...nonReady, ...ready]) {
      if (plan.errors.length > 0) break
      if (!changed.has(item.issue.number)) continue
      try { plan.labelTransitions += item.closedCleanup ? await applyClosedCleanup(client, item.issue) : await applyOpenProjection(client, item) }
      catch (error) { plan.errors.push(`Apply failed for #${item.issue.number}: ${error instanceof Error ? error.message : String(error)}`); break }
    }
  }
  plan.elapsedMs = Date.now() - start
  console.info(JSON.stringify(plan, null, 2))
  if (plan.errors.length > 0) throw new Error('Readiness reconciliation did not complete.')
}

runMain(import.meta.url, () => main())
