import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { asc, eq } from 'drizzle-orm'
import { db } from '@/db'
import { agentConfigs, workforceAgents, workforces } from '@/db/schema'
import { getSession } from '@/lib/session'
import { exportWorkforcesToWorkspace } from '@/lib/workforce-exports'

const slugSchema = z
  .string()
  .trim()
  .min(2)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9_-]*[a-z0-9]$/, 'Use lowercase letters, numbers, hyphens, or underscores.')

const memberSchema = z.object({
  agentConfigId: z.string().uuid(),
  roleLabel: z.string().trim().max(120).nullable().optional(),
  sequence: z.number().int().positive().optional(),
  isRequired: z.boolean().optional(),
})

const createWorkforceSchema = z.object({
  slug: slugSchema.optional(),
  displayName: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).optional(),
  isDefault: z.boolean().optional(),
  isActive: z.boolean().optional(),
  members: z.array(memberSchema).optional(),
})

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
}

async function exportWorkforceMirror(workforceRows: Awaited<ReturnType<typeof listWorkforces>>): Promise<string | null> {
  try {
    await exportWorkforcesToWorkspace(workforceRows)
    return null
  } catch (err) {
    console.error('[api/workforces] Workspace export failed after DB commit', err)
    return 'Workspace workforce files could not be refreshed; database changes were saved.'
  }
}

async function listWorkforces() {
  const [workforceRows, memberRows] = await Promise.all([
    db.select().from(workforces).orderBy(asc(workforces.displayName)),
    db
      .select({
        id: workforceAgents.id,
        workforceId: workforceAgents.workforceId,
        agentConfigId: workforceAgents.agentConfigId,
        roleLabel: workforceAgents.roleLabel,
        sequence: workforceAgents.sequence,
        isRequired: workforceAgents.isRequired,
        metadata: workforceAgents.metadata,
        createdAt: workforceAgents.createdAt,
        updatedAt: workforceAgents.updatedAt,
        agentType: agentConfigs.agentType,
        displayName: agentConfigs.displayName,
        description: agentConfigs.description,
        isActive: agentConfigs.isActive,
      })
      .from(workforceAgents)
      .innerJoin(agentConfigs, eq(workforceAgents.agentConfigId, agentConfigs.id))
      .orderBy(asc(workforceAgents.sequence), asc(agentConfigs.agentType)),
  ])

  const membersByWorkforce = new Map<string, typeof memberRows>()
  for (const member of memberRows) {
    const existing = membersByWorkforce.get(member.workforceId) ?? []
    existing.push(member)
    membersByWorkforce.set(member.workforceId, existing)
  }

  return workforceRows.map((workforce) => ({
    ...workforce,
    members: membersByWorkforce.get(workforce.id) ?? [],
  }))
}

export async function GET(request: NextRequest) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    return NextResponse.json({ workforces: await listWorkforces() })
  } catch (err) {
    console.error('[GET /api/workforces] Unexpected error', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

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

    const parsed = createWorkforceSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', issues: parsed.error.issues },
        { status: 400 },
      )
    }

    const data = parsed.data
    const slug = data.slug ?? slugify(data.displayName)
    const parsedSlug = slugSchema.safeParse(slug)
    if (!parsedSlug.success) {
      return NextResponse.json(
        { error: 'Validation failed', issues: parsedSlug.error.issues },
        { status: 400 },
      )
    }

    await db.transaction(async (tx) => {
      if (data.isDefault === true) {
        await tx.update(workforces).set({ isDefault: false, updatedAt: new Date() })
      }

      const [workforce] = await tx
        .insert(workforces)
        .values({
          slug: parsedSlug.data,
          displayName: data.displayName,
          description: data.description ?? '',
          isDefault: data.isDefault ?? false,
          isActive: data.isActive ?? true,
          updatedAt: new Date(),
        })
        .returning()

      const members = data.members ?? []
      if (members.length > 0) {
        await tx.insert(workforceAgents).values(
          members.map((member, index) => ({
            workforceId: workforce.id,
            agentConfigId: member.agentConfigId,
            roleLabel: member.roleLabel ?? null,
            sequence: member.sequence ?? index + 1,
            isRequired: member.isRequired ?? true,
            updatedAt: new Date(),
          })),
        )
      }
    })

    const nextWorkforces = await listWorkforces()
    const exportWarning = await exportWorkforceMirror(nextWorkforces)

    return NextResponse.json(
      {
        workforces: nextWorkforces,
        ...(exportWarning ? { warnings: [exportWarning] } : {}),
      },
      { status: 201 },
    )
  } catch (err) {
    if (
      typeof err === 'object' &&
      err !== null &&
      'code' in err &&
      (err as { code?: string }).code === '23505'
    ) {
      return NextResponse.json({ error: 'Workforce slug or membership already exists' }, { status: 409 })
    }

    console.error('[POST /api/workforces] Unexpected error', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
