import { createHash, createPublicKey, verify } from 'node:crypto'
import {
  canonicalizeHostBoundaryJson,
  parseHostBoundaryAttestationEnvelope,
} from './mcp-host-boundary-attestation.mjs'

export const HOST_BOUNDARY_SCENARIO_RESULT_DOMAIN_V2 = 'forge:mcp-host-boundary-scenario-result:v2\0'
export const HOST_BOUNDARY_SCENARIO_OPERATION_V2 = 'run_fixed_mcp_host_boundary_scenario_v2'
export const HOST_BOUNDARY_SCENARIO_IDS = Object.freeze([
  'epic-172.cgroup-descendant-containment',
  'epic-172.failure-injection-quiescence',
  'epic-172.peer-credential-boundary',
  'epic-172.protected-fence-service',
  'epic-172.supported-host-preflight',
  'epic-172.teardown-zero-residue',
  'epic-172.uid-credential-isolation',
])

const SCENARIO_SET = new Set(HOST_BOUNDARY_SCENARIO_IDS)
const BASE64_SIGNATURE = /^[A-Za-z0-9+/]{86}==$/

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function exactKeys(value, expected, label) {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} has an unexpected field.`)
  }
}

export function hostBoundaryPreflightEnvelopeDigest(envelope) {
  const parsed = parseHostBoundaryAttestationEnvelope(envelope)
  return `sha256:${createHash('sha256').update(canonicalizeHostBoundaryJson(parsed)).digest('hex')}`
}

export function createFixedHostBoundaryScenarioRequest(input) {
  if (!isRecord(input)) throw new Error('Host-boundary scenario request is invalid.')
  exactKeys(input, ['preflightEnvelope', 'scenarioId'], 'host-boundary scenario request')
  if (typeof input.scenarioId !== 'string' || !SCENARIO_SET.has(input.scenarioId)) {
    throw new Error('Unknown host-boundary scenario ID.')
  }
  const envelope = parseHostBoundaryAttestationEnvelope(input.preflightEnvelope)
  return Object.freeze({
    schemaVersion: 2,
    operation: HOST_BOUNDARY_SCENARIO_OPERATION_V2,
    scenarioId: input.scenarioId,
    preflightEnvelopeDigest: hostBoundaryPreflightEnvelopeDigest(envelope),
  })
}

function parseResult(value) {
  if (!isRecord(value)) throw new Error('Host-boundary scenario result must be an object.')
  exactKeys(value, ['domain', 'payload', 'schemaVersion', 'signature', 'signingKeyId'], 'scenario result')
  if (value.schemaVersion !== 2 || value.domain !== HOST_BOUNDARY_SCENARIO_RESULT_DOMAIN_V2) {
    throw new Error('Wrong host-boundary scenario result version or domain.')
  }
  if (typeof value.signingKeyId !== 'string' || value.signingKeyId.length === 0 || value.signingKeyId.length > 128) {
    throw new Error('Host-boundary scenario result key is invalid.')
  }
  if (typeof value.signature !== 'string' || !BASE64_SIGNATURE.test(value.signature)) {
    throw new Error('Host-boundary scenario result signature is invalid.')
  }
  const signature = Buffer.from(value.signature, 'base64')
  if (signature.length !== 64 || signature.toString('base64') !== value.signature) {
    throw new Error('Host-boundary scenario result signature is not canonical.')
  }
  if (!isRecord(value.payload)) throw new Error('Host-boundary scenario payload must be an object.')
  exactKeys(value.payload, [
    'bootId',
    'controllerRunId',
    'facts',
    'firstAttempt',
    'jobId',
    'observedAt',
    'passed',
    'preflightEnvelopeDigest',
    'reviewedSha',
    'scenarioId',
  ], 'scenario result payload')
  if (typeof value.payload.scenarioId !== 'string' || !SCENARIO_SET.has(value.payload.scenarioId)) {
    throw new Error('Host-boundary scenario result ID is invalid.')
  }
  if (!isRecord(value.payload.facts)) throw new Error('Host-boundary scenario facts must be an object.')
  exactKeys(value.payload.facts, [
    'arbitraryCommandSurfaceAbsent',
    'completeGroupEmpty',
    'crossUidAccessDenied',
    'failureRolledBack',
    'peerCredentialsEnforced',
    'protectedStateUnmodified',
    'zeroResidue',
  ], 'scenario result facts')
  const facts = Object.fromEntries(Object.entries(value.payload.facts).map(([key, fact]) => {
    if (typeof fact !== 'boolean') throw new Error(`Host-boundary fact ${key} must be boolean.`)
    return [key, fact]
  }))
  if (
    typeof value.payload.bootId !== 'string'
    || typeof value.payload.controllerRunId !== 'string'
    || typeof value.payload.jobId !== 'string'
    || typeof value.payload.reviewedSha !== 'string'
    || typeof value.payload.preflightEnvelopeDigest !== 'string'
    || typeof value.payload.observedAt !== 'string'
    || typeof value.payload.firstAttempt !== 'boolean'
    || typeof value.payload.passed !== 'boolean'
  ) {
    throw new Error('Host-boundary scenario result bindings are invalid.')
  }
  return Object.freeze({
    schemaVersion: 2,
    domain: HOST_BOUNDARY_SCENARIO_RESULT_DOMAIN_V2,
    payload: Object.freeze({ ...value.payload, facts: Object.freeze(facts) }),
    signingKeyId: value.signingKeyId,
    signature: value.signature,
  })
}

export function hostBoundaryScenarioResultSigningBytes(value) {
  const parsed = parseResult(value)
  return Buffer.concat([
    Buffer.from(HOST_BOUNDARY_SCENARIO_RESULT_DOMAIN_V2, 'utf8'),
    Buffer.from(canonicalizeHostBoundaryJson(parsed.payload), 'utf8'),
  ])
}

export function verifyHostBoundaryScenarioResult(input) {
  const result = parseResult(input.result)
  const preflight = parseHostBoundaryAttestationEnvelope(input.preflightEnvelope)
  const expectedDigest = hostBoundaryPreflightEnvelopeDigest(preflight)
  const expectedBindings = {
    bootId: preflight.payload.bootId,
    controllerRunId: preflight.payload.controllerRunId,
    jobId: preflight.payload.jobId,
    preflightEnvelopeDigest: expectedDigest,
    reviewedSha: preflight.payload.reviewedSha,
    scenarioId: input.scenarioId,
  }
  for (const [key, expected] of Object.entries(expectedBindings)) {
    if (result.payload[key] !== expected) throw new Error(`Host-boundary scenario ${key} binding does not match.`)
  }
  if (result.signingKeyId !== preflight.signingKeyId) throw new Error('Host-boundary scenario signer changed after preflight.')
  if (result.payload.firstAttempt !== true) throw new Error('Host-boundary scenarios cannot be retried.')
  if (result.payload.passed !== true) throw new Error('Host-boundary scenario failed.')
  if (Object.values(result.payload.facts).some((fact) => fact !== true)) {
    throw new Error('Host-boundary scenario did not prove all closed safety facts.')
  }
  const observedAt = Date.parse(result.payload.observedAt)
  if (
    !Number.isFinite(observedAt)
    || new Date(observedAt).toISOString() !== result.payload.observedAt
    || observedAt < Date.parse(preflight.payload.issuedAt)
    || observedAt >= Date.parse(preflight.payload.expiresAt)
  ) {
    throw new Error('Host-boundary scenario result is outside the preflight evidence window.')
  }
  const publicKey = createPublicKey(input.publicKeyPem)
  if (publicKey.asymmetricKeyType !== 'ed25519') throw new Error('Host-boundary scenario key must be Ed25519.')
  if (!verify(null, hostBoundaryScenarioResultSigningBytes(result), publicKey, Buffer.from(result.signature, 'base64'))) {
    throw new Error('Host-boundary scenario signature is invalid.')
  }
  return result
}
