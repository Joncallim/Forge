import { z } from 'zod'

// These contracts deliberately have no dependencies on persistence, compatibility,
// queues, providers, or UI.  They describe generic runtime data, not authority to
// perform a side effect.
export const runtimeContractVersion = 'v1' as const
export const opaqueIdSchema = z.string().uuid()
export const digestSchema = z.string().regex(/^[a-f0-9]{64}$/)
// Revisions cross JSON as canonical decimal strings. This avoids unsafe JS
// numbers while remaining compatible with the repository's ES2017 target.
export const revisionSchema = z.string().regex(/^(0|[1-9][0-9]*)$/)
export const reasonCodeSchema = z.string().regex(/^vnext\.[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/)

export const principalRefSchema = z.object({
  version: z.literal(runtimeContractVersion),
  type: z.enum(['user', 'service', 'workspace', 'operator']),
  id: opaqueIdSchema,
}).strict()
export type PrincipalRef = z.infer<typeof principalRefSchema>

export const resourceRefSchema = z.object({
  version: z.literal(runtimeContractVersion),
  id: opaqueIdSchema,
  type: z.enum(['repository', 'workspace', 'document', 'dataset', 'service', 'other']),
  revision: z.string().min(1).max(256),
  classification: z.enum(['public', 'internal', 'confidential', 'secret', 'unknown']),
}).strict()
export type ResourceRef = z.infer<typeof resourceRefSchema>

export const resourceBindingSchema = z.object({
  version: z.literal(runtimeContractVersion),
  resource: resourceRefSchema,
  selectorDigest: digestSchema,
  provenance: z.enum(['compatibility', 'operator', 'migration', 'system']),
}).strict()
export type ResourceBinding = z.infer<typeof resourceBindingSchema>

export const capabilityRefSchema = z.object({
  version: z.literal(runtimeContractVersion),
  actionClass: z.string().regex(/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/),
}).strict()
export type CapabilityRef = z.infer<typeof capabilityRefSchema>

export const capabilityRequestSchema = z.object({
  version: z.literal(runtimeContractVersion),
  capability: capabilityRefSchema,
  resource: resourceRefSchema,
  requestedConstraintsDigest: digestSchema,
}).strict()
export type CapabilityRequest = z.infer<typeof capabilityRequestSchema>

// Phase 0 projects a pre-existing grant only. This intentionally has no
// issuance fields or constructor that could turn a request into authority.
export const grantEnvelopeSchema = z.object({
  version: z.literal(runtimeContractVersion),
  id: opaqueIdSchema,
  principal: principalRefSchema,
  capability: capabilityRefSchema,
  resourceScope: resourceRefSchema,
  constraintsDigest: digestSchema,
  policyRevision: z.string().min(1).max(256),
  parentGrantId: opaqueIdSchema.nullable(),
  evidenceDigest: digestSchema,
  expiresAt: z.coerce.date().nullable(),
  revokedAt: z.coerce.date().nullable(),
}).strict()
export type GrantEnvelope = z.infer<typeof grantEnvelopeSchema>

export const missionLifecycleSchema = z.enum(['active', 'paused', 'terminal'])
export const missionOutcomeSchema = z.enum(['succeeded', 'failed', 'cancelled'])
export const executionLifecycleSchema = z.enum(['created', 'admitted', 'queued', 'leased', 'running', 'waiting', 'terminal'])
export const executionOutcomeSchema = z.enum(['succeeded', 'failed', 'cancelled', 'rejected'])

export const compatibilityPinsSchema = z.object({
  version: z.literal(runtimeContractVersion),
  workflowRevision: z.string().min(1).max(256),
  policyRevision: z.string().min(1).max(256),
  budgetEnvelopeRevision: z.string().min(1).max(256),
}).strict()

export const missionSpecSchema = z.object({
  version: z.literal(runtimeContractVersion),
  desiredOutcomeDigest: digestSchema,
  constraintsDigest: digestSchema,
  resourceBindings: z.array(resourceBindingSchema).max(32),
  compatibilityPins: compatibilityPinsSchema,
  parentMissionId: opaqueIdSchema.nullable(),
}).strict()
export type MissionSpec = z.infer<typeof missionSpecSchema>

export const missionRefSchema = z.object({
  version: z.literal(runtimeContractVersion),
  id: opaqueIdSchema,
  owner: principalRefSchema,
  lifecycle: missionLifecycleSchema,
  outcome: missionOutcomeSchema.nullable(),
  revision: revisionSchema,
}).strict()
export type MissionRef = z.infer<typeof missionRefSchema>

export const executionRefSchema = z.object({
  version: z.literal(runtimeContractVersion),
  id: opaqueIdSchema,
  missionId: opaqueIdSchema,
  lifecycle: executionLifecycleSchema,
  outcome: executionOutcomeSchema.nullable(),
  revision: revisionSchema,
}).strict()
export type ExecutionRef = z.infer<typeof executionRefSchema>

export const executionContextSchema = z.object({
  version: z.literal(runtimeContractVersion),
  execution: executionRefSchema,
  principal: principalRefSchema,
  workflowRevision: z.string().min(1).max(256),
  resourceBindings: z.array(resourceBindingSchema).max(32),
  blockerReasonCode: reasonCodeSchema.nullable(),
}).strict()
export type ExecutionContext = z.infer<typeof executionContextSchema>

export function isValidMissionState(lifecycle: z.infer<typeof missionLifecycleSchema>, outcome: z.infer<typeof missionOutcomeSchema> | null): boolean {
  return (lifecycle === 'terminal') === (outcome !== null)
}

export function isValidExecutionState(lifecycle: z.infer<typeof executionLifecycleSchema>, outcome: z.infer<typeof executionOutcomeSchema> | null): boolean {
  return (lifecycle === 'terminal') === (outcome !== null)
}
