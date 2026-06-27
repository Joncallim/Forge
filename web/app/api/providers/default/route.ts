import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { db } from '@/db'
import { providerConfigs } from '@/db/schema'
import { eq } from 'drizzle-orm'
import { getSession } from '@/lib/session'
import {
  clearDefaultProviderConfigId,
  getDefaultProviderConfigId,
  resolveDefaultProvider,
  setDefaultProviderConfigId,
} from '@/lib/providers/default'
import { toPublicProvider } from '@/lib/providers/serialize'

// ---------------------------------------------------------------------------
// GET /api/providers/default
//
// Returns both the configured default (which may be stale/inactive) and the
// resolved provider that will actually be used at runtime, per issue #88's
// fallback chain (default -> zero-config ready local provider -> none).
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const [defaultProviderConfigId, resolved] = await Promise.all([
      getDefaultProviderConfigId(),
      resolveDefaultProvider(),
    ])

    return NextResponse.json({
      defaultProviderConfigId,
      resolvedProvider: resolved ? toPublicProvider(resolved) : null,
    })
  } catch (err) {
    console.error('[GET /api/providers/default] Unexpected error', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// ---------------------------------------------------------------------------
// PUT /api/providers/default
// ---------------------------------------------------------------------------

const setDefaultSchema = z.object({
  providerConfigId: z.string().uuid(),
})

export async function PUT(request: NextRequest) {
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

    const parsed = setDefaultSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', fields: parsed.error.flatten().fieldErrors },
        { status: 400 },
      )
    }

    const [provider] = await db
      .select()
      .from(providerConfigs)
      .where(eq(providerConfigs.id, parsed.data.providerConfigId))
      .limit(1)

    if (!provider || !provider.isActive) {
      return NextResponse.json({ error: 'Provider config not found or inactive' }, { status: 404 })
    }

    await setDefaultProviderConfigId(provider.id)
    return NextResponse.json({ defaultProviderConfigId: provider.id })
  } catch (err) {
    console.error('[PUT /api/providers/default] Unexpected error', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// ---------------------------------------------------------------------------
// DELETE /api/providers/default
// ---------------------------------------------------------------------------

export async function DELETE(request: NextRequest) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    await clearDefaultProviderConfigId()
    return NextResponse.json({ defaultProviderConfigId: null })
  } catch (err) {
    console.error('[DELETE /api/providers/default] Unexpected error', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
