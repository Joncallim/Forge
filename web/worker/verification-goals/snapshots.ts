import { and, eq, sql } from 'drizzle-orm'

import { db } from '@/db'
import { verificationGoalSnapshots } from '@/db/schema'
import type { LoadedVerificationGoal } from '@/lib/verification-goals/registry'

export type VerificationGoalSnapshotTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0]

export type VerificationGoalSnapshotImportResult = {
  snapshotId: string
  goalId: string
  definitionVersion: number
  /** Added by executable-goal v2; omitted by legacy test stores/adapters. */
  definitionSchemaVersion?: 1 | 2
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
  const base = {
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
  if (goal.definition.schemaVersion === 1) return base
  return {
    ...base,
    execution: {
      manual: goal.definition.execution.manual,
      schedule: goal.definition.execution.schedule === null
        ? null
        : { ...goal.definition.execution.schedule },
      deadlineSeconds: goal.definition.execution.deadlineSeconds,
      requiredEvidence: [...goal.definition.execution.requiredEvidence],
    },
  }
}

async function insertOrResolveSnapshot(
  tx: VerificationGoalSnapshotTransaction,
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
      definitionSchemaVersion: goal.definition.schemaVersion,
      kind: 'inserted',
    }
  }

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
    definitionSchemaVersion: goal.definition.schemaVersion,
    kind: 'existing',
  }
}

export { insertOrResolveSnapshot as insertOrResolveVerificationGoalSnapshot }

export function createDatabaseVerificationGoalSnapshotStore(
  database: typeof db = db,
): VerificationGoalSnapshotStore {
  return {
    async importSnapshots(projectId, goals) {
      if (goals.length === 0) return []
      return database.transaction(async (tx) => {
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
