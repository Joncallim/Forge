import { describe, expect, it } from 'vitest'
import {
  EPIC_172_S6_EXECUTED_IDS_DIGEST,
  EPIC_172_S6_SUITE_MANIFEST_DIGEST,
  evaluateEpic172S6ControllerEvidence,
  parseEpic172S6ExternalEvidenceBundle,
  type Epic172S6ExternalEvidenceBundle,
} from '@/lib/mcps/epic-172-s6-controller-gate'

function bundle(): Epic172S6ExternalEvidenceBundle {
  const digest = (character: string) => `sha256:${character.repeat(64)}`
  return {
    schemaVersion: 2,
    phase: 'enabled_build_tests_green',
    controllerRunId: 'controller-run-1',
    jobId: 'job-1',
    reviewedSha: 'a'.repeat(40),
    githubAppId: '123456',
    exactBuilds: [
      'issue_178_s3@s3-build',
      'issue_179_s4@s4-build',
      'issue_180_s5@s5-build',
      'issue_181_s6@s6-build',
    ],
    epoch: 2,
    signerKeyId: '11111111-1111-4111-8111-111111111111',
    signerGeneration: 3,
    imageDigest: digest('b'),
    bootId: 'boot-1',
    databaseStartedAt: '2026-07-17T02:00:00.000Z',
    completedAt: '2026-07-17T02:10:59.000Z',
    leaseExpiresAt: '2026-07-17T02:11:20.000Z',
    outerExpiresAt: '2026-07-17T02:26:00.000Z',
    phaseDurations: {
      orchestrationSeconds: 60,
      preflightSeconds: 29,
      suitePhaseSeconds: 420,
      outputTeardownDestructionSeconds: 120,
      verificationRecordingSeconds: 30,
    },
    suitesExecutedConcurrently: true,
    suiteManifestDigest: EPIC_172_S6_SUITE_MANIFEST_DIGEST,
    executedIdsDigest: EPIC_172_S6_EXECUTED_IDS_DIGEST,
    outputScanDigest: digest('c'),
    outputScanPassed: true,
    preflightReceiptDigest: digest('d'),
    teardownReceiptDigest: digest('e'),
    teardownZeroResidue: true,
    destructionReceiptDigest: digest('f'),
    destructionVerified: true,
    releaseBindings: {
      predecessorReceiptDigest: digest('1'),
      linkedReceiptDigest: digest('2'),
      signerLifecycleDigest: digest('3'),
      writersIngressAndIssuanceDisabled: false,
    },
    suites: [
      { command: 'test:mcp:contract', durationSeconds: 60, firstAttempt: true, retryCount: 0, skippedCount: 0, status: 'passed' },
      { command: 'test:mcp:postgres', durationSeconds: 240, firstAttempt: true, retryCount: 0, skippedCount: 0, status: 'passed' },
      { command: 'test:mcp:issuance', durationSeconds: 300, firstAttempt: true, retryCount: 0, skippedCount: 0, status: 'passed' },
      { command: 'e2e:mcp-operator', durationSeconds: 240, firstAttempt: true, retryCount: 0, skippedCount: 0, status: 'passed' },
      { command: 'test:mcp:host-boundary', durationSeconds: 420, firstAttempt: true, retryCount: 0, skippedCount: 0, status: 'passed' },
    ],
  }
}

const verified = (value: Epic172S6ExternalEvidenceBundle) => () => ({ ok: true as const, value })
const evaluatedAt = new Date('2026-07-17T02:10:59.000Z')
const expected = (value: Epic172S6ExternalEvidenceBundle) => ({
  bootId: value.bootId,
  controllerRunId: value.controllerRunId,
  epoch: value.epoch,
  exactBuilds: value.exactBuilds,
  githubAppId: value.githubAppId,
  imageDigest: value.imageDigest,
  jobId: value.jobId,
  phase: value.phase,
  releaseBindings: value.releaseBindings,
  reviewedSha: value.reviewedSha,
  signerGeneration: value.signerGeneration,
  signerKeyId: value.signerKeyId,
})

describe('Epic 172 S6 external controller gate', () => {
  it('[scenarioId=epic-172.controller-failure-rollback] keeps live authority closed for every injected failure', () => {
    const mutations: Array<[string, (value: Epic172S6ExternalEvidenceBundle) => void]> = [
      ['manifest_mismatch', (value) => { (value as { suiteManifestDigest: string }).suiteManifestDigest = `sha256:${'0'.repeat(64)}` }],
      ['suite_incomplete', (value) => { (value as { suites: Epic172S6ExternalEvidenceBundle['suites'] }).suites = value.suites.slice(1) }],
      ['suite_failed', (value) => { (value.suites[0] as { status: 'failed' }).status = 'failed' }],
      ['suite_retried_or_skipped', (value) => { (value.suites[0] as { retryCount: number }).retryCount = 1 }],
      ['budget_exceeded', (value) => { (value.suites[0] as { durationSeconds: number }).durationSeconds = 61 }],
      ['suite_not_concurrent', (value) => { (value as { suitesExecutedConcurrently: boolean }).suitesExecutedConcurrently = false }],
      ['output_scan_failed', (value) => { (value as { outputScanPassed: boolean }).outputScanPassed = false }],
      ['teardown_failed', (value) => { (value as { teardownZeroResidue: boolean }).teardownZeroResidue = false }],
      ['destruction_missing', (value) => { (value as { destructionVerified: boolean }).destructionVerified = false }],
      ['lease_expired', (value) => { (value as { leaseExpiresAt: string }).leaseExpiresAt = value.completedAt }],
      ['outer_deadline_expired', (value) => {
        ;(value as { outerExpiresAt: string }).outerExpiresAt = value.completedAt
        ;(value as { leaseExpiresAt: string }).leaseExpiresAt = value.completedAt
      }],
    ]

    for (const [reason, mutate] of mutations) {
      const candidate = structuredClone(bundle())
      mutate(candidate)
      expect(evaluateEpic172S6ControllerEvidence(candidate, verified(candidate), expected(candidate), evaluatedAt)).toEqual({
        disposition: 'disabled',
        reason,
        liveAuthorityGranted: false,
      })
    }

    for (const [phase, limit] of [
      ['orchestrationSeconds', 60],
      ['preflightSeconds', 30],
      ['suitePhaseSeconds', 420],
      ['outputTeardownDestructionSeconds', 120],
      ['verificationRecordingSeconds', 30],
    ] as const) {
      const candidate = structuredClone(bundle())
      ;(candidate.phaseDurations as unknown as Record<string, number>)[phase] = limit + 1
      expect(evaluateEpic172S6ControllerEvidence(
        candidate,
        verified(candidate),
        expected(candidate),
        evaluatedAt,
      )).toMatchObject({ disposition: 'disabled', reason: 'budget_exceeded' })
    }
    expect(evaluateEpic172S6ControllerEvidence({}, () => ({ ok: false }), expected(bundle()), evaluatedAt)).toEqual({
      disposition: 'disabled',
      reason: 'signature_invalid',
      liveAuthorityGranted: false,
    })
    const value = bundle()
    expect(evaluateEpic172S6ControllerEvidence(
      value,
      () => { throw new Error('external verifier unavailable') },
      expected(value),
      evaluatedAt,
    )).toMatchObject({ disposition: 'disabled', reason: 'signature_invalid' })
    expect(evaluateEpic172S6ControllerEvidence(
      value,
      () => ({ ok: true, value: { ...value, suites: [null] } }),
      expected(value),
      evaluatedAt,
    )).toMatchObject({ disposition: 'disabled', reason: 'malformed_evidence' })
    expect(evaluateEpic172S6ControllerEvidence(
      value,
      verified(value),
      { ...expected(value), reviewedSha: 'f'.repeat(40) },
      evaluatedAt,
    )).toMatchObject({ disposition: 'disabled', reason: 'cross_bound_evidence' })
    expect(evaluateEpic172S6ControllerEvidence(
      value,
      verified(value),
      {
        ...expected(value),
        releaseBindings: {
          ...value.releaseBindings,
          predecessorReceiptDigest: `sha256:${'9'.repeat(64)}`,
        },
      },
      evaluatedAt,
    )).toMatchObject({ disposition: 'disabled', reason: 'cross_bound_evidence' })
    expect(evaluateEpic172S6ControllerEvidence(
      value,
      verified(value),
      expected(value),
      new Date(value.leaseExpiresAt),
    )).toMatchObject({ disposition: 'disabled', reason: 'lease_expired' })
  })

  it('packages a valid enabled-build result for Step 0 without granting authority', () => {
    const value = bundle()
    expect(evaluateEpic172S6ControllerEvidence(value, verified(value), expected(value), evaluatedAt)).toMatchObject({
      disposition: 'eligible_for_step0_recording',
      targetKind: 'enabled_build_tests_green',
      liveAuthorityGranted: false,
    })
  })

  it.each([
    ['pre_activation', null, null, true, 's6_pre_activation_green'],
    ['post_activation', 2, `sha256:${'2'.repeat(64)}`, true, 's6_post_activation_green'],
  ] as const)('binds %s evidence to its exact release phase', (phase, epoch, linkedReceiptDigest, disabledState, targetKind) => {
    const value = structuredClone(bundle())
    ;(value as { phase: Epic172S6ExternalEvidenceBundle['phase'] }).phase = phase
    ;(value as { epoch: number | null }).epoch = epoch
    ;(value as { exactBuilds: readonly string[] }).exactBuilds = value.exactBuilds.slice(1)
    ;(value.releaseBindings as { linkedReceiptDigest: string | null }).linkedReceiptDigest = linkedReceiptDigest
    ;(value.releaseBindings as { writersIngressAndIssuanceDisabled: boolean }).writersIngressAndIssuanceDisabled = disabledState
    expect(evaluateEpic172S6ControllerEvidence(
      value,
      verified(value),
      expected(value),
      evaluatedAt,
    )).toMatchObject({ disposition: 'eligible_for_step0_recording', targetKind })
  })

  it('fails closed for malformed signed values and exact-binding replay', () => {
    const value = bundle()
    const malformed = { ...value, suites: [null] }
    expect(evaluateEpic172S6ControllerEvidence(
      malformed,
      () => ({ ok: true, value: malformed }),
      expected(value),
      evaluatedAt,
    )).toMatchObject({ disposition: 'disabled', reason: 'malformed_evidence' })
    expect(() => parseEpic172S6ExternalEvidenceBundle({ ...value, unexpected: true })).toThrow(/shape/)
    expect(evaluateEpic172S6ControllerEvidence(
      value,
      verified(value),
      { ...expected(value), reviewedSha: 'f'.repeat(40) },
      evaluatedAt,
    )).toMatchObject({ disposition: 'disabled', reason: 'cross_bound_evidence' })
    const wrongPhaseState = structuredClone(value)
    ;(wrongPhaseState.releaseBindings as { writersIngressAndIssuanceDisabled: boolean }).writersIngressAndIssuanceDisabled = true
    expect(evaluateEpic172S6ControllerEvidence(
      wrongPhaseState,
      verified(wrongPhaseState),
      expected(wrongPhaseState),
      evaluatedAt,
    )).toMatchObject({ disposition: 'disabled', reason: 'cross_bound_evidence' })
  })

  it('rejects evidence evaluated after the controller lease even when completion was timely', () => {
    const value = bundle()
    expect(evaluateEpic172S6ControllerEvidence(
      value,
      verified(value),
      expected(value),
      new Date(value.leaseExpiresAt),
    )).toMatchObject({ disposition: 'disabled', reason: 'lease_expired' })
  })
})
