import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  generateText: vi.fn(),
}))

vi.mock('ai', () => ({
  generateText: mocks.generateText,
}))

import {
  executeWorkPackage,
  hasLocalConflictCopyPathSegment,
  parseWorkPackageExecutionPlan,
  resolveExecutionProviderConfigId,
  type WorkPackageExecutionContext,
} from '@/worker/work-package-executor'

const now = new Date('2026-06-26T00:00:00.000Z')
let tempRoot = ''

function context(overrides: Partial<WorkPackageExecutionContext> = {}): WorkPackageExecutionContext {
  return {
    agentConfig: null,
    validatedProjectRoot: tempRoot,
    model: { provider: 'test', modelId: 'test-model' } as never,
    modelIdUsed: 'test-model',
    project: {
      id: 'project-1',
      name: 'Tracker Smoke',
      githubRepo: null,
      localPath: tempRoot,
      githubTokenEnvVar: null,
      pmProviderConfigId: null,
      mcpConfig: { profile: 'default', requiredMcps: [], overrides: {} },
      defaultBranch: 'main',
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    },
    task: {
      id: 'task-1',
      projectId: 'project-1',
      submittedBy: null,
      title: 'Build tracker',
      prompt: 'Build a tiny task tracker web app.',
      status: 'running',
      pmProviderConfigId: null,
      githubBranch: null,
      githubPrUrl: null,
      errorMessage: null,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    },
    workPackage: {
      id: 'pkg-1',
      taskId: 'task-1',
      harnessId: null,
      assignedRole: 'frontend',
      title: 'Frontend work package',
      summary: 'Build the tiny tracker app.',
      status: 'running',
      sequence: 1,
      steps: ['Create app files', 'Add tests and build script'],
      requiredCapabilities: {},
      acceptanceCriteria: [],
      mcpRequirements: [],
      reviewRequirement: 'both',
      blockedReason: null,
      metadata: {},
      createdAt: now,
      updatedAt: now,
    },
    ...overrides,
  }
}

describe('parseWorkPackageExecutionPlan', () => {
  it('parses a fenced execution JSON block', () => {
    const parsed = parseWorkPackageExecutionPlan([
      '```work_package_execution_json',
      JSON.stringify({
        schemaVersion: 1,
        summary: 'Built tracker',
        files: [{ path: 'package.json', content: '{}' }],
        commands: [['npm', 'test']],
      }),
      '```',
    ].join('\n'))

    expect(parsed.summary).toBe('Built tracker')
    expect(parsed.files).toEqual([{ path: 'package.json', content: '{}' }])
    expect(parsed.commands).toEqual([['npm', 'test']])
  })

  it('rejects unsupported commands', () => {
    expect(() => parseWorkPackageExecutionPlan(JSON.stringify({
      schemaVersion: 1,
      summary: 'Bad command',
      files: [{ path: 'package.json', content: '{}' }],
      commands: [['rm', '-rf', '/']],
    }))).toThrow(/not allowed/i)
  })

  it('rejects local conflict-copy file paths before writes', () => {
    expect(() => parseWorkPackageExecutionPlan(JSON.stringify({
      schemaVersion: 1,
      summary: 'Bad path',
      files: [{ path: 'web/lib/providers/acp/model-selection 2.ts', content: 'bad' }],
      commands: [],
    }))).toThrow(/conflict-copy/i)
  })

  it('parses a balanced JSON object embedded in prose', () => {
    const parsed = parseWorkPackageExecutionPlan([
      'Here is the plan:',
      JSON.stringify({
        schemaVersion: 1,
        summary: 'Built tracker',
        files: [{ path: 'package.json', content: '{"scripts":{}}' }],
        commands: [],
      }),
      'Done.',
    ].join('\n'))

    expect(parsed.summary).toBe('Built tracker')
    expect(parsed.files).toHaveLength(1)
  })
})

describe('hasLocalConflictCopyPathSegment', () => {
  it('detects duplicated local conflict-copy names', () => {
    expect(hasLocalConflictCopyPathSegment('web/__tests__/repository-evidence.test 2.ts')).toBe(true)
    expect(hasLocalConflictCopyPathSegment('web/.next/server/chunks 2')).toBe(true)
    expect(hasLocalConflictCopyPathSegment('docs/chapter-2.md')).toBe(false)
  })
})

describe('resolveExecutionProviderConfigId', () => {
  it('uses the task-selected provider before the agent default', () => {
    expect(resolveExecutionProviderConfigId({
      agentProviderConfigId: 'agent-provider',
      taskProviderConfigId: 'task-provider',
    })).toBe('task-provider')
    expect(resolveExecutionProviderConfigId({
      agentProviderConfigId: 'agent-provider',
      taskProviderConfigId: null,
    })).toBe('agent-provider')
  })
})

describe('executeWorkPackage', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-executor-test-'))
  })

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true })
  })

  it('writes generated files into the task sandbox and runs allowed commands', async () => {
    mocks.generateText.mockResolvedValue({
      text: JSON.stringify({
        schemaVersion: 1,
        summary: 'Built a tiny app.',
        files: [
          {
            path: 'package.json',
            content: JSON.stringify({
              scripts: {
                build: 'node build-check.js',
                test: 'node --test',
              },
            }),
          },
          {
            path: 'build-check.js',
            content: 'console.log("build ok");\n',
          },
          {
            path: 'index.test.js',
            content: 'import test from "node:test"; import assert from "node:assert/strict"; test("ok", () => assert.equal(1, 1));\n',
          },
        ],
        commands: [['npm', 'test'], ['npm', 'run', 'build']],
      }),
    })

    const result = await executeWorkPackage(context())
    const sandbox = path.join(tempRoot, '.forge', 'task-runs', 'task-1', 'pkg-1')

    await expect(fs.stat(path.join(sandbox, 'package.json'))).resolves.toBeTruthy()
    expect(result.sandboxPath).toBe(sandbox)
    expect(result.commandResults.map((item) => item.exitCode)).toEqual([0, 0])
    expect(result.artifactMetadata).toMatchObject({
      repositoryWrites: true,
      sandboxPath: sandbox,
    })
  })

  it('does not execute model-generated npm scripts while validating commands', async () => {
    const outsideFile = path.join(tempRoot, 'outside.txt')
    mocks.generateText.mockResolvedValue({
      text: JSON.stringify({
        schemaVersion: 1,
        summary: 'Attempted script execution.',
        files: [
          {
            path: 'package.json',
            content: JSON.stringify({
              scripts: {
                test: `node -e "require('fs').writeFileSync('${outsideFile}', 'pwned')"`,
              },
            }),
          },
          {
            path: 'index.test.js',
            content: 'import test from "node:test"; import assert from "node:assert/strict"; test("ok", () => assert.equal(1, 1));\n',
          },
        ],
        commands: [['npm', 'test']],
      }),
    })

    await expect(executeWorkPackage(context({
      task: {
        ...context().task,
        prompt: 'Build a tiny task tracker web app with tests.',
      },
    }))).rejects.toThrow(/unsafe shell behavior/i)
    await expect(fs.stat(outsideFile)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('fails build validation when no JavaScript source files can be checked', async () => {
    mocks.generateText.mockResolvedValue({
      text: JSON.stringify({
        schemaVersion: 1,
        summary: 'Generated unchecked TypeScript.',
        files: [
          {
            path: 'package.json',
            content: JSON.stringify({ scripts: { build: 'tsc --noEmit' } }),
          },
          {
            path: 'src/app.tsx',
            content: 'export const App = () => <div />\n',
          },
        ],
        commands: [['npm', 'run', 'build']],
      }),
    })

    await expect(executeWorkPackage(context({
      task: {
        ...context().task,
        prompt: 'Build a tiny task tracker web app. Make sure it builds.',
      },
    }))).rejects.toThrow(/at least one checkable JavaScript source file/i)
  })

  it('rejects symlinked execution sandbox roots before writing generated files', async () => {
    const outsideRoot = path.join(tempRoot, 'outside-sandbox')
    const sandboxParent = path.join(tempRoot, '.forge', 'task-runs', 'task-1')
    await fs.mkdir(outsideRoot, { recursive: true })
    await fs.mkdir(sandboxParent, { recursive: true })
    await fs.symlink(outsideRoot, path.join(sandboxParent, 'pkg-1'))
    mocks.generateText.mockResolvedValue({
      text: JSON.stringify({
        schemaVersion: 1,
        summary: 'Attempt symlink write.',
        files: [{ path: 'package.json', content: '{}' }],
        commands: [],
      }),
    })

    await expect(executeWorkPackage(context())).rejects.toThrow(/sandbox root is a symlink/i)
    await expect(fs.readdir(outsideRoot)).resolves.toEqual([])
  })

  it('rejects file paths that escape the sandbox', async () => {
    mocks.generateText.mockResolvedValue({
      text: JSON.stringify({
        schemaVersion: 1,
        summary: 'Attempt escape.',
        files: [{ path: '../escape.txt', content: 'bad' }],
        commands: [],
      }),
    })

    await expect(executeWorkPackage(context())).rejects.toThrow(/traverse outside/i)
    await expect(fs.stat(path.join(tempRoot, '.forge', 'task-runs', 'task-1', 'escape.txt'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('does not write generated local conflict-copy paths', async () => {
    mocks.generateText.mockResolvedValue({
      text: JSON.stringify({
        schemaVersion: 1,
        summary: 'Attempt conflict copy.',
        files: [{ path: 'src/app 2.ts', content: 'bad' }],
        commands: [],
      }),
    })

    await expect(executeWorkPackage(context())).rejects.toThrow(/conflict-copy/i)
    await expect(fs.stat(path.join(tempRoot, '.forge', 'task-runs', 'task-1', 'pkg-1', 'src', 'app 2.ts')))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects placeholder tests and build scripts when the task requires them', async () => {
    mocks.generateText.mockResolvedValue({
      text: JSON.stringify({
        schemaVersion: 1,
        summary: 'Pretended to build a tracker.',
        files: [
          {
            path: 'package.json',
            content: JSON.stringify({
              scripts: {
                build: 'echo "Build script not needed for this example."',
                test: 'node test.js',
              },
            }),
          },
          {
            path: 'test.js',
            content: 'console.log("No tests needed for this example.");\n',
          },
        ],
        commands: [['npm', 'test'], ['npm', 'run', 'build']],
      }),
    })

    await expect(executeWorkPackage(context({
      task: {
        ...context().task,
        prompt: 'Build a tiny task tracker web app. Add focused tests and make sure the app builds.',
      },
    }))).rejects.toThrow(/placeholder tests/i)
    expect(mocks.generateText).toHaveBeenCalledTimes(2)
  })

  it('rejects invalid node:test shell scripts before command execution', async () => {
    mocks.generateText.mockResolvedValue({
      text: JSON.stringify({
        schemaVersion: 1,
        summary: 'Generated a bad test command.',
        files: [
          {
            path: 'package.json',
            content: JSON.stringify({
              scripts: {
                build: 'node build-check.js',
                test: 'node:test',
              },
            }),
          },
          {
            path: 'tracker.test.js',
            content: 'import test from "node:test"; import assert from "node:assert/strict"; test("adds item", () => assert.equal(1, 1));\n',
          },
          { path: 'build-check.js', content: 'console.log("build ok");\n' },
        ],
        commands: [['npm', 'test'], ['npm', 'run', 'build']],
      }),
    })

    await expect(executeWorkPackage(context({
      task: {
        ...context().task,
        prompt: 'Build a tiny task tracker web app. Add focused tests and make sure the app builds.',
      },
    }))).rejects.toThrow(/test script is invalid/i)
  })

  it('reprompts once when validation rejects the first generated plan', async () => {
    mocks.generateText
      .mockResolvedValueOnce({
        text: JSON.stringify({
          schemaVersion: 1,
          summary: 'Pretended to build a tracker.',
          files: [
            {
              path: 'package.json',
              content: JSON.stringify({
                scripts: {
                  build: 'echo "Build script not needed for this example."',
                  test: 'node test.js',
                },
              }),
            },
            { path: 'test.js', content: 'console.log("No tests needed for this example.");\n' },
          ],
          commands: [['npm', 'test'], ['npm', 'run', 'build']],
        }),
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({
          schemaVersion: 1,
          summary: 'Built and tested the tracker.',
          files: [
            {
              path: 'package.json',
              content: JSON.stringify({
                scripts: {
                  build: 'node build-check.js',
                  test: 'node --test',
                },
              }),
            },
            {
              path: 'tracker.test.js',
              content: 'import test from "node:test"; import assert from "node:assert/strict"; test("adds item", () => assert.equal(["a"].length, 1));\n',
            },
            {
              path: 'build-check.js',
              content: 'console.log("build validated");\n',
            },
          ],
          commands: [['npm', 'test'], ['npm', 'run', 'build']],
        }),
      })

    const result = await executeWorkPackage(context({
      task: {
        ...context().task,
        prompt: 'Build a tiny task tracker web app. Add focused tests and make sure the app builds.',
      },
    }))

    expect(mocks.generateText).toHaveBeenCalledTimes(2)
    expect(result.summary).toBe('Built and tested the tracker.')
    expect(result.commandResults.map((item) => item.exitCode)).toEqual([0, 0])
  })
})
