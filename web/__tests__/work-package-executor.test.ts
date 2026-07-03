import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  dbInsert: vi.fn(),
  dbInsertValues: vi.fn(),
  generateText: vi.fn(),
  getModel: vi.fn(),
  recordTaskLogBestEffort: vi.fn(),
}))

vi.mock('ai', () => ({
  generateText: mocks.generateText,
}))

vi.mock('@/lib/providers/registry', () => ({
  getModel: mocks.getModel,
  getProvider: vi.fn(),
}))

vi.mock('@/db', () => ({
  db: {
    insert: mocks.dbInsert,
  },
}))

vi.mock('@/worker/task-logs', () => ({
  recordTaskLogBestEffort: mocks.recordTaskLogBestEffort,
}))

import {
  executeWorkPackage,
  hasLocalConflictCopyPathSegment,
  parseWorkPackageExecutionPlan,
  resolveExecutionProviderConfigId,
  WorkPackageExecutionError,
  type WorkPackageExecutionContext,
} from '@/worker/work-package-executor'
import { sanitizeWorkerMessage } from '@/worker/redaction'

const now = new Date('2026-06-26T00:00:00.000Z')
let tempRoot = ''

function fixtureSecret(...parts: string[]) {
  return parts.join('')
}

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

describe('ACP execution cwd boundary', () => {
  it('constructs runtime models with the package sandbox cwd, not the host project root', async () => {
    mocks.getModel.mockResolvedValue({ provider: 'test', modelId: 'resolved-model' })
    mocks.generateText.mockResolvedValue({
      text: JSON.stringify({
        schemaVersion: 1,
        summary: 'Resolved model in sandbox.',
        files: [{ path: 'package.json', content: '{}' }],
        commands: [],
      }),
    })
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-executor-cwd-test-'))

    try {
      await executeWorkPackage(context({
        model: undefined,
        providerConfigId: 'provider-1',
      }))
      expect(mocks.getModel).toHaveBeenCalledWith(
        'provider-1',
        { cwd: path.join(tempRoot, '.forge', 'task-runs', 'task-1', 'pkg-1', 'attempt-1') },
      )
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true })
      tempRoot = ''
    }
  })
})

describe('sanitizeWorkerMessage', () => {
  it('redacts execution output secrets from URLs, config files, and credential assignments', () => {
    const bearerToken = fixtureSecret('sk', '-live', '-secret')
    const privateKeyBegin = fixtureSecret('-----BEGIN ', 'PRIVATE KEY-----')
    const privateKeyEnd = fixtureSecret('-----END ', 'PRIVATE KEY-----')
    const redacted = sanitizeWorkerMessage([
      'postgres://db_user:db_password@localhost:5432/app',
      'https://user:remote-secret@example.com/owner/repo.git',
      `Authorization: Bearer ${bearerToken}`,
      'api_key: "plain-api-key"',
      'OPENAI_API_KEY=plain-openai-key',
      'GITHUB_TOKEN: "plain-github-token"',
      'AWS_SECRET_ACCESS_KEY=plain-aws-secret',
      'client_secret=oauth-secret',
      '"auth": "docker-auth-token"',
      'machine github.com login octo password netrc-secret',
      'localhost:5432:app:forge:pgpass-secret',
      `${privateKeyBegin}\nprivate-key-body\n${privateKeyEnd}`,
    ].join('\n'))

    expect(redacted).toContain('[REDACTED_DATABASE_URL]')
    expect(redacted).toContain('https://[REDACTED_USERINFO]@example.com/owner/repo.git')
    expect(redacted).toContain('Authorization: Bearer [REDACTED_TOKEN]')
    expect(redacted).toContain('api_key: "[REDACTED_TOKEN]"')
    expect(redacted).toContain('client_secret=[REDACTED_TOKEN]')
    expect(redacted).toContain('"auth": "[REDACTED_TOKEN]"')
    expect(redacted).toContain('password [REDACTED_TOKEN]')
    expect(redacted).toContain('localhost:5432:app:forge:[REDACTED_TOKEN]')
    expect(redacted).toContain('[REDACTED_PRIVATE_KEY]')
    expect(redacted).not.toContain('db_password')
    expect(redacted).not.toContain('remote-secret')
    expect(redacted).not.toContain('plain-api-key')
    expect(redacted).not.toContain('plain-openai-key')
    expect(redacted).not.toContain('plain-github-token')
    expect(redacted).not.toContain('plain-aws-secret')
    expect(redacted).not.toContain('oauth-secret')
    expect(redacted).not.toContain('docker-auth-token')
    expect(redacted).not.toContain('netrc-secret')
    expect(redacted).not.toContain('pgpass-secret')
    expect(redacted).not.toContain('private-key-body')
  })
})

describe('executeWorkPackage', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    mocks.dbInsert.mockReturnValue({ values: mocks.dbInsertValues })
    mocks.dbInsertValues.mockResolvedValue(undefined)
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-executor-test-'))
  })

  afterEach(async () => {
    if (tempRoot) await fs.rm(tempRoot, { recursive: true, force: true })
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
    const sandbox = path.join(tempRoot, '.forge', 'task-runs', 'task-1', 'pkg-1', 'attempt-1')

    await expect(fs.stat(path.join(sandbox, 'package.json'))).resolves.toBeTruthy()
    expect(result.sandboxPath).toBe(sandbox)
    expect(result.commandResults.map((item) => item.exitCode)).toEqual([0, 0])
    expect(result.artifactMetadata).toMatchObject({
      hostRepositoryWrites: false,
      repositoryWrites: false,
      sandboxPath: sandbox,
      sandboxWrites: true,
    })
    expect(result.executionContextArtifactMetadata).toMatchObject({
      artifactKind: 'host_readonly_execution_context',
      hostRepositoryWrites: false,
      sandboxWrites: false,
    })
  })

  it('does not include host file contents when filesystem runtime was not approved', async () => {
    await fs.writeFile(path.join(tempRoot, 'README.md'), 'project context should stay private\n')
    mocks.generateText.mockResolvedValue({
      text: JSON.stringify({
        schemaVersion: 1,
        summary: 'No filesystem grant.',
        files: [{ path: 'package.json', content: '{}' }],
        commands: [],
      }),
    })

    const result = await executeWorkPackage(context())
    const call = mocks.generateText.mock.calls[0][0]

    expect(call.prompt).toContain('Host read-only execution context packet')
    expect(call.prompt).toContain('Included files: 0')
    expect(call.prompt).not.toContain('File: README.md')
    expect(call.prompt).not.toContain('project context should stay private')
    expect(result.executionContextArtifactMetadata).toMatchObject({
      files: [],
      filesystemMcpRuntime: expect.objectContaining({
        runtimeIssued: false,
        status: 'not_requested',
      }),
      totals: expect.objectContaining({
        includedFiles: 0,
      }),
    })
    expect(mocks.recordTaskLogBestEffort).not.toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'mcp.filesystem.context_issued',
    }))
  })

  it('includes package MCP overlay, requirements, and subtasks in the execution prompt only as run-scoped instructions', async () => {
    mocks.generateText.mockResolvedValue({
      text: JSON.stringify({
        schemaVersion: 1,
        summary: 'Captured scoped instructions.',
        files: [{ path: 'package.json', content: '{}' }],
        commands: [],
      }),
    })

    await executeWorkPackage(context({
      agentConfig: {
        id: 'agent-1',
        agentType: 'backend',
        displayName: 'Backend',
        description: '',
        frontmatterOverrides: null,
        isActive: true,
        isSystem: true,
        providerConfigId: null,
        systemPrompt: 'Permanent backend system prompt.',
        updatedAt: now,
        updatedBy: null,
      },
      workPackage: {
        ...context().workPackage,
        assignedRole: 'backend',
        mcpRequirements: [{
          mcpId: 'github',
          requirement: 'required',
          permissions: ['github.issues.read'],
          reason: 'Inspect the approved issue context.',
          fallback: { action: 'block' },
        }],
        metadata: {
          promptOverlay: 'Use GitHub read tools only for this approved run.',
          mcpAwareSubtasks: [{
            id: 'inspect-issue',
            mcpCapabilities: ['github.issues.read'],
            inputs: ['Task prompt'],
            outputs: ['Issue context'],
            verification: ['Issue context captured'],
            fallback: 'Use local task context if MCP is unavailable.',
          }],
        },
      },
    }))

    const call = mocks.generateText.mock.calls[0][0]
    expect(call.system).toBe('Permanent backend system prompt.')
    expect(call.system).not.toContain('Use GitHub read tools only')
    expect(call.prompt).toContain('Run-scoped MCP/capability instructions:')
    expect(call.prompt).toContain('They do not modify the permanent agent system prompt')
    expect(call.prompt).toContain('does not issue live MCP runtime tools')
    expect(call.prompt).toContain('Use GitHub read tools only for this approved run.')
    expect(call.prompt).toContain('MCP requirements for this run:')
    expect(call.prompt).toContain('github.issues.read')
    expect(call.prompt).toContain('MCP-aware subtasks for this run:')
    expect(call.prompt).toContain('inspect-issue')
  })

  it('marks approved filesystem read/list/search as a bounded read-only runtime context packet', async () => {
    await fs.writeFile(path.join(tempRoot, 'README.md'), 'project context\n')
    mocks.generateText.mockResolvedValue({
      text: JSON.stringify({
        schemaVersion: 1,
        summary: 'Used filesystem context.',
        files: [{ path: 'package.json', content: '{}' }],
        commands: [],
      }),
    })

    const result = await executeWorkPackage(context({
      workPackage: {
        ...context().workPackage,
        assignedRole: 'backend',
        mcpRequirements: [{
          mcpId: 'filesystem',
          requirement: 'required',
          permissions: ['filesystem.read', 'filesystem.project.search'],
          reason: 'Inspect project files.',
          fallback: { action: 'block' },
        }],
        metadata: {
          mcpGrantPhases: {
            effective: {
              schemaVersion: 1,
              phase: 'effective',
              runtimeEnforcement: 'bounded_context_packet',
              source: 'task-approval',
              status: 'approved',
              grants: [{
                mcpId: 'filesystem',
                status: 'approved',
                capabilities: ['filesystem.read', 'filesystem.project.search'],
              }],
            },
          },
          mcpAwareSubtasks: [{
            id: 'inspect-project',
            mcpCapabilities: ['filesystem.project.search'],
          }],
        },
      },
    }))

    const call = mocks.generateText.mock.calls[0][0]
    expect(call.prompt).toContain('bounded read-only filesystem context packet')
    expect(call.prompt).toContain('filesystem.project.read, filesystem.project.search')
    expect(call.prompt).not.toContain('does not issue live MCP runtime tools')
    expect(call.prompt).toContain('File: README.md')
    expect(result.executionContextArtifactMetadata).toMatchObject({
      filesystemMcpRuntime: {
        capabilities: ['filesystem.project.read', 'filesystem.project.search'],
        mode: 'read_only_context_packet',
        runtimeEnforcement: 'bounded_context_packet',
        runtimeIssued: true,
        status: 'issued',
      },
    })
  })

  it('blocks filesystem runtime when requirements were not approved into effective grants', async () => {
    await fs.writeFile(path.join(tempRoot, 'README.md'), 'project context\n')

    await expect(executeWorkPackage(context({
      workPackage: {
        ...context().workPackage,
        assignedRole: 'backend',
        mcpRequirements: [{
          mcpId: 'filesystem',
          requirement: 'required',
          permissions: ['filesystem.project.read'],
          reason: 'Inspect project files.',
          fallback: { action: 'block' },
        }],
        metadata: {},
      },
    }))).rejects.toThrow(/Filesystem MCP context blocked/)

    expect(mocks.generateText).not.toHaveBeenCalled()
    expect(mocks.recordTaskLogBestEffort).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'mcp.filesystem.context_blocked',
      level: 'warning',
      metadata: expect.objectContaining({
        filesystemMcpRuntime: expect.objectContaining({
          requestedCapabilities: ['filesystem.project.read'],
          runtimeIssued: false,
          status: 'blocked',
        }),
      }),
      title: 'Filesystem context blocked',
    }))
  })

  it('continues optional filesystem requests without context when no effective grant is approved', async () => {
    await fs.writeFile(path.join(tempRoot, 'README.md'), 'project context should stay private\n')
    mocks.generateText.mockResolvedValue({
      text: JSON.stringify({
        schemaVersion: 1,
        summary: 'Continued without optional filesystem context.',
        files: [{ path: 'package.json', content: '{}' }],
        commands: [],
      }),
    })

    const result = await executeWorkPackage(context({
      workPackage: {
        ...context().workPackage,
        assignedRole: 'backend',
        mcpRequirements: [{
          mcpId: 'filesystem',
          requirement: 'optional',
          permissions: ['filesystem.project.read'],
          reason: 'Inspect project files if available.',
          fallback: { action: 'continue_without_mcp' },
        }],
        metadata: {
          mcpGrantPhases: {
            effective: {
              schemaVersion: 1,
              phase: 'effective',
              runtimeEnforcement: 'bounded_context_packet',
              source: 'task-approval',
              status: 'approved',
              grants: [{
                mcpId: 'filesystem',
                status: 'warning',
                capabilities: ['filesystem.project.read'],
              }],
            },
          },
        },
      },
    }))

    const call = mocks.generateText.mock.calls[0][0]
    expect(call.prompt).toContain('Included files: 0')
    expect(call.prompt).not.toContain('File: README.md')
    expect(call.prompt).not.toContain('project context should stay private')
    expect(result.executionContextArtifactMetadata).toMatchObject({
      filesystemMcpRuntime: expect.objectContaining({
        requestedCapabilities: ['filesystem.project.read'],
        runtimeIssued: false,
        status: 'not_issued_optional',
      }),
      totals: expect.objectContaining({
        includedFiles: 0,
      }),
    })
  })

  it('issues context for partial optional filesystem grants and records omitted capabilities', async () => {
    await fs.writeFile(path.join(tempRoot, 'README.md'), 'project context\n')

    mocks.generateText.mockResolvedValue({
      text: JSON.stringify({
        schemaVersion: 1,
        summary: 'Continued with approved read context.',
        files: [{ path: 'package.json', content: '{}' }],
        commands: [],
      }),
    })

    const result = await executeWorkPackage(context({
      workPackage: {
        ...context().workPackage,
        assignedRole: 'backend',
        mcpRequirements: [{
          mcpId: 'filesystem',
          requirement: 'optional',
          permissions: ['filesystem.project.read', 'filesystem.project.search'],
          reason: 'Inspect project files if available.',
          fallback: { action: 'continue_without_mcp' },
        }],
        metadata: {
          mcpGrantPhases: {
            effective: {
              schemaVersion: 1,
              phase: 'effective',
              runtimeEnforcement: 'bounded_context_packet',
              source: 'explicit-grant-approval',
              status: 'approved',
              grants: [{
                mcpId: 'filesystem',
                status: 'approved',
                capabilities: ['filesystem.project.read'],
              }],
            },
          },
        },
      },
    }))

    expect(result.executionContextArtifactMetadata).toMatchObject({
      filesystemMcpRuntime: expect.objectContaining({
        capabilities: ['filesystem.project.read'],
        missingRequestedCapabilities: ['filesystem.project.search'],
        omittedOptionalCapabilities: ['filesystem.project.search'],
        status: 'issued',
      }),
    })
    const auditPayload = mocks.dbInsertValues.mock.calls
      .map((call) => call[0] as Record<string, unknown>)
      .find((payload) => payload.status === 'issued')
    expect(auditPayload).toMatchObject({
      requestedCapabilities: ['filesystem.project.read', 'filesystem.project.search'],
      status: 'issued',
    })
    expect(auditPayload?.metadata).toMatchObject({
      omittedOptionalCapabilities: ['filesystem.project.search'],
    })
  })

  it('issues context and audits omitted MCP-aware subtask capabilities', async () => {
    await fs.writeFile(path.join(tempRoot, 'README.md'), 'project context\n')

    mocks.generateText.mockResolvedValue({
      text: JSON.stringify({
        schemaVersion: 1,
        summary: 'Continued with approved read context.',
        files: [{ path: 'package.json', content: '{}' }],
        commands: [],
      }),
    })

    const result = await executeWorkPackage(context({
      workPackage: {
        ...context().workPackage,
        assignedRole: 'backend',
        mcpRequirements: [{
          mcpId: 'filesystem',
          requirement: 'required',
          permissions: ['filesystem.project.read'],
          reason: 'Read project files.',
          fallback: { action: 'block' },
        }],
        metadata: {
          mcpAwareSubtasks: [{
            id: 'search-project',
            mcpCapabilities: ['filesystem.project.search'],
          }],
          mcpGrantPhases: {
            effective: {
              schemaVersion: 1,
              phase: 'effective',
              runtimeEnforcement: 'bounded_context_packet',
              source: 'explicit-grant-approval',
              status: 'approved',
              grants: [{
                mcpId: 'filesystem',
                status: 'approved',
                capabilities: ['filesystem.project.read'],
              }],
            },
          },
        },
      },
    }))

    expect(result.executionContextArtifactMetadata).toMatchObject({
      filesystemMcpRuntime: expect.objectContaining({
        missingRequestedCapabilities: ['filesystem.project.search'],
        omittedOptionalCapabilities: ['filesystem.project.search'],
        requestedCapabilities: ['filesystem.project.read', 'filesystem.project.search'],
        status: 'issued',
      }),
    })
  })

  it('blocks proposed-only filesystem grant snapshots without approved effective grants', async () => {
    await fs.writeFile(path.join(tempRoot, 'README.md'), 'project context\n')

    await expect(executeWorkPackage(context({
      workPackage: {
        ...context().workPackage,
        assignedRole: 'backend',
        mcpRequirements: [{
          mcpId: 'filesystem',
          requirement: 'required',
          permissions: ['filesystem.project.search'],
          reason: 'Search project files.',
          fallback: { action: 'block' },
        }],
        metadata: {
          mcpGrantPhases: {
            proposed: [{
              mcpId: 'filesystem',
              status: 'proposed',
              capabilities: ['filesystem.project.search'],
            }],
            effective: {
              schemaVersion: 1,
              phase: 'effective',
              runtimeEnforcement: 'bounded_context_packet',
              source: 'task-approval',
              status: 'approved',
              grants: [],
            },
          },
        },
      },
    }))).rejects.toThrow(/Filesystem MCP context blocked/)

    expect(mocks.generateText).not.toHaveBeenCalled()
  })

  it('blocks filesystem runtime when approved grants do not cover all required capabilities', async () => {
    await fs.writeFile(path.join(tempRoot, 'README.md'), 'project context\n')

    await expect(executeWorkPackage(context({
      workPackage: {
        ...context().workPackage,
        assignedRole: 'backend',
        mcpRequirements: [{
          mcpId: 'filesystem',
          requirement: 'required',
          permissions: ['filesystem.project.read', 'filesystem.project.search'],
          reason: 'Read and search project files.',
          fallback: { action: 'block' },
        }],
        metadata: {
          mcpGrantPhases: {
            effective: {
              schemaVersion: 1,
              phase: 'effective',
              runtimeEnforcement: 'bounded_context_packet',
              source: 'explicit-grant-approval',
              status: 'approved',
              grants: [{
                mcpId: 'filesystem',
                status: 'approved',
                capabilities: ['filesystem.project.read'],
              }],
            },
          },
        },
      },
    }))).rejects.toThrow(/Filesystem MCP context blocked/)

    expect(mocks.generateText).not.toHaveBeenCalled()
    expect(mocks.recordTaskLogBestEffort).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({
        filesystemMcpRuntime: expect.objectContaining({
          missingBlockingCapabilities: ['filesystem.project.search'],
          status: 'blocked',
        }),
      }),
    }))
  })

  it('blocks list/search-only approved filesystem grants because content packets require read', async () => {
    await fs.writeFile(path.join(tempRoot, 'README.md'), 'project context\n')

    await expect(executeWorkPackage(context({
      workPackage: {
        ...context().workPackage,
        assignedRole: 'backend',
        mcpRequirements: [{
          mcpId: 'filesystem',
          requirement: 'required',
          permissions: ['filesystem.project.search'],
          reason: 'Search project files.',
          fallback: { action: 'block' },
        }],
        metadata: {
          mcpGrantPhases: {
            effective: {
              schemaVersion: 1,
              phase: 'effective',
              runtimeEnforcement: 'bounded_context_packet',
              source: 'explicit-grant-approval',
              status: 'approved',
              grants: [{
                mcpId: 'filesystem',
                status: 'approved',
                capabilities: ['filesystem.project.search'],
              }],
            },
          },
        },
      },
    }))).rejects.toThrow(/Filesystem MCP context blocked/)

    expect(mocks.generateText).not.toHaveBeenCalled()
    expect(mocks.recordTaskLogBestEffort).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({
        filesystemMcpRuntime: expect.objectContaining({
          capabilities: ['filesystem.project.search'],
          missingBlockingCapabilities: ['filesystem.project.read'],
          reason: expect.stringMatching(/not covered by approved effective grants: filesystem\.project\.read/),
          status: 'blocked',
        }),
      }),
    }))
  })

  it('blocks effective filesystem grants when the package never requested filesystem access', async () => {
    await expect(executeWorkPackage(context({
      workPackage: {
        ...context().workPackage,
        assignedRole: 'backend',
        mcpRequirements: [],
        metadata: {
          mcpGrantPhases: {
            effective: {
              schemaVersion: 1,
              phase: 'effective',
              runtimeEnforcement: 'bounded_context_packet',
              source: 'explicit-grant-approval',
              status: 'approved',
              grants: [{
                mcpId: 'filesystem',
                status: 'approved',
                capabilities: ['filesystem.project.read'],
              }],
            },
          },
        },
      },
    }))).rejects.toThrow(/Filesystem MCP context blocked/)

    expect(mocks.generateText).not.toHaveBeenCalled()
    expect(mocks.recordTaskLogBestEffort).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({
        filesystemMcpRuntime: expect.objectContaining({
          capabilities: ['filesystem.project.read'],
          reason: expect.stringMatching(/did not request filesystem capabilities/i),
          status: 'blocked',
        }),
      }),
    }))
  })

  it('ignores malformed approved effective filesystem grant envelopes', async () => {
    await fs.writeFile(path.join(tempRoot, 'README.md'), 'project context\n')

    await expect(executeWorkPackage(context({
      workPackage: {
        ...context().workPackage,
        assignedRole: 'backend',
        mcpRequirements: [{
          mcpId: 'filesystem',
          requirement: 'required',
          permissions: ['filesystem.project.read'],
          reason: 'Read project files.',
          fallback: { action: 'block' },
        }],
        metadata: {
          mcpGrantPhases: {
            effective: {
              schemaVersion: 1,
              phase: 'effective',
              runtimeEnforcement: 'approved_snapshot',
              source: 'task-approval',
              status: 'approved',
              grants: [{
                mcpId: 'filesystem',
                status: 'approved',
                capabilities: ['filesystem.project.read'],
              }],
            },
          },
        },
      },
    }))).rejects.toThrow(/Filesystem MCP context blocked/)

    expect(mocks.generateText).not.toHaveBeenCalled()
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

  it('fails lint validation when no JavaScript source files can be checked', async () => {
    mocks.generateText.mockResolvedValue({
      text: JSON.stringify({
        schemaVersion: 1,
        summary: 'Generated unchecked lint input.',
        files: [
          {
            path: 'package.json',
            content: JSON.stringify({ scripts: { lint: 'eslint .' } }),
          },
          {
            path: 'src/app.tsx',
            content: 'export const App = () => <div />\n',
          },
        ],
        commands: [['npm', 'run', 'lint']],
      }),
    })

    await expect(executeWorkPackage(context())).rejects.toThrow(/at least one checkable JavaScript source file/i)
  })

  it('throws validation failures with durable sandbox output metadata', async () => {
    mocks.generateText.mockResolvedValue({
      text: JSON.stringify({
        schemaVersion: 1,
        summary: 'Generated files but failed validation.',
        files: [
          {
            path: 'package.json',
            content: JSON.stringify({
              scripts: {
                test: 'node missing-test.js',
              },
            }),
          },
        ],
        commands: [['npm', 'test']],
      }),
    })

    try {
      await executeWorkPackage(context())
      throw new Error('Expected execution to fail')
    } catch (err) {
      expect(err).toBeInstanceOf(WorkPackageExecutionError)
      const failure = (err as WorkPackageExecutionError).failureDetails
      expect(failure.sandboxPath).toBe(path.join(tempRoot, '.forge', 'task-runs', 'task-1', 'pkg-1', 'attempt-1'))
      expect(failure.fileCount).toBe(1)
      expect(failure.artifactMetadata).toMatchObject({
        files: ['package.json'],
        generatedBy: 'work-package-executor',
        repositoryWrites: false,
        sandboxWrites: true,
        validationStatus: 'failed',
      })
      expect(failure.commandResults).toHaveLength(1)
      expect(failure.commandResults[0].exitCode).not.toBe(0)
    }
  })

  it('wraps invalid execution-plan generation with durable empty sandbox metadata', async () => {
    mocks.generateText.mockResolvedValue({
      text: 'not json',
    })

    try {
      await executeWorkPackage(context())
      throw new Error('Expected execution to fail')
    } catch (err) {
      expect(err).toBeInstanceOf(WorkPackageExecutionError)
      const failure = (err as WorkPackageExecutionError).failureDetails
      const sandbox = path.join(tempRoot, '.forge', 'task-runs', 'task-1', 'pkg-1', 'attempt-1')
      expect(failure).toMatchObject({
        commandResults: [],
        fileCount: 0,
        sandboxPath: sandbox,
      })
      expect(failure.artifactMetadata).toMatchObject({
        files: [],
        generatedBy: 'work-package-executor',
        repositoryWrites: false,
        sandboxPath: sandbox,
        sandboxWrites: false,
        validationStatus: 'failed',
      })
      await expect(fs.stat(sandbox)).resolves.toMatchObject({})
      expect(mocks.generateText).toHaveBeenCalledTimes(2)
    }
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

    await expect(executeWorkPackage(context())).rejects.toThrow(/sandbox (?:path contains|root is) a symlink/i)
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
    await expect(fs.stat(path.join(tempRoot, '.forge', 'task-runs', 'task-1', 'pkg-1', 'attempt-1', 'src', 'app 2.ts')))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('includes a bounded redacted host context packet and excludes task-run artifacts from the prompt', async () => {
    await fs.writeFile(path.join(tempRoot, 'README.md'), 'API_TOKEN=should-not-leak\n')
    await fs.writeFile(path.join(tempRoot, '.env'), 'SECRET=do-not-read\n')
    await fs.mkdir(path.join(tempRoot, '.forge', 'task-runs', 'old-task'), { recursive: true })
    await fs.writeFile(path.join(tempRoot, '.forge', 'task-runs', 'old-task', 'artifact.txt'), 'old output\n')
    await fs.mkdir(path.join(tempRoot, 'node_modules'), { recursive: true })
    await fs.writeFile(path.join(tempRoot, 'node_modules', 'dep.js'), 'ignored\n')

    mocks.generateText.mockResolvedValue({
      text: JSON.stringify({
        schemaVersion: 1,
        summary: 'Read context safely.',
        files: [{ path: 'package.json', content: '{}' }],
        commands: [],
      }),
    })

    const result = await executeWorkPackage(context({
      attemptNumber: 2,
      workPackage: {
        ...context().workPackage,
        mcpRequirements: [{
          mcpId: 'filesystem',
          requirement: 'required',
          permissions: ['filesystem.project.read'],
          reason: 'Inspect project context.',
          fallback: { action: 'block' },
        }],
        metadata: {
          mcpGrantPhases: {
            effective: {
              schemaVersion: 1,
              phase: 'effective',
              runtimeEnforcement: 'bounded_context_packet',
              source: 'task-approval',
              status: 'approved',
              grants: [{
                mcpId: 'filesystem',
                status: 'approved',
                capabilities: ['filesystem.project.read'],
              }],
            },
          },
        },
      },
      priorReviewContext: {
        packageBlockedReason: 'Needs rework.',
        notes: [{
          gateId: 'gate-1',
          gateType: 'qa_review',
          reason: 'Test coverage was missing.\nReviewed source artifact excerpt:\nPrior output omitted regression coverage.',
          sourceArtifactId: 'artifact-1',
          status: 'needs_rework',
        }],
      },
    }))

    const call = mocks.generateText.mock.calls[0][0]
    expect(call.prompt).toContain('Execution attempt: 2 of 3')
    expect(call.prompt).toContain('Prior review/rework context:')
    expect(call.prompt).toContain('source artifact artifact-1')
    expect(call.prompt).toContain('Prior output omitted regression coverage.')
    expect(call.prompt).toContain('File: README.md')
    expect(call.prompt).toContain('API_TOKEN=[REDACTED_TOKEN]')
    expect(call.prompt).not.toContain('do-not-read')
    expect(call.prompt).not.toContain('old output')
    expect(call.prompt).not.toContain('dep.js')
    expect(result.executionContextArtifactContent).toContain('Host read-only execution context packet summary')
    expect(result.executionContextArtifactContent).toContain('Full file contents are used only for the bounded execution prompt')
    expect(result.executionContextArtifactContent).not.toContain('API_TOKEN=[REDACTED_TOKEN]')
    expect(result.sandboxPath).toBe(path.join(tempRoot, '.forge', 'task-runs', 'task-1', 'pkg-1', 'attempt-2'))
    expect(result.executionContextArtifactMetadata).toMatchObject({
      omitted: expect.objectContaining({
        ignoredDirectories: expect.arrayContaining(['.forge/task-runs', 'node_modules']),
        secretLike: expect.arrayContaining(['.env']),
      }),
      redaction: expect.objectContaining({ applied: true }),
    })
    const auditPayload = mocks.dbInsertValues.mock.calls
      .map((call) => call[0] as Record<string, unknown>)
      .find((payload) => payload.status === 'issued')
    expect(auditPayload).toMatchObject({
      capabilities: ['filesystem.project.read'],
      fileCount: 1,
      omittedCount: expect.any(Number),
      redactionApplied: true,
      requestedCapabilities: ['filesystem.project.read'],
      root: tempRoot,
      status: 'issued',
      taskId: 'task-1',
      workPackageId: 'pkg-1',
    })
    expect(JSON.stringify(auditPayload)).not.toContain('should-not-leak')
  })

  it('audits blocked filesystem context when required grants are missing', async () => {
    await expect(executeWorkPackage(context({
      workPackage: {
        ...context().workPackage,
        mcpRequirements: [{
          mcpId: 'filesystem',
          requirement: 'required',
          permissions: ['filesystem.project.read'],
          reason: 'Inspect project context.',
          fallback: { action: 'block' },
        }],
        metadata: {},
      },
    }))).rejects.toThrow(/Filesystem MCP context blocked/i)

    const auditPayload = mocks.dbInsertValues.mock.calls
      .map((call) => call[0] as Record<string, unknown>)
      .find((payload) => payload.status === 'blocked')
    expect(auditPayload).toMatchObject({
      requestedCapabilities: ['filesystem.project.read'],
      status: 'blocked',
      taskId: 'task-1',
      workPackageId: 'pkg-1',
    })
    expect(String(auditPayload?.reason)).toMatch(/not covered by approved effective grants/i)
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
