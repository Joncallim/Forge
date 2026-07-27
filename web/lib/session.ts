import { db } from '@/db'
import { sessionCredentialReconciliation, sessions } from '@/db/schema'
import { and, eq, isNull, or, sql } from 'drizzle-orm'
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

function legacyRedisKey(credential: string): string {
  return `session:${credential}`
}

function dualWriteSessions(): boolean {
  const mode = process.env.FORGE_SESSION_CREDENTIAL_MODE?.trim() || 'strict'
  if (mode !== 'strict' && mode !== 'dual') {
    throw new Error('FORGE_SESSION_CREDENTIAL_MODE must be strict or dual')
  }
  return mode === 'dual'
}

function sessionIp(ip: string | null | undefined): string | null {
  if (!ip) return null
  return isIP(ip) === 0 ? null : ip
}

function parseDatabaseTimestamp(value: Date | string, field: string): Date {
  const timestamp = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(timestamp.getTime())) {
    throw new Error(`PostgreSQL returned an invalid ${field} session timestamp`)
  }
  return timestamp
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
  credentialStorageVersion: number
  writeLegacyCacheAfterCommit: boolean
}

type LegacyRedisAuthority = {
  expiresAt: Date
  lastSeenAt: Date
}

async function writeLegacySessionCache(
  credential: string,
  session: Pick<AuthorizedSession, 'userId' | 'lastSeenAt' | 'expiresAt'>,
): Promise<void> {
  await redis.set(
    legacyRedisKey(credential),
    JSON.stringify({
      userId: session.userId,
      credentialId: null,
      userAgent: null,
      ip: null,
      lastSeenAt: session.lastSeenAt.getTime(),
    }),
    'PXAT',
    session.expiresAt.getTime(),
  )
}

async function readLegacyRedisAuthority(
  credential: string,
  expectedUserId: string,
): Promise<LegacyRedisAuthority | null> {
  const result = await redis.eval(
    `local value = redis.call('GET', KEYS[1])
local expires = redis.call('PEXPIRETIME', KEYS[1])
local now = redis.call('TIME')
return {value or false, expires, now[1], now[2]}`,
    1,
    legacyRedisKey(credential),
  )
  if (!Array.isArray(result) || result.length !== 4 || typeof result[0] !== 'string') return null
  const expiresAtMs = Number(result[1])
  const redisNowMs = Number(result[2]) * 1000 + Math.floor(Number(result[3]) / 1000)
  if (!Number.isSafeInteger(expiresAtMs) || !Number.isSafeInteger(redisNowMs)
      || expiresAtMs <= redisNowMs) return null
  let payload: unknown
  try {
    payload = JSON.parse(result[0])
  } catch {
    return null
  }
  if (!payload || typeof payload !== 'object') return null
  const legacy = payload as { userId?: unknown; lastSeenAt?: unknown }
  if (legacy.userId !== expectedUserId
      || typeof legacy.lastSeenAt !== 'number'
      || !Number.isFinite(legacy.lastSeenAt)
      || legacy.lastSeenAt < 0
      || legacy.lastSeenAt > redisNowMs) return null
  return { expiresAt: new Date(expiresAtMs), lastSeenAt: new Date(legacy.lastSeenAt) }
}

async function authorizeSession(
  credential: string,
  digest: Buffer,
): Promise<AuthorizedSession | null> {
  return db.transaction(async (tx) => {
    // This lock makes the database decision and any sliding refresh atomic.
    // Redis remains a repairable cache and is written only after commit.
    const [reconciliation] = await tx
      .select({ state: sessionCredentialReconciliation.state })
      .from(sessionCredentialReconciliation)
      .where(eq(sessionCredentialReconciliation.singleton, true))
      .limit(1)
      .for('key share')
    if (!reconciliation) throw new Error('Session credential reconciliation authority is unavailable')

    const [row] = await tx
      .select({
        sessionId: sessions.id,
        userId: sessions.userId,
        lastSeenAt: sessions.lastSeenAt,
        expiresAt: sessions.expiresAt,
        revokedAt: sessions.revokedAt,
        credentialDigestV1: sessions.credentialDigestV1,
        credentialStorageVersion: sessions.credentialStorageVersion,
        databaseNow: sql<Date | string>`pg_catalog.clock_timestamp()`,
      })
      .from(sessions)
      .where(or(
        eq(sessions.credentialDigestV1, digest),
        and(
          eq(sessions.id, credential),
          eq(sessions.credentialStorageVersion, 0),
          isNull(sessions.credentialDigestV1),
        ),
      ))
      .limit(1)
      .for('update')

    if (!row || row.revokedAt) {
      return null
    }
    const databaseNow = parseDatabaseTimestamp(row.databaseNow, 'clock')
    let lastSeenAt = parseDatabaseTimestamp(row.lastSeenAt, 'last-seen')
    let liveExpiresAt = row.expiresAt
      ? parseDatabaseTimestamp(row.expiresAt, 'expiry')
      : null
    let storageVersion = row.credentialStorageVersion

    if (storageVersion === 0) {
      const legacy = await readLegacyRedisAuthority(credential, row.userId)
      if (!legacy) {
        await tx.update(sessions).set({
          revokedAt: sql`pg_catalog.clock_timestamp()`,
          legacyRedisPurgePendingAt: sql`pg_catalog.clock_timestamp()`,
        }).where(and(
          eq(sessions.id, row.sessionId),
          eq(sessions.credentialStorageVersion, 0),
        ))
        return null
      }
      const [backfilled] = await tx.update(sessions).set({
        credentialDigestV1: digest,
        credentialStorageVersion: 1,
        expiresAt: legacy.expiresAt,
        lastSeenAt: legacy.lastSeenAt,
      }).where(and(
        eq(sessions.id, row.sessionId),
        eq(sessions.credentialStorageVersion, 0),
        isNull(sessions.credentialDigestV1),
      )).returning({ id: sessions.id })
      if (!backfilled) throw new Error('Legacy session credential backfill lost its compare-and-set')
      lastSeenAt = legacy.lastSeenAt
      liveExpiresAt = legacy.expiresAt
      storageVersion = 1
    }

    if (!liveExpiresAt || databaseNow >= liveExpiresAt) {
      if (storageVersion < 2) {
        await tx.update(sessions).set({
          revokedAt: sql`COALESCE(${sessions.revokedAt}, pg_catalog.clock_timestamp())`,
          legacyRedisPurgePendingAt: sql`COALESCE(${sessions.legacyRedisPurgePendingAt}, pg_catalog.clock_timestamp())`,
        }).where(eq(sessions.id, row.sessionId))
      }
      return null
    }

    let authorized: AuthorizedSession
    if (databaseNow.getTime() - lastSeenAt.getTime() <= WRITE_BEHIND_INTERVAL_MS) {
      authorized = {
        sessionId: row.sessionId,
        userId: row.userId,
        lastSeenAt,
        expiresAt: liveExpiresAt,
        refreshed: false,
        credentialStorageVersion: storageVersion,
        writeLegacyCacheAfterCommit: storageVersion === 1 && reconciliation.state === 'expansion',
      }
    } else {
      const [refreshed] = await tx
        .update(sessions)
        .set({
          lastSeenAt: sql`pg_catalog.date_trunc('milliseconds', pg_catalog.clock_timestamp())`,
          expiresAt: sql`pg_catalog.date_trunc('milliseconds', pg_catalog.clock_timestamp() + interval '7 days')`,
        })
        .where(eq(sessions.id, row.sessionId))
        .returning({
          lastSeenAt: sessions.lastSeenAt,
          expiresAt: sessions.expiresAt,
        })

      if (!refreshed?.lastSeenAt || !refreshed.expiresAt) {
        throw new Error('Session refresh did not return authoritative timestamps')
      }
      authorized = {
        sessionId: row.sessionId,
        userId: row.userId,
        lastSeenAt: parseDatabaseTimestamp(refreshed.lastSeenAt, 'refreshed last-seen'),
        expiresAt: parseDatabaseTimestamp(refreshed.expiresAt, 'refreshed expiry'),
        refreshed: true,
        credentialStorageVersion: storageVersion,
        writeLegacyCacheAfterCommit: storageVersion === 1 && reconciliation.state === 'expansion',
      }
    }
    return authorized
  })
}

async function cacheAuthorizedSession(
  digest: Buffer,
  session: AuthorizedSession,
): Promise<void> {
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
    authorized = await authorizeSession(credential, digest)
  } catch (error) {
    console.error('Database-authoritative session check failed:', error)
    return null
  }

  if (!authorized) {
    await redis.del(redisKey(digest), legacyRedisKey(credential)).catch(() => {})
    return null
  }

  // Redis is a repairable cache only. Failure never turns a database-valid
  // session into an authorization failure and never extends database expiry.
  if (authorized.writeLegacyCacheAfterCommit) {
    await writeLegacySessionCache(credential, authorized).catch(() => {})
  }
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
  const dualWriteRequested = dualWriteSessions()

  const { created, dualWrite } = await db.transaction(async (tx) => {
    const [reconciliation] = await tx
      .select({ state: sessionCredentialReconciliation.state })
      .from(sessionCredentialReconciliation)
      .where(eq(sessionCredentialReconciliation.singleton, true))
      .limit(1)
      .for('key share')
    if (!reconciliation) throw new Error('Session credential reconciliation authority is unavailable')
    const dualWrite = dualWriteRequested && reconciliation.state === 'expansion'
    const [created] = await tx
      .insert(sessions)
      .values({
        id: dualWrite ? credential : crypto.randomUUID(),
        userId,
        credentialId: credentialId ?? undefined,
        credentialDigestV1: digest,
        credentialStorageVersion: dualWrite ? 1 : 2,
        createdAt: sql`pg_catalog.clock_timestamp()`,
        lastSeenAt: sql`pg_catalog.clock_timestamp()`,
        expiresAt: sql`pg_catalog.date_trunc('milliseconds', pg_catalog.clock_timestamp() + interval '7 days')`,
        userAgent: meta.userAgent ?? undefined,
        ipAddress: ip ?? undefined,
      })
      .returning({
        sessionId: sessions.id,
        lastSeenAt: sessions.lastSeenAt,
        expiresAt: sessions.expiresAt,
      })
    return { created, dualWrite }
  })

  if (!created?.expiresAt) throw new Error('Session creation did not return an expiry')
  if (dualWrite) {
    await writeLegacySessionCache(credential, {
      userId,
      lastSeenAt: created.lastSeenAt,
      expiresAt: created.expiresAt,
    }).catch(() => {})
  }
  await cacheAuthorizedSession(digest, {
    sessionId: created.sessionId,
    userId,
    lastSeenAt: created.lastSeenAt,
    expiresAt: created.expiresAt,
    refreshed: true,
    credentialStorageVersion: dualWrite ? 1 : 2,
    writeLegacyCacheAfterCommit: false,
  }).catch(() => {})

  return credential
}

export async function destroySession(sessionCredential: string): Promise<void> {
  if (!isCanonicalSessionCredential(sessionCredential)) return
  const digest = computeCredentialDigest(sessionCredential).digest

  // PostgreSQL revocation is authoritative and commits before cache deletion.
  await db
    .update(sessions)
    .set({
      revokedAt: sql`pg_catalog.clock_timestamp()`,
      legacyRedisPurgePendingAt: sql`CASE
        WHEN ${sessions.credentialStorageVersion} < 2
          THEN pg_catalog.clock_timestamp()
        ELSE ${sessions.legacyRedisPurgePendingAt}
      END`,
    })
    .where(or(
      eq(sessions.credentialDigestV1, digest),
      eq(sessions.id, sessionCredential),
    ))

  await redis.del(redisKey(digest), legacyRedisKey(sessionCredential))
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
