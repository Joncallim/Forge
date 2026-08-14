import { eq, sql } from 'drizzle-orm'

import { db } from '@/db'
import { projects, verificationGoalRegistryHeads } from '@/db/schema'
import {
  assertProjectLocalPathForExecutionBinding,
  ProjectRootBindingError,
  type ProjectExecutionRootBinding,
} from '@/lib/projects/local-path'
import { verificationGoalRegistryManifest } from '@/lib/verification-goals/manifest'
import {
  loadVerificationGoalRegistry,
  type LoadedVerificationGoal,
} from '@/lib/verification-goals/registry'
import {
  databaseVerificationGoalRegistryStore,
  type VerificationGoalRegistryCommitResult,
  type VerificationGoalRegistryStore,
} from './registry-store'
import { VerificationGoalImportError } from './errors'

export {
  VerificationGoalImportError,
  type VerificationGoalImportErrorCode,
} from './errors'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

type VerificationGoalProject = {
  id: string
  submittedBy: string | null
  archivedAt: Date | null
  localPath: string | null
  rootRef: string | null
  rootBindingRevision: bigint
  grantDecisionRevision: bigint
  updatedAt: string
  priorHeadRevisionId: string | null
}

export type ImportVerificationGoalRegistryInput = {
  projectId: string
  actorUserId: string
}

export type VerificationGoalRegistryImporterDependencies = {
  loadProject: (projectId: string) => Promise<VerificationGoalProject | null>
  bindProjectRoot: (project: VerificationGoalProject) => Promise<ProjectExecutionRootBinding>
  loadRegistry?: (projectRoot: ProjectExecutionRootBinding) => Promise<LoadedVerificationGoal[]>
  store: VerificationGoalRegistryStore
}

async function loadProjectFromDatabase(projectId: string): Promise<VerificationGoalProject | null> {
  const [project] = await db
    .select({
      id: projects.id,
      submittedBy: projects.submittedBy,
      archivedAt: projects.archivedAt,
      localPath: projects.localPath,
      rootRef: projects.rootRef,
      rootBindingRevision: projects.rootBindingRevision,
      grantDecisionRevision: projects.grantDecisionRevision,
      updatedAt: sql<string>`to_char(
        ${projects.updatedAt} AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      )`,
      priorHeadRevisionId: verificationGoalRegistryHeads.registryRevisionId,
    })
    .from(projects)
    .leftJoin(
      verificationGoalRegistryHeads,
      eq(verificationGoalRegistryHeads.projectId, projects.id),
    )
    .where(eq(projects.id, projectId))
    .limit(1)
  return project ?? null
}

const productionDependencies: VerificationGoalRegistryImporterDependencies = {
  loadProject: loadProjectFromDatabase,
  bindProjectRoot: assertProjectLocalPathForExecutionBinding,
  store: databaseVerificationGoalRegistryStore,
}

/**
 * Resolves project scope from PostgreSQL, validates the complete repository
 * registry, then imports it. Callers cannot supply or override a project root.
 */
async function importVerificationGoalRegistryWithDependencies(
  input: ImportVerificationGoalRegistryInput,
  dependencies: VerificationGoalRegistryImporterDependencies,
): Promise<VerificationGoalRegistryCommitResult> {
  if (!UUID.test(input.projectId)) {
    throw new VerificationGoalImportError('invalid_project_id')
  }
  const projectId = input.projectId.toLowerCase()
  if (!UUID.test(input.actorUserId)) {
    throw new VerificationGoalImportError('project_context_unavailable')
  }
  const actorUserId = input.actorUserId.toLowerCase()
  const project = await dependencies.loadProject(projectId)
  if (
    !project
    || project.id !== projectId
    || project.submittedBy !== actorUserId
    || project.archivedAt !== null
  ) {
    throw new VerificationGoalImportError('project_context_unavailable')
  }
  if (!project.localPath?.trim() || !project.rootRef) {
    throw new VerificationGoalImportError('project_repository_unavailable')
  }
  let projectRoot: ProjectExecutionRootBinding
  try {
    projectRoot = await dependencies.bindProjectRoot(project)
  } catch (error) {
    if (error instanceof ProjectRootBindingError) {
      throw new VerificationGoalImportError('project_repository_unavailable')
    }
    throw error
  }
  const goals = await (dependencies.loadRegistry ?? loadVerificationGoalRegistry)(projectRoot)
  const manifest = verificationGoalRegistryManifest(goals)
  return dependencies.store.commitRegistry({
    authority: {
      projectId,
      applicationAssertedActorUserId: actorUserId,
      submittedBy: project.submittedBy,
      archivedAt: project.archivedAt,
      localPath: project.localPath,
      rootRef: project.rootRef,
      rootBindingRevision: project.rootBindingRevision,
      grantDecisionRevision: project.grantDecisionRevision,
      projectRevision: project.updatedAt,
      priorHeadRevisionId: project.priorHeadRevisionId,
    },
    goals,
    manifest,
  })
}

export function importVerificationGoalRegistry(
  input: ImportVerificationGoalRegistryInput,
): Promise<VerificationGoalRegistryCommitResult> {
  return importVerificationGoalRegistryWithDependencies(input, productionDependencies)
}

/** Dependency injection is exposed only for deterministic unit tests. */
export function importVerificationGoalRegistryForTest(
  input: ImportVerificationGoalRegistryInput,
  dependencies: VerificationGoalRegistryImporterDependencies,
): Promise<VerificationGoalRegistryCommitResult> {
  return importVerificationGoalRegistryWithDependencies(input, dependencies)
}
