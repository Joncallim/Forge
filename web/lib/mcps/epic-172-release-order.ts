import { createHash } from 'node:crypto'
import rawManifest from './epic-172-release-order-v1.json'

const RUNTIME_NODE_IDS = [
  'step0_retention_bridge',
  's3_issue_178',
  's4_expand',
  's4_producers_disabled',
  's5_compatible_consumers_deployed',
  's6_pre_activation_green',
  's4_controlled_activation',
  's6_post_activation_green',
  'ingress_and_issuance_enabled',
  's5_s6_release_ready',
] as const

const CODE_DEPENDENCY_NODE_IDS = [
  's1_issue_176',
  's2_issue_177',
  'step0_retention_bridge',
  's3_issue_178',
  's4_remaining_issue_179',
  's5_issue_180',
  's6_issue_181',
] as const

const NODE_REGISTRY_DIGEST = '2c7281849eae771b397561e01559b0ff10c7f666a0ccd7b5f0233d68dfa82914'
const CODE_DEPENDENCY_GRAPH_DIGEST = '943ae6b2a950edf63bbd26ed88e50fd1e06a9bdd58712159090469fc853c1c12'
const RUNTIME_ACTIVATION_GRAPH_DIGEST = 'f841766b7dc414de5cd875ef131512584abf779511eeceac4537d068898bada6'

const RUNTIME_NODE_ID_SET = new Set<string>(RUNTIME_NODE_IDS)
const OWNER_SLICES = new Set(['step0', 's3', 's4', 's5', 's6'])
const BUILD_NAMES = new Set([
  'issue_178_s3',
  'issue_179_s4',
  'issue_179_step0',
  'issue_180_s5',
  'issue_181_s6',
])

export type Epic172ReleaseNodeId = typeof RUNTIME_NODE_IDS[number]
export type Epic172CodeDependencyNodeId = typeof CODE_DEPENDENCY_NODE_IDS[number]
export type Epic172ReleaseGraphName = 'codeDependencyGraph' | 'runtimeActivationGraph'

export type Epic172ReleaseOwner = Readonly<{
  issue: number
  slice: 'step0' | 's3' | 's4' | 's5' | 's6'
}>

export type Epic172ReleaseBuildIdentity = Readonly<{
  exactBuilds: readonly string[]
  reviewedSha: 'required'
  epoch: 'none' | 'required'
}>

export type Epic172ReleaseNode = Readonly<{
  id: Epic172ReleaseNodeId
  owner: Epic172ReleaseOwner
  issueDependencies: readonly number[]
  requiredEvidence: readonly string[]
  buildIdentity: Epic172ReleaseBuildIdentity
}>

export type Epic172ReleaseEdge<NodeId extends string = string> = Readonly<{
  from: NodeId
  to: NodeId
}>

export type Epic172ReleaseGraph<NodeId extends string, Meaning extends string> = Readonly<{
  meaning: Meaning
  nodes: readonly NodeId[]
  edges: readonly Epic172ReleaseEdge<NodeId>[]
}>

export type Epic172ReleaseOrder = Readonly<{
  schemaVersion: 1
  manifestId: 'forge-epic-172-release-order-v1'
  nodes: readonly Epic172ReleaseNode[]
  codeDependencyGraph: Epic172ReleaseGraph<Epic172CodeDependencyNodeId, 'implementation_and_import_prerequisites'>
  runtimeActivationGraph: Epic172ReleaseGraph<Epic172ReleaseNodeId, 'operational_release_transitions'>
}>

type JsonRecord = Record<string, unknown>

function fail(path: string, message: string): never {
  throw new Error(`Invalid Epic 172 release-order manifest at ${path}: ${message}`)
}

function recordAt(value: unknown, path: string, keys: readonly string[]): JsonRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(path, 'expected an object')
  }

  const record = value as JsonRecord
  const expectedKeys = new Set(keys)
  for (const key of Object.keys(record)) {
    if (!expectedKeys.has(key)) fail(path, `unknown field ${JSON.stringify(key)}`)
  }
  for (const key of keys) {
    if (!Object.hasOwn(record, key)) fail(path, `missing field ${JSON.stringify(key)}`)
  }
  return record
}

function stringAt(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) fail(path, 'expected a non-empty string')
  return value
}

function integerAt(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) fail(path, 'expected a positive safe integer')
  return value as number
}

function uniqueArrayAt(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) fail(path, 'expected an array')

  const seen = new Set<string>()
  for (const [index, entry] of value.entries()) {
    const key = JSON.stringify(entry)
    if (seen.has(key)) fail(`${path}[${index}]`, 'duplicate value')
    seen.add(key)
  }
  return value
}

function parseRuntimeNodeId(value: unknown, path: string): Epic172ReleaseNodeId {
  const id = stringAt(value, path)
  if (id === 's4_activate') fail(path, 'obsolete s4_activate is forbidden')
  if (!RUNTIME_NODE_ID_SET.has(id)) fail(path, `unknown runtime node ${JSON.stringify(id)}`)
  return id as Epic172ReleaseNodeId
}

function parseOwner(value: unknown, path: string): Epic172ReleaseOwner {
  const record = recordAt(value, path, ['issue', 'slice'])
  const issue = integerAt(record.issue, `${path}.issue`)
  const slice = stringAt(record.slice, `${path}.slice`)
  if (!OWNER_SLICES.has(slice)) fail(`${path}.slice`, `unknown owner slice ${JSON.stringify(slice)}`)
  return { issue, slice: slice as Epic172ReleaseOwner['slice'] }
}

function parseIssueDependencies(value: unknown, path: string): readonly number[] {
  return uniqueArrayAt(value, path).map((entry, index) => integerAt(entry, `${path}[${index}]`))
}

function parseRequiredEvidence(value: unknown, path: string): readonly string[] {
  const evidence = uniqueArrayAt(value, path).map((entry, index) => stringAt(entry, `${path}[${index}]`))
  if (evidence.length === 0) fail(path, 'at least one required-evidence postcondition is required')
  for (const [index, name] of evidence.entries()) {
    if (!/^[a-z][a-z0-9_]*$/.test(name)) fail(`${path}[${index}]`, 'expected a lower-snake-case evidence name')
    if (name === 's4_activate') fail(`${path}[${index}]`, 'obsolete s4_activate is forbidden')
  }
  return evidence
}

function parseBuildIdentity(value: unknown, path: string): Epic172ReleaseBuildIdentity {
  const record = recordAt(value, path, ['exactBuilds', 'reviewedSha', 'epoch'])
  const exactBuilds = uniqueArrayAt(record.exactBuilds, `${path}.exactBuilds`).map((entry, index) => {
    const build = stringAt(entry, `${path}.exactBuilds[${index}]`)
    if (!BUILD_NAMES.has(build)) fail(`${path}.exactBuilds[${index}]`, `unknown build ${JSON.stringify(build)}`)
    return build
  })
  if (exactBuilds.length === 0) fail(`${path}.exactBuilds`, 'at least one exact build is required')
  if (record.reviewedSha !== 'required') fail(`${path}.reviewedSha`, 'reviewed SHA must be required')
  if (record.epoch !== 'none' && record.epoch !== 'required') {
    fail(`${path}.epoch`, 'expected none or required')
  }
  return {
    exactBuilds,
    reviewedSha: 'required',
    epoch: record.epoch,
  }
}

function parseNodes(value: unknown): readonly Epic172ReleaseNode[] {
  if (!Array.isArray(value)) fail('nodes', 'expected an array')
  if (value.length !== RUNTIME_NODE_IDS.length) {
    fail('nodes', `expected exactly ${RUNTIME_NODE_IDS.length} runtime nodes`)
  }

  const seen = new Set<string>()
  return value.map((entry, index) => {
    const path = `nodes[${index}]`
    const record = recordAt(entry, path, [
      'id',
      'owner',
      'issueDependencies',
      'requiredEvidence',
      'buildIdentity',
    ])
    const id = parseRuntimeNodeId(record.id, `${path}.id`)
    if (seen.has(id)) fail(`${path}.id`, `duplicate node ${JSON.stringify(id)}`)
    seen.add(id)
    if (id !== RUNTIME_NODE_IDS[index]) {
      fail(`${path}.id`, `expected ${JSON.stringify(RUNTIME_NODE_IDS[index])} at runtime position ${index + 1}`)
    }
    return {
      id,
      owner: parseOwner(record.owner, `${path}.owner`),
      issueDependencies: parseIssueDependencies(record.issueDependencies, `${path}.issueDependencies`),
      requiredEvidence: parseRequiredEvidence(record.requiredEvidence, `${path}.requiredEvidence`),
      buildIdentity: parseBuildIdentity(record.buildIdentity, `${path}.buildIdentity`),
    }
  })
}

function assertAcyclic<NodeId extends string>(
  nodes: readonly NodeId[],
  edges: readonly Epic172ReleaseEdge<NodeId>[],
  path: string,
): void {
  const outgoing = new Map<NodeId, NodeId[]>()
  const visiting = new Set<NodeId>()
  const visited = new Set<NodeId>()
  for (const node of nodes) outgoing.set(node, [])
  for (const edge of edges) outgoing.get(edge.from)?.push(edge.to)

  const visit = (node: NodeId): void => {
    if (visiting.has(node)) fail(path, `cycle detected through ${JSON.stringify(node)}`)
    if (visited.has(node)) return
    visiting.add(node)
    for (const next of outgoing.get(node) ?? []) visit(next)
    visiting.delete(node)
    visited.add(node)
  }

  for (const node of nodes) visit(node)
}

function parseGraph<NodeId extends string, Meaning extends string>(
  value: unknown,
  path: Epic172ReleaseGraphName,
  expectedMeaning: Meaning,
  expectedNodes: readonly NodeId[],
): Epic172ReleaseGraph<NodeId, Meaning> {
  const record = recordAt(value, path, ['meaning', 'nodes', 'edges'])
  if (record.meaning !== expectedMeaning) {
    fail(`${path}.meaning`, `expected ${JSON.stringify(expectedMeaning)}; graph substitution is forbidden`)
  }

  if (!Array.isArray(record.nodes)) fail(`${path}.nodes`, 'expected an array')
  if (record.nodes.length !== expectedNodes.length) {
    fail(`${path}.nodes`, `expected exactly ${expectedNodes.length} nodes for this graph meaning`)
  }
  const graphNodes = record.nodes.map((value, index) => {
    const node = stringAt(value, `${path}.nodes[${index}]`)
    if (node === 's4_activate') fail(`${path}.nodes[${index}]`, 'obsolete s4_activate is forbidden')
    if (node !== expectedNodes[index]) {
      fail(`${path}.nodes[${index}]`, `expected ${JSON.stringify(expectedNodes[index])}`)
    }
    return node as NodeId
  })
  if (new Set(graphNodes).size !== graphNodes.length) fail(`${path}.nodes`, 'duplicate node')
  const graphNodeSet = new Set<string>(graphNodes)

  const rawEdges = uniqueArrayAt(record.edges, `${path}.edges`)
  const edgeKeys = new Set<string>()
  const edges = rawEdges.map((entry, index) => {
    const edgePath = `${path}.edges[${index}]`
    const edgeRecord = recordAt(entry, edgePath, ['from', 'to'])
    const from = stringAt(edgeRecord.from, `${edgePath}.from`)
    const to = stringAt(edgeRecord.to, `${edgePath}.to`)
    if (from === 's4_activate' || to === 's4_activate') fail(edgePath, 'obsolete s4_activate is forbidden')
    if (!graphNodeSet.has(from)) fail(`${edgePath}.from`, `unknown node ${JSON.stringify(from)} for this graph`)
    if (!graphNodeSet.has(to)) fail(`${edgePath}.to`, `unknown node ${JSON.stringify(to)} for this graph`)
    const edge = {
      from: from as NodeId,
      to: to as NodeId,
    }
    if (edge.from === edge.to) fail(edgePath, 'self edges are forbidden')
    const edgeKey = `${edge.from}\0${edge.to}`
    if (edgeKeys.has(edgeKey)) fail(edgePath, 'duplicate edge')
    edgeKeys.add(edgeKey)
    return edge
  })

  const coveredNodes = new Set(edges.flatMap((edge) => [edge.from, edge.to]))
  for (const node of graphNodes) {
    if (!coveredNodes.has(node)) fail(`${path}.edges`, `missing node ${JSON.stringify(node)}`)
  }
  assertAcyclic(graphNodes, edges, `${path}.edges`)
  return { meaning: expectedMeaning, nodes: graphNodes, edges }
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function assertDigest(value: unknown, expected: string, path: string): void {
  if (digest(value) !== expected) {
    fail(path, 'does not match the version-1 owner, dependency, evidence, build, node, and edge contract')
  }
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}

export function validateEpic172ReleaseOrder(value: unknown): Epic172ReleaseOrder {
  const record = recordAt(value, 'root', [
    'schemaVersion',
    'manifestId',
    'nodes',
    'codeDependencyGraph',
    'runtimeActivationGraph',
  ])
  if (record.schemaVersion !== 1) fail('schemaVersion', 'expected 1')
  if (record.manifestId !== 'forge-epic-172-release-order-v1') {
    fail('manifestId', 'expected forge-epic-172-release-order-v1')
  }

  const nodes = parseNodes(record.nodes)
  const codeDependencyGraph = parseGraph(
    record.codeDependencyGraph,
    'codeDependencyGraph',
    'implementation_and_import_prerequisites',
    CODE_DEPENDENCY_NODE_IDS,
  )
  const runtimeActivationGraph = parseGraph(
    record.runtimeActivationGraph,
    'runtimeActivationGraph',
    'operational_release_transitions',
    RUNTIME_NODE_IDS,
  )

  assertDigest(nodes, NODE_REGISTRY_DIGEST, 'nodes')
  assertDigest(codeDependencyGraph, CODE_DEPENDENCY_GRAPH_DIGEST, 'codeDependencyGraph')
  assertDigest(runtimeActivationGraph, RUNTIME_ACTIVATION_GRAPH_DIGEST, 'runtimeActivationGraph')

  return deepFreeze({
    schemaVersion: 1,
    manifestId: 'forge-epic-172-release-order-v1',
    nodes,
    codeDependencyGraph,
    runtimeActivationGraph,
  }) as Epic172ReleaseOrder
}

export const epic172ReleaseOrder = validateEpic172ReleaseOrder(rawManifest)

export function getEpic172ReleaseOrderNode(id: Epic172ReleaseNodeId): Epic172ReleaseNode {
  const node = epic172ReleaseOrder.nodes.find((candidate) => candidate.id === id)
  if (!node) throw new Error(`Epic 172 release-order node ${JSON.stringify(id)} is not registered`)
  return node
}

export function getEpic172ReleaseOrderEdges(graph: Epic172ReleaseGraphName): readonly Epic172ReleaseEdge[] {
  return epic172ReleaseOrder[graph].edges
}
