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
  const recStack = new Set<number>()
  const allCyclicNodes = new Set<number>()
  let cyclePath: number[] = []

  // Limit graph traversal
  let nodesVisited = 0
  const maxNodes = MAX_GRAPH_NODES

  function dfs(node: number, path: number[]): boolean {
    if (nodesVisited > maxNodes) return false
    nodesVisited++

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
        if (dfs(dep, path)) {
          // Continue to mark all nodes in cycle paths
          if (cyclePath.length > 0) {
            for (const n of path) {
              if (n === dep || allCyclicNodes.has(n)) break
              allCyclicNodes.add(n)
            }
          }
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

  dfs(targetIssueNumber, [])

  // If no cycle from target, check other nodes too
  if (!cyclePath.length) {
    for (const [num] of nodeMap) {
      if (!visited.has(num)) {
        dfs(num, [])
        if (cyclePath.length > 0) break
      }
    }
  }

  // If target is a cyclic node but we didn't start from it, check
  if (!allCyclicNodes.has(targetIssueNumber) && cyclePath.length > 0) {
    // Walk from target to see if it leads to a cyclic node
    const subVisited = new Set<number>()
    const stack = [targetIssueNumber]
    while (stack.length > 0) {
      const current = stack.pop()!
      if (subVisited.has(current)) continue
      subVisited.add(current)
      if (allCyclicNodes.has(current)) {
        allCyclicNodes.add(targetIssueNumber)
        break
      }
      const deps = nodeMap.get(current)
      if (deps) {
        for (const dep of deps.dependencyIssueNumbers) {
          if (!subVisited.has(dep)) stack.push(dep)
        }
      }
    }
  }

  return {
    hasCycle: cyclePath.length > 0,
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
  let totalVisited = 0

  while (queue.length > 0) {
    const { node, depth } = queue.shift()!
    if (depth > maxDepth || totalVisited > maxNodes) {
      return { dependencies: result, exceededLimit: true }
    }

    const deps = nodeMap.get(node)
    if (!deps) continue

    for (const dep of deps.dependencyIssueNumbers) {
      if (!result.has(dep)) {
        result.add(dep)
        totalVisited++
        queue.push({ node: dep, depth: depth + 1 })
      }
    }
  }

  return { dependencies: result, exceededLimit: false }
}
