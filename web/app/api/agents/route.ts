import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { db } from '@/db'
import { agentConfigs } from '@/db/schema'
import { asc } from 'drizzle-orm'
import { getSession } from '@/lib/session'

// ---------------------------------------------------------------------------
// GET /api/agents
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const agents = await db
      .select()
      .from(agentConfigs)
      .orderBy(asc(agentConfigs.agentType))

    return NextResponse.json({ agents })
  } catch (err) {
    console.error('[GET /api/agents] Unexpected error', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
