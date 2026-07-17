import { describe, expect, it } from 'vitest'
import {
  approvedEffectiveFilesystemCapabilities,
  isFilesystemGrantBlockedPackageMetadata,
  requiresFilesystemGrantApproval,
  summarizeFilesystemCapabilities,
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
        schemaVersion: 2,
        phase: 'effective',
        source: 'explicit-grant-approval',
        grantMode: 'allow_once',
        runtimeIssued: false,
        runtimeEnforcement: 'bounded_context_packet',
        status: 'approved',
        grantDecisionRevision: '1',
        rootBindingRevision: '1',
        grants: [{ mcpId: 'filesystem', status: 'approved', capabilities }],
      },
    },
  }
}

describe('requiresFilesystemGrantApproval', () => {
  it('keeps filesystem.project.write visible as planning-only without requesting a live grant', () => {
    const summary = summarizeFilesystemCapabilities({
      mcpRequirements: [{
        mcpId: 'filesystem',
        agent: 'backend',
        requirement: 'required',
        capabilities: ['filesystem.project.write'],
        fallback: { action: 'block', message: '' },
      }],
      metadata: {},
    })

    expect(summary).toEqual({
      blockingCapabilities: [],
      boundedRuntimeRequestedCapabilities: [],
      planningVisibleCapabilities: ['filesystem.project.write'],
      requestedCapabilities: ['filesystem.project.write'],
    })
    expect(requiresFilesystemGrantApproval({
      mcpRequirements: [{
        mcpId: 'filesystem',
        agent: 'backend',
        requirement: 'required',
        capabilities: ['filesystem.project.write'],
        fallback: { action: 'block', message: '' },
      }],
      metadata: {},
    })).toMatchObject({ blocked: false, requestedCapabilities: ['filesystem.project.write'] })
  })

  it('projects read plus write into distinct planning and bounded-runtime capability sets', () => {
    const summary = summarizeFilesystemCapabilities({
      mcpRequirements: [{
        mcpId: 'filesystem',
        agent: 'backend',
        requirement: 'required',
        capabilities: ['filesystem.project.read', 'filesystem.project.write'],
        fallback: { action: 'block', message: '' },
      }],
      metadata: approvedEffectivePhase(['filesystem.project.read']),
      projectRootBindingRevision: '1',
    })

    expect(summary).toMatchObject({
      blockingCapabilities: [],
      boundedRuntimeRequestedCapabilities: ['filesystem.project.read'],
      planningVisibleCapabilities: ['filesystem.project.read', 'filesystem.project.write'],
      requestedCapabilities: ['filesystem.project.read', 'filesystem.project.write'],
    })
  })

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
      projectRootBindingRevision: '1',
    })
    expect(result.blocked).toBe(true)
    expect(result.missingCapabilities).toEqual(['filesystem.project.search'])
  })

  it('allows a package whose effective grant covers every required capability', () => {
    const result = requiresFilesystemGrantApproval({
      mcpRequirements: REQUIRED_FILESYSTEM_REQUIREMENT,
      metadata: approvedEffectivePhase(['filesystem.project.read', 'filesystem.project.search']),
      projectRootBindingRevision: '1',
    })
    expect(result.blocked).toBe(false)
    expect(result.missingCapabilities).toEqual([])
  })

  it('allows a package covered by the current project-level grant', () => {
    const result = requiresFilesystemGrantApproval({
      mcpRequirements: REQUIRED_FILESYSTEM_REQUIREMENT,
      metadata: {},
      projectMcpConfig: {
        grants: {
          filesystem: {
            schemaVersion: 2,
            mcpId: 'filesystem',
            status: 'approved',
            grantMode: 'always_allow',
            capabilities: ['filesystem.project.read', 'filesystem.project.search'],
            grantApprovalId: 'grant-approval-1',
            grantDecisionRevision: '1',
            rootBindingRevision: '1',
          },
        },
      },
      projectRootBindingRevision: '1',
    })

    expect(result.blocked).toBe(false)
    expect(result.missingCapabilities).toEqual([])
  })

  it('blocks a stale project-derived effective phase after the project grant is removed', () => {
    const result = requiresFilesystemGrantApproval({
      mcpRequirements: REQUIRED_FILESYSTEM_REQUIREMENT,
      metadata: {
        mcpGrantPhases: {
          effective: {
            schemaVersion: 2,
            phase: 'effective',
            source: 'project-filesystem-approval',
            runtimeEnforcement: 'bounded_context_packet',
            status: 'approved',
            grantDecisionRevision: '1',
            rootBindingRevision: '1',
            grants: [{
              mcpId: 'filesystem',
              status: 'approved',
              capabilities: ['filesystem.project.read', 'filesystem.project.search'],
            }],
          },
        },
      },
      projectMcpConfig: { profile: 'default', requiredMcps: [], overrides: {} },
      projectRootBindingRevision: '1',
    })

    expect(result.blocked).toBe(true)
    expect(result.missingCapabilities).toEqual(['filesystem.project.read', 'filesystem.project.search'])
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
