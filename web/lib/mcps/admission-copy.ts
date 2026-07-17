import type {
  McpAdmissionMode,
  McpAdmissionStatus,
  McpRecoveryAction,
} from './admission'
import type {
  McpCatalogEntry,
  McpHealthStatus,
  McpId,
  McpInstallState,
} from './types'
import {
  LOCAL_EFFECT_RECOVERY_ACTIONS,
  MCP_ADMISSION_OPERATOR_RECOVERY_SUITE_ID,
  PACKET_ISSUANCE_RECOVERY_ACTIONS,
} from './recovery-actions-v2'
import {
  PACKET_REDACTION_CATEGORIES,
  packetTerminalTupleIsValid,
  parsePacketIntegrityHold,
  parsePacketIssuanceRecoveryMarker,
  parsePacketRedactionSummary,
  type PacketIntegrityHoldV2,
  type PacketIssuanceRecoveryMarkerV2,
  type PacketRedactionCategory,
  type PacketTerminalOutcome,
  type TerminalPacketAssemblyState,
  type TerminalPacketDeliveryOutcome,
} from './packet-issuance-v2'
import {
  parseHostApplyRecoveryReview,
  parseLocalEffectIntegrityHold,
  parseLocalEffectRecoveryMarker,
  parseRepositoryChangeReview,
  type HostApplyRecoveryReview,
  type LocalEffectIntegrityHoldV1,
  type LocalEffectRecoveryMarkerV1,
  type RepositoryChangeReview,
} from './local-run-evidence-v2'

/**
 * S5 is a presentation-only slice. Every operator-facing MCP sentence and action
 * label belongs here so task, project, and catalog components cannot drift into
 * their own policy or vocabulary.
 *
 * The grant-state union mirrors the S3 presentation boundary. During the stacked
 * rollout S3 replaces this structural seam with its exported closed lifecycle
 * types; no grant or recovery state is stored or inferred here.
 */
export type AdmissionFilesystemGrantPresentationState =
  | { kind: 'not_applicable' }
  | {
      kind: 'effective_approved'
      grantPhase: 'approved'
      grantConsumed: false
      grantDecisionRevision: string
      revocationReason: null
    }
  | {
      kind: 'operator_hold'
      holdKind: 'approval_required'
      grantPhase: 'none' | 'proposed' | 'not_issued'
      grantConsumed: false
      grantDecisionRevision: null
      revocationReason: null
    }
  | {
      kind: 'operator_hold'
      holdKind: 'denied_required'
      grantPhase: 'denied'
      grantConsumed: false
      grantDecisionRevision: string | null
      revocationReason: null
    }
  | {
      kind: 'operator_hold'
      holdKind: 'revoked_required'
      grantPhase: 'revoked'
      grantConsumed: false
      grantDecisionRevision: string
      revocationReason:
        | 'project_grant_removed'
        | 'project_grant_narrowed'
        | 'project_root_repoint'
    }
  | {
      kind: 'operator_hold'
      holdKind: 'consumed_once'
      grantPhase: 'approved'
      grantConsumed: true
      grantDecisionRevision: string
      revocationReason: null
    }

export type AdmissionDecisionPresentationInput = Readonly<{
  mode: McpAdmissionMode
  admissionStatus: McpAdmissionStatus
  recoveryAction?: McpRecoveryAction
  grantState: AdmissionFilesystemGrantPresentationState
  requirement: 'required' | 'optional'
  retryable: boolean
  projectId: string
  packageGrantTargetId?: string
}>

export type ProjectMcpPresentationInput = Readonly<{
  projectId: string
  mcpId: McpId
  installState: McpInstallState
  healthStatus: McpHealthStatus
  enabled: boolean
  runtime: McpCatalogEntry['runtime']
}>

export type CatalogMcpPresentationInput = Readonly<
  Pick<McpCatalogEntry, 'id' | 'runtime'>
>

export type PacketRecoveryRequestIdentity = Readonly<{
  schemaVersion: 2
  priorRuntimeAuditId: string
  markerFingerprint: string
}>

export type LocalEffectRecoveryRequestIdentity = Readonly<{
  schemaVersion: 1
  localRunEvidenceId: string
  evidenceFingerprint: string
}>

export type PresentationCta =
  | { kind: 'scroll'; label: string; targetId: string }
  | { kind: 'link'; label: string; href: string }
  | { kind: 'request_changes'; label: string }
  | { kind: 'retry'; label: string; handler: 'retry_mcp_broker' }
  | {
      kind: 'retry_packet_execution'
      label: string
      handler: 'retry_execution'
      request: PacketRecoveryRequestIdentity
    }
  | {
      kind: 'review_submission'
      label: string
      handler: 'acknowledge_possible_submission'
      request: PacketRecoveryRequestIdentity
    }
  | {
      kind: 'reapprove_packet_context'
      label: string
      targetId: string
      request: PacketRecoveryRequestIdentity
    }
  | {
      kind: 'decline_packet_recovery'
      label: string
      handler: 'decline_packet_recovery'
      request: PacketRecoveryRequestIdentity
    }
  | {
      kind: 'review_local_changes'
      label: string
      handler: 'review_local_changes'
      request: LocalEffectRecoveryRequestIdentity
    }
  | {
      kind: 'retry_local_execution'
      label: string
      handler: 'retry_local_execution'
      request: LocalEffectRecoveryRequestIdentity
    }
  | {
      kind: 'acknowledge_possible_local_invocation'
      label: string
      handler: 'acknowledge_possible_local_invocation'
      request: LocalEffectRecoveryRequestIdentity
    }
  | {
      kind: 'decline_local_retry'
      label: string
      handler: 'decline_local_retry'
      request: LocalEffectRecoveryRequestIdentity
    }
  | { kind: 'install'; label: string; handler: 'install_mcp' }
  | { kind: 'enable'; label: string; handler: 'enable_mcp' }
  | { kind: 'connect'; label: string; handler: 'connect_account' }
  | { kind: 'configure'; label: string; handler: 'configure_project_mcp' }
  | { kind: 'inspect_fix'; label: string; handler: 'inspect_mcp_health' }
  | { kind: 'refresh'; label: string; handler: 'refresh_mcp_health' }

type PacketRecoveryPrimaryCta = Extract<
  PresentationCta,
  { kind: 'retry_packet_execution' | 'review_submission' | 'reapprove_packet_context' }
>
type PacketRecoveryDeclineCta = Extract<
  PresentationCta,
  { kind: 'decline_packet_recovery' }
>
type LocalRecoveryPrimaryCta = Extract<
  PresentationCta,
  { kind: 'retry_local_execution' | 'acknowledge_possible_local_invocation' }
>
type LocalRecoveryDeclineCta = Extract<
  PresentationCta,
  { kind: 'decline_local_retry' }
>
type StandalonePresentationCta = Exclude<
  PresentationCta,
  PacketRecoveryPrimaryCta | LocalRecoveryPrimaryCta
>

export type PresentationActions =
  | readonly []
  | readonly [StandalonePresentationCta]
  | readonly [PacketRecoveryPrimaryCta, PacketRecoveryDeclineCta]
  | readonly [LocalRecoveryPrimaryCta, LocalRecoveryDeclineCta]

export type AdmissionPresentation = Readonly<{
  statusKey:
    | 'planning'
    | 'approved'
    | 'action_required'
    | 'deferred'
    | 'unhealthy'
    | 'legacy'
  tone: 'neutral' | 'positive' | 'warning' | 'danger'
  badgeText: string
  headline: string
  body: string
  actions: PresentationActions
}>

export type McpSurfacePresentation = AdmissionPresentation

export type PacketArtifactPresentation = AdmissionPresentation & Readonly<{
  actions: readonly []
  facts: readonly Readonly<{ label: string; value: string }>[]
}>

export type PacketTerminalDisplayProjection = Readonly<{
  schemaVersion: 2
  assembly: TerminalPacketAssemblyState
  delivery: TerminalPacketDeliveryOutcome
  terminal: PacketTerminalOutcome
  effect:
    | Readonly<{ state: 'not_started' }>
    | Readonly<{
        state: 'quiesced'
        lastStage: 'sandbox_apply' | 'validation' | 'host_apply' | 'repository_evidence' | 'completion_preparation'
        hostApplyLedgerFingerprint: string
      }>
  hostApplyReview: HostApplyRecoveryReview
  repositoryReviews: Readonly<{
    workingTree: RepositoryChangeReview
    gitControl: RepositoryChangeReview
    gitStorage: RepositoryChangeReview
  }>
  combinedRepositoryReviewFingerprint: string
}>

export type PacketArtifactPresentationInput =
  | Readonly<{
      source: 'validated_artifact'
      agentRunId: string
      localRunEvidenceFingerprint: string
      projection: PacketTerminalDisplayProjection
    }>
  | Readonly<{
      source: 'artifact_unavailable'
      agentRunId: string
      reason:
        | 'unsupported_schema_version'
        | 'invalid_artifact_binding'
        | 'invalid_assembly_tuple'
        | 'unknown_redaction_category'
        | 'invalid_redaction_count'
        | 'invalid_delivery_tuple'
        | 'invalid_terminal_tuple'
        | 'unknown_failure_code'
        | 'invalid_failure_stage'
        | 'invalid_effect_tuple'
        | 'invalid_host_ledger_tuple'
        | 'invalid_host_apply_review'
        | 'invalid_repository_review'
        | 'invalid_repository_review_fingerprint'
        | 'terminal_projection_mismatch'
    }>

export type ActivePacketClaimState =
  | Readonly<{ phase: 'preparing'; assemblyState: 'not_assembled'; deliveryState: 'not_exposed' }>
  | Readonly<{ phase: 'assembling'; assemblyState: 'assembling'; deliveryState: 'not_exposed' }>
  | Readonly<{ phase: 'assembled'; assemblyState: 'assembled'; deliveryState: 'not_exposed' }>
  | Readonly<{ phase: 'submitting'; assemblyState: 'assembled'; deliveryState: 'submitting' }>
  | Readonly<{ phase: 'accepted_finalizing'; assemblyState: 'assembled'; deliveryState: 'submitted' }>
  | Readonly<{ phase: 'rejected_finalizing'; assemblyState: 'assembled'; deliveryState: 'submission_failed' }>

type McpOperatorTaskStatus =
  | 'pending'
  | 'running'
  | 'awaiting_answers'
  | 'awaiting_approval'
  | 'approved'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'rejected'

type McpOperatorPackageStatus =
  | 'pending'
  | 'ready'
  | 'running'
  | 'awaiting_review'
  | 'needs_rework'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'cancelled'

export type PacketCurrentStatePresentationInput =
  | Readonly<{
      source: 'active_claim'
      taskStatus: McpOperatorTaskStatus
      packageStatus: McpOperatorPackageStatus
      auditStatus: 'claiming'
      claimState: ActivePacketClaimState
      ownership: {
        executionLeaseActive: true
        localEvidenceLeaseActive: true
        packetIssuanceLeaseActive: true
      }
      databaseObservedAt: string
    }>
  | Readonly<{
      source: 'state_pending_reconciliation'
      reason: 'expired_claim_observed' | 'partial_terminalization_observed'
      taskStatus: McpOperatorTaskStatus
      packageStatus: McpOperatorPackageStatus
      databaseObservedAt: string
    }>
  | Readonly<{
      source: 'state_unavailable'
      reason: 'unknown_persisted_status' | 'unsupported_schema_version' | 'invalid_persisted_tuple'
    }>
  | Readonly<{
      source: 'recovery_marker'
      marker: PacketIssuanceRecoveryMarkerV2
      projectArchived: false
      taskStatus: McpOperatorTaskStatus
      packageStatus: McpOperatorPackageStatus
      packageGrantTargetId: string
      localChangeBarrier: {
        unresolvedCount: number
        fingerprint: string | null
        version: number
        sourceSetFingerprint: string
      }
      currentAuthorization:
        | { state: 'same_decision'; decisionRevision: string; rootBindingRevision: string }
        | {
            state: 'newer_covering_decision'
            priorDecisionRevision: string
            decisionRevision: string
            priorRootBindingRevision: string
            rootBindingRevision: string
          }
        | {
            state: 'not_covering'
            reason: 'denied' | 'revoked' | 'narrowed' | 'policy_changed' | 'root_changed'
          }
        | { state: 'unknown' }
      executionLeaseActive: boolean
      localEvidenceLeaseActive: boolean
      issuanceLeaseActive: boolean
      siblingBarrier: 'none' | 'active_execution' | 'awaiting_review'
    }>
  | Readonly<{
      source: 'integrity_hold'
      hold: PacketIntegrityHoldV2
      taskStatus: McpOperatorTaskStatus
      packageStatus: McpOperatorPackageStatus
    }>

export type LocalIntegrityRepairClassification =
  | Readonly<{ reason: 'missing_local_evidence'; outcome: 'quarantine_only' }>
  | Readonly<{ reason: 'local_evidence_mismatch'; outcome: 'reconstructable' | 'irreconcilable' }>
  | Readonly<{ reason: 'task_projection_mismatch'; outcome: 'reconstructable' | 'irreconcilable' }>
  | Readonly<{ reason: 'quiescence_state_incoherent'; outcome: 'awaiting_service_proof' | 'irreconcilable' }>

export type LocalRunRecoveryPresentationInput =
  | Readonly<{
      source: 'local_effect_recovery'
      marker: LocalEffectRecoveryMarkerV1
      taskStatus: McpOperatorTaskStatus
      packageStatus: McpOperatorPackageStatus
      localChangeBarrier: {
        unresolvedCount: number
        fingerprint: string | null
        version: number
        sourceSetFingerprint: string
      }
      ownershipBarrier: {
        executionLeaseActive: boolean
        localEvidenceLeaseActive: boolean
        packetIssuanceLeaseActive: boolean
      }
      siblingBarrier: 'none' | 'active_execution' | 'awaiting_review'
      invocationState: 'definitive_not_started' | 'invoking' | 'returned' | 'uncertain'
      hostApplyReview: HostApplyRecoveryReview
      repositoryReviews: {
        workingTree: RepositoryChangeReview
        gitControl: RepositoryChangeReview
        gitStorage: RepositoryChangeReview
      }
      localRetryEligibility:
        | { state: 'eligible'; policyRevision: string; policyFingerprint: string }
        | { state: 'ineligible'; reason: 'attempts_exhausted' | 'retry_disabled' | 'handoff_policy_disallows' }
    }>
  | Readonly<{
      source: 'state_pending_reconciliation'
      reason: 'expired_local_claim_observed' | 'partial_local_terminalization_observed'
      databaseObservedAt: string
    }>
  | Readonly<{
      source: 'state_unavailable'
      reason: 'unknown_persisted_status' | 'unsupported_schema_version' | 'invalid_persisted_tuple'
    }>
  | Readonly<{
      source: 'quiescence_wait'
      reason: 'local_run_quiescence_unproven' | 'authorized_recovery_worker_unavailable'
      alertId: string
      membershipChangeId: string | null
      evidenceFingerprint: string
      taskStatus: 'running'
      packageStatus: 'running'
    }>
  | Readonly<{
      source: 'local_effect_integrity_hold'
      hold: LocalEffectIntegrityHoldV1
      repairClassification: LocalIntegrityRepairClassification
      taskStatus: McpOperatorTaskStatus
      packageStatus: McpOperatorPackageStatus
    }>

const EMPTY_ACTIONS = [] as const
const POSITIVE_REVISION = /^[1-9][0-9]*$/u
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/u
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const FINGERPRINT = /^sha256:[0-9a-f]{64}$/u

export const MCP_UI_MUTATION_HANDLERS = [
  ...LOCAL_EFFECT_RECOVERY_ACTIONS,
  PACKET_ISSUANCE_RECOVERY_ACTIONS[1],
  PACKET_ISSUANCE_RECOVERY_ACTIONS[0],
  PACKET_ISSUANCE_RECOVERY_ACTIONS[2],
] as const

export const MCP_OPERATOR_RECOVERY_SUITE_ID = MCP_ADMISSION_OPERATOR_RECOVERY_SUITE_ID

function unavailablePresentation(): AdmissionPresentation {
  return {
    statusKey: 'legacy',
    tone: 'neutral',
    badgeText: 'Status unavailable',
    headline: 'Status unavailable',
    body: 'Forge cannot safely interpret this state. Update Forge or inspect the operator configuration.',
    actions: EMPTY_ACTIONS,
  }
}

function legacyPresentation(): AdmissionPresentation {
  return {
    statusKey: 'legacy',
    tone: 'neutral',
    badgeText: 'Re-open plan to recompute',
    headline: 'Admission decision needs recomputing',
    body: 'This decision predates the current MCP admission contract. Re-open the plan before relying on it.',
    actions: EMPTY_ACTIONS,
  }
}

function projectToolsHref(projectId: string): string {
  return `/dashboard/projects/${encodeURIComponent(projectId)}#project-mcps-heading`
}

function isPositiveRevision(value: unknown): value is string {
  return typeof value === 'string' && POSITIVE_REVISION.test(value)
}

function isSafeId(value: unknown): value is string {
  return typeof value === 'string' && SAFE_ID.test(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function grantStateIsCoherent(value: AdmissionFilesystemGrantPresentationState): boolean {
  if (value.kind === 'not_applicable') return true
  if (value.kind === 'effective_approved') {
    return value.grantPhase === 'approved' &&
      value.grantConsumed === false &&
      isPositiveRevision(value.grantDecisionRevision) &&
      value.revocationReason === null
  }
  if (value.holdKind === 'approval_required') {
    return ['none', 'proposed', 'not_issued'].includes(value.grantPhase) &&
      value.grantConsumed === false &&
      value.grantDecisionRevision === null &&
      value.revocationReason === null
  }
  if (value.holdKind === 'denied_required') {
    return value.grantPhase === 'denied' &&
      value.grantConsumed === false &&
      (value.grantDecisionRevision === null || isPositiveRevision(value.grantDecisionRevision)) &&
      value.revocationReason === null
  }
  if (value.holdKind === 'revoked_required') {
    return value.grantPhase === 'revoked' &&
      value.grantConsumed === false &&
      isPositiveRevision(value.grantDecisionRevision) &&
      ['project_grant_removed', 'project_grant_narrowed', 'project_root_repoint'].includes(value.revocationReason)
  }
  return value.holdKind === 'consumed_once' &&
    value.grantPhase === 'approved' &&
    value.grantConsumed === true &&
    isPositiveRevision(value.grantDecisionRevision) &&
    value.revocationReason === null
}

function decisionTupleIsCoherent(input: AdmissionDecisionPresentationInput): boolean {
  if (!isSafeId(input.projectId) || !grantStateIsCoherent(input.grantState)) return false
  if (input.packageGrantTargetId !== undefined && !isSafeId(input.packageGrantTargetId)) return false
  if (input.retryable && input.recoveryAction !== 'install_or_fix_mcp') return false

  if (input.mode === 'unknown_legacy') {
    return input.recoveryAction === undefined && input.grantState.kind === 'not_applicable' && !input.retryable
  }
  if (input.recoveryAction === 'revise_plan') {
    return (input.mode === 'blocked' || input.mode === 'deferred_live_mcp') && input.admissionStatus === 'blocked'
  }
  if (input.recoveryAction === 'approve_project_filesystem_context') {
    return input.mode === 'bounded_context_required' &&
      (input.admissionStatus === 'blocked' || input.admissionStatus === 'warning') &&
      input.grantState.kind === 'operator_hold'
  }
  if (input.recoveryAction === 'install_or_fix_mcp') {
    return (input.mode === 'blocked' || input.mode === 'bounded_context_approved') &&
      (input.admissionStatus === 'blocked' || input.admissionStatus === 'warning')
  }
  if (input.recoveryAction === 'continue_as_prompt_context') {
    return input.mode === 'planning_only' &&
      (input.admissionStatus === 'allowed' || input.admissionStatus === 'warning') &&
      input.grantState.kind === 'not_applicable' &&
      !input.retryable
  }
  if (input.recoveryAction === 'defer_live_mcp_feature') {
    return input.mode === 'deferred_live_mcp' &&
      input.requirement === 'optional' &&
      input.admissionStatus === 'warning' &&
      input.grantState.kind === 'not_applicable' &&
      !input.retryable
  }
  return input.mode === 'bounded_context_approved' &&
    input.admissionStatus === 'allowed' &&
    input.grantState.kind === 'effective_approved' &&
    !input.retryable
}

function projectContextHoldPresentation(
  input: AdmissionDecisionPresentationInput,
): AdmissionPresentation {
  if (input.grantState.kind !== 'operator_hold') return unavailablePresentation()
  const targetId = input.packageGrantTargetId
  const actions: PresentationActions = targetId
    ? [{ kind: 'scroll', label: 'Review project context', targetId }]
    : EMPTY_ACTIONS

  if (input.grantState.holdKind === 'denied_required') {
    return {
      statusKey: 'action_required',
      tone: 'danger',
      badgeText: 'Context was denied',
      headline: 'Project context was denied',
      body: 'This package cannot receive the required read-only project context until an operator approves it.',
      actions,
    }
  }
  if (input.grantState.holdKind === 'consumed_once') {
    return {
      statusKey: 'action_required',
      tone: 'warning',
      badgeText: 'Approval already used',
      headline: 'One-time context approval was already used',
      body: 'Approve a new bounded context grant before this package can run again.',
      actions,
    }
  }
  if (input.grantState.holdKind === 'revoked_required') {
    const copy = {
      project_grant_removed: {
        badge: 'Context removed',
        headline: 'Project context was removed',
        body: 'This package no longer has a current read-only project context grant.',
      },
      project_grant_narrowed: {
        badge: 'Context no longer covers package',
        headline: 'Project context no longer covers this package',
        body: 'The current grant is narrower than this package requires. Review the package grant before continuing.',
      },
      project_root_repoint: {
        badge: 'Project root changed',
        headline: 'Project root changed — approve context again',
        body: 'The previous decision is bound to an older project root. Forge will not show either path or reuse that approval.',
      },
    }[input.grantState.revocationReason]
    return {
      statusKey: 'action_required',
      tone: 'warning',
      badgeText: copy.badge,
      headline: copy.headline,
      body: copy.body,
      actions,
    }
  }
  return {
    statusKey: 'action_required',
    tone: 'warning',
    badgeText: 'Needs project context',
    headline: 'Read-only project context needs approval',
    body: 'Review the bounded filesystem capabilities requested for this package. No live filesystem tool handles are issued.',
    actions,
  }
}

export function admissionPresentation(
  input: AdmissionDecisionPresentationInput,
): AdmissionPresentation {
  if (!decisionTupleIsCoherent(input)) return unavailablePresentation()
  if (input.mode === 'unknown_legacy') return legacyPresentation()

  if (input.recoveryAction === 'revise_plan') {
    const deferred = input.mode === 'deferred_live_mcp'
    return {
      statusKey: deferred ? 'deferred' : 'action_required',
      tone: deferred ? 'neutral' : 'danger',
      badgeText: deferred ? 'Deferred — MCP boundary' : 'Plan needs changes',
      headline: deferred ? 'Live MCP access is deferred' : 'Revise the plan before execution',
      body: deferred
        ? 'Forge issued no MCP capability through its MCP channel. Agent Communication Protocol (ACP) local processes are not security sandboxes and may have other tools.'
        : 'The requested operation cannot proceed within the current MCP admission boundary.',
      actions: [{ kind: 'request_changes', label: 'Request plan changes' }],
    }
  }

  if (input.recoveryAction === 'approve_project_filesystem_context') {
    return projectContextHoldPresentation(input)
  }

  if (input.recoveryAction === 'install_or_fix_mcp') {
    return {
      statusKey: 'unhealthy',
      tone: 'danger',
      badgeText: 'MCP setup required',
      headline: 'MCP setup needs attention',
      body: 'Install, enable, connect, or repair this MCP on the project before trying the handoff again.',
      actions: [{
        kind: 'link',
        label: 'Open project MCP tools',
        href: projectToolsHref(input.projectId),
      }],
    }
  }

  if (input.mode === 'planning_only') {
    return {
      statusKey: 'planning',
      tone: 'neutral',
      badgeText: 'Planning context',
      headline: 'Planning context only',
      body: 'Forge may include instructions in the plan, but it issued no MCP capability or bounded project packet.',
      actions: EMPTY_ACTIONS,
    }
  }

  if (input.mode === 'deferred_live_mcp') {
    return {
      statusKey: 'deferred',
      tone: 'neutral',
      badgeText: 'Deferred — MCP boundary',
      headline: 'Live MCP access is deferred',
      body: 'Forge issued no MCP capability through its MCP channel. Agent Communication Protocol (ACP) local processes are not security sandboxes and may have other tools.',
      actions: EMPTY_ACTIONS,
    }
  }

  return {
    statusKey: 'approved',
    tone: 'positive',
    badgeText: 'Context approved',
    headline: 'Read-only project context approved',
    body: 'Forge may assemble only the approved bounded project context for this package. No live filesystem tool handles are issued.',
    actions: EMPTY_ACTIONS,
  }
}

const REDACTION_LABELS: Record<PacketRedactionCategory, string> = {
  private_key_blocks: 'Private key blocks',
  authorization_bearer: 'Authorization bearer values',
  docker_auth: 'Docker credentials',
  netrc_credentials: 'Netrc credentials',
  pgpass_credentials: 'PostgreSQL password-file values',
  secret_like_assignments: 'Secret-like assignments',
  structured_secret_keys: 'Structured secret keys',
  database_urls: 'Database connection URLs',
  url_userinfo: 'URL user information',
  well_known_token_prefixes: 'Known token formats',
  cloud_api_tokens: 'Cloud API tokens',
  jwt: 'JSON Web Tokens',
}

type PacketFailureCode = Extract<PacketTerminalOutcome, { status: 'failed' }>['failureCode']

const PACKET_FAILURE_COPY: Record<PacketFailureCode, string> = {
  authorization_changed: 'Project authorization changed before the attempt finished.',
  execution_lease_expired: 'The execution lease expired before the attempt finished.',
  local_evidence_lease_expired: 'The local evidence lease expired before the attempt finished.',
  issuance_lease_expired: 'The packet issuance lease expired before the attempt finished.',
  worker_stopped: 'The worker stopped before the attempt finished.',
  preflight_failed: 'The bounded-context preflight did not complete.',
  assembly_failed: 'The bounded-context packet could not be assembled.',
  submission_rejected: 'The request was not accepted.',
  submission_uncertain: 'Forge could not confirm whether the request was accepted.',
  provider_response_invalid: 'The returned response did not satisfy the expected protocol.',
  external_repository_change_requires_review: 'Repository state changed during the worker attempt and requires review.',
  post_submission_execution_failed: 'Execution failed after submission. Prior work and local repository state require review.',
}

const POST_SUBMISSION_STAGE_COPY: Record<
  Extract<
    Extract<PacketTerminalOutcome, { status: 'failed' }>,
    { failureCode: 'post_submission_execution_failed' }
  >['failureStage'],
  string
> = {
  sandbox_apply: 'The failure occurred while applying sandbox output.',
  validation: 'The failure occurred during output validation.',
  host_apply: 'The failure occurred during host apply; some local files may already have changed.',
  repository_evidence: 'The failure occurred while recording repository evidence.',
  completion_preparation: 'The failure occurred before the atomic completion finalizer.',
}

function packetArtifactUnavailable(): PacketArtifactPresentation {
  return {
    statusKey: 'legacy',
    tone: 'neutral',
    badgeText: 'Evidence unavailable',
    headline: 'Packet evidence unavailable',
    body: 'Forge cannot safely display this packet evidence. Update Forge or ask Release/DevOps to inspect the retained records.',
    actions: EMPTY_ACTIONS,
    facts: EMPTY_ACTIONS,
  }
}

function repositoryReviewIsValid(review: RepositoryChangeReview): boolean {
  return parseRepositoryChangeReview(review) !== null
}

function packetProjectionIsValid(input: Extract<PacketArtifactPresentationInput, { source: 'validated_artifact' }>): boolean {
  const projection = input.projection
  const reviews = Object.values(projection.repositoryReviews)
  if (
    projection.schemaVersion !== 2 ||
    !UUID.test(input.agentRunId) ||
    !FINGERPRINT.test(input.localRunEvidenceFingerprint) ||
    !FINGERPRINT.test(projection.combinedRepositoryReviewFingerprint) ||
    !packetTerminalTupleIsValid(projection) ||
    !parseHostApplyRecoveryReview(projection.hostApplyReview) ||
    !reviews.every(repositoryReviewIsValid)
  ) return false

  if (projection.assembly.state === 'assembled' && !parsePacketRedactionSummary(projection.assembly.redactionSummary)) {
    return false
  }
  if (projection.effect.state === 'quiesced' && !FINGERPRINT.test(projection.effect.hostApplyLedgerFingerprint)) {
    return false
  }
  if (projection.terminal.status === 'succeeded') {
    return projection.hostApplyReview.state !== 'review_required' && reviews.every((review) => (
      review.state === 'not_applicable' &&
      (review.changeResult === 'not_observed' || review.changeResult === 'unchanged')
    ))
  }
  return true
}

function deliveryFact(delivery: TerminalPacketDeliveryOutcome): string {
  if (delivery.state === 'not_exposed') return 'Not submitted'
  if (delivery.state === 'submission_failed') return 'Request not accepted'
  if (delivery.state === 'submission_uncertain') return 'Submission could not be confirmed'
  return 'Submitted to worker'
}

export function packetArtifactPresentation(
  input: PacketArtifactPresentationInput,
): PacketArtifactPresentation {
  if (input.source === 'artifact_unavailable' || !packetProjectionIsValid(input)) {
    return packetArtifactUnavailable()
  }

  const { assembly, delivery, terminal } = input.projection
  const facts: Array<Readonly<{ label: string; value: string }>> = []
  if (assembly.state === 'assembled') {
    facts.push(
      { label: 'Assembly', value: 'Assembled for this project' },
      { label: 'Included files', value: String(assembly.includedCount) },
      { label: 'Packet bytes', value: String(assembly.byteCount) },
      { label: 'Omitted files', value: String(assembly.omittedCount) },
    )
    for (const category of PACKET_REDACTION_CATEGORIES) {
      const count = assembly.redactionSummary[category]
      if (count !== undefined && count > 0) {
        facts.push({ label: REDACTION_LABELS[category], value: String(count) })
      }
    }
  } else if (assembly.state === 'not_assembled') {
    facts.push(
      { label: 'Assembly', value: 'Not assembled' },
      { label: 'Stopped at', value: assembly.failureStage === 'claim' ? 'Claim' : 'Preflight' },
    )
  } else {
    facts.push({ label: 'Assembly', value: 'Could not be confirmed' })
  }
  facts.push(
    { label: 'Delivery', value: deliveryFact(delivery) },
    { label: 'Run result', value: terminal.status === 'succeeded' ? 'Succeeded' : 'Failed' },
  )

  if (terminal.status === 'succeeded') {
    return {
      statusKey: 'approved',
      tone: 'positive',
      badgeText: 'Evidence retained',
      headline: 'Bounded context packet completed',
      body: 'Forge retained bounded metadata for this exact run. Packet contents, selected names, filesystem paths, prompts, credentials, and host-resource details are not displayed.',
      actions: EMPTY_ACTIONS,
      facts,
    }
  }

  const stageCopy = terminal.failureCode === 'post_submission_execution_failed'
    ? ` ${POST_SUBMISSION_STAGE_COPY[terminal.failureStage]}`
    : ''
  return {
    statusKey: 'action_required',
    tone: 'warning',
    badgeText: 'Attempt ended',
    headline: assembly.state === 'assembly_unconfirmed'
      ? 'Packet assembly could not be confirmed'
      : 'Bounded context attempt did not complete',
    body: `${PACKET_FAILURE_COPY[terminal.failureCode]}${stageCopy} Forge did not roll back local changes. The artifact itself never authorizes retry.`,
    actions: EMPTY_ACTIONS,
    facts,
  }
}

function packetRequest(marker: PacketIssuanceRecoveryMarkerV2): PacketRecoveryRequestIdentity {
  return {
    schemaVersion: 2,
    priorRuntimeAuditId: marker.priorRuntimeAuditId,
    markerFingerprint: marker.markerFingerprint,
  }
}

function packetDecline(marker: PacketIssuanceRecoveryMarkerV2): PacketRecoveryDeclineCta {
  return {
    kind: 'decline_packet_recovery',
    label: 'Do not retry — close this package',
    handler: 'decline_packet_recovery',
    request: packetRequest(marker),
  }
}

function recoveryBarrierCopy(input: Extract<PacketCurrentStatePresentationInput, { source: 'recovery_marker' }>): AdmissionPresentation | null {
  if (input.siblingBarrier === 'active_execution') {
    return {
      statusKey: 'deferred', tone: 'neutral', badgeText: 'Waiting',
      headline: 'Waiting for active package',
      body: 'Another package still owns active execution. Recovery remains actionless until the server reconciles the task.',
      actions: EMPTY_ACTIONS,
    }
  }
  if (input.siblingBarrier === 'awaiting_review') {
    return {
      statusKey: 'deferred', tone: 'neutral', badgeText: 'Review pending',
      headline: 'Waiting for required review',
      body: 'A sibling package still needs mandatory review. Forge will not start another run while that barrier remains.',
      actions: EMPTY_ACTIONS,
    }
  }
  if (input.executionLeaseActive || input.localEvidenceLeaseActive || input.issuanceLeaseActive) {
    return {
      statusKey: 'deferred', tone: 'neutral', badgeText: 'Run still owned',
      headline: 'Waiting for the current run',
      body: 'A server-observed execution, evidence, or issuance lease is still active. No recovery action is available.',
      actions: EMPTY_ACTIONS,
    }
  }
  if (input.taskStatus !== 'approved' || input.packageStatus !== 'blocked') {
    return {
      statusKey: 'deferred', tone: 'neutral', badgeText: 'Recovery pending',
      headline: 'Refreshing recovery state',
      body: 'The task aggregate has not reached the exact approved operator-hold state required for recovery.',
      actions: EMPTY_ACTIONS,
    }
  }
  return null
}

export function packetCurrentStatePresentation(
  input: PacketCurrentStatePresentationInput,
): AdmissionPresentation {
  if (input.source === 'state_unavailable') return unavailablePresentation()
  if (input.source === 'state_pending_reconciliation') {
    return {
      statusKey: 'deferred', tone: 'neutral', badgeText: 'Refreshing run state',
      headline: 'Refreshing run state',
      body: 'Forge observed a valid expired or partially finalized state and is reconciling it from retained records.',
      actions: EMPTY_ACTIONS,
    }
  }
  if (input.source === 'active_claim') {
    const phaseCopy: Record<ActivePacketClaimState['phase'], { badge: string; headline: string }> = {
      preparing: { badge: 'Preparing', headline: 'Preparing project context' },
      assembling: { badge: 'Preparing', headline: 'Preparing project context' },
      assembled: { badge: 'Assembled', headline: 'Context assembled' },
      submitting: { badge: 'Submitting', headline: 'Submitting to worker' },
      accepted_finalizing: { badge: 'Finalizing', headline: 'Worker accepted — finalizing' },
      rejected_finalizing: { badge: 'Finalizing', headline: 'Submission rejected — finalizing' },
    }
    const copy = phaseCopy[input.claimState.phase]
    return copy ? {
      statusKey: 'deferred', tone: 'neutral', badgeText: copy.badge,
      headline: copy.headline,
      body: 'This is the last durable server-observed phase. It does not claim a terminal result or expose packet contents.',
      actions: EMPTY_ACTIONS,
    } : unavailablePresentation()
  }
  if (input.source === 'integrity_hold') {
    if (!parsePacketIntegrityHold(input.hold)) return unavailablePresentation()
    return input.hold.reason === 'audit_artifact_mismatch' ? {
      statusKey: 'unhealthy', tone: 'danger', badgeText: 'Evidence quarantined',
      headline: 'Run evidence conflicts — quarantined',
      body: 'Immutable run records conflict. Release/DevOps must inspect the retained evidence using docs/operators/local-execution-integrity-repair.md; the browser cannot rewrite or close it.',
      actions: EMPTY_ACTIONS,
    } : {
      statusKey: 'action_required', tone: 'warning', badgeText: 'Operator repair required',
      headline: 'Run evidence needs operator repair',
      body: 'Terminal success evidence is incomplete. Release/DevOps must use docs/operators/local-execution-integrity-repair.md; no browser recovery action is available.',
      actions: EMPTY_ACTIONS,
    }
  }

  const marker = parsePacketIssuanceRecoveryMarker(input.marker)
  if (!marker || !isSafeId(input.packageGrantTargetId)) return unavailablePresentation()
  if (input.localChangeBarrier.unresolvedCount > 0) {
    return {
      statusKey: 'action_required', tone: 'warning', badgeText: 'Local review required',
      headline: 'Review local changes before packet recovery',
      body: 'The packet action remains unavailable until the exact generic local-evidence review is complete.',
      actions: EMPTY_ACTIONS,
    }
  }
  const barrier = recoveryBarrierCopy(input)
  if (barrier) return barrier
  const decline = packetDecline(marker)

  if (marker.disposition === 'review_local_changes') {
    return {
      statusKey: 'action_required', tone: 'warning', badgeText: 'Local review required',
      headline: 'Review local changes before packet recovery',
      body: 'Use the separate local-run recovery control. Packet recovery cannot clear local evidence.',
      actions: EMPTY_ACTIONS,
    }
  }
  if (marker.disposition === 'review_submission' || marker.disposition === 'review_then_reapprove_allow_once') {
    const primary: PacketRecoveryPrimaryCta = {
      kind: 'review_submission',
      label: 'I understand the prior submission may have happened',
      handler: 'acknowledge_possible_submission',
      request: packetRequest(marker),
    }
    return {
      statusKey: 'action_required', tone: 'warning', badgeText: 'Submission uncertain',
      headline: 'Review possible prior submission',
      body: 'The earlier request may have produced work. Acknowledge that uncertainty before another packet attempt, or decline recovery without acknowledging it.',
      actions: [primary, decline],
    }
  }
  if (marker.disposition === 'reapprove_allow_once') {
    const primary: PacketRecoveryPrimaryCta = {
      kind: 'reapprove_packet_context',
      label: 'Review one-time project context',
      targetId: input.packageGrantTargetId,
      request: packetRequest(marker),
    }
    return {
      statusKey: 'action_required', tone: 'warning', badgeText: 'Reapproval required',
      headline: input.currentAuthorization.state === 'not_covering' && input.currentAuthorization.reason === 'root_changed'
        ? 'Project root changed — approve context again'
        : 'Approve one-time project context again',
      body: 'A new bounded approval is required. Forge will re-check the exact recovery identity after approval and does not reuse the former path binding.',
      actions: [primary, decline],
    }
  }
  if (marker.disposition === 'retry_execution' || marker.disposition === 'reviewed_submission') {
    if (input.currentAuthorization.state === 'unknown' || input.currentAuthorization.state === 'not_covering') {
      return {
        statusKey: 'action_required', tone: 'warning', badgeText: 'Authorization changed',
        headline: input.currentAuthorization.state === 'not_covering' && input.currentAuthorization.reason === 'root_changed'
          ? 'Project root changed — approve context again'
          : 'Current project context does not cover this retry',
        body: 'Forge will not retry under a stale, denied, narrowed, changed, or unknown authorization decision.',
        actions: [decline],
      }
    }
    const primary: PacketRecoveryPrimaryCta = {
      kind: 'retry_packet_execution',
      label: 'Retry packet execution',
      handler: 'retry_execution',
      request: packetRequest(marker),
    }
    return {
      statusKey: 'action_required', tone: 'warning', badgeText: 'Retry available',
      headline: 'Packet execution can be retried',
      body: 'Forge will re-fetch and lock the current recovery state before starting one new attempt.',
      actions: [primary, decline],
    }
  }
  return unavailablePresentation()
}

function localRequest(marker: LocalEffectRecoveryMarkerV1): LocalEffectRecoveryRequestIdentity {
  return {
    schemaVersion: 1,
    localRunEvidenceId: marker.localRunEvidenceId,
    evidenceFingerprint: marker.evidenceFingerprint,
  }
}

function localDecline(marker: LocalEffectRecoveryMarkerV1): LocalRecoveryDeclineCta {
  return {
    kind: 'decline_local_retry',
    label: 'Do not retry — close this package',
    handler: 'decline_local_retry',
    request: localRequest(marker),
  }
}

function localReviewsAreValid(input: Extract<LocalRunRecoveryPresentationInput, { source: 'local_effect_recovery' }>): boolean {
  return parseHostApplyRecoveryReview(input.hostApplyReview) !== null &&
    Object.values(input.repositoryReviews).every((review) => parseRepositoryChangeReview(review) !== null)
}

function localReviewRequired(input: Extract<LocalRunRecoveryPresentationInput, { source: 'local_effect_recovery' }>): boolean {
  return input.hostApplyReview.state === 'review_required' ||
    Object.values(input.repositoryReviews).some((review) => review.state === 'review_required')
}

function localBarrierPresentation(input: Extract<LocalRunRecoveryPresentationInput, { source: 'local_effect_recovery' }>): AdmissionPresentation | null {
  if (input.siblingBarrier === 'active_execution') {
    return {
      statusKey: 'deferred', tone: 'neutral', badgeText: 'Waiting',
      headline: 'Waiting for active package',
      body: 'Another package still owns active execution. No local recovery action is available.',
      actions: EMPTY_ACTIONS,
    }
  }
  if (input.siblingBarrier === 'awaiting_review') {
    return {
      statusKey: 'deferred', tone: 'neutral', badgeText: 'Review pending',
      headline: 'Waiting for required review',
      body: 'A sibling package still needs mandatory review. Forge will not start another local attempt.',
      actions: EMPTY_ACTIONS,
    }
  }
  if (
    input.ownershipBarrier.executionLeaseActive ||
    input.ownershipBarrier.localEvidenceLeaseActive ||
    input.ownershipBarrier.packetIssuanceLeaseActive
  ) {
    return {
      statusKey: 'deferred', tone: 'neutral', badgeText: 'Run still owned',
      headline: 'Waiting for the current run',
      body: 'A server-observed execution, evidence, or packet lease is still active. No new local attempt is available.',
      actions: EMPTY_ACTIONS,
    }
  }
  if (input.taskStatus !== 'approved' || input.packageStatus !== 'blocked') {
    return {
      statusKey: 'deferred', tone: 'neutral', badgeText: 'Recovery pending',
      headline: 'Refreshing recovery state',
      body: 'The task aggregate has not reached the exact approved operator-hold state required for local recovery.',
      actions: EMPTY_ACTIONS,
    }
  }
  return null
}

function integrityPresentation(
  input: Extract<LocalRunRecoveryPresentationInput, { source: 'local_effect_integrity_hold' }>,
): AdmissionPresentation {
  const hold = parseLocalEffectIntegrityHold(input.hold)
  if (!hold || hold.reason !== input.repairClassification.reason) return unavailablePresentation()
  const runbook = ' Release/DevOps must use docs/operators/local-execution-integrity-repair.md; no browser repair action is available.'
  if (input.repairClassification.reason === 'missing_local_evidence') {
    return {
      statusKey: 'unhealthy', tone: 'danger', badgeText: 'Evidence missing',
      headline: 'Required local run evidence is missing',
      body: `The absent evidence cannot be reconstructed. Only evidence-preserving quarantine can close the task.${runbook}`,
      actions: EMPTY_ACTIONS,
    }
  }
  if (input.repairClassification.reason === 'local_evidence_mismatch') {
    const reconstructable = input.repairClassification.outcome === 'reconstructable'
    return {
      statusKey: 'unhealthy', tone: reconstructable ? 'warning' : 'danger',
      badgeText: reconstructable ? 'Repair available' : 'Evidence conflicts',
      headline: reconstructable
        ? 'Local run evidence can be reconstructed from preserved records'
        : 'Local run evidence conflicts and cannot be reconstructed',
      body: reconstructable
        ? `The server proved an evidence-preserving reconstruction path.${runbook}`
        : `Evidence-preserving quarantine is the remaining privileged path.${runbook}`,
      actions: EMPTY_ACTIONS,
    }
  }
  if (input.repairClassification.reason === 'task_projection_mismatch') {
    const reconstructable = input.repairClassification.outcome === 'reconstructable'
    return {
      statusKey: 'unhealthy', tone: reconstructable ? 'warning' : 'danger',
      badgeText: reconstructable ? 'Projection repair available' : 'Evidence conflicts',
      headline: reconstructable
        ? 'Task projection can be recomputed from preserved evidence'
        : 'Task projection conflicts with irreconcilable evidence',
      body: reconstructable
        ? `The retained source set can be recomputed without rewriting run evidence.${runbook}`
        : `Evidence-preserving quarantine is the remaining privileged path.${runbook}`,
      actions: EMPTY_ACTIONS,
    }
  }
  const awaitingProof = input.repairClassification.outcome === 'awaiting_service_proof'
  return {
    statusKey: 'unhealthy', tone: awaitingProof ? 'warning' : 'danger',
    badgeText: awaitingProof ? 'Quiescence proof pending' : 'Evidence conflicts',
    headline: awaitingProof
      ? 'Waiting for service-authored quiescence proof'
      : 'Quiescence evidence is irreconcilable',
    body: awaitingProof
      ? `Only the protected service can author the missing proof.${runbook}`
      : `Evidence-preserving quarantine is the remaining privileged path.${runbook}`,
    actions: EMPTY_ACTIONS,
  }
}

export function localRunRecoveryPresentation(
  input: LocalRunRecoveryPresentationInput,
): AdmissionPresentation {
  if (input.source === 'state_unavailable') return unavailablePresentation()
  if (input.source === 'state_pending_reconciliation') {
    return {
      statusKey: 'deferred', tone: 'neutral', badgeText: 'Refreshing run state',
      headline: 'Refreshing run state',
      body: 'Forge observed a valid expired or partially finalized local state and is reconciling it from retained records.',
      actions: EMPTY_ACTIONS,
    }
  }
  if (input.source === 'quiescence_wait') {
    if (!UUID.test(input.alertId) || !FINGERPRINT.test(input.evidenceFingerprint)) return unavailablePresentation()
    if (input.reason === 'authorized_recovery_worker_unavailable') {
      return {
        statusKey: 'unhealthy', tone: 'danger', badgeText: 'Release/DevOps action required',
        headline: 'Recovery worker unavailable — Release/DevOps action required',
        body: 'No eligible recovery instance remains. Run the dry-run command npm run protocol:replace-work-package-instance -- --candidate <new-instance-id> --replaces <old-instance-id> --actor <operator-id> and follow docs/operators/work-package-instance-replacement-v2.md. This page cannot run the command.',
        actions: EMPTY_ACTIONS,
      }
    }
    return {
      statusKey: 'deferred', tone: 'neutral', badgeText: 'Waiting for quiescence',
      headline: 'Waiting for worker changes to stop',
      body: 'Forge has not received authoritative proof that the complete per-run execution group is empty. No new-run control is available.',
      actions: EMPTY_ACTIONS,
    }
  }
  if (input.source === 'local_effect_integrity_hold') return integrityPresentation(input)

  const marker = parseLocalEffectRecoveryMarker(input.marker)
  if (
    !marker ||
    !localReviewsAreValid(input) ||
    !Number.isInteger(input.localChangeBarrier.unresolvedCount) ||
    input.localChangeBarrier.unresolvedCount < 0 ||
    !Number.isInteger(input.localChangeBarrier.version) ||
    input.localChangeBarrier.version < 1 ||
    !FINGERPRINT.test(input.localChangeBarrier.sourceSetFingerprint) ||
    (input.localChangeBarrier.fingerprint !== null && !FINGERPRINT.test(input.localChangeBarrier.fingerprint))
  ) return unavailablePresentation()

  const barrier = localBarrierPresentation(input)
  if (barrier) return barrier
  const reviewRequired = localReviewRequired(input)
  if (reviewRequired) {
    if (marker.disposition !== 'review_local_changes') return unavailablePresentation()
    const review: StandalonePresentationCta = {
      kind: 'review_local_changes',
      label: 'I reviewed the local changes',
      handler: 'review_local_changes',
      request: localRequest(marker),
    }
    return {
      statusKey: 'action_required', tone: 'warning', badgeText: 'Review required',
      headline: 'Repository changed during the worker attempt — review required',
      body: 'Review working-tree files, Git control and configuration, and Git object and history storage. The Agent Communication Protocol (ACP) runtime is not a filesystem sandbox.',
      actions: [review],
    }
  }
  if (input.localChangeBarrier.unresolvedCount !== 0) return unavailablePresentation()
  if (marker.disposition === 'review_local_changes') {
    return {
      statusKey: 'deferred', tone: 'neutral', badgeText: 'Refreshing run state',
      headline: 'Refreshing run state',
      body: 'The review evidence is complete and Forge is waiting for the server-authored recovery transition.',
      actions: EMPTY_ACTIONS,
    }
  }

  const decline = localDecline(marker)
  if (marker.disposition === 'acknowledge_possible_local_invocation') {
    const primary: LocalRecoveryPrimaryCta = {
      kind: 'acknowledge_possible_local_invocation',
      label: 'I understand the prior local invocation may have happened',
      handler: 'acknowledge_possible_local_invocation',
      request: localRequest(marker),
    }
    return {
      statusKey: 'action_required', tone: 'warning', badgeText: 'Invocation uncertain',
      headline: 'Review possible prior local invocation',
      body: 'The prior local invocation may have produced work. Acknowledge that uncertainty before retry, or decline recovery without acknowledging it.',
      actions: [primary, decline],
    }
  }
  if (marker.disposition === 'retry_local_execution') {
    const trustedDirectRetry = marker.reason === 'local_invocation_uncertain' ||
      input.invocationState === 'definitive_not_started'
    if (!trustedDirectRetry) return unavailablePresentation()
    if (input.localRetryEligibility.state === 'ineligible') {
      const reasonCopy = {
        attempts_exhausted: 'The allowed attempt count is exhausted.',
        retry_disabled: 'Local retry is disabled by current policy.',
        handoff_policy_disallows: 'The current handoff policy does not allow another local attempt.',
      }[input.localRetryEligibility.reason]
      return {
        statusKey: 'action_required', tone: 'warning', badgeText: 'Retry unavailable',
        headline: 'Local execution cannot be retried',
        body: `${reasonCopy} The operator may still close the package without discarding evidence.`,
        actions: [decline],
      }
    }
    if (!POSITIVE_REVISION.test(input.localRetryEligibility.policyRevision) || !FINGERPRINT.test(input.localRetryEligibility.policyFingerprint)) {
      return unavailablePresentation()
    }
    const primary: LocalRecoveryPrimaryCta = {
      kind: 'retry_local_execution',
      label: 'Start another local attempt',
      handler: 'retry_local_execution',
      request: localRequest(marker),
    }
    return {
      statusKey: 'action_required', tone: 'warning', badgeText: 'Retry available',
      headline: 'Local execution can be retried',
      body: 'Forge will re-fetch and lock the exact local evidence and current retry policy before starting one new attempt.',
      actions: [primary, decline],
    }
  }
  return unavailablePresentation()
}

function runtimeBoundary(runtime: McpCatalogEntry['runtime']): string | null {
  if (runtime.liveTools) return null
  if (runtime.mode === 'bounded_context_packet') {
    return 'Bounded read-only context; no live tool handles.'
  }
  if (runtime.mode === 'external_service') {
    return 'Planning context only in this beta; no live tool handles.'
  }
  return null
}

function projectInputIsCoherent(input: ProjectMcpPresentationInput): boolean {
  if (
    !isSafeId(input.projectId) ||
    !['filesystem', 'github'].includes(input.mcpId) ||
    !['installed', 'missing'].includes(input.installState) ||
    ![
      'healthy',
      'unhealthy',
      'disabled',
      'auth_required',
      'configuration_required',
      'unknown',
    ].includes(input.healthStatus) ||
    typeof input.enabled !== 'boolean'
  ) return false
  if (!runtimeBoundary(input.runtime)) return false
  if (input.installState === 'missing') return true
  if (input.healthStatus === 'healthy') return input.enabled
  if (input.healthStatus === 'disabled' || !input.enabled) return true
  return input.enabled
}

export function projectMcpPresentation(
  input: ProjectMcpPresentationInput,
): McpSurfacePresentation {
  if (!projectInputIsCoherent(input)) return unavailablePresentation()
  const boundary = runtimeBoundary(input.runtime)
  if (!boundary) return unavailablePresentation()

  if (input.installState === 'missing') {
    return {
      statusKey: 'action_required',
      tone: 'warning',
      badgeText: 'Not installed',
      headline: 'Install this MCP for the project',
      body: `${boundary} Installation does not grant runtime access.`,
      actions: [{ kind: 'install', label: 'Install MCP', handler: 'install_mcp' }],
    }
  }
  if (input.healthStatus === 'disabled' || !input.enabled) {
    return {
      statusKey: 'action_required',
      tone: 'warning',
      badgeText: 'Disabled',
      headline: 'Enable this MCP for the project',
      body: boundary,
      actions: [{ kind: 'enable', label: 'Enable MCP', handler: 'enable_mcp' }],
    }
  }
  if (input.healthStatus === 'auth_required') {
    return {
      statusKey: 'action_required',
      tone: 'warning',
      badgeText: 'Account required',
      headline: 'Connect an account',
      body: `${boundary} Forge needs an authenticated account before this MCP is ready.`,
      actions: [{ kind: 'connect', label: 'Connect account', handler: 'connect_account' }],
    }
  }
  if (input.healthStatus === 'configuration_required') {
    return {
      statusKey: 'action_required',
      tone: 'warning',
      badgeText: 'Configuration required',
      headline: 'Configure this project MCP',
      body: `${boundary} Complete the required project settings before execution.`,
      actions: [{ kind: 'configure', label: 'Configure MCP', handler: 'configure_project_mcp' }],
    }
  }
  if (input.healthStatus === 'unhealthy') {
    return {
      statusKey: 'unhealthy',
      tone: 'danger',
      badgeText: 'Needs attention',
      headline: 'MCP health check failed',
      body: `${boundary} Inspect the bounded health result and repair the project setup.`,
      actions: [{ kind: 'inspect_fix', label: 'Inspect MCP setup', handler: 'inspect_mcp_health' }],
    }
  }
  if (input.healthStatus === 'unknown') {
    return {
      statusKey: 'deferred',
      tone: 'neutral',
      badgeText: 'Status not checked',
      headline: 'Refresh MCP status',
      body: `${boundary} Forge has a valid transient status record but no current health observation.`,
      actions: [{ kind: 'refresh', label: 'Refresh status', handler: 'refresh_mcp_health' }],
    }
  }
  return {
    statusKey: 'approved',
    tone: 'positive',
    badgeText: 'Ready',
    headline: 'MCP setup is ready',
    body: boundary,
    actions: EMPTY_ACTIONS,
  }
}

export function catalogMcpPresentation(
  input: CatalogMcpPresentationInput,
): McpSurfacePresentation {
  const boundary = runtimeBoundary(input.runtime)
  if (!['filesystem', 'github'].includes(input.id) || !boundary) return unavailablePresentation()
  return {
    statusKey: 'planning',
    tone: 'neutral',
    badgeText: input.runtime.mode === 'bounded_context_packet' ? 'Bounded context' : 'External service',
    headline: input.runtime.mode === 'bounded_context_packet'
      ? 'Bounded project context'
      : 'External service planning context',
    body: boundary,
    actions: EMPTY_ACTIONS,
  }
}

/**
 * Compatibility readers accept persisted/API-shaped data and either return a
 * closed presenter input or null. Null is rendered with neutral, actionless copy;
 * raw reasons, paths, errors, and future enum values never reach copy selection.
 */
export function normalizeAdmissionDecisionPresentationInput(
  value: unknown,
  context: { projectId: string; packageGrantTargetId?: string },
): AdmissionDecisionPresentationInput | null {
  if (!isRecord(value) || !isSafeId(context.projectId)) return null
  const mode = value.mode
  const admissionStatus = value.admissionStatus ?? value.status
  const recoveryAction = value.recoveryAction
  const requirement = value.requirement
  const retryable = value.retryable
  if (
    !['planning_only', 'bounded_context_required', 'bounded_context_approved', 'blocked', 'deferred_live_mcp', 'unknown_legacy'].includes(String(mode)) ||
    !['allowed', 'warning', 'blocked'].includes(String(admissionStatus)) ||
    !['required', 'optional'].includes(String(requirement)) ||
    typeof retryable !== 'boolean' ||
    (recoveryAction !== undefined && ![
      'continue_as_prompt_context',
      'approve_project_filesystem_context',
      'install_or_fix_mcp',
      'revise_plan',
      'defer_live_mcp_feature',
    ].includes(String(recoveryAction)))
  ) return null

  const grant = isRecord(value.grantState) ? value.grantState : null
  let grantState: AdmissionFilesystemGrantPresentationState = { kind: 'not_applicable' }
  if (grant) {
    if (
      grant.kind === 'effective_approved' &&
      grant.grantPhase === 'approved' &&
      grant.grantConsumed === false &&
      isPositiveRevision(grant.grantDecisionRevision) &&
      grant.revocationReason === null
    ) {
      grantState = {
        kind: 'effective_approved',
        grantPhase: 'approved',
        grantConsumed: false,
        grantDecisionRevision: grant.grantDecisionRevision,
        revocationReason: null,
      }
    } else if (grant.kind === 'operator_hold') {
      grantState = grant as AdmissionFilesystemGrantPresentationState
    } else {
      return null
    }
  }

  const input: AdmissionDecisionPresentationInput = {
    mode: mode as McpAdmissionMode,
    admissionStatus: admissionStatus as McpAdmissionStatus,
    ...(recoveryAction !== undefined ? { recoveryAction: recoveryAction as McpRecoveryAction } : {}),
    grantState,
    requirement: requirement as 'required' | 'optional',
    retryable,
    projectId: context.projectId,
    ...(context.packageGrantTargetId ? { packageGrantTargetId: context.packageGrantTargetId } : {}),
  }
  return decisionTupleIsCoherent(input) ? input : null
}

export function admissionPresentationFromUnknown(
  value: unknown,
  context: { projectId: string; packageGrantTargetId?: string },
): AdmissionPresentation {
  const normalized = normalizeAdmissionDecisionPresentationInput(value, context)
  return normalized ? admissionPresentation(normalized) : unavailablePresentation()
}

export function projectMcpPresentationFromUnknown(
  value: unknown,
): McpSurfacePresentation {
  if (!isRecord(value) || !isRecord(value.runtime)) return unavailablePresentation()
  const input = {
    projectId: value.projectId,
    mcpId: value.mcpId,
    installState: value.installState,
    healthStatus: value.healthStatus ?? value.status,
    enabled: value.enabled,
    runtime: value.runtime,
  } as ProjectMcpPresentationInput
  return projectMcpPresentation(input)
}

export function catalogMcpPresentationFromUnknown(
  value: unknown,
): McpSurfacePresentation {
  if (!isRecord(value) || !isRecord(value.runtime)) return unavailablePresentation()
  return catalogMcpPresentation(value as CatalogMcpPresentationInput)
}
