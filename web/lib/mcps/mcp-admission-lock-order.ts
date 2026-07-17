import lockOrder from './mcp-admission-lock-order-v2.json'

export const MCP_ADMISSION_LOCK_ORDER = lockOrder

export type McpAdmissionLockFamily = typeof lockOrder.families[number]

const familyIndexes = new Map<string, number>(
  lockOrder.families.map((family, index) => [family, index]),
)

/**
 * Proves that a transaction's declared lock families are a unique, ordered
 * subsequence of ADR 0009's complete version-2 contract.
 */
export function assertMcpAdmissionLockSequence(
  families: readonly McpAdmissionLockFamily[],
): void {
  const seen = new Set<string>()
  let previousIndex = -1

  for (const family of families) {
    const index = familyIndexes.get(family)
    if (index === undefined) {
      throw new Error(`Unknown MCP admission lock family: ${String(family)}`)
    }
    if (seen.has(family)) {
      throw new Error(`Duplicate MCP admission lock family: ${family}`)
    }
    if (index <= previousIndex) {
      throw new Error(`MCP admission lock family is out of order: ${family}`)
    }
    seen.add(family)
    previousIndex = index
  }
}

export function isMcpAdmissionLockSequence(
  families: readonly string[],
): families is readonly McpAdmissionLockFamily[] {
  try {
    assertMcpAdmissionLockSequence(families as readonly McpAdmissionLockFamily[])
    return true
  } catch {
    return false
  }
}
