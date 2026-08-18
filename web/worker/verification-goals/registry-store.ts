import { sql } from 'drizzle-orm'

import { db } from '@/db'
import type { LoadedVerificationGoal } from '@/lib/verification-goals/registry'
import type { VerificationGoalRegistryManifest } from '@/lib/verification-goals/manifest'
import { buildVerificationGoalExecutionBindingV1 } from '@/lib/verification-goals/executable-contracts'
import { VerificationGoalImportError } from './errors'
import {
  insertOrResolveVerificationGoalSnapshot,
  type VerificationGoalSnapshotImportResult,
  type VerificationGoalSnapshotTransaction,
} from './snapshots'

export type VerificationGoalRegistryAuthority = Readonly<{
  projectId: string
  applicationAssertedActorUserId: string
  submittedBy: string
  archivedAt: Date | null
  localPath: string
  rootRef: string
  rootBindingRevision: bigint
  grantDecisionRevision: bigint
  projectRevision: string
  priorHeadRevisionId: string | null
}>

export type VerificationGoalRegistryCommitInput = Readonly<{
  authority: VerificationGoalRegistryAuthority
  goals: readonly LoadedVerificationGoal[]
  manifest: VerificationGoalRegistryManifest
}>

export type VerificationGoalRegistryCommitResult = Readonly<{
  registryRevisionId: string
  manifestDigest: string
  manifestSchemaVersion: 1 | 2
  headState: 'advanced' | 'existing'
  snapshots: readonly VerificationGoalSnapshotImportResult[]
}>

export interface VerificationGoalRegistryStore {
  commitRegistry(input: VerificationGoalRegistryCommitInput): Promise<VerificationGoalRegistryCommitResult>
}

type RegistryCommitRow = {
  registryRevisionId: string
  revisionSequence: bigint
  headState: 'advanced' | 'existing'
}

type CommitRoutineEntryV1 = {
  snapshotId: string
  goalId: string
  definitionVersion: number
  definitionDigest: string
  sourcePath: string
}

type CommitRoutineEntryV2 = CommitRoutineEntryV1 & {
  entrySchemaVersion: 1 | 2
  executionBinding: ReturnType<typeof buildVerificationGoalExecutionBindingV1> | null
  executionBindingDigest: string | null
}

function sqlState(error: unknown): string | null {
  const direct = (error as { code?: unknown } | null)?.code
  if (typeof direct === 'string') return direct
  const cause = (error as { cause?: unknown } | null)?.cause
  const nested = (cause as { code?: unknown } | null)?.code
  return typeof nested === 'string' ? nested : null
}

function manifestSchemaVersion(manifest: VerificationGoalRegistryManifest): 1 | 2 {
  return 'schemaVersion' in manifest ? manifest.schemaVersion : 1
}

function goalById(goals: readonly LoadedVerificationGoal[]): ReadonlyMap<string, LoadedVerificationGoal> {
  const map = new Map<string, LoadedVerificationGoal>()
  for (const goal of goals) {
    if (map.has(goal.definition.goalId)) {
      throw new Error('Verification goal registry contains duplicate goal identity.')
    }
    map.set(goal.definition.goalId, goal)
  }
  return map
}

function manifestMatchesGoals(input: VerificationGoalRegistryCommitInput): boolean {
  if (input.goals.length !== input.manifest.entries.length) return false
  const goals = goalById(input.goals)
  return input.manifest.entries.every((entry) => {
    const goal = goals.get(entry.goalId)
    if (
      !goal
      || entry.definitionVersion !== goal.definition.definitionVersion
      || entry.definitionDigest !== goal.definitionDigest
      || entry.sourcePath !== goal.sourcePath
    ) return false

    if (!('schemaVersion' in input.manifest)) return goal.definition.schemaVersion === 1
    if (!('entrySchemaVersion' in entry) || entry.entrySchemaVersion !== goal.definition.schemaVersion) return false
    if (goal.definition.schemaVersion === 1) return entry.executionBindingDigest === null
    return entry.executionBindingDigest === buildVerificationGoalExecutionBindingV1(goal.definition).executionBindingDigest
  })
}

async function invokeCommitRoutine(
  tx: VerificationGoalSnapshotTransaction,
  input: VerificationGoalRegistryCommitInput,
  entries: readonly (CommitRoutineEntryV1 | CommitRoutineEntryV2)[],
): Promise<RegistryCommitRow> {
  try {
    const rows = await tx.execute<RegistryCommitRow>(sql`
      select
        committed.registry_revision_id as "registryRevisionId",
        committed.revision_sequence as "revisionSequence",
        committed.head_state as "headState"
      from public.forge_commit_verification_goal_registry_revision_v2(
        ${input.authority.projectId}::uuid,
        ${input.authority.applicationAssertedActorUserId}::uuid,
        ${input.authority.priorHeadRevisionId}::uuid,
        ${input.authority.submittedBy}::uuid,
        ${input.authority.archivedAt}::timestamptz,
        ${input.authority.localPath}::text,
        ${input.authority.rootRef}::uuid,
        ${input.authority.rootBindingRevision}::bigint,
        ${input.authority.grantDecisionRevision}::bigint,
        ${input.authority.projectRevision}::timestamptz,
        ${manifestSchemaVersion(input.manifest)}::integer,
        ${input.manifest.digest}::text,
        ${JSON.stringify(entries)}::jsonb
      ) committed
    `)
    const [result] = rows
    if (
      !result
      || !['advanced', 'existing'].includes(result.headState)
      || typeof result.registryRevisionId !== 'string'
    ) {
      throw new Error('Verification goal registry commit routine returned an invalid result.')
    }
    return result
  } catch (error) {
    switch (sqlState(error)) {
      case 'P1871':
        throw new VerificationGoalImportError('project_authority_changed')
      case 'P1872':
        throw new VerificationGoalImportError('registry_head_changed')
      default:
        throw error
    }
  }
}

/**
 * Inserts immutable definition snapshots, then asks the protected database
 * routine to construct and advance the authoritative registry revision. The
 * application login has no direct write privilege on revision state.
 */
export function createDatabaseVerificationGoalRegistryStore(
  database: typeof db = db,
): VerificationGoalRegistryStore {
  return {
    async commitRegistry(input) {
      if (!manifestMatchesGoals(input)) {
        throw new Error('Verification goal manifest does not match the validated registry.')
      }
      return database.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL lock_timeout = '5s'`)
        const snapshots: VerificationGoalSnapshotImportResult[] = []
        for (const goal of input.goals) {
          snapshots.push(await insertOrResolveVerificationGoalSnapshot(
            tx,
            input.authority.projectId,
            goal,
          ))
        }
        const snapshotByGoal = new Map(snapshots.map((snapshot) => [snapshot.goalId, snapshot]))
        const goals = goalById(input.goals)
        const schemaVersion = manifestSchemaVersion(input.manifest)
        const entries = input.manifest.entries.map((entry): CommitRoutineEntryV1 | CommitRoutineEntryV2 => {
          const snapshot = snapshotByGoal.get(entry.goalId)
          const goal = goals.get(entry.goalId)
          if (!snapshot || !goal) throw new Error('Verification goal registry snapshot membership is incomplete.')
          const base: CommitRoutineEntryV1 = {
            snapshotId: snapshot.snapshotId,
            goalId: entry.goalId,
            definitionVersion: entry.definitionVersion,
            definitionDigest: entry.definitionDigest,
            sourcePath: entry.sourcePath,
          }
          if (schemaVersion === 1) return base

          const executionBinding = goal.definition.schemaVersion === 2
            ? buildVerificationGoalExecutionBindingV1(goal.definition)
            : null
          return {
            ...base,
            entrySchemaVersion: goal.definition.schemaVersion,
            executionBinding,
            executionBindingDigest: executionBinding?.executionBindingDigest ?? null,
          }
        })
        const committed = await invokeCommitRoutine(tx, input, entries)
        return {
          registryRevisionId: committed.registryRevisionId,
          manifestDigest: input.manifest.digest,
          manifestSchemaVersion: schemaVersion,
          headState: committed.headState,
          snapshots,
        }
      })
    },
  }
}

export const databaseVerificationGoalRegistryStore = createDatabaseVerificationGoalRegistryStore()
