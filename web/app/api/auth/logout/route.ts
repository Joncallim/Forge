import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { destroySession, sessionCookieOptions } from '@/lib/session'

export async function POST(request: NextRequest) {
  try {
    const sessionId = request.cookies.get('forge_session')?.value

    if (!sessionId) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    await destroySession(sessionId)

    // Clear the session cookie
    const cookieOpts = sessionCookieOptions()
    const response = NextResponse.json({ ok: true })
    response.cookies.set(cookieOpts.name, '', {
      httpOnly: cookieOpts.httpOnly,
      secure: cookieOpts.secure,
      sameSite: cookieOpts.sameSite,
      maxAge: 0,
      path: cookieOpts.path,
    })

    return response
  } catch (err) {
    console.error('[logout] Unexpected error', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
