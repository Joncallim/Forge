import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { workforceAgents, workforces } from '@/db/schema'
import { getSession } from '@/lib/session'
import { exportWorkforcesToWorkspace } from '@/lib/workforce-exports'
import { normalizeDisplayName, normalizeDisplayNameForUniqueness } from '@/lib/naming'

const idSchema = z.string().uuid()
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

const updateWorkforceSchema = z.object({
  slug: slugSchema.optional(),
  name: z.string().trim().min(1).max(120).optional(),
  displayName: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(500).optional(),
  isDefault: z.boolean().optional(),
  isActive: z.boolean().optional(),
  members: z.array(memberSchema).optional(),
})

async function hasDuplicateDisplayName(displayName: string, currentWorkforceId: string): Promise<boolean> {
  const normalized = normalizeDisplayNameForUniqueness(displayName)
  const rows = await db
    .select({ id: workforces.id, displayName: workforces.displayName })
    .from(workforces)
  return rows.some((row) =>
    row.id !== currentWorkforceId &&
    normalizeDisplayNameForUniqueness(row.displayName) === normalized
  )
}

async function exportWorkforceMirror(): Promise<string | null> {
  try {
    await exportWorkforcesToWorkspace()
    return null
  } catch (err) {
    console.error('[api/workforces/:id] Workspace export failed after DB commit', err)
    return 'Workspace workforce files could not be refreshed; database changes were saved.'
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { id } = await params
    const parsedId = idSchema.safeParse(id)
    if (!parsedId.success) {
      return NextResponse.json({ error: 'Invalid workforce id' }, { status: 400 })
    }

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const parsed = updateWorkforceSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', issues: parsed.error.issues },
        { status: 400 },
      )
    }

    const data = parsed.data
    const [existing] = await db.select().from(workforces).where(eq(workforces.id, id)).limit(1)
    if (!existing) {
      return NextResponse.json({ error: 'Workforce not found' }, { status: 404 })
    }
    const displayName = data.name !== undefined || data.displayName !== undefined
      ? normalizeDisplayName(data.name ?? data.displayName ?? '')
      : undefined
    if (displayName !== undefined && await hasDuplicateDisplayName(displayName, id)) {
      return NextResponse.json({ error: 'Workforce name already exists' }, { status: 409 })
    }

    await db.transaction(async (tx) => {
      if (data.isDefault === true) {
        await tx.update(workforces).set({ isDefault: false, updatedAt: new Date() })
      }

      await tx
        .update(workforces)
        .set({
          ...(data.slug !== undefined && { slug: data.slug }),
          ...(displayName !== undefined && { displayName }),
          ...(data.description !== undefined && { description: data.description }),
          ...(data.isDefault !== undefined && { isDefault: data.isDefault }),
          ...(data.isActive !== undefined && { isActive: data.isActive }),
          updatedAt: new Date(),
        })
        .where(eq(workforces.id, id))

      if (data.members !== undefined) {
        await tx.delete(workforceAgents).where(eq(workforceAgents.workforceId, id))
        if (data.members.length > 0) {
          await tx.insert(workforceAgents).values(
            data.members.map((member, index) => ({
              workforceId: id,
              agentConfigId: member.agentConfigId,
              roleLabel: member.roleLabel ?? null,
              sequence: member.sequence ?? index + 1,
              isRequired: member.isRequired ?? true,
              updatedAt: new Date(),
            })),
          )
        }
      }
    })

    const exportWarning = await exportWorkforceMirror()

    return NextResponse.json({
      ok: true,
      ...(exportWarning ? { warnings: [exportWarning] } : {}),
    })
  } catch (err) {
    if (
      typeof err === 'object' &&
      err !== null &&
      'code' in err &&
      (err as { code?: string }).code === '23505'
    ) {
      if ('constraint' in err && (err as { constraint?: string }).constraint === 'workforces_display_name_normalized_idx') {
        return NextResponse.json({ error: 'Workforce name already exists' }, { status: 409 })
      }
      return NextResponse.json({ error: 'Workforce slug or membership already exists' }, { status: 409 })
    }

    console.error('[PUT /api/workforces/:id] Unexpected error', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { id } = await params
    const parsedId = idSchema.safeParse(id)
    if (!parsedId.success) {
      return NextResponse.json({ error: 'Invalid workforce id' }, { status: 400 })
    }

    await db
      .update(workforces)
      .set({
        isActive: false,
        isDefault: false,
        updatedAt: new Date(),
      })
      .where(eq(workforces.id, id))

    const exportWarning = await exportWorkforceMirror()

    return NextResponse.json({
      ok: true,
      ...(exportWarning ? { warnings: [exportWarning] } : {}),
    })
  } catch (err) {
    console.error('[DELETE /api/workforces/:id] Unexpected error', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
