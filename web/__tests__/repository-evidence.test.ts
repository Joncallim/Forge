import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile as execFileCallback } from 'node:child_process'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  buildRepositoryExecutionContext,
  detectProjectValidationCommands,
  isRepositoryAffectingWorkPackage,
  recordScopedCommandAudit,
  redactCommandOutput,
  runScopedRepositoryCommand,
  scopedCommandRisk,
  type RepositoryEvidenceProject,
  type RepositoryEvidenceTask,
  type RepositoryEvidenceWorkPackage,
} from '@/worker/repository-evidence'
import {
  hostRepositoryWritePolicyState,
  isHostRepositoryWritesEnabled,
  isRepositoryWritePackage,
  shouldApplyHostRepositoryWrites,
} from '@/worker/repository-edit-policy'

const execFile = promisify(execFileCallback)
let tempRoot = ''

function fixtureSecret(...parts: string[]) {
  return parts.join('')
}

const project = (localPath: string | null, overrides: Partial<RepositoryEvidenceProject> = {}): RepositoryEvidenceProject => ({
  id: 'project-1',
  name: 'Forge Fixture',
  githubRepo: 'Joncallim/Forge-Fixture',
  localPath,
  defaultBranch: 'main',
  ...overrides,
})

const task = (overrides: Partial<RepositoryEvidenceTask> = {}): RepositoryEvidenceTask => ({
  id: 'task-12345678',
  title: 'Implement safe change',
  githubBranch: null,
  ...overrides,
})

const workPackage = (
  overrides: Partial<RepositoryEvidenceWorkPackage> = {},
): RepositoryEvidenceWorkPackage => ({
  id: 'pkg-12345678',
  title: 'Backend package',
  assignedRole: 'backend',
  metadata: {},
  requiredCapabilities: {},
  ...overrides,
})

async function initRepo(dir: string) {
  await execFile('git', ['init', '-b', 'main'], { cwd: dir })
  await execFile('git', ['config', 'user.email', 'forge@example.com'], { cwd: dir })
  await execFile('git', ['config', 'user.name', 'Forge Test'], { cwd: dir })
  await fs.writeFile(path.join(dir, 'README.md'), 'ready\n')
  await execFile('git', ['add', 'README.md'], { cwd: dir })
  await execFile('git', ['commit', '-m', 'initial'], { cwd: dir })
  await execFile('git', ['remote', 'add', 'origin', 'https://github.com/example/repo.git'], { cwd: dir })
}

async function withHostRepositoryWrites<T>(value: string, fn: () => Promise<T>): Promise<T> {
  const previous = process.env.FORGE_HOST_REPOSITORY_WRITES
  process.env.FORGE_HOST_REPOSITORY_WRITES = value
  try {
    return await fn()
  } finally {
    if (previous === undefined) delete process.env.FORGE_HOST_REPOSITORY_WRITES
    else process.env.FORGE_HOST_REPOSITORY_WRITES = previous
  }
}

describe('repository execution context', () => {
  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-repo-evidence-'))
  })

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true })
  })

  it('resolves a ready Git repository', async () => {
    await initRepo(tempRoot)

    const context = await buildRepositoryExecutionContext({
      project: project(tempRoot),
      task: task(),
      workPackage: workPackage(),
    })

    expect(context).toMatchObject({
      status: 'ready',
      pathExists: true,
      isGitRepository: true,
      currentBranch: 'main',
      baseBranch: 'main',
      isDirty: false,
      hasRemote: true,
      branchCollision: false,
      blockedReason: null,
    })
    expect(context.intendedTaskBranch).toMatch(/^forge\/task-12345678-backend-package/)
  })

  it('uses the prevalidated project root instead of a stale stored local path', async () => {
    await initRepo(tempRoot)

    const context = await buildRepositoryExecutionContext({
      project: project(path.join(tempRoot, 'stale-link')),
      task: task(),
      validatedProjectRoot: tempRoot,
      workPackage: workPackage(),
    })

    expect(context.status).toBe('ready')
    expect(context.projectLocalPath).toBe(path.resolve(tempRoot))
  })

  it('blocks missing local paths', async () => {
    const context = await buildRepositoryExecutionContext({
      project: project(path.join(tempRoot, 'missing')),
      task: task(),
      workPackage: workPackage(),
    })

    expect(context).toMatchObject({
      status: 'blocked',
      pathExists: false,
      isGitRepository: false,
      blockedReason: expect.stringMatching(/does not exist/i),
    })
  })

  it('allows non-Git directories because execution is sandbox-only by default', async () => {
    const context = await buildRepositoryExecutionContext({
      project: project(tempRoot),
      task: task(),
      workPackage: workPackage(),
    })

    expect(context).toMatchObject({
      status: 'ready',
      pathExists: true,
      isGitRepository: false,
      blockedReason: null,
    })
  })

  it('allows local-only non-Git project directories without requiring sandbox-only mode', async () => {
    await withHostRepositoryWrites('1', async () => {
      const context = await buildRepositoryExecutionContext({
        project: project(tempRoot, { githubRepo: null }),
        task: task(),
        workPackage: workPackage(),
      })

      expect(context).toMatchObject({
        status: 'ready',
        pathExists: true,
        isGitRepository: false,
        hasRemote: false,
        blockedReason: null,
      })
      expect(context.projectLocalPath).toBe(tempRoot)
      expect(context.baseBranch).toBe('main')
    })
  })

  it('does not gate sandbox execution on dirty trees, missing remotes, or branch collisions', async () => {
    await initRepo(tempRoot)
    await execFile('git', ['remote', 'remove', 'origin'], { cwd: tempRoot })
    await fs.writeFile(path.join(tempRoot, 'dirty.txt'), 'dirty\n')
    const pkg = workPackage({ title: 'Colliding Branch' })
    const expected = 'forge/task-12345678-colliding-branch'
    await execFile('git', ['branch', expected], { cwd: tempRoot })

    const context = await buildRepositoryExecutionContext({
      project: project(tempRoot),
      task: task(),
      workPackage: pkg,
    })

    expect(context.status).toBe('ready')
    expect(context.isDirty).toBe(true)
    expect(context.hasRemote).toBe(false)
    expect(context.branchCollision).toBe(true)
    expect(context.blockedReason).toBeNull()

    await execFile('git', ['add', 'dirty.txt'], { cwd: tempRoot })
    await execFile('git', ['commit', '-m', 'clean dirty fixture'], { cwd: tempRoot })

    const cleanContext = await buildRepositoryExecutionContext({
      project: project(tempRoot),
      task: task(),
      workPackage: pkg,
    })

    expect(cleanContext.status).toBe('ready')
    expect(cleanContext.isDirty).toBe(false)
    expect(cleanContext.hasRemote).toBe(false)
    expect(cleanContext.branchCollision).toBe(true)
    expect(cleanContext.blockedReason).toBeNull()
  })

  it('allows dirty working trees when host repository writes are disabled', async () => {
    await initRepo(tempRoot)
    await fs.writeFile(path.join(tempRoot, 'dirty.txt'), 'dirty\n')

    await withHostRepositoryWrites('0', async () => {
      const context = await buildRepositoryExecutionContext({
        project: project(tempRoot),
        task: task(),
        workPackage: workPackage(),
      })

      expect(context.status).toBe('ready')
      expect(context.isDirty).toBe(true)
      expect(context.blockedReason).toBeNull()
    })
  })

  it('allows sandbox-only execution for existing non-Git project directories', async () => {
    await withHostRepositoryWrites('0', async () => {
      const context = await buildRepositoryExecutionContext({
        project: project(tempRoot),
        task: task(),
        workPackage: workPackage(),
      })

      expect(context.status).toBe('ready')
      expect(context.projectLocalPath).toBe(tempRoot)
      expect(context.pathExists).toBe(true)
      expect(context.isGitRepository).toBe(false)
      expect(context.hasRemote).toBe(false)
      expect(context.isDirty).toBeNull()
      expect(context.intendedTaskBranch).toBeNull()
      expect(context.branchCollision).toBeNull()
      expect(context.baseBranch).toBe('main')
      expect(context.blockedReason).toBeNull()
    })
  })

  it('ignores Forge task-run artifacts when checking dirty working trees', async () => {
    await initRepo(tempRoot)
    await fs.mkdir(path.join(tempRoot, '.forge', 'task-runs', 'task-1', 'pkg-1'), { recursive: true })
    await fs.writeFile(path.join(tempRoot, '.forge', 'task-runs', 'task-1', 'pkg-1', 'result.md'), 'artifact\n')

    const context = await buildRepositoryExecutionContext({
      project: project(tempRoot),
      task: task(),
      workPackage: workPackage(),
    })

    expect(context.status).toBe('ready')
    expect(context.isDirty).toBe(false)
    expect(context.blockedReason).toBeNull()
  })

  it('ignores tracked Forge task-run artifact updates when checking dirty working trees', async () => {
    await initRepo(tempRoot)
    const artifactPath = path.join(tempRoot, '.forge', 'task-runs', 'task-1', 'pkg-1', 'result.md')
    await fs.mkdir(path.dirname(artifactPath), { recursive: true })
    await fs.writeFile(artifactPath, 'first artifact\n')
    await execFile('git', ['add', '.forge/task-runs/task-1/pkg-1/result.md'], { cwd: tempRoot })
    await execFile('git', ['commit', '-m', 'track forge artifact fixture'], { cwd: tempRoot })
    await fs.writeFile(artifactPath, 'updated artifact\n')

    const context = await buildRepositoryExecutionContext({
      project: project(tempRoot),
      task: task(),
      workPackage: workPackage(),
    })

    expect(context.status).toBe('ready')
    expect(context.isDirty).toBe(false)
    expect(context.blockedReason).toBeNull()
  })

  it('allows staged renames from Forge task-run artifacts into product paths when host repository writes are disabled', async () => {
    await initRepo(tempRoot)
    const artifactPath = path.join(tempRoot, '.forge', 'task-runs', 'task-1', 'pkg-1', 'result.md')
    await fs.mkdir(path.dirname(artifactPath), { recursive: true })
    await fs.writeFile(artifactPath, 'first artifact\n')
    await execFile('git', ['add', '.forge/task-runs/task-1/pkg-1/result.md'], { cwd: tempRoot })
    await execFile('git', ['commit', '-m', 'track forge artifact fixture'], { cwd: tempRoot })
    await fs.mkdir(path.join(tempRoot, 'src'), { recursive: true })
    await execFile('git', ['mv', '.forge/task-runs/task-1/pkg-1/result.md', 'src/app.ts'], { cwd: tempRoot })

    await withHostRepositoryWrites('0', async () => {
      const context = await buildRepositoryExecutionContext({
        project: project(tempRoot),
        task: task(),
        workPackage: workPackage(),
      })

      expect(context.status).toBe('ready')
      expect(context.isDirty).toBe(true)
      expect(context.statusShort).toContain('src/app.ts')
      expect(context.blockedReason).toBeNull()
    })
  })

  it('allows dirty product paths even after many ignored Forge task-run artifacts when host repository writes are disabled', async () => {
    await initRepo(tempRoot)
    await fs.mkdir(path.join(tempRoot, '.forge', 'task-runs', 'overflow'), { recursive: true })
    for (let index = 0; index < 500; index += 1) {
      await fs.writeFile(
        path.join(
          tempRoot,
          '.forge',
          'task-runs',
          'overflow',
          `artifact-${String(index).padStart(4, '0')}-${'x'.repeat(40)}.md`,
        ),
        'artifact\n',
      )
    }
    await fs.mkdir(path.join(tempRoot, 'src'), { recursive: true })
    await fs.writeFile(path.join(tempRoot, 'src', 'late-dirty.ts'), 'dirty\n')

    await withHostRepositoryWrites('0', async () => {
      const context = await buildRepositoryExecutionContext({
        project: project(tempRoot),
        task: task(),
        workPackage: workPackage(),
      })

      expect(context.status).toBe('ready')
      expect(context.isDirty).toBe(true)
      expect(context.statusShort).toContain('src/late-dirty.ts')
      expect(context.statusShort).not.toContain('.forge/task-runs/overflow')
      expect(context.blockedReason).toBeNull()
    })
  })

  it('allows missing remotes when host repository writes are disabled', async () => {
    await initRepo(tempRoot)
    await execFile('git', ['remote', 'remove', 'origin'], { cwd: tempRoot })

    await withHostRepositoryWrites('0', async () => {
      const context = await buildRepositoryExecutionContext({
        project: project(tempRoot),
        task: task(),
        workPackage: workPackage(),
      })

      expect(context.status).toBe('ready')
      expect(context.hasRemote).toBe(false)
      expect(context.blockedReason).toBeNull()
    })
  })

  it('allows intended branch collisions when host repository writes are disabled', async () => {
    await initRepo(tempRoot)
    const pkg = workPackage({ title: 'Colliding Branch' })
    const expected = 'forge/task-12345678-colliding-branch'
    await execFile('git', ['branch', expected], { cwd: tempRoot })

    await withHostRepositoryWrites('0', async () => {
      const context = await buildRepositoryExecutionContext({
        project: project(tempRoot),
        task: task(),
        workPackage: pkg,
      })

      expect(context.status).toBe('ready')
      expect(context.branchCollision).toBe(true)
      expect(context.intendedTaskBranch).toBe(expected)
      expect(context.blockedReason).toBeNull()
    })
  })

  it('allows work packages to opt out of repository evidence', () => {
    expect(isRepositoryAffectingWorkPackage(workPackage())).toBe(true)
    expect(isRepositoryAffectingWorkPackage(workPackage({ metadata: { repositoryWrites: false } }))).toBe(false)
    expect(isRepositoryAffectingWorkPackage(workPackage({ assignedRole: 'reviewer' }))).toBe(false)
    expect(isRepositoryAffectingWorkPackage(workPackage({ assignedRole: 'security-review' }))).toBe(false)
  })
})

describe('repository edit policy', () => {
  it('keeps host writes unavailable while distinguishing explicit enable requests', () => {
    expect(hostRepositoryWritePolicyState({})).toMatchObject({
      available: false,
      enabled: false,
      recognized: true,
      requested: false,
      source: null,
    })

    for (const value of ['0', 'false', 'off', 'no', 'disabled']) {
      expect(hostRepositoryWritePolicyState({ FORGE_HOST_REPOSITORY_WRITES: value })).toMatchObject({
        enabled: false,
        recognized: true,
        requested: false,
      })
    }

    for (const value of ['1', 'true', 'on', 'yes', 'enabled']) {
      expect(hostRepositoryWritePolicyState({ FORGE_HOST_REPOSITORY_WRITES: value })).toMatchObject({
        available: false,
        enabled: false,
        recognized: true,
        requested: true,
        source: 'FORGE_HOST_REPOSITORY_WRITES',
      })
    }

    expect(hostRepositoryWritePolicyState({ FORGE_REPOSITORY_EDITS: 'true' })).toMatchObject({
      enabled: false,
      requested: true,
      source: 'FORGE_REPOSITORY_EDITS',
    })
    expect(hostRepositoryWritePolicyState({ FORGE_HOST_REPOSITORY_WRITES: 'maybe' })).toMatchObject({
      enabled: false,
      recognized: false,
      requested: false,
    })
    expect(isHostRepositoryWritesEnabled({ FORGE_HOST_REPOSITORY_WRITES: 'true' })).toBe(false)
    expect(shouldApplyHostRepositoryWrites(workPackage(), {
      FORGE_HOST_REPOSITORY_WRITES: 'true',
    })).toBe(true)
    expect(shouldApplyHostRepositoryWrites(workPackage(), {})).toBe(false)
  })

  it('normalizes display-style review and security roles as non-writing packages', () => {
    for (const assignedRole of ['Security Reviewer', 'security_review', 'Code Reviewer', 'Review']) {
      expect(isRepositoryWritePackage({
        assignedRole,
        metadata: {},
        requiredCapabilities: {},
      })).toBe(false)
    }
  })
})

describe('scoped repository command runner', () => {
  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-command-audit-'))
    await initRepo(tempRoot)
  })

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true })
  })

  it('requires an explicit cwd', async () => {
    await expect(runScopedRepositoryCommand({ cwd: '', command: 'git', argv: ['status', '--short'] }))
      .rejects.toThrow(/cwd is required/i)
  })

  it('runs allowed read-only Git commands', async () => {
    const result = await runScopedRepositoryCommand({
      cwd: tempRoot,
      command: 'git',
      argv: ['status', '--short'],
    })

    expect(result.riskClass).toBe('read_only')
    expect(result.exitCode).toBe(0)
    expect(result.outputSummary).toBe('')

    const headDiffResult = await runScopedRepositoryCommand({
      cwd: tempRoot,
      command: 'git',
      argv: ['diff', '--stat', 'HEAD', '--'],
    })

    expect(headDiffResult.riskClass).toBe('read_only')
    expect(headDiffResult.exitCode).toBe(0)
  })

  it('detects local validation commands but blocks host package-manager execution', async () => {
    await fs.writeFile(path.join(tempRoot, 'package.json'), JSON.stringify({
      scripts: {
        test: 'node -e "require(\\"fs\\").writeFileSync(\\"host-validation-ran\\", \\"yes\\")"',
        lint: 'node -e "process.exit(1)"',
      },
    }))

    await expect(detectProjectValidationCommands(tempRoot)).resolves.toEqual([
      ['npm', 'test'],
      ['npm', 'run', 'lint'],
    ])
    await expect(scopedCommandRisk({ cwd: tempRoot, command: 'npm', argv: ['test'] }))
      .rejects.toThrow(/host package manager validation/i)
    await expect(runScopedRepositoryCommand({ cwd: tempRoot, command: 'npm', argv: ['test'] }))
      .rejects.toThrow(/host package manager validation/i)

    await expect(fs.stat(path.join(tempRoot, 'host-validation-ran'))).rejects.toThrow()
  })

  it('blocks unsupported and dangerous commands', async () => {
    await expect(runScopedRepositoryCommand({ cwd: tempRoot, command: 'python', argv: ['-c', 'print(1)'] }))
      .rejects.toThrow(/not allowed/i)
    await expect(runScopedRepositoryCommand({ cwd: tempRoot, command: 'gh', argv: ['pr', 'create'] }))
      .rejects.toThrow(/GitHub write/i)
    await expect(runScopedRepositoryCommand({ cwd: tempRoot, command: 'git', argv: ['push'] }))
      .rejects.toThrow(/remote Git mutation/i)
    await expect(runScopedRepositoryCommand({ cwd: tempRoot, command: 'rm', argv: ['-rf', '.'] }))
      .rejects.toThrow(/destructive filesystem/i)
    await expect(runScopedRepositoryCommand({ cwd: tempRoot, command: 'sh', argv: ['-c', 'git status | cat'] }))
      .rejects.toThrow(/shell/i)
    await expect(runScopedRepositoryCommand({ cwd: tempRoot, command: 'npm', argv: ['install'] }))
      .rejects.toThrow(/package install/i)
  })

  it('redacts secrets from command output summaries', () => {
    const bearerToken = fixtureSecret('sk', '-live', '-secret')
    const githubToken = fixtureSecret('ghp', '_example', 'value1234567890')
    const privateKeyBegin = fixtureSecret('-----BEGIN ', 'OPENSSH PRIVATE KEY-----')
    const privateKeyEnd = fixtureSecret('-----END ', 'OPENSSH PRIVATE KEY-----')
    const redacted = redactCommandOutput([
      `Authorization: Bearer ${bearerToken}`,
      `token=${githubToken}`,
      'OPENAI_API_KEY=plain-openai-key',
      'AWS_SECRET_ACCESS_KEY: "plain-aws-secret"',
      'origin\thttps://user:remote-secret@example.com/owner/repo.git (fetch)',
      privateKeyBegin,
      'abc',
      privateKeyEnd,
    ].join('\n'))

    expect(redacted).not.toContain(bearerToken)
    expect(redacted).not.toContain(githubToken)
    expect(redacted).not.toContain('plain-openai-key')
    expect(redacted).not.toContain('plain-aws-secret')
    expect(redacted).not.toContain('remote-secret')
    expect(redacted).not.toContain('abc')
    expect(redacted).toContain('[REDACTED_TOKEN]')
    expect(redacted).toContain('https://[REDACTED_USERINFO]@example.com/owner/repo.git')
    expect(redacted).toContain('[REDACTED_PRIVATE_KEY]')
  })

  it('persists command audit records through the supplied sink', async () => {
    const sink = vi.fn(async () => ({ id: 'audit-1' }))
    const result = await runScopedRepositoryCommand({
      cwd: tempRoot,
      command: 'git',
      argv: ['branch', '--show-current'],
    })

    await recordScopedCommandAudit({
      result,
      taskId: 'task-1',
      workPackageId: 'pkg-1',
      agentRunId: 'run-1',
      artifactId: 'artifact-1',
      auditSink: sink,
    })

    expect(sink).toHaveBeenCalledWith(expect.objectContaining({
      taskId: 'task-1',
      workPackageId: 'pkg-1',
      agentRunId: 'run-1',
      artifactId: 'artifact-1',
      cwd: tempRoot,
      command: 'git',
      argv: ['branch', '--show-current'],
      riskClass: 'read_only',
      exitCode: 0,
      outputSummary: 'main',
    }))
  })
})
