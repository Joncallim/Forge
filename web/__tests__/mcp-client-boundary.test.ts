import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('MCP branded presentation client boundary', () => {
  it('keeps the client task page on the pure branded view and the server wrapper on the same view', async () => {
    const [taskPage, serverWrapper] = await Promise.all([
      readFile('app/dashboard/tasks/[id]/page.tsx', 'utf8'),
      readFile('components/mcps/BrandedTerminalJoin.tsx', 'utf8'),
    ])

    expect(taskPage).toContain("from '@/components/mcps/BrandedTerminalJoinView'")
    expect(taskPage).not.toContain("from '@/components/mcps/BrandedTerminalJoin'")
    expect(serverWrapper).toContain("import 'server-only'")
    expect(serverWrapper).toContain("from './BrandedTerminalJoinView'")
  })
})
