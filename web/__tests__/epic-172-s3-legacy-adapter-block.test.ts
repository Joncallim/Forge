import { describe, it, expect } from 'vitest'
import { legacyFilesystemGrantBlock } from '@/lib/mcps/legacy-adapter'
import { buildFilesystemGrantBlockMetadata } from '@/lib/mcps/filesystem-grant-lifecycle'
import type { ProjectMcpConfig } from '@/db/schema'

const WP = '660e8400-e29b-41d4-a716-446655440001'
const EMPTY_CONFIG = {} as ProjectMcpConfig

const canonicalBlock = buildFilesystemGrantBlockMetadata({
  blockedAt: new Date('2026-05-01T00:00:00.000Z'),
  hold: {
    holdKind: 'approval_required',
    grantPhase: 'none',
    grantConsumed: false,
    grantDecisionRevision: null,
    revocationReason: null,
  },
  requirementKeys: ['requirement:filesystem.context'],
  requestedCapabilities: ['filesystem.project.read', 'filesystem.project.list'],
  rootBindingRevision: '7',
})

describe('S3: legacy filesystem grant block adapter', () => {
  it('preserves the real work-package id and reconstructs an equivalent canonical block', () => {
    const state = legacyFilesystemGrantBlock({
      workPackageId: WP,
      mcpRequirements: [],
      metadata: { mcpGrantBlock: canonicalBlock },
      projectMcpConfig: EMPTY_CONFIG,
      projectRootBindingRevision: BigInt(7), // bigint, as returned by Drizzle for the revision column
    })

    expect(state.workPackageId).toBe(WP)
    expect(state.fingerprintVerified).toBe(true)
    expect(state.blockFingerprint).toBe(canonicalBlock.blockFingerprint)
    // Byte-for-byte fixture equivalence between the reconstructed and stored block.
    expect(state.blockMetadata).toEqual(canonicalBlock)
    expect(JSON.stringify(state.blockMetadata)).toBe(JSON.stringify(canonicalBlock))
  })

  it('reads the block only from metadata.mcpGrantBlock, never the metadata root', () => {
    // The pre-fix adapter parsed the whole metadata object; a block sitting at the
    // root must now be ignored because the canonical location is mcpGrantBlock.
    const state = legacyFilesystemGrantBlock({
      workPackageId: WP,
      metadata: canonicalBlock,
      projectMcpConfig: EMPTY_CONFIG,
      projectRootBindingRevision: '7',
    })
    expect(state.blockMetadata).toBeNull()
    expect(state.blockFingerprint).toBeNull()
    expect(state.fingerprintVerified).toBe(false)
  })

  it('flags a block whose fingerprint does not reconstruct under the given root binding', () => {
    const state = legacyFilesystemGrantBlock({
      workPackageId: WP,
      metadata: { mcpGrantBlock: canonicalBlock },
      projectMcpConfig: EMPTY_CONFIG,
      projectRootBindingRevision: '999', // wrong revision → fingerprint cannot match
    })
    expect(state.fingerprintVerified).toBe(false)
    expect(state.blockFingerprint).not.toBe(canonicalBlock.blockFingerprint)
    // The un-verified original is still surfaced unchanged, never a forged one.
    expect(state.blockMetadata).toEqual(canonicalBlock)
  })

  it('honors the injected clock and rejects reads past the adapter deadline', () => {
    expect(() =>
      legacyFilesystemGrantBlock({
        workPackageId: WP,
        metadata: { mcpGrantBlock: canonicalBlock },
        projectMcpConfig: EMPTY_CONFIG,
        projectRootBindingRevision: '7',
        now: new Date('2027-06-15T00:00:00.000Z'),
      }),
    ).toThrow('legacy filesystem grant adapter expired')
  })
})
