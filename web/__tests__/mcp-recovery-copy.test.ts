import { describe, expect, it } from 'vitest'
import {
  localRunRecoveryPresentation,
  packetArtifactPresentation,
  packetCurrentStatePresentation,
  type LocalRunRecoveryPresentationInput,
  type PacketArtifactPresentationInput,
  type PacketCurrentStatePresentationInput,
} from '@/lib/mcps/admission-copy'
import { PACKET_REDACTION_CATEGORIES } from '@/lib/mcps/packet-issuance-v2'
import type { LocalEffectRecoveryMarkerV1 } from '@/lib/mcps/local-run-evidence-v2'
import type { PacketIssuanceRecoveryMarkerV2 } from '@/lib/mcps/packet-issuance-v2'

const ids = {
  alert: '11111111-1111-4111-8111-111111111111',
  run: '22222222-2222-4222-8222-222222222222',
  audit: '33333333-3333-4333-8333-333333333333',
  evidence: '44444444-4444-4444-8444-444444444444',
  invocation: '55555555-5555-4555-8555-555555555555',
}
const fingerprint = `sha256:${'a'.repeat(64)}`

function packetMarker(overrides: Partial<PacketIssuanceRecoveryMarkerV2> = {}): PacketIssuanceRecoveryMarkerV2 {
  return {
    schemaVersion: 2,
    kind: 'packet_issuance',
    priorAgentRunId: ids.run,
    priorRuntimeAuditId: ids.audit,
    recoveryFailure: { status: 'failed', failureCode: 'submission_uncertain' },
    deliveryState: 'submission_uncertain',
    grantMode: 'always_allow',
    disposition: 'review_submission',
    acknowledgedAt: null,
    acknowledgedByUserId: null,
    combinedRepositoryReviewFingerprint: fingerprint,
    markerFingerprint: fingerprint,
    policyFingerprint: fingerprint,
    coverageFingerprint: fingerprint,
    autoRetryable: false,
    ...overrides,
  } as PacketIssuanceRecoveryMarkerV2
}

function packetRecovery(
  overrides: Partial<Extract<PacketCurrentStatePresentationInput, { source: 'recovery_marker' }>> = {},
): Extract<PacketCurrentStatePresentationInput, { source: 'recovery_marker' }> {
  return {
    source: 'recovery_marker',
    marker: packetMarker(),
    projectArchived: false,
    taskStatus: 'approved',
    packageStatus: 'blocked',
    packageGrantTargetId: 'filesystem-grant-package-1',
    localChangeBarrier: {
      unresolvedCount: 0,
      fingerprint: null,
      version: 1,
      sourceSetFingerprint: fingerprint,
    },
    currentAuthorization: {
      state: 'same_decision',
      decisionRevision: '1',
      rootBindingRevision: '1',
    },
    executionLeaseActive: false,
    localEvidenceLeaseActive: false,
    issuanceLeaseActive: false,
    siblingBarrier: 'none',
    ...overrides,
  }
}

function localMarker(overrides: Partial<LocalEffectRecoveryMarkerV1> = {}): LocalEffectRecoveryMarkerV1 {
  return {
    schemaVersion: 1,
    kind: 'local_effect_recovery',
    source: 'local-run-evidence',
    priorAgentRunId: ids.run,
    localRunEvidenceId: ids.evidence,
    evidenceFingerprint: fingerprint,
    taskDisposition: 'operator_hold',
    autoRetryable: false,
    reason: 'local_execution_interrupted',
    disposition: 'retry_local_execution',
    reviewState: 'not_applicable',
    ...overrides,
  } as LocalEffectRecoveryMarkerV1
}

function localRecovery(
  overrides: Partial<Extract<LocalRunRecoveryPresentationInput, { source: 'local_effect_recovery' }>> = {},
): Extract<LocalRunRecoveryPresentationInput, { source: 'local_effect_recovery' }> {
  return {
    source: 'local_effect_recovery',
    marker: localMarker(),
    taskStatus: 'approved',
    packageStatus: 'blocked',
    localChangeBarrier: {
      unresolvedCount: 0,
      fingerprint: null,
      version: 1,
      sourceSetFingerprint: fingerprint,
    },
    ownershipBarrier: {
      executionLeaseActive: false,
      localEvidenceLeaseActive: false,
      packetIssuanceLeaseActive: false,
    },
    siblingBarrier: 'none',
    invocationState: 'definitive_not_started',
    hostApplyReview: { state: 'not_applicable' },
    repositoryReviews: {
      workingTree: { state: 'not_applicable', baselineFingerprint: null, changeResult: 'unchanged' },
      gitControl: { state: 'not_applicable', baselineFingerprint: null, changeResult: 'unchanged' },
      gitStorage: { state: 'not_applicable', baselineFingerprint: null, changeResult: 'unchanged' },
    },
    localRetryEligibility: {
      state: 'eligible',
      policyRevision: '1',
      policyFingerprint: fingerprint,
    },
    ...overrides,
  }
}

function packetArtifact(
  overrides: Partial<Extract<PacketArtifactPresentationInput, { source: 'validated_artifact' }>['projection']> = {},
): Extract<PacketArtifactPresentationInput, { source: 'validated_artifact' }> {
  const redactionSummary = Object.fromEntries(
    PACKET_REDACTION_CATEGORIES.map((category, index) => [category, index + 1]),
  )
  return {
    source: 'validated_artifact',
    agentRunId: ids.run,
    localRunEvidenceFingerprint: fingerprint,
    projection: {
      schemaVersion: 2,
      assembly: {
        state: 'assembled',
        rootRef: 'opaque-project-root',
        includedCount: 2,
        byteCount: 128,
        omittedCount: 1,
        redactionSummary,
      },
      delivery: { state: 'submitted', submittedAt: '2026-07-17T01:00:00.000Z' },
      terminal: { status: 'succeeded' },
      effect: { state: 'not_started' },
      hostApplyReview: { state: 'not_applicable' },
      repositoryReviews: {
        workingTree: { state: 'not_applicable', baselineFingerprint: null, changeResult: 'unchanged' },
        gitControl: { state: 'not_applicable', baselineFingerprint: null, changeResult: 'unchanged' },
        gitStorage: { state: 'not_applicable', baselineFingerprint: null, changeResult: 'unchanged' },
      },
      combinedRepositoryReviewFingerprint: fingerprint,
      ...overrides,
    },
  }
}

describe('packet artifact presentation', () => {
  it('renders all shared redaction categories as bounded facts without root or content', () => {
    const presentation = packetArtifactPresentation(packetArtifact())
    const rendered = JSON.stringify(presentation)

    expect(presentation.actions).toEqual([])
    expect(presentation.facts).toHaveLength(6 + PACKET_REDACTION_CATEGORIES.length)
    expect(rendered).not.toContain('opaque-project-root')
    expect(rendered).not.toContain('/Users/')
    expect(rendered).not.toContain('selectedNames')
  })

  it('fails a thirteenth redaction key closed without echoing it', () => {
    const input = packetArtifact()
    ;(input.projection.assembly as { redactionSummary: Record<string, number> }).redactionSummary.future_secret = 1
    const presentation = packetArtifactPresentation(input)

    expect(presentation).toMatchObject({ badgeText: 'Evidence unavailable', actions: [], facts: [] })
    expect(JSON.stringify(presentation)).not.toContain('future_secret')
  })

  it('keeps assembly-unconfirmed evidence actionless and count-free', () => {
    const presentation = packetArtifactPresentation(packetArtifact({
      assembly: {
        state: 'assembly_unconfirmed',
        failureStage: 'assembly',
        assemblyAttemptId: ids.alert,
      },
      delivery: { state: 'not_exposed' },
      terminal: { status: 'failed', failureCode: 'assembly_failed' },
    }))

    expect(presentation.headline).toBe('Packet assembly could not be confirmed')
    expect(presentation.actions).toEqual([])
    expect(presentation.facts).toEqual(expect.arrayContaining([
      { label: 'Assembly', value: 'Could not be confirmed' },
    ]))
    expect(presentation.facts.some((fact) => fact.label === 'Included files')).toBe(false)
  })
})

describe('packet current-state presentation', () => {
  it('orders submission acknowledgement before packet decline with the same v2 identity', () => {
    const presentation = packetCurrentStatePresentation(packetRecovery())
    expect(presentation.actions.map((action) => action.kind)).toEqual([
      'review_submission',
      'decline_packet_recovery',
    ])
    expect(presentation.actions[0]).toMatchObject({
      handler: 'acknowledge_possible_submission',
      request: { priorRuntimeAuditId: ids.audit, markerFingerprint: fingerprint },
    })
    expect(presentation.actions[1]).toMatchObject({
      request: { priorRuntimeAuditId: ids.audit, markerFingerprint: fingerprint },
    })
  })

  it.each([
    { siblingBarrier: 'active_execution' as const },
    { siblingBarrier: 'awaiting_review' as const },
    { executionLeaseActive: true },
    { localEvidenceLeaseActive: true },
    { issuanceLeaseActive: true },
    { taskStatus: 'running' as const },
  ])('suppresses both actions behind each server-owned barrier', (barrier) => {
    expect(packetCurrentStatePresentation(packetRecovery(barrier)).actions).toEqual([])
  })

  it('uses the reapproval target without displaying either root path', () => {
    const presentation = packetCurrentStatePresentation(packetRecovery({
      marker: packetMarker({
        grantMode: 'allow_once',
        disposition: 'reapprove_allow_once',
        deliveryState: 'submission_failed',
        recoveryFailure: { status: 'failed', failureCode: 'submission_rejected' },
      }),
      currentAuthorization: { state: 'not_covering', reason: 'root_changed' },
    }))

    expect(presentation.headline).toContain('Project root changed')
    expect(presentation.actions.map((action) => action.kind)).toEqual([
      'reapprove_packet_context',
      'decline_packet_recovery',
    ])
    expect(JSON.stringify(presentation)).not.toContain('/Users/')
  })
})

describe('packet-independent local recovery presentation', () => {
  it('offers direct retry then decline only for trusted not-started evidence', () => {
    const presentation = localRunRecoveryPresentation(localRecovery())
    expect(presentation.actions.map((action) => action.kind)).toEqual([
      'retry_local_execution',
      'decline_local_retry',
    ])

    expect(localRunRecoveryPresentation(localRecovery({ invocationState: 'uncertain' })).actions).toEqual([])
  })

  it('shows one local review action across working tree, Git control, and Git storage', () => {
    const marker = localMarker({
      reason: 'repository_change_requires_review',
      disposition: 'review_local_changes',
      reviewState: 'review_required',
      nextDisposition: 'retry_local_execution',
    })
    const changed = {
      state: 'review_required' as const,
      baselineFingerprint: fingerprint,
      changeResult: 'changed' as const,
      changeFingerprint: fingerprint,
      reviewedAt: null,
      reviewedByUserId: null,
    }
    const presentation = localRunRecoveryPresentation(localRecovery({
      marker,
      localChangeBarrier: {
        unresolvedCount: 3,
        fingerprint,
        version: 1,
        sourceSetFingerprint: fingerprint,
      },
      repositoryReviews: { workingTree: changed, gitControl: changed, gitStorage: changed },
    }))

    expect(presentation.body).toContain('working-tree files')
    expect(presentation.body).toContain('Git control')
    expect(presentation.body).toContain('Git object')
    expect(presentation.actions.map((action) => action.kind)).toEqual(['review_local_changes'])
  })

  it('keeps total recovery-worker loss actionless with the exact runbook command', () => {
    const presentation = localRunRecoveryPresentation({
      source: 'quiescence_wait',
      reason: 'authorized_recovery_worker_unavailable',
      alertId: ids.alert,
      membershipChangeId: null,
      evidenceFingerprint: fingerprint,
      taskStatus: 'running',
      packageStatus: 'running',
    })

    expect(presentation.headline).toBe('Recovery worker unavailable — Release/DevOps action required')
    expect(presentation.body).toContain('npm run protocol:replace-work-package-instance -- --candidate <new-instance-id> --replaces <old-instance-id> --actor <operator-id>')
    expect(presentation.body).toContain('docs/operators/work-package-instance-replacement-v2.md')
    expect(presentation.actions).toEqual([])
  })

  it.each([
    ['missing_local_evidence', 'quarantine_only', 'Required local run evidence is missing'],
    ['local_evidence_mismatch', 'reconstructable', 'can be reconstructed'],
    ['local_evidence_mismatch', 'irreconcilable', 'cannot be reconstructed'],
    ['task_projection_mismatch', 'reconstructable', 'can be recomputed'],
    ['quiescence_state_incoherent', 'awaiting_service_proof', 'service-authored quiescence proof'],
  ] as const)('keeps integrity reason %s/%s distinct and actionless', (reason, outcome, expected) => {
    const hold = reason === 'missing_local_evidence'
      ? {
          schemaVersion: 1 as const,
          kind: 'local_effect_integrity_hold' as const,
          source: 'local-run-evidence' as const,
          priorAgentRunId: ids.run,
          alertId: ids.alert,
          evidenceFingerprint: fingerprint,
          taskDisposition: 'operator_hold' as const,
          autoRetryable: false as const,
          reason,
          localRunEvidenceId: null,
          expectedLocalRunEvidenceId: ids.evidence,
          packetAuditId: null,
          projectId: ids.alert,
          taskId: ids.audit,
          packageId: ids.evidence,
          claimIdentityFingerprint: fingerprint,
        }
      : {
          schemaVersion: 1 as const,
          kind: 'local_effect_integrity_hold' as const,
          source: 'local-run-evidence' as const,
          priorAgentRunId: ids.run,
          alertId: ids.alert,
          evidenceFingerprint: fingerprint,
          taskDisposition: 'operator_hold' as const,
          autoRetryable: false as const,
          reason,
          localRunEvidenceId: ids.evidence,
          expectedLocalRunEvidenceId: null,
          packetAuditId: null,
        }
    const presentation = localRunRecoveryPresentation({
      source: 'local_effect_integrity_hold',
      hold,
      repairClassification: { reason, outcome } as never,
      taskStatus: 'failed',
      packageStatus: 'blocked',
    })

    expect(`${presentation.headline} ${presentation.body}`).toContain(expected)
    expect(presentation.actions).toEqual([])
  })
})
