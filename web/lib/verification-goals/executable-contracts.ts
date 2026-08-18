import { createHash } from 'node:crypto'

import {
  canonicalJson,
  hasExactKeys,
  isPlainRecord,
  type OperationDefinition,
} from '@/lib/operations/contracts'
import { OPERATION_CATALOG } from '@/lib/operations/catalog'
import {
  MAX_VERIFICATION_GOAL_CAPABILITY_LENGTH,
  MAX_VERIFICATION_GOAL_DEFINITION_VERSION,
  MAX_VERIFICATION_GOAL_DESCRIPTION_LENGTH,
  MAX_VERIFICATION_GOAL_ID_LENGTH,
  MAX_VERIFICATION_GOAL_OPERATIONS,
  MAX_VERIFICATION_GOAL_TITLE_LENGTH,
  VERIFICATION_GOAL_SEVERITIES,
  compareVerificationGoalStrings,
  type VerificationGoalOperationReference,
  type VerificationGoalSeverity,
} from './contracts'
import {
  VERIFICATION_GOAL_OPERATION_ELIGIBILITY_VERSION,
  resolveVerificationGoalOperationBinding,
  verificationGoalEligibilityPolicyDigest,
  verificationGoalExecutionBindingDigest,
  type VerificationGoalOperationBindingV1,
  type VerificationGoalTriggerKind,
} from './eligibility'

export const EXECUTABLE_VERIFICATION_GOAL_SCHEMA_VERSION = 2 as const
export const EXECUTABLE_VERIFICATION_GOAL_EXECUTION_SCHEMA_VERSION = 1 as const
export const MAX_EXECUTABLE_GOAL_DEADLINE_SECONDS = 3_600
export const MIN_EXECUTABLE_GOAL_SCHEDULE_INTERVAL_SECONDS = 60
export const MAX_EXECUTABLE_GOAL_SCHEDULE_INTERVAL_SECONDS = 365 * 24 * 60 * 60

export const EXECUTABLE_VERIFICATION_GOAL_KEYS = [
  'capability',
  'definitionVersion',
  'description',
  'enabled',
  'execution',
  'goalId',
  'operations',
  'schemaVersion',
  'severity',
  'title',
] as const

export const EXECUTABLE_VERIFICATION_GOAL_EXECUTION_KEYS = [
  'deadlineSeconds',
  'manual',
  'requiredEvidence',
  'schedule',
] as const

export const EXECUTABLE_VERIFICATION_GOAL_OPERATION_KEYS = [
  'operationId',
  'operationVersion',
] as const

export const EXECUTABLE_VERIFICATION_GOAL_SCHEDULE_KEYS = [
  'everySeconds',
  'kind',
] as const

export const VERIFICATION_GOAL_EVIDENCE_REQUIREMENTS = [
  'canonical_operation_outcomes',
  'execution_environment',
  'operation_evidence',
  'repository_identity',
] as const

export type VerificationGoalEvidenceRequirement = typeof VERIFICATION_GOAL_EVIDENCE_REQUIREMENTS[number]

export type VerificationGoalScheduleDeclarationV1 = null | {
  kind: 'interval'
  everySeconds: number
}

export type VerificationGoalExecutionDeclarationV1 = {
  manual: boolean
  schedule: VerificationGoalScheduleDeclarationV1
  deadlineSeconds: number
  requiredEvidence: VerificationGoalEvidenceRequirement[]
}

export type VerificationGoalDefinitionV2 = {
  schemaVersion: 2
  goalId: string
  definitionVersion: number
  title: string
  description: string
  capability: string
  severity: VerificationGoalSeverity
  enabled: boolean
  operations: VerificationGoalOperationReference[]
  execution: VerificationGoalExecutionDeclarationV1
}

export type VerificationGoalExecutionBindingV1 = {
  schemaVersion: 1
  eligibilityPolicyVersion: 1
  eligibilityPolicyDigest: string
  operations: VerificationGoalOperationBindingV1[]
  executionBindingDigest: string
}

export class ExecutableVerificationGoalContractError extends Error {
  readonly code:
    | 'invalid_definition'
    | 'unknown_operation'
    | 'unsupported_operation'

  constructor(code: ExecutableVerificationGoalContractError['code'], message: string) {
    super(message)
    this.name = 'ExecutableVerificationGoalContractError'
    this.code = code
  }
}

const SAFE_TEXT_CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u
const OPERATION_OR_CAPABILITY_GRAMMAR = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)+$/
const GOAL_ID_GRAMMAR = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/

function invalid(message: string): never {
  throw new ExecutableVerificationGoalContractError('invalid_definition', message)
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

function parseSchedule(value: unknown): VerificationGoalScheduleDeclarationV1 {
  if (value === null) return null
  if (!isPlainRecord(value) || !hasExactKeys(value, EXECUTABLE_VERIFICATION_GOAL_SCHEDULE_KEYS)) {
    return invalid('Verification goal execution schedule must be null or contain exactly kind and everySeconds.')
  }
  if (value.kind !== 'interval') {
    return invalid('Verification goal execution schedule kind must be interval.')
  }
  if (
    !Number.isSafeInteger(value.everySeconds)
    || (value.everySeconds as number) < MIN_EXECUTABLE_GOAL_SCHEDULE_INTERVAL_SECONDS
    || (value.everySeconds as number) > MAX_EXECUTABLE_GOAL_SCHEDULE_INTERVAL_SECONDS
  ) {
    return invalid('Verification goal schedule interval is outside the executable v2 absolute bounds.')
  }
  return {
    kind: 'interval',
    everySeconds: value.everySeconds as number,
  }
}

function parseRequiredEvidence(value: unknown): VerificationGoalEvidenceRequirement[] {
  if (!Array.isArray(value) || value.length > VERIFICATION_GOAL_EVIDENCE_REQUIREMENTS.length) {
    return invalid('Verification goal requiredEvidence must be a bounded array of supported evidence kinds.')
  }
  const evidence = value.map((entry) => {
    if (!VERIFICATION_GOAL_EVIDENCE_REQUIREMENTS.includes(entry as VerificationGoalEvidenceRequirement)) {
      return invalid('Verification goal requiredEvidence contains an unsupported evidence kind.')
    }
    return entry as VerificationGoalEvidenceRequirement
  }).sort(compareVerificationGoalStrings)
  for (let index = 1; index < evidence.length; index += 1) {
    if (evidence[index - 1] === evidence[index]) {
      return invalid(`Verification goal requiredEvidence contains duplicate ${evidence[index]}.`)
    }
  }
  return evidence
}

function parseExecution(value: unknown): VerificationGoalExecutionDeclarationV1 {
  if (!isPlainRecord(value) || !hasExactKeys(value, EXECUTABLE_VERIFICATION_GOAL_EXECUTION_KEYS)) {
    return invalid('Verification goal execution must contain exactly manual, schedule, deadlineSeconds, and requiredEvidence.')
  }
  if (typeof value.manual !== 'boolean') {
    return invalid('Verification goal execution manual must be a boolean.')
  }
  if (
    !Number.isSafeInteger(value.deadlineSeconds)
    || (value.deadlineSeconds as number) < 1
    || (value.deadlineSeconds as number) > MAX_EXECUTABLE_GOAL_DEADLINE_SECONDS
  ) {
    return invalid('Verification goal deadlineSeconds is outside the executable v2 absolute bounds.')
  }
  return {
    manual: value.manual,
    schedule: parseSchedule(value.schedule),
    deadlineSeconds: value.deadlineSeconds as number,
    requiredEvidence: parseRequiredEvidence(value.requiredEvidence),
  }
}

function parseOperationReference(value: unknown): VerificationGoalOperationReference {
  if (!isPlainRecord(value) || !hasExactKeys(value, EXECUTABLE_VERIFICATION_GOAL_OPERATION_KEYS)) {
    return invalid('Each executable verification goal operation must contain exactly operationId and operationVersion.')
  }
  if (
    typeof value.operationId !== 'string'
    || value.operationId.length > MAX_VERIFICATION_GOAL_CAPABILITY_LENGTH
    || !OPERATION_OR_CAPABILITY_GRAMMAR.test(value.operationId)
  ) {
    return invalid('Executable verification goal operationId is invalid.')
  }
  if (
    !Number.isSafeInteger(value.operationVersion)
    || (value.operationVersion as number) < 1
    || (value.operationVersion as number) > MAX_VERIFICATION_GOAL_DEFINITION_VERSION
  ) {
    return invalid('Executable verification goal operationVersion must be a bounded positive integer.')
  }
  return {
    operationId: value.operationId,
    operationVersion: value.operationVersion as number,
  }
}

function executionTrigger(definition: Pick<VerificationGoalDefinitionV2, 'execution'>): VerificationGoalTriggerKind {
  return definition.execution.schedule === null ? 'manual' : 'scheduled'
}

export function buildVerificationGoalExecutionBindingV1(
  definition: VerificationGoalDefinitionV2,
  catalog: ReadonlyMap<string, OperationDefinition> = OPERATION_CATALOG,
): VerificationGoalExecutionBindingV1 {
  const trigger = executionTrigger(definition)
  const operations = definition.operations.map((operation) => {
    try {
      return resolveVerificationGoalOperationBinding({
        operationId: operation.operationId,
        operationVersion: operation.operationVersion,
        goalCapability: definition.capability,
        trigger,
        catalog,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Verification goal operation is not supported.'
      const unknown = /not registered|not supported/i.test(message)
      throw new ExecutableVerificationGoalContractError(
        unknown ? 'unknown_operation' : 'unsupported_operation',
        message,
      )
    }
  })
  const executionBindingDigest = verificationGoalExecutionBindingDigest(operations)
  return {
    schemaVersion: EXECUTABLE_VERIFICATION_GOAL_EXECUTION_SCHEMA_VERSION,
    eligibilityPolicyVersion: VERIFICATION_GOAL_OPERATION_ELIGIBILITY_VERSION,
    eligibilityPolicyDigest: verificationGoalEligibilityPolicyDigest(),
    operations,
    executionBindingDigest,
  }
}

export function parseExecutableVerificationGoalDefinition(
  value: unknown,
  catalog: ReadonlyMap<string, OperationDefinition> = OPERATION_CATALOG,
): VerificationGoalDefinitionV2 {
  if (!isPlainRecord(value) || !hasExactKeys(value, EXECUTABLE_VERIFICATION_GOAL_KEYS)) {
    return invalid('Executable verification goal must contain exactly the v2 definition keys.')
  }
  if (value.schemaVersion !== EXECUTABLE_VERIFICATION_GOAL_SCHEMA_VERSION) {
    return invalid('Executable verification goal schemaVersion must be 2.')
  }
  if (
    typeof value.goalId !== 'string'
    || value.goalId.length > MAX_VERIFICATION_GOAL_ID_LENGTH
    || !GOAL_ID_GRAMMAR.test(value.goalId)
  ) {
    return invalid('Executable verification goal goalId is invalid.')
  }
  if (
    !Number.isSafeInteger(value.definitionVersion)
    || (value.definitionVersion as number) < 1
    || (value.definitionVersion as number) > MAX_VERIFICATION_GOAL_DEFINITION_VERSION
  ) {
    return invalid('Executable verification goal definitionVersion must be a bounded positive integer.')
  }
  if (!isBoundedText(value.title, MAX_VERIFICATION_GOAL_TITLE_LENGTH, { singleLine: true })) {
    return invalid('Executable verification goal title must be bounded, printable, non-empty single-line text.')
  }
  if (!isBoundedText(value.description, MAX_VERIFICATION_GOAL_DESCRIPTION_LENGTH)) {
    return invalid('Executable verification goal description must be bounded, printable, non-empty text.')
  }
  if (
    typeof value.capability !== 'string'
    || value.capability.length > MAX_VERIFICATION_GOAL_CAPABILITY_LENGTH
    || !OPERATION_OR_CAPABILITY_GRAMMAR.test(value.capability)
  ) {
    return invalid('Executable verification goal capability is invalid.')
  }
  if (!VERIFICATION_GOAL_SEVERITIES.includes(value.severity as VerificationGoalSeverity)) {
    return invalid('Executable verification goal severity must be low, medium, high, or critical.')
  }
  if (typeof value.enabled !== 'boolean') {
    return invalid('Executable verification goal enabled must be a boolean.')
  }
  if (
    !Array.isArray(value.operations)
    || value.operations.length < 1
    || value.operations.length > MAX_VERIFICATION_GOAL_OPERATIONS
  ) {
    return invalid(`Executable verification goal operations must contain between 1 and ${MAX_VERIFICATION_GOAL_OPERATIONS} references.`)
  }

  const execution = parseExecution(value.execution)
  if (value.enabled && !execution.manual && execution.schedule === null) {
    return invalid('An enabled executable verification goal must allow manual execution or declare a schedule.')
  }

  const operations = value.operations.map(parseOperationReference)
  operations.sort((left, right) => compareVerificationGoalStrings(left.operationId, right.operationId)
    || left.operationVersion - right.operationVersion)
  for (let index = 1; index < operations.length; index += 1) {
    const previous = operations[index - 1]!
    const current = operations[index]!
    if (
      previous.operationId === current.operationId
      && previous.operationVersion === current.operationVersion
    ) {
      return invalid(`Executable verification goal contains duplicate operation ${current.operationId}@${current.operationVersion}.`)
    }
  }

  const definition: VerificationGoalDefinitionV2 = {
    schemaVersion: EXECUTABLE_VERIFICATION_GOAL_SCHEMA_VERSION,
    goalId: value.goalId,
    definitionVersion: value.definitionVersion as number,
    title: value.title,
    description: value.description,
    capability: value.capability,
    severity: value.severity as VerificationGoalSeverity,
    enabled: value.enabled,
    operations,
    execution,
  }

  // Validation of code-owned eligibility and operation semantics is part of the
  // parser contract: an executable definition is not valid merely because its
  // JSON shape is well formed.
  buildVerificationGoalExecutionBindingV1(definition, catalog)
  return definition
}

export function executableVerificationGoalDefinitionDigest(definition: VerificationGoalDefinitionV2): string {
  return createHash('sha256')
    .update('forge:verification-goal:definition:v2\0', 'utf8')
    .update(canonicalJson(definition), 'utf8')
    .digest('hex')
}
