import suiteManifestJson from '@/test-contracts/mcp-admission-v2.json'

export const EPIC_172_S6_SUITE_COMMANDS = Object.freeze({
  contract: 'test:mcp:contract',
  postgres: 'test:mcp:postgres',
  issuance: 'test:mcp:issuance',
  'operator-desktop': 'e2e:mcp-operator',
  'operator-mobile': 'e2e:mcp-operator',
  'host-boundary': 'test:mcp:host-boundary',
} as const)

export type Epic172S6SuitePartitionId = keyof typeof EPIC_172_S6_SUITE_COMMANDS
export type Epic172S6SuiteRunner = 'vitest' | 'playwright'

export type Epic172S6SuitePartition = Readonly<{
  id: Epic172S6SuitePartitionId
  runner: Epic172S6SuiteRunner
  expectedCount: number
  executionKeys: readonly string[]
}>

export type Epic172S6SuiteManifest = Readonly<{
  schemaVersion: 2
  contractVersion: 'mcp-admission-v2'
  partitions: readonly Epic172S6SuitePartition[]
}>

const PARTITION_IDS = Object.freeze(Object.keys(EPIC_172_S6_SUITE_COMMANDS).sort())
const PLAYWRIGHT_PROJECT_BY_PARTITION = Object.freeze({
  'host-boundary': 'mcp-host-boundary',
  issuance: 'mcp-issuance',
  'operator-desktop': 'mcp-operator-desktop',
  'operator-mobile': 'mcp-operator-mobile',
  postgres: 'mcp-postgres',
} satisfies Record<Exclude<Epic172S6SuitePartitionId, 'contract'>, string>)

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} must contain only: ${wanted.join(', ')}.`)
  }
}

function parsePartition(value: unknown, index: number): Epic172S6SuitePartition {
  if (!isRecord(value)) throw new Error(`partitions[${index}] must be an object.`)
  exactKeys(value, ['executionKeys', 'expectedCount', 'id', 'runner'], `partitions[${index}]`)

  const id = value.id
  if (typeof id !== 'string' || !(id in EPIC_172_S6_SUITE_COMMANDS)) {
    throw new Error(`partitions[${index}].id is not a supported partition.`)
  }
  if (value.runner !== 'vitest' && value.runner !== 'playwright') {
    throw new Error(`partition ${id} has an unsupported runner.`)
  }
  if (!Number.isSafeInteger(value.expectedCount) || Number(value.expectedCount) <= 0) {
    throw new Error(`partition ${id} expectedCount must be a positive integer.`)
  }
  if (!Array.isArray(value.executionKeys) || value.executionKeys.length === 0) {
    throw new Error(`partition ${id} must declare at least one execution key.`)
  }

  const executionKeys = value.executionKeys.map((key, keyIndex) => {
    if (
      typeof key !== 'string'
      || key.length > 160
      || key.trim() !== key
      || key.includes('*')
      || key.includes('?')
      || !key.includes('::')
    ) {
      throw new Error(`partition ${id} executionKeys[${keyIndex}] is invalid.`)
    }
    const expectedPrefix = value.runner === 'vitest'
      ? 'vitest::'
      : `${PLAYWRIGHT_PROJECT_BY_PARTITION[id as Exclude<Epic172S6SuitePartitionId, 'contract'>]}::`
    if (!key.startsWith(expectedPrefix)) {
      throw new Error(`partition ${id} execution key ${key} must start with ${expectedPrefix}.`)
    }
    return key
  })

  if (executionKeys.length !== value.expectedCount) {
    throw new Error(`partition ${id} expectedCount does not match executionKeys.length.`)
  }
  const sorted = [...executionKeys].sort()
  if (executionKeys.some((key, keyIndex) => key !== sorted[keyIndex])) {
    throw new Error(`partition ${id} executionKeys must be sorted.`)
  }
  if (new Set(executionKeys).size !== executionKeys.length) {
    throw new Error(`partition ${id} contains a duplicate execution key.`)
  }

  return Object.freeze({
    id: id as Epic172S6SuitePartitionId,
    runner: value.runner,
    expectedCount: Number(value.expectedCount),
    executionKeys: Object.freeze(executionKeys),
  })
}

export function parseEpic172S6SuiteManifest(value: unknown): Epic172S6SuiteManifest {
  if (!isRecord(value)) throw new Error('The MCP admission suite manifest must be an object.')
  exactKeys(value, ['contractVersion', 'partitions', 'schemaVersion'], 'suite manifest')
  if (value.schemaVersion !== 2) throw new Error('The suite manifest schemaVersion must be 2.')
  if (value.contractVersion !== 'mcp-admission-v2') {
    throw new Error('The suite manifest contractVersion must be mcp-admission-v2.')
  }
  if (!Array.isArray(value.partitions)) throw new Error('The suite manifest partitions must be an array.')

  const partitions = value.partitions.map(parsePartition)
  const ids = partitions.map((partition) => partition.id)
  const sortedIds = [...ids].sort()
  if (
    sortedIds.length !== PARTITION_IDS.length
    || sortedIds.some((id, index) => id !== PARTITION_IDS[index])
  ) {
    throw new Error(`The suite manifest must contain exactly: ${PARTITION_IDS.join(', ')}.`)
  }

  const allExecutionKeys = partitions.flatMap((partition) => partition.executionKeys)
  if (new Set(allExecutionKeys).size !== allExecutionKeys.length) {
    throw new Error('Execution keys must be globally unique across all partitions.')
  }

  return Object.freeze({
    schemaVersion: 2,
    contractVersion: 'mcp-admission-v2',
    partitions: Object.freeze(partitions),
  })
}

export const epic172S6SuiteManifest = parseEpic172S6SuiteManifest(suiteManifestJson)

export function getEpic172S6SuitePartition(id: Epic172S6SuitePartitionId): Epic172S6SuitePartition {
  const partition = epic172S6SuiteManifest.partitions.find((candidate) => candidate.id === id)
  if (!partition) throw new Error(`Missing required MCP admission suite partition: ${id}.`)
  return partition
}
