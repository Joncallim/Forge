import { eq } from 'drizzle-orm'

import { db } from '@/db'
import { agentHarnesses, agentRuns, projects, providerConfigs, tasks, workPackages } from '@/db/schema'
import { RELIABILITY_POLICY_VERSION } from '@/lib/reliability/contracts'
import type {
  ReliabilityPolicyInput,
  ReliabilityRuntimeInput,
  ReliabilityScopeInput,
} from '@/lib/reliability/contracts'
import type { CapabilitySource } from './ledger'

function extractRequiredCapabilities(requiredCapabilities: unknown): string[] | null {
  if (
    requiredCapabilities
    && typeof requiredCapabilities === 'object'
    && Array.isArray((requiredCapabilities as { required?: unknown }).required)
  ) {
    return (requiredCapabilities as { required: unknown[] }).required.filter(
      (c): c is string => typeof c === 'string',
    )
  }
  return null
}

/** Reads the Architect's required-capability classification for one work package. */
export async function loadWorkPackageCapabilitySource(pkg: {
  id: string
  assignedRole: string
}): Promise<CapabilitySource> {
  const [row] = await db
    .select({ requiredCapabilities: workPackages.requiredCapabilities })
    .from(workPackages)
    .where(eq(workPackages.id, pkg.id))
    .limit(1)
  return {
    kind: 'work_package',
    role: pkg.assignedRole,
    capabilities: extractRequiredCapabilities(row?.requiredCapabilities),
  }
}

/** Like `loadWorkPackageCapabilitySource`, plus the declared acceptance-criteria count. */
export async function loadWorkPackageCapabilityContext(pkg: {
  id: string
  assignedRole: string
}): Promise<{ source: CapabilitySource; acceptanceCriteriaTotal: number }> {
  const [row] = await db
    .select({
      requiredCapabilities: workPackages.requiredCapabilities,
      acceptanceCriteria: workPackages.acceptanceCriteria,
    })
    .from(workPackages)
    .where(eq(workPackages.id, pkg.id))
    .limit(1)
  return {
    source: {
      kind: 'work_package',
      role: pkg.assignedRole,
      capabilities: extractRequiredCapabilities(row?.requiredCapabilities),
    },
    acceptanceCriteriaTotal: Array.isArray(row?.acceptanceCriteria) ? row.acceptanceCriteria.length : 0,
  }
}

/**
 * Reads the project's opaque root identity and assembles the scope
 * fingerprint input. One extra indexed read, acceptable per the ingest
 * boundary guidance -- never a live re-read of anything mutable beyond this.
 */
export async function buildWorkPackageReliabilityScope(input: {
  projectId: string
  rootBindingRevision: bigint
  grantDecisionRevision: bigint
  repositoryWriteIntent: boolean
  capabilities: string[]
  mcpRequirementKeys: string[]
}): Promise<ReliabilityScopeInput> {
  const [project] = await db
    .select({ rootRef: projects.rootRef })
    .from(projects)
    .where(eq(projects.id, input.projectId))
    .limit(1)
  return {
    contractVersion: 1,
    projectId: input.projectId,
    rootRef: project?.rootRef ?? null,
    rootBindingRevision: input.rootBindingRevision.toString(),
    grantDecisionRevision: input.grantDecisionRevision.toString(),
    repositoryWriteIntent: input.repositoryWriteIntent,
    capabilities: input.capabilities,
    mcpRequirementKeys: input.mcpRequirementKeys,
  }
}

/**
 * Loads project scope fresh via the task, for ingest boundaries (completion,
 * failure) where no already-locked project snapshot is in scope. Returns
 * null when the task or its project is unavailable -- callers must skip
 * ingest rather than fabricate scope identity.
 */
export async function buildWorkPackageReliabilityScopeForTask(input: {
  taskId: string
  repositoryWriteIntent: boolean
  capabilities: string[]
  mcpRequirementKeys: string[]
}): Promise<ReliabilityScopeInput | null> {
  const [row] = await db
    .select({
      projectId: tasks.projectId,
      rootRef: projects.rootRef,
      rootBindingRevision: projects.rootBindingRevision,
      grantDecisionRevision: projects.grantDecisionRevision,
    })
    .from(tasks)
    .innerJoin(projects, eq(projects.id, tasks.projectId))
    .where(eq(tasks.id, input.taskId))
    .limit(1)
  if (!row) return null
  return {
    contractVersion: 1,
    projectId: row.projectId,
    rootRef: row.rootRef ?? null,
    rootBindingRevision: row.rootBindingRevision.toString(),
    grantDecisionRevision: row.grantDecisionRevision.toString(),
    repositoryWriteIntent: input.repositoryWriteIntent,
    capabilities: input.capabilities,
    mcpRequirementKeys: input.mcpRequirementKeys,
  }
}

/** Scope input for a deterministic operation attempt (ADR 0011). One extra project read. */
export async function buildOperationReliabilityScope(input: {
  projectId: string
  capability: string
}): Promise<ReliabilityScopeInput | null> {
  const [project] = await db
    .select({
      rootRef: projects.rootRef,
      rootBindingRevision: projects.rootBindingRevision,
      grantDecisionRevision: projects.grantDecisionRevision,
    })
    .from(projects)
    .where(eq(projects.id, input.projectId))
    .limit(1)
  if (!project) return null
  return {
    contractVersion: 1,
    projectId: input.projectId,
    rootRef: project.rootRef ?? null,
    rootBindingRevision: project.rootBindingRevision.toString(),
    grantDecisionRevision: project.grantDecisionRevision.toString(),
    repositoryWriteIntent: false,
    capabilities: [input.capability],
    mcpRequirementKeys: [],
  }
}

/** Runtime identity for a deterministic operation attempt (ADR 0011). */
export function buildOperationRuntimeInput(adapterKind: string): ReliabilityRuntimeInput {
  return { kind: 'deterministic_adapter', adapterKind }
}

/** Runtime identity for an attempt that actually executed, from the agent-run snapshot. */
export function buildExecutedRuntimeInput(run: {
  providerTypeUsed: string | null
  modelIdUsed: string
  providerIsLocalUsed: boolean | null
  providerConfigUpdatedAtUsed: Date | null
  acpExecutionMode: string
}): ReliabilityRuntimeInput {
  return {
    kind: 'model',
    providerType: run.providerTypeUsed,
    modelId: run.modelIdUsed,
    providerIsLocal: run.providerIsLocalUsed,
    providerConfigUpdatedAt: run.providerConfigUpdatedAtUsed
      ? run.providerConfigUpdatedAtUsed.toISOString()
      : null,
    acpExecutionMode: run.acpExecutionMode,
  }
}

/**
 * Loads the actual agent-run snapshot fresh by id rather than trusting a
 * caller's in-scope `run` object, which on the protected S4 lifecycle path
 * can be a partial `{ id }` stand-in. Returns null when the row or its
 * model snapshot is unavailable -- the caller must skip ingest rather than
 * fabricate a runtime fingerprint.
 */
export async function buildExecutedRuntimeInputFromRunId(
  runId: string,
): Promise<ReliabilityRuntimeInput | null> {
  const [run] = await db
    .select({
      providerTypeUsed: agentRuns.providerTypeUsed,
      modelIdUsed: agentRuns.modelIdUsed,
      providerIsLocalUsed: agentRuns.providerIsLocalUsed,
      providerConfigUpdatedAtUsed: agentRuns.providerConfigUpdatedAtUsed,
      acpExecutionMode: agentRuns.acpExecutionMode,
    })
    .from(agentRuns)
    .where(eq(agentRuns.id, runId))
    .limit(1)
  if (!run?.modelIdUsed) return null
  return buildExecutedRuntimeInput(run)
}

/**
 * Runtime identity for an admission block, which happens before any agent
 * run exists. Uses the assigned harness's configured default provider as the
 * intended runtime. Returns null when that identity is unavailable -- the
 * caller must skip ingest rather than fabricate a runtime fingerprint.
 */
export async function buildIntendedRuntimeInputFromHarness(
  harnessId: string | null,
): Promise<ReliabilityRuntimeInput | null> {
  if (!harnessId) return null
  const [harness] = await db
    .select({ defaultProviderConfigId: agentHarnesses.defaultProviderConfigId })
    .from(agentHarnesses)
    .where(eq(agentHarnesses.id, harnessId))
    .limit(1)
  if (!harness?.defaultProviderConfigId) return null
  const [provider] = await db
    .select({
      providerType: providerConfigs.providerType,
      modelId: providerConfigs.modelId,
      isLocal: providerConfigs.isLocal,
      updatedAt: providerConfigs.updatedAt,
    })
    .from(providerConfigs)
    .where(eq(providerConfigs.id, harness.defaultProviderConfigId))
    .limit(1)
  if (!provider) return null
  return {
    kind: 'model',
    providerType: provider.providerType,
    modelId: provider.modelId,
    providerIsLocal: provider.isLocal,
    providerConfigUpdatedAt: provider.updatedAt.toISOString(),
    acpExecutionMode: 'not_applicable',
  }
}

/** Policy input for a deterministic operation attempt (ADR 0011): no harness, no review gate. */
export function buildOperationPolicyInput(): ReliabilityPolicyInput {
  return {
    contractVersion: 1,
    policyVersion: RELIABILITY_POLICY_VERSION,
    harnessId: null,
    harnessUpdatedAt: null,
    reviewRequirement: 'none',
    repositoryWritesEnabled: false,
  }
}

/** Extracts stable requirement keys from a work package's mcp_requirements array. */
export function extractMcpRequirementKeys(mcpRequirements: unknown): string[] {
  if (!Array.isArray(mcpRequirements)) return []
  const keys: string[] = []
  for (const item of mcpRequirements) {
    if (item && typeof item === 'object' && typeof (item as { requirementKey?: unknown }).requirementKey === 'string') {
      keys.push((item as { requirementKey: string }).requirementKey)
    }
  }
  return keys
}

export async function buildWorkPackagePolicyInput(input: {
  harnessId: string | null
  reviewRequirement: 'none' | 'qa_only' | 'reviewer_only' | 'both'
  repositoryWritesEnabled: boolean
}): Promise<ReliabilityPolicyInput> {
  let harnessUpdatedAt: string | null = null
  if (input.harnessId) {
    const [harness] = await db
      .select({ updatedAt: agentHarnesses.updatedAt })
      .from(agentHarnesses)
      .where(eq(agentHarnesses.id, input.harnessId))
      .limit(1)
    harnessUpdatedAt = harness?.updatedAt ? harness.updatedAt.toISOString() : null
  }
  return {
    contractVersion: 1,
    policyVersion: RELIABILITY_POLICY_VERSION,
    harnessId: input.harnessId,
    harnessUpdatedAt,
    reviewRequirement: input.reviewRequirement,
    repositoryWritesEnabled: input.repositoryWritesEnabled,
  }
}
