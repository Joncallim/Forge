/**
 * Suite — secret encryption (lib/crypto.ts)
 *
 * AES-256-GCM round-trip, IV uniqueness, tamper rejection, and the missing-key
 * guard. The key is derived from SESSION_SECRET (or FORGE_ENCRYPTION_KEY).
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { encryptSecret, decryptSecret } from '@/lib/crypto'

describe('crypto', () => {
  beforeEach(() => {
    process.env.SESSION_SECRET = 'b'.repeat(64)
    delete process.env.FORGE_ENCRYPTION_KEY
  })

  it('round-trips a secret and never stores it in cleartext', () => {
    const encoded = encryptSecret('sk-ant-secret-123')
    expect(encoded).not.toContain('sk-ant-secret-123')
    expect(encoded.startsWith('v1:')).toBe(true)
    expect(decryptSecret(encoded)).toBe('sk-ant-secret-123')
  })

  it('produces different ciphertext each time (random IV)', () => {
    expect(encryptSecret('same-input')).not.toBe(encryptSecret('same-input'))
  })

  it('rejects tampered ciphertext via the auth tag', () => {
    const encoded = encryptSecret('secret')
    const parts = encoded.split(':')
    const tampered = [
      parts[0],
      parts[1],
      parts[2],
      Buffer.from('tampered-data').toString('base64'),
    ].join(':')
    expect(() => decryptSecret(tampered)).toThrow()
  })

  it('rejects malformed input', () => {
    expect(() => decryptSecret('not-valid')).toThrow(/malformed/i)
  })

  it('throws when no secret is configured', () => {
    delete process.env.SESSION_SECRET
    delete process.env.FORGE_ENCRYPTION_KEY
    expect(() => encryptSecret('x')).toThrow(/SESSION_SECRET/)
  })
})
