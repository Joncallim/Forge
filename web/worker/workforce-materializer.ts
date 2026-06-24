import { randomUUID } from 'crypto'
import { and, eq, inArray } from 'drizzle-orm'
import { db } from '../db'
import {
  agentHarnesses,
  approvalGates,
  workPackageDependencies,
  workPackages,
} from '../db/schema'
import type { PreparedArchitectArtifact } from './architect-artifact'

type JsonObject = Record<string, unknown>
type AgentHarnessInsert = typeof agentHarnesses.$inferInsert & { id: string; slug: string; role: string }
type WorkPackageInsert = typeof workPackages.$inferInsert & { id: string; assignedRole: string }

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
}

export type WorkforceMaterializationResult = {
  status: 'materialized' | 'disabled'
  harnessCount: number
  workPackageCount: number
  dependencyCount: number
  approvalGateCount: number
}

type BuildOptions = {
  idFactory?: () => string
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

function displayNameForSlug(slug: string): string {
  return slug
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function titleForAgent(role: string): string {
  const trimmed = role.trim()
  return trimmed === '' ? 'Specialist work package' : `${trimmed} work package`
}

function mcpGrantsForAgent(prepared: PreparedArchitectArtifact, agentType: string): JsonObject[] {
  return prepared.mcpExecutionDesign.grantDecisions.decisions
    .filter((decision) => normalizeAgentType(decision.agent) === agentType)
    .map((decision) => ({
      decisionId: decision.decisionId,
      mcpId: decision.mcpId,
      capabilities: decision.capabilities,
      requirement: decision.requirement,
      status: decision.status,
      reason: decision.reason,
      fallback: decision.fallback,
      health: decision.health,
    }))
}

function mcpRequirementsForAgent(prepared: PreparedArchitectArtifact, agentType: string): JsonObject[] {
  const design = prepared.mcpExecutionDesign.proposed
  if (!design) return []

  return design.requirements
    .filter((requirement) => {
      const targetAgents = requirement.assignment.targetAgents.map(normalizeAgentType)
      const permissionAgents = Object.keys(requirement.agentPermissions).map(normalizeAgentType)
      return targetAgents.includes(agentType) || permissionAgents.includes(agentType)
    })
    .map((requirement) => ({
      mcpId: requirement.mcpId,
      requirement: requirement.requirement,
      reason: requirement.reason,
      assignment: requirement.assignment,
      permissions: requirement.agentPermissions[agentType] ?? [],
      prohibitedCapabilities: requirement.prohibitedCapabilities,
      fallback: requirement.fallback,
    }))
}

function mcpSubtasksForAgent(prepared: PreparedArchitectArtifact, agentType: string): JsonObject[] {
  const design = prepared.mcpExecutionDesign.proposed
  if (!design) return []

  return design.mcpAwareSubtasks
    .filter((subtask) => normalizeAgentType(subtask.agent) === agentType)
    .map((subtask) => ({
      id: subtask.id,
      dependsOn: subtask.dependsOn,
      mcpCapabilities: subtask.mcpCapabilities,
      inputs: subtask.inputs,
      outputs: subtask.outputs,
      verification: subtask.verification,
      stoppingCondition: subtask.stoppingCondition,
      fallback: subtask.fallback,
    }))
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
    const agentType = normalizeAgentType(agent.role)
    if (agentType === '' || agentType === 'architect') return

    const harnessId = idFactory()
    const workPackageId = idFactory()
    const mcpRequirements = mcpRequirementsForAgent(input.prepared, agentType)
    const mcpSubtasks = mcpSubtasksForAgent(input.prepared, agentType)
    const promptOverlay = input.prepared.mcpExecutionDesign.proposed?.promptOverlays[agentType] ?? null

    harnesses.push({
      id: harnessId,
      slug: agentType,
      role: agentType,
      displayName: agent.role || displayNameForSlug(agentType),
      category: agentType,
      description: `${agent.role || displayNameForSlug(agentType)} harness seeded from Architect workforce planning.`,
      systemPrompt: promptOverlay ?? '',
      toolPolicy: {
        mcpGrants: mcpGrantsForAgent(input.prepared, agentType),
      },
      referencePaths: [],
      outputSchema: {},
      validationChecks: [],
      isActive: true,
      metadata: {
        source: 'workforce-materializer',
        seededFromTaskId: input.taskId,
      },
    })

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
        required: input.prepared.capabilityClassification.proposed.required,
        optional: input.prepared.capabilityClassification.proposed.optional,
      },
      acceptanceCriteria: agent.steps.length > 0 ? agent.steps : [agent.summary || titleForAgent(agent.role)],
      mcpRequirements,
      metadata: {
        source: 'architect-artifact',
        architectRunId: input.architectRunId,
        artifactId: input.artifactId,
        plannedTasks: agent.tasks,
        mcpAwareSubtasks: mcpSubtasks,
      },
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
        workPackageIds: packages.map((pkg) => pkg.id),
        harnessIds: harnesses.map((harness) => harness.id),
        mcpExecutionStatus: input.prepared.mcpExecutionDesign.validation.status,
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

  const rows = buildWorkforceMaterializationRows(input)

  await db.transaction(async (tx) => {
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
      .where(and(eq(workPackages.taskId, input.taskId), eq(workPackages.status, 'pending')))

    if (rows.harnesses.length > 0) {
      await tx
        .insert(agentHarnesses)
        .values(rows.harnesses)
        .onConflictDoNothing({ target: agentHarnesses.slug })

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

  return {
    status: 'materialized',
    harnessCount: rows.harnesses.length,
    workPackageCount: rows.workPackages.length,
    dependencyCount: rows.dependencies.length,
    approvalGateCount: 1,
  }
}
