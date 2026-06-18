import { NextResponse } from 'next/server'
import { db } from '@/db'
import { redis } from '@/lib/redis'
import { sql } from 'drizzle-orm'
import { listActiveProviders } from '@/lib/providers/registry'
import { checkProviderHealth } from '@/lib/providers/health'
import { checkRuntimeEnv } from '@/lib/env'

export async function GET() {
  const env = checkRuntimeEnv()
  const envOk = env.every((check) => check.present)
  const checks = await Promise.allSettled([
    db.execute(sql`SELECT 1`),
    redis.ping(),
  ])

  const postgres = checks[0].status === 'fulfilled'
  const redisOk = checks[1].status === 'fulfilled'

  // Check all active providers (each has its own 3s internal timeout)
  let providers: { id: string; displayName: string; reachable: boolean }[] = []
  try {
    const activeProviders = await listActiveProviders()
    providers = await Promise.all(
      activeProviders.map(async (p) => {
        const h = await checkProviderHealth(p)
        return { id: p.id, displayName: p.displayName, reachable: h.reachable }
      }),
    )
  } catch (err) {
    console.error('[GET /api/health] Failed to check provider health', err)
  }

  const allProvidersReachable = providers.length === 0 || providers.every((p) => p.reachable)
  const status = postgres && redisOk && envOk && allProvidersReachable
    ? 'ok'
    : postgres && redisOk
      ? 'degraded'
      : 'down'

  return NextResponse.json(
    {
      status,
      env,
      postgres: { connected: postgres },
      redis: { connected: redisOk },
      providers,
    },
    { status: status === 'down' ? 503 : 200 },
  )
}
