import { constants } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { getWorkspaceSettings, type WorkspaceSettings } from '../lib/workspace'
import type { TaskStatus } from './task-state'

export const DEFAULT_ARCHITECT_RESUME_CHECKPOINT_MAX_BYTES = 12_000

type CheckpointKind = 'architect-success' | 'architect-failure' | 'architect-replan'
type RunStatus = 'completed' | 'failed'

type CheckpointTask = {
  id: string
  title: string
}

type CheckpointProject = {
  id: string
  name: string
  githubRepo: string | null
  localPath: string | null
  defaultBranch: string
}

type CheckpointRun = {
  id: string
  agentType: string
  modelIdUsed: string
  startedAt: Date | null
  completedAt: Date | null
}

export type ArchitectCheckpointInput = {
  task: CheckpointTask
  project: CheckpointProject
  run: CheckpointRun
  checkpointKind: CheckpointKind
  runStatus: RunStatus
  taskStatus: TaskStatus
  artifactId?: string
  openQuestionCount: number
  openQuestions: string[]
  revisedFromAnswers: boolean
  revisedFromPlan: boolean
  planText?: string
  errorMessage?: string
  partialOutput?: string
  createdAt?: Date
}

export type CheckpointWriteResult = {
  runPath: string
  latestPath: string
}

export type ArchitectResumeCheckpoint = {
  taskId: string
  latestPath: string
  markdown: string
  originalBytes: number
  maxBytes: number
  truncated: boolean
  loadedAt: Date
}

function safePathSegment(segment: string): string {
  return segment.replace(/[^A-Za-z0-9._-]/g, '_')
}

export function taskCheckpointDirectory(workspace: WorkspaceSettings, taskId: string): string {
  return path.join(
    /*turbopackIgnore: true*/ workspace.checkpointsRoot,
    'tasks',
    safePathSegment(taskId),
  )
}

export function architectCheckpointPaths(
  workspace: WorkspaceSettings,
  taskId: string,
  agentRunId: string,
): CheckpointWriteResult {
  const taskDir = taskCheckpointDirectory(workspace, taskId)
  return {
    runPath: path.join(/*turbopackIgnore: true*/ taskDir, 'runs', `${safePathSegment(agentRunId)}.md`),
    latestPath: path.join(/*turbopackIgnore: true*/ taskDir, 'latest.md'),
  }
}

function yamlValue(value: string | number | boolean | null): string {
  if (typeof value === 'string') return JSON.stringify(value)
  if (value === null) return 'null'
  return String(value)
}

function frontmatter(input: ArchitectCheckpointInput, workspace: WorkspaceSettings, createdAt: Date): string {
  const entries: [string, string | number | boolean | null][] = [
    ['schemaVersion', 1],
    ['taskId', input.task.id],
    ['projectId', input.project.id],
    ['agentRunId', input.run.id],
    ['agentType', input.run.agentType],
    ['status', input.runStatus],
    ['taskStatus', input.taskStatus],
    ['checkpointKind', input.checkpointKind],
    ['createdAt', createdAt.toISOString()],
    ['workspaceRoot', workspace.workspaceRoot],
    ['projectLocalPath', input.project.localPath],
    ['artifactId', input.artifactId ?? null],
    ['openQuestionCount', input.openQuestionCount],
    ['revisedFromAnswers', input.revisedFromAnswers],
    ['revisedFromPlan', input.revisedFromPlan],
  ]

  return ['---', ...entries.map(([key, value]) => `${key}: ${yamlValue(value)}`), '---'].join('\n')
}

function singleLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function renderOpenQuestions(questions: string[]): string {
  if (questions.length === 0) return 'None'
  return questions.map((question) => `- ${singleLine(question)}`).join('\n')
}

function renderOptionalSection(title: string, value: string | undefined): string[] {
  if (!value?.trim()) return []
  return ['', `## ${title}`, '', value.trim()]
}

export function renderArchitectCheckpoint(
  input: ArchitectCheckpointInput,
  workspace: WorkspaceSettings,
): string {
  const createdAt = input.createdAt ?? new Date()
  const planText = input.planText?.trim() || 'No plan artifact was produced before this checkpoint.'
  const summary = input.runStatus === 'failed'
    ? 'The Architect run failed. Resume by inspecting the failure details and rerunning the task once the root cause is fixed.'
    : input.openQuestionCount > 0
      ? 'The Architect run completed and is waiting for human answers before continuation.'
      : 'The Architect run completed and produced a plan ready for approval.'

  return [
    frontmatter(input, workspace, createdAt),
    '',
    '# Forge Checkpoint',
    '',
    '## Task',
    '',
    `- Title: ${singleLine(input.task.title)}`,
    `- Status after checkpoint: ${input.taskStatus}`,
    `- Project: ${singleLine(input.project.name)}`,
    `- Repository: ${input.project.githubRepo ?? 'not configured'}`,
    `- Default branch: ${input.project.defaultBranch}`,
    '',
    '## Agent Run',
    '',
    `- Agent: ${input.run.agentType}`,
    `- Model: ${input.run.modelIdUsed}`,
    `- Started: ${input.run.startedAt?.toISOString() ?? 'unknown'}`,
    `- Completed: ${input.run.completedAt?.toISOString() ?? 'unknown'}`,
    '',
    '## Continuation Summary',
    '',
    summary,
    '',
    '## Plan Artifact',
    '',
    planText,
    '',
    '## Open Questions',
    '',
    renderOpenQuestions(input.openQuestions),
    ...renderOptionalSection('Failure', input.errorMessage),
    ...renderOptionalSection('Partial Output', input.partialOutput),
    '',
  ].join('\n')
}

async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  const dir = path.dirname(filePath)
  await fs.mkdir(dir, { recursive: true })
  const tempPath = path.join(
    /*turbopackIgnore: true*/ dir,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  )
  await fs.writeFile(tempPath, content, { mode: 0o600 })
  await fs.rename(tempPath, filePath)
}

export async function writeArchitectCheckpoint(
  input: ArchitectCheckpointInput,
): Promise<CheckpointWriteResult> {
  const workspace = await getWorkspaceSettings()
  const paths = architectCheckpointPaths(workspace, input.task.id, input.run.id)
  const content = renderArchitectCheckpoint(input, workspace)

  await writeFileAtomic(paths.runPath, content)
  await writeFileAtomic(paths.latestPath, content)

  return paths
}

export async function writeArchitectCheckpointSafely(
  input: ArchitectCheckpointInput,
): Promise<CheckpointWriteResult | null> {
  try {
    return await writeArchitectCheckpoint(input)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.warn('[worker/checkpoints] Failed to write Architect checkpoint', {
      taskId: input.task.id,
      agentRunId: input.run.id,
      checkpointKind: input.checkpointKind,
      error: message,
    })
    return null
  }
}

export async function readLatestArchitectCheckpointSafely(
  taskId: string,
  options: { maxBytes?: number } = {},
): Promise<ArchitectResumeCheckpoint | null> {
  const maxBytes = options.maxBytes ?? DEFAULT_ARCHITECT_RESUME_CHECKPOINT_MAX_BYTES
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
    console.warn('[worker/checkpoints] Invalid Architect checkpoint read limit', {
      taskId,
      maxBytes,
    })
    return null
  }

  let latestPath = ''
  try {
    const workspace = await getWorkspaceSettings()
    latestPath = architectCheckpointPaths(workspace, taskId, 'latest').latestPath
    const taskDir = taskCheckpointDirectory(workspace, taskId)
    const checkpointRoot = await fs.realpath(workspace.checkpointsRoot)
    const realTaskDir = await fs.realpath(taskDir)
    const taskDirRelative = path.relative(checkpointRoot, realTaskDir)
    if (taskDirRelative.startsWith('..') || path.isAbsolute(taskDirRelative)) return null

    const stat = await fs.lstat(latestPath)
    if (!stat.isFile() || stat.isSymbolicLink()) return null

    const noFollowFlag = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
    const handle = await fs.open(/*turbopackIgnore: true*/ latestPath, noFollowFlag)
    try {
      const openedStat = await handle.stat()
      if (!openedStat.isFile()) return null
      const readLength = Math.min(openedStat.size, maxBytes)
      const buffer = Buffer.alloc(readLength)
      const { bytesRead } = await handle.read(buffer, 0, readLength, 0)
      return {
        taskId,
        latestPath,
        markdown: buffer.subarray(0, bytesRead).toString('utf-8'),
        originalBytes: openedStat.size,
        maxBytes,
        truncated: openedStat.size > maxBytes,
        loadedAt: new Date(),
      }
    } finally {
      await handle.close()
    }
  } catch (err) {
    const code = typeof err === 'object' && err !== null && 'code' in err ? (err as { code?: unknown }).code : null
    if (code !== 'ENOENT') {
      const message = err instanceof Error ? err.message : String(err)
      console.warn('[worker/checkpoints] Failed to read Architect resume checkpoint', {
        taskId,
        latestPath: latestPath || null,
        error: message,
      })
    }
    return null
  }
}
