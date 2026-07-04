import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { verifyRegistrationResponse } from '@simplewebauthn/server'
import type { AuthenticatorTransportFuture, RegistrationResponseJSON } from '@simplewebauthn/server'
import { db } from '@/db'
import { users, credentials } from '@/db/schema'
import { redis } from '@/lib/redis'
import { createSession, sessionCookieOptions } from '@/lib/session'
import { hashPassword, validatePassword } from '@/lib/password'
import { count } from 'drizzle-orm'
import { passkeysEnabled } from '@/lib/auth-options'
import { claimLegacyOwnership } from '@/lib/bootstrap-ownership'

export async function POST(request: NextRequest) {
  let registrationLock: { key: string; token: string } | null = null

  // Always clear reg_nonce cookie on exit (success or failure)
  const clearNonce = (response: NextResponse): NextResponse => {
    response.cookies.set('reg_nonce', '', {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 0,
      path: '/',
    })
    return response
  }

  try {
    if (!passkeysEnabled()) {
      return clearNonce(NextResponse.json({ error: 'Passkeys are disabled' }, { status: 404 }))
    }

    // Read reg_nonce cookie
    const tempUserId = request.cookies.get('reg_nonce')?.value
    if (!tempUserId) {
      return clearNonce(
        NextResponse.json({ error: 'Missing registration nonce' }, { status: 400 }),
      )
    }

    // Parse request body
    let body: unknown
    try {
      body = await request.json()
    } catch {
      return clearNonce(NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }))
    }

    if (
      !body ||
      typeof body !== 'object' ||
      !('credential' in body) ||
      !('password' in body) ||
      typeof (body as Record<string, unknown>).password !== 'string'
    ) {
      return clearNonce(
        NextResponse.json({ error: 'Missing credential or password in body' }, { status: 400 }),
      )
    }

    const { credential, password } = body as {
      credential: RegistrationResponseJSON
      password: string
    }

    const passwordError = validatePassword(password)
    if (passwordError) {
      return clearNonce(NextResponse.json({ error: passwordError }, { status: 400 }))
    }

    // Fetch and atomically consume challenge from Redis (prevents replay attacks)
    const redisKey = `webauthn:challenge:reg:${tempUserId}`
    const raw = await redis.getdel(redisKey)
    if (!raw) {
      return clearNonce(
        NextResponse.json({ error: 'Challenge expired or not found' }, { status: 400 }),
      )
    }

    let stored: { challenge: string; displayName: string }
    try {
      stored = JSON.parse(raw) as { challenge: string; displayName: string }
    } catch {
      return clearNonce(NextResponse.json({ error: 'Invalid challenge data' }, { status: 400 }))
    }

    // Verify the registration response
    let verification: Awaited<ReturnType<typeof verifyRegistrationResponse>>
    try {
      verification = await verifyRegistrationResponse({
        response: credential,
        expectedChallenge: stored.challenge,
        expectedOrigin: process.env.WEBAUTHN_ORIGIN!,
        expectedRPID: process.env.WEBAUTHN_RP_ID!,
        requireUserVerification: true,
      })
    } catch (err) {
      console.error('[register/finish] verifyRegistrationResponse error', err)
      return clearNonce(
        NextResponse.json({ error: 'Registration verification failed' }, { status: 400 }),
      )
    }

    if (!verification.verified || !verification.registrationInfo) {
      return clearNonce(
        NextResponse.json({ error: 'Registration not verified' }, { status: 400 }),
      )
    }

    const { registrationInfo } = verification
    // In @simplewebauthn/server v13, registrationInfo.credential is the WebAuthnCredential object
    const { credential: webAuthnCredential, aaguid, credentialDeviceType, credentialBackedUp } = registrationInfo

    const transports: AuthenticatorTransportFuture[] =
      (credential.response.transports as AuthenticatorTransportFuture[] | undefined) ?? []

    const passwordHash = await hashPassword(password)

    // Persist in a transaction
    let userId: string
    let credentialId: string

    const lockKey = 'webauthn:registration:first-user-lock'
    const lockToken = crypto.randomUUID()
    const lockResult = await redis.set(lockKey, lockToken, 'EX', 30, 'NX')
    if (lockResult !== 'OK') {
      return clearNonce(NextResponse.json({ error: 'Registration closed' }, { status: 409 }))
    }
    registrationLock = { key: lockKey, token: lockToken }

    await db.transaction(async (tx) => {
      // Atomically gate: if any user already exists, reject (prevents concurrent first-registration race)
      const [{ value: userCount }] = await tx.select({ value: count() }).from(users)
      if (userCount > 0) {
        throw Object.assign(new Error('Registration closed'), { status: 409 })
      }

      // Insert user
      const [newUser] = await tx
        .insert(users)
        .values({ displayName: stored.displayName, passwordHash })
        .returning({ id: users.id })
      userId = newUser.id
      await claimLegacyOwnership(tx, userId)

      // Insert credential — credentialId is already a Base64URL string in v13
      const [newCred] = await tx
        .insert(credentials)
        .values({
          userId,
          credentialId: webAuthnCredential.id,
          publicKey: Buffer.from(webAuthnCredential.publicKey),
          counter: webAuthnCredential.counter,
          deviceType: credentialDeviceType,
          backedUp: credentialBackedUp,
          transports,
          aaguid,
        })
        .returning({ id: credentials.id })
      credentialId = newCred.id
    })

    // Extract request metadata
    const userAgent = request.headers.get('user-agent')
    const ip =
      request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
      request.headers.get('x-real-ip') ??
      null

    // Create session
    const sessionId = await createSession(userId!, credentialId!, { userAgent, ip })

    // Build response
    const cookieOpts = sessionCookieOptions()
    const response = NextResponse.json({ userId: userId!, displayName: stored.displayName })
    response.cookies.set(cookieOpts.name, sessionId, {
      httpOnly: cookieOpts.httpOnly,
      secure: cookieOpts.secure,
      sameSite: cookieOpts.sameSite,
      maxAge: cookieOpts.maxAge,
      path: cookieOpts.path,
    })

    return clearNonce(response)
  } catch (err) {
    if (err instanceof Error && (err as Error & { status?: number }).status === 409) {
      return clearNonce(NextResponse.json({ error: 'Registration closed' }, { status: 409 }))
    }
    console.error('[register/finish] Unexpected error', err)
    return clearNonce(NextResponse.json({ error: 'Internal server error' }, { status: 500 }))
  } finally {
    if (registrationLock) {
      try {
        const currentToken = await redis.get(registrationLock.key)
        if (currentToken === registrationLock.token) {
          await redis.del(registrationLock.key)
        }
      } catch (err) {
        console.error('[register/finish] Failed to release registration lock', err)
      }
    }
  }
}
