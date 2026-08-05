import type { OperationDefinition, OperationPolicyCeiling, OperationPolicyDecision } from './contracts'

export type TrustedOperationPolicyContext = {
  projectId: string
  scopedProjectId: string
  policyVersion: string
  allowedCapabilities: readonly string[]
  policyCeilings: Readonly<Record<OperationPolicyCeiling, boolean>>
}

export function evaluateOperationPolicy(input: {
  definition: OperationDefinition
  requestedCapability: string
  context: TrustedOperationPolicyContext
}): OperationPolicyDecision {
  const base = {
    schemaVersion: 1 as const,
    capability: input.definition.capability,
    projectId: input.context.projectId,
    policyVersion: input.context.policyVersion,
  }
  if (!input.definition.enabled) return { ...base, allowed: false, code: 'operation_disabled' }
  if (input.definition.deprecated) return { ...base, allowed: false, code: 'operation_deprecated' }
  if (input.requestedCapability !== input.definition.capability) {
    return { ...base, allowed: false, code: 'capability_mismatch' }
  }
  if (input.context.projectId !== input.context.scopedProjectId) {
    return { ...base, allowed: false, code: 'scope_mismatch' }
  }
  if (!input.context.allowedCapabilities.includes(input.definition.capability)) {
    return { ...base, allowed: false, code: 'missing_capability' }
  }
  if (input.context.policyCeilings[input.definition.requiredPolicyCeiling] !== true) {
    return { ...base, allowed: false, code: 'policy_ceiling_denied' }
  }
  return { ...base, allowed: true, code: 'allowed' }
}
