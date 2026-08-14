export type VerificationGoalImportErrorCode =
  | 'invalid_project_id'
  | 'project_context_unavailable'
  | 'project_repository_unavailable'
  | 'project_authority_changed'
  | 'registry_head_changed'

const IMPORT_ERROR_MESSAGES: Record<VerificationGoalImportErrorCode, string> = {
  invalid_project_id: 'Verification goal import requires a valid project id.',
  project_context_unavailable: 'Verification goal project context could not be resolved.',
  project_repository_unavailable: 'Verification goal project repository is unavailable.',
  project_authority_changed: 'Verification goal project authority changed during import.',
  registry_head_changed: 'Verification goal registry head changed during import.',
}

export class VerificationGoalImportError extends Error {
  readonly code: VerificationGoalImportErrorCode

  constructor(code: VerificationGoalImportErrorCode) {
    super(IMPORT_ERROR_MESSAGES[code])
    this.name = 'VerificationGoalImportError'
    this.code = code
  }
}
