import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { db } from '@/db'
import { providerConfigs } from '@/db/schema'
import { getSession } from '@/lib/session'
import { listActiveProviders } from '@/lib/providers/registry'
import { PROVIDER_TYPES, requiresProviderBaseUrl } from '@/lib/providers/types'
import { toPublicProvider } from '@/lib/providers/serialize'
import { encryptSecret } from '@/lib/crypto'
import { isAcpAgentId } from '@/lib/providers/acp/catalog'

// ---------------------------------------------------------------------------
// Validation schema
// ---------------------------------------------------------------------------

const providerTypeEnum = z.enum(PROVIDER_TYPES)

const createProviderSchema = z.object({
  displayName: z.string().min(1).max(100),
  providerType: providerTypeEnum,
  modelId: z.string().min(1).max(200),
  baseUrl: z.string().max(2048).nullable().optional(),
  apiKeyEnvVar: z.string().max(200).nullable().optional(),
  apiKey: z.string().max(8192).nullable().optional(),
  isLocal: z.boolean(),
})

function validateAcpProvider(data: z.infer<typeof createProviderSchema>): string | null {
  if (data.providerType !== 'acp') return null

  if (!isAcpAgentId(data.modelId)) {
    return 'modelId must be a known ACP agent id'
  }
  if (data.baseUrl && data.baseUrl.trim() !== '') {
    return 'baseUrl is not supported for ACP providers'
  }
  if (data.apiKeyEnvVar && data.apiKeyEnvVar.trim() !== '') {
    return 'apiKeyEnvVar is not supported for ACP providers'
  }
  if (data.apiKey && data.apiKey.trim() !== '') {
    return 'apiKey is not supported for ACP providers'
  }

  return null
}

// ---------------------------------------------------------------------------
// GET /api/providers
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const providers = await listActiveProviders()
    return NextResponse.json({ providers: providers.map(toPublicProvider) })
  } catch (err) {
    console.error('[GET /api/providers] Unexpected error', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// ---------------------------------------------------------------------------
// POST /api/providers
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

    const parsed = createProviderSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', fields: parsed.error.flatten().fieldErrors },
        { status: 400 },
      )
    }

    const data = parsed.data
    const acpError = validateAcpProvider(data)
    if (acpError) {
      return NextResponse.json({ error: acpError }, { status: 400 })
    }

    // Conditional validation: baseUrl is required for provider types with a custom endpoint.
    if (requiresProviderBaseUrl(data.providerType) && !data.baseUrl) {
      return NextResponse.json(
        { error: `baseUrl is required for ${data.providerType} providers` },
        { status: 400 },
      )
    }

    const apiKeyCiphertext =
      data.apiKey && data.apiKey.trim() !== '' ? encryptSecret(data.apiKey.trim()) : null

    const [provider] = await db
      .insert(providerConfigs)
      .values({
        displayName: data.displayName,
        providerType: data.providerType,
        modelId: data.modelId,
        baseUrl: data.providerType === 'acp' ? null : data.baseUrl ?? null,
        apiKeyEnvVar: data.providerType === 'acp' ? null : data.apiKeyEnvVar ?? null,
        apiKeyCiphertext,
        isLocal: data.providerType === 'acp' ? true : data.isLocal,
      })
      .returning()

    console.info('[POST /api/providers] Created provider config', { id: provider.id, providerType: provider.providerType })
    return NextResponse.json({ provider: toPublicProvider(provider) }, { status: 201 })
  } catch (err) {
    console.error('[POST /api/providers] Unexpected error', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
