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

const EMPTY_ACTIONS = [] as const
const POSITIVE_REVISION = /^[1-9][0-9]*$/u
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/u

export const MCP_OPERATOR_RECOVERY_SUITE_ID = 'mcp-admission.operator-recovery' as const

export const MCP_UI_MUTATION_HANDLERS = [
  'review_local_changes',
  'acknowledge_possible_local_invocation',
  'retry_local_execution',
  'decline_local_retry',
  'retry_execution',
  'acknowledge_possible_submission',
  'decline_packet_recovery',
] as const

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
