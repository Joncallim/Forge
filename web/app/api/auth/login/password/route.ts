import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { db } from '@/db'
import { users } from '@/db/schema'
import { createSession, sessionCookieOptions } from '@/lib/session'
import { verifyPassword } from '@/lib/password'
import { redis } from '@/lib/redis'

// Passwords can be guessed online, unlike passkeys. Keep a short fixed-window
// throttle per client and globally so exposed installs are not unlimited.
const RATE_LIMIT_WINDOW_SECONDS = 900
const RATE_LIMIT_PER_IP = 10
const RATE_LIMIT_GLOBAL = 50

function clientIp(request: NextRequest): string {
  return (
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    request.headers.get('x-real-ip') ||
    'unknown'
  )
}

async function hitRateLimit(key: string): Promise<number> {
  const count = await redis.incr(key)
  if (count === 1) {
    await redis.expire(key, RATE_LIMIT_WINDOW_SECONDS)
  }
  return count
}

export async function POST(request: NextRequest) {
  try {
    const ip = clientIp(request)
    const ipKey = `ratelimit:login:password:ip:${ip}`
    const globalKey = 'ratelimit:login:password:global'

    const [ipCount, globalCount] = await Promise.all([
      hitRateLimit(ipKey),
      hitRateLimit(globalKey),
    ])

    if (ipCount > RATE_LIMIT_PER_IP || globalCount > RATE_LIMIT_GLOBAL) {
      return NextResponse.json(
        { error: 'Too many sign-in attempts. Please wait and try again.' },
        {
          status: 429,
          headers: { 'Retry-After': String(RATE_LIMIT_WINDOW_SECONDS) },
        },
      )
    }

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    if (
      !body ||
      typeof body !== 'object' ||
      !('password' in body) ||
      typeof (body as Record<string, unknown>).password !== 'string'
    ) {
      return NextResponse.json({ error: 'Password is required' }, { status: 400 })
    }

    const { password } = body as { password: string }

    // Forge currently has one user. If multi-user sign-in is added later, this
    // must look up the user by a stable identifier instead of taking the first row.
    const [user] = await db
      .select({
        id: users.id,
        displayName: users.displayName,
        passwordHash: users.passwordHash,
      })
      .from(users)
      .limit(1)

    const validPassword = await verifyPassword(password, user?.passwordHash)
    if (!user || !validPassword) {
      return NextResponse.json({ error: 'Invalid password' }, { status: 401 })
    }

    await Promise.all([redis.del(ipKey), redis.del(globalKey)]).catch(() => {})

    const userAgent = request.headers.get('user-agent')
    const sessionIp = ip === 'unknown' ? null : ip

    const sessionId = await createSession(user.id, null, { userAgent, ip: sessionIp })

    const cookieOpts = sessionCookieOptions()
    const response = NextResponse.json({ userId: user.id, displayName: user.displayName })
    response.cookies.set(cookieOpts.name, sessionId, {
      httpOnly: cookieOpts.httpOnly,
      secure: cookieOpts.secure,
      sameSite: cookieOpts.sameSite,
      maxAge: cookieOpts.maxAge,
      path: cookieOpts.path,
    })

    return response
  } catch (err) {
    console.error('[login/password] Unexpected error', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
