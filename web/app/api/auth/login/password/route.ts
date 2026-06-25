import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { db } from '@/db'
import { users } from '@/db/schema'
import { createSession, sessionCookieOptions } from '@/lib/session'
import { verifyPassword } from '@/lib/password'
import { redis } from '@/lib/redis'
import {
  PASSWORD_LOGIN_RATE_LIMIT_GLOBAL,
  PASSWORD_LOGIN_RATE_LIMIT_PER_IP,
  PASSWORD_LOGIN_RATE_LIMIT_WINDOW_SECONDS,
  hitPasswordLoginRateLimit,
  passwordLoginRateLimitKeys,
} from '@/lib/auth-rate-limit'

// Passwords can be guessed online, unlike passkeys. Keep a short fixed-window
// throttle per client and globally so exposed installs are not unlimited.
function clientIp(request: NextRequest): string {
  if (process.env.FORGE_TRUST_PROXY === '1') {
    return (
      request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
      request.headers.get('x-real-ip') ||
      'unknown'
    )
  }

  // Next.js Request does not expose the direct socket address in this runtime.
  // Without an explicit trusted proxy boundary, keep all direct attempts in one
  // bucket so clients cannot choose arbitrary rate-limit keys via headers.
  return 'direct'
}

export async function POST(request: NextRequest) {
  try {
    const ip = clientIp(request)
    const { ipKey, globalKey } = passwordLoginRateLimitKeys(ip)

    const [ipCount, globalCount] = await Promise.all([
      hitPasswordLoginRateLimit(ipKey),
      hitPasswordLoginRateLimit(globalKey),
    ])

    if (
      ipCount > PASSWORD_LOGIN_RATE_LIMIT_PER_IP ||
      globalCount > PASSWORD_LOGIN_RATE_LIMIT_GLOBAL
    ) {
      return NextResponse.json(
        { error: 'Too many sign-in attempts. Please wait and try again.' },
        {
          status: 429,
          headers: { 'Retry-After': String(PASSWORD_LOGIN_RATE_LIMIT_WINDOW_SECONDS) },
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
