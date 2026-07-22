import { randomUUID } from 'crypto'
import { and, eq, inArray, or } from 'drizzle-orm'
import { sql } from 'drizzle-orm'
import { db } from '../db'
import {
  agentConfigs,
  agentHarnesses,
  approvalGates,
  projects,
  tasks,
  workPackageDependencies,
  workPackages,
} from '../db/schema'
import {
  projectFilesystemEffectivePhase,
  projectFilesystemGrantCovers,
} from '../lib/mcps/filesystem-grants'
import { loadCurrentProjectFilesystemDecision } from '../lib/mcps/filesystem-grant-reconciliation'
import { canonicalAgentPackageIdentity } from '../lib/mcps/agent-package-identity'
import type { PreparedArchitectArtifact } from './architect-artifact'
import type { ReviewRequirement } from './agent-breakdown'
import { isImplementationPackageRole } from './review-gates'
import {
  architectPlanEntryReference,
  parseArchitectPlanEntryReference,
  type ArchitectPlanEntryEnvelope,
  type ArchitectPlanEntryReference,
} from '../lib/mcps/architect-plan-entries'

type JsonObject = Record<string, unknown>
type AgentHarnessInsert = typeof agentHarnesses.$inferInsert & { id: string; slug: string; role: string }
type WorkPackageInsert = typeof workPackages.$inferInsert & { id: string; assignedRole: string }
type MaterializerAgentCatalogRow = Pick<typeof agentConfigs.$inferSelect, 'agentType' | 'displayName'>

type MaterializerRowSet = {
  harnesses: AgentHarnessInsert[]
  workPackages: WorkPackageInsert[]
  dependencies: Array<typeof workPackageDependencies.$inferInsert>
  approvalGate: typeof approvalGates.$inferInsert
}

export type WorkforceMaterializationInput = {
  taskId: string
  architectRunId: string
  artifactId: string
  prepared: PreparedArchitectArtifact
  protectedArchitectPlanEntries?: ArchitectPlanEntryEnvelope[]
}

export type WorkforceMaterializationResult = {
  status: 'materialized' | 'disabled' | 'cancelled'
  harnessCount: number
  workPackageCount: number
  dependencyCount: number
  approvalGateCount: number
}

type BuildOptions = {
  activeAgents?: MaterializerAgentCatalogRow[]
  idFactory?: () => string
  projectMcpConfig?: unknown
  projectFilesystemDecision?: unknown
  projectRootBindingRevision?: unknown
}

function featureFlagDisabled(value: string | undefined): boolean {
  return value === '0' || value?.toLowerCase() === 'false'
}

export function isWorkforceMaterializationEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return !featureFlagDisabled(env.FORGE_WORKFORCE_MATERIALIZATION)
}

function normalizeAgentType(role: string): string {
  return role.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')
}

function normalizeRoleLookup(value: string): string {
  return canonicalAgentPackageIdentity(value)
}

function displayNameForSlug(slug: string): string {
  return slug
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function defaultReviewRequirement(agentType: string): ReviewRequirement {
  return isImplementationPackageRole(agentType) ? 'both' : 'none'
}

function isReservedArchitectAssignedRole(role: string): boolean {
  const normalized = normalizeAgentType(role)
  return ['architect', 'security', 'security-review', 'security_review'].includes(normalized)
}

// Implementation packages keep full QA + Reviewer gates until executable
// QA/Reviewer work packages can produce durable gate decisions tied to the
// implementation artifact. The planning model is not allowed to downgrade them.
function resolveReviewRequirement(
  agentType: string,
  requested: ReviewRequirement | undefined,
): ReviewRequirement {
  if (isImplementationPackageRole(agentType)) return 'both'
  return requested ?? defaultReviewRequirement(agentType)
}

function titleForAgent(role: string): string {
  const trimmed = role.trim()
  return trimmed === '' ? 'Specialist work package' : `${trimmed} work package`
}

function plannedRoleSummary(input: WorkforceMaterializationInput): string {
  const roles = input.prepared.agents
    .map((agent) => agent.role.trim())
    .filter(Boolean)

  return roles.length > 0
    ? ` Planned roles: ${roles.join(', ')}.`
    : ' The plan did not include any parsed agent_breakdown_json agents or [Role] handoff tags.'
}

function resolveCanonicalAgentType(
  role: string,
  activeAgents: MaterializerAgentCatalogRow[] | undefined,
): string | null {
  const fallback = normalizeAgentType(role)
  if (!activeAgents) return fallback

  const requested = normalizeRoleLookup(role)
  const match = activeAgents.find((agent) =>
    normalizeRoleLookup(agent.displayName) === requested ||
    normalizeRoleLookup(agent.agentType) === requested
  )
  return match?.agentType ?? null
}

function roleAliases(role: string, agentType: string): string[] {
  return Array.from(new Set([normalizeAgentType(role), agentType].filter(Boolean)))
}

// Match roles separator-insensitively (`_` vs `-`). resolveCanonicalAgentType
// resolves via normalizeRoleLookup, so the MCP execution design may spell an
// agent as `backend_dev` while the canonical agentType is `backend-dev`;
// matching on normalizeAgentType alone would silently drop that package's MCP
// requirements/grants and bypass the broker entirely.
function roleMatches(value: string, agentType: string, aliases: string[]): boolean {
  const normalized = normalizeRoleLookup(value)
  return normalized === normalizeRoleLookup(agentType) ||
    aliases.some((alias) => normalizeRoleLookup(alias) === normalized)
}

function matchingObjectValues<T>(
  object: Record<string, T>,
  agentType: string,
  aliases: string[],
): T[] {
  return Object.entries(object)
    .filter(([key]) => roleMatches(key, agentType, aliases))
    .map(([, value]) => value)
}

function mcpGrantsForAgent(prepared: PreparedArchitectArtifact, agentType: string, aliases: string[]): JsonObject[] {
  return prepared.mcpExecutionDesign.grantDecisions.decisions
    .filter((decision) => roleMatches(decision.agent, agentType, aliases))
    .map((decision) => ({
      requirementKey: decision.requirementKey,
      decisionId: decision.decisionId,
      sourceRequirementIndex: decision.sourceRequirementIndex,
      agent: agentType,
      mcpId: decision.mcpId,
      capabilities: decision.capabilities,
      normalizedCapabilities: decision.normalizedCapabilities ?? decision.capabilities,
      capabilityClasses: decision.capabilityClasses ?? [],
      requirement: decision.requirement,
      status: decision.status,
      admissionStatus: decision.admissionStatus ?? (decision.status === 'proposed' ? 'allowed' : decision.status),
      mode: decision.mode ?? 'unknown_legacy',
      recoveryAction: decision.recoveryAction,
      grantState: decision.grantState ?? { phase: 'not_issued' },
      evidenceRefs: decision.evidenceRefs ?? [],
      reason: decision.reason,
      assignment: decision.assignment,
      fallback: decision.fallback,
      health: decision.health,
      // Protected prompt text is represented by one-use content-free references,
      // not by an inline grant-envelope overlay. The protected policy below owns
      // the separate indication that prompt context exists.
      promptOverlayPresent: false,
    }))
}

function mcpRequirementsForAgent(prepared: PreparedArchitectArtifact, agentType: string, aliases: string[]): JsonObject[] {
  const design = prepared.mcpExecutionDesign.proposed
  if (!design) return []

  const candidates = new Set([agentType, ...aliases].map(normalizeRoleLookup))
  return design.requirements
    .filter((requirement) => {
      const requirementAgents = requirementAgentsForMaterialization(requirement).map(normalizeRoleLookup)
      return requirementAgents.some((agent) => candidates.has(agent))
    })
    .map((requirement, index) => ({
      requirementKey: requirement.requirementKey,
      sourceRequirementIndex: requirement.sourceRequirementIndex ?? index,
      agent: agentType,
      mcpId: requirement.mcpId,
      requirement: requirement.requirement,
      reason: requirement.reason,
      confidence: requirement.confidence ?? 'medium',
      scope: requirement.scope ?? { kind: 'project' },
      accessMode: requirement.accessMode ?? 'planning_instruction',
      assignment: requirement.assignment,
      permissions: [...new Set(matchingObjectValues(requirement.agentPermissions, agentType, aliases).flat())].sort(),
      prohibitedCapabilities: requirement.prohibitedCapabilities,
      fallback: requirement.fallback,
    }))
}

function requirementAgentsForMaterialization(
  requirement: NonNullable<PreparedArchitectArtifact['mcpExecutionDesign']['proposed']>['requirements'][number],
): string[] {
  const agents = new Set([...requirement.assignment.targetAgents, ...Object.keys(requirement.agentPermissions)])
  if (requirement.assignment.type === 'architect_only') agents.add('architect')
  if (requirement.assignment.type === 'reviewer_only') agents.add('reviewer')
  return [...agents]
}

function mcpPromptContextForAgent(
  prepared: PreparedArchitectArtifact,
  protectedEntries: readonly ArchitectPlanEntryEnvelope[],
  taskId: string,
  artifactId: string,
  agentType: string,
  aliases: string[],
): Readonly<{ policy: JsonObject; references: ArchitectPlanEntryReference[] }> {
  const design = prepared.mcpExecutionDesign.proposed
  if (!design) {
    return {
      policy: {
        schemaVersion: 1,
        state: 'not_required',
        promptOverlayPresent: false,
        requirementContextCount: 0,
        mcpAwareSubtaskCount: 0,
        eligibleReferenceCount: 0,
      },
      references: [],
    }
  }

  const contexts = (design.requirementContexts ?? [])
    .filter((context) => roleMatches(context.agent, agentType, aliases))
  const legacyOverlays = matchingObjectValues(design.promptOverlays, agentType, aliases)
  const subtasks = design.mcpAwareSubtasks
    .filter((subtask) => roleMatches(subtask.agent, agentType, aliases))
  const promptOverlayPresent = contexts.some((context) => context.promptOverlay.trim() !== '')
    || legacyOverlays.some((overlay) => overlay.trim() !== '')
  const matchingEntries = protectedEntries.filter((entry) =>
    entry.taskId === taskId
      && entry.planArtifactId === artifactId
      && entry.projectionEligible
      && entry.agent !== null
      && roleMatches(entry.agent, agentType, aliases)
  )
  const referencePairs = matchingEntries.flatMap((entry) => {
    const reference = architectPlanEntryReference(entry)
    return parseArchitectPlanEntryReference(reference) ? [{ entry, reference }] : []
  })
  const referencedEntries = referencePairs.map(({ entry }) => entry)
  const references: ArchitectPlanEntryReference[] = referencePairs.map(({ reference }) => reference)
  const contextCoverageComplete = contexts.every((context) => referencedEntries.some((entry) =>
    (entry.entryKind === 'overlay' || entry.entryKind === 'requirement')
      && entry.requirementKey === context.requirementKey
  ))
  const subtaskCoverageComplete = referencedEntries.filter((entry) => entry.entryKind === 'subtask').length >= subtasks.length
  const protectedContextRequired = promptOverlayPresent || contexts.length > 0 || subtasks.length > 0
  const protectedCoverageComplete = protectedContextRequired
    && references.length > 0
    && contextCoverageComplete
    && subtaskCoverageComplete

  return {
    policy: {
      schemaVersion: 1,
      state: protectedCoverageComplete
        ? 'protected_references_available'
        : protectedContextRequired
          ? 'safe_policy_only'
          : 'not_required',
      promptOverlayPresent,
      requirementContextCount: contexts.length,
      mcpAwareSubtaskCount: subtasks.length,
      eligibleReferenceCount: references.length,
      protectedCoverageComplete,
    },
    references,
  }
}

function planningOnlyHarnessMetadata(): JsonObject {
  return {
    schemaVersion: 1,
    status: 'planning_only',
    runtimePolicyApplied: false,
    note: 'Harness records shape planning for beta handoff only; it is not wired as a runtime tool or MCP policy.',
  }
}

function mcpNormalizationEvidence(
  prepared: PreparedArchitectArtifact,
): JsonObject[] {
  return (prepared.mcpExecutionDesign.proposed?.normalizationEvidence ?? [])
    .map((evidence) => ({ ...evidence }))
}

function mcpGrantPhaseMetadata(input: {
  grants: JsonObject[]
  validationStatus: string
}): JsonObject {
  return {
    schemaVersion: 1,
    proposed: input.grants,
    broker: {
      schemaVersion: 1,
      runtimeEnforcement: 'not_implemented',
      validationStatus: input.validationStatus,
      status: input.validationStatus,
    },
    approved: null,
    effective: {
      schemaVersion: 1,
      phase: 'effective',
      runtimeIssued: false,
      runtimeEnforcement: 'not_implemented',
      status: 'not_issued',
      note: 'Effective run instructions are prompt/context metadata only in this beta; no live MCP runtime tools are issued.',
    },
  }
}

function buildDependencyRows(
  packages: WorkPackageInsert[],
  idFactory: () => string,
): Array<typeof workPackageDependencies.$inferInsert> {
  const implementationPackages = packages.filter(
    (pkg) => !['architect', 'qa', 'reviewer'].includes(pkg.assignedRole),
  )
  const qaPackages = packages.filter((pkg) => pkg.assignedRole === 'qa')
  const reviewerPackages = packages.filter((pkg) => pkg.assignedRole === 'reviewer')
  const dependencies: Array<typeof workPackageDependencies.$inferInsert> = []

  for (const qaPackage of qaPackages) {
    for (const implementationPackage of implementationPackages) {
      dependencies.push({
        id: idFactory(),
        workPackageId: qaPackage.id,
        dependsOnWorkPackageId: implementationPackage.id,
        dependencyType: 'finish_to_start',
        metadata: { source: 'workforce-materializer', rule: 'qa-after-implementation' },
      })
    }
  }

  const reviewerPrerequisites = qaPackages.length > 0 ? qaPackages : implementationPackages
  for (const reviewerPackage of reviewerPackages) {
    for (const prerequisite of reviewerPrerequisites) {
      dependencies.push({
        id: idFactory(),
        workPackageId: reviewerPackage.id,
        dependsOnWorkPackageId: prerequisite.id,
        dependencyType: 'finish_to_start',
        metadata: { source: 'workforce-materializer', rule: 'review-after-verification' },
      })
    }
  }

  return dependencies
}

export function buildWorkforceMaterializationRows(
  input: WorkforceMaterializationInput,
  options: BuildOptions = {},
): MaterializerRowSet {
  const idFactory = options.idFactory ?? randomUUID
  const harnesses: AgentHarnessInsert[] = []
  const packages: WorkPackageInsert[] = []

  input.prepared.agents.forEach((agent, index) => {
    const agentType = resolveCanonicalAgentType(agent.role, options.activeAgents)
    const fallbackAgentType = normalizeAgentType(agent.role)
    if (isReservedArchitectAssignedRole(agentType ?? fallbackAgentType) || isReservedArchitectAssignedRole(fallbackAgentType)) {
      return
    }

    if (!agentType) {
      const workPackageId = idFactory()
      packages.push({
        id: workPackageId,
        taskId: input.taskId,
        harnessId: null,
        assignedRole: fallbackAgentType || 'unconfigured-agent',
        title: titleForAgent(agent.role),
        summary: agent.summary || titleForAgent(agent.role),
        status: 'failed',
        sequence: index + 1,
        steps: agent.steps,
        requiredCapabilities: {
          schemaVersion: input.prepared.capabilityClassification.proposed.schemaVersion,
          required: input.prepared.capabilityClassification.proposed.required,
          optional: input.prepared.capabilityClassification.proposed.optional,
          excluded: input.prepared.capabilityClassification.proposed.excluded,
        },
        acceptanceCriteria: agent.steps.length > 0 ? agent.steps : [agent.summary || titleForAgent(agent.role)],
        mcpRequirements: [],
        reviewRequirement: 'none',
        blockedReason: `Architect assigned "${agent.role}", but no active configured agent matches that display name or slug. Create or reactivate an agent before execution.`,
        metadata: {
          source: 'architect-artifact',
          architectRunId: input.architectRunId,
          artifactId: input.artifactId,
          mcpGrantsSchemaVersion: 2,
          mcpNormalizationErrors: [...(input.prepared.mcpExecutionDesign.proposed?.normalizationErrors ?? [])],
          mcpNormalizationEvidence: mcpNormalizationEvidence(input.prepared),
          unresolvedAgentRole: agent.role,
          requiresAgentConfiguration: true,
        },
      })
      return
    }

    const harnessId = idFactory()
    const workPackageId = idFactory()
    const aliases = roleAliases(agent.role, agentType)
    const mcpGrants = mcpGrantsForAgent(input.prepared, agentType, aliases)
    const mcpRequirements = mcpRequirementsForAgent(input.prepared, agentType, aliases)
    const mcpPromptContext = mcpPromptContextForAgent(
      input.prepared,
      input.protectedArchitectPlanEntries ?? [],
      input.taskId,
      input.artifactId,
      agentType,
      aliases,
    )

    harnesses.push({
      id: harnessId,
      slug: agentType,
      role: agentType,
      displayName: agent.role || displayNameForSlug(agentType),
      category: agentType,
      description: `${agent.role || displayNameForSlug(agentType)} harness seeded from Architect workforce planning.`,
      systemPrompt: '',
      toolPolicy: {},
      referencePaths: [],
      outputSchema: {},
      validationChecks: [],
      isActive: true,
      metadata: {
        source: 'workforce-materializer',
        harnessSemantics: planningOnlyHarnessMetadata(),
        seededFromTaskId: input.taskId,
      },
    })

    const packageMetadata: JsonObject = {
      source: 'architect-artifact',
      architectRunId: input.architectRunId,
      artifactId: input.artifactId,
      mcpGrants,
      mcpGrantsSchemaVersion: 2,
      mcpNormalizationErrors: [...(input.prepared.mcpExecutionDesign.proposed?.normalizationErrors ?? [])],
      mcpNormalizationEvidence: mcpNormalizationEvidence(input.prepared),
      mcpGrantPhases: mcpGrantPhaseMetadata({
        grants: mcpGrants,
        validationStatus: input.prepared.mcpExecutionDesign.validation.status,
      }),
      harnessSemantics: planningOnlyHarnessMetadata(),
      mcpPromptContextPolicy: mcpPromptContext.policy,
      ...(mcpPromptContext.references.length > 0
        ? { architectPlanEntryReferences: mcpPromptContext.references }
        : {}),
      plannedTasks: agent.tasks,
    }
    const projectGrant = projectFilesystemGrantCovers({
      mcpConfig: options.projectMcpConfig,
      mcpRequirements,
      metadata: packageMetadata,
      projectFilesystemDecision: options.projectFilesystemDecision,
      projectRootBindingRevision: options.projectRootBindingRevision,
    })
    if (projectGrant) {
      const phases = packageMetadata.mcpGrantPhases
      packageMetadata.mcpGrantPhases = {
        ...(typeof phases === 'object' && phases !== null && !Array.isArray(phases) ? phases : {}),
        schemaVersion: 2,
        effective: projectFilesystemEffectivePhase(projectGrant),
      }
    }

    packages.push({
      id: workPackageId,
      taskId: input.taskId,
      harnessId,
      assignedRole: agentType,
      title: titleForAgent(agent.role),
      summary: agent.summary || titleForAgent(agent.role),
      status: 'pending',
      sequence: index + 1,
      steps: agent.steps,
      requiredCapabilities: {
        schemaVersion: input.prepared.capabilityClassification.proposed.schemaVersion,
        required: input.prepared.capabilityClassification.proposed.required,
        optional: input.prepared.capabilityClassification.proposed.optional,
        excluded: input.prepared.capabilityClassification.proposed.excluded,
      },
      acceptanceCriteria: agent.steps.length > 0 ? agent.steps : [agent.summary || titleForAgent(agent.role)],
      mcpRequirements,
      reviewRequirement: resolveReviewRequirement(agentType, agent.reviewRequirement),
      metadata: packageMetadata,
    })
  })

  return {
    harnesses,
    workPackages: packages,
    dependencies: buildDependencyRows(packages, idFactory),
    approvalGate: {
      id: idFactory(),
      taskId: input.taskId,
      gateType: 'plan_approval',
      status: 'pending',
      sourceAgentRunId: input.architectRunId,
      sourceArtifactId: input.artifactId,
      title: 'Approve Architect plan',
      instructions: 'Review the Architect plan before Forge releases specialist work packages.',
      metadata: {
        source: 'workforce-materializer',
        artifactId: input.artifactId,
        architectRunId: input.architectRunId,
        harnessSemantics: planningOnlyHarnessMetadata(),
        workPackageIds: packages.map((pkg) => pkg.id),
        harnessIds: harnesses.map((harness) => harness.id),
        mcpExecutionStatus: input.prepared.mcpExecutionDesign.validation.status,
        mcpOperatorReviewRequired: (input.prepared.mcpExecutionDesign.proposed?.requirements.length ?? 0) > 0,
        mcpNormalizationErrors: [...(input.prepared.mcpExecutionDesign.proposed?.normalizationErrors ?? [])],
        mcpNormalizationEvidence: mcpNormalizationEvidence(input.prepared),
      },
    },
  }
}

export async function materializeWorkforceFromArchitectArtifact(
  input: WorkforceMaterializationInput,
): Promise<WorkforceMaterializationResult> {
  if (!isWorkforceMaterializationEnabled()) {
    return {
      status: 'disabled',
      harnessCount: 0,
      workPackageCount: 0,
      dependencyCount: 0,
      approvalGateCount: 0,
    }
  }

  const [activeAgents, taskProject] = await Promise.all([
    db
      .select({
        agentType: agentConfigs.agentType,
        displayName: agentConfigs.displayName,
      })
      .from(agentConfigs)
      .where(eq(agentConfigs.isActive, true)),
    db
      .select({
        id: projects.id,
        mcpConfig: projects.mcpConfig,
        rootBindingRevision: projects.rootBindingRevision,
      })
      .from(tasks)
      .innerJoin(projects, eq(tasks.projectId, projects.id))
      .where(eq(tasks.id, input.taskId))
      .limit(1)
      .then((rows) => rows[0] ?? null),
  ])
  const projectFilesystemDecision = taskProject
    ? await loadCurrentProjectFilesystemDecision(taskProject.id)
    : null
  const rows = buildWorkforceMaterializationRows(input, {
    activeAgents,
    projectMcpConfig: taskProject?.mcpConfig,
    projectFilesystemDecision,
    projectRootBindingRevision: taskProject?.rootBindingRevision,
  })
  if (rows.workPackages.length === 0) {
    throw new Error(
      'Architect plan did not produce any executable work packages. Assign at least one configured implementation, documentation, DevOps, Backend, Frontend, QA, Reviewer, or other specialist handoff agent; Architect and Security are planning/review gates, not executable handoff packages.' +
      plannedRoleSummary(input),
    )
  }

  // Guard against a concurrent operator stop (DELETE /api/tasks/:id). That route
  // updates the task row inside a transaction; taking a FOR UPDATE lock here
  // serializes the two so we either observe the pre-stop 'running' status (and
  // any rows we insert are cancelled by the route's own workPackages/gate
  // updates) or the committed 'cancelled' status (and we skip materialization
  // entirely). Without this, a stop landing mid-plan would leave a cancelled
  // task with freshly materialized pending work packages and an actionable
  // plan_approval gate.
  let cancelledDuringMaterialization = false
  await db.transaction(async (tx) => {
    const [taskRow] = await tx
      .select({ status: tasks.status })
      .from(tasks)
      .where(eq(tasks.id, input.taskId))
      .for('update')
    if (!taskRow || taskRow.status !== 'running') {
      cancelledDuringMaterialization = true
      return
    }
    await tx
      .delete(approvalGates)
      .where(
        and(
          eq(approvalGates.taskId, input.taskId),
          eq(approvalGates.gateType, 'plan_approval'),
          eq(approvalGates.status, 'pending'),
        ),
      )
    await tx
      .delete(workPackages)
      .where(and(
        eq(workPackages.taskId, input.taskId),
        or(
          eq(workPackages.status, 'pending'),
          and(
            eq(workPackages.status, 'failed'),
            sql`${workPackages.metadata}->>'requiresAgentConfiguration' = 'true'`,
          ),
        ),
      ))

    if (rows.harnesses.length > 0) {
      await tx
        .insert(agentHarnesses)
        .values(rows.harnesses)
        .onConflictDoUpdate({
          target: agentHarnesses.slug,
          set: {
            category: sql`excluded.category`,
            description: sql`excluded.description`,
            displayName: sql`excluded.display_name`,
            isActive: true,
            metadata: sql`excluded.metadata`,
            role: sql`excluded.role`,
            toolPolicy: sql`excluded.tool_policy`,
            updatedAt: new Date(),
          },
        })

      const harnessRows = await tx
        .select({ id: agentHarnesses.id, slug: agentHarnesses.slug })
        .from(agentHarnesses)
        .where(inArray(agentHarnesses.slug, rows.harnesses.map((harness) => harness.slug)))
      const harnessIdsBySlug = new Map(harnessRows.map((row) => [row.slug, row.id]))

      for (const pkg of rows.workPackages) {
        pkg.harnessId = harnessIdsBySlug.get(pkg.assignedRole) ?? pkg.harnessId
      }
    }

    if (rows.workPackages.length > 0) {
      await tx.insert(workPackages).values(rows.workPackages)
    }

    if (rows.dependencies.length > 0) {
      await tx.insert(workPackageDependencies).values(rows.dependencies)
    }

    await tx.insert(approvalGates).values(rows.approvalGate)
  })

  if (cancelledDuringMaterialization) {
    return {
      status: 'cancelled',
      harnessCount: 0,
      workPackageCount: 0,
      dependencyCount: 0,
      approvalGateCount: 0,
    }
  }

  return {
    status: 'materialized',
    harnessCount: rows.harnesses.length,
    workPackageCount: rows.workPackages.length,
    dependencyCount: rows.dependencies.length,
    approvalGateCount: 1,
  }
}
