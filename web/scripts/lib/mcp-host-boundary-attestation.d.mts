export const HOST_BOUNDARY_ATTESTATION_DOMAIN_V2: string
export const HOST_BOUNDARY_PREFLIGHT_OPERATION_V2: string
export const HOST_BOUNDARY_MAX_ENVELOPE_BYTES: number

export type HostBoundaryAttestationEnvelope = Readonly<{
  schemaVersion: 2
  domain: string
  payload: Readonly<Record<string, unknown>>
  signingKeyId: string
  signature: string
}>

export function parseHostBoundaryAttestationEnvelope(value: unknown): HostBoundaryAttestationEnvelope
export function canonicalizeHostBoundaryJson(value: unknown): string
export function hostBoundaryAttestationSigningBytes(envelope: unknown): Buffer
export function verifyHostBoundaryAttestation(input: {
  envelope: unknown
  expected: Record<string, unknown>
  localPlatform?: NodeJS.Platform
  now?: Date
  publicKeyPem: string | Buffer
}): HostBoundaryAttestationEnvelope
export function createFixedHostBoundaryRequest(challenge: unknown): Readonly<Record<string, unknown>>
