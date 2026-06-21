import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { generateRegistrationOptions } from '@simplewebauthn/server'
import { isoUint8Array } from '@simplewebauthn/server/helpers'
import { db } from '@/db'
import { users } from '@/db/schema'
import { redis } from '@/lib/redis'
import { count } from 'drizzle-orm'
import { passkeysEnabled } from '@/lib/auth-options'

export async function POST(request: NextRequest) {
  try {
    if (!passkeysEnabled()) {
      return NextResponse.json({ error: 'Passkeys are disabled' }, { status: 404 })
    }

    // Parse and validate request body
    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    if (
      !body ||
      typeof body !== 'object' ||
      !('displayName' in body) ||
      typeof (body as Record<string, unknown>).displayName !== 'string'
    ) {
      return NextResponse.json({ error: 'displayName must be a non-empty string' }, { status: 400 })
    }

    const { displayName } = body as { displayName: string }

    if (displayName.trim().length === 0 || displayName.length > 100) {
      return NextResponse.json(
        { error: 'displayName must be between 1 and 100 characters' },
        { status: 400 },
      )
    }

    // Registration gating: only allow when zero users exist
    const [{ value: userCount }] = await db.select({ value: count() }).from(users)

    if (userCount > 0) {
      return NextResponse.json({ error: 'Registration closed' }, { status: 403 })
    }

    // Generate a temp user ID for the challenge nonce
    const tempUserId = crypto.randomUUID()

    // Generate registration options
    const options = await generateRegistrationOptions({
      rpName: process.env.WEBAUTHN_RP_NAME!,
      rpID: process.env.WEBAUTHN_RP_ID!,
      userID: isoUint8Array.fromUTF8String(tempUserId),
      userName: displayName,
      userDisplayName: displayName,
      attestationType: 'none',
      authenticatorSelection: {
        residentKey: 'required',
        userVerification: 'required',
      },
    })

    // Store challenge in Redis with 5-minute TTL
    const challengeData = JSON.stringify({ challenge: options.challenge, displayName })
    await redis.set(`webauthn:challenge:reg:${tempUserId}`, challengeData, 'EX', 300)

    // Build response and set reg_nonce cookie
    const response = NextResponse.json({ options })
    response.cookies.set('reg_nonce', tempUserId, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 300,
      path: '/',
    })

    return response
  } catch (err) {
    console.error('[register/start] Unexpected error', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
