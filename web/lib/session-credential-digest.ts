import { createHash, timingSafeEqual } from 'node:crypto'
import { and, eq, sql } from 'drizzle-orm'
import { db } from '@/db'
import { sessions } from '@/db/schema'

export const SESSION_CREDENTIAL_DOMAIN_V1 = Buffer.from('forge:web-session:v1\0', 'utf8')

const DIGEST_ALGORITHM = 'sha256'

export type SessionCredentialDigest = {
  digestAlgorithm: typeof DIGEST_ALGORITHM
  digest: Buffer
  issuedAt: Date
}

export function isCanonicalSessionCredential(credential: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(credential)
}

export function computeCredentialDigest(credential: string): SessionCredentialDigest {
  if (!isCanonicalSessionCredential(credential)) {
    throw new Error('Session credential must be an exact lowercase UUIDv4')
  }
  const hash = createHash(DIGEST_ALGORITHM)
  hash.update(SESSION_CREDENTIAL_DOMAIN_V1)
  hash.update(Buffer.from(credential, 'ascii'))
  return {
    digestAlgorithm: DIGEST_ALGORITHM,
    digest: hash.digest(),
    issuedAt: new Date(),
  }
}

export function verifyCredentialDigest(record: {
  credentialDigest?: Buffer | null
}, credential: string): boolean {
  if (!record.credentialDigest) return false
  let expected: SessionCredentialDigest
  try {
    expected = computeCredentialDigest(credential)
  } catch {
    return false
  }
  return record.credentialDigest.length === expected.digest.length &&
    timingSafeEqual(record.credentialDigest, expected.digest)
}

export async function rekeySessionCredentialDigest(input: {
  credentialId: string
  sessionCredential: string
  userId: string
}): Promise<void> {
  const digest = computeCredentialDigest(input.sessionCredential).digest
  const [updated] = await db
    .update(sessions)
    .set({
      credentialId: input.credentialId as Sessions['credentialId'],
      lastSeenAt: sql`pg_catalog.clock_timestamp()`,
    })
    .where(and(
      eq(sessions.userId, input.userId),
      eq(sessions.credentialDigestV1, digest),
    ))
    .returning({ id: sessions.id })
  if (!updated) throw new Error('Session not found for credential rekey')
}

export async function invalidateSessionCredentialDigests(userId: string): Promise<number> {
  const result = await db
    .update(sessions)
    .set({
      revokedAt: sql`pg_catalog.clock_timestamp()`,
    })
    .where(eq(sessions.userId, userId))
    .returning({ id: sessions.id })
  return result.length
}

type Sessions = typeof sessions.$inferSelect
