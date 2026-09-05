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
import type { IssueType } from '../contracts/common'
import type { IssueControlMetadata } from '../contracts/issue-control-metadata'
import type { IssueReadinessResult, ReadinessReasonCode } from '../contracts/issue-readiness-result'
import type { ResolvedDependencyFact } from '../core/issue-readiness'
import { evaluateReadiness } from '../core/issue-readiness'
import { parseControlMetadata } from '../core/issue-control'
import { detectIssueType, validateIssue } from '../core/issue-validation'
import { detectCycle, getTransitiveDependencies } from '../core/dependency-graph'

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

const DEFAULT_FETCH_CONCURRENCY = 8
const DEFAULT_MAX_OPEN_ISSUES_SCAN = 5000

/**
 * A cached dependency fact for a single issue.
 */
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
  /**
   * Snapshot of open issues for reconciliation.
   */
  private openIssueSnapshot: Map<number, GitHubIssue> | null = null

  constructor(client: GitHubClient, options: ReadinessResolverOptions = {}) {
    this.client = client
    this.options = {
      maxFetchConcurrency: options.maxFetchConcurrency ?? DEFAULT_FETCH_CONCURRENCY,
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
    } catch (error) {
      return this.failClosed(issueNumber, 'queue.issue_dependency_lookup_failed', [
        { reasonCode: 'queue.issue_dependency_lookup_failed' as ReadinessReasonCode, detail: `Failed to fetch issue #${issueNumber}: ${errorMessage(error)}`, dependencyIssueNumber: null },
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

    // Structural validation
    const structuralResult = validateIssue({
      number: issue.number,
      title: issue.title,
      body,
    })

    // Control metadata
    const controlResult = parseControlMetadata(body, issueType)

    // If structural validation says valid, use it; otherwise use the result
    const structuralValid = structuralResult.valid

    // Resolve dependencies
    const dependencyFacts = await this.resolveDependencies(
      issue.number,
      controlResult.metadata,
      issueType,
    )

    // Cycle detection
    const cycleResult = this.detectCycles(issue.number, controlResult.metadata, issueType)

    // Evaluate readiness
    return evaluateReadiness({
      issueNumber: issue.number,
      issueState: mapIssueState(issue.state),
      issueType,
      controlMetadata: controlResult.metadata,
      structuralValid,
      structuralErrors: structuralResult.missingSections,
      dependencyFacts,
      hasCycle: cycleResult.hasCycle,
      graphLimitExceeded: cycleResult.limitExceeded,
      bodyTooLarge: false, // Already handled by parseControlMetadata
    })
  }

  /**
   * Resolve dependency facts for the given issue's dependencies.
   */
  private async resolveDependencies(
    issueNumber: number,
    metadata: IssueControlMetadata,
    _issueType: IssueType,
  ): Promise<readonly ResolvedDependencyFact[]> {
    if (metadata.dependencies.length === 0) return []

    const facts: ResolvedDependencyFact[] = []

    // Check for self-dependency
    for (const dep of metadata.dependencies) {
      if (dep === issueNumber) {
        facts.push({
          issueNumber: dep,
          state: 'closed_unknown',
          reasonCode: 'queue.issue_dependency_self' as ReadinessReasonCode,
        })
        // Don't try to fetch self-dependency
        continue
      }

      // Check for duplicate in metadata
      if (metadata.dependencies.filter((d) => d === dep).length > 1) {
        if (!facts.find((f) => f.issueNumber === dep && f.reasonCode === 'queue.issue_dependency_duplicate')) {
          facts.push({
            issueNumber: dep,
            state: 'closed_unknown',
            reasonCode: 'queue.issue_dependency_duplicate' as ReadinessReasonCode,
          })
        }
        continue
      }

      // Fetch dependency state with memoization
      const fact = await this.fetchDependencyFact(dep)
      facts.push(fact)
    }

    return facts
  }

  /**
   * Fetch a single dependency fact with memoization including in-flight promises.
   */
  private fetchDependencyFact(dependencyNumber: number): Promise<ResolvedDependencyFact> {
    const cached = this.dependencyCache.get(dependencyNumber)
    if (cached) return cached

    const promise = this.doFetchDependencyFact(dependencyNumber)
    this.dependencyCache.set(dependencyNumber, promise)
    return promise
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
        }
      }

      // Check if it's a tracking-only issue
      if (issue.labels.some((l) => l.toLowerCase() === 'tracking-only')) {
        return {
          issueNumber: dependencyNumber,
          state: 'tracking_only',
          reasonCode: 'queue.issue_dependency_tracking' as ReadinessReasonCode,
        }
      }

      // Map state/stateReason
      if (issue.state === 'open') {
        return {
          issueNumber: dependencyNumber,
          state: 'open',
          reasonCode: 'queue.issue_dependency_open' as ReadinessReasonCode,
        }
      }

      if (issue.state === 'closed') {
        switch (issue.stateReason) {
          case 'completed':
            return {
              issueNumber: dependencyNumber,
              state: 'closed_completed',
              reasonCode: 'queue.issue_dependency_open' as ReadinessReasonCode, // Placeholder, will be overridden
            }
          case 'not_planned':
            return {
              issueNumber: dependencyNumber,
              state: 'closed_not_planned',
              reasonCode: 'queue.issue_dependency_terminal_unsatisfied' as ReadinessReasonCode,
            }
          case 'duplicate':
            return {
              issueNumber: dependencyNumber,
              state: 'closed_duplicate',
              reasonCode: 'queue.issue_dependency_terminal_unsatisfied' as ReadinessReasonCode,
            }
          default:
            return {
              issueNumber: dependencyNumber,
              state: 'closed_unknown',
              reasonCode: 'queue.issue_dependency_state_unknown' as ReadinessReasonCode,
            }
        }
      }

      return {
        issueNumber: dependencyNumber,
        state: 'closed_unknown',
        reasonCode: 'queue.issue_dependency_state_unknown' as ReadinessReasonCode,
      }
    } catch (error) {
      if (error instanceof Error && 'status' in error && (error as { status: number }).status === 404) {
        return {
          issueNumber: dependencyNumber,
          state: 'not_found',
          reasonCode: 'queue.issue_dependency_not_found' as ReadinessReasonCode,
        }
      }
      if (error instanceof Error && 'status' in error && (error as { status: number }).status === 403) {
        return {
          issueNumber: dependencyNumber,
          state: 'inaccessible',
          reasonCode: 'queue.issue_dependency_inaccessible' as ReadinessReasonCode,
        }
      }
      return {
        issueNumber: dependencyNumber,
        state: 'lookup_failed',
        reasonCode: 'queue.issue_dependency_lookup_failed' as ReadinessReasonCode,
      }
    }
  }

  /**
   * Detect cycles for the given issue's dependencies.
   */
  private detectCycles(
    issueNumber: number,
    metadata: IssueControlMetadata,
    _issueType: IssueType,
  ): { hasCycle: boolean; limitExceeded: boolean } {
    if (metadata.dependencies.length === 0) return { hasCycle: false, limitExceeded: false }

    // Build a node map from cache + open snapshot
    const nodeMap = new Map<number, { issueNumber: number; dependencyIssueNumbers: readonly number[] }>()

    // Add the target issue
    nodeMap.set(issueNumber, {
      issueNumber,
      dependencyIssueNumbers: metadata.dependencies,
    })

    // Add dependencies that we have cached
    for (const dep of metadata.dependencies) {
      const cached = this.dependencyCache.get(dep)
      if (cached) {
        // We can't resolve the cached dependency's own dependencies without more fetches
        // For cycle detection, we add it as a leaf node
        nodeMap.set(dep, {
          issueNumber: dep,
          dependencyIssueNumbers: [],
        })
      }
    }

    const cycleResult = detectCycle(issueNumber, nodeMap)

    // Check graph limits
    const transitive = getTransitiveDependencies(issueNumber, nodeMap)

    return {
      hasCycle: cycleResult.hasCycle,
      limitExceeded: transitive.exceededLimit,
    }
  }

  /**
   * Snapshot all open issues for full reconciliation.
   * Parses control metadata and builds in-memory graph.
   */
  async loadOpenIssueSnapshot(): Promise<{
    issues: Map<number, GitHubIssue>
    parsedMetadata: Map<number, { issueType: IssueType; metadata: IssueControlMetadata; structuralValid: boolean }>
    exceededLimit: boolean
  }> {
    const issues = new Map<number, GitHubIssue>()
    const parsedMetadata = new Map<number, { issueType: IssueType; metadata: IssueControlMetadata; structuralValid: boolean }>()
    let page = 1
    let totalFetched = 0

    while (true) {
      const { issues: pageIssues, hasMore } = await this.client.listOpenIssues({ page, perPage: 100 })
      for (const issue of pageIssues) {
        if (totalFetched >= this.options.maxOpenIssuesScan) {
          return { issues, parsedMetadata, exceededLimit: true }
        }

        issues.set(issue.number, issue)
        totalFetched++

        const issueType = detectIssueType({ title: issue.title, body: issue.body })  
        const controlResult = parseControlMetadata(issue.body ?? '', issueType)
        const structuralResult = validateIssue({
          number: issue.number,
          title: issue.title,
          body: issue.body ?? '',
        })

        parsedMetadata.set(issue.number, {
          issueType,
          metadata: controlResult.metadata,
          structuralValid: structuralResult.valid,
        })
      }

      if (!hasMore) break
      page++
    }

    return { issues, parsedMetadata, exceededLimit: false }
  }

  /**
   * Clear the memoization cache.
   */
  clearCache(): void {
    this.dependencyCache.clear()
    this.openIssueSnapshot = null
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

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
