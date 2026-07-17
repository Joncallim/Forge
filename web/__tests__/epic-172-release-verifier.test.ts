import {
  generateKeyPairSync,
  sign,
} from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getEpic172RequiredEvidenceNames } from '@/lib/mcps/epic-172-release-order'
import {
  canonicalizeEpic172Json,
  EPIC_172_RELEASE_EVIDENCE_DOMAIN,
  EPIC_172_TRANSITION_AUTHORIZATION_DOMAIN,
  epic172EnvelopeDigest,
  epic172ReceiptSetDigest,
  epic172ReleaseEvidenceSignedBytes,
  epic172TransitionIdentityDigest,
  epic172TransitionAuthorizationSignedBytes,
  parseEpic172TransitionAuthorizationEnvelope,
  verifyEpic172ReleaseEvidence,
  verifyEpic172TransitionAuthorization,
  type CanonicalJsonValue,
} from '@/lib/mcps/epic-172-release-verifier'

const NOW = new Date('2026-07-17T04:00:00.000Z')

function keyPair() {
  const pair = generateKeyPairSync('ed25519')
  return {
    privateKey: pair.privateKey,
    publicKeySpki: pair.publicKey.export({ format: 'der', type: 'spki' }),
  }
}

function releaseEnvelope(overrides: Record<string, unknown> = {}) {
  const evidenceKind = (overrides.evidenceKind ?? 'step0_retention_bridge') as 'step0_retention_bridge'
  const envelope = {
    envelopeVersion: 1,
    receiptId: '00000000-0000-4000-8000-000000000001',
    manifestVersion: 1,
    evidenceKind,
    owner: { issue: 179, slice: 'step0' },
    exactBuilds: ['issue_179_step0@café'],
    requiredEvidence: getEpic172RequiredEvidenceNames(evidenceKind).map((name, index) => ({
      name,
      measurementDigest: (index + 1).toString(16).padStart(64, '0'),
    })),
    reviewedSha: 'a'.repeat(40),
    epoch: null,
    predecessorReceiptIds: [],
    predecessorSetDigest: '',
    transitionIdentityDigest: '',
    signerKeyId: '00000000-0000-4000-8000-000000000002',
    signerGeneration: 1,
    githubAppId: '123456',
    controllerRunId: 'controller-run-1',
    controllerJobId: 'controller-job-1',
    nonce: '00000000-0000-4000-8000-000000000003',
    issuedAt: '2026-07-17T03:59:00.000Z',
    ...overrides,
  }
  envelope.predecessorSetDigest = typeof overrides.predecessorSetDigest === 'string'
    ? overrides.predecessorSetDigest
    : epic172ReceiptSetDigest(envelope.predecessorReceiptIds as string[])
  envelope.transitionIdentityDigest = typeof overrides.transitionIdentityDigest === 'string'
    ? overrides.transitionIdentityDigest
    : epic172TransitionIdentityDigest({
      manifestVersion: 1,
      nodeOrRequiredEvidenceKind: envelope.evidenceKind as 'step0_retention_bridge',
      owner: envelope.owner as { issue: number; slice: 'step0' },
      exactBuilds: envelope.exactBuilds as string[],
      reviewedSha: envelope.reviewedSha as string,
      epoch: envelope.epoch as number | null,
      canonicalPredecessorReceiptSetDigest: envelope.predecessorSetDigest,
    })
  return envelope
}

function transitionEnvelope(overrides: Record<string, unknown> = {}) {
  const envelope = {
    envelopeVersion: 1,
    authorizationId: '00000000-0000-4000-8000-000000000004',
    manifestVersion: 1,
    targetNode: 's3_issue_178',
    transitionIdentityDigest: '',
    sourceReceiptIds: ['00000000-0000-4000-8000-000000000001'],
    sourceReceiptSetDigest: '',
    owner: { issue: 178, slice: 's3' },
    exactBuilds: ['issue_178_s3@build-1'],
    reviewedSha: 'f'.repeat(40),
    epoch: null,
    operationId: 's3-transition-1',
    operation: 'record_s3_receipt',
    controllerLoginId: 'forge-release-controller',
    controllerRunId: 'controller-run-1',
    signerKeyId: '00000000-0000-4000-8000-000000000002',
    signerGeneration: 1,
    nonce: '00000000-0000-4000-8000-000000000005',
    issuedAt: '2026-07-17T03:59:00.000Z',
    expiresAt: '2026-07-17T04:29:00.000Z',
    ...overrides,
  }
  envelope.sourceReceiptSetDigest = typeof overrides.sourceReceiptSetDigest === 'string'
    ? overrides.sourceReceiptSetDigest
    : epic172ReceiptSetDigest(envelope.sourceReceiptIds as string[])
  envelope.transitionIdentityDigest = typeof overrides.transitionIdentityDigest === 'string'
    ? overrides.transitionIdentityDigest
    : epic172TransitionIdentityDigest({
      manifestVersion: 1,
      nodeOrRequiredEvidenceKind: envelope.targetNode as 's3_issue_178',
      owner: envelope.owner as { issue: number; slice: 's3' },
      exactBuilds: envelope.exactBuilds as string[],
      reviewedSha: envelope.reviewedSha as string,
      epoch: envelope.epoch as number | null,
      canonicalPredecessorReceiptSetDigest: envelope.sourceReceiptSetDigest,
    })
  return envelope
}

describe('Epic 172 release envelope verifier', () => {
  it('uses exact trailing-NUL domains and verifies a correct release signature', () => {
    expect(EPIC_172_RELEASE_EVIDENCE_DOMAIN.at(-1)?.charCodeAt(0)).toBe(0)
    expect(EPIC_172_TRANSITION_AUTHORIZATION_DOMAIN.at(-1)?.charCodeAt(0)).toBe(0)

    const envelope = releaseEnvelope()
    const keys = keyPair()
    const detachedSignature = sign(null, epic172ReleaseEvidenceSignedBytes(envelope), keys.privateKey)
    const result = verifyEpic172ReleaseEvidence({
      envelope,
      envelopeDigest: epic172EnvelopeDigest(envelope as CanonicalJsonValue),
      detachedSignature,
      publicKeySpki: keys.publicKeySpki,
      databaseNow: NOW,
    })
    expect(result).toMatchObject({ ok: true, envelope: { evidenceKind: 'step0_retention_bridge' } })
  })

  it('verifies a correct, live transition authorization signature', () => {
    const envelope = transitionEnvelope()
    const keys = keyPair()
    const detachedSignature = sign(null, epic172TransitionAuthorizationSignedBytes(envelope), keys.privateKey)
    expect(verifyEpic172TransitionAuthorization({
      envelope,
      envelopeDigest: epic172EnvelopeDigest(envelope as CanonicalJsonValue),
      detachedSignature,
      publicKeySpki: keys.publicKeySpki,
      databaseNow: NOW,
    })).toMatchObject({ ok: true, envelope: { targetNode: 's3_issue_178' } })
  })

  it('rejects a wrong key, wrong domain, and changed signature', () => {
    const envelope = releaseEnvelope()
    const keys = keyPair()
    const otherKeys = keyPair()
    const correctBytes = epic172ReleaseEvidenceSignedBytes(envelope)
    const correctSignature = sign(null, correctBytes, keys.privateKey)
    const transitionDomainSignature = sign(
      null,
      Buffer.concat([
        Buffer.from(EPIC_172_TRANSITION_AUTHORIZATION_DOMAIN, 'utf8'),
        canonicalizeEpic172Json(envelope as CanonicalJsonValue),
      ]),
      keys.privateKey,
    )
    const changedSignature = Buffer.from(correctSignature)
    changedSignature[0] ^= 1
    const base = {
      envelope,
      envelopeDigest: epic172EnvelopeDigest(envelope as CanonicalJsonValue),
      databaseNow: NOW,
    }
    expect(verifyEpic172ReleaseEvidence({
      ...base,
      detachedSignature: correctSignature,
      publicKeySpki: otherKeys.publicKeySpki,
    })).toEqual({ ok: false, reason: 'invalid_signature' })
    expect(verifyEpic172ReleaseEvidence({
      ...base,
      detachedSignature: transitionDomainSignature,
      publicKeySpki: keys.publicKeySpki,
    })).toEqual({ ok: false, reason: 'invalid_signature' })
    expect(verifyEpic172ReleaseEvidence({
      ...base,
      detachedSignature: changedSignature,
      publicKeySpki: keys.publicKeySpki,
    })).toEqual({ ok: false, reason: 'invalid_signature' })
  })

  it('normalizes strings to NFC before canonical key ordering and hashing', () => {
    const decomposed = releaseEnvelope({ exactBuilds: ['issue_179_step0@cafe\u0301'] })
    const composed = releaseEnvelope({ exactBuilds: ['issue_179_step0@café'] })
    expect(epic172EnvelopeDigest(decomposed as CanonicalJsonValue)).toBe(
      epic172EnvelopeDigest(composed as CanonicalJsonValue),
    )
    expect(canonicalizeEpic172Json({ z: 1, a: 2 })).toEqual(Buffer.from('{"a":2,"z":1}'))
  })

  it('rejects unknown fields and manifest-invalid epoch or predecessor cross-products', () => {
    expect(() => epic172ReleaseEvidenceSignedBytes(releaseEnvelope({ unexpected: true }))).toThrow(/unknown field/)
    expect(() => epic172ReleaseEvidenceSignedBytes(releaseEnvelope({ epoch: 2 }))).toThrow(/must be null/)
    expect(() => epic172ReleaseEvidenceSignedBytes(releaseEnvelope({
      exactBuilds: ['issue_178_s3@wrong-slice'],
    }))).toThrow(/issue_179_step0.*manifest order/)
    expect(() => epic172ReleaseEvidenceSignedBytes(releaseEnvelope({
      predecessorReceiptIds: ['00000000-0000-4000-8000-000000000006'],
    }))).toThrow(/only Step 0/)
    for (const length of [39, 41, 63, 65]) {
      expect(() => epic172ReleaseEvidenceSignedBytes(releaseEnvelope({
        reviewedSha: 'a'.repeat(length),
      }))).toThrow(/reviewed Git SHA/)
    }
    expect(() => epic172ReleaseEvidenceSignedBytes(releaseEnvelope({
      reviewedSha: 'a'.repeat(64),
      exactBuilds: [`issue_179_step0@${'a'.repeat(64)}`],
    }))).not.toThrow()
  })

  it('cryptographically binds the exact ordered postcondition measurements', () => {
    const envelope = releaseEnvelope()
    const keys = keyPair()
    const detachedSignature = sign(null, epic172ReleaseEvidenceSignedBytes(envelope), keys.privateKey)
    const changedMeasurement = structuredClone(envelope)
    changedMeasurement.requiredEvidence[0].measurementDigest = 'f'.repeat(64)
    expect(verifyEpic172ReleaseEvidence({
      envelope: changedMeasurement,
      envelopeDigest: epic172EnvelopeDigest(changedMeasurement as CanonicalJsonValue),
      detachedSignature,
      publicKeySpki: keys.publicKeySpki,
      databaseNow: NOW,
    })).toEqual({ ok: false, reason: 'invalid_signature' })

    expect(() => epic172ReleaseEvidenceSignedBytes(releaseEnvelope({ requiredEvidence: [] }))).toThrow(/expected exactly/)
    const reordered = structuredClone(envelope.requiredEvidence)
    ;[reordered[0], reordered[1]] = [reordered[1], reordered[0]]
    expect(() => epic172ReleaseEvidenceSignedBytes(releaseEnvelope({ requiredEvidence: reordered }))).toThrow(/expected/)
    expect(() => epic172ReleaseEvidenceSignedBytes(releaseEnvelope({
      requiredEvidence: [...envelope.requiredEvidence, { name: 'extra', measurementDigest: 'a'.repeat(64) }],
    }))).toThrow(/expected exactly/)
    expect(() => epic172ReleaseEvidenceSignedBytes(releaseEnvelope({
      requiredEvidence: envelope.requiredEvidence.map((claim, index) => (
        index === 0 ? { ...claim, measurementDigest: 'not-a-digest' } : claim
      )),
    }))).toThrow(/measurement digest/)
  })

  it('rejects future-issued release evidence even with a valid signature', () => {
    const envelope = releaseEnvelope({ issuedAt: '2026-07-17T04:00:00.001Z' })
    const keys = keyPair()
    const detachedSignature = sign(null, epic172ReleaseEvidenceSignedBytes(envelope), keys.privateKey)
    expect(verifyEpic172ReleaseEvidence({
      envelope,
      envelopeDigest: epic172EnvelopeDigest(envelope as CanonicalJsonValue),
      detachedSignature,
      publicKeySpki: keys.publicKeySpki,
      databaseNow: NOW,
    })).toEqual({ ok: false, reason: 'future_issued_at' })
  })

  it('rejects expired and overlong transition authorizations', () => {
    const expired = transitionEnvelope({ expiresAt: NOW.toISOString() })
    const keys = keyPair()
    const detachedSignature = sign(null, epic172TransitionAuthorizationSignedBytes(expired), keys.privateKey)
    expect(verifyEpic172TransitionAuthorization({
      envelope: expired,
      envelopeDigest: epic172EnvelopeDigest(expired as CanonicalJsonValue),
      detachedSignature,
      publicKeySpki: keys.publicKeySpki,
      databaseNow: NOW,
    })).toEqual({ ok: false, reason: 'expired_authorization' })

    expect(() => parseEpic172TransitionAuthorizationEnvelope(transitionEnvelope({
      expiresAt: '2026-07-17T04:29:00.001Z',
    }))).toThrow(/at most 30 minutes/)
  })
})
