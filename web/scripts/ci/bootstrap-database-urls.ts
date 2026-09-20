import { getRequiredEnv } from '@/lib/env'
import postgres from 'postgres'

export type BootstrapDatabaseUrls = Readonly<{
  adminUrl: string
  migrationUrl: string
  adminClient?: ReturnType<typeof postgres>
  migrationRole?: string
}>

export type BootstrapAdminInput = Readonly<{
  adminUrl: string
  adminClient?: ReturnType<typeof postgres>
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

export async function openBootstrapDatabaseContext(explicit?: BootstrapDatabaseUrls): Promise<Readonly<{
  admin: ReturnType<typeof postgres>
  migrationRole: string
  close: () => Promise<void>
}>> {
  const { adminUrl, migrationUrl } = resolveBootstrapDatabaseUrls(explicit)
  let migrationRole = explicit?.migrationRole
  if (!migrationRole) {
    const migration = postgres(migrationUrl, { max: 1, onnotice: () => {} })
    try {
      ;[{ migrationRole }] = await migration<{ migrationRole: string }[]>`select current_user as "migrationRole"`
    } finally {
      await migration.end({ timeout: 5 })
    }
  }
  if (!migrationRole) throw new Error('Protected bootstrap could not identify its migration role.')
  const ownedAdmin = !explicit?.adminClient
  const admin = explicit?.adminClient ?? postgres(adminUrl, { max: 1, onnotice: () => {} })
  return { admin, migrationRole, close: async () => { if (ownedAdmin) await admin.end({ timeout: 5 }) } }
}

export function openBootstrapAdmin(explicit?: BootstrapAdminInput): Readonly<{
  admin: ReturnType<typeof postgres>
  close: () => Promise<void>
}> {
  const ownedAdmin = !explicit?.adminClient
  const admin = explicit?.adminClient ?? postgres(resolveBootstrapAdminUrl(explicit), { max: 1, onnotice: () => {} })
  return { admin, close: async () => { if (ownedAdmin) await admin.end({ timeout: 5 }) } }
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
