import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { db } from '@/db'
import { providerConfigs } from '@/db/schema'
import { getSession } from '@/lib/session'
import { listActiveProviders } from '@/lib/providers/registry'
import { PROVIDER_TYPES, requiresProviderBaseUrl } from '@/lib/providers/types'

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
  isLocal: z.boolean(),
})

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
    return NextResponse.json({ providers })
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

    // Conditional validation: baseUrl is required for provider types with a custom endpoint.
    if (requiresProviderBaseUrl(data.providerType) && !data.baseUrl) {
      return NextResponse.json(
        { error: `baseUrl is required for ${data.providerType} providers` },
        { status: 400 },
      )
    }

    const [provider] = await db
      .insert(providerConfigs)
      .values({
        displayName: data.displayName,
        providerType: data.providerType,
        modelId: data.modelId,
        baseUrl: data.baseUrl ?? null,
        apiKeyEnvVar: data.apiKeyEnvVar ?? null,
        isLocal: data.isLocal,
      })
      .returning()

    console.info('[POST /api/providers] Created provider config', { id: provider.id, providerType: provider.providerType })
    return NextResponse.json({ provider }, { status: 201 })
  } catch (err) {
    console.error('[POST /api/providers] Unexpected error', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
