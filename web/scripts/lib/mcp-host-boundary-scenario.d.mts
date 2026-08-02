export const HOST_BOUNDARY_SCENARIO_RESULT_DOMAIN_V2: string
export const HOST_BOUNDARY_SCENARIO_OPERATION_V2: string
export const HOST_BOUNDARY_SCENARIO_IDS: readonly string[]
export function hostBoundaryPreflightEnvelopeDigest(envelope: unknown): string
export function createFixedHostBoundaryScenarioRequest(input: {
  preflightEnvelope: unknown
  scenarioId: string
}): Readonly<Record<string, unknown>>
export function hostBoundaryScenarioResultSigningBytes(value: unknown): Buffer
export function verifyHostBoundaryScenarioResult(input: {
  preflightEnvelope: unknown
  publicKeyPem: string | Buffer
  result: unknown
  scenarioId: string
}): Readonly<Record<string, unknown>>
