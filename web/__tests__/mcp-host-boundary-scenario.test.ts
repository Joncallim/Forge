import { generateKeyPairSync, sign } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  HOST_BOUNDARY_ATTESTATION_DOMAIN_V2,
  hostBoundaryAttestationSigningBytes,
} from '@/scripts/lib/mcp-host-boundary-attestation.mjs'
import {
  HOST_BOUNDARY_SCENARIO_RESULT_DOMAIN_V2,
  createFixedHostBoundaryScenarioRequest,
  hostBoundaryPreflightEnvelopeDigest,
  hostBoundaryScenarioResultSigningBytes,
  verifyHostBoundaryScenarioResult,
} from '@/scripts/lib/mcp-host-boundary-scenario.mjs'

const { privateKey, publicKey } = generateKeyPairSync('ed25519')
const publicKeyPem = publicKey.export({ format: 'pem', type: 'spki' }).toString()

function signedPreflight() {
  const unsigned = {
    schemaVersion: 2,
    domain: HOST_BOUNDARY_ATTESTATION_DOMAIN_V2,
    payload: {
      bootId: 'boot-scenario',
      controllerRunId: 'controller-scenario',
      expiresAt: '2026-07-17T02:04:00.000Z',
      harnessDigest: `sha256:${'a'.repeat(64)}`,
      imageDigest: `sha256:${'b'.repeat(64)}`,
      issuedAt: '2026-07-17T02:00:00.000Z',
      jobId: 'job-scenario',
      nonce: '0123456789abcdefghijklmnop',
      observations: {
        cgroupVersion: 'v2',
        distro: 'ubuntu',
        distroVersion: '24.04',
        immutableRootHarness: true,
        initSystem: 'systemd',
        kernelRelease: '6.8.0-102-generic',
        noNewPrivileges: true,
        operatingSystem: 'linux',
        protectedFenceState: true,
        separateServiceUid: true,
        separateTestUid: true,
        separateWorkerUid: true,
        soPeerCred: true,
        zeroEgressCheckout: true,
      },
      reviewedSha: 'c'.repeat(40),
      tlsFixtureDigest: `sha256:${'d'.repeat(64)}`,
      workflowRunId: 'workflow-scenario',
    },
    signingKeyId: 'host-key-scenario',
    signature: Buffer.alloc(64).toString('base64'),
  }
  return {
    ...unsigned,
    signature: sign(null, hostBoundaryAttestationSigningBytes(unsigned), privateKey).toString('base64'),
  }
}

function signedScenario(preflight: ReturnType<typeof signedPreflight>, overrides: Record<string, unknown> = {}) {
  const unsigned = {
    schemaVersion: 2,
    domain: HOST_BOUNDARY_SCENARIO_RESULT_DOMAIN_V2,
    payload: {
      bootId: preflight.payload.bootId,
      controllerRunId: preflight.payload.controllerRunId,
      facts: {
        arbitraryCommandSurfaceAbsent: true,
        completeGroupEmpty: true,
        crossUidAccessDenied: true,
        failureRolledBack: true,
        peerCredentialsEnforced: true,
        protectedStateUnmodified: true,
        zeroResidue: true,
      },
      firstAttempt: true,
      jobId: preflight.payload.jobId,
      observedAt: '2026-07-17T02:01:00.000Z',
      passed: true,
      preflightEnvelopeDigest: hostBoundaryPreflightEnvelopeDigest(preflight),
      reviewedSha: preflight.payload.reviewedSha,
      scenarioId: 'epic-172.cgroup-descendant-containment',
      ...overrides,
    },
    signingKeyId: preflight.signingKeyId,
    signature: Buffer.alloc(64).toString('base64'),
  }
  return {
    ...unsigned,
    signature: sign(null, hostBoundaryScenarioResultSigningBytes(unsigned), privateKey).toString('base64'),
  }
}

describe('MCP host-boundary fixed scenario evidence', () => {
  it('accepts one signed first-attempt result bound to the verified preflight', () => {
    const preflight = signedPreflight()
    const scenarioId = 'epic-172.cgroup-descendant-containment'
    expect(createFixedHostBoundaryScenarioRequest({ preflightEnvelope: preflight, scenarioId })).toEqual({
      schemaVersion: 2,
      operation: 'run_fixed_mcp_host_boundary_scenario_v2',
      scenarioId,
      preflightEnvelopeDigest: hostBoundaryPreflightEnvelopeDigest(preflight),
    })
    expect(() => verifyHostBoundaryScenarioResult({
      preflightEnvelope: preflight,
      publicKeyPem,
      result: signedScenario(preflight),
      scenarioId,
    })).not.toThrow()
  })

  it.each([
    ['cross-job replay', { jobId: 'other-job' }, /jobId binding/],
    ['retry', { firstAttempt: false }, /cannot be retried/],
    ['failed scenario', { passed: false }, /scenario failed/],
    ['late result', { observedAt: '2026-07-17T02:04:00.000Z' }, /outside the preflight/],
  ])('rejects %s even when the harness signature is valid', (_label, overrides, message) => {
    const preflight = signedPreflight()
    expect(() => verifyHostBoundaryScenarioResult({
      preflightEnvelope: preflight,
      publicKeyPem,
      result: signedScenario(preflight, overrides),
      scenarioId: 'epic-172.cgroup-descendant-containment',
    })).toThrow(message)
  })

  it('rejects a false safety fact before release evidence packaging', () => {
    const preflight = signedPreflight()
    const facts = {
      ...signedScenario(preflight).payload.facts,
      completeGroupEmpty: false,
    }
    expect(() => verifyHostBoundaryScenarioResult({
      preflightEnvelope: preflight,
      publicKeyPem,
      result: signedScenario(preflight, { facts }),
      scenarioId: 'epic-172.cgroup-descendant-containment',
    })).toThrow(/all closed safety facts/)
  })
})
