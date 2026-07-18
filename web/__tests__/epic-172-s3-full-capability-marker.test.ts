import { describe, it, expect } from 'vitest'
import {
  buildFilesystemGrantBlockMetadata,
  parseFilesystemGrantBlockMetadata,
  filesystemGrantBlockFingerprint,
} from '@/lib/mcps/filesystem-grant-lifecycle'
import {
  canonicalFilesystemProjectCapabilities,
  type FilesystemProjectCapability,
} from '@/lib/mcps/filesystem-grants'

describe('S3: full-capability marker', () => {
  const ALL_THREE: FilesystemProjectCapability[] = [
    'filesystem.project.read',
    'filesystem.project.list',
    'filesystem.project.search',
  ]
  const ALL_THREE_CANONICAL: FilesystemProjectCapability[] = [
    'filesystem.project.list',
    'filesystem.project.read',
    'filesystem.project.search',
  ]

  it('persists the full canonical set of three capabilities in marker metadata', () => {
    const marker = buildFilesystemGrantBlockMetadata({
      blockedAt: new Date(),
      hold: {
        holdKind: 'approval_required',
        grantPhase: 'none',
        grantConsumed: false,
        grantDecisionRevision: null,
        revocationReason: null,
      },
      requirementKeys: ['requirement:filesystem.context'],
      requestedCapabilities: ALL_THREE,
      rootBindingRevision: '1',
    })

    expect(marker.requestedCapabilities).toHaveLength(3)
    expect(marker.requestedCapabilities).toEqual(ALL_THREE_CANONICAL)

    const parsed = parseFilesystemGrantBlockMetadata(marker)
    expect(parsed?.requestedCapabilities).toHaveLength(3)
    expect(parsed?.requestedCapabilities).toEqual(ALL_THREE_CANONICAL)
  })

  it('canonicalizes only the three known bounded-read-only capabilities', () => {
    const canonical = canonicalFilesystemProjectCapabilities([
      'filesystem.project.read',
      'filesystem.project.search',
      'filesystem.project.list',
      'filesystem.project.write',
      'filesystem.project.tree',
    ])
    expect(canonical).toHaveLength(3)
    expect(canonical).toEqual(ALL_THREE_CANONICAL)
  })

  it('rejects markers that omit any of the three capabilities', () => {
    const partialMarker = buildFilesystemGrantBlockMetadata({
      blockedAt: new Date(),
      hold: {
        holdKind: 'approval_required',
        grantPhase: 'none',
        grantConsumed: false,
        grantDecisionRevision: null,
        revocationReason: null,
      },
      requirementKeys: ['requirement:filesystem.context'],
      requestedCapabilities: ['filesystem.project.read'],
      rootBindingRevision: '1',
    })
    expect(partialMarker.requestedCapabilities).toHaveLength(1)
    expect(partialMarker.requestedCapabilities).toEqual(['filesystem.project.read'])

    const hash = filesystemGrantBlockFingerprint({
      hold: {
        holdKind: 'approval_required',
        grantPhase: 'none',
        grantConsumed: false,
        grantDecisionRevision: null,
        revocationReason: null,
      },
      requirementKeys: ['requirement:filesystem.context'],
      requestedCapabilities: ALL_THREE,
      rootBindingRevision: '1',
    })
    expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  it('computes distinct fingerprints for different capability sets', () => {
    const hashFull = filesystemGrantBlockFingerprint({
      hold: {
        holdKind: 'approval_required',
        grantPhase: 'none',
        grantConsumed: false,
        grantDecisionRevision: null,
        revocationReason: null,
      },
      requirementKeys: ['r1'],
      requestedCapabilities: ALL_THREE,
      rootBindingRevision: '1',
    })
    const hashPartial = filesystemGrantBlockFingerprint({
      hold: {
        holdKind: 'approval_required',
        grantPhase: 'none',
        grantConsumed: false,
        grantDecisionRevision: null,
        revocationReason: null,
      },
      requirementKeys: ['r1'],
      requestedCapabilities: ['filesystem.project.read'],
      rootBindingRevision: '1',
    })
    expect(hashFull).not.toBe(hashPartial)
  })
})
