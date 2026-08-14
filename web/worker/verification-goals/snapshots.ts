import { and, eq, sql } from 'drizzle-orm'

import { db } from '@/db'
import { verificationGoalSnapshots } from '@/db/schema'
import type { LoadedVerificationGoal } from '@/lib/verification-goals/registry'

type SnapshotTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0]

export type VerificationGoalSnapshotImportResult = {
  snapshotId: string
  goalId: string
  definitionVersion: number
  kind: 'inserted' | 'existing'
}

export interface VerificationGoalSnapshotStore {
  importSnapshots(
    projectId: string,
    goals: readonly LoadedVerificationGoal[],
  ): Promise<VerificationGoalSnapshotImportResult[]>
}

export class VerificationGoalSnapshotConflictError extends Error {
  readonly code = 'definition_version_conflict' as const
  readonly projectId: string
  readonly goalId: string
  readonly definitionVersion: number

  constructor(input: { projectId: string; goalId: string; definitionVersion: number }) {
    super(`Verification goal ${input.goalId} version ${input.definitionVersion} already exists with different content.`)
    this.name = 'VerificationGoalSnapshotConflictError'
    this.projectId = input.projectId
    this.goalId = input.goalId
    this.definitionVersion = input.definitionVersion
  }
}

function canonicalDefinitionValue(goal: LoadedVerificationGoal): Record<string, unknown> {
  return {
    schemaVersion: goal.definition.schemaVersion,
    goalId: goal.definition.goalId,
    definitionVersion: goal.definition.definitionVersion,
    title: goal.definition.title,
    description: goal.definition.description,
    capability: goal.definition.capability,
    severity: goal.definition.severity,
    enabled: goal.definition.enabled,
    operations: goal.definition.operations.map((operation) => ({ ...operation })),
  }
}

async function insertOrResolveSnapshot(
  tx: SnapshotTransaction,
  projectId: string,
  goal: LoadedVerificationGoal,
): Promise<VerificationGoalSnapshotImportResult> {
  const [inserted] = await tx
    .insert(verificationGoalSnapshots)
    .values({
      projectId,
      goalId: goal.definition.goalId,
      definitionVersion: goal.definition.definitionVersion,
      canonicalDefinition: canonicalDefinitionValue(goal),
      definitionDigest: goal.definitionDigest,
      sourcePath: goal.sourcePath,
    })
    .onConflictDoNothing({
      target: [
        verificationGoalSnapshots.projectId,
        verificationGoalSnapshots.goalId,
        verificationGoalSnapshots.definitionVersion,
      ],
    })
    .returning({ id: verificationGoalSnapshots.id })

  if (inserted) {
    return {
      snapshotId: inserted.id,
      goalId: goal.definition.goalId,
      definitionVersion: goal.definition.definitionVersion,
      kind: 'inserted',
    }
  }

  // A concurrent INSERT ... ON CONFLICT waits for the winning transaction.
  // This following statement gets a fresh READ COMMITTED snapshot and can
  // therefore resolve the committed winner rather than misreporting it as
  // missing.
  const [existing] = await tx
    .select({
      id: verificationGoalSnapshots.id,
      definitionDigest: verificationGoalSnapshots.definitionDigest,
    })
    .from(verificationGoalSnapshots)
    .where(and(
      eq(verificationGoalSnapshots.projectId, projectId),
      eq(verificationGoalSnapshots.goalId, goal.definition.goalId),
      eq(verificationGoalSnapshots.definitionVersion, goal.definition.definitionVersion),
    ))
    .limit(1)

  if (!existing) {
    throw new Error('Idempotent verification goal snapshot could not be resolved.')
  }
  if (existing.definitionDigest !== goal.definitionDigest) {
    throw new VerificationGoalSnapshotConflictError({
      projectId,
      goalId: goal.definition.goalId,
      definitionVersion: goal.definition.definitionVersion,
    })
  }
  return {
    snapshotId: existing.id,
    goalId: goal.definition.goalId,
    definitionVersion: goal.definition.definitionVersion,
    kind: 'existing',
  }
}

/**
 * Imports the already-validated registry in one transaction. A divergent
 * identity conflict rolls back every snapshot inserted by this import.
 */
export function createDatabaseVerificationGoalSnapshotStore(
  database: typeof db = db,
): VerificationGoalSnapshotStore {
  return {
    async importSnapshots(projectId, goals) {
      if (goals.length === 0) return []
      return database.transaction(async (tx) => {
        // A concurrent importer may hold the same unique identity open. The
        // normal critical section is milliseconds; cap the wait so a parked
        // peer cannot pin this worker connection indefinitely.
        await tx.execute(sql`SET LOCAL lock_timeout = '5s'`)
        const results: VerificationGoalSnapshotImportResult[] = []
        for (const goal of goals) {
          results.push(await insertOrResolveSnapshot(tx, projectId, goal))
        }
        return results
      })
    },
  }
}

export const databaseVerificationGoalSnapshotStore = createDatabaseVerificationGoalSnapshotStore()
