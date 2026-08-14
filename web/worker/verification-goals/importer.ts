import { eq } from 'drizzle-orm'

import { db } from '@/db'
import { projects } from '@/db/schema'
import {
  assertProjectLocalPathForExecutionBinding,
  type ProjectExecutionRootBinding,
} from '@/lib/projects/local-path'
import {
  loadVerificationGoalRegistry,
  type LoadedVerificationGoal,
} from '@/lib/verification-goals/registry'
import {
  databaseVerificationGoalSnapshotStore,
  type VerificationGoalSnapshotImportResult,
  type VerificationGoalSnapshotStore,
} from './snapshots'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

type VerificationGoalProject = {
  id: string
  localPath: string | null
}

export type ImportVerificationGoalRegistryInput = {
  projectId: string
}

export type VerificationGoalImportErrorCode =
  | 'invalid_project_id'
  | 'project_context_unavailable'
  | 'project_repository_unavailable'

const IMPORT_ERROR_MESSAGES: Record<VerificationGoalImportErrorCode, string> = {
  invalid_project_id: 'Verification goal import requires a valid project id.',
  project_context_unavailable: 'Verification goal project context could not be resolved.',
  project_repository_unavailable: 'Verification goal project repository is unavailable.',
}

export class VerificationGoalImportError extends Error {
  readonly code: VerificationGoalImportErrorCode

  constructor(code: VerificationGoalImportErrorCode) {
    super(IMPORT_ERROR_MESSAGES[code])
    this.name = 'VerificationGoalImportError'
    this.code = code
  }
}

export type VerificationGoalRegistryImporterDependencies = {
  loadProject: (projectId: string) => Promise<VerificationGoalProject | null>
  bindProjectRoot: (project: VerificationGoalProject) => Promise<ProjectExecutionRootBinding>
  loadRegistry?: (projectRoot: ProjectExecutionRootBinding) => Promise<LoadedVerificationGoal[]>
  store: VerificationGoalSnapshotStore
}

async function loadProjectFromDatabase(projectId: string): Promise<VerificationGoalProject | null> {
  const [project] = await db
    .select({ id: projects.id, localPath: projects.localPath })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1)
  return project ?? null
}

const productionDependencies: VerificationGoalRegistryImporterDependencies = {
  loadProject: loadProjectFromDatabase,
  bindProjectRoot: assertProjectLocalPathForExecutionBinding,
  store: databaseVerificationGoalSnapshotStore,
}

/**
 * Resolves project scope from PostgreSQL, validates the complete repository
 * registry, then imports it. Callers cannot supply or override a project root.
 */
async function importVerificationGoalRegistryWithDependencies(
  input: ImportVerificationGoalRegistryInput,
  dependencies: VerificationGoalRegistryImporterDependencies,
): Promise<VerificationGoalSnapshotImportResult[]> {
  if (!UUID.test(input.projectId)) {
    throw new VerificationGoalImportError('invalid_project_id')
  }
  const projectId = input.projectId.toLowerCase()
  const project = await dependencies.loadProject(projectId)
  if (!project || project.id !== projectId) {
    throw new VerificationGoalImportError('project_context_unavailable')
  }
  if (!project.localPath?.trim()) {
    throw new VerificationGoalImportError('project_repository_unavailable')
  }
  let projectRoot: ProjectExecutionRootBinding
  try {
    projectRoot = await dependencies.bindProjectRoot(project)
  } catch {
    throw new VerificationGoalImportError('project_repository_unavailable')
  }
  const goals = await (dependencies.loadRegistry ?? loadVerificationGoalRegistry)(projectRoot)
  return dependencies.store.importSnapshots(projectId, goals)
}

export function importVerificationGoalRegistry(
  input: ImportVerificationGoalRegistryInput,
): Promise<VerificationGoalSnapshotImportResult[]> {
  return importVerificationGoalRegistryWithDependencies(input, productionDependencies)
}

/** Dependency injection is exposed only for deterministic unit tests. */
export function importVerificationGoalRegistryForTest(
  input: ImportVerificationGoalRegistryInput,
  dependencies: VerificationGoalRegistryImporterDependencies,
): Promise<VerificationGoalSnapshotImportResult[]> {
  return importVerificationGoalRegistryWithDependencies(input, dependencies)
}
