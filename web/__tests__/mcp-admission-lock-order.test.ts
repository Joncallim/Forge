import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  assertMcpAdmissionLockSequence,
  isMcpAdmissionLockSequence,
  MCP_ADMISSION_LOCK_ORDER,
  type McpAdmissionLockFamily,
} from '@/lib/mcps/mcp-admission-lock-order'

function adrLockOrder(): unknown {
  const adr = fs.readFileSync(
    path.resolve(process.cwd(), '../docs/adr/0009-mcp-admission-contract.md'),
    'utf8',
  )
  const anchor = '<a id="canonical-cross-slice-database-lock-order"></a>'
  const section = adr.slice(adr.indexOf(anchor))
  const match = section.match(/```json\r?\n\s*({[\s\S]*?})\r?\n\s*```/)
  if (!match) throw new Error('ADR 0009 lock-order JSON block is missing')
  return JSON.parse(match[1])
}

describe('MCP admission lock order v2', () => {
  it('is byte-for-meaning equal to the normative ADR object', () => {
    expect(MCP_ADMISSION_LOCK_ORDER).toEqual(adrLockOrder())
  })

  it('accepts the complete order and ordered subsequences', () => {
    expect(() => assertMcpAdmissionLockSequence(MCP_ADMISSION_LOCK_ORDER.families)).not.toThrow()
    expect(isMcpAdmissionLockSequence([
      'project',
      'work-packages:id-ascending',
      'grant-approval-decision-rows:id-ascending',
      'review-gates:id-ascending',
    ])).toBe(true)
    expect(isMcpAdmissionLockSequence([])).toBe(true)
  })

  it.each([
    [['tasks:id-ascending', 'project'], 'reverse order'],
    [['project', 'project'], 'duplicate'],
    [['project', 'made-up-family'], 'unknown family'],
  ])('rejects %s (%s)', (families) => {
    expect(isMcpAdmissionLockSequence(families)).toBe(false)
    expect(() => assertMcpAdmissionLockSequence(
      families as readonly McpAdmissionLockFamily[],
    )).toThrow()
  })

  it('fails parity when any family is deleted, renamed, duplicated, or swapped', () => {
    const original = adrLockOrder() as typeof MCP_ADMISSION_LOCK_ORDER
    const mutations = [
      { ...original, families: original.families.slice(1) },
      { ...original, families: original.families.map((family, index) => index === 2 ? `${family}-renamed` : family) },
      { ...original, families: [original.families[0], ...original.families] },
      { ...original, families: [original.families[1], original.families[0], ...original.families.slice(2)] },
    ]
    for (const mutation of mutations) expect(mutation).not.toEqual(MCP_ADMISSION_LOCK_ORDER)
  })
})
