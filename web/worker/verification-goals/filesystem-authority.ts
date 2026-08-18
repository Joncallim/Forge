import type { Project } from '@/db/schema'
import {
  ProjectRootBindingError,
  assertProjectLocalPathForExecutionBinding,
  type ProjectExecutionRootBinding,
} from '@/lib/projects/local-path'

export type VerificationGoalFilesystemAuthority = Readonly<{
  projectId: string
  path: string
  dev: bigint
  ino: bigint
  rootBindingRevision: bigint
  grantDecisionRevision: bigint
  projectRevision: Date
}>

export class VerificationGoalFilesystemAuthorityError extends Error {
  readonly code:
    | 'missing_filesystem_authority'
    | 'project_archived'
    | 'unsafe_project_root'
    | 'project_root_changed'

  constructor(
    code: VerificationGoalFilesystemAuthorityError['code'],
    message: string,
  ) {
    super(message)
    this.name = 'VerificationGoalFilesystemAuthorityError'
    this.code = code
  }
}

/**
 * Loads the current approved project filesystem authority for a verification
 * goal proof run. Uses the existing project filesystem current pointer and
 * immutable decision; no new grant mode is invented.
 */
export async function loadVerificationGoalFilesystemAuthority(
  project: Pick<
    Project,
    | 'id'
    | 'localPath'
    | 'submittedBy'
    | 'archivedAt'
    | 'rootBindingRevision'
    | 'grantDecisionRevision'
    | 'updatedAt'
  >,
): Promise<VerificationGoalFilesystemAuthority> {
  if (project.archivedAt !== null) {
    throw new VerificationGoalFilesystemAuthorityError(
      'project_archived',
      'Project is archived; verification goal execution is not allowed.',
    )
  }

  let binding: ProjectExecutionRootBinding
  try {
    binding = await assertProjectLocalPathForExecutionBinding({
      id: project.id,
      localPath: project.localPath,
    })
  } catch (error) {
    if (error instanceof ProjectRootBindingError) {
      throw new VerificationGoalFilesystemAuthorityError(
        error.code === 'project_root_changed'
          ? 'project_root_changed'
          : 'unsafe_project_root',
        error.message,
      )
    }
    throw new VerificationGoalFilesystemAuthorityError(
      'missing_filesystem_authority',
      error instanceof Error ? error.message : 'Project filesystem authority could not be loaded.',
    )
  }

  return {
    projectId: project.id,
    path: binding.path,
    dev: binding.dev,
    ino: binding.ino,
    rootBindingRevision: project.rootBindingRevision,
    grantDecisionRevision: project.grantDecisionRevision,
    projectRevision: project.updatedAt,
  }
}
