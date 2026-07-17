import { createHash, timingSafeEqual } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { sessions } from '@/db/schema'

const CREDENTIAL_DIGEST_DOMAIN = Buffer.from('forge:session-credential-digest:v1\0')

const DIGEST_ALGORITHM = 'sha256'

export type SessionCredentialDigest = {
  digestAlgorithm: typeof DIGEST_ALGORITHM
  digest: Buffer
  issuedAt: Date
}

export function computeCredentialDigest(input: {
  credentialId: string
  sessionId: string
  userId: string
}): SessionCredentialDigest {
  const hmac = createHash(DIGEST_ALGORITHM)
  hmac.update(CREDENTIAL_DIGEST_DOMAIN)
  const payload = `${input.sessionId}\0${input.userId}\0${input.credentialId}`
  hmac.update(payload)
  return {
    digestAlgorithm: DIGEST_ALGORITHM,
    digest: hmac.digest(),
    issuedAt: new Date(),
  }
}

export function verifyCredentialDigest(record: {
  credentialDigest?: Buffer | null
}, input: {
  credentialId: string
  sessionId: string
  userId: string
}): boolean {
  if (!record.credentialDigest) return false
  const expected = computeCredentialDigest(input)
  return record.credentialDigest.length === expected.digest.length &&
    timingSafeEqual(record.credentialDigest, expected.digest)
}

export async function rekeySessionCredentialDigest(input: {
  credentialId: string
  sessionId: string
  userId: string
}): Promise<void> {
  computeCredentialDigest(input)
  const [updated] = await db
    .update(sessions)
    .set({
      credentialId: input.credentialId as Sessions['credentialId'],
      lastSeenAt: new Date(),
    })
    .where(eq(sessions.id, input.sessionId))
    .returning({ id: sessions.id })
  if (!updated) throw new Error(`Session ${input.sessionId} not found for credential rekey`)
}

export async function invalidateSessionCredentialDigests(userId: string): Promise<number> {
  const result = await db
    .update(sessions)
    .set({
      revokedAt: new Date(),
    })
    .where(eq(sessions.userId, userId))
    .returning({ id: sessions.id })
  return result.length
}

type Sessions = typeof sessions.$inferSelect
