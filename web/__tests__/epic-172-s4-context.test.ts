import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { McpWorkPackageAdmission } from '@/lib/mcps/admission'
import {
  ARCHITECT_PLAN_HEADER,
  architectPlanEntryReference,
  materializeArchitectPlanEntries,
  parseArchitectPlanEntryReference,
  verifyArchitectPlanEntry,
} from '@/lib/mcps/architect-plan-entries'
import { serializeExecutableMcpPrompt } from '@/lib/mcps/bounded-executable-prompt'
import { projectExecutableMcpInstructions } from '@/lib/mcps/executable-instruction-projection'
import {
  packetCandidateGuard,
  packetTerminalTupleIsValid,
  parsePacketAuthorizationSnapshot,
  parsePacketRedactionSummary,
  parseTerminalPacketAssembly,
  type PacketAuthorizationSnapshot,
} from '@/lib/mcps/packet-issuance-v2'
import {
  localEffectCandidateGuard,
  parseLocalEffectRecoveryMarker,
  parseRepositoryChangeReview,
} from '@/lib/mcps/local-run-evidence-v2'
import {
  LOCAL_EFFECT_RECOVERY_ACTIONS,
  MCP_ADMISSION_OPERATOR_RECOVERY_SUITE_ID,
  PACKET_ISSUANCE_RECOVERY_ACTIONS,
} from '@/lib/mcps/recovery-actions-v2'

const TASK_ID = '00000000-0000-4000-8000-000000000001'
const ARTIFACT_ID = '00000000-0000-4000-8000-000000000002'
const USER_ID = '00000000-0000-4000-8000-000000000003'
const RUN_ID = '00000000-0000-4000-8000-000000000004'
const AUDIT_ID = '00000000-0000-4000-8000-000000000005'
const APPROVAL_ID = '00000000-0000-4000-8000-000000000006'
const NONCE = '00000000-0000-4000-8000-000000000007'
const SHA = `sha256:${'a'.repeat(64)}`

function decision(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    mcpId: 'filesystem',
    agent: 'backend',
    requirement: 'required',
    requestedCapabilities: ['filesystem.project.read'],
    normalizedCapabilities: ['filesystem.project.read'],
    capabilityClasses: [{
      capability: 'filesystem.project.read',
      class: 'bounded_read_only',
      deliveryKind: 'bounded_context_packet',
    }],
    mode: 'bounded_context_approved',
    status: 'allowed',
    reason: 'allowed',
    evidenceRefs: [],
    ...overrides,
  }
}

function admission(overrides: Partial<McpWorkPackageAdmission> = {}): McpWorkPackageAdmission {
  return {
    schemaVersion: 2,
    evaluations: [{
      decision: decision(),
      source: {
        requirementKey: 'filesystem-context',
        decisionId: 'decision-1',
        sourceRequirementIndex: 0,
        assignment: { type: 'role', targetId: 'backend' },
        fallback: { action: 'block', message: '' },
        promptOverlayPresent: true,
      },
      health: {
        mcpId: 'filesystem', enabled: true, installState: 'installed',
        status: 'healthy', error: null, observedAt: null,
      },
    }],
    subtaskDecisions: [{
      subtaskId: 'subtask-1', agent: 'backend', requirementKey: 'filesystem-context',
      mcpId: 'filesystem', capability: 'filesystem.project.read',
      class: 'bounded_read_only', deliveryKind: 'bounded_context_packet',
      status: 'allowed', reason: 'allowed',
    }],
    referencedHealth: [],
    aggregate: { status: 'allowed', blocked: [], warnings: [], blockedReason: null, retryable: false },
    ...overrides,
  } as McpWorkPackageAdmission
}

describe('Epic 172 S4 protected Architect plan history', () => {
  it('materializes deterministic NFC HMAC envelopes and text-free executable references', () => {
    const key = randomBytes(32)
    const first = materializeArchitectPlanEntries({
      digestKey: key,
      digestKeyId: 'plan-key-1',
      taskId: TASK_ID,
      planArtifactId: ARTIFACT_ID,
      planVersion: '1',
      entries: [{
        entryId: 'requirement:filesystem-context',
        entryKind: 'requirement',
        agent: 'backend',
        requirementKey: 'filesystem-context',
        bindingFingerprint: SHA,
        content: 'Use Cafe\u0301 read context.',
        projectionEligible: true,
      }],
    })
    const second = materializeArchitectPlanEntries({
      digestKey: key,
      digestKeyId: 'plan-key-1',
      taskId: TASK_ID,
      planArtifactId: ARTIFACT_ID,
      planVersion: '1',
      entries: [{
        entryId: 'requirement:filesystem-context',
        entryKind: 'requirement',
        agent: 'backend',
        requirementKey: 'filesystem-context',
        bindingFingerprint: SHA,
        content: 'Use Caf\u00e9 read context.',
        projectionEligible: true,
      }],
    })
    expect(first).toEqual(second)
    expect(verifyArchitectPlanEntry({ digestKey: key, entry: first.entries[0] })).toBe(true)
    expect(verifyArchitectPlanEntry({ digestKey: randomBytes(32), entry: first.entries[0] })).toBe(false)

    const reference = architectPlanEntryReference(first.entries[0])
    expect(JSON.stringify(reference)).not.toContain('Caf')
    expect(parseArchitectPlanEntryReference(reference)).toEqual(reference)
    expect(parseArchitectPlanEntryReference({ ...reference, content: 'leak' })).toBeNull()
    expect(ARCHITECT_PLAN_HEADER).not.toContain('Use Caf')
  })

  it('retains ambiguous legacy text but never makes it projection eligible', () => {
    expect(() => materializeArchitectPlanEntries({
      digestKey: randomBytes(32), digestKeyId: 'plan-key-1', taskId: TASK_ID,
      planArtifactId: ARTIFACT_ID, planVersion: '1',
      entries: [{
        entryId: 'legacy_full_plan:000001', entryKind: 'legacy_full_plan',
        agent: null, requirementKey: null, bindingFingerprint: null,
        content: 'Retained legacy plan', projectionEligible: true,
      }],
    })).toThrow(/never executable/)
  })
})

describe('Epic 172 S4 executable projection and serialization', () => {
  it('includes only wholly admitted task-bound fragments in structured JSON', () => {
    const projection = projectExecutableMcpInstructions({
      admission: admission(),
      requirementSources: new Map([['filesystem-context', {
        key: 'filesystem-context', agent: 'backend', content: 'Read only the bounded project packet.',
      }]]),
      subtaskSources: new Map([['subtask-1', {
        key: 'subtask-1', agent: 'backend', content: 'Inspect the bounded inputs.',
      }]]),
    })
    expect(projection.requirementInstructions).toHaveLength(1)
    expect(projection.subtasks).toHaveLength(1)
    const serialized = serializeExecutableMcpPrompt({ digestKey: randomBytes(32), projection })
    expect(serialized.byteCount).toBe(Buffer.byteLength(serialized.json))
    expect(serialized.digest).toMatch(/^hmac-sha256:[0-9a-f]{64}$/)
    expect(JSON.parse(serialized.json).forgePolicy).toContain('Forge issued no live MCP handle.')
  })

  it('never echoes a rejected source and omits a subtask unless every binding is eligible', () => {
    const blocked = admission()
    blocked.evaluations[0].decision = decision({ status: 'blocked', mode: 'blocked' }) as never
    blocked.subtaskDecisions[0].status = 'blocked'
    const secret = 'DO-NOT-ECHO-REJECTED-CONTENT'
    const projection = projectExecutableMcpInstructions({
      admission: blocked,
      requirementSources: new Map([['filesystem-context', { key: 'filesystem-context', agent: 'backend', content: secret }]]),
      subtaskSources: new Map([['subtask-1', { key: 'subtask-1', agent: 'backend', content: secret }]]),
    })
    expect(projection.requirementInstructions).toEqual([])
    expect(projection.subtasks).toEqual([])
    expect(JSON.stringify(projection)).not.toContain(secret)
    expect(projection.staticBoundaryWarnings).toHaveLength(1)
  })
})

describe('Epic 172 S4 packet evidence', () => {
  const packageAuthorization: PacketAuthorizationSnapshot = {
    schemaVersion: 2,
    source: 'package_allow_once', grantMode: 'allow_once',
    grantApprovalId: APPROVAL_ID, grantDecisionNonce: NONCE,
    grantDecisionRevision: '12', rootBindingRevision: '5',
    approvedCapabilities: ['filesystem.project.list', 'filesystem.project.read'],
    requiredCapabilities: ['filesystem.project.read'],
    decidedByUserId: USER_ID, decidedAt: '2026-07-17T00:00:00.000Z', coverageFingerprint: SHA,
  }

  it('accepts only the two exact authorization arms and rejects mirror-like cross products', () => {
    expect(parsePacketAuthorizationSnapshot(packageAuthorization)).toEqual(packageAuthorization)
    expect(parsePacketAuthorizationSnapshot({
      ...packageAuthorization,
      source: 'project_always_allow', grantMode: 'always_allow',
    })).toBeNull()
    expect(parsePacketAuthorizationSnapshot({ ...packageAuthorization, extra: true })).toBeNull()
    expect(parsePacketAuthorizationSnapshot({
      ...packageAuthorization,
      approvedCapabilities: ['filesystem.project.read', 'filesystem.project.list'],
    })).toBeNull()
  })

  it('bounds assembly metadata and rejects arbitrary redaction keys', () => {
    expect(parsePacketRedactionSummary({ jwt: 1, database_urls: 2 })).toEqual({ jwt: 1, database_urls: 2 })
    expect(parsePacketRedactionSummary({ 'selected/path': 1 })).toBeNull()
    expect(parseTerminalPacketAssembly({
      state: 'assembled', rootRef: 'opaque_root_1', includedCount: 50,
      byteCount: 160 * 1024, omittedCount: 0, redactionSummary: { jwt: 1 },
    })).not.toBeNull()
    expect(parseTerminalPacketAssembly({
      state: 'assembly_unconfirmed', failureStage: 'assembly', assemblyAttemptId: RUN_ID,
      rootRef: '/repo/private',
    })).toBeNull()
  })

  it('enforces terminal assembly and delivery compatibility', () => {
    expect(packetTerminalTupleIsValid({
      assembly: { state: 'assembled', rootRef: 'opaque', includedCount: 1, byteCount: 10, omittedCount: 0, redactionSummary: {} },
      delivery: { state: 'submitted', submittedAt: '2026-07-17T00:00:00.000Z' },
      terminal: { status: 'succeeded' },
    })).toBe(true)
    expect(packetTerminalTupleIsValid({
      assembly: { state: 'assembly_unconfirmed', failureStage: 'assembly', assemblyAttemptId: RUN_ID },
      delivery: { state: 'submission_uncertain' },
      terminal: { status: 'failed', failureCode: 'submission_uncertain' },
    })).toBe(false)
  })

  it('treats malformed known recovery markers as an absolute candidate hold', () => {
    expect(packetCandidateGuard({})).toEqual({ blocked: false })
    expect(packetCandidateGuard({ packet_issuance: { schemaVersion: 2, secret: 'must-not-pass' } }))
      .toEqual({ blocked: true, kind: 'invalid_packet_marker' })
    expect(packetCandidateGuard({ packet_integrity_hold: {
      schemaVersion: 2, kind: 'packet_integrity_hold', priorAgentRunId: RUN_ID,
      priorRuntimeAuditId: AUDIT_ID, reason: 'audit_artifact_mismatch', autoRetryable: false,
      markerFingerprint: SHA,
    } })).toEqual({ blocked: true, kind: 'packet_integrity_hold' })
  })
})

describe('Epic 172 S4 generic local recovery evidence', () => {
  it('keeps the seven operator actions and stable suite identity closed', () => {
    expect([...LOCAL_EFFECT_RECOVERY_ACTIONS, ...PACKET_ISSUANCE_RECOVERY_ACTIONS]).toEqual([
      'review_local_changes', 'acknowledge_possible_local_invocation',
      'retry_local_execution', 'decline_local_retry',
      'acknowledge_possible_submission', 'retry_execution', 'decline_packet_recovery',
    ])
    expect(MCP_ADMISSION_OPERATOR_RECOVERY_SUITE_ID).toBe('mcp-admission.operator-recovery')
  })

  it('rejects free-form local recovery fields and blocks malformed known markers', () => {
    const marker = {
      schemaVersion: 1,
      kind: 'local_effect_recovery',
      source: 'local-run-evidence',
      priorAgentRunId: RUN_ID,
      localRunEvidenceId: AUDIT_ID,
      evidenceFingerprint: SHA,
      taskDisposition: 'operator_hold',
      autoRetryable: false,
      reason: 'local_execution_interrupted',
      disposition: 'retry_local_execution',
      reviewState: 'not_applicable',
    }
    expect(parseLocalEffectRecoveryMarker(marker)).toEqual(marker)
    expect(parseLocalEffectRecoveryMarker({ ...marker, path: '/private/repo' })).toBeNull()
    expect(localEffectCandidateGuard({ local_effect_recovery: { schemaVersion: 1 } }))
      .toEqual({ blocked: true, kind: 'invalid_local_effect_marker' })
  })

  it('requires exact repository-review fingerprints and actor/time pairs', () => {
    expect(parseRepositoryChangeReview({
      state: 'review_required', baselineFingerprint: SHA, changeResult: 'changed',
      changeFingerprint: SHA, reviewedAt: null, reviewedByUserId: null,
    })).not.toBeNull()
    expect(parseRepositoryChangeReview({
      state: 'reviewed', baselineFingerprint: SHA, changeResult: 'changed',
      changeFingerprint: SHA, reviewedAt: null, reviewedByUserId: USER_ID,
    })).toBeNull()
  })
})
