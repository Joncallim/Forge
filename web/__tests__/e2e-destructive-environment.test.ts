import { describe, expect, it } from 'vitest'
import { resolveDestructiveE2EEnvironment } from '@/e2e/destructive-environment'
import { resetState } from '@/e2e/helpers'

const validEnvironment = {
  FORGE_E2E_ALLOW_DESTRUCTIVE_RESET: '1',
  FORGE_E2E_DATABASE_URL: 'postgresql://forge_e2e:secret@localhost:5432/forge_e2e',
  FORGE_E2E_REDIS_URL: 'redis://localhost:6379/15',
}

describe('destructive E2E environment guard', () => {
  it('blocks resetState before opening destructive clients when opt-in is absent', async () => {
    const names = [
      'FORGE_E2E_ALLOW_DESTRUCTIVE_RESET',
      'FORGE_E2E_DATABASE_URL',
      'FORGE_E2E_REDIS_URL',
      'DATABASE_URL',
      'REDIS_URL',
    ] as const
    const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]))
    names.forEach((name) => delete process.env[name])
    try {
      await expect(resetState()).rejects.toThrow(/ALLOW_DESTRUCTIVE_RESET=1/)
    } finally {
      names.forEach((name) => {
        const value = previous[name]
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      })
    }
  })

  it('requires explicit destructive-reset opt-in and dedicated URLs', () => {
    expect(() => resolveDestructiveE2EEnvironment({})).toThrow(/ALLOW_DESTRUCTIVE_RESET=1/)
    expect(() => resolveDestructiveE2EEnvironment({
      ...validEnvironment,
      FORGE_E2E_ALLOW_DESTRUCTIVE_RESET: undefined,
      DATABASE_URL: 'postgresql://forge:secret@localhost:5432/forge',
      REDIS_URL: 'redis://localhost:6379/0',
    })).toThrow(/ALLOW_DESTRUCTIVE_RESET=1/)
    expect(() => resolveDestructiveE2EEnvironment({
      FORGE_E2E_ALLOW_DESTRUCTIVE_RESET: '1',
    })).toThrow(/FORGE_E2E_DATABASE_URL is required/)
    expect(() => resolveDestructiveE2EEnvironment({
      FORGE_E2E_ALLOW_DESTRUCTIVE_RESET: '1',
      FORGE_E2E_DATABASE_URL: validEnvironment.FORGE_E2E_DATABASE_URL,
    })).toThrow(/FORGE_E2E_REDIS_URL is required/)
  })

  it('rejects normal PostgreSQL identities and Redis database zero', () => {
    expect(() => resolveDestructiveE2EEnvironment({
      ...validEnvironment,
      FORGE_E2E_DATABASE_URL: 'postgresql://forge:secret@localhost:5432/forge',
    })).toThrow(/dedicated E2E\/test user and database names/)
    expect(() => resolveDestructiveE2EEnvironment({
      ...validEnvironment,
      FORGE_E2E_REDIS_URL: 'redis://localhost:6379/0',
    })).toThrow(/dedicated nonzero Redis database/)
  })

  it('rejects runtime URLs that differ from the dedicated test identities', () => {
    expect(() => resolveDestructiveE2EEnvironment({
      ...validEnvironment,
      DATABASE_URL: 'postgresql://forge:secret@localhost:5432/forge',
    })).toThrow(/DATABASE_URL must match/)
    expect(() => resolveDestructiveE2EEnvironment({
      ...validEnvironment,
      REDIS_URL: 'redis://localhost:6379/0',
    })).toThrow(/REDIS_URL must match/)
  })

  it('accepts matching dedicated PostgreSQL and Redis identities', () => {
    expect(resolveDestructiveE2EEnvironment({
      ...validEnvironment,
      DATABASE_URL: validEnvironment.FORGE_E2E_DATABASE_URL,
      REDIS_URL: validEnvironment.FORGE_E2E_REDIS_URL,
    })).toEqual({
      databaseUrl: validEnvironment.FORGE_E2E_DATABASE_URL,
      redisUrl: validEnvironment.FORGE_E2E_REDIS_URL,
    })
  })
})
