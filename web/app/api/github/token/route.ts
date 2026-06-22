import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { getSession } from '@/lib/session'
import { clearStoredPat, storePat, validatePat } from '@/lib/github'

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const tokenSchema = z.object({
  token: z.string().trim().min(1, 'A token is required'),
})

// ---------------------------------------------------------------------------
// POST /api/github/token — validate and store a Personal Access Token (encrypted)
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const parsed = tokenSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', issues: parsed.error.issues },
        { status: 400 },
      )
    }

    const validated = await validatePat(parsed.data.token)
    if (!validated) {
      return NextResponse.json(
        { error: 'GitHub rejected this token. Check that it is valid and not expired.' },
        { status: 400 },
      )
    }

    await storePat(parsed.data.token)

    console.info('[POST /api/github/token] Stored GitHub PAT', { login: validated.login })
    return NextResponse.json({ ok: true, login: validated.login })
  } catch (err) {
    console.error('[POST /api/github/token] Unexpected error', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// ---------------------------------------------------------------------------
// DELETE /api/github/token — remove the stored PAT (disconnect)
// ---------------------------------------------------------------------------

export async function DELETE(request: NextRequest) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    await clearStoredPat()
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[DELETE /api/github/token] Unexpected error', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
