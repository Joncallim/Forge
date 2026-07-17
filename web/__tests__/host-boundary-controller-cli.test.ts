import { describe, expect, it } from 'vitest'
import controllerContract from '@/test-contracts/epic-172-host-boundary-controller-v2.json'
import {
  buildHostBoundaryControllerRequest,
  validateHostBoundaryControllerResponse,
} from '@/scripts/host-boundary-controller-cli.mjs'

describe('external host-boundary controller adapter', () => {
  it('is checked in disabled with no activation, ingress, issuance, or Check Run authority', () => {
    expect(controllerContract).toMatchObject({
      schemaVersion: 2,
      deploymentMode: 'disabled',
      requiredCheck: {
        name: 'forge/host-boundary-controller',
        conclusionOwner: 'external_github_app',
        runnerMayConclude: false,
        checkoutMayConclude: false,
      },
      authority: {
        activation: false,
        ingress: false,
        issuance: false,
        evidenceStore: 'step0_import_only',
      },
    })
  })

  it('offers only fixed external control-plane requests', () => {
    const sha = 'a'.repeat(40)
    const requests = [
      buildHostBoundaryControllerRequest('inspect', ['--run', 'run-1', '--sha', sha]),
      buildHostBoundaryControllerRequest('verify-ruleset', [
        '--repository', 'owner/repo',
        '--app-id', '12345',
        '--check', 'forge/host-boundary-controller',
      ]),
      buildHostBoundaryControllerRequest('retry', [
        '--run', 'run-1',
        '--sha', sha,
        '--actor', 'operator-1',
        '--expected-state', 'failed',
        '--apply',
      ]),
      buildHostBoundaryControllerRequest('rotate-key', [
        '--pending-key-ref', 'vault:key-2026-08',
        '--actor', 'operator-1',
      ]),
    ]
    expect(requests.map((request) => request.operation)).toEqual([
      'inspect_controller_run',
      'verify_exact_app_ruleset',
      'retry_failed_controller_check',
      'inspect_controller_key_rotation_plan',
    ])
    for (const request of requests) {
      expect(request).not.toHaveProperty('activate')
      expect(request).not.toHaveProperty('ingress')
      expect(request).not.toHaveProperty('issuance')
      expect(JSON.stringify(request)).not.toMatch(/private.?key|secret/i)
    }
  })

  it('rejects successful/pending retry and ambiguous key discard', () => {
    const base = ['--run', 'run-1', '--sha', 'a'.repeat(40), '--actor', 'operator-1']
    expect(() => buildHostBoundaryControllerRequest('retry', [
      ...base,
      '--expected-state', 'success',
      '--apply',
    ])).toThrow(/Retry binding/)
    expect(() => buildHostBoundaryControllerRequest('rotate-key', [
      '--rotation', 'rotation-1',
      '--discard',
      '--actor', 'operator-1',
    ])).toThrow(/options/)
  })

  it('requires retry responses to name a fresh operation bound to the failed source run', () => {
    const request = buildHostBoundaryControllerRequest('retry', [
      '--run', 'failed-run-1',
      '--sha', 'a'.repeat(40),
      '--actor', 'operator-1',
      '--expected-state', 'failed',
      '--apply',
    ])
    const response = {
      schemaVersion: 2,
      requestId: request.requestId,
      operation: request.operation,
      disposition: 'accepted',
      messageCode: 'retry_started',
      facts: {
        appId: null,
        keyGeneration: null,
        reviewedSha: request.reviewedSha,
        rotationId: null,
        rulesetFingerprint: null,
        runId: 'fresh-run-2',
        sourceRunId: request.runId,
        sourceState: request.expectedState,
        state: 'pending',
      },
    }
    expect(validateHostBoundaryControllerResponse(response, request)).toEqual(response)
    expect(() => validateHostBoundaryControllerResponse({
      ...response,
      facts: { ...response.facts, runId: request.runId },
    }, request)).toThrow(/fresh operation/)
    expect(() => validateHostBoundaryControllerResponse({
      ...response,
      facts: { ...response.facts, sourceState: 'timed_out' },
    }, request)).toThrow(/fresh operation/)
  })

  it('requires exact App and digest-shaped ruleset facts', () => {
    const request = buildHostBoundaryControllerRequest('verify-ruleset', [
      '--repository', 'owner/repo',
      '--app-id', '12345',
      '--check', 'forge/host-boundary-controller',
    ])
    const response = {
      schemaVersion: 2,
      requestId: request.requestId,
      operation: request.operation,
      disposition: 'accepted',
      messageCode: 'ruleset_verified',
      facts: {
        appId: request.appId,
        keyGeneration: null,
        reviewedSha: null,
        rotationId: null,
        rulesetFingerprint: `sha256:${'a'.repeat(64)}`,
        runId: null,
        sourceRunId: null,
        sourceState: null,
        state: 'succeeded',
      },
    }
    expect(validateHostBoundaryControllerResponse(response, request)).toEqual(response)
    expect(() => validateHostBoundaryControllerResponse({
      ...response,
      facts: { ...response.facts, rulesetFingerprint: 'opaque-fingerprint' },
    }, request)).toThrow(/facts are invalid/)
  })
})
