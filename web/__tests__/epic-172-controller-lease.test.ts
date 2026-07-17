import { describe, expect, it } from 'vitest'
import fixture from './__fixtures__/epic-172-controller-lease-v1.json'
import {
  assertEpic172ProductionControllerLeaseSecret,
  constantTimeEqualEpic172DigestV1,
  epic172ControllerLeaseDigestV1,
  EPIC_172_CONTROLLER_LEASE_DIGEST_DOMAIN_V1,
  EPIC_172_CONTROLLER_LEASE_SECRET_BYTES_V1,
  generateEpic172ControllerLeaseSecretV1,
} from '@/lib/mcps/epic-172-controller-lease'

describe('Epic 172 controller lease v1', () => {
  it('matches the language-neutral domain and digest vector', () => {
    const secret = Buffer.from(fixture.secretHex, 'hex')
    expect(EPIC_172_CONTROLLER_LEASE_SECRET_BYTES_V1).toBe(fixture.secretBytes)
    expect(EPIC_172_CONTROLLER_LEASE_DIGEST_DOMAIN_V1.toString('utf8')).toBe(fixture.domainUtf8)
    expect(EPIC_172_CONTROLLER_LEASE_DIGEST_DOMAIN_V1.toString('hex')).toBe(fixture.domainHex)
    expect(epic172ControllerLeaseDigestV1(secret).toString('hex')).toBe(fixture.digestHex)
  })

  it.each([0, 31, 33])('rejects a %i-byte secret', (length) => {
    expect(() => epic172ControllerLeaseDigestV1(Buffer.alloc(length))).toThrow(/exactly 32 bytes/)
  })

  it('distinguishes a bit flip and rejects non-32-byte comparisons', () => {
    const digest = Buffer.from(fixture.digestHex, 'hex')
    const changed = Buffer.from(digest)
    changed[31] ^= 1
    expect(constantTimeEqualEpic172DigestV1(digest, Buffer.from(digest))).toBe(true)
    expect(constantTimeEqualEpic172DigestV1(digest, changed)).toBe(false)
    expect(() => constantTimeEqualEpic172DigestV1(digest, Buffer.alloc(31))).toThrow(/exactly 32 bytes/)
  })

  it('forbids the public fixture secret for production use', () => {
    expect(() => assertEpic172ProductionControllerLeaseSecret(Buffer.from(fixture.secretHex, 'hex')))
      .toThrow(/fixture secret is forbidden/)
  })

  it('generates exact-length non-fixture secrets', () => {
    const secret = generateEpic172ControllerLeaseSecretV1()
    expect(secret).toHaveLength(fixture.secretBytes)
    expect(secret.toString('hex')).not.toBe(fixture.secretHex)
  })
})
