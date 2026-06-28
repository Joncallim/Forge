import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { db } from '@/db'
import { agentConfigs } from '@/db/schema'
import { getSession } from '@/lib/session'
import { listActiveProviders } from '@/lib/providers/registry'
import { evaluateAgentRoles } from '@/lib/agent-evaluation'

// ---------------------------------------------------------------------------
// Validation schema
// ---------------------------------------------------------------------------

const evaluateRequestSchema = z.object({
  enableWebResearch: z.boolean().optional(),
})

const ARCHITECT_AGENT = 'architect'

// ---------------------------------------------------------------------------
// POST /api/agents/evaluate
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    let body: unknown = {}
    try {
      const text = await request.text()
      if (text) body = JSON.parse(text)
    } catch {
      // default {}
    }

    const parsed = evaluateRequestSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', issues: parsed.error.issues },
        { status: 400 },
      )
    }

    const [allAgentConfigs, activeProviders] = await Promise.all([
      db.select().from(agentConfigs),
      listActiveProviders(),
    ])

    const architectConfig = allAgentConfigs.find((c) => c.agentType === ARCHITECT_AGENT)
    if (!architectConfig || !architectConfig.providerConfigId) {
      return NextResponse.json(
        { error: 'Assign a provider to the Architect agent before running role evaluation.' },
        { status: 400 },
      )
    }
    const architectProvider = activeProviders.find((provider) => provider.id === architectConfig.providerConfigId)
    if (architectProvider?.providerType === 'acp') {
      return NextResponse.json(
        { error: 'Agent role evaluation is a workspace-level workflow and cannot use an ACP provider without a project folder. Choose a non-ACP Architect provider for role evaluation.' },
        { status: 400 },
      )
    }

    try {
      const { recommendations, usage } = await evaluateAgentRoles({
        agentConfigs: allAgentConfigs,
        activeProviders,
        enableWebResearch: parsed.data.enableWebResearch,
      })

      return NextResponse.json({ recommendations, usage })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error('[POST /api/agents/evaluate] Unexpected error', err)
      return NextResponse.json({ error: message }, { status: 502 })
    }
  } catch (err) {
    console.error('[POST /api/agents/evaluate] Unexpected error', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
