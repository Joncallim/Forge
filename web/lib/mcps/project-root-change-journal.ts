export const PROJECT_ROOT_CHANGE_JOURNAL_OUTCOMES = Object.freeze([
  'insert',
  'root_update',
  'archive',
] as const)

export type ProjectRootChangeJournalOutcome = typeof PROJECT_ROOT_CHANGE_JOURNAL_OUTCOMES[number]

export type ProjectRootChangeJournalEntry = Readonly<{
  generation: bigint
  operationId: string
  projectId: string
  outcome: ProjectRootChangeJournalOutcome
  rootBindingRevision: bigint | null
  grantDecisionRevision: bigint | null
  occurredAt: Date
}>

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const NON_NEGATIVE_DECIMAL = /^(?:0|[1-9][0-9]*)$/
const POSITIVE_DECIMAL = /^[1-9][0-9]*$/

function parseDecimal(value: unknown, field: string, positive: boolean): bigint {
  if (typeof value !== 'string' || !(positive ? POSITIVE_DECIMAL : NON_NEGATIVE_DECIMAL).test(value)) {
    throw new Error(`Project root change journal ${field} must be a canonical ${positive ? 'positive' : 'non-negative'} decimal string`)
  }
  return BigInt(value)
}

function parseOptionalPositiveDecimal(value: unknown, field: string): bigint | null {
  return value === null ? null : parseDecimal(value, field, true)
}

function parseUuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new Error(`Project root change journal ${field} must be a canonical UUID`)
  }
  return value
}

function parseOccurredAt(value: unknown): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error('Project root change journal occurredAt must be a valid database timestamp')
  }
  return value
}

/** Parses only the bounded, path-free journal row shape returned by PostgreSQL. */
export function parseProjectRootChangeJournalEntry(value: unknown): ProjectRootChangeJournalEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Project root change journal entry must be an object')
  }
  const row = value as Record<string, unknown>
  const keys = Object.keys(row).sort()
  const expectedKeys = [
    'generation', 'grantDecisionRevision', 'occurredAt', 'operationId',
    'outcome', 'projectId', 'rootBindingRevision',
  ]
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
    throw new Error('Project root change journal entry has an unknown or missing field')
  }
  if (!PROJECT_ROOT_CHANGE_JOURNAL_OUTCOMES.includes(row.outcome as ProjectRootChangeJournalOutcome)) {
    throw new Error('Project root change journal outcome is invalid')
  }
  return Object.freeze({
    generation: parseDecimal(row.generation, 'generation', true),
    operationId: parseUuid(row.operationId, 'operationId'),
    projectId: parseUuid(row.projectId, 'projectId'),
    outcome: row.outcome as ProjectRootChangeJournalOutcome,
    rootBindingRevision: parseOptionalPositiveDecimal(row.rootBindingRevision, 'rootBindingRevision'),
    grantDecisionRevision: parseOptionalPositiveDecimal(row.grantDecisionRevision, 'grantDecisionRevision'),
    occurredAt: parseOccurredAt(row.occurredAt),
  })
}
