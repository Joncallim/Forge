import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { z } from 'zod'
import path from 'path'
import fs from 'fs/promises'
import { db } from '@/db'
import { agentConfigs } from '@/db/schema'
import { eq } from 'drizzle-orm'
import { getSession } from '@/lib/session'
import { redis } from '@/lib/redis'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VALID_AGENT_TYPES = ['architect', 'backend', 'frontend', 'qa', 'reviewer', 'devops'] as const
type AgentType = (typeof VALID_AGENT_TYPES)[number]

function isValidAgentType(value: string): value is AgentType {
  return (VALID_AGENT_TYPES as readonly string[]).includes(value)
}

// ---------------------------------------------------------------------------
// Validation schema
// ---------------------------------------------------------------------------

const updateAgentSchema = z.object({
  providerConfigId: z.string().uuid().nullable().optional(),
  systemPrompt: z.string().min(1).optional(),
  frontmatterOverrides: z.record(z.unknown()).optional(),
})

// ---------------------------------------------------------------------------
// Disk sync helper — preserves YAML frontmatter block
// ---------------------------------------------------------------------------

async function syncAgentFileToDisk(type: AgentType, newSystemPrompt: string): Promise<void> {
  const agentFilePath = path.resolve(process.cwd(), `../../.claude/agents/${type}.md`)

  let existing = ''
  try {
    existing = await fs.readFile(agentFilePath, 'utf8')
  } catch (err: unknown) {
    // File does not exist — write without frontmatter
    const errCode = (err as NodeJS.ErrnoException).code
    if (errCode !== 'ENOENT') throw err
    await fs.writeFile(agentFilePath, `${newSystemPrompt}\n`, 'utf8')
    console.info('[agents/sync] Created new agent file (no existing frontmatter)', {
      type,
      path: agentFilePath,
    })
    return
  }

  // Extract frontmatter: text between the first --- line and the second --- line
  const lines = existing.split('\n')
  let frontmatter = ''

  if (lines[0]?.trim() === '---') {
    const closingIndex = lines.findIndex((line, idx) => idx > 0 && line.trim() === '---')
    if (closingIndex !== -1) {
      // Include the lines between the delimiters (not the delimiters themselves)
      frontmatter = lines.slice(1, closingIndex).join('\n')
    }
  }

  let newContent: string
  if (frontmatter) {
    newContent = `---\n${frontmatter}\n---\n\n${newSystemPrompt}\n`
  } else {
    newContent = `${newSystemPrompt}\n`
  }

  await fs.writeFile(agentFilePath, newContent, 'utf8')
  console.info('[agents/sync] Synced agent system prompt to disk', {
    type,
    path: agentFilePath,
  })
}

// ---------------------------------------------------------------------------
// GET /api/agents/:type
// ---------------------------------------------------------------------------

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ type: string }> },
) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { type } = await params

    if (!isValidAgentType(type)) {
      return NextResponse.json(
        { error: `Invalid agent type '${type}'. Must be one of: ${VALID_AGENT_TYPES.join(', ')}` },
        { status: 400 },
      )
    }

    const [agent] = await db
      .select()
      .from(agentConfigs)
      .where(eq(agentConfigs.agentType, type))
      .limit(1)

    if (!agent) {
      return NextResponse.json({ error: 'Agent config not found' }, { status: 404 })
    }

    return NextResponse.json({ agent })
  } catch (err) {
    console.error('[GET /api/agents/:type] Unexpected error', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// ---------------------------------------------------------------------------
// PUT /api/agents/:type
// ---------------------------------------------------------------------------

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ type: string }> },
) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { type } = await params

    if (!isValidAgentType(type)) {
      return NextResponse.json(
        { error: `Invalid agent type '${type}'. Must be one of: ${VALID_AGENT_TYPES.join(', ')}` },
        { status: 400 },
      )
    }

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const parsed = updateAgentSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', issues: parsed.error.issues },
        { status: 400 },
      )
    }

    const data = parsed.data

    // Fetch existing record to obtain current systemPrompt for upsert default
    const [existing] = await db
      .select()
      .from(agentConfigs)
      .where(eq(agentConfigs.agentType, type))
      .limit(1)

    // Build the values for upsert
    const upsertValues: {
      agentType: AgentType
      systemPrompt: string
      providerConfigId?: string | null
      frontmatterOverrides?: Record<string, unknown>
      updatedAt: Date
      updatedBy: string
    } = {
      agentType: type,
      // systemPrompt must always have a value — fall back to existing or placeholder
      systemPrompt: data.systemPrompt ?? existing?.systemPrompt ?? '',
      updatedAt: new Date(),
      updatedBy: session.userId,
    }

    if ('providerConfigId' in data) {
      upsertValues.providerConfigId = data.providerConfigId ?? null
    } else if (existing?.providerConfigId) {
      upsertValues.providerConfigId = existing.providerConfigId
    }

    if (data.frontmatterOverrides !== undefined) {
      upsertValues.frontmatterOverrides = data.frontmatterOverrides
    }

    const [agent] = await db
      .insert(agentConfigs)
      .values(upsertValues)
      .onConflictDoUpdate({
        target: agentConfigs.agentType,
        set: {
          ...(data.systemPrompt !== undefined && { systemPrompt: data.systemPrompt }),
          ...('providerConfigId' in data && { providerConfigId: data.providerConfigId ?? null }),
          ...(data.frontmatterOverrides !== undefined && {
            frontmatterOverrides: data.frontmatterOverrides,
          }),
          updatedAt: new Date(),
          updatedBy: session.userId,
        },
      })
      .returning()

    // Auto-sync to disk if systemPrompt was provided
    if (data.systemPrompt !== undefined) {
      try {
        await syncAgentFileToDisk(type, data.systemPrompt)
      } catch (err) {
        // Log but don't fail the request — DB is the source of truth
        console.error('[PUT /api/agents/:type] Failed to sync agent file to disk', {
          type,
          err,
        })
      }
    }

    await redis.publish('forge:agent-config-changed', JSON.stringify({ agentType: type }))

    console.info('[PUT /api/agents/:type] Upserted agent config', {
      type,
      userId: session.userId,
    })
    return NextResponse.json({ agent })
  } catch (err) {
    console.error('[PUT /api/agents/:type] Unexpected error', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
