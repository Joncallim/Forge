import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { verifyAuthenticationResponse } from '@simplewebauthn/server'
import { isoBase64URL } from '@simplewebauthn/server/helpers'
import type { AuthenticationResponseJSON, AuthenticatorTransportFuture } from '@simplewebauthn/server'
import { db } from '@/db'
import { credentials, users } from '@/db/schema'
import { redis } from '@/lib/redis'
import { createSession, sessionCookieOptions } from '@/lib/session'
import { eq } from 'drizzle-orm'
import { passkeysEnabled } from '@/lib/auth-options'

export async function POST(request: NextRequest) {
  try {
    if (!passkeysEnabled()) {
      return NextResponse.json({ error: 'Passkeys are disabled' }, { status: 404 })
    }

    // Parse request body
    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    if (
      !body ||
      typeof body !== 'object' ||
      !('nonce' in body) ||
      !('credential' in body) ||
      typeof (body as Record<string, unknown>).nonce !== 'string'
    ) {
      return NextResponse.json({ error: 'Missing nonce or credential in body' }, { status: 400 })
    }

    const { nonce, credential } = body as { nonce: string; credential: AuthenticationResponseJSON }

    // Fetch and atomically consume challenge from Redis (prevents replay attacks)
    const challengeKey = `webauthn:challenge:auth:${nonce}`
    const storedChallenge = await redis.getdel(challengeKey)
    if (!storedChallenge) {
      return NextResponse.json({ error: 'Challenge expired or not found' }, { status: 400 })
    }

    // Look up credential by credentialId (base64url-encoded)
    // credential.id is the canonical base64url credential ID from the browser JSON
    // Use isoBase64URL to normalize (strip padding, ensure consistent encoding)
    const credentialIdB64 = isoBase64URL.fromBuffer(isoBase64URL.toBuffer(credential.id))

    const [storedCredential] = await db
      .select()
      .from(credentials)
      .where(eq(credentials.credentialId, credentialIdB64))
      .limit(1)

    if (!storedCredential) {
      return NextResponse.json({ error: 'Credential not found' }, { status: 404 })
    }

    // Fetch the user
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.id, storedCredential.userId))
      .limit(1)

    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    // Verify the authentication response
    let verification: Awaited<ReturnType<typeof verifyAuthenticationResponse>>
    try {
      verification = await verifyAuthenticationResponse({
        response: credential,
        expectedChallenge: storedChallenge,
        expectedOrigin: process.env.WEBAUTHN_ORIGIN!,
        expectedRPID: process.env.WEBAUTHN_RP_ID!,
        requireUserVerification: true,
        credential: {
          id: storedCredential.credentialId,
          publicKey: storedCredential.publicKey as unknown as Uint8Array<ArrayBuffer>,
          counter: storedCredential.counter,
          transports: (storedCredential.transports as AuthenticatorTransportFuture[] | null) ?? undefined,
        },
      })
    } catch (err) {
      console.error('[login/finish] verifyAuthenticationResponse error', err)
      return NextResponse.json({ error: 'Authentication verification failed' }, { status: 400 })
    }

    if (!verification.verified) {
      return NextResponse.json({ error: 'Authentication not verified' }, { status: 400 })
    }

    const { authenticationInfo } = verification

    // Clone detection: counter regression means possible cloned credential
    if (authenticationInfo.newCounter <= storedCredential.counter && storedCredential.counter > 0) {
      console.error(
        '[login/finish] Credential counter regression — possible clone detected',
        {
          credentialId: storedCredential.credentialId,
          storedCounter: storedCredential.counter,
          newCounter: authenticationInfo.newCounter,
          userId: user.id,
        },
      )
      return NextResponse.json(
        { error: 'Credential counter regression — possible clone detected' },
        { status: 403 },
      )
    }

    // Update credential counter and lastUsedAt
    await db
      .update(credentials)
      .set({ counter: authenticationInfo.newCounter, lastUsedAt: new Date() })
      .where(eq(credentials.id, storedCredential.id))

    // Extract request metadata
    const userAgent = request.headers.get('user-agent')
    const ip =
      request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
      request.headers.get('x-real-ip') ??
      null

    // Create session
    const sessionId = await createSession(user.id, storedCredential.id, { userAgent, ip })

    // Set session cookie and return user info
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
    console.error('[login/finish] Unexpected error', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
