/**
 * Shared readiness resolver.
 *
 * This is the single I/O service that computes semantic readiness from
 * current GitHub truth. It is used by:
 *   - intake projection
 *   - agent-command admission
 *   - dispatch admission
 *   - handoff admission
 *   - pre-runtime readiness check
 *
 * It owns:
 *   - fresh target issue/dependency resolution
 *   - repository snapshot/cache for reconciliation runs
 *   - graph limits and cycle handling
 *   - stable fail-closed result generation
 *
 * No model call is permitted anywhere in this module.
 */

import type { GitHubClient, GitHubIssue } from '../io/github-client'
import { GitHubApiError } from '../io/github-client'
import type { IssueType } from '../contracts/common'
import type { ControlDiagnostic, IssueControlMetadata } from '../contracts/issue-control-metadata'
import type { IssueReadinessResult, ReadinessReasonCode } from '../contracts/issue-readiness-result'
import type { ResolvedDependencyFact } from '../core/issue-readiness'
import { evaluateReadiness } from '../core/issue-readiness'
import { parseControlMetadata } from '../core/issue-control'
import { detectIssueType, validateIssue } from '../core/issue-validation'
import { scanVisibleMarkdownLines } from '../core/visible-markdown-scanner'
import { MAX_GRAPH_DEPTH, MAX_GRAPH_NODES, detectCycle, getTransitiveDependencies, type DependencyNode } from '../core/dependency-graph'

/**
 * Options for readiness resolution.
 */
export type ReadinessResolverOptions = Readonly<{
  /**
   * Maximum concurrent GitHub fetches for dependency resolution.
   */
  maxFetchConcurrency?: number
  /**
   * Maximum open issues to scan during full reconciliation.
   */
  maxOpenIssuesScan?: number
}>

/** Bounded, body-free facts retained by a full-reconcile snapshot. */
export type SnapshotIssueReadinessFacts = Readonly<{
  issueType: IssueType
  metadata: IssueControlMetadata
  structuralValid: boolean
  structuralErrors: readonly string[]
  bodyTooLarge: boolean
  controlParseErrors: readonly string[]
  controlDiagnostics: readonly ControlDiagnostic[]
  hasDuplicateDeclaration: boolean
}>

const DEFAULT_FETCH_CONCURRENCY = 8
const DEFAULT_MAX_OPEN_ISSUES_SCAN = 5000

/**
 * Shared readiness resolver.
 */
export class IssueReadinessResolver {
  private readonly client: GitHubClient
  private readonly options: Required<ReadinessResolverOptions>
  /**
   * Memoized dependency facts (including in-flight promises).
   */
  private readonly dependencyCache = new Map<number, Promise<ResolvedDependencyFact>>()
  private activeFetches = 0
  private readonly fetchWaiters: Array<() => void> = []
  /**
   * Counters for operational metrics.
   */
  uniqueDependencyFetches = 0
  cacheHits = 0
  graphLimitFailures = 0
  apiFailures = 0
  /** Bounded internal failure classifications for reconcile observability. */
  readonly apiFailureClasses: Record<'not-found' | 'permission' | 'rate-limit' | 'network-timeout' | 'server' | 'invalid-response', number> = {
    'not-found': 0, permission: 0, 'rate-limit': 0, 'network-timeout': 0, server: 0, 'invalid-response': 0,
  }

  constructor(client: GitHubClient, options: ReadinessResolverOptions = {}) {
    this.client = client
    this.options = {
      maxFetchConcurrency: Math.min(8, Math.max(1, options.maxFetchConcurrency ?? DEFAULT_FETCH_CONCURRENCY)),
      maxOpenIssuesScan: options.maxOpenIssuesScan ?? DEFAULT_MAX_OPEN_ISSUES_SCAN,
    }
  }

  /**
   * Resolve semantic readiness for a single target issue.
   *
   * Performs fresh GitHub I/O for the target and its dependencies.
   * Results are memoized for the lifetime of this resolver instance.
   */
  async resolveReadiness(issueNumber: number): Promise<IssueReadinessResult> {
    let issue: GitHubIssue
    try {
      issue = await this.client.getIssue(issueNumber)
    } catch {
      this.apiFailures++
      return this.failClosed(issueNumber, 'queue.issue_dependency_lookup_failed', [
        { reasonCode: 'queue.issue_dependency_lookup_failed' as ReadinessReasonCode, detail: `Failed to fetch issue #${issueNumber}.`, dependencyIssueNumber: null },
      ])
    }

    return await this.resolveFromIssue(issue)
  }

  /**
   * Resolve readiness from an already-fetched issue object.
   */
  async resolveFromIssue(issue: GitHubIssue): Promise<IssueReadinessResult> {
    const body = issue.body ?? ''
    const issueType = detectIssueType({ title: issue.title, body })

    // Scan visible lines first to detect bodyTooLarge
    const scanResult = scanVisibleMarkdownLines(body)
    const bodyTooLarge = scanResult.bodyTooLarge

    // Structural validation
    const structuralResult = validateIssue({
      number: issue.number,
      title: issue.title,
      body,
    })

    // Control metadata
    const controlResult = parseControlMetadata(body, issueType)

    return await this.resolveFromFacts(issue, {
      issueType,
      metadata: controlResult.metadata,
      structuralValid: structuralResult.valid,
      structuralErrors: structuralResult.missingSections,
      bodyTooLarge,
      controlParseErrors: controlResult.errors,
      controlDiagnostics: controlResult.diagnostics,
      hasDuplicateDeclaration: controlResult.hasDuplicateDeclaration,
    })
  }

  /** Resolve a body-free issue retained by the bounded reconciliation snapshot. */
  async resolveFromSnapshot(issue: GitHubIssue, facts: SnapshotIssueReadinessFacts): Promise<IssueReadinessResult> {
    return await this.resolveFromFacts(issue, facts)
  }

  private async resolveFromFacts(issue: GitHubIssue, facts: SnapshotIssueReadinessFacts): Promise<IssueReadinessResult> {

    // /issues also returns pull requests. A target PR is never a dispatchable
    // work item, even if it happens to contain an otherwise valid issue body.
    if (issue.isPullRequest) {
      return this.failClosed(issue.number, 'queue.issue_dependency_is_pull_request', [
        { reasonCode: 'queue.issue_dependency_is_pull_request', detail: `Target #${issue.number} is a pull request, not an issue.`, dependencyIssueNumber: null },
      ])
    }

    // Determine issue state
    const issueState = mapIssueState(issue.state)
    const stateUnknown = issueState === 'unknown'

    // Resolve dependencies (only if not bodyTooLarge and not unknown state)
    let dependencyFacts: readonly ResolvedDependencyFact[] = []
    let hasCycle = false
    let graphLimitExceeded = false

    // Closed targets are terminal projection cleanup.  They must not consume
    // dependency graph/API budget merely because their historic body was valid.
    if (issueState !== 'closed' && !facts.bodyTooLarge && !stateUnknown && facts.controlDiagnostics.length === 0) {
      dependencyFacts = await this.resolveDependencies(
        issue.number,
        facts.metadata,
      )

      // Cycle detection using the already-resolved dependency facts
      const cycleResult = await this.detectCyclesAsync(issue.number, facts.metadata, dependencyFacts)
      hasCycle = cycleResult.hasCycle
      graphLimitExceeded = cycleResult.limitExceeded
      dependencyFacts = cycleResult.facts
    }

    // Evaluate readiness with all propagated state
    return evaluateReadiness({
      issueNumber: issue.number,
      issueState,
      issueType: facts.issueType,
      controlMetadata: facts.metadata,
      structuralValid: facts.structuralValid,
      structuralErrors: facts.structuralErrors,
      dependencyFacts,
      hasCycle,
      graphLimitExceeded,
      bodyTooLarge: facts.bodyTooLarge,
      controlParseErrors: facts.controlParseErrors,
      controlDiagnostics: facts.controlDiagnostics,
      hasDuplicateDeclaration: facts.hasDuplicateDeclaration,
      stateUnknown,
    })
  }

  /**
   * Resolve dependency facts for the given issue's dependencies.
   * Uses bounded concurrency and memoization.
   */
  private async resolveDependencies(
    issueNumber: number,
    metadata: IssueControlMetadata,
  ): Promise<readonly ResolvedDependencyFact[]> {
    if (metadata.dependencies.length === 0) return []

    // Build unique dependency list (excluding self)
    const uniqueDeps = [...new Set(metadata.dependencies.filter((d) => d !== issueNumber))]
    const facts: ResolvedDependencyFact[] = []

    // Handle self-dependency
    if (metadata.dependencies.includes(issueNumber)) {
      facts.push({
        issueNumber,
        state: 'closed_unknown',
        reasonCode: 'queue.issue_dependency_self' as ReadinessReasonCode,
        transitiveDependencyIssueNumbers: [],
      })
    }

    // Handle duplicate dependency references
    const seen = new Set<number>()
    for (const dep of metadata.dependencies) {
      if (dep === issueNumber) continue
      if (seen.has(dep)) {
        facts.push({
          issueNumber: dep,
          state: 'closed_unknown',
          reasonCode: 'queue.issue_dependency_duplicate' as ReadinessReasonCode,
          transitiveDependencyIssueNumbers: [],
        })
      }
      seen.add(dep)
    }

    // Fetch unique dependencies with bounded concurrency
    const concurrency = this.options.maxFetchConcurrency
    const results: Array<{ index: number; fact: ResolvedDependencyFact }> = []
    const depSet = [...new Set(uniqueDeps)]

    // Process in batches of `concurrency`
    for (let i = 0; i < depSet.length; i += concurrency) {
      const batch = depSet.slice(i, i + concurrency)
      const batchResults = await Promise.all(
        batch.map((dep) => this.fetchDependencyFact(dep).then((fact) => ({ index: i + batch.indexOf(dep), fact }))),
      )
      results.push(...batchResults)
    }

    // Sort results by original index
    results.sort((a, b) => a.index - b.index)
    facts.push(...results.map((r) => r.fact))

    return facts
  }

  /**
   * Fetch a single dependency fact with memoization including in-flight promises.
   */
  private fetchDependencyFact(dependencyNumber: number): Promise<ResolvedDependencyFact> {
    const cached = this.dependencyCache.get(dependencyNumber)
    if (cached) {
      this.cacheHits++
      return cached
    }

    this.uniqueDependencyFetches++
    const promise = this.withFetchSlot(() => this.doFetchDependencyFact(dependencyNumber))
    this.dependencyCache.set(dependencyNumber, promise)
    return promise
  }

  private async withFetchSlot<T>(operation: () => Promise<T>): Promise<T> {
    if (this.activeFetches >= this.options.maxFetchConcurrency) {
      await new Promise<void>((resolve) => this.fetchWaiters.push(resolve))
    }
    this.activeFetches++
    try {
      return await operation()
    } finally {
      this.activeFetches--
      this.fetchWaiters.shift()?.()
    }
  }

  private async doFetchDependencyFact(dependencyNumber: number): Promise<ResolvedDependencyFact> {
    try {
      const issue = await this.client.getIssue(dependencyNumber)

      // Check if it's a pull request
      if (issue.isPullRequest) {
        return {
          issueNumber: dependencyNumber,
          state: 'is_pull_request',
          reasonCode: 'queue.issue_dependency_is_pull_request' as ReadinessReasonCode,
          transitiveDependencyIssueNumbers: [],
        }
      }

      // Completed dependencies are terminal satisfied leaves regardless of
      // their historical type or control metadata.
      if (issue.state === 'closed' && issue.stateReason === 'completed') {
        return {
          issueNumber: dependencyNumber,
          state: 'closed_completed',
          reasonCode: 'queue.issue_dependency_open' as ReadinessReasonCode,
          transitiveDependencyIssueNumbers: [],
        }
      }

      // Derive tracking semantics from body/control contract, NOT from labels.
      // Only an open tracking issue is invalid as a dependency; completed
      // tracking issues were handled above as terminal satisfied leaves.
      const depBody = issue.body ?? ''
      const depIssueType = detectIssueType({ title: issue.title, body: depBody })
      const depControl = parseControlMetadata(depBody, depIssueType)
      const isTracking = depControl.metadata.executionMode === 'tracking' || depIssueType === 'epic'

      if (issue.state === 'open' && isTracking) {
        return {
          issueNumber: dependencyNumber,
          state: 'tracking_only',
          reasonCode: 'queue.issue_dependency_tracking' as ReadinessReasonCode,
          transitiveDependencyIssueNumbers: [],
        }
      }

      // Map state/stateReason
      if (issue.state === 'open') {
        // Parse the dependency's own control metadata for cycle detection
        const depControl = parseControlMetadata(issue.body ?? '', detectIssueType({ title: issue.title, body: issue.body ?? '' }))
        return {
          issueNumber: dependencyNumber,
          state: 'open',
          reasonCode: 'queue.issue_dependency_open' as ReadinessReasonCode,
          transitiveDependencyIssueNumbers: depControl.metadata.dependencies,
          controlDiagnostics: depControl.diagnostics,
        }
      }

      if (issue.state === 'closed') {
        switch (issue.stateReason) {
          case 'not_planned':
            return {
              issueNumber: dependencyNumber,
              state: 'closed_not_planned',
              reasonCode: 'queue.issue_dependency_terminal_unsatisfied' as ReadinessReasonCode,
              transitiveDependencyIssueNumbers: [],
            }
          case 'duplicate':
            return {
              issueNumber: dependencyNumber,
              state: 'closed_duplicate',
              reasonCode: 'queue.issue_dependency_terminal_unsatisfied' as ReadinessReasonCode,
              transitiveDependencyIssueNumbers: [],
            }
          default:
            return {
              issueNumber: dependencyNumber,
              state: 'closed_unknown',
              reasonCode: 'queue.issue_dependency_state_unknown' as ReadinessReasonCode,
              transitiveDependencyIssueNumbers: [],
            }
        }
      }

      return {
        issueNumber: dependencyNumber,
        state: 'closed_unknown',
        reasonCode: 'queue.issue_dependency_state_unknown' as ReadinessReasonCode,
      }
    } catch (error) {
      this.apiFailures++
      return this.normalizeApiError(dependencyNumber, error)
    }
  }

  /**
   * Normalize a GitHub API error into a safe dependency fact.
   * Distinguishes at least: definitive not-found, permission/inaccessible,
   * rate-limited/secondary-rate-limited, timeout/network, server failure,
   * and response/schema invalid.
   */
  private normalizeApiError(dependencyNumber: number, error: unknown): ResolvedDependencyFact {
    if (error instanceof GitHubApiError) {
      switch (error.status) {
        case 404:
          this.apiFailureClasses['not-found']++
          return {
            issueNumber: dependencyNumber,
            state: 'not_found',
            reasonCode: 'queue.issue_dependency_not_found' as ReadinessReasonCode,
            transitiveDependencyIssueNumbers: [],
          }
        case 403:
          if (isRateLimitError(error)) this.apiFailureClasses['rate-limit']++
          else this.apiFailureClasses.permission++
          return {
            issueNumber: dependencyNumber,
            state: 'inaccessible',
            reasonCode: 'queue.issue_dependency_inaccessible' as ReadinessReasonCode,
            transitiveDependencyIssueNumbers: [],
          }
        case 429:
          this.apiFailureClasses['rate-limit']++
          return {
            issueNumber: dependencyNumber,
            state: 'inaccessible',
            reasonCode: 'queue.issue_dependency_inaccessible' as ReadinessReasonCode,
            transitiveDependencyIssueNumbers: [],
          }
        case 422:
          this.apiFailureClasses['invalid-response']++
          return {
            issueNumber: dependencyNumber,
            state: 'lookup_failed',
            reasonCode: 'queue.issue_dependency_lookup_failed' as ReadinessReasonCode,
            transitiveDependencyIssueNumbers: [],
          }
        default:
          if (error.status >= 500) {
            this.apiFailureClasses.server++
            return {
              issueNumber: dependencyNumber,
              state: 'lookup_failed',
              reasonCode: 'queue.issue_dependency_lookup_failed' as ReadinessReasonCode,
              transitiveDependencyIssueNumbers: [],
            }
          }
          this.apiFailureClasses['invalid-response']++
          return {
            issueNumber: dependencyNumber,
            state: 'lookup_failed',
            reasonCode: 'queue.issue_dependency_lookup_failed' as ReadinessReasonCode,
            transitiveDependencyIssueNumbers: [],
          }
      }
    }

    // Timeout/network errors (TypeError, AbortError, etc.)
    if (error instanceof TypeError || (error instanceof Error && error.name === 'AbortError')) {
      this.apiFailureClasses['network-timeout']++
      return {
        issueNumber: dependencyNumber,
        state: 'lookup_failed',
        reasonCode: 'queue.issue_dependency_lookup_failed' as ReadinessReasonCode,
        transitiveDependencyIssueNumbers: [],
      }
    }

    this.apiFailureClasses['invalid-response']++
    // Fallback
    return {
      issueNumber: dependencyNumber,
      state: 'lookup_failed',
      reasonCode: 'queue.issue_dependency_lookup_failed' as ReadinessReasonCode,
      transitiveDependencyIssueNumbers: [],
    }
  }

  /**
   * Async cycle detection using already-resolved dependency facts.
   * Builds a bounded adjacency graph and runs DFS cycle detection.
   */
  private async detectCyclesAsync(
    issueNumber: number,
    metadata: IssueControlMetadata,
    dependencyFacts: readonly ResolvedDependencyFact[],
  ): Promise<{ hasCycle: boolean; limitExceeded: boolean; facts: readonly ResolvedDependencyFact[] }> {
    if (metadata.dependencies.length === 0) return { hasCycle: false, limitExceeded: false, facts: dependencyFacts }

    // Build node map from resolved dependency facts
    const nodeMap = new Map<number, DependencyNode>()

    // Add the target issue
    nodeMap.set(issueNumber, {
      issueNumber,
      dependencyIssueNumbers: metadata.dependencies,
    })

    // Add resolved dependency nodes with their transitive deps
    // Only open dependencies are traversed; completed/terminal deps are leaves
    const allFacts: ResolvedDependencyFact[] = [...dependencyFacts]
    let expansionLimitExceeded = false
    for (const fact of dependencyFacts) {
      const transitive = fact.transitiveDependencyIssueNumbers ?? []
      nodeMap.set(fact.issueNumber, {
        issueNumber: fact.issueNumber,
        dependencyIssueNumbers: transitive,
      })

      // For open dependencies, also fetch their transitive dependencies' transitive deps
      // up to MAX_GRAPH_DEPTH to build a complete reachable graph
      if (!expansionLimitExceeded && fact.state === 'open' && transitive.length > 0) {
        expansionLimitExceeded = await this.expandGraphNode(fact.issueNumber, transitive, nodeMap, 1, allFacts)
      }
    }

    const cycleResult = detectCycle(issueNumber, nodeMap)

    // Check graph limits
    const transitive = getTransitiveDependencies(issueNumber, nodeMap)
    const limitExceeded = expansionLimitExceeded || transitive.exceededLimit || cycleResult.limitExceeded

    if (limitExceeded) {
      this.graphLimitFailures++
    }

    return {
      hasCycle: cycleResult.hasCycle,
      limitExceeded,
      facts: allFacts,
    }
  }

  /**
   * Recursively expand a graph node by fetching transitive dependency facts.
   * Bounded by MAX_GRAPH_DEPTH and MAX_GRAPH_NODES.
   */
  private async expandGraphNode(
    nodeNumber: number,
    transitiveDeps: readonly number[],
    nodeMap: Map<number, DependencyNode>,
    depth: number,
    allFacts: ResolvedDependencyFact[],
  ): Promise<boolean> {
    // This node is already at the permitted depth. Any unvisited child would
    // be outside the complete bounded graph, so report the cap explicitly.
    if (depth >= MAX_GRAPH_DEPTH) return transitiveDeps.some((dep) => !nodeMap.has(dep))
    if (nodeMap.size >= MAX_GRAPH_NODES) return transitiveDeps.some((dep) => !nodeMap.has(dep))

    for (const dep of transitiveDeps) {
      if (nodeMap.has(dep)) continue

      if (nodeMap.size >= MAX_GRAPH_NODES) return true

      // Fetch the dependency's fact (uses memoization)
      let fact: ResolvedDependencyFact
      try {
        fact = await this.fetchDependencyFact(dep)
      } catch {
        continue
      }

      const childTransitive = fact.transitiveDependencyIssueNumbers ?? []
      allFacts.push(fact)
      nodeMap.set(dep, {
        issueNumber: dep,
        dependencyIssueNumbers: childTransitive,
      })

      // Only expand open deps further; completed/terminal/error deps are leaves
      if (fact.state === 'open' && childTransitive.length > 0) {
        if (await this.expandGraphNode(dep, childTransitive, nodeMap, depth + 1, allFacts)) return true
      }
    }
    return false
  }

  /**
   * Snapshot all open issues for full reconciliation.
   * Normalizes page-by-page, discarding raw bodies after parsing.
   * Retains only bounded semantic facts required for the graph.
   */
  async loadOpenIssueSnapshot(): Promise<{
    issues: Map<number, GitHubIssue>
    parsedMetadata: Map<number, SnapshotIssueReadinessFacts>
    exceededLimit: boolean
  }> {
    const issues = new Map<number, GitHubIssue>()
    const parsedMetadata = new Map<number, SnapshotIssueReadinessFacts>()
    let page = 1
    let totalFetched = 0
    let hitMaxPages = false

    while (true) {
      const { issues: pageIssues, hasMore, rawPageFullAtCap = false } = await this.client.listOpenIssues({ page, perPage: 100 })
      for (const issue of pageIssues) {
        if (totalFetched >= this.options.maxOpenIssuesScan) {
          return { issues, parsedMetadata, exceededLimit: true }
        }

        // Parse control metadata and structural validity, then discard raw body
        const issueType = detectIssueType({ title: issue.title, body: issue.body })
        const body = issue.body ?? ''
        const scanResult = scanVisibleMarkdownLines(body)
        const controlResult = parseControlMetadata(body, issueType)
        const structuralResult = validateIssue({
          number: issue.number,
          title: issue.title,
          body,
        })

        // Do not retain raw issue bodies beyond this page. Planning consumes
        // these parsed facts; ready promotion always fetches current GitHub truth.
        issues.set(issue.number, { ...issue, body: null })
        totalFetched++

        parsedMetadata.set(issue.number, {
          issueType,
          metadata: controlResult.metadata,
          structuralValid: structuralResult.valid,
          structuralErrors: structuralResult.missingSections,
          bodyTooLarge: scanResult.bodyTooLarge,
          controlParseErrors: controlResult.errors,
          controlDiagnostics: controlResult.diagnostics,
          hasDuplicateDeclaration: controlResult.hasDuplicateDeclaration,
        })
      }

      if (!hasMore) {
        // If page is at maxPages and the page was full, mark incomplete
        if (rawPageFullAtCap) {
          hitMaxPages = true
        }
        break
      }
      page++
    }

    // Populate the same dependency cache used by graph resolution with
    // normalized, body-free facts.  Full reconcile therefore reuses open
    // inventory and fetches only references absent from it.
    for (const [number, issue] of issues) {
      const facts = parsedMetadata.get(number)
      if (facts) this.dependencyCache.set(number, Promise.resolve(this.snapshotDependencyFact(issue, facts)))
    }
    return { issues, parsedMetadata, exceededLimit: hitMaxPages }
  }

  private snapshotDependencyFact(issue: GitHubIssue, facts: SnapshotIssueReadinessFacts): ResolvedDependencyFact {
    if (issue.isPullRequest) return { issueNumber: issue.number, state: 'is_pull_request', reasonCode: 'queue.issue_dependency_is_pull_request' as ReadinessReasonCode, transitiveDependencyIssueNumbers: [] }
    if (facts.metadata.executionMode === 'tracking' || facts.issueType === 'epic') return { issueNumber: issue.number, state: 'tracking_only', reasonCode: 'queue.issue_dependency_tracking' as ReadinessReasonCode, transitiveDependencyIssueNumbers: [] }
    if (issue.state === 'open') return { issueNumber: issue.number, state: 'open', reasonCode: 'queue.issue_dependency_open' as ReadinessReasonCode, transitiveDependencyIssueNumbers: facts.metadata.dependencies, controlDiagnostics: facts.controlDiagnostics }
    return { issueNumber: issue.number, state: 'closed_unknown', reasonCode: 'queue.issue_dependency_state_unknown' as ReadinessReasonCode, transitiveDependencyIssueNumbers: [] }
  }

  /**
   * Clear the memoization cache.
   */
  clearCache(): void {
    this.dependencyCache.clear()
  }

  private failClosed(
    issueNumber: number,
    reasonCode: ReadinessReasonCode,
    blockers: Array<{ reasonCode: ReadinessReasonCode; detail: string; dependencyIssueNumber: number | null }>,
  ): IssueReadinessResult {
    return {
      issueNumber,
      state: 'needs-clarification',
      dispatchable: false,
      executionMode: null,
      dependencies: [],
      reasonCodes: [reasonCode],
      blockers,
      desiredReadinessLabels: ['needs-clarification'],
      partial: true,
    }
  }
}

function mapIssueState(state: string): 'open' | 'closed' | 'unknown' {
  switch (state) {
    case 'open':
      return 'open'
    case 'closed':
      return 'closed'
    default:
      return 'unknown'
  }
}

function isRateLimitError(error: GitHubApiError): boolean {
  return error.rateLimitEvidence.retryAfter
    || error.rateLimitEvidence.remainingZero
    // Test doubles and older callers may not have response evidence. This is
    // deliberately only a fallback; RestGitHubClient supplies header facts.
    || /(?:secondary\s+)?rate\s*limit|rate[_ -]?limited/i.test(error.message)
}
