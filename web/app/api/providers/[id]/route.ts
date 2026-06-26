import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { db } from '@/db'
import { providerConfigs, tasks, agentConfigs, type ProviderConfig } from '@/db/schema'
import { eq, and, ne, asc, inArray } from 'drizzle-orm'
import { getSession } from '@/lib/session'
import { PROVIDER_TYPES, requiresProviderBaseUrl } from '@/lib/providers/types'
import { toPublicProvider } from '@/lib/providers/serialize'
import { encryptSecret } from '@/lib/crypto'
import { isAcpAgentId } from '@/lib/providers/acp/catalog'
import { providerSupportsUserBaseUrl } from '@/lib/providers/catalog'
import {
  providerBaseUrlForStorage,
  validateProviderApiKeyEnvVar,
  validateProviderBaseUrl,
} from '@/lib/providers/credentials'

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

const deleteProviderSchema = z.object({
  confirm: z.boolean().optional(),
  confirmed: z.boolean().optional(),
  expectedAgentConfigIds: z.array(z.string()).optional(),
  expectedTaskIds: z.array(z.string()).optional(),
})

const NON_TERMINAL_TASK_STATUSES = [
  'pending',
  'running',
  'awaiting_answers',
  'awaiting_approval',
  'approved',
] as const

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

type ProviderDeleteConfirmation = {
  confirmed: boolean
  expectedAgentConfigIds: string[]
  expectedTaskIds: string[]
}

async function providerDeleteConfirmation(request: NextRequest): Promise<ProviderDeleteConfirmation> {
  const url = request.nextUrl ?? new URL(request.url)
  const rawConfirm = url.searchParams.get('confirm') ?? url.searchParams.get('confirmed')
  if (rawConfirm && ['1', 'true', 'yes'].includes(rawConfirm.toLowerCase())) {
    return {
      confirmed: true,
      expectedAgentConfigIds: [],
      expectedTaskIds: [],
    }
  }

  const contentType = request.headers.get('content-type') ?? ''
  if (!contentType.toLowerCase().includes('application/json')) {
    return { confirmed: false, expectedAgentConfigIds: [], expectedTaskIds: [] }
  }

  try {
    const parsed = deleteProviderSchema.safeParse(await request.json())
    if (!parsed.success) return { confirmed: false, expectedAgentConfigIds: [], expectedTaskIds: [] }
    return {
      confirmed: parsed.data.confirm === true || parsed.data.confirmed === true,
      expectedAgentConfigIds: parsed.data.expectedAgentConfigIds ?? [],
      expectedTaskIds: parsed.data.expectedTaskIds ?? [],
    }
  } catch {
    return { confirmed: false, expectedAgentConfigIds: [], expectedTaskIds: [] }
  }
}

function sameIdSet(left: string[], right: string[]): boolean {
  const leftSet = new Set(left)
  const rightSet = new Set(right)
  if (leftSet.size !== left.length || rightSet.size !== right.length) return false
  if (leftSet.size !== rightSet.size) return false
  return [...leftSet].every((id) => rightSet.has(id))
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
    if (requiresProviderBaseUrl(effectiveType) && !effectiveBaseUrl?.trim()) {
      return NextResponse.json(
        { error: `baseUrl is required for ${effectiveType} providers` },
        { status: 400 },
      )
    }
    if ('baseUrl' in data) {
      const baseUrlError = validateProviderBaseUrl(effectiveType, data.baseUrl)
      if (baseUrlError) {
        return NextResponse.json({ error: baseUrlError }, { status: 400 })
      }
    }
    const switchingToAcp = existing.providerType !== 'acp' && data.providerType === 'acp'
    if (!switchingToAcp && 'apiKeyEnvVar' in data) {
      const envVarError = validateProviderApiKeyEnvVar(effectiveType, data.apiKeyEnvVar)
      if (envVarError) {
        return NextResponse.json({ error: envVarError }, { status: 400 })
      }
    }

    // Build update set — only include keys that were provided
    const updateSet: Record<string, unknown> = { updatedAt: new Date() }
    if (data.displayName !== undefined) updateSet.displayName = data.displayName
    if (data.providerType !== undefined) updateSet.providerType = data.providerType
    if (data.modelId !== undefined) updateSet.modelId = data.modelId
    if ('baseUrl' in data || data.providerType !== undefined || !providerSupportsUserBaseUrl(effectiveType)) {
      updateSet.baseUrl = providerBaseUrlForStorage(effectiveType, effectiveBaseUrl)
    }
    if ('apiKeyEnvVar' in data) {
      updateSet.apiKeyEnvVar = data.apiKeyEnvVar?.trim() || null
    } else if (
      data.providerType !== undefined ||
      validateProviderApiKeyEnvVar(effectiveType, existing.apiKeyEnvVar) !== null
    ) {
      const existingEnvVar = existing.apiKeyEnvVar?.trim() || null
      updateSet.apiKeyEnvVar =
        existingEnvVar && validateProviderApiKeyEnvVar(effectiveType, existingEnvVar) === null
          ? existingEnvVar
          : null
    }
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
    const confirmation = await providerDeleteConfirmation(request)

    const [existing] = await db
      .select()
      .from(providerConfigs)
      .where(eq(providerConfigs.id, id))
      .limit(1)

    if (!existing) {
      return NextResponse.json({ error: 'Provider config not found' }, { status: 404 })
    }

    const affectedAgents = await db
      .select({
        id: agentConfigs.id,
        agentType: agentConfigs.agentType,
        displayName: agentConfigs.displayName,
      })
      .from(agentConfigs)
      .where(eq(agentConfigs.providerConfigId, id))
      .orderBy(asc(agentConfigs.agentType))
    const affectedTasks = await db
      .select({
        id: tasks.id,
        title: tasks.title,
        status: tasks.status,
      })
      .from(tasks)
      .where(
        and(
          eq(tasks.pmProviderConfigId, id),
          inArray(tasks.status, [...NON_TERMINAL_TASK_STATUSES]),
        ),
      )
      .orderBy(asc(tasks.createdAt))
    const hasAssignments = affectedAgents.length > 0 || affectedTasks.length > 0

    const [defaultCandidate] = hasAssignments
      ? await db
        .select()
        .from(providerConfigs)
        .where(
          and(
            eq(providerConfigs.isActive, true),
            ne(providerConfigs.providerType, 'acp'),
            ne(providerConfigs.id, id),
          ),
        )
        .orderBy(asc(providerConfigs.createdAt))
        .limit(1)
      : []

    const setupPrompt = defaultCandidate
      ? null
      : 'Create or activate another provider before running more work.'
    const buildImpact = (
      agents: typeof affectedAgents,
      providerTasks: typeof affectedTasks,
    ) => ({
      provider: toPublicProvider(existing),
      affectedAssignments: {
        agentConfigs: agents.map((agent) => ({
          id: agent.id,
          role: agent.agentType,
          displayName: agent.displayName || agent.agentType,
        })),
        tasks: providerTasks.map((task) => ({
          id: task.id,
          title: task.title,
          status: task.status,
        })),
      },
      hasDefaultProviderFallback: Boolean(defaultCandidate),
      fallbackProvider: null,
      setupPrompt,
      message: [
        agents.length > 0
          ? `${agents.length} agent default${agents.length === 1 ? '' : 's'} will use the default provider.`
          : null,
        providerTasks.length > 0
          ? `${providerTasks.length} active task provider override${providerTasks.length === 1 ? '' : 's'} will be cleared.`
          : null,
        setupPrompt,
      ].filter(Boolean).join(' '),
    })
    const impact = buildImpact(affectedAgents, affectedTasks)

    if (hasAssignments && !confirmation.confirmed) {
      return NextResponse.json(
        {
          error: 'Provider deactivation requires confirmation because it affects current assignments.',
          code: 'provider_deactivation_requires_confirmation',
          confirmationRequired: true,
          impact,
        },
        { status: 409 },
      )
    }

    if (
      hasAssignments &&
      (
        !sameIdSet(confirmation.expectedAgentConfigIds, affectedAgents.map((agent) => agent.id)) ||
        !sameIdSet(confirmation.expectedTaskIds, affectedTasks.map((task) => task.id))
      )
    ) {
      return NextResponse.json(
        {
          error: 'Provider deactivation impact changed. Review the updated affected assignments before confirming.',
          code: 'provider_deactivation_requires_confirmation',
          confirmationRequired: true,
          impact,
        },
        { status: 409 },
      )
    }

    const updatedAt = new Date()
    let transactionImpact: typeof impact | null = null
    await db.transaction(async (tx) => {
      const currentAgents = await tx
        .select({
          id: agentConfigs.id,
          agentType: agentConfigs.agentType,
          displayName: agentConfigs.displayName,
        })
        .from(agentConfigs)
        .where(eq(agentConfigs.providerConfigId, id))
        .orderBy(asc(agentConfigs.agentType))
      const currentTasks = await tx
        .select({
          id: tasks.id,
          title: tasks.title,
          status: tasks.status,
        })
        .from(tasks)
        .where(
          and(
            eq(tasks.pmProviderConfigId, id),
            inArray(tasks.status, [...NON_TERMINAL_TASK_STATUSES]),
          ),
        )
        .orderBy(asc(tasks.createdAt))

      if (
        !sameIdSet(confirmation.expectedAgentConfigIds, currentAgents.map((agent) => agent.id)) ||
        !sameIdSet(confirmation.expectedTaskIds, currentTasks.map((task) => task.id))
      ) {
        transactionImpact = buildImpact(currentAgents, currentTasks)
        return
      }

      if (affectedAgents.length > 0) {
        await tx
          .update(agentConfigs)
          .set({ providerConfigId: null, updatedAt })
          .where(
            and(
              eq(agentConfigs.providerConfigId, id),
              inArray(agentConfigs.id, affectedAgents.map((agent) => agent.id)),
            ),
          )
      }

      if (affectedTasks.length > 0) {
        await tx
          .update(tasks)
          .set({ pmProviderConfigId: null, updatedAt })
          .where(
            and(
              eq(tasks.pmProviderConfigId, id),
              inArray(tasks.status, [...NON_TERMINAL_TASK_STATUSES]),
              inArray(tasks.id, affectedTasks.map((task) => task.id)),
            ),
          )
      }

      await tx
        .update(providerConfigs)
        .set({ isActive: false, updatedAt })
        .where(eq(providerConfigs.id, id))
    })

    if (transactionImpact) {
      return NextResponse.json(
        {
          error: 'Provider deactivation impact changed. Review the updated affected assignments before confirming.',
          code: 'provider_deactivation_requires_confirmation',
          confirmationRequired: true,
          impact: transactionImpact,
        },
        { status: 409 },
      )
    }

    console.info('[DELETE /api/providers/:id] Soft-deleted provider config', {
      id,
      clearedAgentDefaults: affectedAgents.length,
      clearedTaskOverrides: affectedTasks.length,
      setupRequired: !defaultCandidate,
    })
    return NextResponse.json({
      ok: true,
      deactivatedProviderId: id,
      fallbackProvider: null,
      setupPrompt,
      reassigned: {
        agentConfigs: affectedAgents.length,
        tasks: affectedTasks.length,
      },
    })
  } catch (err) {
    console.error('[DELETE /api/providers/:id] Unexpected error', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
