import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { db } from '@/db'
import { users } from '@/db/schema'
import { createSession, sessionCookieOptions } from '@/lib/session'
import { verifyPassword } from '@/lib/password'

export async function POST(request: NextRequest) {
  try {
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

    const userAgent = request.headers.get('user-agent')
    const ip =
      request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
      request.headers.get('x-real-ip') ??
      null

    const sessionId = await createSession(user.id, null, { userAgent, ip })

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
