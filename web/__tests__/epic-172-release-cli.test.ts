import { describe, expect, it } from 'vitest'
import {
  decodeEpic172SignedEnvelope,
  parseEpic172ReleaseCliArgs,
} from '@/scripts/epic-172-release'

describe('Epic 172 release CLI boundary', () => {
  it('accepts only the closed command option contract', () => {
    expect(parseEpic172ReleaseCliArgs(['record-evidence', '--input', 'receipt.json'])).toEqual({
      command: 'record-evidence',
      options: { input: 'receipt.json' },
    })
    expect(parseEpic172ReleaseCliArgs(['prepare-authorization', '--input', 'authorization.json'])).toEqual({
      command: 'prepare-authorization',
      options: { input: 'authorization.json' },
    })
    expect(() => parseEpic172ReleaseCliArgs([
      'record-evidence',
      '--input',
      'receipt.json',
      '--private-key',
      'do-not-load.pem',
    ])).toThrow(/private-key/)
    expect(() => parseEpic172ReleaseCliArgs(['inspect', '--database-url', 'secret'])).toThrow(/database-url/)
  })

  it('accepts a canonical detached Ed25519 signature without widening the input', () => {
    const value = {
      envelope: { manifestVersion: 1 },
      envelopeDigest: 'a'.repeat(64),
      detachedSignatureBase64: Buffer.alloc(64, 7).toString('base64'),
    }
    const decoded = decodeEpic172SignedEnvelope(value)
    expect(decoded.detachedSignature).toHaveLength(64)
    expect(decoded.envelope).toEqual(value.envelope)
    expect(() => decodeEpic172SignedEnvelope({ ...value, privateKey: 'forbidden' })).toThrow(/exactly/)
    expect(() => decodeEpic172SignedEnvelope({ ...value, detachedSignatureBase64: 'AAAA' })).toThrow(/64-byte/)
  })
})
