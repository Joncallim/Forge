import { db } from '@/db'
import { sessions } from '@/db/schema'
import { eq, sql } from 'drizzle-orm'
import { redis } from '@/lib/redis'
import { isIP } from 'node:net'
import {
  computeCredentialDigest,
  isCanonicalSessionCredential,
} from '@/lib/session-credential-digest'

export type SessionData = {
  userId: string
  expiresAt: number
  lastSeenAt: number
}

export type CookieOptions = {
  name: string
  httpOnly: boolean
  secure: boolean
  sameSite: 'strict'
  maxAge: number
  path: '/'
}

type SessionMeta = {
  userAgent?: string | null
  ip?: string | null
}

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7
const SESSION_TTL_MS = SESSION_TTL_SECONDS * 1000
const WRITE_BEHIND_INTERVAL_MS = 60 * 1000

function redisKey(digest: Buffer): string {
  return `session:v2:${digest.toString('hex')}`
}

function sessionIp(ip: string | null | undefined): string | null {
  if (!ip) return null
  return isIP(ip) === 0 ? null : ip
}

export function readSessionCredential(request: Request): string | null {
  const cookieHeader = request.headers.get('cookie') ?? ''
  for (const cookie of cookieHeader.split(';')) {
    const segment = cookie.trimStart()
    const separator = segment.indexOf('=')
    if (separator === -1 || segment.slice(0, separator).trim() !== 'forge_session') continue
    const credential = segment.slice(separator + 1)
    return isCanonicalSessionCredential(credential) ? credential : null
  }
  return null
}

type AuthorizedSession = {
  sessionId: string
  userId: string
  lastSeenAt: Date
  expiresAt: Date
  refreshed: boolean
}

async function authorizeSession(digest: Buffer): Promise<AuthorizedSession | null> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({
        sessionId: sessions.id,
        userId: sessions.userId,
        lastSeenAt: sessions.lastSeenAt,
        expiresAt: sessions.expiresAt,
        revokedAt: sessions.revokedAt,
        databaseNow: sql<Date>`pg_catalog.clock_timestamp()`,
      })
      .from(sessions)
      .where(eq(sessions.credentialDigestV1, digest))
      .limit(1)
      .for('update')

    if (!row || row.revokedAt || !row.expiresAt || row.databaseNow >= row.expiresAt) {
      return null
    }
    const liveExpiresAt = row.expiresAt

    if (row.databaseNow.getTime() - row.lastSeenAt.getTime() <= WRITE_BEHIND_INTERVAL_MS) {
      return { ...row, expiresAt: liveExpiresAt, refreshed: false }
    }

    const [refreshed] = await tx
      .update(sessions)
      .set({
        lastSeenAt: sql`pg_catalog.clock_timestamp()`,
        expiresAt: sql`pg_catalog.clock_timestamp() + interval '7 days'`,
      })
      .where(eq(sessions.id, row.sessionId))
      .returning({
        lastSeenAt: sessions.lastSeenAt,
        expiresAt: sessions.expiresAt,
      })

    if (!refreshed.expiresAt) throw new Error('Session refresh did not return an expiry')
    return { ...row, ...refreshed, expiresAt: refreshed.expiresAt, refreshed: true }
  })
}

async function cacheAuthorizedSession(digest: Buffer, session: AuthorizedSession): Promise<void> {
  const cache: SessionData = {
    userId: session.userId,
    expiresAt: session.expiresAt.getTime(),
    lastSeenAt: session.lastSeenAt.getTime(),
  }
  await redis.set(
    redisKey(digest),
    JSON.stringify(cache),
    'PXAT',
    session.expiresAt.getTime(),
  )
}

export async function getSession(
  request: Request,
): Promise<{ sessionId: string; userId: string } | null> {
  const credential = readSessionCredential(request)
  if (!credential) return null
  const digest = computeCredentialDigest(credential).digest

  let authorized: AuthorizedSession | null
  try {
    authorized = await authorizeSession(digest)
  } catch (error) {
    console.error('Database-authoritative session check failed:', error)
    return null
  }

  if (!authorized) {
    await redis.del(redisKey(digest)).catch(() => {})
    return null
  }

  // Redis is a repairable cache only. Failure never turns a database-valid
  // session into an authorization failure and never extends database expiry.
  await cacheAuthorizedSession(digest, authorized).catch(() => {})
  return { sessionId: authorized.sessionId, userId: authorized.userId }
}

export async function createSession(
  userId: string,
  credentialId: string | null,
  meta: SessionMeta,
): Promise<string> {
  const credential = crypto.randomUUID()
  const digest = computeCredentialDigest(credential).digest
  const ip = sessionIp(meta.ip)

  const [created] = await db
    .insert(sessions)
    .values({
      id: crypto.randomUUID(),
      userId,
      credentialId: credentialId ?? undefined,
      credentialDigestV1: digest,
      createdAt: sql`pg_catalog.clock_timestamp()`,
      lastSeenAt: sql`pg_catalog.clock_timestamp()`,
      expiresAt: sql`pg_catalog.clock_timestamp() + interval '7 days'`,
      userAgent: meta.userAgent ?? undefined,
      ipAddress: ip ?? undefined,
    })
    .returning({
      sessionId: sessions.id,
      lastSeenAt: sessions.lastSeenAt,
      expiresAt: sessions.expiresAt,
    })

  if (!created?.expiresAt) throw new Error('Session creation did not return an expiry')
  await cacheAuthorizedSession(digest, {
    sessionId: created.sessionId,
    userId,
    lastSeenAt: created.lastSeenAt,
    expiresAt: created.expiresAt,
    refreshed: true,
  }).catch(() => {})

  return credential
}

export async function destroySession(sessionCredential: string): Promise<void> {
  if (!isCanonicalSessionCredential(sessionCredential)) return
  const digest = computeCredentialDigest(sessionCredential).digest

  // PostgreSQL revocation is authoritative and commits before cache deletion.
  await db
    .update(sessions)
    .set({ revokedAt: sql`pg_catalog.clock_timestamp()` })
    .where(eq(sessions.credentialDigestV1, digest))

  await redis.del(redisKey(digest)).catch(() => {})
}

export function sessionCookieOptions(): CookieOptions {
  return {
    name: 'forge_session',
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: SESSION_TTL_MS / 1000,
    path: '/',
  }
}
