import { generateText } from 'ai'
import type { LanguageModel } from 'ai'
import { db } from '../db'
import { agentConfigs, agentRuns, artifacts, projects, tasks } from '../db/schema'
import { getProvider } from '../lib/providers/registry'
import { and, eq } from 'drizzle-orm'
import { publishTaskEvent } from './events'
import { updateTaskStatus } from './task-state'

type TaskRow = typeof tasks.$inferSelect
type ProjectRow = typeof projects.$inferSelect
type AgentConfigRow = typeof agentConfigs.$inferSelect

const ARCHITECT_AGENT = 'architect'

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

async function loadTaskContext(taskId: string): Promise<{ task: TaskRow; project: ProjectRow } | null> {
  const [row] = await db
    .select({
      task: tasks,
      project: projects,
    })
    .from(tasks)
    .innerJoin(projects, eq(tasks.projectId, projects.id))
    .where(eq(tasks.id, taskId))
    .limit(1)

  return row ?? null
}

async function loadAgentConfig(agentType: string): Promise<AgentConfigRow | null> {
  const [config] = await db
    .select()
    .from(agentConfigs)
    .where(eq(agentConfigs.agentType, agentType))
    .limit(1)

  return config ?? null
}

async function isTaskCancelled(taskId: string): Promise<boolean> {
  const [task] = await db
    .select({ status: tasks.status })
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.status, 'cancelled')))
    .limit(1)

  return task !== undefined
}

function buildArchitectPrompt(task: TaskRow, project: ProjectRow): string {
  return [
    `Project: ${project.name}`,
    `Repository: ${project.githubRepo ?? 'not configured'}`,
    `Default branch: ${project.defaultBranch}`,
    '',
    `Task title: ${task.title}`,
    '',
    'Task prompt:',
    task.prompt,
    '',
    'Produce a concise implementation plan for this task.',
    'Include assumptions, recommended files/modules to inspect, implementation steps, verification steps, and notable risks.',
    'Do not claim that code has been changed. This worker stage only creates the initial architecture artifact.',
  ].join('\n')
}

async function createArtifact(
  taskId: string,
  agentRunId: string,
  content: string,
): Promise<void> {
  const [artifact] = await db
    .insert(artifacts)
    .values({
      agentRunId,
      artifactType: 'adr_text',
      content,
      metadata: {
        stage: 'architect_plan',
        generatedBy: 'forge-worker',
      },
    })
    .returning()

  await publishTaskEvent(taskId, 'artifact:created', {
    id: artifact.id,
    artifactId: artifact.id,
    agentRunId,
    artifactType: artifact.artifactType,
    content: artifact.content,
    metadata: artifact.metadata,
  })
}

async function runArchitect(task: TaskRow, project: ProjectRow): Promise<void> {
  const config = await loadAgentConfig(ARCHITECT_AGENT)
  if (!config) {
    throw new Error('Architect agent config is missing')
  }

  const providerConfigId = config.providerConfigId ?? task.pmProviderConfigId
  if (!providerConfigId) {
    throw new Error('Architect agent has no provider configured')
  }

  const providerResult = await getProvider(providerConfigId)
  if (!providerResult) {
    throw new Error(`Provider config ${providerConfigId} is missing or inactive`)
  }

  const model = (providerResult.provider as (modelId: string) => LanguageModel)(
    providerResult.config.modelId,
  )
  const startedAt = new Date()
  const [run] = await db
    .insert(agentRuns)
    .values({
      taskId: task.id,
      agentType: ARCHITECT_AGENT,
      providerConfigId,
      modelIdUsed: providerResult.config.modelId,
      status: 'running',
      startedAt,
    })
    .returning()

  await publishTaskEvent(task.id, 'run:started', {
    runId: run.id,
    agentType: ARCHITECT_AGENT,
    modelIdUsed: providerResult.config.modelId,
    startedAt: startedAt.toISOString(),
  })

  try {
    const result = await generateText({
      model,
      system: config.systemPrompt,
      prompt: buildArchitectPrompt(task, project),
      temperature: 0.2,
    })

    await publishTaskEvent(task.id, 'run:chunk', {
      runId: run.id,
      delta: result.text,
    })

    await createArtifact(task.id, run.id, result.text)

    const completedAt = new Date()
    await db
      .update(agentRuns)
      .set({
        status: 'completed',
        inputTokens: result.usage.inputTokens ?? null,
        outputTokens: result.usage.outputTokens ?? null,
        completedAt,
      })
      .where(eq(agentRuns.id, run.id))

    await publishTaskEvent(task.id, 'run:completed', {
      runId: run.id,
      inputTokens: result.usage.inputTokens ?? null,
      outputTokens: result.usage.outputTokens ?? null,
      costUsd: null,
      completedAt: completedAt.toISOString(),
    })
  } catch (err) {
    const message = errorMessage(err)
    const completedAt = new Date()

    await db
      .update(agentRuns)
      .set({
        status: 'failed',
        errorMessage: message,
        completedAt,
      })
      .where(eq(agentRuns.id, run.id))

    await publishTaskEvent(task.id, 'run:failed', {
      runId: run.id,
      errorMessage: message,
      completedAt: completedAt.toISOString(),
    })

    throw err
  }
}

export async function processTask(taskId: string): Promise<void> {
  const context = await loadTaskContext(taskId)
  if (!context) {
    console.warn('[worker/orchestrator] Task not found', { taskId })
    return
  }

  const { task, project } = context
  if (task.status !== 'pending') {
    console.info('[worker/orchestrator] Skipping task with non-pending status', {
      taskId,
      status: task.status,
    })
    return
  }

  try {
    await updateTaskStatus(task.id, 'running')
    await runArchitect(task, project)

    if (await isTaskCancelled(task.id)) {
      return
    }

    await updateTaskStatus(task.id, 'awaiting_approval')
  } catch (err) {
    const message = errorMessage(err)
    await updateTaskStatus(task.id, 'failed', message)
    throw err
  }
}

export async function processApproval(taskId: string): Promise<void> {
  const [task] = await db
    .select({ status: tasks.status })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .limit(1)

  if (!task) {
    console.warn('[worker/orchestrator] Approval target task not found', { taskId })
    return
  }

  if (task.status !== 'approved') {
    console.info('[worker/orchestrator] Skipping approval with non-approved status', {
      taskId,
      status: task.status,
    })
    return
  }

  await updateTaskStatus(taskId, 'completed')
}
