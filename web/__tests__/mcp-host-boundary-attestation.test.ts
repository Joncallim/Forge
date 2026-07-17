import { generateKeyPairSync, sign } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  HOST_BOUNDARY_ATTESTATION_DOMAIN_V2,
  createFixedHostBoundaryRequest,
  hostBoundaryAttestationSigningBytes,
  verifyHostBoundaryAttestation,
} from '@/scripts/lib/mcp-host-boundary-attestation.mjs'

const { privateKey, publicKey } = generateKeyPairSync('ed25519')
const publicKeyPem = publicKey.export({ format: 'pem', type: 'spki' }).toString()

function makeEnvelope(overrides: Record<string, unknown> = {}) {
  const payload = {
    bootId: 'boot-001',
    controllerRunId: 'controller-run-001',
    expiresAt: '2026-07-17T02:04:00.000Z',
    harnessDigest: `sha256:${'a'.repeat(64)}`,
    imageDigest: `sha256:${'b'.repeat(64)}`,
    issuedAt: '2026-07-17T02:00:00.000Z',
    jobId: 'job-001',
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
    workflowRunId: 'workflow-run-001',
    ...overrides,
  }
  const unsigned = {
    schemaVersion: 2,
    domain: HOST_BOUNDARY_ATTESTATION_DOMAIN_V2,
    payload,
    signingKeyId: 'host-harness-key-2026-07',
    signature: Buffer.alloc(64).toString('base64'),
  }
  return {
    ...unsigned,
    signature: sign(null, hostBoundaryAttestationSigningBytes(unsigned), privateKey).toString('base64'),
  }
}

function expectedFor(envelope: ReturnType<typeof makeEnvelope>) {
  return {
    bootId: envelope.payload.bootId,
    controllerRunId: envelope.payload.controllerRunId,
    harnessDigest: envelope.payload.harnessDigest,
    imageDigest: envelope.payload.imageDigest,
    jobId: envelope.payload.jobId,
    nonce: envelope.payload.nonce,
    reviewedSha: envelope.payload.reviewedSha,
    signingKeyId: envelope.signingKeyId,
    tlsFixtureDigest: envelope.payload.tlsFixtureDigest,
    workflowRunId: envelope.payload.workflowRunId,
  }
}

describe('MCP supported-host preflight attestation', () => {
  it('accepts a fresh, exact Ubuntu 24.04/Linux 6.8+ signed envelope', () => {
    const envelope = makeEnvelope()
    expect(verifyHostBoundaryAttestation({
      envelope,
      expected: expectedFor(envelope),
      localPlatform: 'linux',
      now: new Date('2026-07-17T02:01:00.000Z'),
      publicKeyPem,
    })).toEqual(envelope)
  })

  it.each([
    ['macOS is not release evidence', { localPlatform: 'darwin' as const }],
    ['Windows is not release evidence', { localPlatform: 'win32' as const }],
  ])('rejects unsupported local execution: %s', (_label, injected) => {
    const envelope = makeEnvelope()
    expect(() => verifyHostBoundaryAttestation({
      envelope,
      expected: expectedFor(envelope),
      now: new Date('2026-07-17T02:01:00.000Z'),
      publicKeyPem,
      ...injected,
    })).toThrow(/supported Linux runner/)
  })

  it.each([
    ['expired evidence', makeEnvelope(), new Date('2026-07-17T02:04:00.000Z'), /expired/],
    ['wrong SHA binding', makeEnvelope(), new Date('2026-07-17T02:01:00.000Z'), /reviewedSha/],
    ['unsupported kernel', makeEnvelope({ observations: {
      ...makeEnvelope().payload.observations,
      kernelRelease: '6.7.12',
    } }), new Date('2026-07-17T02:01:00.000Z'), /Ubuntu 24.04/],
  ])('fails closed for %s', (label, envelope, now, message) => {
    const expected = expectedFor(envelope)
    if (label === 'wrong SHA binding') expected.reviewedSha = 'e'.repeat(40)
    expect(() => verifyHostBoundaryAttestation({
      envelope,
      expected,
      localPlatform: 'linux',
      now,
      publicKeyPem,
    })).toThrow(message)
  })

  it('rejects a forged or mutated envelope', () => {
    const envelope = makeEnvelope()
    const forged = structuredClone(envelope)
    forged.payload.jobId = 'job-forged'
    expect(() => verifyHostBoundaryAttestation({
      envelope: forged,
      expected: expectedFor(forged),
      localPlatform: 'linux',
      now: new Date('2026-07-17T02:01:00.000Z'),
      publicKeyPem,
    })).toThrow(/signature/)
  })

  it('builds only the fixed harness operation', () => {
    const envelope = makeEnvelope()
    const challenge = { ...envelope.payload } as Record<string, unknown>
    delete challenge.observations
    const request = createFixedHostBoundaryRequest({ ...challenge, signingKeyId: envelope.signingKeyId })
    expect(request).toMatchObject({
      schemaVersion: 2,
      operation: 'attest_fixed_mcp_host_boundary_v2',
    })
    expect(JSON.stringify(request)).not.toContain('command')
  })
})
