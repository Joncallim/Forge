/**
 * Bounded dependency-graph utilities.
 *
 * Provides cycle detection, reverse-index building, and graph traversal
 * helpers used by the shared readiness resolver.
 *
 * No GitHub calls, no model calls.
 */


/**
 * Graph bounds used during resolution.
 */
export const MAX_GRAPH_DEPTH = 64
export const MAX_GRAPH_NODES = 512

/**
 * A normalized node in the dependency graph.
 */
export type DependencyNode = Readonly<{
  issueNumber: number
  dependencyIssueNumbers: readonly number[]
}>

/**
 * Result of a cycle detection pass.
 */
export type CycleDetectionResult = Readonly<{
  hasCycle: boolean
  limitExceeded: boolean
  /**
   * The cycle path if found (issue numbers in order).
   */
  cyclePath: readonly number[]
  /**
   * All nodes that participate in a cycle.
   */
  cyclicNodes: ReadonlySet<number>
}>

/**
 * Build a reverse dependency index from a list of dependency nodes.
 *
 * reverse[issueNumber] = Set of issue numbers that depend on issueNumber.
 */
export function buildReverseIndex(nodes: Iterable<DependencyNode>): Map<number, Set<number>> {
  const reverse = new Map<number, Set<number>>()

  for (const node of nodes) {
    for (const dep of node.dependencyIssueNumbers) {
      if (!reverse.has(dep)) reverse.set(dep, new Set())
      reverse.get(dep)!.add(node.issueNumber)
    }
  }

  return reverse
}

/**
 * Detect whether the given target issue participates in a dependency cycle.
 *
 * Uses DFS with a visited set and recursion stack. Bounded by MAX_GRAPH_NODES.
 *
 * @param targetIssueNumber - The issue to check for cycle participation.
 * @param nodeMap - Map of issueNumber -> DependencyNode for all known issues.
 * @returns Cycle detection result.
 */
export function detectCycle(
  targetIssueNumber: number,
  nodeMap: ReadonlyMap<number, DependencyNode>,
): CycleDetectionResult {
  const visited = new Set<number>()
  const reachable = new Set<number>()
  const recStack = new Set<number>()
  const allCyclicNodes = new Set<number>()
  let cyclePath: number[] = []
  let limitExceeded = false

  function dfs(node: number, path: number[], depth: number): boolean {
    if (depth > MAX_GRAPH_DEPTH || reachable.size > MAX_GRAPH_NODES) {
      limitExceeded = true
      return false
    }
    reachable.add(node)
    if (reachable.size > MAX_GRAPH_NODES) {
      limitExceeded = true
      return false
    }

    if (recStack.has(node)) {
      // Found a cycle - extract the cycle from the path
      const cycleStart = path.indexOf(node)
      if (cycleStart !== -1) {
        cyclePath = path.slice(cycleStart)
        for (const n of cyclePath) allCyclicNodes.add(n)
      }
      return true
    }

    if (visited.has(node)) return false

    visited.add(node)
    recStack.add(node)
    path.push(node)

    const deps = nodeMap.get(node)
    if (deps) {
      for (const dep of deps.dependencyIssueNumbers) {
        if (dfs(dep, path, depth + 1)) {
          path.pop()
          recStack.delete(node)
          return true
        }
      }
    }

    path.pop()
    recStack.delete(node)
    return false
  }

  dfs(targetIssueNumber, [], 0)

  return {
    hasCycle: cyclePath.length > 0,
    limitExceeded,
    cyclePath: Object.freeze(cyclePath),
    cyclicNodes: allCyclicNodes,
  }
}

/**
 * Get all transitive dependencies of an issue (BFS, bounded).
 */
export function getTransitiveDependencies(
  issueNumber: number,
  nodeMap: ReadonlyMap<number, DependencyNode>,
  maxDepth: number = MAX_GRAPH_DEPTH,
  maxNodes: number = MAX_GRAPH_NODES,
): { dependencies: Set<number>; exceededLimit: boolean } {
  const result = new Set<number>()
  const queue: Array<{ node: number; depth: number }> = [{ node: issueNumber, depth: 0 }]
  let cursor = 0

  while (cursor < queue.length) {
    const { node, depth } = queue[cursor++]
    if (depth > maxDepth || result.size > maxNodes) {
      return { dependencies: result, exceededLimit: true }
    }

    const deps = nodeMap.get(node)
    if (!deps) continue

    for (const dep of deps.dependencyIssueNumbers) {
      if (!result.has(dep)) {
        result.add(dep)
        queue.push({ node: dep, depth: depth + 1 })
      }
    }
  }

  return { dependencies: result, exceededLimit: false }
}
