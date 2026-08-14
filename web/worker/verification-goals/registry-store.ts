import { sql } from 'drizzle-orm'

import { db } from '@/db'
import type { LoadedVerificationGoal } from '@/lib/verification-goals/registry'
import type { VerificationGoalRegistryManifest } from '@/lib/verification-goals/manifest'
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

type CommitRoutineEntry = {
  snapshotId: string
  goalId: string
  definitionVersion: number
  definitionDigest: string
  sourcePath: string
}

function sqlState(error: unknown): string | null {
  const direct = (error as { code?: unknown } | null)?.code
  if (typeof direct === 'string') return direct
  const cause = (error as { cause?: unknown } | null)?.cause
  const nested = (cause as { code?: unknown } | null)?.code
  return typeof nested === 'string' ? nested : null
}

function manifestMatchesGoals(input: VerificationGoalRegistryCommitInput): boolean {
  if (input.goals.length !== input.manifest.entries.length) return false
  return input.goals.every((goal, index) => {
    const entry = input.manifest.entries[index]
    return entry?.goalId === goal.definition.goalId
      && entry.definitionVersion === goal.definition.definitionVersion
      && entry.definitionDigest === goal.definitionDigest
      && entry.sourcePath === goal.sourcePath
  })
}

async function invokeCommitRoutine(
  tx: VerificationGoalSnapshotTransaction,
  input: VerificationGoalRegistryCommitInput,
  entries: readonly CommitRoutineEntry[],
): Promise<RegistryCommitRow> {
  try {
    const rows = await tx.execute<RegistryCommitRow>(sql`
      select
        committed.registry_revision_id as "registryRevisionId",
        committed.revision_sequence as "revisionSequence",
        committed.head_state as "headState"
      from public.forge_commit_verification_goal_registry_revision_v1(
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
        const entries = input.manifest.entries.map((entry) => {
          const snapshot = snapshotByGoal.get(entry.goalId)
          if (!snapshot) throw new Error('Verification goal registry snapshot membership is incomplete.')
          return {
            snapshotId: snapshot.snapshotId,
            goalId: entry.goalId,
            definitionVersion: entry.definitionVersion,
            definitionDigest: entry.definitionDigest,
            sourcePath: entry.sourcePath,
          }
        })
        const committed = await invokeCommitRoutine(tx, input, entries)
        return {
          registryRevisionId: committed.registryRevisionId,
          manifestDigest: input.manifest.digest,
          headState: committed.headState,
          snapshots,
        }
      })
    },
  }
}

export const databaseVerificationGoalRegistryStore = createDatabaseVerificationGoalRegistryStore()
