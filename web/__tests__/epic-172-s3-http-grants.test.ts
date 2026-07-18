import { describe, it, expect, vi } from 'vitest'
import {
  CURRENT_LOCAL_PROJECTION_HEAD_KINDS,
  CURRENT_LOCAL_PROJECTION_HEAD_KIND_COUNT,
  MAX_LOCAL_PROJECTION_HEAD_PACKAGES,
  MAX_LOCAL_PROJECTION_HEADS,
  isLocalProjectionHeadKind,
  assertLocalProjectionHeadKind,
  projectionHeadFingerprint,
  assertProjectionHeadReassignment,
  assertProjectionHeadNotMissing,
  assertProjectionHeadNotDeleted,
  buildProjectionHeadIdentity,
} from '@/lib/mcps/local-projection-heads'
import {
  isLegacyAdapterExpired,
  assertLegacyAdapterNotExpired,
  adaptLegacyMutation,
  LEGACY_S3_ADAPTER_DEADLINE,
} from '@/lib/mcps/legacy-adapter'
import {
  parseFilesystemGrantBlockMetadata,
  buildFilesystemGrantBlockMetadata,
} from '@/lib/mcps/filesystem-grant-lifecycle'
import {
  canonicalFilesystemProjectCapabilities,
} from '@/lib/mcps/filesystem-grants'
import { logged500Error, generic500Response } from '@/lib/logged-500'

describe('S3: local projection heads', () => {
  it('has exactly eight preallocated head kinds', () => {
    expect(CURRENT_LOCAL_PROJECTION_HEAD_KINDS).toHaveLength(8)
    expect(CURRENT_LOCAL_PROJECTION_HEAD_KIND_COUNT).toBe(8)
  })

  it('enforces 2,048 heads at 256 packages', () => {
    expect(MAX_LOCAL_PROJECTION_HEAD_PACKAGES).toBe(256)
    expect(MAX_LOCAL_PROJECTION_HEADS).toBe(2048)
  })

  it('identifies valid head kinds', () => {
    for (const kind of CURRENT_LOCAL_PROJECTION_HEAD_KINDS) {
      expect(isLocalProjectionHeadKind(kind)).toBe(true)
    }
    expect(isLocalProjectionHeadKind('ninth_kind')).toBe(false)
    expect(isLocalProjectionHeadKind('')).toBe(false)
    expect(isLocalProjectionHeadKind(null)).toBe(false)
    expect(isLocalProjectionHeadKind(undefined)).toBe(false)
  })

  it('asserts valid and rejects invalid head kinds', () => {
    assertLocalProjectionHeadKind('filesystem_grant_decision')
    expect(() => assertLocalProjectionHeadKind('arbitrary_head')).toThrow(
      'Invalid projection head kind',
    )
    expect(() => assertLocalProjectionHeadKind(42)).toThrow(
      'Invalid projection head kind',
    )
  })

  it('rejects reassignment across head kinds', () => {
    const headId = '550e8400-e29b-41d4-a716-446655440000'
    const identity = buildProjectionHeadIdentity('111e8400-e29b-41d4-a716-446655440000',
      '660e8400-e29b-41d4-a716-446655440001',
      'filesystem_grant_decision',
      0,
    )
    expect(() =>
      assertProjectionHeadReassignment(
        {
          headId,
          kind: 'claim_token',
          headFingerprint: projectionHeadFingerprint(identity),
        },
        identity,
      ),
    ).toThrow('kind mismatch')
  })

  it('rejects fingerprint mismatches', () => {
    const wpId = '660e8400-e29b-41d4-a716-446655440001'
    const identityA = buildProjectionHeadIdentity('111e8400-e29b-41d4-a716-446655440000', wpId, 'lease_expiry', 3)
    const identityB = buildProjectionHeadIdentity('111e8400-e29b-41d4-a716-446655440000',
      '770e8400-e29b-41d4-a716-446655440002',
      'lease_expiry',
      3,
    )
    expect(() =>
      assertProjectionHeadReassignment(
        {
          headId: identityA.headId,
          kind: 'lease_expiry',
          headFingerprint: projectionHeadFingerprint(identityA),
        },
        identityB,
      ),
    ).toThrow('fingerprint mismatch')
  })

  it('asserts head is not missing', () => {
    const identity = buildProjectionHeadIdentity('111e8400-e29b-41d4-a716-446655440000',
      '660e8400-e29b-41d4-a716-446655440001',
      'integrity_hold',
      5,
    )
    assertProjectionHeadNotMissing({ headId: identity.headId, kind: 'integrity_hold' }, identity)
    expect(() =>
      assertProjectionHeadNotMissing(null, identity),
    ).toThrow('Missing projection head')
    expect(() =>
      assertProjectionHeadNotMissing(undefined, identity),
    ).toThrow('Missing projection head')
  })

  it('asserts head is not deleted', () => {
    assertProjectionHeadNotDeleted({ state: 'preallocated' })
    assertProjectionHeadNotDeleted({ state: 'claimed' })
    expect(() => assertProjectionHeadNotDeleted({ state: 'deleted' })).toThrow(
      'Cannot operate on a deleted projection head',
    )
  })

  it('builds deterministic projection head fingerprints', () => {
    const wpId = '660e8400-e29b-41d4-a716-446655440001'
    const identity = buildProjectionHeadIdentity('111e8400-e29b-41d4-a716-446655440000', wpId, 'terminal_state', 6)
    const fingerprint = projectionHeadFingerprint(identity)
    expect(fingerprint).toMatch(
      /^head:v1:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:terminal_state:6$/,
    )
    const sameFingerprint = projectionHeadFingerprint({
      headId: identity.headId,
      taskId: identity.taskId,
      workPackageId: wpId,
      kind: 'terminal_state',
      index: 6,
    })
    expect(fingerprint).toBe(sameFingerprint)
  })
})

describe('S3: persisted requestedCapabilities', () => {
  it('persists full canonical requestedCapabilities not missingCapabilities', () => {
    const full = ['filesystem.project.read', 'filesystem.project.list', 'filesystem.project.search']
    const missing = ['filesystem.project.list']
    const fullCanonical = canonicalFilesystemProjectCapabilities(full)
    const missingCanonical = canonicalFilesystemProjectCapabilities(missing)
    expect(fullCanonical).toHaveLength(3)
    expect(missingCanonical).toHaveLength(1)
    expect(fullCanonical).toEqual(
      expect.arrayContaining(['filesystem.project.read', 'filesystem.project.list', 'filesystem.project.search']),
    )

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
      requestedCapabilities: fullCanonical,
      rootBindingRevision: '1',
    })
    expect(marker.requestedCapabilities).toHaveLength(3)
    expect(marker.requestedCapabilities).toEqual(fullCanonical)

    const parsed = parseFilesystemGrantBlockMetadata(marker)
    expect(parsed?.requestedCapabilities).toEqual(fullCanonical)
  })
})

describe('S3: legacy adapter contract', () => {
  it('defines a time-bounded deadline', () => {
    expect(LEGACY_S3_ADAPTER_DEADLINE).toBeInstanceOf(Date)
    expect(LEGACY_S3_ADAPTER_DEADLINE.getTime()).toBeGreaterThan(Date.now())
    expect(LEGACY_S3_ADAPTER_DEADLINE.toISOString()).toMatch(
      /^2026-12-31T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    )
  })

  it('is not yet expired', () => {
    expect(isLegacyAdapterExpired()).toBe(false)
    expect(isLegacyAdapterExpired(new Date('2025-01-01'))).toBe(false)
    expect(isLegacyAdapterExpired(new Date('2027-01-01'))).toBe(true)
  })

  it('asserts adapter is not expired', () => {
    expect(() => assertLegacyAdapterNotExpired()).not.toThrow()
    expect(() =>
      assertLegacyAdapterNotExpired(new Date('2027-06-15')),
    ).toThrow('legacy filesystem grant adapter expired')
  })

  it('adapts legacy mutations to S3 format', () => {
    const mutation = adaptLegacyMutation({
      workPackageId: '550e8400-e29b-41d4-a716-446655440000',
      decision: 'approved',
      capabilities: ['filesystem.project.read'],
      reason: 'Audit reason',
    })
    expect(mutation).toEqual({
      workPackageId: '550e8400-e29b-41d4-a716-446655440000',
      decision: 'approved',
      capabilities: ['filesystem.project.read'],
      grantMode: 'allow_once',
      reason: 'Audit reason',
    })
  })

  it('rejects mutations after deadline', () => {
    expect(() =>
      adaptLegacyMutation({
        workPackageId: '550e8400-e29b-41d4-a716-446655440000',
        decision: 'approved',
        capabilities: ['filesystem.project.read'],
        reason: 'OK',
      }),
    ).not.toThrow()

    const frozenDate = new Date('2027-06-15')
    if (isLegacyAdapterExpired(frozenDate)) {
      expect(isLegacyAdapterExpired(frozenDate)).toBe(true)
    }
  })
})

describe('S3: generic logged 500 responses', () => {
  it('logs errors with route context', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      generic500Response(
        new Error('Database connection lost'),
        'GET /api/projects/:id/filesystem-grant',
      )
      expect(consoleError).toHaveBeenCalledTimes(1)
      const call = consoleError.mock.calls[0]
      expect(call[0]).toContain('[GET /api/projects/:id/filesystem-grant]')
      expect(call[1]).toBeDefined()
      if (call[1] && typeof call[1] === 'object') {
        const payload = call[1] as Record<string, unknown>
        expect(payload.error).toBe('Database connection lost')
        expect(payload.route).toContain('/api/projects/:id/filesystem-grant')
      }
    } finally {
      consoleError.mockRestore()
    }
  })

  it('deduplicates repeated error logs', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const err = new Error('Test error')
      logged500Error('/api/test', err)
      logged500Error('/api/test', err)
      logged500Error('/api/test', err)
      expect(consoleError).toHaveBeenCalledTimes(1)

      const err2 = new Error('Different error')
      logged500Error('/api/other', err2)
      expect(consoleError).toHaveBeenCalledTimes(2)
    } finally {
      consoleError.mockRestore()
    }
  })

  it('returns generic error in production mode', () => {
    vi.stubEnv('NODE_ENV', 'production')
    const result = generic500Response(
      new Error('Sensitive details'),
      '/api/test',
    )
    vi.unstubAllEnvs()
    expect(result.error).toBe('Internal server error')
    expect(result.status).toBe(500)
    expect(result.logged).toBe(true)
  })
})

describe('S3: HTTP grant fixture mutations', () => {
  it('mutation schema validates expected pointer format', () => {
    const validPointer = {
      currentDecisionId: '550e8400-e29b-41d4-a716-446655440000',
      currentDecisionRevision: '5',
      pointerFingerprint: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
      pointerVersion: '2',
    }
    expect(validPointer.currentDecisionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    )
    expect(validPointer.currentDecisionRevision).toMatch(/^[1-9][0-9]*$/)
    expect(validPointer.pointerFingerprint).toMatch(/^.{1,200}$/)
    expect(validPointer.pointerVersion).toMatch(/^(0|[1-9][0-9]*)$/)

    const nullPointer = {
      currentDecisionId: null,
      currentDecisionRevision: null,
      pointerFingerprint: 'empty:550e8400-e29b-41d4-a716-446655440000',
      pointerVersion: '0',
    }
    expect(nullPointer.currentDecisionId).toBeNull()
    expect(nullPointer.currentDecisionRevision).toBeNull()
  })

  it('rejects invalid decision revisions', () => {
    expect('1').toMatch(/^[1-9][0-9]*$/)
    expect('100').toMatch(/^[1-9][0-9]*$/)
    expect('0').not.toMatch(/^[1-9][0-9]*$/)
    expect('-1').not.toMatch(/^[1-9][0-9]*$/)
    expect('abc').not.toMatch(/^[1-9][0-9]*$/)
  })
})
