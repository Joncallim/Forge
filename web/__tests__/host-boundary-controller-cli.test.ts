import { describe, expect, it } from 'vitest'
import controllerContract from '@/test-contracts/epic-172-host-boundary-controller-v2.json'
import { buildHostBoundaryControllerRequest } from '@/scripts/host-boundary-controller-cli.mjs'

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
})
