import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { db } from '@/db'
import { providerConfigs, tasks, agentRuns, agentConfigs, type ProviderConfig } from '@/db/schema'
import { eq, and, isNotNull, count } from 'drizzle-orm'
import { getSession } from '@/lib/session'
import { PROVIDER_TYPES, requiresProviderBaseUrl } from '@/lib/providers/types'
import { toPublicProvider } from '@/lib/providers/serialize'
import { encryptSecret } from '@/lib/crypto'
import { isAcpAgentId } from '@/lib/providers/acp/catalog'

// ---------------------------------------------------------------------------
// Validation schema (all fields optional for PUT)
// ---------------------------------------------------------------------------

const providerTypeEnum = z.enum(PROVIDER_TYPES)

const updateProviderSchema = z.object({
  displayName: z.string().min(1).max(100).optional(),
  providerType: providerTypeEnum.optional(),
  modelId: z.string().min(1).max(200).optional(),
  baseUrl: z.string().max(2048).nullable().optional(),
  apiKeyEnvVar: z.string().max(200).nullable().optional(),
  apiKey: z.string().max(8192).nullable().optional(),
  isLocal: z.boolean().optional(),
})

function validateAcpProviderUpdate(
  data: z.infer<typeof updateProviderSchema>,
  existing: ProviderConfig,
): string | null {
  const effectiveType = data.providerType ?? existing.providerType
  if (effectiveType !== 'acp') return null

  const effectiveModelId = data.modelId ?? existing.modelId
  const switchingToAcp = existing.providerType !== 'acp' && data.providerType === 'acp'
  const effectiveBaseUrl = switchingToAcp ? null : 'baseUrl' in data ? data.baseUrl : existing.baseUrl
  const effectiveApiKeyEnvVar = switchingToAcp ? null : 'apiKeyEnvVar' in data ? data.apiKeyEnvVar : existing.apiKeyEnvVar
  const typedApiKey = 'apiKey' in data ? data.apiKey : null

  if (!isAcpAgentId(effectiveModelId)) {
    return 'modelId must be a known ACP agent id'
  }
  if (effectiveBaseUrl && effectiveBaseUrl.trim() !== '') {
    return 'baseUrl is not supported for ACP providers'
  }
  if (effectiveApiKeyEnvVar && effectiveApiKeyEnvVar.trim() !== '') {
    return 'apiKeyEnvVar is not supported for ACP providers'
  }
  if (typedApiKey && typedApiKey.trim() !== '') {
    return 'apiKey is not supported for ACP providers'
  }

  return null
}

// ---------------------------------------------------------------------------
// GET /api/providers/:id
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

    const [provider] = await db
      .select()
      .from(providerConfigs)
      .where(eq(providerConfigs.id, id))
      .limit(1)

    if (!provider) {
      return NextResponse.json({ error: 'Provider config not found' }, { status: 404 })
    }

    return NextResponse.json({ provider: toPublicProvider(provider) })
  } catch (err) {
    console.error('[GET /api/providers/:id] Unexpected error', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// ---------------------------------------------------------------------------
// PUT /api/providers/:id
// ---------------------------------------------------------------------------

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

    // Check the provider exists
    const [existing] = await db
      .select()
      .from(providerConfigs)
      .where(eq(providerConfigs.id, id))
      .limit(1)

    if (!existing) {
      return NextResponse.json({ error: 'Provider config not found' }, { status: 404 })
    }

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const parsed = updateProviderSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', fields: parsed.error.flatten().fieldErrors },
        { status: 400 },
      )
    }

    const data = parsed.data
    const acpError = validateAcpProviderUpdate(data, existing)
    if (acpError) {
      return NextResponse.json({ error: acpError }, { status: 400 })
    }

    // Conditional validation: if providerType requires baseUrl, baseUrl must be present.
    const effectiveType = data.providerType ?? existing.providerType
    const effectiveBaseUrl = 'baseUrl' in data ? data.baseUrl : existing.baseUrl
    if (requiresProviderBaseUrl(effectiveType) && !effectiveBaseUrl) {
      return NextResponse.json(
        { error: `baseUrl is required for ${effectiveType} providers` },
        { status: 400 },
      )
    }

    // Build update set — only include keys that were provided
    const updateSet: Record<string, unknown> = { updatedAt: new Date() }
    if (data.displayName !== undefined) updateSet.displayName = data.displayName
    if (data.providerType !== undefined) updateSet.providerType = data.providerType
    if (data.modelId !== undefined) updateSet.modelId = data.modelId
    if ('baseUrl' in data) updateSet.baseUrl = data.baseUrl ?? null
    if ('apiKeyEnvVar' in data) updateSet.apiKeyEnvVar = data.apiKeyEnvVar ?? null
    if (data.isLocal !== undefined) updateSet.isLocal = data.isLocal

    if ((data.providerType ?? existing.providerType) === 'acp') {
      updateSet.baseUrl = null
      updateSet.apiKeyEnvVar = null
      updateSet.apiKeyCiphertext = null
      updateSet.isLocal = true
    }

    // API key: present-and-non-empty replaces the stored key; explicit null or
    // empty string clears it; omitted leaves the existing key untouched.
    if ('apiKey' in data && (data.providerType ?? existing.providerType) !== 'acp') {
      const key = data.apiKey?.trim()
      updateSet.apiKeyCiphertext = key ? encryptSecret(key) : null
    }

    const [updated] = await db
      .update(providerConfigs)
      .set(updateSet)
      .where(eq(providerConfigs.id, id))
      .returning()

    console.info('[PUT /api/providers/:id] Updated provider config', { id: updated.id })
    return NextResponse.json({ provider: toPublicProvider(updated) })
  } catch (err) {
    console.error('[PUT /api/providers/:id] Unexpected error', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// ---------------------------------------------------------------------------
// DELETE /api/providers/:id  (soft-delete by setting isActive = false)
// ---------------------------------------------------------------------------

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

    const [existing] = await db
      .select()
      .from(providerConfigs)
      .where(eq(providerConfigs.id, id))
      .limit(1)

    if (!existing) {
      return NextResponse.json({ error: 'Provider config not found' }, { status: 404 })
    }

    // Guard: check if this is the only active provider of its type AND it is referenced
    // by tasks, agentRuns, or agentConfigs.
    const [activeOfTypeResult] = await db
      .select({ total: count() })
      .from(providerConfigs)
      .where(
        and(
          eq(providerConfigs.providerType, existing.providerType),
          eq(providerConfigs.isActive, true),
        ),
      )

    const activeOfTypeCount = Number(activeOfTypeResult?.total ?? 0)

    if (activeOfTypeCount <= 1) {
      // This is the only active provider of its type — check for references
      const [taskRef] = await db
        .select({ total: count() })
        .from(tasks)
        .where(
          and(
            eq(tasks.pmProviderConfigId, id),
            isNotNull(tasks.pmProviderConfigId),
          ),
        )

      const [agentRunRef] = await db
        .select({ total: count() })
        .from(agentRuns)
        .where(
          and(
            eq(agentRuns.providerConfigId, id),
            isNotNull(agentRuns.providerConfigId),
          ),
        )

      const [agentConfigRef] = await db
        .select({ total: count() })
        .from(agentConfigs)
        .where(
          and(
            eq(agentConfigs.providerConfigId, id),
            isNotNull(agentConfigs.providerConfigId),
          ),
        )

      const hasReferences =
        Number(taskRef?.total ?? 0) > 0 ||
        Number(agentRunRef?.total ?? 0) > 0 ||
        Number(agentConfigRef?.total ?? 0) > 0

      if (hasReferences) {
        return NextResponse.json(
          { error: 'Cannot deactivate the only active provider. Assign an alternative first.' },
          { status: 409 },
        )
      }
    }

    await db
      .update(providerConfigs)
      .set({ isActive: false, updatedAt: new Date() })
      .where(eq(providerConfigs.id, id))

    console.info('[DELETE /api/providers/:id] Soft-deleted provider config', { id })
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[DELETE /api/providers/:id] Unexpected error', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
