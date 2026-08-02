import { PROJECT_ROOT_CHANGE_JOURNAL_OUTCOMES, type ProjectRootChangeJournalOutcome } from '@/lib/mcps/project-root-change-journal'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const NON_NEGATIVE_DECIMAL = /^(?:0|[1-9][0-9]*)$/

export const PROJECT_ROOT_RECONCILIATION_STATES = Object.freeze(['running', 'complete'] as const)
export type ProjectRootReconciliationState = typeof PROJECT_ROOT_RECONCILIATION_STATES[number]

export type ProjectRootReconciliationCommand = Readonly<{
  actorId: string
  apply: boolean
  throughGeneration: bigint
}>

export type ClaimedProjectRootChange = Readonly<{
  generation: bigint
  grantDecisionRevision: bigint | null
  outcome: ProjectRootChangeJournalOutcome
  projectId: string
  rootBindingRevision: bigint | null
}>

function parseUuid(value: string | undefined, name: string): string {
  if (!value || !UUID.test(value)) throw new Error(`${name} must be a canonical UUID`)
  return value
}

function parseGeneration(value: string | undefined): bigint {
  if (!value || !NON_NEGATIVE_DECIMAL.test(value)) {
    throw new Error('--through must be a non-negative canonical generation')
  }
  return BigInt(value)
}

/** The operator command is intentionally actionless until its literal --apply. */
export function parseProjectRootReconciliationCommand(argv: readonly string[]): ProjectRootReconciliationCommand {
  let actor: string | undefined
  let through: string | undefined
  let apply = false
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--apply') {
      if (apply) throw new Error('--apply may appear only once')
      apply = true
      continue
    }
    if (token === '--actor') {
      if (actor !== undefined) throw new Error('--actor may appear only once')
      actor = argv[++index]
      continue
    }
    if (token === '--through') {
      if (through !== undefined) throw new Error('--through may appear only once')
      through = argv[++index]
      continue
    }
    throw new Error(`Unknown project-root reconciliation argument: ${token}`)
  }
  return Object.freeze({ actorId: parseUuid(actor, '--actor'), apply, throughGeneration: parseGeneration(through) })
}

export function parseClaimedProjectRootChange(value: Record<string, unknown>): ClaimedProjectRootChange {
  const generation = value.generation
  const projectId = value.projectId
  const outcome = value.outcome
  const parseOptionalRevision = (candidate: unknown, name: string): bigint | null => {
    if (candidate === null) return null
    if (typeof candidate !== 'string' || !/^[1-9][0-9]*$/.test(candidate)) throw new Error(`${name} must be null or positive`)
    return BigInt(candidate)
  }
  if (typeof generation !== 'string' || !/^[1-9][0-9]*$/.test(generation)) throw new Error('claimed generation must be positive')
  if (typeof projectId !== 'string' || !UUID.test(projectId)) throw new Error('claimed projectId must be a UUID')
  if (!PROJECT_ROOT_CHANGE_JOURNAL_OUTCOMES.includes(outcome as ProjectRootChangeJournalOutcome)) throw new Error('claimed outcome is invalid')
  return Object.freeze({
    generation: BigInt(generation),
    grantDecisionRevision: parseOptionalRevision(value.grantDecisionRevision, 'grantDecisionRevision'),
    outcome: outcome as ProjectRootChangeJournalOutcome,
    projectId,
    rootBindingRevision: parseOptionalRevision(value.rootBindingRevision, 'rootBindingRevision'),
  })
}
