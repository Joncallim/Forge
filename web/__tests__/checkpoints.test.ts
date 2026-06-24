import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceSettings } from '@/lib/workspace'
import {
  architectCheckpointPaths,
  renderArchitectCheckpoint,
  taskCheckpointDirectory,
  writeArchitectCheckpoint,
  writeArchitectCheckpointSafely,
  type ArchitectCheckpointInput,
} from '@/worker/checkpoints'

const previousWorkspaceRoot = process.env.FORGE_WORKSPACE_ROOT

function workspace(root: string): WorkspaceSettings {
  return {
    workspaceRoot: root,
    projectsRoot: path.join(root, 'projects'),
    mcpsRoot: path.join(root, 'mcps'),
    templatesRoot: path.join(root, 'templates'),
    localMemoryRoot: path.join(root, 'local-memory'),
    checkpointsRoot: path.join(root, 'local-memory', 'checkpoints'),
    globalSettingsPath: path.join(root, 'global-settings.json'),
    source: 'env',
    envLocked: true,
  }
}

function checkpointInput(overrides: Partial<ArchitectCheckpointInput> = {}): ArchitectCheckpointInput {
  return {
    task: {
      id: '11111111-1111-1111-1111-111111111111',
      title: 'Add cross-agent checkpoints',
    },
    project: {
      id: '22222222-2222-2222-2222-222222222222',
      name: 'Forge',
      githubRepo: 'Joncallim/Forge',
      localPath: '/tmp/forge-project',
      defaultBranch: 'main',
    },
    run: {
      id: '33333333-3333-3333-3333-333333333333',
      agentType: 'architect',
      modelIdUsed: 'test-model',
      startedAt: new Date('2026-06-24T00:00:00.000Z'),
      completedAt: new Date('2026-06-24T00:01:00.000Z'),
    },
    checkpointKind: 'architect-success',
    runStatus: 'completed',
    taskStatus: 'awaiting_approval',
    artifactId: '44444444-4444-4444-4444-444444444444',
    openQuestionCount: 0,
    openQuestions: [],
    revisedFromAnswers: false,
    revisedFromPlan: false,
    planText: '## Plan\n\n- Do the smallest useful slice.',
    createdAt: new Date('2026-06-24T00:02:00.000Z'),
    ...overrides,
  }
}

afterEach(() => {
  if (previousWorkspaceRoot === undefined) {
    delete process.env.FORGE_WORKSPACE_ROOT
  } else {
    process.env.FORGE_WORKSPACE_ROOT = previousWorkspaceRoot
  }
  vi.restoreAllMocks()
})

describe('worker checkpoints', () => {
  it('places task checkpoints under workspace local memory, not .forge', () => {
    const root = '/tmp/forge-workspace'
    const activeWorkspace = workspace(root)
    const taskDir = taskCheckpointDirectory(activeWorkspace, '../task:id')
    const paths = architectCheckpointPaths(activeWorkspace, '../task:id', '../run:id')

    expect(taskDir).toBe(path.join(root, 'local-memory', 'checkpoints', 'tasks', '.._task_id'))
    expect(paths.runPath).toBe(
      path.join(root, 'local-memory', 'checkpoints', 'tasks', '.._task_id', 'runs', '.._run_id.md'),
    )
    expect(paths.latestPath).toBe(
      path.join(root, 'local-memory', 'checkpoints', 'tasks', '.._task_id', 'latest.md'),
    )
    expect(paths.runPath).not.toContain(`${path.sep}.forge${path.sep}`)
  })

  it('renders a human-readable Architect checkpoint with continuation metadata', () => {
    const markdown = renderArchitectCheckpoint(checkpointInput({
      openQuestionCount: 1,
      openQuestions: ['Which provider should run the Backend agent?'],
      revisedFromAnswers: true,
      checkpointKind: 'architect-replan',
      taskStatus: 'awaiting_answers',
    }), workspace('/tmp/forge-workspace'))

    expect(markdown).toContain('schemaVersion: 1')
    expect(markdown).toContain('checkpointKind: "architect-replan"')
    expect(markdown).toContain('taskStatus: "awaiting_answers"')
    expect(markdown).toContain('openQuestionCount: 1')
    expect(markdown).toContain('# Forge Checkpoint')
    expect(markdown).toContain('## Plan')
    expect(markdown).toContain('- Which provider should run the Backend agent?')
  })

  it('renders failure checkpoints with error and partial output details', () => {
    const markdown = renderArchitectCheckpoint(checkpointInput({
      checkpointKind: 'architect-failure',
      runStatus: 'failed',
      taskStatus: 'running',
      artifactId: undefined,
      planText: undefined,
      errorMessage: 'Provider config is missing',
      partialOutput: 'Partial architect stream before failure',
    }), workspace('/tmp/forge-workspace'))

    expect(markdown).toContain('checkpointKind: "architect-failure"')
    expect(markdown).toContain('status: "failed"')
    expect(markdown).toContain('artifactId: null')
    expect(markdown).toContain('The Architect run failed.')
    expect(markdown).toContain('No plan artifact was produced before this checkpoint.')
    expect(markdown).toContain('## Failure')
    expect(markdown).toContain('Provider config is missing')
    expect(markdown).toContain('## Partial Output')
    expect(markdown).toContain('Partial architect stream before failure')
  })

  it('writes run-specific and latest checkpoint files under the active workspace', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-checkpoints-'))
    process.env.FORGE_WORKSPACE_ROOT = root

    try {
      const paths = await writeArchitectCheckpoint(checkpointInput())
      const runMarkdown = await fs.readFile(paths.runPath, 'utf-8')
      const latestMarkdown = await fs.readFile(paths.latestPath, 'utf-8')

      expect(paths.runPath.startsWith(path.join(root, 'local-memory', 'checkpoints'))).toBe(true)
      expect(runMarkdown).toBe(latestMarkdown)
      expect(runMarkdown).toContain('artifactId: "44444444-4444-4444-4444-444444444444"')
      await expect(fs.stat(path.join(root, '.forge'))).rejects.toThrow()
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('logs and returns null when checkpoint persistence fails', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-checkpoint-file-root-'))
    const fileRoot = path.join(root, 'not-a-directory')
    await fs.writeFile(fileRoot, 'not a directory')
    process.env.FORGE_WORKSPACE_ROOT = fileRoot
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    try {
      await expect(writeArchitectCheckpointSafely(checkpointInput())).resolves.toBeNull()
      expect(warn).toHaveBeenCalledWith(
        '[worker/checkpoints] Failed to write Architect checkpoint',
        expect.objectContaining({
          taskId: '11111111-1111-1111-1111-111111111111',
          checkpointKind: 'architect-success',
        }),
      )
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})
