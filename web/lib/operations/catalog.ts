import {
  OPERATION_DEFINITION_SCHEMA_VERSION,
  OperationContractError,
  hasExactKeys,
  type OperationDefinition,
  type OperationRequest,
} from './contracts'

const EMPTY_INPUT_KEYS = [] as const

export const BUILT_IN_OPERATIONS = [
  {
    schemaVersion: OPERATION_DEFINITION_SCHEMA_VERSION,
    id: 'repository.status.read',
    version: 1,
    description: 'Read the current bounded Git repository status for the trusted project.',
    capability: 'filesystem.project.read',
    risk: 'read_only',
    inputKeys: EMPTY_INPUT_KEYS,
    scope: 'trusted_project',
    requiredPolicyCeiling: 'repository_read',
    adapter: 'repository_status_read_v1',
    timeoutMs: 30_000,
    verification: 'deterministic_adapter',
    recovery: 'none_read_only',
    approvalRequired: false,
    independentVerificationRequired: false,
    audit: { persistInputs: false, fingerprint: 'sha256', reasonUse: 'audit_only' },
    enabled: true,
    deprecated: false,
  },
  {
    schemaVersion: OPERATION_DEFINITION_SCHEMA_VERSION,
    id: 'repository.diff.summary',
    version: 1,
    description: 'Read a bounded diff-stat summary for the trusted project working tree.',
    capability: 'filesystem.project.read',
    risk: 'read_only',
    inputKeys: EMPTY_INPUT_KEYS,
    scope: 'trusted_project',
    requiredPolicyCeiling: 'repository_read',
    adapter: 'repository_diff_summary_v1',
    timeoutMs: 30_000,
    verification: 'deterministic_adapter',
    recovery: 'none_read_only',
    approvalRequired: false,
    independentVerificationRequired: false,
    audit: { persistInputs: false, fingerprint: 'sha256', reasonUse: 'audit_only' },
    enabled: true,
    deprecated: false,
  },
  {
    schemaVersion: OPERATION_DEFINITION_SCHEMA_VERSION,
    id: 'repository.branch.read',
    version: 1,
    description: 'Read the current branch name for the trusted Git repository.',
    capability: 'filesystem.project.read',
    risk: 'read_only',
    inputKeys: EMPTY_INPUT_KEYS,
    scope: 'trusted_project',
    requiredPolicyCeiling: 'repository_read',
    adapter: 'repository_branch_read_v1',
    timeoutMs: 30_000,
    verification: 'deterministic_adapter',
    recovery: 'none_read_only',
    approvalRequired: false,
    independentVerificationRequired: false,
    audit: { persistInputs: false, fingerprint: 'sha256', reasonUse: 'audit_only' },
    enabled: true,
    deprecated: false,
  },
] as const satisfies readonly OperationDefinition[]

function definitionKey(definition: Pick<OperationDefinition, 'id' | 'version'>): string {
  return `${definition.id}@${definition.version}`
}

export function createOperationCatalog(
  definitions: readonly OperationDefinition[],
): ReadonlyMap<string, OperationDefinition> {
  const catalog = new Map<string, OperationDefinition>()
  for (const definition of definitions) {
    if (definition.schemaVersion !== OPERATION_DEFINITION_SCHEMA_VERSION) {
      throw new Error(`Unsupported operation definition schema for ${definition.id}.`)
    }
    if (!Number.isSafeInteger(definition.version) || definition.version < 1) {
      throw new Error(`Invalid operation version for ${definition.id}.`)
    }
    if (definition.risk !== 'read_only' || definition.recovery !== 'none_read_only') {
      throw new Error(`The v1 operation catalog only accepts read-only operations: ${definition.id}.`)
    }
    if (definition.audit.persistInputs || definition.audit.reasonUse !== 'audit_only') {
      throw new Error(`The v1 operation audit contract is not safe for ${definition.id}.`)
    }
    const key = definitionKey(definition)
    if (catalog.has(key)) throw new Error(`Duplicate operation definition: ${key}.`)
    catalog.set(key, Object.freeze({ ...definition, inputKeys: Object.freeze([...definition.inputKeys]) }))
  }
  return catalog
}

export const OPERATION_CATALOG = createOperationCatalog(BUILT_IN_OPERATIONS)

export function resolveOperationDefinition(
  request: Pick<OperationRequest, 'operationId' | 'operationVersion'>,
  catalog: ReadonlyMap<string, OperationDefinition> = OPERATION_CATALOG,
): OperationDefinition {
  const definition = catalog.get(`${request.operationId}@${request.operationVersion}`)
  if (definition) return definition
  const knownId = [...catalog.values()].some((candidate) => candidate.id === request.operationId)
  throw new OperationContractError(
    knownId ? 'unsupported_version' : 'unknown_operation',
    knownId ? 'Requested operation version is not supported.' : 'Requested operation is not registered.',
  )
}

export function validateOperationInputs(
  definition: OperationDefinition,
  inputs: Record<string, unknown>,
): void {
  if (!hasExactKeys(inputs, definition.inputKeys)) {
    throw new OperationContractError('invalid_request', `Inputs do not match ${definition.id}@${definition.version}.`)
  }
}
