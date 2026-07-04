import { describe, expect, it } from 'vitest'
import {
  accessibleProjectCondition,
  accessibleProjectOwnerCondition,
} from '@/lib/project-access'

function flattenSqlChunks(value: unknown): string {
  if (typeof value === 'string') return value
  if (!value || typeof value !== 'object') return ''
  if (Array.isArray((value as { value?: unknown }).value)) {
    return ((value as { value: unknown[] }).value).map(flattenSqlChunks).join('')
  }
  if (Array.isArray((value as { queryChunks?: unknown[] }).queryChunks)) {
    return (value as { queryChunks: unknown[] }).queryChunks.map(flattenSqlChunks).join('')
  }
  if (typeof (value as { name?: unknown }).name === 'string') {
    return String((value as { name: string }).name)
  }
  return ''
}

describe('project access ownership conditions', () => {
  it('does not treat null submitted_by as shared access in the owner filter', () => {
    const sqlText = flattenSqlChunks(accessibleProjectOwnerCondition('user-abc')).toLowerCase()
    expect(sqlText).toContain('submitted_by')
    expect(sqlText).not.toContain('is null')
  })

  it('requires both the project id and matching owner for direct project access', () => {
    const sqlText = flattenSqlChunks(
      accessibleProjectCondition('project-123', 'user-abc'),
    ).toLowerCase()
    expect(sqlText).toContain('submitted_by')
    expect(sqlText).toContain('id')
    expect(sqlText).not.toContain('is null')
  })
})
