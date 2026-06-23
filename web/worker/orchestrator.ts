import { streamText } from 'ai'
import type { LanguageModel } from 'ai'
import { db } from '../db'
import { agentConfigs, agentRuns, artifacts, projects, taskQuestions, tasks } from '../db/schema'
import { getProvider } from '../lib/providers/registry'
import { and, desc, eq } from 'drizzle-orm'
import { publishTaskEvent } from './events'
import { updateTaskStatus, updateTaskStatusIfCurrent } from './task-state'
import {
  buildSpecialistContext,
  buildWebResearchContext,
  detectSoftwareProfile,
} from './architect-context'
import { parseOpenQuestions, type OpenQuestion } from './open-questions'
import { parseAgentBreakdown } from './agent-breakdown'

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

export interface AnsweredQuestion {
  question: string
  answer: string
}

function buildArchitectPrompt(
  task: TaskRow,
  project: ProjectRow,
  specialistContext: string,
  webResearchContext: string,
  answeredQuestions: AnsweredQuestion[] = [],
  previousPlan: string | null = null,
): string {
  const answeredSection =
    answeredQuestions.length === 0
      ? []
      : [
          '',
          'The task originator has answered the open questions from your previous plan. Incorporate these answers and adjust the plan accordingly:',
          ...answeredQuestions.map((q) => `- Q: ${q.question}\n  A: ${q.answer}`),
        ]
  const previousPlanSection =
    previousPlan === null
      ? []
      : [
          '',
          'Previous implementation plan:',
          '```markdown',
          previousPlan,
          '```',
          '',
          'Revise the previous implementation plan in place. Preserve the same structure and any unaffected sections. Change only what the task revision, answered questions, or new context requires. The output should be the full revised plan, not a diff and not a brand-new unrelated plan.',
        ]

  return [
    `Project: ${project.name}`,
    `Repository: ${project.githubRepo ?? 'not configured'}`,
    `Local folder: ${project.localPath ?? 'not configured'}`,
    `Default branch: ${project.defaultBranch}`,
    '',
    `Task title: ${task.title}`,
    '',
    'Task prompt:',
    task.prompt,
    ...answeredSection,
    ...previousPlanSection,
    '',
    'Produce a concise implementation plan for this task. Write it in Markdown.',
    'Include: assumptions, the specific files/modules to inspect first, the chosen approach, task breakdown (handoffs), verification steps, and notable risks.',
    '',
    'Right-size the plan to the task:',
    '- Choose the simplest design that fully satisfies the stated requirements. Do not gold-plate.',
    '- Do NOT introduce new frameworks, libraries, or heavyweight patterns (global state managers like Redux, message queues, microservices, build-tool changes) unless the task genuinely requires them. If you add any dependency, justify it in one short line; otherwise prefer the platform/standard library and what the repo already uses.',
    '- Match the number of steps and agents to the scope. A small, self-contained task should produce a short plan and use only the agents it needs.',
    '',
    'Task breakdown rules:',
    '- Assign every implementation step to one of Forge\'s worker agents using its [Role] tag (e.g. "[Frontend] Build the task list component"). Never invent specialist titles.',
    '- Prefer concrete, repository-specific guidance: name the actual files, directories, or modules the implementer should create or change. If the repository or local folder above is configured, base your file references on it; if it is not, say so and keep paths illustrative.',
    '- After the Markdown plan, append a fenced code block tagged exactly `agent_breakdown_json` containing a single JSON object of the shape `{"agents":[{"role":"Frontend","tasks":2,"summary":"Build task page UI and state handling"}]}`. Derive this from the [Role] assignments in the task breakdown. Use an empty array only if the plan truly assigns no worker tasks.',
    '',
    'Open questions:',
    answeredQuestions.length === 0
      ? '- If anything is genuinely ambiguous and a wrong guess would be costly, list it as an open question instead of guessing. Otherwise make the most reasonable assumption and proceed — most tasks should have zero open questions.'
      : '- All previously open questions have been answered above. Only raise NEW open questions if the answers introduce fresh ambiguity; otherwise return an empty list.',
    '- After the agent breakdown block, append a fenced code block tagged exactly `open_questions_json` containing a single JSON object of the shape `{"questions":[{"question":"...","suggestions":["Option A","Option B"]}]}`.',
    '- Include 1-4 concise suggested answers for each open question, plus enough contrast that the user can choose quickly. If no suggestions are appropriate, use an empty suggestions array. Use an empty questions array when there are no open questions. This block is parsed by software — emit nothing else inside it.',
    '',
    specialistContext,
    '',
    webResearchContext,
    '',
    'Do not claim that code has been changed. This worker stage only creates the initial architecture artifact.',
  ].join('\n')
}

function mockArchitectPlan(task: TaskRow, project: ProjectRow): string {
  return [
    `Mock architect plan for ${task.title}`,
    '',
    `Project: ${project.name}`,
    `Repository: ${project.githubRepo ?? 'not configured'}`,
    '',
    'Assumptions:',
    '- This output was generated by FORGE_WORKER_MOCK_ARCHITECT for smoke testing.',
    '',
    'Implementation steps:',
    '- [Backend] Verify provider routing and task lifecycle wiring.',
    '- [Backend] Persist the planning artifact and move the task to awaiting approval.',
    '',
    'Verification steps:',
    '- Confirm the task detail page shows the agent run and artifact.',
    '- Approve the generated plan and confirm the Orchestrator stage completes.',
    '',
    '```agent_breakdown_json',
    '{"agents":[{"role":"Backend","tasks":2,"summary":"Verify worker routing and persisted planning artifacts"}]}',
    '```',
    '',
    '```open_questions_json',
    '{"questions": []}',
    '```',
  ].join('\n')
}

async function loadLatestPlanArtifact(taskId: string): Promise<string | null> {
  const [artifact] = await db
    .select({ content: artifacts.content })
    .from(artifacts)
    .innerJoin(agentRuns, eq(artifacts.agentRunId, agentRuns.id))
    .where(and(eq(agentRuns.taskId, taskId), eq(artifacts.artifactType, 'adr_text')))
    .orderBy(desc(artifacts.createdAt))
    .limit(1)

  return artifact?.content ?? null
}

async function createArtifact(
  taskId: string,
  agentRunId: string,
  content: string,
  metadataExtra: Record<string, unknown> = {},
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
        ...metadataExtra,
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

/**
 * Persists the open questions extracted from an architect run, replacing any
 * previously stored questions for the task. Suggested answers are optional and
 * stored with each question. Returns the number of open questions persisted.
 */
async function persistOpenQuestions(taskId: string, questions: OpenQuestion[]): Promise<number> {
  // Clear any prior questions from an earlier architect run for this task —
  // each run represents the current/latest plan, so stale questions from a
  // previous round should not linger.
  await db.delete(taskQuestions).where(eq(taskQuestions.taskId, taskId))

  if (questions.length === 0) return 0

  const rows = await db
    .insert(taskQuestions)
    .values(
      questions.map((question) => ({
        taskId,
        question: question.question,
        suggestions: question.suggestions,
        status: 'open' as const,
      })),
    )
    .returning()

  await publishTaskEvent(taskId, 'questions:created', {
    questions: rows.map((row) => ({
      id: row.id,
      question: row.question,
      suggestions: row.suggestions,
      status: row.status,
    })),
  })

  return rows.length
}

async function runArchitect(
  task: TaskRow,
  project: ProjectRow,
  answeredQuestions: AnsweredQuestion[] = [],
): Promise<{ openQuestionCount: number }> {
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
  const previousPlan = await loadLatestPlanArtifact(task.id)
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
    let text = ''
    let usage = { inputTokens: 0, outputTokens: 0 }

    if (process.env.FORGE_WORKER_MOCK_ARCHITECT === '1') {
      text = mockArchitectPlan(task, project)
      await publishTaskEvent(task.id, 'run:chunk', {
        runId: run.id,
        delta: text,
      })
    } else {
      const profile = detectSoftwareProfile(task, project)
      const [specialistContext, webResearchContext] = await Promise.all([
        Promise.resolve(buildSpecialistContext(profile)),
        buildWebResearchContext(profile, task),
      ])
      const result = streamText({
        model,
        system: config.systemPrompt,
        prompt: buildArchitectPrompt(
          task,
          project,
          specialistContext,
          webResearchContext,
          answeredQuestions,
          previousPlan,
        ),
        temperature: 0.2,
      })

      for await (const delta of result.textStream) {
        text += delta
        await publishTaskEvent(task.id, 'run:chunk', {
          runId: run.id,
          delta,
        })
      }

      const streamUsage = await result.usage
      usage = {
        inputTokens: streamUsage.inputTokens ?? 0,
        outputTokens: streamUsage.outputTokens ?? 0,
      }
    }

    const { planText: planWithoutQuestions, questions } = parseOpenQuestions(text)
    const { planText, agents } = parseAgentBreakdown(planWithoutQuestions)
    await createArtifact(task.id, run.id, planText, {
      openQuestionCount: questions.length,
      revisedFromAnswers: answeredQuestions.length > 0,
      revisedFromPlan: previousPlan !== null,
      agentBreakdown: agents,
    })
    const openQuestionCount = await persistOpenQuestions(task.id, questions)

    const completedAt = new Date()
    await db
      .update(agentRuns)
      .set({
        status: 'completed',
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        completedAt,
      })
      .where(eq(agentRuns.id, run.id))

    await publishTaskEvent(task.id, 'run:completed', {
      runId: run.id,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      costUsd: null,
      completedAt: completedAt.toISOString(),
    })

    return { openQuestionCount }
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

export async function processTask(
  taskId: string,
  options: { finalAttempt?: boolean } = {},
): Promise<void> {
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
    const claimed = await updateTaskStatusIfCurrent(task.id, 'pending', 'running')
    if (!claimed) {
      console.info('[worker/orchestrator] Skipping task that was claimed by another worker', {
        taskId,
      })
      return
    }

    const { openQuestionCount } = await runArchitect(task, project)

    if (await isTaskCancelled(task.id)) {
      return
    }

    await updateTaskStatus(task.id, openQuestionCount > 0 ? 'awaiting_answers' : 'awaiting_approval')
  } catch (err) {
    const message = errorMessage(err)
    if (options.finalAttempt ?? true) {
      await updateTaskStatus(task.id, 'failed', message)
    } else if (!(await isTaskCancelled(task.id))) {
      await updateTaskStatus(task.id, 'pending', `Retrying after error: ${message}`)
    }
    throw err
  }
}

/**
 * Re-runs the architect once every open question for a task has been
 * answered, appending the Q&A pairs to the prompt context. Produces an
 * adjusted plan and moves the task to `awaiting_approval` (or back to
 * `awaiting_answers` if the adjusted plan raises new questions).
 *
 * Called by the questions API route once the last open question is
 * answered. Idempotent: skips tasks that are not currently
 * `awaiting_answers`, or that still have unanswered questions.
 */
export async function processAnsweredQuestions(taskId: string): Promise<void> {
  const context = await loadTaskContext(taskId)
  if (!context) {
    console.warn('[worker/orchestrator] Task not found', { taskId })
    return
  }

  const { task, project } = context
  if (task.status !== 'awaiting_answers') {
    console.info('[worker/orchestrator] Skipping re-plan for task with non-awaiting_answers status', {
      taskId,
      status: task.status,
    })
    return
  }

  const existingQuestions = await db
    .select()
    .from(taskQuestions)
    .where(eq(taskQuestions.taskId, taskId))

  const unanswered = existingQuestions.filter((q) => q.status !== 'answered')
  if (unanswered.length > 0) {
    console.info('[worker/orchestrator] Skipping re-plan; questions still unanswered', {
      taskId,
      unanswered: unanswered.length,
    })
    return
  }

  const claimed = await updateTaskStatusIfCurrent(taskId, 'awaiting_answers', 'running')
  if (!claimed) {
    console.info('[worker/orchestrator] Skipping re-plan claimed by another worker', { taskId })
    return
  }

  try {
    const answeredQuestions: AnsweredQuestion[] = existingQuestions.map((q) => ({
      question: q.question,
      answer: q.answer ?? '',
    }))

    const { openQuestionCount } = await runArchitect(task, project, answeredQuestions)

    if (await isTaskCancelled(taskId)) {
      return
    }

    await updateTaskStatus(taskId, openQuestionCount > 0 ? 'awaiting_answers' : 'awaiting_approval')
  } catch (err) {
    const message = errorMessage(err)
    await updateTaskStatus(taskId, 'failed', message)
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

  const completed = await updateTaskStatusIfCurrent(taskId, 'approved', 'completed')
  if (!completed) {
    console.info('[worker/orchestrator] Skipping approval that was changed by another actor', {
      taskId,
    })
  }
}
