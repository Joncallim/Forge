import { describe, expect, it } from 'vitest'
import {
  EPIC_172_S6_EXECUTED_IDS_DIGEST,
  EPIC_172_S6_SUITE_MANIFEST_DIGEST,
  evaluateEpic172S6ControllerEvidence,
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
    imageDigest: digest('b'),
    bootId: 'boot-1',
    databaseStartedAt: '2026-07-17T02:00:00.000Z',
    completedAt: '2026-07-17T02:10:59.000Z',
    leaseExpiresAt: '2026-07-17T02:11:20.000Z',
    outerExpiresAt: '2026-07-17T02:26:00.000Z',
    suiteManifestDigest: EPIC_172_S6_SUITE_MANIFEST_DIGEST,
    executedIdsDigest: EPIC_172_S6_EXECUTED_IDS_DIGEST,
    outputScanDigest: digest('c'),
    outputScanPassed: true,
    preflightReceiptDigest: digest('d'),
    teardownReceiptDigest: digest('e'),
    teardownZeroResidue: true,
    destructionReceiptDigest: digest('f'),
    destructionVerified: true,
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

describe('Epic 172 S6 external controller gate', () => {
  it('[scenarioId=epic-172.controller-failure-rollback] keeps live authority closed for every injected failure', () => {
    const mutations: Array<[string, (value: Epic172S6ExternalEvidenceBundle) => void]> = [
      ['manifest_mismatch', (value) => { (value as { suiteManifestDigest: string }).suiteManifestDigest = `sha256:${'0'.repeat(64)}` }],
      ['suite_incomplete', (value) => { (value as { suites: Epic172S6ExternalEvidenceBundle['suites'] }).suites = value.suites.slice(1) }],
      ['suite_failed', (value) => { (value.suites[0] as { status: 'failed' }).status = 'failed' }],
      ['suite_retried_or_skipped', (value) => { (value.suites[0] as { retryCount: number }).retryCount = 1 }],
      ['budget_exceeded', (value) => { (value.suites[0] as { durationSeconds: number }).durationSeconds = 61 }],
      ['output_scan_failed', (value) => { (value as { outputScanPassed: boolean }).outputScanPassed = false }],
      ['teardown_failed', (value) => { (value as { teardownZeroResidue: boolean }).teardownZeroResidue = false }],
      ['destruction_missing', (value) => { (value as { destructionVerified: boolean }).destructionVerified = false }],
      ['lease_expired', (value) => { (value as { leaseExpiresAt: string }).leaseExpiresAt = value.completedAt }],
      ['outer_deadline_expired', (value) => { (value as { outerExpiresAt: string }).outerExpiresAt = value.completedAt }],
    ]

    for (const [reason, mutate] of mutations) {
      const candidate = structuredClone(bundle())
      mutate(candidate)
      expect(evaluateEpic172S6ControllerEvidence(candidate, verified(candidate))).toEqual({
        disposition: 'disabled',
        reason,
        liveAuthorityGranted: false,
      })
    }
    expect(evaluateEpic172S6ControllerEvidence({}, () => ({ ok: false }))).toEqual({
      disposition: 'disabled',
      reason: 'signature_invalid',
      liveAuthorityGranted: false,
    })
  })

  it('packages a valid enabled-build result for Step 0 without granting authority', () => {
    const value = bundle()
    expect(evaluateEpic172S6ControllerEvidence(value, verified(value))).toMatchObject({
      disposition: 'eligible_for_step0_recording',
      targetKind: 'enabled_build_tests_green',
      liveAuthorityGranted: false,
    })
  })
})
