import { describe, expect, it } from 'vitest'
import {
  MCP_OPERATOR_RECOVERY_SUITE_ID,
  MCP_UI_MUTATION_HANDLERS,
  admissionPresentation,
  admissionPresentationFromUnknown,
  catalogMcpPresentation,
  catalogMcpPresentationFromUnknown,
  projectMcpPresentation,
  projectMcpPresentationFromUnknown,
  type AdmissionDecisionPresentationInput,
  type ProjectMcpPresentationInput,
} from '@/lib/mcps/admission-copy'
import { MCP_CATALOG } from '@/lib/mcps/catalog'

const projectId = '11111111-1111-4111-8111-111111111111'

function decision(
  overrides: Partial<AdmissionDecisionPresentationInput>,
): AdmissionDecisionPresentationInput {
  return {
    mode: 'planning_only',
    admissionStatus: 'allowed',
    recoveryAction: 'continue_as_prompt_context',
    grantState: { kind: 'not_applicable' },
    requirement: 'required',
    retryable: false,
    projectId,
    ...overrides,
  }
}

function projectMcp(
  overrides: Partial<ProjectMcpPresentationInput>,
): ProjectMcpPresentationInput {
  return {
    projectId,
    mcpId: 'filesystem',
    installState: 'installed',
    healthStatus: 'healthy',
    enabled: true,
    runtime: MCP_CATALOG.filesystem.runtime,
    ...overrides,
  }
}

describe('MCP admission operator copy', () => {
  it('keeps the S6 suite and seven S4 UI mutation identities stable', () => {
    expect(MCP_OPERATOR_RECOVERY_SUITE_ID).toBe('mcp-admission.operator-recovery')
    expect(MCP_UI_MUTATION_HANDLERS).toEqual([
      'review_local_changes',
      'acknowledge_possible_local_invocation',
      'retry_local_execution',
      'decline_local_retry',
      'retry_execution',
      'acknowledge_possible_submission',
      'decline_packet_recovery',
    ])
  })

  it.each([
    ['none', 'approval_required', 'Needs project context'],
    ['proposed', 'approval_required', 'Needs project context'],
    ['not_issued', 'approval_required', 'Needs project context'],
    ['denied', 'denied_required', 'Context was denied'],
    ['approved', 'consumed_once', 'Approval already used'],
  ] as const)('renders the %s grant phase with distinct static copy', (grantPhase, holdKind, badgeText) => {
    const grantState = grantPhase === 'denied'
      ? {
          kind: 'operator_hold' as const,
          holdKind,
          grantPhase,
          grantConsumed: false as const,
          grantDecisionRevision: null,
          revocationReason: null,
        }
      : grantPhase === 'approved'
        ? {
            kind: 'operator_hold' as const,
            holdKind,
            grantPhase,
            grantConsumed: true as const,
            grantDecisionRevision: '7',
            revocationReason: null,
          }
        : {
            kind: 'operator_hold' as const,
            holdKind,
            grantPhase,
            grantConsumed: false as const,
            grantDecisionRevision: null,
            revocationReason: null,
          }
    const presentation = admissionPresentation(decision({
      mode: 'bounded_context_required',
      admissionStatus: 'blocked',
      recoveryAction: 'approve_project_filesystem_context',
      grantState,
      packageGrantTargetId: 'filesystem-grant-package-1',
    }))

    expect(presentation.badgeText).toBe(badgeText)
    expect(presentation.actions).toEqual([{
      kind: 'scroll',
      label: 'Review project context',
      targetId: 'filesystem-grant-package-1',
    }])
  })

  it.each([
    ['project_grant_removed', 'Context removed'],
    ['project_grant_narrowed', 'Context no longer covers package'],
    ['project_root_repoint', 'Project root changed'],
  ] as const)('maps revocation %s without rendering a reason or path', (revocationReason, badgeText) => {
    const presentation = admissionPresentation(decision({
      mode: 'bounded_context_required',
      admissionStatus: 'blocked',
      recoveryAction: 'approve_project_filesystem_context',
      grantState: {
        kind: 'operator_hold',
        holdKind: 'revoked_required',
        grantPhase: 'revoked',
        grantConsumed: false,
        grantDecisionRevision: '9',
        revocationReason,
      },
    }))
    expect(presentation.badgeText).toBe(badgeText)
    expect(JSON.stringify(presentation)).not.toContain('/Users/')
  })

  it('separates planning, approved, deferred, remediation, and revise-plan states', () => {
    const planning = admissionPresentation(decision({}))
    const approved = admissionPresentation(decision({
      mode: 'bounded_context_approved',
      admissionStatus: 'allowed',
      recoveryAction: undefined,
      grantState: {
        kind: 'effective_approved',
        grantPhase: 'approved',
        grantConsumed: false,
        grantDecisionRevision: '2',
        revocationReason: null,
      },
    }))
    const deferred = admissionPresentation(decision({
      mode: 'deferred_live_mcp',
      admissionStatus: 'warning',
      recoveryAction: 'defer_live_mcp_feature',
      requirement: 'optional',
    }))
    const remediation = admissionPresentation(decision({
      mode: 'blocked',
      admissionStatus: 'blocked',
      recoveryAction: 'install_or_fix_mcp',
      retryable: true,
    }))
    const revise = admissionPresentation(decision({
      mode: 'blocked',
      admissionStatus: 'blocked',
      recoveryAction: 'revise_plan',
    }))

    expect(planning.statusKey).toBe('planning')
    expect(approved).toMatchObject({ statusKey: 'approved', tone: 'positive', actions: [] })
    expect(deferred).toMatchObject({ statusKey: 'deferred', tone: 'neutral', actions: [] })
    expect(remediation.actions[0]).toMatchObject({ kind: 'link', label: 'Open project MCP tools' })
    expect(revise.actions).toEqual([{ kind: 'request_changes', label: 'Request plan changes' }])
  })

  it('fails malformed or incoherent tuples closed without echoing hostile input', () => {
    const hostile = '\u202e/Users/operator/.ssh/id_ed25519 SECRET=top-secret'
    const presentation = admissionPresentationFromUnknown({
      mode: 'bounded_context_approved',
      admissionStatus: 'allowed',
      requirement: 'required',
      retryable: true,
      recoveryAction: 'approve_project_filesystem_context',
      grantState: {
        kind: 'operator_hold',
        holdKind: 'revoked_required',
        grantPhase: 'revoked',
        grantConsumed: false,
        grantDecisionRevision: '1',
        revocationReason: hostile,
      },
      reason: hostile,
    }, { projectId })

    expect(presentation).toMatchObject({ badgeText: 'Status unavailable', actions: [] })
    expect(JSON.stringify(presentation)).not.toContain(hostile)
    expect(JSON.stringify(presentation)).not.toContain('id_ed25519')
  })
})

describe('project MCP operator copy', () => {
  it.each([
    [
      { installState: 'missing' as const, healthStatus: 'unknown' as const, enabled: true },
      'Not installed',
      'install_mcp',
    ],
    [
      { installState: 'installed' as const, healthStatus: 'disabled' as const, enabled: false },
      'Disabled',
      'enable_mcp',
    ],
    [
      { healthStatus: 'auth_required' as const },
      'Account required',
      'connect_account',
    ],
    [
      { healthStatus: 'configuration_required' as const },
      'Configuration required',
      'configure_project_mcp',
    ],
    [
      { healthStatus: 'unhealthy' as const },
      'Needs attention',
      'inspect_mcp_health',
    ],
    [
      { healthStatus: 'unknown' as const },
      'Status not checked',
      'refresh_mcp_health',
    ],
  ])('maps every actionable health state to its distinct handler', (overrides, badgeText, handler) => {
    const presentation = projectMcpPresentation(projectMcp(overrides))
    expect(presentation.badgeText).toBe(badgeText)
    expect(presentation.actions[0]).toMatchObject({ handler })
  })

  it('renders healthy setup positively but does not imply live handles', () => {
    const presentation = projectMcpPresentation(projectMcp({}))
    expect(presentation).toMatchObject({ badgeText: 'Ready', tone: 'positive', actions: [] })
    expect(presentation.body).toContain('no live tool handles')
  })

  it('allows refresh only for typed transient unknown, not future or incoherent state', () => {
    const future = projectMcpPresentationFromUnknown({
      projectId,
      mcpId: 'filesystem',
      installState: 'installed',
      healthStatus: 'new_future_state',
      enabled: true,
      runtime: MCP_CATALOG.filesystem.runtime,
    })
    const incoherent = projectMcpPresentation(projectMcp({ healthStatus: 'healthy', enabled: false }))

    expect(future).toMatchObject({ badgeText: 'Status unavailable', actions: [] })
    expect(incoherent).toMatchObject({ badgeText: 'Status unavailable', actions: [] })
  })
})

describe('MCP catalog operator copy', () => {
  it('distinguishes bounded context and external service without granting runtime authority', () => {
    const filesystem = catalogMcpPresentation(MCP_CATALOG.filesystem)
    const github = catalogMcpPresentation(MCP_CATALOG.github)

    expect(filesystem.badgeText).toBe('Bounded context')
    expect(github.badgeText).toBe('External service')
    expect(filesystem.body).toContain('no live tool handles')
    expect(github.body).toContain('no live tool handles')
  })

  it('fails a future runtime or live-tools claim closed', () => {
    const future = catalogMcpPresentationFromUnknown({
      id: 'github',
      runtime: { capabilities: [], mode: 'future_runtime', liveTools: false },
    })
    const live = catalogMcpPresentationFromUnknown({
      id: 'github',
      runtime: { capabilities: [], mode: 'external_service', liveTools: true },
    })

    expect(future).toMatchObject({ badgeText: 'Status unavailable', actions: [] })
    expect(live).toMatchObject({ badgeText: 'Status unavailable', actions: [] })
  })
})
