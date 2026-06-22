import { NextResponse } from 'next/server'
import { generateAuthenticationOptions } from '@simplewebauthn/server'
import { redis } from '@/lib/redis'
import { passkeysEnabled } from '@/lib/auth-options'

export async function POST() {
  try {
    if (!passkeysEnabled()) {
      return NextResponse.json({ error: 'Passkeys are disabled' }, { status: 404 })
    }

    const nonce = crypto.randomUUID()

    // Generate authentication options (discoverable credential — no allowCredentials hint)
    const options = await generateAuthenticationOptions({
      rpID: process.env.WEBAUTHN_RP_ID!,
      userVerification: 'required',
      allowCredentials: [],
    })

    // Store challenge in Redis with 5-minute TTL
    await redis.set(`webauthn:challenge:auth:${nonce}`, options.challenge, 'EX', 300)

    return NextResponse.json({ options, nonce })
  } catch (err) {
    console.error('[login/start] Unexpected error', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
