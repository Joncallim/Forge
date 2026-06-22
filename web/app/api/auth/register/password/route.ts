import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { count } from 'drizzle-orm'
import { db } from '@/db'
import { users } from '@/db/schema'
import { redis } from '@/lib/redis'
import { createSession, sessionCookieOptions } from '@/lib/session'
import { hashPassword, validatePassword } from '@/lib/password'
import { passkeysEnabled } from '@/lib/auth-options'

function displayNameError(displayName: unknown): string | null {
  if (typeof displayName !== 'string') return 'displayName must be a non-empty string'
  if (displayName.trim().length === 0 || displayName.length > 100) {
    return 'displayName must be between 1 and 100 characters'
  }
  return null
}

export async function POST(request: NextRequest) {
  let registrationLock: { key: string; token: string } | null = null

  try {
    if (passkeysEnabled()) {
      return NextResponse.json(
        { error: 'Password-only registration is disabled' },
        { status: 404 },
      )
    }

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const data = body as Record<string, unknown>
    const nameError = displayNameError(data.displayName)
    if (nameError) {
      return NextResponse.json({ error: nameError }, { status: 400 })
    }

    if (typeof data.password !== 'string') {
      return NextResponse.json({ error: 'Password is required' }, { status: 400 })
    }

    const passwordError = validatePassword(data.password)
    if (passwordError) {
      return NextResponse.json({ error: passwordError }, { status: 400 })
    }

    const lockKey = 'webauthn:registration:first-user-lock'
    const lockToken = crypto.randomUUID()
    const lockResult = await redis.set(lockKey, lockToken, 'EX', 30, 'NX')
    if (lockResult !== 'OK') {
      return NextResponse.json({ error: 'Registration closed' }, { status: 409 })
    }
    registrationLock = { key: lockKey, token: lockToken }

    const [{ value: userCount }] = await db.select({ value: count() }).from(users)
    if (userCount > 0) {
      return NextResponse.json({ error: 'Registration closed' }, { status: 409 })
    }

    const displayName = String(data.displayName).trim()
    const passwordHash = await hashPassword(data.password)
    const [newUser] = await db
      .insert(users)
      .values({ displayName, passwordHash })
      .returning({ id: users.id })

    const userAgent = request.headers.get('user-agent')
    const ip =
      request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
      request.headers.get('x-real-ip') ??
      null

    const sessionId = await createSession(newUser.id, null, { userAgent, ip })

    const cookieOpts = sessionCookieOptions()
    const response = NextResponse.json({ userId: newUser.id, displayName })
    response.cookies.set(cookieOpts.name, sessionId, {
      httpOnly: cookieOpts.httpOnly,
      secure: cookieOpts.secure,
      sameSite: cookieOpts.sameSite,
      maxAge: cookieOpts.maxAge,
      path: cookieOpts.path,
    })

    return response
  } catch (err) {
    console.error('[register/password] Unexpected error', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  } finally {
    if (registrationLock) {
      try {
        const currentToken = await redis.get(registrationLock.key)
        if (currentToken === registrationLock.token) {
          await redis.del(registrationLock.key)
        }
      } catch (err) {
        console.error('[register/password] Failed to release registration lock', err)
      }
    }
  }
}
