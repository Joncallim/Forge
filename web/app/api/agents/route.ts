import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { db } from '@/db'
import { agentConfigs } from '@/db/schema'
import { asc, eq } from 'drizzle-orm'
import { getSession } from '@/lib/session'
import { syncAgentPromptFileToWorkspace } from '@/lib/agent-prompts'

const agentSlugSchema = z
  .string()
  .trim()
  .min(2)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9_-]*[a-z0-9]$/, 'Use lowercase letters, numbers, hyphens, or underscores.')

const createAgentSchema = z.object({
  agentType: agentSlugSchema,
  displayName: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).optional(),
  providerConfigId: z.string().uuid().nullable().optional(),
  systemPrompt: z.string().trim().min(1),
})

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

// ---------------------------------------------------------------------------
// POST /api/agents
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

    const parsed = createAgentSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', issues: parsed.error.issues },
        { status: 400 },
      )
    }

    const data = parsed.data
    const [agent] = await db
      .insert(agentConfigs)
      .values({
        agentType: data.agentType,
        displayName: data.displayName,
        description: data.description ?? '',
        providerConfigId: data.providerConfigId ?? null,
        systemPrompt: data.systemPrompt,
        isSystem: false,
        isActive: true,
        updatedAt: new Date(),
        updatedBy: session.userId,
      })
      .returning()

    try {
      await syncAgentPromptFileToWorkspace({
        agentType: data.agentType,
        displayName: data.displayName,
        description: data.description ?? '',
        systemPrompt: data.systemPrompt,
      })
    } catch (promptErr) {
      await db.delete(agentConfigs).where(eq(agentConfigs.id, agent.id)).catch((cleanupErr) => {
        console.error('[POST /api/agents] Failed to clean up agent after prompt sync failure', cleanupErr)
      })
      console.error('[POST /api/agents] Prompt sync failed', promptErr)
      return NextResponse.json(
        { error: 'Agent prompt file could not be written' },
        { status: 500 },
      )
    }

    return NextResponse.json({ agent }, { status: 201 })
  } catch (err) {
    if (
      typeof err === 'object' &&
      err !== null &&
      'code' in err &&
      (err as { code?: string }).code === '23505'
    ) {
      return NextResponse.json({ error: 'Agent slug already exists' }, { status: 409 })
    }

    console.error('[POST /api/agents] Unexpected error', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
