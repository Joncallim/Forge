import { createHash } from 'node:crypto'

import {
  canonicalJson,
  hasExactKeys,
  isPlainRecord,
  type OperationDefinition,
} from '@/lib/operations/contracts'
import {
  OPERATION_CATALOG,
  resolveOperationDefinition,
} from '@/lib/operations/catalog'

export const VERIFICATION_GOAL_SCHEMA_VERSION = 1 as const
export const VERIFICATION_GOAL_KEYS = [
  'capability',
  'definitionVersion',
  'description',
  'enabled',
  'goalId',
  'operations',
  'schemaVersion',
  'severity',
  'title',
] as const
export const VERIFICATION_GOAL_OPERATION_KEYS = [
  'operationId',
  'operationVersion',
] as const

export const VERIFICATION_GOAL_SEVERITIES = [
  'low',
  'medium',
  'high',
  'critical',
] as const

export const MAX_VERIFICATION_GOAL_ID_LENGTH = 64
export const MAX_VERIFICATION_GOAL_DEFINITION_VERSION = 1_000_000
export const MAX_VERIFICATION_GOAL_TITLE_LENGTH = 160
export const MAX_VERIFICATION_GOAL_DESCRIPTION_LENGTH = 2_000
export const MAX_VERIFICATION_GOAL_CAPABILITY_LENGTH = 200
export const MAX_VERIFICATION_GOAL_OPERATIONS = 16

export type VerificationGoalSeverity = typeof VERIFICATION_GOAL_SEVERITIES[number]

export type VerificationGoalOperationReference = {
  operationId: string
  operationVersion: number
}

export type VerificationGoalDefinition = {
  schemaVersion: 1
  goalId: string
  definitionVersion: number
  title: string
  description: string
  capability: string
  severity: VerificationGoalSeverity
  enabled: boolean
  operations: VerificationGoalOperationReference[]
}

export class VerificationGoalContractError extends Error {
  readonly code:
    | 'invalid_definition'
    | 'unknown_operation'
    | 'unsupported_operation'

  constructor(code: VerificationGoalContractError['code'], message: string) {
    super(message)
    this.name = 'VerificationGoalContractError'
    this.code = code
  }
}

const SAFE_TEXT_CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u
const OPERATION_OR_CAPABILITY_GRAMMAR = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)+$/
const GOAL_ID_GRAMMAR = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/

/** Locale-independent ordering for canonical identities. */
export function compareVerificationGoalStrings(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

function invalid(message: string): never {
  throw new VerificationGoalContractError('invalid_definition', message)
}

function isBoundedText(
  value: unknown,
  maximumLength: number,
  options: { singleLine?: boolean } = {},
): value is string {
  return typeof value === 'string'
    && value.trim().length > 0
    && value.length <= maximumLength
    && !SAFE_TEXT_CONTROL_CHARACTERS.test(value)
    && (!options.singleLine || !/[\r\n]/u.test(value))
}

function parseOperationReference(
  value: unknown,
  goalCapability: string,
  catalog: ReadonlyMap<string, OperationDefinition>,
): VerificationGoalOperationReference {
  if (!isPlainRecord(value) || !hasExactKeys(value, VERIFICATION_GOAL_OPERATION_KEYS)) {
    return invalid('Each verification goal operation must contain exactly operationId and operationVersion.')
  }
  if (
    typeof value.operationId !== 'string'
    || value.operationId.length > MAX_VERIFICATION_GOAL_CAPABILITY_LENGTH
    || !OPERATION_OR_CAPABILITY_GRAMMAR.test(value.operationId)
  ) {
    return invalid('Verification goal operationId is invalid.')
  }
  if (
    !Number.isSafeInteger(value.operationVersion)
    || (value.operationVersion as number) < 1
    || (value.operationVersion as number) > MAX_VERIFICATION_GOAL_DEFINITION_VERSION
  ) {
    return invalid('Verification goal operationVersion must be a bounded positive integer.')
  }

  let definition: OperationDefinition
  try {
    definition = resolveOperationDefinition({
      operationId: value.operationId,
      operationVersion: value.operationVersion as number,
    }, catalog)
  } catch (error) {
    throw new VerificationGoalContractError(
      'unknown_operation',
      error instanceof Error ? error.message : 'Verification goal operation is not registered.',
    )
  }
  if (!definition.enabled || definition.deprecated) {
    throw new VerificationGoalContractError(
      'unsupported_operation',
      `Verification goal operation ${definition.id}@${definition.version} is disabled or deprecated.`,
    )
  }
  if (definition.capability !== goalCapability) {
    throw new VerificationGoalContractError(
      'unsupported_operation',
      `Verification goal operation ${definition.id}@${definition.version} does not match the goal capability.`,
    )
  }
  if (definition.inputKeys.length !== 0) {
    throw new VerificationGoalContractError(
      'unsupported_operation',
      `Verification goal operation ${definition.id}@${definition.version} requires inputs, which v1 goals cannot provide.`,
    )
  }

  return {
    operationId: definition.id,
    operationVersion: definition.version,
  }
}

/**
 * Parses the declarative v1 goal format. It deliberately accepts references
 * only: operation inputs, commands, paths, adapters, and policy overrides are
 * unknown keys and therefore fail closed before any persistence or execution.
 */
export function parseVerificationGoalDefinition(
  value: unknown,
  catalog: ReadonlyMap<string, OperationDefinition> = OPERATION_CATALOG,
): VerificationGoalDefinition {
  if (!isPlainRecord(value) || !hasExactKeys(value, VERIFICATION_GOAL_KEYS)) {
    return invalid('Verification goal must contain exactly the v1 definition keys.')
  }
  if (value.schemaVersion !== VERIFICATION_GOAL_SCHEMA_VERSION) {
    return invalid('Verification goal schemaVersion must be 1.')
  }
  if (
    typeof value.goalId !== 'string'
    || value.goalId.length > MAX_VERIFICATION_GOAL_ID_LENGTH
    || !GOAL_ID_GRAMMAR.test(value.goalId)
  ) {
    return invalid('Verification goal goalId is invalid.')
  }
  if (
    !Number.isSafeInteger(value.definitionVersion)
    || (value.definitionVersion as number) < 1
    || (value.definitionVersion as number) > MAX_VERIFICATION_GOAL_DEFINITION_VERSION
  ) {
    return invalid('Verification goal definitionVersion must be a bounded positive integer.')
  }
  if (!isBoundedText(value.title, MAX_VERIFICATION_GOAL_TITLE_LENGTH, { singleLine: true })) {
    return invalid('Verification goal title must be bounded, printable, non-empty single-line text.')
  }
  if (!isBoundedText(value.description, MAX_VERIFICATION_GOAL_DESCRIPTION_LENGTH)) {
    return invalid('Verification goal description must be bounded, printable, non-empty text.')
  }
  if (
    typeof value.capability !== 'string'
    || value.capability.length > MAX_VERIFICATION_GOAL_CAPABILITY_LENGTH
    || !OPERATION_OR_CAPABILITY_GRAMMAR.test(value.capability)
  ) {
    return invalid('Verification goal capability is invalid.')
  }
  if (!VERIFICATION_GOAL_SEVERITIES.includes(value.severity as VerificationGoalSeverity)) {
    return invalid('Verification goal severity must be low, medium, high, or critical.')
  }
  if (typeof value.enabled !== 'boolean') {
    return invalid('Verification goal enabled must be a boolean.')
  }
  if (
    !Array.isArray(value.operations)
    || value.operations.length < 1
    || value.operations.length > MAX_VERIFICATION_GOAL_OPERATIONS
  ) {
    return invalid(`Verification goal operations must contain between 1 and ${MAX_VERIFICATION_GOAL_OPERATIONS} references.`)
  }

  const operations = value.operations.map((reference) => parseOperationReference(
    reference,
    value.capability as string,
    catalog,
  ))
  operations.sort((left, right) => compareVerificationGoalStrings(left.operationId, right.operationId)
    || left.operationVersion - right.operationVersion)
  for (let index = 1; index < operations.length; index += 1) {
    const previous = operations[index - 1]!
    const current = operations[index]!
    if (
      previous.operationId === current.operationId
      && previous.operationVersion === current.operationVersion
    ) {
      return invalid(`Verification goal contains duplicate operation ${current.operationId}@${current.operationVersion}.`)
    }
  }

  return {
    schemaVersion: VERIFICATION_GOAL_SCHEMA_VERSION,
    goalId: value.goalId,
    definitionVersion: value.definitionVersion as number,
    title: value.title,
    description: value.description,
    capability: value.capability,
    severity: value.severity as VerificationGoalSeverity,
    enabled: value.enabled,
    operations,
  }
}

/** Stable, domain-separated digest of the validated canonical definition. */
export function verificationGoalDefinitionDigest(definition: VerificationGoalDefinition): string {
  return createHash('sha256')
    .update('forge:verification-goal:definition:v1\0', 'utf8')
    .update(canonicalJson(definition), 'utf8')
    .digest('hex')
}
