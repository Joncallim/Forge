import { describe, expect, it } from 'vitest'
import {
  decodeEpic172SignedEnvelope,
  EPIC_172_REQUIRED_RETENTION_FOREIGN_KEYS,
  parseEpic172ReleaseCliArgs,
} from '@/scripts/epic-172-release'

describe('Epic 172 release CLI boundary', () => {
  it('inspects the exact release and retained-evidence foreign-key set', () => {
    expect(EPIC_172_REQUIRED_RETENTION_FOREIGN_KEYS).toHaveLength(43)
    expect(new Set(EPIC_172_REQUIRED_RETENTION_FOREIGN_KEYS)).toHaveProperty('size', 43)
    expect(new Set(EPIC_172_REQUIRED_RETENTION_FOREIGN_KEYS.map((name) => name.slice(0, 63))))
      .toHaveProperty('size', 43)
    expect(EPIC_172_REQUIRED_RETENTION_FOREIGN_KEYS).toContain('tasks_project_id_projects_id_fk')
    expect(EPIC_172_REQUIRED_RETENTION_FOREIGN_KEYS).toContain(
      'forge_epic_172_release_evidence_signer_key_id_forge_release_signer_keys_id_fk',
    )
  })
  it('accepts only the closed command option contract', () => {
    expect(parseEpic172ReleaseCliArgs(['record-evidence', '--input', 'receipt.json'])).toEqual({
      command: 'record-evidence',
      options: { input: 'receipt.json' },
    })
    expect(parseEpic172ReleaseCliArgs(['prepare-authorization', '--input', 'authorization.json'])).toEqual({
      command: 'prepare-authorization',
      options: { input: 'authorization.json' },
    })
    expect(parseEpic172ReleaseCliArgs([
      'rotate-signer',
      '--key-id', '00000000-0000-4000-8000-000000000002',
      '--expected-active-key-id', '00000000-0000-4000-8000-000000000001',
      '--expected-active-generation', '1',
      '--actor', 'release-operator',
      '--reason', 'rotate',
    ])).toEqual({
      command: 'rotate-signer',
      options: {
        'key-id': '00000000-0000-4000-8000-000000000002',
        'expected-active-key-id': '00000000-0000-4000-8000-000000000001',
        'expected-active-generation': '1',
        actor: 'release-operator',
        reason: 'rotate',
      },
    })
    expect(parseEpic172ReleaseCliArgs([
      'retire-signer',
      '--key-id', '00000000-0000-4000-8000-000000000001',
      '--generation', '1',
      '--actor', 'release-operator',
      '--reason', 'retire',
    ])).toEqual({
      command: 'retire-signer',
      options: {
        'key-id': '00000000-0000-4000-8000-000000000001',
        generation: '1',
        actor: 'release-operator',
        reason: 'retire',
      },
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
