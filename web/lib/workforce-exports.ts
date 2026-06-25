import fs from 'node:fs/promises'
import path from 'node:path'
import { asc, eq } from 'drizzle-orm'
import { db } from '@/db'
import { agentConfigs, workforceAgents, workforces } from '@/db/schema'
import { writeWorkspaceFileAtomically } from '@/lib/agent-prompts'
import { getWorkspaceSettings, isWithinPath } from '@/lib/workspace'

type WorkforceRow = typeof workforces.$inferSelect

type WorkforceMemberExport = {
  id: string
  workforceId: string
  agentConfigId: string
  roleLabel: string | null
  sequence: number
  isRequired: boolean
  metadata: Record<string, unknown>
  agentType: string
  displayName: string
  description: string
  isActive: boolean
}

type WorkforceExport = WorkforceRow & {
  members: WorkforceMemberExport[]
}

const WORKFORCE_SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}[a-z0-9]$/

function jsonStringify(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

function safeMetadata(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function promptPathForAgent(agentType: string): string {
  return `../prompts/agents/${agentType}.toml`
}

function assertSafeWorkforceSlug(slug: string): void {
  if (!WORKFORCE_SLUG_PATTERN.test(slug)) {
    throw new Error(`Unsafe workforce slug for filesystem export: ${slug}`)
  }
}

function workforceExportRoot(workforcesRoot: string, slug: string): string {
  assertSafeWorkforceSlug(slug)
  const root = path.resolve(workforcesRoot, slug)
  if (!isWithinPath(workforcesRoot, root) || root === path.resolve(workforcesRoot)) {
    throw new Error(`Workforce export path escaped workspace root: ${slug}`)
  }
  return root
}

function managerPrompt(workforce: WorkforceExport): string {
  const metadata = safeMetadata(workforce.metadata)
  if (typeof metadata.managerPrompt === 'string' && metadata.managerPrompt.trim()) {
    return `${metadata.managerPrompt.trim()}\n`
  }

  const members = workforce.members
    .slice()
    .sort((a, b) => a.sequence - b.sequence || a.agentType.localeCompare(b.agentType))
    .map((member) => `- ${member.roleLabel || member.displayName}: ${member.agentType}`)
    .join('\n')

  return [
    `You are the workforce manager for ${workforce.displayName}.`,
    '',
    'Route work to the listed agents in sequence, collect their outputs, and escalate blockers, failed checks, and security-sensitive decisions to the project manager.',
    '',
    'Agents:',
    members || '- No agents assigned.',
    '',
  ].join('\n')
}

function workflow(workforce: WorkforceExport): Record<string, unknown> {
  const metadata = safeMetadata(workforce.metadata)
  if (metadata.workflow && typeof metadata.workflow === 'object' && !Array.isArray(metadata.workflow)) {
    return metadata.workflow as Record<string, unknown>
  }

  const orderedMembers = workforce.members
    .slice()
    .sort((a, b) => a.sequence - b.sequence || a.agentType.localeCompare(b.agentType))
  const steps = orderedMembers
    .map((member, index) => ({
      id: `${index + 1}-${member.agentType}`,
      agentType: member.agentType,
      roleLabel: member.roleLabel,
      required: member.isRequired,
      dependsOn: index === 0 ? [] : [`${index}-${orderedMembers[index - 1].agentType}`],
    }))

  return {
    schemaVersion: 1,
    mode: 'sequential',
    approvalGates: ['pm-final-review'],
    steps,
  }
}

export async function loadWorkforcesForExport(): Promise<WorkforceExport[]> {
  const [workforceRows, memberRows] = await Promise.all([
    db.select().from(workforces).orderBy(asc(workforces.displayName)),
    db
      .select({
        id: workforceAgents.id,
        workforceId: workforceAgents.workforceId,
        agentConfigId: workforceAgents.agentConfigId,
        roleLabel: workforceAgents.roleLabel,
        sequence: workforceAgents.sequence,
        isRequired: workforceAgents.isRequired,
        metadata: workforceAgents.metadata,
        agentType: agentConfigs.agentType,
        displayName: agentConfigs.displayName,
        description: agentConfigs.description,
        isActive: agentConfigs.isActive,
      })
      .from(workforceAgents)
      .innerJoin(agentConfigs, eq(workforceAgents.agentConfigId, agentConfigs.id))
      .orderBy(asc(workforceAgents.sequence), asc(agentConfigs.agentType)),
  ])

  const membersByWorkforce = new Map<string, WorkforceMemberExport[]>()
  for (const member of memberRows) {
    const existing = membersByWorkforce.get(member.workforceId) ?? []
    existing.push({
      ...member,
      metadata: safeMetadata(member.metadata),
    })
    membersByWorkforce.set(member.workforceId, existing)
  }

  return workforceRows.map((workforce) => ({
    ...workforce,
    metadata: safeMetadata(workforce.metadata),
    members: membersByWorkforce.get(workforce.id) ?? [],
  }))
}

export async function exportWorkforcesToWorkspace(
  workforceRows?: WorkforceExport[],
): Promise<void> {
  const rows = workforceRows ?? await loadWorkforcesForExport()
  const workspace = await getWorkspaceSettings()
  for (const workforce of rows) {
    assertSafeWorkforceSlug(workforce.slug)
  }
  await fs.mkdir(workspace.workforcesRoot, { recursive: true })

  const agents = new Map<string, {
    agentType: string
    displayName: string
    description: string
    isActive: boolean
    promptPath: string
  }>()

  for (const workforce of rows) {
    for (const member of workforce.members) {
      agents.set(member.agentType, {
        agentType: member.agentType,
        displayName: member.displayName,
        description: member.description,
        isActive: member.isActive,
        promptPath: promptPathForAgent(member.agentType),
      })
    }
  }

  await writeWorkspaceFileAtomically(
    path.join(workspace.workforcesRoot, 'agents.json'),
    jsonStringify({
      schemaVersion: 1,
      agents: Array.from(agents.values()).sort((a, b) => a.agentType.localeCompare(b.agentType)),
    }),
    workspace.workspaceRoot,
  )

  await writeWorkspaceFileAtomically(
    path.join(workspace.workforcesRoot, 'index.json'),
    jsonStringify({
      schemaVersion: 1,
      workforces: rows.map((workforce) => ({
        slug: workforce.slug,
        displayName: workforce.displayName,
        description: workforce.description,
        isDefault: workforce.isDefault,
        isActive: workforce.isActive,
        memberCount: workforce.members.length,
        paths: {
          workforce: `${workforce.slug}/workforce.json`,
          workflow: `${workforce.slug}/workflow.json`,
          managerPrompt: `${workforce.slug}/manager-prompt.md`,
        },
      })),
    }),
    workspace.workspaceRoot,
  )

  for (const workforce of rows) {
    const workforceRoot = workforceExportRoot(workspace.workforcesRoot, workforce.slug)
    await fs.mkdir(workforceRoot, { recursive: true })
    await writeWorkspaceFileAtomically(
      path.join(workforceRoot, 'workforce.json'),
      jsonStringify({
        schemaVersion: 1,
        id: workforce.id,
        slug: workforce.slug,
        displayName: workforce.displayName,
        description: workforce.description,
        isDefault: workforce.isDefault,
        isActive: workforce.isActive,
        metadata: workforce.metadata,
        members: workforce.members
          .slice()
          .sort((a, b) => a.sequence - b.sequence || a.agentType.localeCompare(b.agentType))
          .map((member) => ({
            agentType: member.agentType,
            agentConfigId: member.agentConfigId,
            roleLabel: member.roleLabel,
            sequence: member.sequence,
            isRequired: member.isRequired,
            promptPath: promptPathForAgent(member.agentType),
          })),
      }),
      workspace.workspaceRoot,
    )

    await writeWorkspaceFileAtomically(
      path.join(workforceRoot, 'workflow.json'),
      jsonStringify(workflow(workforce)),
      workspace.workspaceRoot,
    )
    await writeWorkspaceFileAtomically(
      path.join(workforceRoot, 'manager-prompt.md'),
      managerPrompt(workforce),
      workspace.workspaceRoot,
    )
  }
}
