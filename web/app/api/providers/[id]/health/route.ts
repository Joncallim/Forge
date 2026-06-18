import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { db } from '@/db'
import { providerConfigs } from '@/db/schema'
import { eq } from 'drizzle-orm'
import { getSession } from '@/lib/session'
import { checkProviderHealth } from '@/lib/providers/health'

// ---------------------------------------------------------------------------
// GET /api/providers/:id/health
// ---------------------------------------------------------------------------

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { id } = await params

    const [config] = await db
      .select()
      .from(providerConfigs)
      .where(eq(providerConfigs.id, id))
      .limit(1)

    if (!config) {
      return NextResponse.json({ error: 'Provider config not found' }, { status: 404 })
    }

    const health = await checkProviderHealth(config)
    return NextResponse.json(health)
  } catch (err) {
    console.error('[GET /api/providers/:id/health] Unexpected error', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
