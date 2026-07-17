import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import rawManifest from '@/lib/mcps/epic-172-release-order-v1.json'
import {
  epic172ReleaseOrder,
  getEpic172ReleaseOrderEdges,
  getEpic172ReleaseOrderNode,
  validateEpic172ReleaseOrder,
} from '@/lib/mcps/epic-172-release-order'

const RUNTIME_NODE_ORDER = [
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

const CODE_DEPENDENCY_NODE_ORDER = [
  's1_issue_176',
  's2_issue_177',
  'step0_retention_bridge',
  's3_issue_178',
  's4_remaining_issue_179',
  's5_issue_180',
  's6_issue_181',
] as const

type MutableManifest = typeof rawManifest

function mutated(change: (manifest: MutableManifest) => void): MutableManifest {
  const manifest = structuredClone(rawManifest)
  change(manifest)
  return manifest
}

describe('Epic 172 release order', () => {
  it('loads one frozen registry and keeps code dependencies separate from runtime activation', () => {
    expect(epic172ReleaseOrder.nodes.map((node) => node.id)).toEqual(RUNTIME_NODE_ORDER)
    expect(epic172ReleaseOrder.nodes).toHaveLength(10)

    const runtimeEdges = getEpic172ReleaseOrderEdges('runtimeActivationGraph')
    expect(epic172ReleaseOrder.runtimeActivationGraph.nodes).toEqual(RUNTIME_NODE_ORDER)
    expect([runtimeEdges[0].from, ...runtimeEdges.map((edge) => edge.to)]).toEqual(RUNTIME_NODE_ORDER)
    expect(epic172ReleaseOrder.codeDependencyGraph.nodes).toEqual(CODE_DEPENDENCY_NODE_ORDER)
    expect(getEpic172ReleaseOrderEdges('codeDependencyGraph')).not.toEqual(runtimeEdges)

    expect(Object.isFrozen(epic172ReleaseOrder)).toBe(true)
    expect(Object.isFrozen(epic172ReleaseOrder.nodes)).toBe(true)
    expect(Object.isFrozen(getEpic172ReleaseOrderNode('step0_retention_bridge').requiredEvidence)).toBe(true)
  })

  it('preserves exact per-node ownership, Step 0 issue dependencies, and slice code prerequisites', () => {
    const step0 = getEpic172ReleaseOrderNode('step0_retention_bridge')
    expect(step0.owner).toEqual({ issue: 179, slice: 'step0' })
    expect(step0.issueDependencies).toEqual([176, 177])
    expect(step0.buildIdentity).toEqual({
      exactBuilds: ['issue_179_step0'],
      reviewedSha: 'required',
      epoch: 'none',
    })

    expect(getEpic172ReleaseOrderNode('s3_issue_178').owner).toEqual({ issue: 178, slice: 's3' })
    expect(getEpic172ReleaseOrderNode('s5_compatible_consumers_deployed').owner).toEqual({
      issue: 180,
      slice: 's5',
    })
    expect(getEpic172ReleaseOrderNode('s5_s6_release_ready').owner).toEqual({ issue: 181, slice: 's6' })

    const codeEdges = epic172ReleaseOrder.codeDependencyGraph.edges
    expect([codeEdges[0].from, ...codeEdges.map((edge) => edge.to)]).toEqual(CODE_DEPENDENCY_NODE_ORDER)
  })

  it('imports only the data manifest and Node hashing support', () => {
    const source = readFileSync(new URL('../lib/mcps/epic-172-release-order.ts', import.meta.url), 'utf8')
    const imports = [...source.matchAll(/from '([^']+)'/g)].map((match) => match[1])
    expect(imports).toEqual(['node:crypto', './epic-172-release-order-v1.json'])
  })

  it.each([
    ['unknown root field', (manifest: MutableManifest) => Object.assign(manifest, { shadowGraph: {} })],
    ['missing node', (manifest: MutableManifest) => manifest.nodes.pop()],
    ['duplicate node', (manifest: MutableManifest) => manifest.nodes.push(structuredClone(manifest.nodes[0]))],
    ['reordered node', (manifest: MutableManifest) => manifest.nodes.reverse()],
    ['unknown owner', (manifest: MutableManifest) => { manifest.nodes[1].owner.issue = 179 }],
    ['unknown owner slice', (manifest: MutableManifest) => { manifest.nodes[1].owner.slice = 'unknown' }],
    ['widened Step 0 dependency', (manifest: MutableManifest) => { manifest.nodes[0].issueDependencies.push(178) }],
    ['flattened S3 dependency', (manifest: MutableManifest) => {
      manifest.nodes[1].issueDependencies.push(176, 177)
      manifest.codeDependencyGraph.edges.shift()
    }],
    ['missing required evidence', (manifest: MutableManifest) => manifest.nodes[0].requiredEvidence.pop()],
    ['substituted build identity', (manifest: MutableManifest) => {
      manifest.nodes[1].buildIdentity.exactBuilds = ['issue_179_s4']
    }],
    ['missing code edge', (manifest: MutableManifest) => manifest.codeDependencyGraph.edges.pop()],
    ['missing code node', (manifest: MutableManifest) => manifest.codeDependencyGraph.nodes.pop()],
    ['duplicate code node', (manifest: MutableManifest) => {
      manifest.codeDependencyGraph.nodes[6] = manifest.codeDependencyGraph.nodes[5]
    }],
    ['code cycle', (manifest: MutableManifest) => {
      manifest.codeDependencyGraph.edges.push({ from: 's6_issue_181', to: 's1_issue_176' })
    }],
    ['missing runtime edge', (manifest: MutableManifest) => manifest.runtimeActivationGraph.edges.pop()],
    ['missing runtime graph node', (manifest: MutableManifest) => manifest.runtimeActivationGraph.nodes.pop()],
    ['duplicate runtime edge', (manifest: MutableManifest) => {
      manifest.runtimeActivationGraph.edges.push(structuredClone(manifest.runtimeActivationGraph.edges[0]))
    }],
    ['runtime cycle', (manifest: MutableManifest) => {
      manifest.runtimeActivationGraph.edges.push({
        from: 's5_s6_release_ready',
        to: 'step0_retention_bridge',
      })
    }],
    ['obsolete s4_activate', (manifest: MutableManifest) => {
      manifest.runtimeActivationGraph.edges[5].to = 's4_activate'
    }],
    ['graph substitution', (manifest: MutableManifest) => {
      const codeGraph = manifest.codeDependencyGraph
      manifest.codeDependencyGraph = manifest.runtimeActivationGraph
      manifest.runtimeActivationGraph = codeGraph
    }],
    ['graph evidence substitution', (manifest: MutableManifest) => {
      manifest.nodes[5].requiredEvidence = structuredClone(manifest.nodes[6].requiredEvidence)
    }],
  ])('rejects %s', (_name, change) => {
    expect(() => validateEpic172ReleaseOrder(mutated(change))).toThrow(/Invalid Epic 172 release-order manifest/)
  })
})
