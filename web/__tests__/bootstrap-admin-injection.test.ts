import { describe, expect, it, vi } from 'vitest'

const postgresFactory = vi.hoisted(() => vi.fn())
vi.mock('postgres', () => ({ default: postgresFactory }))

import { openBootstrapAdmin, openBootstrapDatabaseContext } from '@/scripts/ci/bootstrap-database-urls'

describe('protected bootstrap administrator injection', () => {
  it('uses and never closes the injected reserved administrator client', async () => {
    const end = vi.fn()
    const reservedAdmin = Object.assign(vi.fn(), { end })
    const context = await openBootstrapDatabaseContext({
      adminUrl: 'postgresql://unused-admin.invalid/forge',
      migrationUrl: 'postgresql://unused-migrator.invalid/forge',
      adminClient: reservedAdmin as never,
      migrationRole: 'forge_migrator_0123456789abcdef0123456789abcdef',
    })
    expect(context.admin).toBe(reservedAdmin)
    expect(context.migrationRole).toContain('forge_migrator_')
    await context.close()
    const adminOnly = openBootstrapAdmin({ adminUrl: 'postgresql://unused.invalid/forge', adminClient: reservedAdmin as never })
    await adminOnly.close()
    expect(postgresFactory).not.toHaveBeenCalled()
    expect(end).not.toHaveBeenCalled()
  })
})
