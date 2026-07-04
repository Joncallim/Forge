import { describe, expect, it } from 'vitest'
import {
  approvedEffectiveFilesystemCapabilities,
  isFilesystemGrantBlockedPackageMetadata,
  requiresFilesystemGrantApproval,
} from '@/lib/mcps/filesystem-grants'

const REQUIRED_FILESYSTEM_REQUIREMENT = [{
  mcpId: 'filesystem',
  requirement: 'required',
  capabilities: ['filesystem.project.read', 'filesystem.project.search'],
}]

function approvedEffectivePhase(capabilities: string[]): Record<string, unknown> {
  return {
    mcpGrantPhases: {
      effective: {
        schemaVersion: 1,
        phase: 'effective',
        runtimeEnforcement: 'bounded_context_packet',
        status: 'approved',
        grants: [{ mcpId: 'filesystem', status: 'approved', capabilities }],
      },
    },
  }
}

describe('requiresFilesystemGrantApproval', () => {
  it('holds a required filesystem package that has no approved effective grant', () => {
    const result = requiresFilesystemGrantApproval({
      mcpRequirements: REQUIRED_FILESYSTEM_REQUIREMENT,
      metadata: {},
    })
    expect(result.blocked).toBe(true)
    expect(result.missingCapabilities).toContain('filesystem.project.read')
    expect(result.missingCapabilities).toContain('filesystem.project.search')
  })

  it('holds a package whose effective grant only covers some required capabilities', () => {
    const result = requiresFilesystemGrantApproval({
      mcpRequirements: REQUIRED_FILESYSTEM_REQUIREMENT,
      metadata: approvedEffectivePhase(['filesystem.project.read']),
    })
    expect(result.blocked).toBe(true)
    expect(result.missingCapabilities).toEqual(['filesystem.project.search'])
  })

  it('allows a package whose effective grant covers every required capability', () => {
    const result = requiresFilesystemGrantApproval({
      mcpRequirements: REQUIRED_FILESYSTEM_REQUIREMENT,
      metadata: approvedEffectivePhase(['filesystem.project.read', 'filesystem.project.search']),
    })
    expect(result.blocked).toBe(false)
    expect(result.missingCapabilities).toEqual([])
  })

  it('never blocks optional continue-without-mcp filesystem requirements', () => {
    const result = requiresFilesystemGrantApproval({
      mcpRequirements: [{
        mcpId: 'filesystem',
        requirement: 'optional',
        fallback: { action: 'continue_without_mcp' },
        capabilities: ['filesystem.project.read'],
      }],
      metadata: {},
    })
    expect(result.blocked).toBe(false)
  })

  it('does not block packages with no filesystem requirement', () => {
    const result = requiresFilesystemGrantApproval({ mcpRequirements: [], metadata: {} })
    expect(result.blocked).toBe(false)
  })

  it('ignores a denied effective phase when computing approved capabilities', () => {
    expect(approvedEffectiveFilesystemCapabilities({
      mcpGrantPhases: {
        effective: {
          schemaVersion: 1,
          phase: 'effective',
          runtimeEnforcement: 'bounded_context_packet',
          status: 'denied',
          grants: [],
        },
      },
    })).toEqual([])
  })
})

describe('isFilesystemGrantBlockedPackageMetadata', () => {
  it('recognises the handoff grant-block marker', () => {
    expect(isFilesystemGrantBlockedPackageMetadata({
      mcpGrantBlock: { source: 'filesystem-grant-approval', status: 'failed' },
    })).toBe(true)
  })

  it('rejects metadata without the marker or from another source', () => {
    expect(isFilesystemGrantBlockedPackageMetadata({})).toBe(false)
    expect(isFilesystemGrantBlockedPackageMetadata(null)).toBe(false)
    expect(isFilesystemGrantBlockedPackageMetadata({ mcpGrantBlock: { source: 'other' } })).toBe(false)
  })
})
