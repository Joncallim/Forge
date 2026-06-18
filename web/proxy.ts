import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

export function proxy(request: NextRequest) {
  const sessionId = request.cookies.get('forge_session')?.value

  if (sessionId) {
    // Cookie is present; route handlers verify actual session validity.
    return NextResponse.next()
  }

  const acceptHeader = request.headers.get('accept') ?? ''
  const isHtmlRequest = acceptHeader.includes('text/html')

  if (isHtmlRequest) {
    const loginUrl = new URL('/login', request.url)
    return NextResponse.redirect(loginUrl)
  }

  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
}

export const config = {
  matcher: ['/dashboard/:path*', '/api/((?!auth|health).*)'],
}
