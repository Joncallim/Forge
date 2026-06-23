import { db } from '@/db'
import { sessions, users } from '@/db/schema'
import { eq } from 'drizzle-orm'
import { redis } from '@/lib/redis'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SessionData = {
  userId: string
  credentialId: string | null
  userAgent: string | null
  ip: string | null
  lastSeenAt: number // unix ms, stored in Redis for write-behind logic
}

export type CookieOptions = {
  name: string
  httpOnly: boolean
  secure: boolean
  sameSite: 'strict'
  maxAge: number
  path: string
}

type SessionMeta = {
  userAgent?: string | null
  ip?: string | null
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7 // 7 days
const WRITE_BEHIND_INTERVAL_MS = 60 * 1000 // 60 seconds

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function redisKey(sessionId: string): string {
  return `session:${sessionId}`
}

// ---------------------------------------------------------------------------
// getSession
// ---------------------------------------------------------------------------

export async function getSession(
  request: Request,
): Promise<{ sessionId: string; userId: string } | null> {
  // Parse forge_session cookie from request headers
  const cookieHeader = request.headers.get('cookie') ?? ''
  const cookies = Object.fromEntries(
    cookieHeader
      .split(';')
      .map((c) => c.trim())
      .filter(Boolean)
      .map((c) => {
        const idx = c.indexOf('=')
        if (idx === -1) return [c, '']
        return [c.slice(0, idx).trim(), c.slice(idx + 1).trim()]
      }),
  )

  const sessionId = cookies['forge_session']
  if (!sessionId) return null

  const raw = await redis.get(redisKey(sessionId))
  if (!raw) return null

  let data: SessionData
  try {
    data = JSON.parse(raw) as SessionData
  } catch {
    return null
  }

  // The Postgres users row may have been deleted (DB reset, fresh install with
  // a surviving Redis volume, etc.) while the Redis session entry outlives it.
  // Re-validate on every call so a dead userId never reaches callers.
  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, data.userId))
    .limit(1)

  if (!user) {
    await redis.del(redisKey(sessionId)).catch(() => {})
    return null
  }

  // Write-behind: update lastSeenAt in DB if the stored timestamp is >60s old
  const now = Date.now()
  if (now - (data.lastSeenAt ?? 0) > WRITE_BEHIND_INTERVAL_MS) {
    // Update Redis timestamp first (fire-and-forget the DB write)
    const updated: SessionData = { ...data, lastSeenAt: now }
    // Allow failure silently — do not await
    redis
      .set(redisKey(sessionId), JSON.stringify(updated), 'EX', SESSION_TTL_SECONDS)
      .catch(() => {})

    // Fire-and-forget DB write
    void db.update(sessions).set({ lastSeenAt: new Date() }).where(eq(sessions.id, sessionId)).execute().catch((err: unknown) => {
      console.error('Session write-behind failed:', err)
    })
  }

  return { sessionId, userId: data.userId }
}

// ---------------------------------------------------------------------------
// createSession
// ---------------------------------------------------------------------------

export async function createSession(
  userId: string,
  credentialId: string | null,
  meta: SessionMeta,
): Promise<string> {
  const sessionId = crypto.randomUUID()
  const now = Date.now()

  const data: SessionData = {
    userId,
    credentialId,
    userAgent: meta.userAgent ?? null,
    ip: meta.ip ?? null,
    lastSeenAt: now,
  }

  // Write to Redis with 7-day TTL
  await redis.set(redisKey(sessionId), JSON.stringify(data), 'EX', SESSION_TTL_SECONDS)

  // Insert audit row into PostgreSQL
  await db.insert(sessions).values({
    id: sessionId,
    userId,
    credentialId: credentialId ?? undefined,
    userAgent: meta.userAgent ?? undefined,
    ipAddress: meta.ip ?? undefined,
  })

  return sessionId
}

// ---------------------------------------------------------------------------
// destroySession
// ---------------------------------------------------------------------------

export async function destroySession(sessionId: string): Promise<void> {
  // Delete from Redis immediately
  await redis.del(redisKey(sessionId))

  // Mark revoked in PostgreSQL
  await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(eq(sessions.id, sessionId))
}

// ---------------------------------------------------------------------------
// sessionCookieOptions
// ---------------------------------------------------------------------------

export function sessionCookieOptions(): CookieOptions {
  return {
    name: 'forge_session',
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: 60 * 60 * 24 * 7,
    path: '/',
  }
}
