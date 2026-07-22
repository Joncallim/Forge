import { describe, expect, it } from 'vitest'
import { fixedDatabaseRoleUrl } from '@/lib/mcps/fixed-database-url'

describe('fixed database role URLs', () => {
  it('accepts a passwordless PostgreSQL URL for the exact fixed role', () => {
    const value = 'postgresql://forge_review_source_resolver@db.internal:5432/forge?sslmode=require'
    expect(fixedDatabaseRoleUrl({
      environmentName: 'FORGE_REVIEW_SOURCE_RESOLVER_DATABASE_URL',
      expectedUsername: 'forge_review_source_resolver',
      value,
    })).toBe(value)
  })

  for (const value of [
    'https://forge_review_source_resolver@db.internal/forge',
    'postgresql://postgres@db.internal/forge',
    'postgresql://forge_review_source_resolver:secret@db.internal/forge',
    'postgresql://forge_review_source_resolver@db.internal/forge?password=secret',
    'postgresql://forge_review_source_resolver@db.internal/forge?PASS=secret',
    'postgresql://forge_review_source_resolver@db.internal/forge?pwd=secret',
    'postgresql://forge_review_source_resolver@db.internal/forge#secret',
  ]) {
    it(`rejects unsafe fixed-role URL ${value}`, () => {
      expect(() => fixedDatabaseRoleUrl({
        environmentName: 'FORGE_REVIEW_SOURCE_RESOLVER_DATABASE_URL',
        expectedUsername: 'forge_review_source_resolver',
        value,
      })).toThrow(/passwordless PostgreSQL URL/i)
    })
  }
})
