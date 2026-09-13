import { getRequiredEnv } from '@/lib/env'

export type BootstrapDatabaseUrls = Readonly<{
  adminUrl: string
  migrationUrl: string
}>

export function resolveBootstrapDatabaseUrls(explicit?: BootstrapDatabaseUrls): BootstrapDatabaseUrls {
  if (explicit) return explicit
  const adminUrl = process.env.FORGE_DATABASE_ADMIN_URL?.trim()
  if (!adminUrl) throw new Error('FORGE_DATABASE_ADMIN_URL is required for this protected-role bootstrap.')
  return { adminUrl, migrationUrl: getRequiredEnv('DATABASE_URL') }
}

export function resolveBootstrapAdminUrl(explicit?: Readonly<{ adminUrl: string }>): string {
  if (explicit) return explicit.adminUrl
  return process.env.FORGE_DATABASE_ADMIN_URL?.trim() || getRequiredEnv('DATABASE_URL')
}

/** Detect ambient credential-channel mutation while an explicitly injected
 * bootstrap is pending, including across timer/microtask interleavings. */
export async function runWithDatabaseUrlSentinel<T>(operation: () => Promise<T>): Promise<T> {
  const expected = process.env.DATABASE_URL
  let changed = false
  const observe = () => { if (process.env.DATABASE_URL !== expected) changed = true }
  const interval = setInterval(observe, 0)
  try {
    const result = await operation()
    observe()
    if (changed) throw new Error('A protected bootstrap mutated ambient DATABASE_URL while it was pending.')
    return result
  } finally {
    clearInterval(interval)
  }
}
