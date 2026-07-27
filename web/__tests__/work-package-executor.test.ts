import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  dbInsert: vi.fn(),
  dbInsertValues: vi.fn(),
  dbUpdate: vi.fn(),
  dbUpdateSet: vi.fn(),
  dbUpdateWhere: vi.fn(),
  buildExecutionContextPacket: vi.fn(),
  generateText: vi.fn(),
  getModel: vi.fn(),
  publishTaskEvent: vi.fn(),
  recordTaskLogBestEffort: vi.fn(),
  beginPacketAssemblyV2: vi.fn(),
  completePacketAssemblyV2: vi.fn(),
  beginPacketDeliveryV2: vi.fn(),
  completePacketDeliveryV2: vi.fn(),
  architectPlanStorageConfiguration: vi.fn(),
  bindRegisteredArchitectPlanEntry: vi.fn(),
  resolveRegisteredArchitectPlanEntry: vi.fn(),
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
    update: mocks.dbUpdate,
  },
}))

vi.mock('@/worker/events', () => ({
  publishTaskEvent: mocks.publishTaskEvent,
}))

vi.mock('@/worker/task-logs', () => ({
  recordTaskLogBestEffort: mocks.recordTaskLogBestEffort,
}))

vi.mock('@/lib/mcps/s4-protocol-store', () => ({
  architectPlanStorageConfiguration: mocks.architectPlanStorageConfiguration,
  bindRegisteredArchitectPlanEntry: mocks.bindRegisteredArchitectPlanEntry,
  resolveRegisteredArchitectPlanEntry: mocks.resolveRegisteredArchitectPlanEntry,
}))

vi.mock('@/lib/mcps/s4-lease', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/mcps/s4-lease')>(),
  beginPacketAssemblyV2: mocks.beginPacketAssemblyV2,
  completePacketAssemblyV2: mocks.completePacketAssemblyV2,
  beginPacketDeliveryV2: mocks.beginPacketDeliveryV2,
  completePacketDeliveryV2: mocks.completePacketDeliveryV2,
}))

vi.mock('@/worker/execution-context-packet', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/worker/execution-context-packet')>()
  mocks.buildExecutionContextPacket.mockImplementation(actual.buildExecutionContextPacket)
  return {
    ...actual,
    buildExecutionContextPacket: mocks.buildExecutionContextPacket,
  }
})

import {
  executeWorkPackage,
  ConfinedMaterializationUnavailableError,
  hasLocalConflictCopyPathSegment,
  parseWorkPackageExecutionPlan,
  resolveProtectedArchitectPlanContext,
  resolveExecutionProviderConfigId,
  type WorkPackageExecutionContext,
  type WorkPackageExecutionPreflight,
} from '@/worker/work-package-executor'
import { sanitizeWorkerMessage } from '@/worker/redaction'

const now = new Date('2026-06-26T00:00:00.000Z')
let tempRoot = ''

function immutableProjectAuthorityFromConfig(mcpConfig: unknown) {
  const config = mcpConfig && typeof mcpConfig === 'object' ? mcpConfig as Record<string, unknown> : {}
  const grants = config.grants && typeof config.grants === 'object'
    ? config.grants as Record<string, unknown>
    : {}
  const grant = grants.filesystem && typeof grants.filesystem === 'object'
    ? grants.filesystem as Record<string, unknown>
    : null
  if (!grant || grant.status !== 'approved') return null
  return {
    schemaVersion: 2 as const,
    decisionId: String(grant.grantApprovalId ?? 'grant-project-1'),
    projectId: 'project-1',
    decision: 'approved' as const,
    capabilities: Array.isArray(grant.capabilities) ? [...grant.capabilities].sort() : [],
    grantDecisionRevision: String(grant.grantDecisionRevision ?? '1'),
    rootBindingRevision: String(grant.rootBindingRevision ?? '1'),
    decisionFingerprint: `sha256:${'1'.repeat(64)}`,
    decisionGeneration: '1',
    decidedAt: String(grant.approvedAt ?? now.toISOString()),
    decidedBy: String(grant.approvedBy ?? 'user-1'),
    reason: String(grant.reason ?? ''),
    revocationReason: null,
  }
}

function fixtureSecret(...parts: string[]) {
  return parts.join('')
}

function context(overrides: Partial<WorkPackageExecutionContext> = {}): WorkPackageExecutionContext {
  const defaultWorkPackage: WorkPackageExecutionContext['workPackage'] = {
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
    metadata: { repositoryWrites: false },
    createdAt: now,
    updatedAt: now,
  }
  const workPackage = overrides.workPackage
    ? {
      ...defaultWorkPackage,
      ...overrides.workPackage,
      metadata: {
        ...defaultWorkPackage.metadata,
        ...(overrides.workPackage.metadata ?? {}),
      },
    }
    : defaultWorkPackage
  const workPackageMetadata = workPackage.metadata && typeof workPackage.metadata === 'object'
    ? workPackage.metadata as Record<string, unknown>
    : {}
  const phases = workPackageMetadata.mcpGrantPhases && typeof workPackageMetadata.mcpGrantPhases === 'object'
    ? workPackageMetadata.mcpGrantPhases as Record<string, unknown>
    : null
  const effective = phases?.effective && typeof phases.effective === 'object'
    ? phases.effective as Record<string, unknown>
    : null
  if (effective?.source === 'explicit-grant-approval' && !effective.grantApprovalId) {
    effective.grantApprovalId = '00000000-0000-4000-8000-000000000020'
  }

  return {
    agentConfig: null,
    agentRunId: '00000000-0000-4000-8000-000000000010',
    validatedProjectRoot: tempRoot,
    model: { provider: 'test', modelId: 'test-model' } as never,
    modelIdUsed: 'test-model',
    projectFilesystemDecision: overrides.projectFilesystemDecision ??
      immutableProjectAuthorityFromConfig(overrides.project?.mcpConfig),
    project: {
      id: 'project-1',
      rootRef: '00000000-0000-4000-8000-000000000001',
      name: 'Tracker Smoke',
      submittedBy: null,
      githubRepo: null,
      localPath: tempRoot,
      githubTokenEnvVar: null,
      pmProviderConfigId: null,
      mcpConfig: { profile: 'default', requiredMcps: [], overrides: {} },
      grantDecisionRevision: BigInt(1),
      rootBindingRevision: BigInt(1),
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
      localProjectionSourceTaskId: null,
      localProjectionReplacementState: null,
      localProjectionReplacementVersion: null,
      localProjectionReplacementFingerprint: null,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    },
    ...overrides,
    workPackage,
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

  it('normalizes package-script validation command aliases', () => {
    const parsed = parseWorkPackageExecutionPlan(JSON.stringify({
      schemaVersion: 1,
      summary: 'Built tracker',
      files: [{
        path: 'package.json',
        content: JSON.stringify({
          scripts: {
            build: 'node build-check.js',
            lint: 'node lint-check.js',
            test: 'node tracker.test.js',
          },
        }),
      }],
      commands: [['node', 'tracker.test.js'], ['node', 'build-check.js'], ['node', 'lint-check.js']],
    }))

    expect(parsed.commands).toEqual([['npm', 'test'], ['npm', 'run', 'build'], ['npm', 'run', 'lint']])
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

  it('reports malformed execution JSON instead of an incidental object shape error', () => {
    const raw = [
      'Diagnostic metadata: {"provider":"local"}',
      '```work_package_execution_json',
      '{"schemaVersion":1,"summary":"Cut off"',
    ].join('\n')

    expect(() => parseWorkPackageExecutionPlan(raw)).toThrow(/not valid JSON/i)
  })

  it('parses a one-line fenced execution JSON block', () => {
    const payload = JSON.stringify({
      schemaVersion: 1,
      summary: 'Built tracker',
      files: [{ path: 'package.json', content: '{"scripts":{}}' }],
      commands: [],
    })

    const parsed = parseWorkPackageExecutionPlan(`\`\`\`work_package_execution_json ${payload}\`\`\``)

    expect(parsed.summary).toBe('Built tracker')
    expect(parsed.files).toHaveLength(1)
  })

  it('parses a JSON-encoded execution response string', () => {
    const payload = JSON.stringify({
      schemaVersion: 1,
      summary: 'Built tracker',
      files: [{ path: 'package.json', content: '{"scripts":{}}' }],
      commands: [],
    })

    const parsed = parseWorkPackageExecutionPlan(JSON.stringify(payload))

    expect(parsed.summary).toBe('Built tracker')
    expect(parsed.files).toHaveLength(1)
  })

  it('parses a JSON-encoded fenced execution response string', () => {
    const payload = [
      '```work_package_execution_json',
      JSON.stringify({
        schemaVersion: 1,
        summary: 'Built tracker',
        files: [{ path: 'package.json', content: '{"scripts":{}}' }],
        commands: [],
      }),
      '```',
    ].join('\n')

    const parsed = parseWorkPackageExecutionPlan(JSON.stringify(payload))

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

describe('confined materialization boundary', () => {
  it('fails before creating a sandbox or launching a provider when no OS writer exists', async () => {
    const unavailableRoot = path.join(os.tmpdir(), `forge-no-writer-${Date.now()}`)

    await expect(executeWorkPackage(context({ validatedProjectRoot: unavailableRoot })))
      .rejects.toBeInstanceOf(ConfinedMaterializationUnavailableError)

    await expect(fs.stat(unavailableRoot)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(mocks.getModel).not.toHaveBeenCalled()
    expect(mocks.generateText).not.toHaveBeenCalled()
    expect(mocks.dbInsert).not.toHaveBeenCalled()
    expect(mocks.dbUpdate).not.toHaveBeenCalled()
    expect(mocks.publishTaskEvent).not.toHaveBeenCalled()
    expect(mocks.recordTaskLogBestEffort).not.toHaveBeenCalled()
    expect(mocks.beginPacketAssemblyV2).not.toHaveBeenCalled()
    expect(mocks.completePacketAssemblyV2).not.toHaveBeenCalled()
    expect(mocks.beginPacketDeliveryV2).not.toHaveBeenCalled()
    expect(mocks.completePacketDeliveryV2).not.toHaveBeenCalled()
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
    mocks.dbUpdate.mockReturnValue({ set: mocks.dbUpdateSet })
    mocks.dbUpdateSet.mockReturnValue({ where: mocks.dbUpdateWhere })
    mocks.dbUpdateWhere.mockResolvedValue(undefined)
    mocks.beginPacketAssemblyV2.mockResolvedValue(true)
    mocks.completePacketAssemblyV2.mockResolvedValue(true)
    mocks.beginPacketDeliveryV2.mockResolvedValue(true)
    mocks.completePacketDeliveryV2.mockResolvedValue(true)
    mocks.architectPlanStorageConfiguration.mockReturnValue({
      mode: 'protected',
      digestKey: Buffer.alloc(32, 7),
      digestKeyId: 'test-key-v1',
    })
    mocks.bindRegisteredArchitectPlanEntry.mockResolvedValue('00000000-0000-4000-8000-000000000040')
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-executor-test-'))
  })

  afterEach(async () => {
    if (tempRoot) await fs.rm(tempRoot, { recursive: true, force: true })
  })

  it('resolves protected prompt fragments only into the claimed run in memory', async () => {
    const bindingFingerprint = `sha256:${'a'.repeat(64)}`
    const references = [{
      schemaVersion: 1 as const,
      planArtifactId: '00000000-0000-4000-8000-000000000041',
      planVersion: '1',
      entryId: 'overlay:mcp-requirement-v1-test-1:frontend',
      digestKeyId: 'test-key-v1',
      contentDigest: `hmac-sha256:${'b'.repeat(64)}`,
      requirementKey: 'mcp-requirement-v1-test-1',
      bindingFingerprint,
    }, {
      schemaVersion: 1 as const,
      planArtifactId: '00000000-0000-4000-8000-000000000041',
      planVersion: '1',
      entryId: 'subtask:inspect:frontend',
      digestKeyId: 'test-key-v1',
      contentDigest: `hmac-sha256:${'c'.repeat(64)}`,
      requirementKey: 'mcp-requirement-v1-test-1',
      bindingFingerprint,
    }]
    const registrationIds = [
      '00000000-0000-4000-8000-000000000052',
      '00000000-0000-4000-8000-000000000053',
    ]
    mocks.bindRegisteredArchitectPlanEntry
      .mockResolvedValueOnce('00000000-0000-4000-8000-000000000042')
      .mockResolvedValueOnce('00000000-0000-4000-8000-000000000043')
    mocks.resolveRegisteredArchitectPlanEntry
      .mockResolvedValueOnce({ entryId: references[0].entryId, content: 'Use the approved issue summary only.' })
      .mockResolvedValueOnce({
        entryId: references[1].entryId,
        content: JSON.stringify({ id: 'inspect', agent: 'frontend', mcpCapabilities: ['github.issues.read'] }),
      })
    const fullContext = context({
      workPackage: {
        ...context().workPackage,
        metadata: {
          repositoryWrites: false,
          architectPlanEntryRegistrationIds: registrationIds,
          mcpPromptContextPolicy: { schemaVersion: 1, state: 'protected_references_available' },
        },
      },
    })
    const preflight = {
      ...fullContext,
      filesystemRuntime: { schemaVersion: 1, runtimeIssued: false, status: 'not_requested' },
      projectFilesystemDecision: fullContext.projectFilesystemDecision ?? null,
    } as WorkPackageExecutionPreflight & { validatedProjectRoot?: string }
    delete preflight.validatedProjectRoot
    const assertOwned = vi.fn().mockResolvedValue(undefined)

    const resolved = await resolveProtectedArchitectPlanContext(preflight, {
      agentRunId: fullContext.agentRunId!,
      assertS4LifecycleOwned: assertOwned,
    })

    expect(assertOwned).toHaveBeenCalledTimes(5)
    expect(mocks.bindRegisteredArchitectPlanEntry).toHaveBeenNthCalledWith(1, expect.objectContaining({
      agentRunId: fullContext.agentRunId,
      registrationId: registrationIds[0],
    }))
    expect(resolved.workPackage.metadata).toMatchObject({
      promptOverlay: 'Use the approved issue summary only.',
      mcpAwareSubtasks: [expect.objectContaining({ id: 'inspect' })],
    })
    expect(resolved.workPackage.metadata).not.toHaveProperty('architectPlanEntryRegistrationIds')
    expect(resolved.workPackage.metadata).not.toHaveProperty('mcpPromptContextPolicy')
    expect(fullContext.workPackage.metadata).toHaveProperty('architectPlanEntryRegistrationIds')
  })

  it('fails closed before binding malformed protected prompt references', async () => {
    const fullContext = context({
      workPackage: {
        ...context().workPackage,
        metadata: {
          architectPlanEntryRegistrationIds: ['not-a-registration-id'],
        },
      },
    })
    const preflight = {
      ...fullContext,
      filesystemRuntime: { schemaVersion: 1, runtimeIssued: false, status: 'not_requested' },
      projectFilesystemDecision: fullContext.projectFilesystemDecision ?? null,
    } as WorkPackageExecutionPreflight & { validatedProjectRoot?: string }
    delete preflight.validatedProjectRoot

    await expect(resolveProtectedArchitectPlanContext(preflight, {
      agentRunId: fullContext.agentRunId!,
    })).rejects.toThrow(/invalid registration set/i)
    expect(mocks.bindRegisteredArchitectPlanEntry).not.toHaveBeenCalled()
  })

  it('treats a package with no approved registration property as having no protected context', async () => {
    const fullContext = context({
      workPackage: {
        ...context().workPackage,
        metadata: { repositoryWrites: false },
      },
    })
    const preflight = {
      ...fullContext,
      filesystemRuntime: { schemaVersion: 1, runtimeIssued: false, status: 'not_requested' },
      projectFilesystemDecision: fullContext.projectFilesystemDecision ?? null,
    } as WorkPackageExecutionPreflight & { validatedProjectRoot?: string }
    delete preflight.validatedProjectRoot

    await expect(resolveProtectedArchitectPlanContext(preflight, {
      agentRunId: fullContext.agentRunId!,
    })).resolves.toBe(preflight)
    expect(mocks.bindRegisteredArchitectPlanEntry).not.toHaveBeenCalled()
    expect(mocks.resolveRegisteredArchitectPlanEntry).not.toHaveBeenCalled()
  })

})
