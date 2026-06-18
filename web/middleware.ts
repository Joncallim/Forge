import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

export function middleware(request: NextRequest) {
  const sessionId = request.cookies.get('forge_session')?.value

  if (sessionId) {
    // Cookie is present — let the route handler verify actual session validity
    return NextResponse.next()
  }

  // No session cookie — determine response type
  const acceptHeader = request.headers.get('accept') ?? ''
  const isHtmlRequest = acceptHeader.includes('text/html')

  if (isHtmlRequest) {
    // Browser navigation: redirect to login page
    const loginUrl = new URL('/login', request.url)
    return NextResponse.redirect(loginUrl)
  }

  // API request: return 401 JSON
  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
}

export const config = {
  matcher: ['/dashboard/:path*', '/api/((?!auth|health).*)'],
}
