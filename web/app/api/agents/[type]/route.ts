import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { z } from 'zod'
import path from 'path'
import fs from 'fs/promises'
import { db } from '@/db'
import { agentConfigs, workforceAgents } from '@/db/schema'
import { eq } from 'drizzle-orm'
import { getSession } from '@/lib/session'
import { redis } from '@/lib/redis'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const AGENT_CONFIG_DIR =
  process.env.FORGE_AGENT_CONFIG_DIR?.trim() || path.resolve(process.cwd(), '../../.claude/agents')

function isValidAgentType(value: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,62}[a-z0-9]$/.test(value)
}

// ---------------------------------------------------------------------------
// Validation schema
// ---------------------------------------------------------------------------

const updateAgentSchema = z.object({
  displayName: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(500).optional(),
  isActive: z.boolean().optional(),
  providerConfigId: z.string().uuid().nullable().optional(),
  systemPrompt: z.string().min(1).optional(),
  frontmatterOverrides: z.record(z.unknown()).optional(),
})

// ---------------------------------------------------------------------------
// Disk sync helper — preserves YAML frontmatter block
// ---------------------------------------------------------------------------

async function syncAgentFileToDisk(type: string, newSystemPrompt: string): Promise<void> {
  const agentFilePath = path.resolve(AGENT_CONFIG_DIR, `${type}.md`)

  let existing = ''
  try {
    existing = await fs.readFile(agentFilePath, 'utf8')
  } catch (err: unknown) {
    // File does not exist — write without frontmatter
    const errCode = (err as NodeJS.ErrnoException).code
    if (errCode !== 'ENOENT') throw err
    await fs.mkdir(path.dirname(agentFilePath), { recursive: true })
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
        { error: `Invalid agent type '${type}'. Use a lowercase slug with letters, numbers, hyphens, or underscores.` },
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
        { error: `Invalid agent type '${type}'. Use a lowercase slug with letters, numbers, hyphens, or underscores.` },
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

    if (!existing) {
      return NextResponse.json({ error: 'Agent config not found' }, { status: 404 })
    }

    const [agent] = await db
      .update(agentConfigs)
      .set({
        ...(data.systemPrompt !== undefined && { systemPrompt: data.systemPrompt }),
        ...(data.displayName !== undefined && { displayName: data.displayName }),
        ...(data.description !== undefined && { description: data.description }),
        ...(data.isActive !== undefined && { isActive: data.isActive }),
        ...('providerConfigId' in data && { providerConfigId: data.providerConfigId ?? null }),
        ...(data.frontmatterOverrides !== undefined && {
          frontmatterOverrides: data.frontmatterOverrides,
        }),
        updatedAt: new Date(),
        updatedBy: session.userId,
      })
      .where(eq(agentConfigs.agentType, type))
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

// ---------------------------------------------------------------------------
// DELETE /api/agents/:type
// ---------------------------------------------------------------------------

export async function DELETE(
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
        { error: `Invalid agent type '${type}'. Use a lowercase slug with letters, numbers, hyphens, or underscores.` },
        { status: 400 },
      )
    }

    if (type === 'architect') {
      return NextResponse.json(
        { error: 'The architect agent is required for the current planning worker.' },
        { status: 409 },
      )
    }

    const [existing] = await db
      .select()
      .from(agentConfigs)
      .where(eq(agentConfigs.agentType, type))
      .limit(1)

    if (!existing) {
      return NextResponse.json({ error: 'Agent config not found' }, { status: 404 })
    }

    await db.transaction(async (tx) => {
      await tx.delete(workforceAgents).where(eq(workforceAgents.agentConfigId, existing.id))
      await tx
        .update(agentConfigs)
        .set({
          isActive: false,
          providerConfigId: null,
          updatedAt: new Date(),
          updatedBy: session.userId,
        })
        .where(eq(agentConfigs.id, existing.id))
    })

    await redis.publish('forge:agent-config-changed', JSON.stringify({ agentType: type }))

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[DELETE /api/agents/:type] Unexpected error', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
