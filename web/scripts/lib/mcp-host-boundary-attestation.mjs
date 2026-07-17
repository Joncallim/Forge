import { createPublicKey, verify } from 'node:crypto'

export const HOST_BOUNDARY_ATTESTATION_DOMAIN_V2 = 'forge:mcp-host-boundary-attestation:v2\0'
export const HOST_BOUNDARY_PREFLIGHT_OPERATION_V2 = 'attest_fixed_mcp_host_boundary_v2'
export const HOST_BOUNDARY_MAX_ENVELOPE_BYTES = 64 * 1024

const DIGEST = /^sha256:[a-f0-9]{64}$/
const HEX_SHA = /^[a-f0-9]{40}$|^[a-f0-9]{64}$/
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const NONCE = /^[A-Za-z0-9_-]{22,128}$/

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function exactKeys(value, expected, label) {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} must contain only: ${wanted.join(', ')}.`)
  }
}

function requireString(value, pattern, label) {
  if (typeof value !== 'string' || !pattern.test(value)) throw new Error(`${label} is invalid.`)
  return value
}

function requireIsoTime(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    throw new Error(`${label} must be an exact UTC timestamp.`)
  }
  const milliseconds = Date.parse(value)
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new Error(`${label} is invalid.`)
  }
  return value
}

export function canonicalizeHostBoundaryJson(value) {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'string') return JSON.stringify(value.normalize('NFC'))
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error('Signed host evidence contains a non-integer number.')
    return String(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalizeHostBoundaryJson).join(',')}]`
  if (!isRecord(value)) throw new Error('Signed host evidence contains an unsupported value.')
  const normalizedKeys = Object.keys(value).map((key) => ({ original: key, normalized: key.normalize('NFC') }))
  if (new Set(normalizedKeys.map(({ normalized }) => normalized)).size !== normalizedKeys.length) {
    throw new Error('Signed host evidence contains duplicate keys after Unicode normalization.')
  }
  const entries = normalizedKeys
    .sort((left, right) => left.normalized < right.normalized ? -1 : left.normalized > right.normalized ? 1 : 0)
    .map(({ original, normalized }) => `${JSON.stringify(normalized)}:${canonicalizeHostBoundaryJson(value[original])}`)
  return `{${entries.join(',')}}`
}

function parsePayload(value) {
  if (!isRecord(value)) throw new Error('Host-boundary payload must be an object.')
  exactKeys(value, [
    'bootId',
    'controllerRunId',
    'expiresAt',
    'harnessDigest',
    'imageDigest',
    'issuedAt',
    'jobId',
    'nonce',
    'observations',
    'reviewedSha',
    'tlsFixtureDigest',
    'workflowRunId',
  ], 'host-boundary payload')

  if (!isRecord(value.observations)) throw new Error('Host observations must be an object.')
  exactKeys(value.observations, [
    'cgroupVersion',
    'distro',
    'distroVersion',
    'immutableRootHarness',
    'initSystem',
    'kernelRelease',
    'noNewPrivileges',
    'operatingSystem',
    'protectedFenceState',
    'separateServiceUid',
    'separateTestUid',
    'separateWorkerUid',
    'soPeerCred',
    'zeroEgressCheckout',
  ], 'host observations')

  const issuedAt = requireIsoTime(value.issuedAt, 'issuedAt')
  const expiresAt = requireIsoTime(value.expiresAt, 'expiresAt')
  const issuedMilliseconds = Date.parse(issuedAt)
  const expiresMilliseconds = Date.parse(expiresAt)
  if (expiresMilliseconds <= issuedMilliseconds || expiresMilliseconds - issuedMilliseconds > 5 * 60_000) {
    throw new Error('Host-boundary evidence lifetime must be positive and at most five minutes.')
  }

  return Object.freeze({
    bootId: requireString(value.bootId, OPAQUE_ID, 'bootId'),
    controllerRunId: requireString(value.controllerRunId, OPAQUE_ID, 'controllerRunId'),
    expiresAt,
    harnessDigest: requireString(value.harnessDigest, DIGEST, 'harnessDigest'),
    imageDigest: requireString(value.imageDigest, DIGEST, 'imageDigest'),
    issuedAt,
    jobId: requireString(value.jobId, OPAQUE_ID, 'jobId'),
    nonce: requireString(value.nonce, NONCE, 'nonce'),
    observations: Object.freeze({
      cgroupVersion: value.observations.cgroupVersion,
      distro: value.observations.distro,
      distroVersion: value.observations.distroVersion,
      immutableRootHarness: value.observations.immutableRootHarness,
      initSystem: value.observations.initSystem,
      kernelRelease: value.observations.kernelRelease,
      noNewPrivileges: value.observations.noNewPrivileges,
      operatingSystem: value.observations.operatingSystem,
      protectedFenceState: value.observations.protectedFenceState,
      separateServiceUid: value.observations.separateServiceUid,
      separateTestUid: value.observations.separateTestUid,
      separateWorkerUid: value.observations.separateWorkerUid,
      soPeerCred: value.observations.soPeerCred,
      zeroEgressCheckout: value.observations.zeroEgressCheckout,
    }),
    reviewedSha: requireString(value.reviewedSha, HEX_SHA, 'reviewedSha'),
    tlsFixtureDigest: requireString(value.tlsFixtureDigest, DIGEST, 'tlsFixtureDigest'),
    workflowRunId: requireString(value.workflowRunId, OPAQUE_ID, 'workflowRunId'),
  })
}

export function parseHostBoundaryAttestationEnvelope(value) {
  if (!isRecord(value)) throw new Error('Host-boundary attestation must be an object.')
  exactKeys(value, ['domain', 'payload', 'schemaVersion', 'signature', 'signingKeyId'], 'attestation envelope')
  if (value.schemaVersion !== 2) throw new Error('Host-boundary attestation schemaVersion must be 2.')
  if (value.domain !== HOST_BOUNDARY_ATTESTATION_DOMAIN_V2) throw new Error('Wrong host attestation signature domain.')
  const signature = requireString(value.signature, /^[A-Za-z0-9+/]{86}==$/, 'signature')
  const signatureBytes = Buffer.from(signature, 'base64')
  if (signatureBytes.length !== 64 || signatureBytes.toString('base64') !== signature) {
    throw new Error('Host attestation signature must be canonical 64-byte Base64.')
  }
  return Object.freeze({
    schemaVersion: 2,
    domain: HOST_BOUNDARY_ATTESTATION_DOMAIN_V2,
    payload: parsePayload(value.payload),
    signingKeyId: requireString(value.signingKeyId, OPAQUE_ID, 'signingKeyId'),
    signature,
  })
}

export function hostBoundaryAttestationSigningBytes(envelope) {
  const parsed = parseHostBoundaryAttestationEnvelope(envelope)
  return Buffer.concat([
    Buffer.from(HOST_BOUNDARY_ATTESTATION_DOMAIN_V2, 'utf8'),
    Buffer.from(canonicalizeHostBoundaryJson(parsed.payload), 'utf8'),
  ])
}

function assertSupportedObservations(observations) {
  const kernelMajorMinor = typeof observations.kernelRelease === 'string'
    ? observations.kernelRelease.match(/^(\d+)\.(\d+)/)
    : null
  const supportedKernel = kernelMajorMinor
    ? Number(kernelMajorMinor[1]) > 6
      || (Number(kernelMajorMinor[1]) === 6 && Number(kernelMajorMinor[2]) >= 8)
    : false
  const exactSupportedFacts = observations.operatingSystem === 'linux'
    && observations.distro === 'ubuntu'
    && observations.distroVersion === '24.04'
    && supportedKernel
    && observations.cgroupVersion === 'v2'
    && observations.initSystem === 'systemd'
    && observations.separateWorkerUid === true
    && observations.separateServiceUid === true
    && observations.separateTestUid === true
    && observations.soPeerCred === true
    && observations.protectedFenceState === true
    && observations.immutableRootHarness === true
    && observations.noNewPrivileges === true
    && observations.zeroEgressCheckout === true
  if (!exactSupportedFacts) {
    throw new Error('This attestation does not prove the supported Ubuntu 24.04 host boundary.')
  }
}

export function verifyHostBoundaryAttestation(input) {
  const envelope = parseHostBoundaryAttestationEnvelope(input.envelope)
  const expected = input.expected
  if (!isRecord(expected)) throw new Error('Expected host-boundary bindings are required.')
  exactKeys(expected, [
    'bootId',
    'controllerRunId',
    'harnessDigest',
    'imageDigest',
    'jobId',
    'nonce',
    'reviewedSha',
    'signingKeyId',
    'tlsFixtureDigest',
    'workflowRunId',
  ], 'expected host-boundary bindings')

  if ((input.localPlatform ?? process.platform) !== 'linux') {
    throw new Error('Trusted host-boundary evidence can only be evaluated inside the supported Linux runner.')
  }
  const now = input.now instanceof Date ? input.now : new Date()
  if (!Number.isFinite(now.getTime())) throw new Error('A valid verification time is required.')
  if (now.getTime() < Date.parse(envelope.payload.issuedAt) - 5_000) {
    throw new Error('Host-boundary evidence is not valid yet.')
  }
  if (now.getTime() >= Date.parse(envelope.payload.expiresAt)) {
    throw new Error('Host-boundary evidence has expired.')
  }

  for (const key of [
    'bootId',
    'controllerRunId',
    'harnessDigest',
    'imageDigest',
    'jobId',
    'nonce',
    'reviewedSha',
    'tlsFixtureDigest',
    'workflowRunId',
  ]) {
    if (envelope.payload[key] !== expected[key]) throw new Error(`Host-boundary ${key} binding does not match.`)
  }
  if (envelope.signingKeyId !== expected.signingKeyId) {
    throw new Error('Host-boundary signingKeyId binding does not match.')
  }

  assertSupportedObservations(envelope.payload.observations)
  const publicKey = createPublicKey(input.publicKeyPem)
  if (publicKey.asymmetricKeyType !== 'ed25519') throw new Error('Host-boundary public key must be Ed25519.')
  if (!verify(null, hostBoundaryAttestationSigningBytes(envelope), publicKey, Buffer.from(envelope.signature, 'base64'))) {
    throw new Error('Host-boundary attestation signature is invalid.')
  }
  return envelope
}

export function createFixedHostBoundaryRequest(challenge) {
  if (!isRecord(challenge)) throw new Error('Controller challenge must be an object.')
  const allowed = [
    'bootId',
    'controllerRunId',
    'expiresAt',
    'harnessDigest',
    'imageDigest',
    'issuedAt',
    'jobId',
    'nonce',
    'reviewedSha',
    'signingKeyId',
    'tlsFixtureDigest',
    'workflowRunId',
  ]
  exactKeys(challenge, allowed, 'controller challenge')
  return Object.freeze({
    schemaVersion: 2,
    operation: HOST_BOUNDARY_PREFLIGHT_OPERATION_V2,
    challenge: Object.freeze({ ...challenge }),
  })
}
