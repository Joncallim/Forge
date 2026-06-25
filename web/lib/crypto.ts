import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'
import { unsafeRuntimeSecretReason } from '@/lib/env'

/**
 * Symmetric encryption for secrets at rest (provider API keys).
 *
 * Keys are entered in the web UI and stored encrypted in the database so the
 * user never pastes them into `.env`. We use AES-256-GCM (authenticated) with a
 * random IV per value. The encoded form is:
 *
 *   v1:<iv-b64>:<authtag-b64>:<ciphertext-b64>
 *
 * The encryption key is derived from `FORGE_ENCRYPTION_KEY` if set, otherwise
 * from `SESSION_SECRET` (which the installer already generates). A fixed salt
 * is acceptable because the input secret is high-entropy and unique per install.
 */
const ALGORITHM = 'aes-256-gcm'
const VERSION = 'v1'
const SALT = 'forge.provider.secret.v1'

function getKey(): Buffer {
  const secretName = process.env.FORGE_ENCRYPTION_KEY ? 'FORGE_ENCRYPTION_KEY' : 'SESSION_SECRET'
  const secret = process.env.FORGE_ENCRYPTION_KEY ?? process.env.SESSION_SECRET
  if (!secret || secret.trim() === '') {
    throw new Error(
      '[crypto] FORGE_ENCRYPTION_KEY or SESSION_SECRET must be set to encrypt/decrypt stored secrets',
    )
  }
  const unsafeSecretReason = unsafeRuntimeSecretReason(secretName, secret)
  if (unsafeSecretReason) {
    throw new Error(`[crypto] ${unsafeSecretReason}.`)
  }
  return scryptSync(secret, SALT, 32)
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv(ALGORITHM, getKey(), iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()
  return [
    VERSION,
    iv.toString('base64'),
    authTag.toString('base64'),
    ciphertext.toString('base64'),
  ].join(':')
}

export function decryptSecret(encoded: string): string {
  const parts = encoded.split(':')
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error('[crypto] malformed or unsupported ciphertext')
  }
  const [, ivB64, tagB64, dataB64] = parts
  const decipher = createDecipheriv(ALGORITHM, getKey(), Buffer.from(ivB64, 'base64'))
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'))
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64')),
    decipher.final(),
  ])
  return plaintext.toString('utf8')
}
