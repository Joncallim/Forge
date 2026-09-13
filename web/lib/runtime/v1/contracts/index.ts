import { z } from 'zod'

export const safeRevisionSchema = z.string().regex(/^(?:rev:v1:[A-Za-z0-9._-]{1,200}|sha256:[a-f0-9]{64})$/, 'safe revision identifier required')

// These contracts deliberately have no dependencies on persistence, compatibility,
// queues, providers, or UI.  They describe generic runtime data, not authority to
// perform a side effect.
export const runtimeContractVersion = 'v1' as const
// Forge's existing random UUID identities are the accepted opaque equivalent
// to UUIDv7 for this additive slice.  They carry no type, hierarchy, owner, or
// lifecycle information; a later ordered-ID migration must not re-key them.
export const opaqueIdSchema = z.string().uuid()
export const digestSchema = z.string().regex(/^[a-f0-9]{64}$/)
// Revisions cross JSON as canonical decimal strings. This avoids unsafe JS
// numbers while remaining compatible with the repository's ES2017 target.
export const revisionSchema = z.string().regex(/^(0|[1-9][0-9]*)$/)
export const reasonCodes = [
  'internal.error', 'auth.unauthorized', 'auth.credentials_missing', 'auth.credentials_expired', 'auth.session_expired',
  'policy.denied', 'policy.evaluation_error', 'policy.missing', 'policy.version_mismatch',
  'grant.denied', 'grant.expired', 'grant.revoked', 'grant.missing', 'grant.insufficient_scope', 'grant.parent_revoked',
  'resource.not_found', 'resource.access_denied', 'resource.classification_denied', 'resource.locked',
  'budget.exhausted', 'budget.reservation_failed', 'budget.unknown_cost', 'budget.ceiling_exceeded',
  'provider.unavailable', 'provider.configuration_error', 'provider.authentication_error', 'provider.quota_exhausted', 'provider.rate_limited', 'provider.timeout',
  'model.invocation_failed', 'model.refused', 'model.output_validation_failed', 'model.context_exceeded',
  'operation.invalid_input', 'operation.validation_failed', 'operation.timeout', 'operation.cancelled', 'operation.unsupported_resource', 'operation.version_mismatch',
  'side_effect.submission_uncertain', 'side_effect.reconciliation_failed', 'side_effect.human_required', 'side_effect.duplicate_prevented',
  'execution.admitted', 'execution.queued', 'execution.leased', 'execution.running', 'execution.waiting', 'execution.succeeded', 'execution.failed', 'execution.admission_denied', 'execution.lease_lost', 'execution.timeout', 'execution.cancelled', 'execution.blocked', 'execution.indeterminate',
  'mission.created', 'mission.activated', 'mission.waiting', 'mission.paused', 'mission.succeeded', 'mission.failed', 'mission.not_found', 'mission.terminal', 'mission.cancelled',
  'queue.full', 'queue.rate_limited', 'queue.dispatch_failed', 'trigger.invalid_event', 'trigger.deduplicated', 'trigger.loop_prevented', 'trigger.processing_failed',
  'verification.evidence_missing', 'verification.evidence_stale', 'verification.gate_blocked', 'verification.self_verification_denied',
  'gate.evaluation_error', 'gate.evidence_insufficient', 'gate.human_required',
  'package.install_failed', 'package.validation_failed', 'package.version_mismatch', 'package.provenance_mismatch', 'package.dependency_failed',
  'adapter.unavailable', 'adapter.timeout', 'adapter.credential_missing', 'adapter.invalid_response', 'adapter.capability_unsupported',
  'migration.in_progress', 'migration.validation_failed', 'migration.conflict', 'migration.rollback_required', 'migration.rollback_failed',
  'security.policy_violation', 'security.audit_failed', 'security.integrity_violation', 'security.violation', 'security.egress_denied', 'security.sandbox_escape_prevented', 'security.confused_denied',
] as const
export const reasonCodeSchema = z.enum(reasonCodes)

// Principal kind is identity provenance, never an authority grant.  Keep this
// closed: a new actor must be deliberately added to contracts, persistence and
// audit policy together.
export const principalTypeSchema = z.enum([
  'operator', 'system', 'mission', 'execution', 'agent_run', 'trigger',
  'adapter', 'verifier', 'service',
])

export const principalRefSchema = z.object({
  version: z.literal(runtimeContractVersion),
  type: principalTypeSchema,
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
  policyRevision: safeRevisionSchema,
  parentGrantId: opaqueIdSchema.nullable(),
  evidenceDigest: digestSchema,
  expiresAt: z.coerce.date().nullable(),
  revokedAt: z.coerce.date().nullable(),
}).strict()
export type GrantEnvelope = z.infer<typeof grantEnvelopeSchema>

export const missionLifecycleSchema = z.enum(['draft', 'active', 'waiting', 'paused', 'terminal'])
export const missionOutcomeSchema = z.enum(['succeeded', 'failed', 'cancelled'])
export const executionLifecycleSchema = z.enum(['created', 'admitted', 'queued', 'leased', 'running', 'waiting', 'terminal'])
export const executionOutcomeSchema = z.enum(['succeeded', 'failed', 'cancelled', 'blocked', 'indeterminate'])

const compatibilityPinRevisionsSchema = z.object({
  version: z.literal(runtimeContractVersion),
  workflowRevision: safeRevisionSchema,
  policyRevision: safeRevisionSchema,
  budgetEnvelopeRevision: safeRevisionSchema,
}).strict()

// The generic profile is deliberately separate from the coding compatibility
// seam. It is a truthful project-less, zero-capability baseline rather than a
// software-engineering workflow with empty-looking fields.
export const genericZeroCapabilityPinsSchema = compatibilityPinRevisionsSchema.extend({
  compatibilityMode: z.literal('generic_zero_capability_v1'),
}).strict()

export const softwareEngineeringLegacyPinsSchema = compatibilityPinRevisionsSchema.extend({
  compatibilityMode: z.literal('software_engineering_legacy_v1'),
}).strict()

export const compatibilityPinsSchema = z.discriminatedUnion('compatibilityMode', [
  genericZeroCapabilityPinsSchema,
  softwareEngineeringLegacyPinsSchema,
])

const missionSpecBaseSchema = z.object({
  version: z.literal(runtimeContractVersion),
  desiredOutcomeDigest: digestSchema,
  constraintsDigest: digestSchema,
  parentMissionId: opaqueIdSchema.nullable(),
}).strict()

export const missionSpecSchema = z.union([
  missionSpecBaseSchema.extend({
    resourceBindings: z.array(resourceBindingSchema).length(0),
    compatibilityPins: genericZeroCapabilityPinsSchema,
  }).strict(),
  missionSpecBaseSchema.extend({
    resourceBindings: z.array(resourceBindingSchema).max(32),
    compatibilityPins: softwareEngineeringLegacyPinsSchema,
  }).strict(),
])
export type MissionSpec = z.infer<typeof missionSpecSchema>

export const missionRefSchema = z.object({
  version: z.literal(runtimeContractVersion),
  id: opaqueIdSchema,
  owner: principalRefSchema,
  lifecycle: missionLifecycleSchema,
  outcome: missionOutcomeSchema.nullable(),
  revision: revisionSchema,
  createdAt: z.string().datetime({ offset: true }),
  activeAt: z.string().datetime({ offset: true }).nullable(),
  waitingAt: z.string().datetime({ offset: true }).nullable(),
  pausedAt: z.string().datetime({ offset: true }).nullable(),
  terminalAt: z.string().datetime({ offset: true }).nullable(),
  updatedAt: z.string().datetime({ offset: true }),
}).strict().superRefine((value, context) => {
  if (!isValidMissionState(value.lifecycle, value.outcome)) {
    context.addIssue({ code: 'custom', message: 'Mission lifecycle and outcome are inconsistent.' })
  }
  const timestampForLifecycle = {
    draft: null,
    active: value.activeAt,
    waiting: value.waitingAt,
    paused: value.pausedAt,
    terminal: value.terminalAt,
  }[value.lifecycle]
  if (value.lifecycle !== 'draft' && timestampForLifecycle === null) {
    context.addIssue({ code: 'custom', message: 'Mission lifecycle is missing its authoritative transition timestamp.' })
  }
  if (value.lifecycle !== 'terminal' && value.terminalAt !== null) {
    context.addIssue({ code: 'custom', message: 'A non-terminal Mission cannot have a terminal timestamp.' })
  }
})
export type MissionRef = z.infer<typeof missionRefSchema>

export const executionRefSchema = z.object({
  version: z.literal(runtimeContractVersion),
  id: opaqueIdSchema,
  missionId: opaqueIdSchema,
  lifecycle: executionLifecycleSchema,
  outcome: executionOutcomeSchema.nullable(),
  revision: revisionSchema,
  createdAt: z.string().datetime({ offset: true }),
  admittedAt: z.string().datetime({ offset: true }).nullable(),
  queuedAt: z.string().datetime({ offset: true }).nullable(),
  leasedAt: z.string().datetime({ offset: true }).nullable(),
  runningAt: z.string().datetime({ offset: true }).nullable(),
  waitingAt: z.string().datetime({ offset: true }).nullable(),
  terminalAt: z.string().datetime({ offset: true }).nullable(),
  updatedAt: z.string().datetime({ offset: true }),
}).strict().superRefine((value, context) => {
  if (!isValidExecutionState(value.lifecycle, value.outcome)) {
    context.addIssue({ code: 'custom', message: 'Execution lifecycle and outcome are inconsistent.' })
  }
  const timestampForLifecycle = {
    created: null,
    admitted: value.admittedAt,
    queued: value.queuedAt,
    leased: value.leasedAt,
    running: value.runningAt,
    waiting: value.waitingAt,
    terminal: value.terminalAt,
  }[value.lifecycle]
  if (value.lifecycle !== 'created' && timestampForLifecycle === null) {
    context.addIssue({ code: 'custom', message: 'Execution lifecycle is missing its authoritative transition timestamp.' })
  }
  if (value.lifecycle !== 'terminal' && value.terminalAt !== null) {
    context.addIssue({ code: 'custom', message: 'A non-terminal Execution cannot have a terminal timestamp.' })
  }
})
export type ExecutionRef = z.infer<typeof executionRefSchema>

export const executionContextSchema = z.object({
  version: z.literal(runtimeContractVersion),
  execution: executionRefSchema,
  principal: principalRefSchema,
  workflowRevision: safeRevisionSchema,
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
