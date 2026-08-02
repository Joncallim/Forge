import { getTableColumns, getTableName } from 'drizzle-orm'
import { getTableConfig } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'
import { filesystemMcpIssuanceRecoveryActions } from '@/db/schema'

describe('S4 issuance recovery schema', () => {
  it('maps the optional project decision authorizer to its immutable project authority row', () => {
    const columns = getTableColumns(filesystemMcpIssuanceRecoveryActions)
    expect(columns.authorizingProjectDecisionId).toMatchObject({
      name: 'authorizing_project_decision_id',
      notNull: false,
    })

    const foreignKey = getTableConfig(filesystemMcpIssuanceRecoveryActions).foreignKeys.find((candidate) => (
      candidate.reference().columns.some((column) => column.name === 'authorizing_project_decision_id')
    ))
    expect(foreignKey).toBeDefined()
    expect(getTableName(foreignKey!.reference().foreignTable)).toBe('project_filesystem_grant_decisions')
    expect(foreignKey?.reference().foreignColumns.map((column) => column.name)).toEqual(['id'])
    expect(foreignKey).toMatchObject({ onDelete: 'restrict', onUpdate: 'restrict' })
  })
})
