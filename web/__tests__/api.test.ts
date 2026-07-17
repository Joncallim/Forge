/**
 * Suite 3 — REST endpoint contracts
 *
 * Tests HTTP contract behaviours by importing route handlers directly and
 * constructing Request objects manually (no live network or DB).
 *
 * Mocks:
 *  - @/lib/session  — getSession returns null or a fake session
 *  - @/db           — mock db object
 *  - @/lib/redis    — mock redis object
 *  - @/lib/providers/registry — listActiveProviders
 */

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { getTableName } from 'drizzle-orm'
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'

// ---------------------------------------------------------------------------
// Module-level mocks
// ---------------------------------------------------------------------------

// Session mock
const mockGetSession = vi.fn()
vi.mock('@/lib/session', () => ({
  getSession: mockGetSession,
  createSession: vi.fn(),
  destroySession: vi.fn(),
  sessionCookieOptions: vi.fn().mockReturnValue({
    name: 'forge_session',
    httpOnly: true,
    secure: false,
    sameSite: 'strict',
    maxAge: 604800,
    path: '/',
  }),
}))

// Existing route-contract cases exercise behavior behind the release gate.
// The gate itself and its fail-closed route placement have a focused suite.
const mockGuardEpic172ProjectManagementIngress = vi.fn().mockResolvedValue(null)
vi.mock('@/lib/projects/epic-172-project-ingress', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/projects/epic-172-project-ingress')>(),
  guardEpic172ProjectManagementIngress: mockGuardEpic172ProjectManagementIngress,
}))

// DB mock — returns fluent chain helpers per-call
const mockDbSelect = vi.fn()
const mockDbInsert = vi.fn()
const mockDbUpdate = vi.fn()
const mockDbDelete = vi.fn()
const mockDbTransaction = vi.fn(async (callback: (tx: unknown) => unknown) =>
  callback({
    select: mockDbSelect,
    insert: mockDbInsert,
    update: mockDbUpdate,
    delete: mockDbDelete,
  }),
)

vi.mock('@/db', () => ({
  db: {
    select: mockDbSelect,
    insert: mockDbInsert,
    update: mockDbUpdate,
    delete: mockDbDelete,
    transaction: mockDbTransaction,
  },
}))

// Redis mock
const mockRedisLpush = vi.fn()
const mockRedisSet = vi.fn()
const mockRedisZadd = vi.fn()
const mockRedisExpire = vi.fn()
const mockRedisPublish = vi.fn()
const mockRedisDel = vi.fn()

vi.mock('@/lib/redis', () => ({
  redis: {
    del: mockRedisDel,
    lpush: mockRedisLpush,
    set: mockRedisSet,
    zadd: mockRedisZadd,
    expire: mockRedisExpire,
    publish: mockRedisPublish,
  },
}))

const mockExecFile = vi.fn()
vi.mock('node:child_process', () => ({
  execFile: mockExecFile,
}))

// Provider registry mock
vi.mock('@/lib/providers/registry', () => ({
  listActiveProviders: vi.fn().mockResolvedValue([]),
  getProvider: vi.fn().mockResolvedValue(null),
  getModel: vi.fn().mockResolvedValue(null),
}))

const mockDecideReviewGate = vi.fn()
vi.mock('@/worker/review-gates', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/worker/review-gates')>(),
  decideReviewGate: mockDecideReviewGate,
}))

const mockProgressWorkforce = vi.fn().mockResolvedValue({ status: 'no_ready_packages', readyPackageIds: [], claimedPackageId: null })
vi.mock('@/worker/work-package-handoff', () => ({
  progressWorkforce: mockProgressWorkforce,
}))

const mockGetGitHubStatus = vi.fn()
const mockResolveGitHubToken = vi.fn()
const mockValidateGitHubTokenEnvVar = vi.fn((rawEnvVar: string | null | undefined) => {
  const envVar = rawEnvVar?.trim()
  if (!envVar) return null
  return ['GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_PAT', 'FORGE_GITHUB_TOKEN'].includes(envVar)
    ? null
    : 'GitHub token env var must be allowlisted'
})
vi.mock('@/lib/github', () => ({
  getGitHubStatus: mockGetGitHubStatus,
  resolveGitHubToken: mockResolveGitHubToken,
  validateGitHubTokenEnvVar: mockValidateGitHubTokenEnvVar,
}))

const mockGetProjectMcpOverview = vi.fn()
const mockLoadCurrentProjectFilesystemDecision = vi.fn().mockResolvedValue(null)
vi.mock('@/lib/mcps/manager', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/mcps/manager')>()
  return {
    ...actual,
    getProjectMcpOverview: (...args: Parameters<typeof actual.getProjectMcpOverview>) => (
      mockGetProjectMcpOverview(...args) ?? actual.getProjectMcpOverview(...args)
    ),
  }
})

vi.mock('@/lib/mcps/filesystem-grant-reconciliation', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/mcps/filesystem-grant-reconciliation')>(),
  loadCurrentProjectFilesystemDecision: mockLoadCurrentProjectFilesystemDecision,
}))

// ---------------------------------------------------------------------------
// Drizzle chain factory
// ---------------------------------------------------------------------------

function chain(resolveValue: unknown) {
  const thenable: Record<string, unknown> = {
    then: (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
      Promise.resolve(resolveValue).then(onFulfilled, onRejected),
    catch: (onRejected: (e: unknown) => unknown) =>
      Promise.resolve(resolveValue).catch(onRejected),
  }
  const methods = ['from', 'where', 'limit', 'orderBy', 'groupBy', 'values', 'returning', 'set', 'offset', 'innerJoin', 'onConflictDoUpdate', 'onConflictDoNothing', 'for']
  methods.forEach((m) => { thenable[m] = () => thenable })
  return thenable
}

function rejectingChain(error: unknown) {
  const thenable: Record<string, unknown> = {
    then: (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
      Promise.reject(error).then(onFulfilled, onRejected),
    catch: (onRejected: (e: unknown) => unknown) =>
      Promise.reject(error).catch(onRejected),
  }
  const methods = ['from', 'where', 'limit', 'orderBy', 'groupBy', 'values', 'returning', 'set', 'offset', 'innerJoin', 'onConflictDoUpdate', 'onConflictDoNothing', 'for']
  methods.forEach((m) => { thenable[m] = () => thenable })
  return thenable
}

function flattenSqlChunks(value: unknown): string {
  if (typeof value === 'string') return value
  if (!value || typeof value !== 'object') return ''
  if (Array.isArray((value as { value?: unknown }).value)) {
    return ((value as { value: unknown[] }).value).filter((chunk): chunk is string => typeof chunk === 'string').join('')
  }
  if (Array.isArray((value as { queryChunks?: unknown[] }).queryChunks)) {
    return (value as { queryChunks: unknown[] }).queryChunks.map(flattenSqlChunks).join('')
  }
  return ''
}

// ---------------------------------------------------------------------------
// Fake sessions
// ---------------------------------------------------------------------------

const FAKE_SESSION = { sessionId: 'sess-123', userId: 'user-abc' }

function authRequest(path: string, init: RequestInit = {}) {
  return new Request(`http://localhost${path}`, init)
}

function nextAuthRequest(path: string, init: RequestInit = {}) {
  return Object.assign(authRequest(path, init), {
    nextUrl: new URL(`http://localhost${path}`),
  })
}

// ---------------------------------------------------------------------------
// Suite 3.1 — Auth guard: GET /api/projects returns 401 when not authenticated
// ---------------------------------------------------------------------------

describe('GET /api/projects — auth guard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockDbUpdate.mockReturnValue(chain([]))
  })

  it('returns 401 when getSession returns null', async () => {
    mockGetSession.mockResolvedValue(null)

    const { GET } = await import('@/app/api/projects/route')
    const res = await GET(authRequest('/api/projects') as never)

    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error).toBe('Unauthorized')
  })

  it('returns displayLocalPath for project list rows', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    const previousRoot = process.env.FORGE_WORKSPACE_ROOT
    const previousHome = process.env.HOME
    const fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-project-list-display-home-'))
    const workspaceRoot = path.join(fakeHome, 'Documents', 'Forge')
    const project = {
      id: 'project-list-display',
      name: 'List Display',
      githubRepo: null,
      localPath: path.join(workspaceRoot, 'projects', 'list-display'),
      githubTokenEnvVar: null,
      pmProviderConfigId: null,
      mcpConfig: {
        profile: 'default',
        requiredMcps: ['filesystem', 'github'],
        overrides: {},
      },
      grantDecisionRevision: BigInt(0),
      rootBindingRevision: BigInt(1),
      defaultBranch: 'main',
      createdAt: new Date(),
      updatedAt: new Date(),
      archivedAt: null,
    }
    process.env.HOME = fakeHome
    process.env.FORGE_WORKSPACE_ROOT = workspaceRoot
    mockDbSelect
      .mockReturnValueOnce(chain([project]))
      .mockReturnValueOnce(chain([]))

    try {
      const { GET } = await import('@/app/api/projects/route')
      const res = await GET(authRequest('/api/projects') as never)

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.projects[0]).toMatchObject({
        localPath: project.localPath,
        displayLocalPath: '~/Documents/Forge/projects/list-display',
      })
      expect(mockGuardEpic172ProjectManagementIngress).not.toHaveBeenCalled()
      expect(mockDbUpdate).not.toHaveBeenCalled()
    } finally {
      if (previousRoot === undefined) {
        delete process.env.FORGE_WORKSPACE_ROOT
      } else {
        process.env.FORGE_WORKSPACE_ROOT = previousRoot
      }
      if (previousHome === undefined) {
        delete process.env.HOME
      } else {
        process.env.HOME = previousHome
      }
      await fs.rm(fakeHome, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// Suite 3.1b — Project creation supports GitHub and local sources
// ---------------------------------------------------------------------------

describe('POST /api/projects — source handling', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockDbSelect.mockReturnValue(chain([]))
  })

  it('returns 400 when a GitHub project is missing githubRepo', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)

    const { POST } = await import('@/app/api/projects/route')
    const res = await POST(authRequest('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'GitHub project',
        source: 'github',
      }),
    }) as never)

    expect(res.status).toBe(400)
    expect(mockDbInsert).not.toHaveBeenCalled()
  })

  it('creates a local project with no githubRepo and writes forge.project.json', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    const previousRoot = process.env.FORGE_WORKSPACE_ROOT
    const parentPath = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-project-test-'))
    const localPath = path.join(parentPath, 'forge-games')
    process.env.FORGE_WORKSPACE_ROOT = parentPath
    await fs.mkdir(localPath)
    const createdProject = {
      id: 'project-local',
      name: 'Local project',
      githubRepo: null,
      localPath,
      githubTokenEnvVar: null,
      pmProviderConfigId: null,
      defaultBranch: 'main',
      createdAt: new Date(),
      updatedAt: new Date(),
      archivedAt: null,
    }
    mockDbInsert.mockReturnValue(chain([createdProject]))

    try {
      const { POST } = await import('@/app/api/projects/route')
      const res = await POST(authRequest('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Local project',
          source: 'local',
          localPath,
          defaultBranch: 'main',
        }),
      }) as never)

      expect(res.status).toBe(201)
      const body = await res.json()
      expect(body.project.githubRepo).toBeNull()
      expect(body.project.localPath).toBe(localPath)

      const projectConfig = JSON.parse(
        await fs.readFile(path.join(localPath, 'forge.project.json'), 'utf-8'),
      ) as {
        projectId: string
        name: string
        localPath: string
        mcpProfile: string
        requiredMcps: string[]
        mcpOverrides: Record<string, unknown>
      }
      expect(projectConfig.projectId).toBe('project-local')
      expect(projectConfig.name).toBe('Local project')
      expect(projectConfig.localPath).toMatch(/forge-games$/)
      expect(projectConfig.mcpProfile).toBe('default')
      expect(projectConfig.requiredMcps).toEqual(['filesystem', 'github'])
      expect(projectConfig.mcpOverrides).toEqual({})
    } finally {
      if (previousRoot === undefined) {
        delete process.env.FORGE_WORKSPACE_ROOT
      } else {
        process.env.FORGE_WORKSPACE_ROOT = previousRoot
      }
      await fs.rm(parentPath, { recursive: true, force: true })
    }
  })

  it('accepts a displayed local project path and returns displayLocalPath', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    const previousRoot = process.env.FORGE_WORKSPACE_ROOT
    const previousHome = process.env.HOME
    const fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-project-display-home-'))
    const workspaceRoot = path.join(fakeHome, 'Documents', 'Forge')
    const displayLocalPath = '~/Documents/Forge/projects/display-project'
    const expectedLocalPath = path.join(workspaceRoot, 'projects', 'display-project')
    process.env.HOME = fakeHome
    process.env.FORGE_WORKSPACE_ROOT = workspaceRoot
    const createdProject = {
      id: 'project-display-local',
      name: 'Display project',
      githubRepo: null,
      localPath: expectedLocalPath,
      githubTokenEnvVar: null,
      pmProviderConfigId: null,
      defaultBranch: 'main',
      createdAt: new Date(),
      updatedAt: new Date(),
      archivedAt: null,
    }
    mockDbInsert.mockReturnValue(chain([createdProject]))

    try {
      const { POST } = await import('@/app/api/projects/route')
      const res = await POST(authRequest('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Display project',
          source: 'local',
          localPath: displayLocalPath,
          defaultBranch: 'main',
        }),
      }) as never)

      expect(res.status).toBe(201)
      const body = await res.json()
      expect(body.project.localPath).toBe(expectedLocalPath)
      expect(body.project.displayLocalPath).toBe(displayLocalPath)
      await expect(fs.stat(expectedLocalPath)).resolves.toMatchObject({})
    } finally {
      if (previousRoot === undefined) {
        delete process.env.FORGE_WORKSPACE_ROOT
      } else {
        process.env.FORGE_WORKSPACE_ROOT = previousRoot
      }
      if (previousHome === undefined) {
        delete process.env.HOME
      } else {
        process.env.HOME = previousHome
      }
      await fs.rm(fakeHome, { recursive: true, force: true })
    }
  })

  it('rejects local project paths outside the active workspace', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    const previousRoot = process.env.FORGE_WORKSPACE_ROOT
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-local-boundary-'))
    const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-local-outside-'))
    process.env.FORGE_WORKSPACE_ROOT = workspaceRoot

    try {
      const { POST } = await import('@/app/api/projects/route')
      const res = await POST(authRequest('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'External project',
          source: 'local',
          localPath: path.join(outsideRoot, 'external-project'),
          defaultBranch: 'main',
        }),
      }) as never)

      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toMatch(/active Forge workspace|workspace root/i)
      expect(mockDbInsert).not.toHaveBeenCalled()
    } finally {
      if (previousRoot === undefined) {
        delete process.env.FORGE_WORKSPACE_ROOT
      } else {
        process.env.FORGE_WORKSPACE_ROOT = previousRoot
      }
      await fs.rm(workspaceRoot, { recursive: true, force: true })
      await fs.rm(outsideRoot, { recursive: true, force: true })
    }
  })

  it('uses an allowlisted clone request githubTokenEnvVar through askpass without persisting the token', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    const previousRoot = process.env.FORGE_WORKSPACE_ROOT
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-clone-env-'))
    process.env.FORGE_WORKSPACE_ROOT = workspaceRoot
    const expectedLocalPath = path.join(workspaceRoot, 'projects', 'private-repo')
    const token = 'placeholder@clone:token/with-specials'
    const createdProject = {
      id: 'project-clone-env',
      name: 'Private Repo',
      githubRepo: 'owner/private-repo',
      localPath: expectedLocalPath,
      githubTokenEnvVar: 'GITHUB_TOKEN',
      pmProviderConfigId: null,
      defaultBranch: 'main',
      createdAt: new Date(),
      updatedAt: new Date(),
      archivedAt: null,
    }
    mockResolveGitHubToken.mockResolvedValue({ token, source: 'env' })
    mockExecFile.mockImplementation((_command, args: string[], _options, callback) => {
      const run = async () => {
        if (args[0] === 'clone') {
          const cloneUrl = args[3]
          const destination = args[4]
          await fs.mkdir(path.join(destination, '.git'), { recursive: true })
          await fs.writeFile(
            path.join(destination, '.git', 'config'),
            `[remote "origin"]\n\turl = ${cloneUrl}\n`,
          )
          return
        }
        if (args[0] === '-C' && args[2] === 'remote' && args[3] === 'set-url') {
          const destination = args[1]
          const cloneUrl = args[5]
          await fs.mkdir(path.join(destination, '.git'), { recursive: true })
          await fs.writeFile(
            path.join(destination, '.git', 'config'),
            `[remote "origin"]\n\turl = ${cloneUrl}\n`,
          )
          return
        }
        throw new Error(`Unexpected git command: ${args.join(' ')}`)
      }
      run().then(
        () => callback(null, '', ''),
        (err) => callback(err),
      )
      return undefined
    })
    mockDbInsert.mockReturnValue(chain([createdProject]))

    try {
      const { POST } = await import('@/app/api/projects/route')
      const res = await POST(authRequest('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Private Repo',
          source: 'clone',
          githubRepo: 'owner/private-repo',
          localPath: 'private-repo',
          githubTokenEnvVar: 'GITHUB_TOKEN',
          defaultBranch: 'main',
        }),
      }) as never)

      expect(res.status).toBe(201)
      expect(mockResolveGitHubToken).toHaveBeenCalledWith({ envVar: 'GITHUB_TOKEN' })
      const cloneCall = mockExecFile.mock.calls.find((call) => (call[1] as string[])[0] === 'clone')
      expect(cloneCall).toBeTruthy()
      expect(cloneCall?.[1]).toEqual([
        'clone',
        '--depth',
        '1',
        'https://github.com/owner/private-repo.git',
        expectedLocalPath,
      ])
      expect(cloneCall?.[2]).toEqual(expect.objectContaining({
        env: expect.objectContaining({
          GIT_ASKPASS: expect.stringContaining('forge-git-askpass-'),
          GIT_TERMINAL_PROMPT: '0',
        }),
      }))
      const askpassPath = (cloneCall?.[2] as { env?: NodeJS.ProcessEnv } | undefined)?.env?.GIT_ASKPASS
      expect(askpassPath).toBeTruthy()
      await expect(fs.stat(path.dirname(askpassPath as string))).rejects.toMatchObject({ code: 'ENOENT' })
      const setUrlCall = mockExecFile.mock.calls.find((call) => (call[1] as string[])[2] === 'remote')
      expect(setUrlCall?.[1]).toEqual([
        '-C',
        expectedLocalPath,
        'remote',
        'set-url',
        'origin',
        'https://github.com/owner/private-repo.git',
      ])
      const serializedExecCalls = JSON.stringify(mockExecFile.mock.calls)
      expect(serializedExecCalls).not.toContain(token)
      expect(serializedExecCalls).not.toContain(encodeURIComponent(token))
      const gitConfig = await fs.readFile(path.join(expectedLocalPath, '.git', 'config'), 'utf-8')
      expect(gitConfig).toContain('url = https://github.com/owner/private-repo.git')
      expect(gitConfig).not.toContain(token)
      expect(gitConfig).not.toContain(encodeURIComponent(token))
    } finally {
      if (previousRoot === undefined) {
        delete process.env.FORGE_WORKSPACE_ROOT
      } else {
        process.env.FORGE_WORKSPACE_ROOT = previousRoot
      }
      await fs.rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('rejects existing clone destinations without deleting a pre-existing empty directory', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    const previousRoot = process.env.FORGE_WORKSPACE_ROOT
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-clone-existing-'))
    process.env.FORGE_WORKSPACE_ROOT = workspaceRoot
    const existingDestination = path.join(workspaceRoot, 'projects', 'private-repo')
    await fs.mkdir(existingDestination, { recursive: true })

    try {
      const { POST } = await import('@/app/api/projects/route')
      const res = await POST(authRequest('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Private Repo',
          source: 'clone',
          githubRepo: 'owner/private-repo',
          localPath: 'private-repo',
          githubTokenEnvVar: 'GITHUB_TOKEN',
        }),
      }) as never)

      expect(res.status).toBe(409)
      const body = await res.json()
      expect(body.error).toMatch(/already exists/i)
      expect(mockResolveGitHubToken).not.toHaveBeenCalled()
      expect(mockExecFile).not.toHaveBeenCalled()
      await expect(fs.stat(existingDestination)).resolves.toMatchObject({})
    } finally {
      if (previousRoot === undefined) {
        delete process.env.FORGE_WORKSPACE_ROOT
      } else {
        process.env.FORGE_WORKSPACE_ROOT = previousRoot
      }
      await fs.rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('rejects clone requests that try to read arbitrary server environment variables', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    const previousRoot = process.env.FORGE_WORKSPACE_ROOT
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-clone-env-reject-'))
    process.env.FORGE_WORKSPACE_ROOT = workspaceRoot

    try {
      const { POST } = await import('@/app/api/projects/route')
      const res = await POST(authRequest('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Private Repo',
          source: 'clone',
          githubRepo: 'owner/private-repo',
          localPath: 'private-repo',
          githubTokenEnvVar: 'SESSION_SECRET',
          defaultBranch: 'main',
        }),
      }) as never)

      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toMatch(/allowlisted|GitHub token env var/i)
      expect(mockResolveGitHubToken).not.toHaveBeenCalled()
      expect(mockExecFile).not.toHaveBeenCalled()
    } finally {
      if (previousRoot === undefined) {
        delete process.env.FORGE_WORKSPACE_ROOT
      } else {
        process.env.FORGE_WORKSPACE_ROOT = previousRoot
      }
      await fs.rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('rejects local project creation through a symlink that escapes the active workspace', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    const previousRoot = process.env.FORGE_WORKSPACE_ROOT
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-local-link-'))
    const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-local-link-outside-'))
    process.env.FORGE_WORKSPACE_ROOT = workspaceRoot
    const linkPath = path.join(workspaceRoot, 'projects', 'outside-link')
    await fs.mkdir(path.dirname(linkPath), { recursive: true })
    await fs.symlink(outsideRoot, linkPath, 'dir')

    try {
      const { POST } = await import('@/app/api/projects/route')
      const res = await POST(authRequest('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Symlink Escape',
          source: 'local',
          localPath: path.join(linkPath, 'new-project'),
          defaultBranch: 'main',
        }),
      }) as never)

      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toMatch(/active Forge workspace|workspace root/i)
      expect(mockDbInsert).not.toHaveBeenCalled()
      await expect(fs.stat(path.join(outsideRoot, 'new-project'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      if (previousRoot === undefined) {
        delete process.env.FORGE_WORKSPACE_ROOT
      } else {
        process.env.FORGE_WORKSPACE_ROOT = previousRoot
      }
      await fs.rm(workspaceRoot, { recursive: true, force: true })
      await fs.rm(outsideRoot, { recursive: true, force: true })
    }
  })

  it('rejects local project creation when forge.project.json is a symlink', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    const previousRoot = process.env.FORGE_WORKSPACE_ROOT
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-local-marker-link-'))
    const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-local-marker-outside-'))
    process.env.FORGE_WORKSPACE_ROOT = workspaceRoot
    const localPath = path.join(workspaceRoot, 'projects', 'marker-link')
    const outsideFile = path.join(outsideRoot, 'outside.json')
    await fs.mkdir(localPath, { recursive: true })
    await fs.writeFile(outsideFile, 'outside\n')
    await fs.symlink(outsideFile, path.join(localPath, 'forge.project.json'))

    try {
      const { POST } = await import('@/app/api/projects/route')
      const res = await POST(authRequest('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Marker Link',
          source: 'local',
          localPath,
        }),
      }) as never)

      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toMatch(/symlink/i)
      expect(mockDbInsert).not.toHaveBeenCalled()
      await expect(fs.readFile(outsideFile, 'utf-8')).resolves.toBe('outside\n')
    } finally {
      if (previousRoot === undefined) {
        delete process.env.FORGE_WORKSPACE_ROOT
      } else {
        process.env.FORGE_WORKSPACE_ROOT = previousRoot
      }
      await fs.rm(workspaceRoot, { recursive: true, force: true })
      await fs.rm(outsideRoot, { recursive: true, force: true })
    }
  })

  it('rejects clone destinations through a symlink that escapes the active workspace', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    const previousRoot = process.env.FORGE_WORKSPACE_ROOT
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-clone-link-'))
    const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-clone-link-outside-'))
    process.env.FORGE_WORKSPACE_ROOT = workspaceRoot
    const linkPath = path.join(workspaceRoot, 'projects', 'outside-link')
    await fs.mkdir(path.dirname(linkPath), { recursive: true })
    await fs.symlink(outsideRoot, linkPath, 'dir')

    try {
      const { POST } = await import('@/app/api/projects/route')
      const res = await POST(authRequest('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Symlink Clone',
          source: 'clone',
          githubRepo: 'owner/private-repo',
          localPath: path.join(linkPath, 'private-repo'),
          githubTokenEnvVar: 'GITHUB_TOKEN',
          defaultBranch: 'main',
        }),
      }) as never)

      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toMatch(/workspace root/i)
      expect(mockExecFile).not.toHaveBeenCalled()
      await expect(fs.stat(path.join(outsideRoot, 'private-repo'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      if (previousRoot === undefined) {
        delete process.env.FORGE_WORKSPACE_ROOT
      } else {
        process.env.FORGE_WORKSPACE_ROOT = previousRoot
      }
      await fs.rm(workspaceRoot, { recursive: true, force: true })
      await fs.rm(outsideRoot, { recursive: true, force: true })
    }
  })

  it('rejects cloned projects that contain a symlinked forge.project.json marker', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    const previousRoot = process.env.FORGE_WORKSPACE_ROOT
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-clone-marker-link-'))
    const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-clone-marker-outside-'))
    process.env.FORGE_WORKSPACE_ROOT = workspaceRoot
    const expectedLocalPath = path.join(workspaceRoot, 'projects', 'private-repo')
    const outsideFile = path.join(outsideRoot, 'outside.json')
    await fs.writeFile(outsideFile, 'outside\n')
    mockResolveGitHubToken.mockResolvedValue({ token: 'placeholder-token', source: 'env' })
    mockExecFile.mockImplementation((_command, args: string[], _options, callback) => {
      const run = async () => {
        if (args[0] === 'clone') {
          const destination = args[4]
          await fs.mkdir(destination, { recursive: true })
          await fs.symlink(outsideFile, path.join(destination, 'forge.project.json'))
          return
        }
        if (args[0] === '-C' && args[2] === 'remote') return
        throw new Error(`Unexpected git command: ${args.join(' ')}`)
      }
      run().then(
        () => callback(null, '', ''),
        (err) => callback(err),
      )
      return undefined
    })

    try {
      const { POST } = await import('@/app/api/projects/route')
      const res = await POST(authRequest('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Private Repo',
          source: 'clone',
          githubRepo: 'owner/private-repo',
          localPath: 'private-repo',
          githubTokenEnvVar: 'GITHUB_TOKEN',
        }),
      }) as never)

      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toMatch(/symlink/i)
      expect(mockDbInsert).not.toHaveBeenCalled()
      await expect(fs.stat(expectedLocalPath)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(fs.readFile(outsideFile, 'utf-8')).resolves.toBe('outside\n')
    } finally {
      if (previousRoot === undefined) {
        delete process.env.FORGE_WORKSPACE_ROOT
      } else {
        process.env.FORGE_WORKSPACE_ROOT = previousRoot
      }
      await fs.rm(workspaceRoot, { recursive: true, force: true })
      await fs.rm(outsideRoot, { recursive: true, force: true })
    }
  })

  it('defaults a local project path under the active workspace when localPath is omitted', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    const previousRoot = process.env.FORGE_WORKSPACE_ROOT
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-default-project-'))
    process.env.FORGE_WORKSPACE_ROOT = workspaceRoot
    const expectedLocalPath = path.join(workspaceRoot, 'projects', 'my-default-project')
    const createdProject = {
      id: 'project-default-local',
      name: 'My Default Project',
      githubRepo: null,
      localPath: expectedLocalPath,
      githubTokenEnvVar: null,
      pmProviderConfigId: null,
      defaultBranch: 'main',
      createdAt: new Date(),
      updatedAt: new Date(),
      archivedAt: null,
    }
    mockDbInsert.mockReturnValue(chain([createdProject]))

    try {
      const { POST } = await import('@/app/api/projects/route')
      const res = await POST(authRequest('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'My Default Project',
          source: 'local',
          defaultBranch: 'main',
        }),
      }) as never)

      expect(res.status).toBe(201)
      const stat = await fs.stat(expectedLocalPath)
      expect(stat.isDirectory()).toBe(true)
      await expect(fs.stat(path.join(expectedLocalPath, 'forge.project.json'))).resolves.toMatchObject({})
    } finally {
      if (previousRoot === undefined) {
        delete process.env.FORGE_WORKSPACE_ROOT
      } else {
        process.env.FORGE_WORKSPACE_ROOT = previousRoot
      }
      await fs.rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('rejects local project paths inside protected Forge workspace directories', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    const previousRoot = process.env.FORGE_WORKSPACE_ROOT
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-protected-project-'))
    process.env.FORGE_WORKSPACE_ROOT = workspaceRoot

    try {
      const { POST } = await import('@/app/api/projects/route')
      const res = await POST(authRequest('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Bad project',
          source: 'local',
          localPath: path.join(workspaceRoot, 'config'),
        }),
      }) as never)

      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toMatch(/workspace config directory/i)
      expect(mockDbInsert).not.toHaveBeenCalled()
    } finally {
      if (previousRoot === undefined) {
        delete process.env.FORGE_WORKSPACE_ROOT
      } else {
        process.env.FORGE_WORKSPACE_ROOT = previousRoot
      }
      await fs.rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('rejects local project paths overlapping another project before creating directories', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    const previousRoot = process.env.FORGE_WORKSPACE_ROOT
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-local-overlap-'))
    process.env.FORGE_WORKSPACE_ROOT = workspaceRoot
    const existingProjectRoot = path.join(workspaceRoot, 'projects', 'existing')
    const nestedProjectRoot = path.join(existingProjectRoot, 'nested')
    await fs.mkdir(existingProjectRoot, { recursive: true })
    mockDbSelect.mockReturnValue(chain([{ id: 'project-existing', localPath: existingProjectRoot }]))

    try {
      const { POST } = await import('@/app/api/projects/route')
      const res = await POST(authRequest('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Nested project',
          source: 'local',
          localPath: nestedProjectRoot,
        }),
      }) as never)

      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toMatch(/overlaps another registered Forge project/i)
      expect(mockDbInsert).not.toHaveBeenCalled()
      await expect(fs.stat(nestedProjectRoot)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      if (previousRoot === undefined) {
        delete process.env.FORGE_WORKSPACE_ROOT
      } else {
        process.env.FORGE_WORKSPACE_ROOT = previousRoot
      }
      await fs.rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('rejects clone destinations overlapping another project before running git clone', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    const previousRoot = process.env.FORGE_WORKSPACE_ROOT
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-clone-overlap-'))
    process.env.FORGE_WORKSPACE_ROOT = workspaceRoot
    const existingProjectRoot = path.join(workspaceRoot, 'projects', 'existing')
    const nestedProjectRoot = path.join(existingProjectRoot, 'nested-clone')
    await fs.mkdir(existingProjectRoot, { recursive: true })
    mockDbSelect.mockReturnValue(chain([{ id: 'project-existing', localPath: existingProjectRoot }]))

    try {
      const { POST } = await import('@/app/api/projects/route')
      const res = await POST(authRequest('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Nested clone',
          source: 'clone',
          githubRepo: 'owner/private-repo',
          localPath: nestedProjectRoot,
          githubTokenEnvVar: 'GITHUB_TOKEN',
          defaultBranch: 'main',
        }),
      }) as never)

      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toMatch(/overlaps another registered Forge project/i)
      expect(mockExecFile).not.toHaveBeenCalled()
      await expect(fs.stat(nestedProjectRoot)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      if (previousRoot === undefined) {
        delete process.env.FORGE_WORKSPACE_ROOT
      } else {
        process.env.FORGE_WORKSPACE_ROOT = previousRoot
      }
      await fs.rm(workspaceRoot, { recursive: true, force: true })
    }
  })
})

describe('PUT /api/projects/:id — local path display handling', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('accepts a displayed local path and keeps the stored path canonical', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    const previousRoot = process.env.FORGE_WORKSPACE_ROOT
    const previousHome = process.env.HOME
    const fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-project-update-display-home-'))
    const workspaceRoot = path.join(fakeHome, 'Documents', 'Forge')
    const displayLocalPath = '~/Documents/Forge/projects/updated-project'
    const expectedLocalPath = path.join(workspaceRoot, 'projects', 'updated-project')
    process.env.HOME = fakeHome
    process.env.FORGE_WORKSPACE_ROOT = workspaceRoot
    await fs.mkdir(expectedLocalPath, { recursive: true })
    const existingProject = {
      id: 'project-update-display',
      name: 'Display update',
      githubRepo: null,
      localPath: null,
      githubTokenEnvVar: null,
      pmProviderConfigId: null,
      defaultBranch: 'main',
      createdAt: new Date(),
      updatedAt: new Date(),
      archivedAt: null,
    }
    const updatedProject = {
      ...existingProject,
      localPath: expectedLocalPath,
      updatedAt: new Date(),
    }
    mockDbSelect.mockReturnValue(chain([existingProject]))
    mockDbUpdate.mockReturnValue(chain([updatedProject]))

    try {
      const { PUT } = await import('@/app/api/projects/[id]/route')
      const res = await PUT(authRequest('/api/projects/project-update-display', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ localPath: displayLocalPath }),
      }) as never, {
        params: Promise.resolve({ id: 'project-update-display' }),
      })

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.project.localPath).toBe(expectedLocalPath)
      expect(body.project.displayLocalPath).toBe(displayLocalPath)
    } finally {
      if (previousRoot === undefined) {
        delete process.env.FORGE_WORKSPACE_ROOT
      } else {
        process.env.FORGE_WORKSPACE_ROOT = previousRoot
      }
      if (previousHome === undefined) {
        delete process.env.HOME
      } else {
        process.env.HOME = previousHome
      }
      await fs.rm(fakeHome, { recursive: true, force: true })
    }
  })

  it('rejects updates that point at protected Forge workspace directories', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    const previousRoot = process.env.FORGE_WORKSPACE_ROOT
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-project-update-protected-'))
    process.env.FORGE_WORKSPACE_ROOT = workspaceRoot
    const existingProject = {
      id: 'project-update-protected',
      name: 'Protected update',
      githubRepo: null,
      localPath: null,
      githubTokenEnvVar: null,
      pmProviderConfigId: null,
      defaultBranch: 'main',
      createdAt: new Date(),
      updatedAt: new Date(),
      archivedAt: null,
    }
    mockDbSelect.mockReturnValue(chain([existingProject]))

    try {
      const { PUT } = await import('@/app/api/projects/[id]/route')
      const res = await PUT(authRequest('/api/projects/project-update-protected', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ localPath: path.join(workspaceRoot, 'config') }),
      }) as never, {
        params: Promise.resolve({ id: 'project-update-protected' }),
      })

      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toMatch(/workspace config directory/i)
      expect(mockDbUpdate).not.toHaveBeenCalled()
    } finally {
      if (previousRoot === undefined) {
        delete process.env.FORGE_WORKSPACE_ROOT
      } else {
        process.env.FORGE_WORKSPACE_ROOT = previousRoot
      }
      await fs.rm(workspaceRoot, { recursive: true, force: true })
    }
  })
})

describe('DELETE /api/projects/:id — retained-evidence archive boundary', () => {
  beforeEach(() => { vi.clearAllMocks() })

  function projectRow(localPath: string) {
    return {
      id: 'project-delete',
      name: 'Delete Me',
      githubRepo: null,
      localPath,
      githubTokenEnvVar: null,
      pmProviderConfigId: null,
      defaultBranch: 'main',
      createdAt: new Date(),
      updatedAt: new Date(),
      archivedAt: null,
    }
  }

  it('rejects deleteFiles before inspecting the project or filesystem', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-delete-root-'))

    try {
      const { DELETE } = await import('@/app/api/projects/[id]/route')
      const res = await DELETE(nextAuthRequest('/api/projects/project-delete?deleteFiles=true') as never, {
        params: Promise.resolve({ id: 'project-delete' }),
      })

      expect(res.status).toBe(409)
      const body = await res.json()
      expect(body.code).toBe('project_hard_delete_disabled')
      expect(body.error).toMatch(/retry without deleteFiles to archive/i)
      expect(mockDbSelect).not.toHaveBeenCalled()
      expect(mockDbUpdate).not.toHaveBeenCalled()
      expect(mockDbDelete).not.toHaveBeenCalled()
      await expect(fs.stat(workspaceRoot)).resolves.toMatchObject({})
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('archives a Forge-owned project without touching its directory', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    const previousRoot = process.env.FORGE_WORKSPACE_ROOT
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-delete-owned-'))
    process.env.FORGE_WORKSPACE_ROOT = workspaceRoot
    const localPath = path.join(workspaceRoot, 'projects', 'delete-me')
    await fs.mkdir(localPath, { recursive: true })
    await fs.writeFile(
      path.join(localPath, 'forge.project.json'),
      `${JSON.stringify({ projectId: 'project-delete' })}\n`,
    )
    mockDbSelect.mockReturnValue(chain([projectRow(localPath)]))
    mockDbUpdate.mockReturnValue(chain(undefined))

    try {
      const { DELETE } = await import('@/app/api/projects/[id]/route')
      const res = await DELETE(nextAuthRequest('/api/projects/project-delete') as never, {
        params: Promise.resolve({ id: 'project-delete' }),
      })

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body).toMatchObject({
        archived: true,
        filesDeleted: false,
        fileDeletionSkippedReason: 'retained_release_evidence',
      })
      expect(mockDbUpdate).toHaveBeenCalled()
      expect(mockDbDelete).not.toHaveBeenCalled()
      await expect(fs.readFile(path.join(localPath, 'forge.project.json'), 'utf-8')).resolves.toContain(
        'project-delete',
      )
    } finally {
      if (previousRoot === undefined) {
        delete process.env.FORGE_WORKSPACE_ROOT
      } else {
        process.env.FORGE_WORKSPACE_ROOT = previousRoot
      }
      await fs.rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('archives an external project path without deleting its files', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    const previousRoot = process.env.FORGE_WORKSPACE_ROOT
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-delete-external-workspace-'))
    const externalRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-delete-external-project-'))
    const externalFile = path.join(externalRoot, 'keep.txt')
    await fs.writeFile(externalFile, 'do not delete\n')
    process.env.FORGE_WORKSPACE_ROOT = workspaceRoot
    mockDbSelect.mockReturnValue(chain([projectRow(externalRoot)]))
    mockDbUpdate.mockReturnValue(chain(undefined))

    try {
      const { DELETE } = await import('@/app/api/projects/[id]/route')
      const res = await DELETE(nextAuthRequest('/api/projects/project-delete') as never, {
        params: Promise.resolve({ id: 'project-delete' }),
      })

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.filesDeleted).toBe(false)
      expect(body.fileDeletionSkippedReason).toBe('retained_release_evidence')
      expect(body.fileDeletionMessage).toMatch(/archived the project record/i)
      expect(mockDbUpdate).toHaveBeenCalled()
      expect(mockDbDelete).not.toHaveBeenCalled()
      await expect(fs.readFile(externalFile, 'utf-8')).resolves.toBe('do not delete\n')
    } finally {
      if (previousRoot === undefined) {
        delete process.env.FORGE_WORKSPACE_ROOT
      } else {
        process.env.FORGE_WORKSPACE_ROOT = previousRoot
      }
      await fs.rm(workspaceRoot, { recursive: true, force: true })
      await fs.rm(externalRoot, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// Suite 3.1c — Folder browser lists local directories for authenticated users
// ---------------------------------------------------------------------------

describe('GET /api/filesystem/directories — folder selector', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('returns a requested workspace directory listing', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    const previousRoot = process.env.FORGE_WORKSPACE_ROOT
    const previousDisplayRoot = process.env.FORGE_WORKSPACE_DISPLAY_ROOT
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-folder-list-'))
    process.env.FORGE_WORKSPACE_ROOT = workspaceRoot
    process.env.FORGE_WORKSPACE_DISPLAY_ROOT = '/Forge Workspace'
    const parentPath = path.join(workspaceRoot, 'projects')
    const childPath = path.join(parentPath, 'demo-app')
    await fs.mkdir(childPath, { recursive: true })

    try {
      const { GET } = await import('@/app/api/filesystem/directories/route')
      const res = await GET(nextAuthRequest(
        `/api/filesystem/directories?path=${encodeURIComponent('/Forge Workspace/projects')}`,
      ) as never)

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.path).toBe(parentPath)
      expect(body.displayPath).toBe('/Forge Workspace/projects')
      expect(body.directories).toEqual([
        expect.objectContaining({
          name: 'demo-app',
          path: childPath,
          displayPath: '/Forge Workspace/projects/demo-app',
        }),
      ])
    } finally {
      if (previousRoot === undefined) {
        delete process.env.FORGE_WORKSPACE_ROOT
      } else {
        process.env.FORGE_WORKSPACE_ROOT = previousRoot
      }
      if (previousDisplayRoot === undefined) {
        delete process.env.FORGE_WORKSPACE_DISPLAY_ROOT
      } else {
        process.env.FORGE_WORKSPACE_DISPLAY_ROOT = previousDisplayRoot
      }
      await fs.rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('rejects requested paths outside the active workspace', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    const previousRoot = process.env.FORGE_WORKSPACE_ROOT
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-folder-boundary-'))
    const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-folder-outside-'))
    process.env.FORGE_WORKSPACE_ROOT = workspaceRoot

    try {
      const { GET } = await import('@/app/api/filesystem/directories/route')
      const res = await GET(nextAuthRequest(`/api/filesystem/directories?path=${encodeURIComponent(outsideRoot)}`) as never)

      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toMatch(/workspace root/i)
    } finally {
      if (previousRoot === undefined) {
        delete process.env.FORGE_WORKSPACE_ROOT
      } else {
        process.env.FORGE_WORKSPACE_ROOT = previousRoot
      }
      await fs.rm(workspaceRoot, { recursive: true, force: true })
      await fs.rm(outsideRoot, { recursive: true, force: true })
    }
  })

  it('rejects symlinked workspace paths that resolve outside the active workspace', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    const previousRoot = process.env.FORGE_WORKSPACE_ROOT
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-folder-link-'))
    const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-folder-link-outside-'))
    process.env.FORGE_WORKSPACE_ROOT = workspaceRoot
    const linkPath = path.join(workspaceRoot, 'projects', 'outside-link')
    await fs.mkdir(path.dirname(linkPath), { recursive: true })
    await fs.symlink(outsideRoot, linkPath, 'dir')

    try {
      const { GET } = await import('@/app/api/filesystem/directories/route')
      const res = await GET(nextAuthRequest(`/api/filesystem/directories?path=${encodeURIComponent(linkPath)}`) as never)

      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toMatch(/workspace root/i)
    } finally {
      if (previousRoot === undefined) {
        delete process.env.FORGE_WORKSPACE_ROOT
      } else {
        process.env.FORGE_WORKSPACE_ROOT = previousRoot
      }
      await fs.rm(workspaceRoot, { recursive: true, force: true })
      await fs.rm(outsideRoot, { recursive: true, force: true })
    }
  })

  it('defaults to the active workspace projects directory without bootstrapping workspace files', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    const previousRoot = process.env.FORGE_WORKSPACE_ROOT
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-workspace-test-'))
    process.env.FORGE_WORKSPACE_ROOT = workspaceRoot
    await fs.mkdir(path.join(workspaceRoot, 'projects'))

    try {
      const { GET } = await import('@/app/api/filesystem/directories/route')
      const res = await GET(nextAuthRequest('/api/filesystem/directories') as never)

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.path).toBe(path.join(workspaceRoot, 'projects'))
      await expect(fs.stat(path.join(workspaceRoot, 'mcps'))).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(fs.stat(path.join(workspaceRoot, 'templates'))).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(fs.stat(path.join(workspaceRoot, 'global-settings.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      if (previousRoot === undefined) {
        delete process.env.FORGE_WORKSPACE_ROOT
      } else {
        process.env.FORGE_WORKSPACE_ROOT = previousRoot
      }
      await fs.rm(workspaceRoot, { recursive: true, force: true })
    }
  })
})

describe('POST /api/filesystem/directories — folder creation', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('creates a child folder for authenticated users', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    const previousRoot = process.env.FORGE_WORKSPACE_ROOT
    const previousDisplayRoot = process.env.FORGE_WORKSPACE_DISPLAY_ROOT
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-folder-test-'))
    process.env.FORGE_WORKSPACE_ROOT = workspaceRoot
    process.env.FORGE_WORKSPACE_DISPLAY_ROOT = '/Forge Workspace'
    const parentPath = path.join(workspaceRoot, 'projects')
    await fs.mkdir(parentPath, { recursive: true })

    try {
      const { POST } = await import('@/app/api/filesystem/directories/route')
      const res = await POST(nextAuthRequest('/api/filesystem/directories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parentPath: '/Forge Workspace/projects', name: 'new-app' }),
      }) as never)

      expect(res.status).toBe(201)
      const body = await res.json()
      const createdPath = path.join(parentPath, 'new-app')
      expect(body.path).toBe(createdPath)
      expect(body.displayPath).toBe('/Forge Workspace/projects/new-app')
      expect(body.parentPath).toBe(parentPath)
      expect(body.parentDisplayPath).toBe('/Forge Workspace/projects')
      const stat = await fs.stat(createdPath)
      expect(stat.isDirectory()).toBe(true)
    } finally {
      if (previousRoot === undefined) {
        delete process.env.FORGE_WORKSPACE_ROOT
      } else {
        process.env.FORGE_WORKSPACE_ROOT = previousRoot
      }
      if (previousDisplayRoot === undefined) {
        delete process.env.FORGE_WORKSPACE_DISPLAY_ROOT
      } else {
        process.env.FORGE_WORKSPACE_DISPLAY_ROOT = previousDisplayRoot
      }
      await fs.rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('rejects parent paths outside the active workspace', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    const previousRoot = process.env.FORGE_WORKSPACE_ROOT
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-folder-post-boundary-'))
    const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-folder-post-outside-'))
    process.env.FORGE_WORKSPACE_ROOT = workspaceRoot

    try {
      const { POST } = await import('@/app/api/filesystem/directories/route')
      const res = await POST(nextAuthRequest('/api/filesystem/directories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parentPath: outsideRoot, name: 'new-app' }),
      }) as never)

      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toMatch(/workspace root/i)
    } finally {
      if (previousRoot === undefined) {
        delete process.env.FORGE_WORKSPACE_ROOT
      } else {
        process.env.FORGE_WORKSPACE_ROOT = previousRoot
      }
      await fs.rm(workspaceRoot, { recursive: true, force: true })
      await fs.rm(outsideRoot, { recursive: true, force: true })
    }
  })

  it('rejects symlinked parent paths that resolve outside the active workspace', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    const previousRoot = process.env.FORGE_WORKSPACE_ROOT
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-folder-post-link-'))
    const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-folder-post-link-outside-'))
    process.env.FORGE_WORKSPACE_ROOT = workspaceRoot
    const linkPath = path.join(workspaceRoot, 'projects', 'outside-link')
    await fs.mkdir(path.dirname(linkPath), { recursive: true })
    await fs.symlink(outsideRoot, linkPath, 'dir')

    try {
      const { POST } = await import('@/app/api/filesystem/directories/route')
      const res = await POST(nextAuthRequest('/api/filesystem/directories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parentPath: linkPath, name: 'new-app' }),
      }) as never)

      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toMatch(/workspace root/i)
      await expect(fs.stat(path.join(outsideRoot, 'new-app'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      if (previousRoot === undefined) {
        delete process.env.FORGE_WORKSPACE_ROOT
      } else {
        process.env.FORGE_WORKSPACE_ROOT = previousRoot
      }
      await fs.rm(workspaceRoot, { recursive: true, force: true })
      await fs.rm(outsideRoot, { recursive: true, force: true })
    }
  })

  it('rejects folder names with path traversal', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)

    const { POST } = await import('@/app/api/filesystem/directories/route')
    const res = await POST(nextAuthRequest('/api/filesystem/directories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parentPath: '/tmp', name: '../bad' }),
    }) as never)

    expect(res.status).toBe(400)
  })
})

// ---------------------------------------------------------------------------
// Suite 3.1d — Workspace settings bootstrap and override
// ---------------------------------------------------------------------------

describe('GET/PUT /api/settings/workspace', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('defaults to ~/Documents/Forge when no env or stored override exists', async () => {
    const previousRoot = process.env.FORGE_WORKSPACE_ROOT
    const previousHome = process.env.HOME
    const fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-home-'))
    delete process.env.FORGE_WORKSPACE_ROOT
    process.env.HOME = fakeHome
    mockDbSelect.mockReturnValue(chain([]))

    try {
      const {
        DEFAULT_WORKSPACE_ROOT,
        expandHomePath,
        getWorkspaceSettings,
      } = await import('@/lib/workspace')
      const workspace = await getWorkspaceSettings({ ensure: false })

      expect(DEFAULT_WORKSPACE_ROOT).toBe('~/Documents/Forge')
      expect(expandHomePath('~/Documents/Forge')).toBe(path.join(fakeHome, 'Documents', 'Forge'))
      expect(workspace.workspaceRoot).toBe(path.join(fakeHome, 'Documents', 'Forge'))
      expect(workspace.source).toBe('default')
    } finally {
      if (previousRoot === undefined) {
        delete process.env.FORGE_WORKSPACE_ROOT
      } else {
        process.env.FORGE_WORKSPACE_ROOT = previousRoot
      }
      if (previousHome === undefined) {
        delete process.env.HOME
      } else {
        process.env.HOME = previousHome
      }
      await fs.rm(fakeHome, { recursive: true, force: true })
    }
  })

  it('returns workspace display paths from the settings API', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    const previousRoot = process.env.FORGE_WORKSPACE_ROOT
    const previousMcpsRoot = process.env.FORGE_MCPS_ROOT
    const previousHome = process.env.HOME
    const fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-settings-display-home-'))
    delete process.env.FORGE_WORKSPACE_ROOT
    delete process.env.FORGE_MCPS_ROOT
    process.env.HOME = fakeHome
    mockDbSelect.mockReturnValue(chain([]))

    try {
      const { GET } = await import('@/app/api/settings/workspace/route')
      const res = await GET(authRequest('/api/settings/workspace') as never)

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.workspace.workspaceRoot).toBe(path.join(fakeHome, 'Documents', 'Forge'))
      expect(body.workspace.displayPaths).toMatchObject({
        workspaceRoot: '~/Documents/Forge',
        projectsRoot: '~/Documents/Forge/projects',
        mcpsRoot: '~/Documents/Forge/mcps',
        globalSettingsPath: '~/Documents/Forge/global-settings.json',
      })
    } finally {
      if (previousRoot === undefined) {
        delete process.env.FORGE_WORKSPACE_ROOT
      } else {
        process.env.FORGE_WORKSPACE_ROOT = previousRoot
      }
      if (previousMcpsRoot === undefined) {
        delete process.env.FORGE_MCPS_ROOT
      } else {
        process.env.FORGE_MCPS_ROOT = previousMcpsRoot
      }
      if (previousHome === undefined) {
        delete process.env.HOME
      } else {
        process.env.HOME = previousHome
      }
      await fs.rm(fakeHome, { recursive: true, force: true })
    }
  })

  it('maps workspace display aliases back to canonical paths when saving settings', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    mockDbSelect.mockReturnValue(chain([]))
    mockDbInsert.mockReturnValue(chain(undefined))
    const previousRoot = process.env.FORGE_WORKSPACE_ROOT
    const previousMcpsRoot = process.env.FORGE_MCPS_ROOT
    const previousDisplayRoot = process.env.FORGE_WORKSPACE_DISPLAY_ROOT
    const previousHome = process.env.HOME
    const fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-settings-display-save-home-'))
    const workspaceRoot = path.join(fakeHome, 'Documents', 'Forge')
    const mcpsRoot = path.join(workspaceRoot, 'custom-mcps')
    delete process.env.FORGE_WORKSPACE_ROOT
    delete process.env.FORGE_MCPS_ROOT
    process.env.HOME = fakeHome
    process.env.FORGE_WORKSPACE_DISPLAY_ROOT = '/Forge Workspace'

    try {
      const { PUT } = await import('@/app/api/settings/workspace/route')
      const res = await PUT(authRequest('/api/settings/workspace', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceRoot: '/Forge Workspace',
          mcpsRoot: '/Forge Workspace/custom-mcps',
        }),
      }) as never)

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.workspace.workspaceRoot).toBe(workspaceRoot)
      expect(body.workspace.mcpsRoot).toBe(mcpsRoot)
      expect(body.workspace.displayPaths).toMatchObject({
        workspaceRoot: '/Forge Workspace',
        mcpsRoot: '/Forge Workspace/custom-mcps',
      })
      await expect(fs.stat(mcpsRoot)).resolves.toMatchObject({})
    } finally {
      if (previousRoot === undefined) {
        delete process.env.FORGE_WORKSPACE_ROOT
      } else {
        process.env.FORGE_WORKSPACE_ROOT = previousRoot
      }
      if (previousMcpsRoot === undefined) {
        delete process.env.FORGE_MCPS_ROOT
      } else {
        process.env.FORGE_MCPS_ROOT = previousMcpsRoot
      }
      if (previousDisplayRoot === undefined) {
        delete process.env.FORGE_WORKSPACE_DISPLAY_ROOT
      } else {
        process.env.FORGE_WORKSPACE_DISPLAY_ROOT = previousDisplayRoot
      }
      if (previousHome === undefined) {
        delete process.env.HOME
      } else {
        process.env.HOME = previousHome
      }
      await fs.rm(fakeHome, { recursive: true, force: true })
    }
  })

  it('saves a workspace override and writes global-settings.json', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    mockDbInsert.mockReturnValue(chain(undefined))
    const previousRoot = process.env.FORGE_WORKSPACE_ROOT
    delete process.env.FORGE_WORKSPACE_ROOT
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-workspace-save-'))

    try {
      const { PUT } = await import('@/app/api/settings/workspace/route')
      const res = await PUT(authRequest('/api/settings/workspace', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceRoot }),
      }) as never)

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.workspace.workspaceRoot).toBe(workspaceRoot)
      await expect(fs.stat(path.join(workspaceRoot, 'projects'))).resolves.toMatchObject({})
      const globalSettings = JSON.parse(
        await fs.readFile(path.join(workspaceRoot, 'global-settings.json'), 'utf-8'),
      ) as {
        workspaceRoot: string
        configRoot: string
        projectsRoot: string
        mcpsRoot: string
        templatesRoot: string
        localMemoryRoot: string
        checkpointsRoot: string
        promptsRoot: string
        agentPromptsRoot: string
        workforcesRoot: string
        runtimeRoot: string
        logsRoot: string
        backupsRoot: string
        forgeEnvPath: string
      }
      expect(globalSettings.configRoot).toMatch(/\/config$/)
      expect(globalSettings.projectsRoot).toMatch(/\/projects$/)
      expect(globalSettings.mcpsRoot).toMatch(/\/mcps$/)
      expect(globalSettings.templatesRoot).toMatch(/\/templates$/)
      expect(globalSettings.localMemoryRoot).toMatch(/\/local-memory$/)
      expect(globalSettings.checkpointsRoot).toMatch(/\/local-memory\/checkpoints$/)
      expect(globalSettings.promptsRoot).toMatch(/\/prompts$/)
      expect(globalSettings.agentPromptsRoot).toMatch(/\/prompts\/agents$/)
      expect(globalSettings.workforcesRoot).toMatch(/\/workforces$/)
      expect(globalSettings.runtimeRoot).toMatch(/\/runtime$/)
      expect(globalSettings.logsRoot).toMatch(/\/logs$/)
      expect(globalSettings.backupsRoot).toMatch(/\/backups$/)
      expect(globalSettings.forgeEnvPath).toMatch(/\/config\/forge\.env$/)
      await expect(fs.stat(path.join(workspaceRoot, 'local-memory', 'checkpoints'))).resolves.toMatchObject({})
      await expect(fs.stat(path.join(workspaceRoot, 'prompts', 'agents'))).resolves.toMatchObject({})
      await expect(fs.stat(path.join(workspaceRoot, 'workforces'))).resolves.toMatchObject({})
      await expect(fs.stat(path.join(workspaceRoot, 'runtime'))).resolves.toMatchObject({})
      await expect(fs.stat(path.join(workspaceRoot, 'logs'))).resolves.toMatchObject({})
      await expect(fs.readFile(path.join(workspaceRoot, 'local-memory', '.gitignore'), 'utf-8')).resolves.toBe(
        '*\n!.gitignore\n',
      )
    } finally {
      if (previousRoot === undefined) {
        delete process.env.FORGE_WORKSPACE_ROOT
      } else {
        process.env.FORGE_WORKSPACE_ROOT = previousRoot
      }
      await fs.rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('saves a custom shared MCP root with workspace settings', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    mockDbInsert.mockReturnValue(chain(undefined))
    const previousRoot = process.env.FORGE_WORKSPACE_ROOT
    const previousMcpsRoot = process.env.FORGE_MCPS_ROOT
    delete process.env.FORGE_WORKSPACE_ROOT
    delete process.env.FORGE_MCPS_ROOT
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-workspace-mcps-'))
    const mcpsRoot = path.join(workspaceRoot, 'custom-mcps')

    try {
      const { PUT } = await import('@/app/api/settings/workspace/route')
      const res = await PUT(authRequest('/api/settings/workspace', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceRoot, mcpsRoot }),
      }) as never)

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.workspace.workspaceRoot).toBe(workspaceRoot)
      expect(body.workspace.mcpsRoot).toBe(mcpsRoot)
      await expect(fs.stat(mcpsRoot)).resolves.toMatchObject({})
      const globalSettings = JSON.parse(
        await fs.readFile(path.join(workspaceRoot, 'global-settings.json'), 'utf-8'),
      ) as { mcpsRoot: string }
      expect(globalSettings.mcpsRoot).toMatch(/custom-mcps$/)
    } finally {
      if (previousRoot === undefined) {
        delete process.env.FORGE_WORKSPACE_ROOT
      } else {
        process.env.FORGE_WORKSPACE_ROOT = previousRoot
      }
      if (previousMcpsRoot === undefined) {
        delete process.env.FORGE_MCPS_ROOT
      } else {
        process.env.FORGE_MCPS_ROOT = previousMcpsRoot
      }
      await fs.rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('rejects custom shared MCP roots outside the active workspace', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    const previousRoot = process.env.FORGE_WORKSPACE_ROOT
    const previousMcpsRoot = process.env.FORGE_MCPS_ROOT
    delete process.env.FORGE_WORKSPACE_ROOT
    delete process.env.FORGE_MCPS_ROOT
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-workspace-mcps-boundary-'))
    const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-outside-mcps-'))

    try {
      const { PUT } = await import('@/app/api/settings/workspace/route')
      const res = await PUT(authRequest('/api/settings/workspace', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceRoot, mcpsRoot: path.join(outsideRoot, 'mcps') }),
      }) as never)

      expect(res.status).toBe(409)
      const body = await res.json()
      expect(body.error).toMatch(/active workspace root/)
    } finally {
      if (previousRoot === undefined) {
        delete process.env.FORGE_WORKSPACE_ROOT
      } else {
        process.env.FORGE_WORKSPACE_ROOT = previousRoot
      }
      if (previousMcpsRoot === undefined) {
        delete process.env.FORGE_MCPS_ROOT
      } else {
        process.env.FORGE_MCPS_ROOT = previousMcpsRoot
      }
      await fs.rm(workspaceRoot, { recursive: true, force: true })
      await fs.rm(outsideRoot, { recursive: true, force: true })
    }
  })

  it('rejects workspace override writes when FORGE_WORKSPACE_ROOT is set', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    const previousRoot = process.env.FORGE_WORKSPACE_ROOT
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-workspace-env-'))
    process.env.FORGE_WORKSPACE_ROOT = workspaceRoot

    try {
      const { PUT } = await import('@/app/api/settings/workspace/route')
      const res = await PUT(authRequest('/api/settings/workspace', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceRoot: '~/OtherForge' }),
      }) as never)

      expect(res.status).toBe(409)
      const body = await res.json()
      expect(body.error).toMatch(/FORGE_WORKSPACE_ROOT/)
    } finally {
      if (previousRoot === undefined) {
        delete process.env.FORGE_WORKSPACE_ROOT
      } else {
        process.env.FORGE_WORKSPACE_ROOT = previousRoot
      }
      await fs.rm(workspaceRoot, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// Suite 3.1e — Project MCP status and installation
// ---------------------------------------------------------------------------

describe('GET/POST/PUT /api/projects/:id/mcps — shared MCP management', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetGitHubStatus.mockResolvedValue({
      connected: false,
      source: 'none',
      cliAuthenticated: false,
      patStored: false,
      login: null,
    })
  })

  async function withWorkspaceProject<T>(
    callback: (project: {
      id: string
      name: string
      githubRepo: string | null
      localPath: string
      githubTokenEnvVar: string | null
      pmProviderConfigId: string | null
      mcpConfig: {
        profile: 'default'
        requiredMcps: string[]
        overrides: Record<string, never>
      }
      defaultBranch: string
      createdAt: Date
      updatedAt: Date
      archivedAt: null
    }, workspaceRoot: string) => Promise<T>,
  ): Promise<T> {
    const previousRoot = process.env.FORGE_WORKSPACE_ROOT
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-mcp-test-'))
    process.env.FORGE_WORKSPACE_ROOT = workspaceRoot
    const localPath = path.join(workspaceRoot, 'projects', 'demo')
    await fs.mkdir(localPath, { recursive: true })
    const project = {
      id: 'project-mcp',
      name: 'MCP project',
      githubRepo: 'Joncallim/Forge',
      localPath,
      githubTokenEnvVar: null,
      pmProviderConfigId: null,
      mcpConfig: {
        profile: 'default' as const,
        requiredMcps: ['filesystem', 'github'],
        overrides: {},
      },
      grantDecisionRevision: BigInt(0),
      rootBindingRevision: BigInt(1),
      defaultBranch: 'main',
      createdAt: new Date(),
      updatedAt: new Date(),
      archivedAt: null,
    }

    try {
      return await callback(project, workspaceRoot)
    } finally {
      if (previousRoot === undefined) {
        delete process.env.FORGE_WORKSPACE_ROOT
      } else {
        process.env.FORGE_WORKSPACE_ROOT = previousRoot
      }
      await fs.rm(workspaceRoot, { recursive: true, force: true })
    }
  }

  async function writeMcpManifest(workspaceRoot: string, mcpId: string, manifestId = mcpId) {
    const installPath = path.join(workspaceRoot, 'mcps', mcpId)
    await fs.mkdir(installPath, { recursive: true })
    await fs.writeFile(
      path.join(installPath, 'forge.mcp.json'),
      `${JSON.stringify({
        schemaVersion: 1,
        id: manifestId,
        displayName: mcpId,
        source: 'forge-catalog',
        createdAt: new Date().toISOString(),
      })}\n`,
    )
    return installPath
  }

  it('reports recommended MCPs as missing before installation', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    mockDbInsert.mockReturnValue(chain(undefined))
    const previousDisplayRoot = process.env.FORGE_WORKSPACE_DISPLAY_ROOT

    try {
      process.env.FORGE_WORKSPACE_DISPLAY_ROOT = '/Forge Workspace'
      await withWorkspaceProject(async (project) => {
        mockDbSelect
          .mockReturnValueOnce(chain([project]))
          .mockReturnValueOnce(chain([]))

        const { GET } = await import('@/app/api/projects/[id]/mcps/route')
        const res = await GET(authRequest('/api/projects/project-mcp/mcps') as never, {
          params: Promise.resolve({ id: project.id }),
        })

        expect(res.status).toBe(200)
        const body = await res.json()
        expect(body.overview.displayMcpsRoot).toBe('/Forge Workspace/mcps')
        expect(body.overview.catalog.map((entry: { id: string }) => entry.id)).toEqual(['filesystem', 'github'])
        expect(body.overview.summary.missing).toBe(2)
        expect(body.overview.statuses.map((status: { installState: string }) => status.installState)).toEqual([
          'missing',
          'missing',
        ])
        expect(body.overview.statuses.map((status: { displayInstallPath: string }) => status.displayInstallPath)).toEqual([
          '/Forge Workspace/mcps/filesystem',
          '/Forge Workspace/mcps/github',
        ])
        expect(mockGetProjectMcpOverview).toHaveBeenCalledWith(
          project,
          { cache: false, ensureWorkspace: false },
        )
        expect(mockDbInsert).not.toHaveBeenCalled()
      })
    } finally {
      if (previousDisplayRoot === undefined) {
        delete process.env.FORGE_WORKSPACE_DISPLAY_ROOT
      } else {
        process.env.FORGE_WORKSPACE_DISPLAY_ROOT = previousDisplayRoot
      }
    }
  })

  it('installs recommended MCP manifests and returns cached health status', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    const insertTables: unknown[] = []
    mockDbInsert.mockImplementation((table: unknown) => {
      insertTables.push(table)
      return chain(undefined)
    })

    await withWorkspaceProject(async (project, workspaceRoot) => {
      const { mcpInstallations, projectMcpStatusChecks } = await import('@/db/schema')
      mockDbSelect
        .mockReturnValueOnce(chain([project]))
        .mockReturnValueOnce(chain([]))
        .mockReturnValueOnce(chain([]))

      const { POST } = await import('@/app/api/projects/[id]/mcps/install-recommended/route')
      const res = await POST(authRequest('/api/projects/project-mcp/mcps/install-recommended', {
        method: 'POST',
      }) as never, {
        params: Promise.resolve({ id: project.id }),
      })

      expect(res.status).toBe(200)
      const body = await res.json()
      const statuses = body.overview.statuses as Array<{ mcpId: string; installState: string; status: string }>
      expect(statuses.find((status) => status.mcpId === 'filesystem')).toMatchObject({
        installerAgentType: 'mcp-installer',
        installState: 'installed',
        status: 'healthy',
      })
      expect(statuses.find((status) => status.mcpId === 'github')).toMatchObject({
        installerAgentType: 'mcp-installer',
        installState: 'installed',
        remediation: expect.objectContaining({
          agentType: 'mcp-installer',
          action: expect.stringMatching(/Connect GitHub/),
        }),
        status: 'auth_required',
      })
      await expect(fs.stat(path.join(workspaceRoot, 'mcps', 'filesystem', 'forge.mcp.json'))).resolves.toMatchObject({})
      await expect(fs.stat(path.join(workspaceRoot, 'mcps', 'github', 'forge.mcp.json'))).resolves.toMatchObject({})
      expect(insertTables.filter((table) => table === mcpInstallations)).toHaveLength(2)
      expect(insertTables.filter((table) => table === projectMcpStatusChecks)).toHaveLength(2)
    })
  })

  it('installs only selected MCP manifests when requested', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    mockDbInsert.mockReturnValue(chain(undefined))

    await withWorkspaceProject(async (project, workspaceRoot) => {
      mockDbSelect
        .mockReturnValueOnce(chain([project]))
        .mockReturnValueOnce(chain([]))
        .mockReturnValueOnce(chain([]))

      const { POST } = await import('@/app/api/projects/[id]/mcps/install-recommended/route')
      const res = await POST(authRequest('/api/projects/project-mcp/mcps/install-recommended', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mcpIds: ['filesystem'] }),
      }) as never, {
        params: Promise.resolve({ id: project.id }),
      })

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.overview.statuses.find((status: { mcpId: string }) => status.mcpId === 'filesystem')).toMatchObject({
        installState: 'installed',
        status: 'healthy',
      })
      expect(body.overview.statuses.find((status: { mcpId: string }) => status.mcpId === 'github')).toMatchObject({
        installState: 'missing',
        remediation: expect.objectContaining({
          agentType: 'mcp-installer',
          action: expect.stringMatching(/install the GitHub catalog manifest/),
        }),
      })
      await expect(fs.stat(path.join(workspaceRoot, 'mcps', 'filesystem', 'forge.mcp.json'))).resolves.toMatchObject({})
      await expect(fs.stat(path.join(workspaceRoot, 'mcps', 'github', 'forge.mcp.json'))).rejects.toMatchObject({
        code: 'ENOENT',
      })
    })
  })

  it('returns MCP summaries from the projects list endpoint', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    mockDbInsert.mockReturnValue(chain(undefined))

    await withWorkspaceProject(async (project) => {
      mockDbSelect
        .mockReturnValueOnce(chain([project]))
        .mockReturnValueOnce(chain([
          {
            projectId: project.id,
            mcpId: 'filesystem',
            status: 'unknown',
            installState: 'missing',
            error: 'MCP is not installed.',
            details: null,
            checkedAt: new Date(),
          },
          {
            projectId: project.id,
            mcpId: 'github',
            status: 'unknown',
            installState: 'missing',
            error: 'MCP is not installed.',
            details: null,
            checkedAt: new Date(),
          },
        ]))

      const { GET } = await import('@/app/api/projects/route')
      const res = await GET(authRequest('/api/projects') as never)

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.projects[0].mcpSummary).toMatchObject({
        label: 'MCPs: 2 missing',
        status: 'missing',
        missing: 2,
      })
      expect(mockDbInsert).not.toHaveBeenCalled()
    })
  })

  it('distinguishes disabled, unhealthy, and configuration-required MCP states', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    mockDbInsert.mockReturnValue(chain(undefined))

    await withWorkspaceProject(async (project, workspaceRoot) => {
      const filesystemPath = await writeMcpManifest(workspaceRoot, 'filesystem')
      const invalidPath = await writeMcpManifest(workspaceRoot, 'github', 'filesystem')
      const { GET } = await import('@/app/api/projects/[id]/mcps/route')

      const disabledProject = {
        ...project,
        mcpConfig: {
          profile: 'custom' as const,
          requiredMcps: ['filesystem'],
          overrides: {},
        },
      }
      mockDbSelect
        .mockReturnValueOnce(chain([disabledProject]))
        .mockReturnValueOnce(chain([
          { mcpId: 'filesystem', installPath: filesystemPath, enabled: false },
        ]))

      const disabledRes = await GET(authRequest('/api/projects/project-mcp/mcps') as never, {
        params: Promise.resolve({ id: project.id }),
      })
      expect(disabledRes.status).toBe(200)
      expect((await disabledRes.json()).overview.statuses[0]).toMatchObject({
        installState: 'installed',
        remediation: expect.objectContaining({
          agentType: 'mcp-installer',
          action: expect.stringMatching(/Enable the filesystem MCP/),
        }),
        status: 'disabled',
      })

      const unhealthyProject = {
        ...project,
        mcpConfig: {
          profile: 'custom' as const,
          requiredMcps: ['github'],
          overrides: {},
        },
      }
      mockDbSelect
        .mockReturnValueOnce(chain([unhealthyProject]))
        .mockReturnValueOnce(chain([
          { mcpId: 'github', installPath: invalidPath, enabled: true },
        ]))

      const unhealthyRes = await GET(authRequest('/api/projects/project-mcp/mcps') as never, {
        params: Promise.resolve({ id: project.id }),
      })
      expect(unhealthyRes.status).toBe(200)
      expect((await unhealthyRes.json()).overview.statuses[0]).toMatchObject({
        installState: 'installed',
        remediation: expect.objectContaining({
          agentType: 'mcp-installer',
          action: expect.stringMatching(/verify the GitHub manifest/),
        }),
        status: 'unhealthy',
      })

      const missingLocalPathProject = {
        ...disabledProject,
        localPath: path.join(workspaceRoot, 'projects', 'missing'),
      }
      mockDbSelect
        .mockReturnValueOnce(chain([missingLocalPathProject]))
        .mockReturnValueOnce(chain([
          { mcpId: 'filesystem', installPath: filesystemPath, enabled: true },
        ]))

      const configRes = await GET(authRequest('/api/projects/project-mcp/mcps') as never, {
        params: Promise.resolve({ id: project.id }),
      })
      expect(configRes.status).toBe(200)
      expect((await configRes.json()).overview.statuses[0]).toMatchObject({
        installState: 'installed',
        remediation: expect.objectContaining({
          agentType: 'mcp-installer',
          action: expect.stringMatching(/Set a valid project local path/),
        }),
        status: 'configuration_required',
      })
    })
  })

  it('rejects project MCP override paths outside the shared MCP root', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)

    await withWorkspaceProject(async (project) => {
      mockDbSelect.mockReturnValueOnce(chain([project]))

      const { PUT } = await import('@/app/api/projects/[id]/mcps/route')
      const res = await PUT(authRequest('/api/projects/project-mcp/mcps', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          profile: 'custom',
          requiredMcps: ['filesystem'],
          overrides: {
            filesystem: { installPath: '/tmp/outside-forge-mcps' },
          },
        }),
      }) as never, {
        params: Promise.resolve({ id: project.id }),
      })

      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toMatch(/active workspace root/)
      expect(mockDbUpdate).not.toHaveBeenCalled()
    })
  })

  it('allows project MCP override paths inside the active workspace root', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    mockDbUpdate.mockReturnValue(chain(undefined))
    mockDbInsert.mockReturnValue(chain(undefined))

    await withWorkspaceProject(async (project, workspaceRoot) => {
      const customPath = path.join(workspaceRoot, 'custom-mcps', 'filesystem')
      await fs.mkdir(customPath, { recursive: true })
      await fs.writeFile(
        path.join(customPath, 'forge.mcp.json'),
        `${JSON.stringify({
          schemaVersion: 1,
          id: 'filesystem',
          displayName: 'Filesystem',
          source: 'forge-catalog',
          createdAt: new Date().toISOString(),
        })}\n`,
      )
      mockDbSelect
        .mockReturnValueOnce(chain([project]))
        .mockReturnValueOnce(chain([]))

      const { PUT } = await import('@/app/api/projects/[id]/mcps/route')
      const res = await PUT(authRequest('/api/projects/project-mcp/mcps', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          profile: 'custom',
          requiredMcps: ['filesystem'],
          overrides: {
            filesystem: { installPath: customPath },
          },
        }),
      }) as never, {
        params: Promise.resolve({ id: project.id }),
      })

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.overview.statuses[0]).toMatchObject({
        installPath: customPath,
        installState: 'installed',
        status: 'healthy',
      })
      expect(mockDbUpdate).toHaveBeenCalled()
    })
  })

  it('preserves project-level grants when saving MCP settings', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    mockDbInsert.mockReturnValue(chain(undefined))
    const update = chain(undefined)
    update.set = vi.fn(() => update)
    mockDbUpdate.mockReturnValue(update)

    await withWorkspaceProject(async (project) => {
      const projectWithGrant = {
        ...project,
        mcpConfig: {
          ...project.mcpConfig,
          grants: {
            filesystem: {
              schemaVersion: 2,
              mcpId: 'filesystem',
              status: 'approved',
              grantMode: 'always_allow',
              capabilities: ['filesystem.project.read', 'filesystem.project.search'],
              grantApprovalId: 'grant-approval-1',
              approvedAt: '2026-07-05T00:00:00.000Z',
              approvedBy: 'user-abc',
              reason: 'Trusted project',
              grantDecisionRevision: '1',
              rootBindingRevision: '1',
            },
          },
        },
      }
      mockDbSelect
        .mockReturnValueOnce(chain([projectWithGrant]))
        .mockReturnValueOnce(chain([]))

      const { PUT } = await import('@/app/api/projects/[id]/mcps/route')
      const res = await PUT(authRequest('/api/projects/project-mcp/mcps', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          profile: 'custom',
          requiredMcps: ['filesystem'],
          overrides: {},
        }),
      }) as never, {
        params: Promise.resolve({ id: project.id }),
      })

      expect(res.status).toBe(200)
      expect(update.set).toHaveBeenCalledWith(expect.objectContaining({
        mcpConfig: expect.objectContaining({
          grants: expect.objectContaining({
            filesystem: expect.objectContaining({
              grantMode: 'always_allow',
              grantApprovalId: 'grant-approval-1',
              capabilities: ['filesystem.project.read', 'filesystem.project.search'],
            }),
          }),
        }),
      }))
    })
  })

  it('does not accept client-supplied project grants through MCP settings', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    mockDbInsert.mockReturnValue(chain(undefined))
    const update = chain(undefined)
    update.set = vi.fn(() => update)
    mockDbUpdate.mockReturnValue(update)

    await withWorkspaceProject(async (project) => {
      mockDbSelect
        .mockReturnValueOnce(chain([project]))
        .mockReturnValueOnce(chain([]))

      const { PUT } = await import('@/app/api/projects/[id]/mcps/route')
      const res = await PUT(authRequest('/api/projects/project-mcp/mcps', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          profile: 'custom',
          requiredMcps: ['filesystem'],
          overrides: {},
          grants: {
            filesystem: {
              schemaVersion: 1,
              mcpId: 'filesystem',
              status: 'approved',
              grantMode: 'always_allow',
              capabilities: ['filesystem.project.read'],
              grantApprovalId: 'spoofed',
              approvedAt: '2026-07-05T00:00:00.000Z',
              approvedBy: 'attacker',
              reason: 'spoofed',
            },
          },
        }),
      }) as never, {
        params: Promise.resolve({ id: project.id }),
      })

      expect(res.status).toBe(200)
      expect(update.set).toHaveBeenCalledWith(expect.objectContaining({
        mcpConfig: expect.not.objectContaining({
          grants: expect.anything(),
        }),
      }))
    })
  })

  it('persists an empty custom MCP selection as an explicit rejection of all catalog MCPs', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    mockDbUpdate.mockReturnValue(chain(undefined))

    await withWorkspaceProject(async (project) => {
      mockDbSelect
        .mockReturnValueOnce(chain([project]))
        .mockReturnValueOnce(chain([]))

      const { PUT } = await import('@/app/api/projects/[id]/mcps/route')
      const res = await PUT(authRequest('/api/projects/project-mcp/mcps', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          profile: 'custom',
          requiredMcps: [],
          overrides: {},
        }),
      }) as never, {
        params: Promise.resolve({ id: project.id }),
      })

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.overview.config).toMatchObject({
        profile: 'custom',
        requiredMcps: [],
      })
      expect(body.overview.statuses).toEqual([])
      expect(body.overview.summary).toMatchObject({
        label: 'MCPs: None selected',
        status: 'disabled',
      })
      expect(mockDbUpdate).toHaveBeenCalled()
    })
  })
})

// ---------------------------------------------------------------------------
// Suite 3.2 — 404: GET /api/projects/:id when project does not exist
// ---------------------------------------------------------------------------

describe('GET /api/projects/:id — 404 when project not found', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('returns displayLocalPath for a project detail row', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    const previousRoot = process.env.FORGE_WORKSPACE_ROOT
    const previousHome = process.env.HOME
    const fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-project-detail-display-home-'))
    const workspaceRoot = path.join(fakeHome, 'Documents', 'Forge')
    const project = {
      id: 'project-detail-display',
      name: 'Detail Display',
      githubRepo: null,
      localPath: path.join(workspaceRoot, 'projects', 'detail-display'),
      githubTokenEnvVar: null,
      pmProviderConfigId: null,
      mcpConfig: {
        profile: 'default',
        requiredMcps: ['filesystem', 'github'],
        overrides: {},
      },
      defaultBranch: 'main',
      createdAt: new Date(),
      updatedAt: new Date(),
      archivedAt: null,
    }
    process.env.HOME = fakeHome
    process.env.FORGE_WORKSPACE_ROOT = workspaceRoot
    mockDbSelect.mockReturnValue(chain([project]))

    try {
      const { GET } = await import('@/app/api/projects/[id]/route')
      const res = await GET(authRequest('/api/projects/project-detail-display') as never, {
        params: Promise.resolve({ id: 'project-detail-display' }),
      })

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.project).toMatchObject({
        localPath: project.localPath,
        displayLocalPath: '~/Documents/Forge/projects/detail-display',
      })
    } finally {
      if (previousRoot === undefined) {
        delete process.env.FORGE_WORKSPACE_ROOT
      } else {
        process.env.FORGE_WORKSPACE_ROOT = previousRoot
      }
      if (previousHome === undefined) {
        delete process.env.HOME
      } else {
        process.env.HOME = previousHome
      }
      await fs.rm(fakeHome, { recursive: true, force: true })
    }
  })

  it('returns 404 when the project does not exist', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    mockDbSelect.mockReturnValue(chain([]))  // empty result = not found

    const { GET } = await import('@/app/api/projects/[id]/route')
    const req = authRequest('/api/projects/nonexistent-id')
    const params = Promise.resolve({ id: 'nonexistent-id' })

    const res = await GET(req as never, { params })

    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error).toMatch(/not found/i)
  })

  it('keeps legacy null-owned project reads non-mutating until bootstrap ownership is assigned', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    mockDbSelect.mockReturnValueOnce(chain([]))

    const { GET } = await import('@/app/api/projects/[id]/route')
    const res = await GET(authRequest('/api/projects/project-legacy') as never, {
      params: Promise.resolve({ id: 'project-legacy' }),
    })

    expect(res.status).toBe(404)
    expect(mockDbSelect).toHaveBeenCalledOnce()
    expect(mockDbUpdate).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Suite 3.3 — Task details include package-scoped artifacts
// ---------------------------------------------------------------------------

describe('GET /api/tasks/:id — task details', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('hydrates work-package harness prompts and package-scoped artifacts in task details', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    const task = {
      id: 'task-work-packages',
      status: 'awaiting_approval',
      projectId: 'proj-1',
      title: 'Inspect assigned work packages',
      prompt: 'Show assigned work.',
      submittedBy: 'user-abc',
      pmProviderConfigId: null,
      githubBranch: null,
      githubPrUrl: null,
      errorMessage: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      completedAt: null,
    }
    const workPackage = {
      id: 'package-1',
      taskId: task.id,
      harnessId: 'harness-1',
      title: 'Frontend handoff',
      summary: 'Update the Providers page.',
      sequence: 1,
      status: 'pending',
      dependsOn: [],
      targetFiles: ['web/app/dashboard/providers/page.tsx'],
      targetAreas: ['Providers'],
      mcpRequirements: {},
      metadata: {
        promptOverlay: 'Keep the Providers list synced after local detection.',
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    }
    const qaWorkPackage = {
      ...workPackage,
      id: 'package-2',
      harnessId: 'harness-2',
      title: 'QA verification',
      sequence: 2,
      metadata: {
        promptOverlay: 'Verify the Providers list after local detection.',
      },
    }
    const packageRun = {
      id: 'run-1',
      taskId: task.id,
      workPackageId: 'package-1',
      harnessId: 'harness-1',
      agentType: 'handoff',
      stage: 'handoff',
      attemptNumber: 1,
      providerConfigId: null,
      modelIdUsed: 'forge-handoff/no-op',
      status: 'completed',
      inputTokens: null,
      outputTokens: null,
      costUsd: null,
      startedAt: new Date(),
      completedAt: new Date(),
      errorMessage: null,
      createdAt: new Date(),
    }
    const qaPackageRun = {
      ...packageRun,
      id: 'run-2',
      workPackageId: 'package-2',
      harnessId: 'harness-2',
      agentType: 'qa',
      modelIdUsed: 'openrouter/test',
    }
    const taskLevelRun = {
      ...packageRun,
      id: 'run-task',
      workPackageId: null,
      harnessId: null,
      agentType: 'architect',
      stage: 'planning',
      modelIdUsed: 'openrouter/architect',
    }
    const packageArtifact = {
      id: 'artifact-1',
      agentRunId: 'run-1',
      artifactType: 'log_output',
      content: 'Package handoff summary.',
      metadata: { repositoryWrites: false },
      createdAt: new Date(),
    }
    const qaPackageArtifact = {
      id: 'artifact-2',
      agentRunId: 'run-2',
      artifactType: 'test_report',
      content: 'Package QA summary.',
      metadata: { repositoryWrites: false },
      createdAt: new Date(),
    }
    const taskLevelArtifact = {
      id: 'artifact-task',
      agentRunId: 'run-task',
      artifactType: 'adr_text',
      content: 'Task-level plan.',
      metadata: { revision: 1 },
      createdAt: new Date(),
    }
    mockDbSelect
      .mockReturnValueOnce(chain([task]))
      .mockReturnValueOnce(chain([packageRun, qaPackageRun, taskLevelRun]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([packageArtifact, qaPackageArtifact, taskLevelArtifact]))
      .mockReturnValueOnce(chain([workPackage, qaWorkPackage]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([
        {
          id: 'harness-1',
          role: 'frontend',
          displayName: 'Frontend',
          description: 'Dashboard UI specialist.',
        },
        {
          id: 'harness-2',
          role: 'qa',
          displayName: 'QA',
          description: 'Regression specialist.',
        },
      ]))

    const { GET } = await import('@/app/api/tasks/[id]/route')
    const res = await GET(authRequest(`/api/tasks/${task.id}`) as never, {
      params: Promise.resolve({ id: task.id }),
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.workPackages).toMatchObject([{
      id: 'package-1',
      harnessRole: 'frontend',
      harnessDisplayName: 'Frontend',
      harnessDescription: 'Dashboard UI specialist.',
      promptOverlay: 'Keep the Providers list synced after local detection.',
      artifacts: [{
        id: 'artifact-1',
        agentRunId: 'run-1',
        artifactType: 'log_output',
        content: 'Package handoff summary.',
      }],
    }, {
      id: 'package-2',
      harnessRole: 'qa',
      harnessDisplayName: 'QA',
      harnessDescription: 'Regression specialist.',
      promptOverlay: 'Verify the Providers list after local detection.',
      artifacts: [{
        id: 'artifact-2',
        agentRunId: 'run-2',
        artifactType: 'test_report',
        content: 'Package QA summary.',
      }],
    }])
    expect(body.artifacts.map((artifact: { id: string }) => artifact.id)).toEqual([
      'artifact-1',
      'artifact-2',
      'artifact-task',
    ])
    expect(body.workPackages.flatMap(
      (pkg: { artifacts: Array<{ id: string }> }) => pkg.artifacts.map((artifact) => artifact.id),
    )).toEqual(['artifact-1', 'artifact-2'])
  })

  it('returns task details when the optional repository command audit table has not been migrated yet', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    const task = {
      id: 'task-missing-audit-table',
      status: 'pending',
      projectId: 'proj-1',
      title: 'New task',
      prompt: 'Do something.',
      submittedBy: 'user-abc',
      pmProviderConfigId: null,
      githubBranch: null,
      githubPrUrl: null,
      errorMessage: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      completedAt: null,
    }
    const missingTableError = Object.assign(new Error('relation "repository_command_audits" does not exist'), {
      cause: { code: '42P01' },
    })
    mockDbSelect
      .mockReturnValueOnce(chain([task]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(rejectingChain(missingTableError))

    const { GET } = await import('@/app/api/tasks/[id]/route')
    const res = await GET(authRequest(`/api/tasks/${task.id}`) as never, {
      params: Promise.resolve({ id: task.id }),
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.task.id).toBe(task.id)
    expect(body.commandAudits).toEqual([])
  })

  it('returns task details when optional filesystem audit rows are not readable', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    const task = {
      id: 'task-unreadable-filesystem-audits',
      status: 'running',
      projectId: 'proj-1',
      title: 'Running task',
      prompt: 'Do something.',
      submittedBy: 'user-abc',
      pmProviderConfigId: null,
      githubBranch: null,
      githubPrUrl: null,
      errorMessage: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      completedAt: null,
    }
    const permissionError = Object.assign(new Error('permission denied for table filesystem_mcp_runtime_audits'), {
      cause: { code: '42501' },
    })
    mockDbSelect
      .mockReturnValueOnce(chain([task]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(rejectingChain(permissionError))

    const { GET } = await import('@/app/api/tasks/[id]/route')
    const res = await GET(authRequest(`/api/tasks/${task.id}`) as never, {
      params: Promise.resolve({ id: task.id }),
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.task.id).toBe(task.id)
    expect(body.filesystemAudits).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Suite 3.4 — Task deletion and cancellation
// ---------------------------------------------------------------------------

describe('DELETE /api/tasks/:id — stop or delete a task', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('cancels a running task and non-terminal package state', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    const runningTask = {
      id: 'task-1',
      status: 'running',
      projectId: 'proj-1',
      title: 'Test',
      prompt: 'Do something',
      submittedBy: 'user-abc',
      pmProviderConfigId: null,
      githubBranch: null,
      githubPrUrl: null,
      errorMessage: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      completedAt: null,
    }
    mockDbSelect.mockReturnValue(chain([runningTask]))
    mockDbUpdate
      .mockReturnValueOnce(chain([{ id: 'task-1' }]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([]))

    const { DELETE } = await import('@/app/api/tasks/[id]/route')
    const req = authRequest('/api/tasks/task-1', { method: 'DELETE' })
    const params = Promise.resolve({ id: 'task-1' })

    const res = await DELETE(req as never, { params })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ ok: true, mode: 'cancel' })
    expect(mockDbUpdate).toHaveBeenCalledTimes(4)
    expect(mockRedisPublish).toHaveBeenCalledWith(
      'forge:task:task-1',
      expect.stringContaining('"status":"cancelled"'),
    )
  })

  it('retains a terminal task when mode=delete is requested', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    mockDbSelect.mockReturnValue(chain([{
      id: 'task-delete',
      status: 'completed',
    }]))

    const { DELETE } = await import('@/app/api/tasks/[id]/route')
    const req = authRequest('/api/tasks/task-delete?mode=delete', { method: 'DELETE' })
    const params = Promise.resolve({ id: 'task-delete' })

    const res = await DELETE(req as never, { params })

    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error).toMatch(/retains task, run, and review evidence/i)
    expect(mockDbDelete).not.toHaveBeenCalled()
  })

  it('rejects hard-delete for active tasks so operators must stop them first', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    mockDbSelect.mockReturnValue(chain([{
      id: 'task-running-delete',
      status: 'running',
    }]))

    const { DELETE } = await import('@/app/api/tasks/[id]/route')
    const req = authRequest('/api/tasks/task-running-delete?mode=delete', { method: 'DELETE' })
    const params = Promise.resolve({ id: 'task-running-delete' })

    const res = await DELETE(req as never, { params })

    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error).toMatch(/Stop it first/i)
    expect(mockDbDelete).not.toHaveBeenCalled()
  })

  it('does not attempt a delete for any terminal task', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    mockDbSelect.mockReturnValue(chain([{
      id: 'task-raced-delete',
      status: 'failed',
    }]))

    const { DELETE } = await import('@/app/api/tasks/[id]/route')
    const req = authRequest('/api/tasks/task-raced-delete?mode=delete', { method: 'DELETE' })
    const params = Promise.resolve({ id: 'task-raced-delete' })

    const res = await DELETE(req as never, { params })

    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error).toMatch(/retains task, run, and review evidence/i)
    expect(mockDbDelete).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Suite 3.4 — Task status guard: POST /api/tasks/:id/approve returns 409 when status is 'pending'
// ---------------------------------------------------------------------------

describe('POST /api/tasks/:id/approve — 409 when status is pending', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetProjectMcpOverview.mockImplementation(async (project: { id: string; mcpConfig: unknown }) => ({
      projectId: project.id,
      config: project.mcpConfig,
      catalog: [],
      mcpsRoot: '/tmp/mcps',
      statuses: [],
      summary: { label: 'Unavailable', status: 'missing', missing: 0, authRequired: 0, unhealthy: 0, disabled: 0 },
    }))
  })
  afterEach(() => { mockGetProjectMcpOverview.mockReset() })

  it('returns 409 when task status is pending', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    const pendingTask = {
      id: 'task-2',
      status: 'pending',
    }
    mockDbSelect.mockReturnValue(chain([pendingTask]))

    const { POST } = await import('@/app/api/tasks/[id]/approve/route')
    const req = authRequest('/api/tasks/task-2/approve', { method: 'POST' })
    const params = Promise.resolve({ id: 'task-2' })

    const res = await POST(req as never, { params })

    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error).toMatch(/awaiting_approval/i)
  })

  it('uses the freshly locked project policy and returns 409 when its filesystem grant is absent', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    const projectHealthChain = chain([{
      id: 'project-1',
      mcpConfig: {
        grants: {
          filesystem: {
            schemaVersion: 1,
            mcpId: 'filesystem',
            status: 'approved',
            grantMode: 'always_allow',
            capabilities: ['filesystem.project.read', 'filesystem.project.search'],
            grantApprovalId: 'stale-grant',
            approvedAt: '2026-07-14T00:00:00.000Z',
            approvedBy: FAKE_SESSION.userId,
            reason: 'This pre-lock snapshot must not authorize approval.',
          },
        },
      },
    }])
    const lockedProjectChain = chain([{ id: 'project-1', mcpConfig: {} }])
    const lockedTaskChain = chain([{
      id: 'task-approval',
      projectId: 'project-1',
      status: 'awaiting_approval',
    }])
    const lockedPackagesChain = chain([{
      id: 'pkg-fs',
      assignedRole: 'frontend',
      title: 'Frontend work package',
      mcpRequirements: [{
        mcpId: 'filesystem',
        agent: 'frontend',
        requirement: 'required',
        capabilities: ['filesystem.project.read', 'filesystem.project.search'],
        fallback: { action: 'block', message: '' },
      }],
      metadata: {
        mcpGrantPhases: {
          effective: {
            schemaVersion: 1,
            phase: 'effective',
            runtimeEnforcement: 'approved_snapshot',
            status: 'not_issued',
          },
        },
      },
    }])
    lockedProjectChain.for = vi.fn(() => lockedProjectChain)
    lockedTaskChain.for = vi.fn(() => lockedTaskChain)
    lockedPackagesChain.orderBy = vi.fn(() => lockedPackagesChain)
    lockedPackagesChain.for = vi.fn(() => lockedPackagesChain)
    mockGetProjectMcpOverview.mockResolvedValueOnce({
      projectId: 'project-1', config: {}, catalog: [], mcpsRoot: '/tmp/mcps',
      statuses: [{
        mcpId: 'filesystem', displayName: 'Filesystem', description: '', installPath: '/tmp/mcps/filesystem',
        installState: 'installed', status: 'healthy', enabled: true, error: null,
        checkedAt: '2026-07-14T00:00:01.000Z',
      }],
      summary: { label: 'Healthy', status: 'healthy', missing: 0, authRequired: 0, unhealthy: 0, disabled: 0 },
    })
    mockDbSelect
      .mockReturnValueOnce(chain([{
        id: 'task-approval',
        projectId: 'project-1',
        status: 'awaiting_approval',
        updatedAt: new Date('2026-06-25T00:00:00.000Z'),
      }]))
      .mockReturnValueOnce(projectHealthChain)
      .mockReturnValueOnce(lockedProjectChain)
      .mockReturnValueOnce(lockedTaskChain)
      .mockReturnValueOnce(lockedPackagesChain)

    const { POST } = await import('@/app/api/tasks/[id]/approve/route')
    const req = authRequest('/api/tasks/task-approval/approve', { method: 'POST' })
    const res = await POST(req as never, { params: Promise.resolve({ id: 'task-approval' }) })

    expect(res.status).toBe(409)
    await expect(res.json()).resolves.toMatchObject({
      error: expect.stringContaining('Filesystem context approval is required'),
      primaryRecoveryAction: 'approve_project_filesystem_context',
      workPackageId: 'pkg-fs',
    })
    expect(mockDbUpdate).not.toHaveBeenCalled()
    expect(mockRedisLpush).not.toHaveBeenCalled()
    expect(mockGetProjectMcpOverview.mock.invocationCallOrder[0])
      .toBeLessThan(mockDbTransaction.mock.invocationCallOrder[0])
    expect(lockedProjectChain.for).toHaveBeenCalledWith('update')
    expect(lockedTaskChain.for).toHaveBeenCalledWith('update')
    expect(lockedPackagesChain.orderBy).toHaveBeenCalledOnce()
    expect(lockedPackagesChain.for).toHaveBeenCalledWith('update')
    expect((lockedProjectChain.for as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0])
      .toBeLessThan((lockedTaskChain.for as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0])
    expect((lockedTaskChain.for as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0])
      .toBeLessThan((lockedPackagesChain.for as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0])
  })

  it.each([
    ['MCP configuration', {
      localPath: '/tmp/project-before',
      mcpConfig: { profile: 'default', requiredMcps: [], overrides: {} },
    }],
    ['project path', {
      localPath: '/tmp/project-after',
      mcpConfig: { profile: 'default', requiredMcps: ['github'], overrides: {} },
    }],
  ] as const)('returns a no-write 409 when the locked %s changed after health capture', async (_label, lockedState) => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    const awaitingTask = {
      id: 'task-health-policy-drift',
      projectId: 'project-1',
      status: 'awaiting_approval',
      updatedAt: new Date('2026-07-14T00:00:00.000Z'),
    }
    const capturedProject = {
      id: 'project-1',
      localPath: '/tmp/project-before',
      mcpConfig: { profile: 'default' as const, requiredMcps: ['github'], overrides: {} },
    }
    const lockedProjectChain = chain([{ id: 'project-1', ...lockedState }])
    lockedProjectChain.for = vi.fn(() => lockedProjectChain)
    mockGetProjectMcpOverview.mockResolvedValueOnce({
      projectId: capturedProject.id,
      config: capturedProject.mcpConfig,
      catalog: [],
      mcpsRoot: '/tmp/mcps',
      statuses: [{
        mcpId: 'github', displayName: 'GitHub', description: '', installPath: '/tmp/mcps/github',
        installState: 'installed', status: 'healthy', enabled: true, error: null,
        checkedAt: '2026-07-14T00:00:01.000Z',
      }],
      summary: { label: 'Healthy', status: 'healthy', missing: 0, authRequired: 0, unhealthy: 0, disabled: 0 },
    })
    mockDbSelect
      .mockReturnValueOnce(chain([awaitingTask]))
      .mockReturnValueOnce(chain([capturedProject]))
      .mockReturnValueOnce(lockedProjectChain)

    const { POST } = await import('@/app/api/tasks/[id]/approve/route')
    const res = await POST(authRequest('/api/tasks/task-health-policy-drift/approve', { method: 'POST' }) as never, {
      params: Promise.resolve({ id: awaitingTask.id }),
    })

    expect(res.status).toBe(409)
    await expect(res.json()).resolves.toMatchObject({
      error: expect.stringContaining('health inputs changed'),
      primaryMode: 'blocked',
      primaryRecoveryAction: 'revise_plan',
      retryable: false,
      workPackageId: null,
    })
    expect(lockedProjectChain.for).toHaveBeenCalledWith('update')
    expect(mockDbUpdate).not.toHaveBeenCalled()
    expect(mockRedisLpush).not.toHaveBeenCalled()
    expect(mockRedisPublish).not.toHaveBeenCalled()
  })

  it('fails closed without approval writes or queueing for malformed legacy MCP containers', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    const awaitingTask = {
      id: 'task-malformed-legacy-mcp',
      projectId: 'project-1',
      status: 'awaiting_approval',
      updatedAt: new Date('2026-07-14T00:00:00.000Z'),
    }
    const project = {
      id: 'project-1',
      localPath: '/tmp/project-1',
      mcpConfig: { profile: 'default' as const, requiredMcps: [], overrides: {} },
    }
    const lockedProject = chain([project])
    const lockedTask = chain([awaitingTask])
    const lockedPackages = chain([{
      id: 'pkg-malformed-legacy-mcp',
      assignedRole: 'backend',
      title: 'Malformed legacy MCP package',
      mcpRequirements: { mcpId: 'github', permissions: ['github.issues.read'] },
      metadata: { mcpGrants: { decisionId: 'not-an-array' } },
    }])
    lockedProject.for = vi.fn(() => lockedProject)
    lockedTask.for = vi.fn(() => lockedTask)
    lockedPackages.orderBy = vi.fn(() => lockedPackages)
    lockedPackages.for = vi.fn(() => lockedPackages)
    mockGetProjectMcpOverview.mockResolvedValueOnce({
      projectId: project.id,
      config: project.mcpConfig,
      catalog: [], mcpsRoot: '/tmp/mcps', statuses: [],
      summary: { label: 'None', status: 'missing', missing: 0, authRequired: 0, unhealthy: 0, disabled: 0 },
    })
    mockDbSelect
      .mockReturnValueOnce(chain([awaitingTask]))
      .mockReturnValueOnce(chain([project]))
      .mockReturnValueOnce(lockedProject)
      .mockReturnValueOnce(lockedTask)
      .mockReturnValueOnce(lockedPackages)

    const { POST } = await import('@/app/api/tasks/[id]/approve/route')
    const res = await POST(authRequest('/api/tasks/task-malformed-legacy-mcp/approve', { method: 'POST' }) as never, {
      params: Promise.resolve({ id: awaitingTask.id }),
    })

    expect(res.status).toBe(409)
    await expect(res.json()).resolves.toMatchObject({
      error: expect.stringContaining('Legacy MCP policies must be stored as an array'),
      primaryRecoveryAction: 'revise_plan',
      retryable: false,
      workPackageId: 'pkg-malformed-legacy-mcp',
    })
    expect(mockDbUpdate).not.toHaveBeenCalled()
    expect(mockRedisLpush).not.toHaveBeenCalled()
    expect(mockRedisPublish).not.toHaveBeenCalled()
  })

  const overflowingSubtaskPolicy = (
    boundaryCapability: string,
    prohibitedCapabilities: readonly string[] = [],
  ) => ({
    schemaVersion: 1,
    requirements: [{
      mcpId: 'github', requirement: 'required', reason: 'Read issues.',
      assignment: { type: 'agent', targetAgents: ['backend'], targetId: null },
      agentPermissions: { backend: ['github.issues.read'] },
      prohibitedCapabilities: [...prohibitedCapabilities], fallback: { action: 'block', message: 'Revise.' },
    }],
    promptOverlays: {}, requirementContexts: [],
    mcpAwareSubtasks: [{
      id: 'inspect', agent: 'backend', dependsOn: [],
      mcpCapabilities: [...Array(30).fill('github.issues.read'), boundaryCapability],
      inputs: [], outputs: [], verification: [], stoppingCondition: 'Done.', fallback: 'Revise.',
    }],
  })

  it.each([
    ['filesystem first', ['filesystem', 'github']],
    ['github first', ['github', 'filesystem']],
  ] as const)('returns one precedence-consistent primary admission decision in either requirement order: %s', async (_label, order) => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    const awaitingTask = {
      id: 'task-mixed-mcp-blockers',
      projectId: 'project-1',
      status: 'awaiting_approval',
      updatedAt: new Date('2026-07-14T00:00:00.000Z'),
    }
    const project = { id: 'project-1', mcpConfig: {} }
    const requirements = {
      filesystem: {
        requirementKey: 'a-fs',
        sourceRequirementIndex: 0,
        mcpId: 'filesystem',
        agent: 'backend',
        requirement: 'required',
        capabilities: ['filesystem.project.read'],
        evidenceRefs: ['filesystem-proof'],
        prohibitedCapabilities: [],
        assignment: { type: 'agent', targetId: null },
        fallback: { action: 'block', message: '' },
      },
      github: {
        requirementKey: 'z-gh',
        sourceRequirementIndex: 1,
        mcpId: 'github',
        agent: 'backend',
        requirement: 'required',
        capabilities: ['github.contents.write'],
        evidenceRefs: ['github-proof'],
        prohibitedCapabilities: [],
        assignment: { type: 'agent', targetId: null },
        fallback: { action: 'block', message: '' },
      },
    }
    const workPackage = {
      id: 'pkg-mixed',
      assignedRole: 'backend',
      title: 'Mixed MCP blockers',
      mcpRequirements: order.map((key) => requirements[key]),
      metadata: {},
    }
    mockDbSelect
      .mockReturnValueOnce(chain([awaitingTask]))
      .mockReturnValueOnce(chain([project]))
      .mockReturnValueOnce(chain([project]))
      .mockReturnValueOnce(chain([awaitingTask]))
      .mockReturnValueOnce(chain([workPackage]))

    const { POST } = await import('@/app/api/tasks/[id]/approve/route')
    const res = await POST(authRequest('/api/tasks/task-mixed-mcp-blockers/approve', { method: 'POST' }) as never, {
      params: Promise.resolve({ id: awaitingTask.id }),
    })

    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body).toMatchObject({
      reason: expect.stringContaining('deferred live MCP capabilities'),
      evidenceRefs: ['github-proof'],
      primaryMode: 'deferred_live_mcp',
      primaryRecoveryAction: 'revise_plan',
      primaryDecision: {
        kind: 'requirement',
        mode: 'deferred_live_mcp',
        recoveryAction: 'revise_plan',
        retryableContribution: false,
        requirementKey: 'z-gh',
        reason: expect.stringContaining('deferred live MCP capabilities'),
        evidenceRefs: ['github-proof'],
      },
      primaryRetryableContribution: false,
      retryable: false,
      workPackageId: 'pkg-mixed',
    })
    const { evaluateWorkPackageMcpBroker } = await import('@/worker/mcp-execution-design')
    const broker = evaluateWorkPackageMcpBroker({
      assignedRole: workPackage.assignedRole,
      mcpRequirements: workPackage.mcpRequirements,
      metadata: workPackage.metadata,
      projectMcpConfig: project.mcpConfig,
      title: workPackage.title,
    })
    const { buildMcpBrokerBlockMetadata } = await import('@/worker/blocked-handoff-retry')
    const brokerMetadata = buildMcpBrokerBlockMetadata({
      blockedAt: new Date('2026-07-14T00:00:01.000Z'),
      check: broker,
      existingMetadata: {},
    }) as { mcpBroker: Record<string, unknown> }
    expect(body.primaryDecision).toEqual(broker.primaryDecision)
    expect(body.primaryMode).toBe(broker.primaryMode)
    expect(body.primaryRecoveryAction).toBe(broker.primaryRecoveryAction)
    expect(body.primaryRetryableContribution).toBe(broker.primaryDecision?.retryableContribution)
    expect(body.retryable).toBe(broker.retryable)
    expect(brokerMetadata.mcpBroker.primaryDecision).toEqual(body.primaryDecision)
    expect(brokerMetadata.mcpBroker.primaryMode).toBe(body.primaryMode)
    expect(brokerMetadata.mcpBroker.primaryRecoveryAction).toBe(body.primaryRecoveryAction)
    expect(brokerMetadata.mcpBroker.primaryRetryableContribution).toBe(body.primaryRetryableContribution)
    expect(brokerMetadata.mcpBroker.retryable).toBe(body.retryable)
    expect(mockDbUpdate).not.toHaveBeenCalled()
    expect(mockRedisLpush).not.toHaveBeenCalled()
  })

  it('returns the normalization reason without stale canonical evidence for mixed blockers', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    const normalizationError = 'MCP requirement 0 is malformed and cannot be normalized.'
    const awaitingTask = {
      id: 'task-normalization-and-policy-blocked',
      projectId: 'project-1',
      status: 'awaiting_approval',
      updatedAt: new Date('2026-07-14T00:00:00.000Z'),
    }
    const project = { id: 'project-1', mcpConfig: {} }
    const workPackage = {
      id: 'pkg-normalization-and-policy-blocked',
      assignedRole: 'backend',
      title: 'Malformed mixed policy',
      mcpRequirements: [{
        requirementKey: 'deferred-write',
        sourceRequirementIndex: 0,
        agent: 'backend',
        mcpId: 'github',
        requirement: 'required',
        permissions: ['github.contents.write'],
        evidenceRefs: ['stale-canonical-proof'],
        prohibitedCapabilities: [],
        assignment: { type: 'agent', targetId: null },
        fallback: { action: 'block', message: '' },
      }],
      metadata: {
        mcpGrantsSchemaVersion: 2,
        mcpNormalizationErrors: [normalizationError],
      },
    }
    mockDbSelect
      .mockReturnValueOnce(chain([awaitingTask]))
      .mockReturnValueOnce(chain([project]))
      .mockReturnValueOnce(chain([project]))
      .mockReturnValueOnce(chain([awaitingTask]))
      .mockReturnValueOnce(chain([workPackage]))

    const { POST } = await import('@/app/api/tasks/[id]/approve/route')
    const res = await POST(authRequest('/api/tasks/task-normalization-and-policy-blocked/approve', { method: 'POST' }) as never, {
      params: Promise.resolve({ id: awaitingTask.id }),
    })

    expect(res.status).toBe(409)
    await expect(res.json()).resolves.toMatchObject({
      reason: normalizationError,
      evidenceRefs: [],
      primaryDecision: null,
      primaryMode: 'blocked',
      primaryRecoveryAction: 'revise_plan',
      workPackageId: workPackage.id,
    })
    expect(mockDbUpdate).not.toHaveBeenCalled()
    expect(mockRedisLpush).not.toHaveBeenCalled()
  })

  it('rejects canonicalized separator-alias policy with package-wide deny-wins', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    const awaitingTask = {
      id: 'task-separator-deny-wins',
      projectId: 'project-1',
      status: 'awaiting_approval',
      updatedAt: new Date('2026-07-14T00:00:00.000Z'),
    }
    const project = { id: 'project-1', mcpConfig: {} }
    const workPackage = {
      id: 'pkg-separator-deny-wins',
      assignedRole: 'backend-dev',
      title: 'Canonical backend package',
      mcpRequirements: [{
        requirementKey: 'mcp-requirement-v1-a-separator-read',
        sourceRequirementIndex: 0,
        mcpId: 'github',
        agent: 'backend-dev',
        requirement: 'required',
        permissions: ['github.issues.read'],
        prohibitedCapabilities: [],
        assignment: { type: 'agent', targetId: null },
        fallback: { action: 'block', message: '' },
      }, {
        requirementKey: 'mcp-requirement-v1-z-separator-deny',
        sourceRequirementIndex: 1,
        mcpId: 'github',
        agent: 'backend-dev',
        requirement: 'required',
        permissions: [],
        prohibitedCapabilities: ['github.issues.read'],
        assignment: { type: 'agent', targetId: null },
        fallback: { action: 'block', message: '' },
      }],
      metadata: {},
    }
    mockDbSelect
      .mockReturnValueOnce(chain([awaitingTask]))
      .mockReturnValueOnce(chain([project]))
      .mockReturnValueOnce(chain([project]))
      .mockReturnValueOnce(chain([awaitingTask]))
      .mockReturnValueOnce(chain([workPackage]))

    const { POST } = await import('@/app/api/tasks/[id]/approve/route')
    const res = await POST(authRequest('/api/tasks/task-separator-deny-wins/approve', { method: 'POST' }) as never, {
      params: Promise.resolve({ id: awaitingTask.id }),
    })

    expect(res.status).toBe(409)
    await expect(res.json()).resolves.toMatchObject({
      primaryMode: 'blocked',
      primaryRecoveryAction: 'revise_plan',
      reason: expect.stringContaining('prohibited'),
      workPackageId: workPackage.id,
    })
    expect(mockDbUpdate).not.toHaveBeenCalled()
    expect(mockRedisLpush).not.toHaveBeenCalled()
  })

  it('rejects the separator-alias deny policy produced by the real materializer', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    const taskId = 'task-materialized-separator-deny'
    const overview = {
      projectId: 'project-1',
      config: { profile: 'default' as const, requiredMcps: [], overrides: {} },
      catalog: [],
      mcpsRoot: '/tmp/mcps',
      statuses: [],
      summary: { label: 'Unavailable', status: 'missing' as const, missing: 0, authRequired: 0, unhealthy: 0, disabled: 0 },
    }
    const { prepareArchitectArtifact } = await import('@/worker/architect-artifact')
    const preparedArtifact = prepareArchitectArtifact([
      '# Plan',
      '- [backend-dev] Implement the canonical package.',
      '```mcp_execution_design_json',
      JSON.stringify({
        schemaVersion: 1,
        requirements: [{
          mcpId: 'github', requirement: 'required', reason: 'Read issues.',
          assignment: { type: 'agent', targetAgents: ['backend_dev'], targetId: null },
          agentPermissions: { backend_dev: ['github.issues.read'] },
          prohibitedCapabilities: [], fallback: { action: 'block', message: 'Revise.' },
        }, {
          mcpId: 'github', requirement: 'required', reason: 'Deny issue reads.',
          assignment: { type: 'agent', targetAgents: ['backend-dev'], targetId: null },
          agentPermissions: {}, prohibitedCapabilities: ['github.issues.read'],
          fallback: { action: 'block', message: 'Revise.' },
        }],
        promptOverlays: {},
        requirementContexts: [],
        mcpAwareSubtasks: [],
      }),
      '```',
    ].join('\n'), overview)
    const { buildWorkforceMaterializationRows } = await import('@/worker/workforce-materializer')
    let nextId = 0
    const materialized = buildWorkforceMaterializationRows({
      taskId,
      architectRunId: 'run-1',
      artifactId: 'artifact-1',
      prepared: preparedArtifact,
    }, {
      activeAgents: [{ agentType: 'backend-dev', displayName: 'Backend Dev' }],
      idFactory: () => `00000000-0000-4000-8000-${String(++nextId).padStart(12, '0')}`,
    }).workPackages[0]
    expect(materialized.mcpRequirements).toEqual([
      expect.objectContaining({ agent: 'backend-dev', permissions: ['github.issues.read'] }),
      expect.objectContaining({ agent: 'backend-dev', prohibitedCapabilities: ['github.issues.read'] }),
    ])

    const awaitingTask = {
      id: taskId,
      projectId: 'project-1',
      status: 'awaiting_approval',
      updatedAt: new Date('2026-07-14T00:00:00.000Z'),
    }
    const project = { id: 'project-1', mcpConfig: overview.config }
    mockDbSelect
      .mockReturnValueOnce(chain([awaitingTask]))
      .mockReturnValueOnce(chain([project]))
      .mockReturnValueOnce(chain([project]))
      .mockReturnValueOnce(chain([awaitingTask]))
      .mockReturnValueOnce(chain([materialized]))

    const { POST } = await import('@/app/api/tasks/[id]/approve/route')
    const res = await POST(authRequest(`/api/tasks/${taskId}/approve`, { method: 'POST' }) as never, {
      params: Promise.resolve({ id: taskId }),
    })

    expect(res.status).toBe(409)
    await expect(res.json()).resolves.toMatchObject({
      primaryMode: 'blocked',
      primaryRecoveryAction: 'revise_plan',
      reason: expect.stringContaining('prohibited'),
      workPackageId: materialized.id,
    })
    expect(mockDbUpdate).not.toHaveBeenCalled()
    expect(mockRedisLpush).not.toHaveBeenCalled()
  })

  it.each([
    ['malformed deferred requirement', {
      schemaVersion: 1,
      requirements: [{
        mcpId: '', requirement: 'required',
        assignment: { type: 'agent', targetAgents: ['backend'], targetId: null },
        agentPermissions: { backend: ['github.contents.write'] },
        prohibitedCapabilities: [], fallback: { action: 'block', message: 'Revise.' },
      }],
      promptOverlays: {}, requirementContexts: [], mcpAwareSubtasks: [],
    }, 'github.contents.write'],
    ['malformed requirement context', {
      schemaVersion: 1,
      requirements: [{
        mcpId: 'github', requirement: 'required', reason: 'Read issues.',
        assignment: { type: 'agent', targetAgents: ['backend'], targetId: null },
        agentPermissions: { backend: ['github.issues.read'] },
        prohibitedCapabilities: [], fallback: { action: 'block', message: 'Revise.' },
      }],
      promptOverlays: {},
      requirementContexts: [{ sourceRequirementIndex: '0', agent: 'backend', promptOverlay: 'RAW-CONTEXT' }],
      mcpAwareSubtasks: [],
    }, 'RAW-CONTEXT'],
    ['overflowing deferred subtask', overflowingSubtaskPolicy('github.contents.write'), 'github.contents.write'],
    ['overflowing prohibited subtask', overflowingSubtaskPolicy('github.issues.read', ['github.issues.read']), 'github.issues.read'],
    ['overflowing malformed subtask', overflowingSubtaskPolicy('github..read'), 'github..read'],
    ['overflowing cross-MCP subtask', overflowingSubtaskPolicy('filesystem.project.read'), 'filesystem.project.read'],
  ] as const)('propagates %s through artifact, materializer, and real approval', async (_label, rawDesign, rawPolicyText) => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    const taskId = 'task-nested-policy-invalid'
    const overview = {
      projectId: 'project-1',
      config: { profile: 'default' as const, requiredMcps: [], overrides: {} },
      catalog: [], mcpsRoot: '/tmp/mcps', statuses: [],
      summary: { label: 'Unavailable', status: 'missing' as const, missing: 0, authRequired: 0, unhealthy: 0, disabled: 0 },
    }
    const { prepareArchitectArtifact } = await import('@/worker/architect-artifact')
    const preparedArtifact = prepareArchitectArtifact([
      '# Plan',
      '- [Backend] Implement the package safely.',
      '```mcp_execution_design_json',
      JSON.stringify(rawDesign),
      '```',
    ].join('\n'), overview)
    expect(preparedArtifact.mcpExecutionDesign.proposed?.normalizationErrors?.length).toBeGreaterThan(0)
    expect(preparedArtifact.mcpExecutionDesign.proposed?.normalizationEvidence).toEqual([
      expect.objectContaining({ schemaVersion: 1, category: 'normalization', code: 'mcp_design_nested_policy_invalid' }),
    ])
    expect(JSON.stringify(preparedArtifact.mcpExecutionDesign.proposed?.normalizationEvidence)).not.toContain(rawPolicyText)
    if (_label.startsWith('overflowing ')) {
      expect(preparedArtifact.mcpExecutionDesign.proposed?.mcpAwareSubtasks).toEqual([])
    }

    const { buildWorkforceMaterializationRows } = await import('@/worker/workforce-materializer')
    let nextId = 0
    const materialized = buildWorkforceMaterializationRows({
      taskId,
      architectRunId: 'run-1',
      artifactId: 'artifact-1',
      prepared: preparedArtifact,
    }, {
      activeAgents: [{ agentType: 'backend', displayName: 'Backend' }],
      idFactory: () => `00000000-0000-4000-8000-${String(++nextId).padStart(12, '0')}`,
    }).workPackages[0]
    expect(materialized.metadata).toMatchObject({
      mcpNormalizationEvidence: [expect.objectContaining({ code: 'mcp_design_nested_policy_invalid' })],
    })
    expect((materialized.metadata as { mcpNormalizationErrors: string[] }).mcpNormalizationErrors)
      .toEqual(expect.arrayContaining([expect.any(String)]))
    if (_label.startsWith('overflowing ')) {
      expect(materialized.metadata).toMatchObject({ mcpAwareSubtasks: [] })
    }

    const awaitingTask = {
      id: taskId,
      projectId: 'project-1',
      status: 'awaiting_approval',
      updatedAt: new Date('2026-07-14T00:00:00.000Z'),
    }
    const project = { id: 'project-1', mcpConfig: overview.config }
    mockDbSelect
      .mockReturnValueOnce(chain([awaitingTask]))
      .mockReturnValueOnce(chain([project]))
      .mockReturnValueOnce(chain([project]))
      .mockReturnValueOnce(chain([awaitingTask]))
      .mockReturnValueOnce(chain([materialized]))

    const { POST } = await import('@/app/api/tasks/[id]/approve/route')
    const res = await POST(authRequest(`/api/tasks/${taskId}/approve`, { method: 'POST' }) as never, {
      params: Promise.resolve({ id: taskId }),
    })
    expect(res.status).toBe(409)
    await expect(res.json()).resolves.toMatchObject({
      error: expect.stringContaining('MCP'),
      primaryRecoveryAction: 'revise_plan',
      retryable: false,
      workPackageId: materialized.id,
    })
    expect(mockDbUpdate).not.toHaveBeenCalled()
    expect(mockRedisLpush).not.toHaveBeenCalled()
  })

  it('propagates duplicate JSON object-key blockers through artifact, materializer, and real approval', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    const taskId = 'task-duplicate-json-policy-key'
    const duplicateKey = 'sk_live_DUPLICATE_POLICY_SECRET'
    const overview = {
      projectId: 'project-1',
      config: { profile: 'default' as const, requiredMcps: [], overrides: {} },
      catalog: [], mcpsRoot: '/tmp/mcps', statuses: [],
      summary: { label: 'Unavailable', status: 'missing' as const, missing: 0, authRequired: 0, unhealthy: 0, disabled: 0 },
    }
    const rawDesign = String.raw`{"schemaVersion":1,"requirements":[],"promptOverlays":{},"requirementContexts":[],"mcpAwareSubtasks":[],"${duplicateKey}":{"assignment":{"type":"agent","type":"architect_only"}},"${duplicateKey}":{}}`
    const { prepareArchitectArtifact } = await import('@/worker/architect-artifact')
    const preparedArtifact = prepareArchitectArtifact([
      '# Plan',
      '- [Backend] Implement the package safely.',
      '```mcp_execution_design_json',
      rawDesign,
      '```',
    ].join('\n'), overview)

    expect(preparedArtifact.planText).not.toContain('mcp_execution_design_json')
    expect(preparedArtifact.planText).not.toContain(duplicateKey)
    expect(preparedArtifact.mcpExecutionDesign.proposed).toMatchObject({
      requirements: [],
      normalizationEvidence: [{
        schemaVersion: 1,
        category: 'parse',
        code: 'mcp_design_json_duplicate_object_key',
      }],
    })
    expect(JSON.stringify(preparedArtifact.mcpExecutionDesign.proposed)).not.toContain(duplicateKey)

    const { buildWorkforceMaterializationRows } = await import('@/worker/workforce-materializer')
    let nextId = 0
    const materialized = buildWorkforceMaterializationRows({
      taskId,
      architectRunId: 'run-1',
      artifactId: 'artifact-1',
      prepared: preparedArtifact,
    }, {
      activeAgents: [{ agentType: 'backend', displayName: 'Backend' }],
      idFactory: () => `00000000-0000-4000-8000-${String(++nextId).padStart(12, '0')}`,
    }).workPackages[0]
    expect(materialized.metadata).toMatchObject({
      mcpNormalizationEvidence: [expect.objectContaining({
        category: 'parse',
        code: 'mcp_design_json_duplicate_object_key',
      })],
    })
    expect(JSON.stringify(materialized.metadata)).not.toContain(duplicateKey)

    const awaitingTask = {
      id: taskId,
      projectId: 'project-1',
      status: 'awaiting_approval',
      updatedAt: new Date('2026-07-14T00:00:00.000Z'),
    }
    const project = { id: 'project-1', mcpConfig: overview.config }
    mockDbSelect
      .mockReturnValueOnce(chain([awaitingTask]))
      .mockReturnValueOnce(chain([project]))
      .mockReturnValueOnce(chain([project]))
      .mockReturnValueOnce(chain([awaitingTask]))
      .mockReturnValueOnce(chain([materialized]))

    const { POST } = await import('@/app/api/tasks/[id]/approve/route')
    const res = await POST(authRequest(`/api/tasks/${taskId}/approve`, { method: 'POST' }) as never, {
      params: Promise.resolve({ id: taskId }),
    })
    expect(res.status).toBe(409)
    await expect(res.json()).resolves.toMatchObject({
      error: expect.stringContaining('MCP'),
      primaryRecoveryAction: 'revise_plan',
      retryable: false,
      workPackageId: materialized.id,
    })
    expect(mockDbUpdate).not.toHaveBeenCalled()
    expect(mockRedisLpush).not.toHaveBeenCalled()
  })

  it('refuses approval when an unresolved materialized package carries normalization blockers', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    const normalizationError = 'MCP requirement 0 prohibitedCapabilities exceeds the maximum of 30 entries and was truncated.'
    const { buildWorkforceMaterializationRows } = await import('@/worker/workforce-materializer')
    let nextId = 0
    const rows = buildWorkforceMaterializationRows({
      taskId: 'task-normalization-blocked',
      architectRunId: 'run-1',
      artifactId: 'artifact-1',
      prepared: {
        planText: '# Plan\nImplement the requested change.',
        questions: [],
        agents: [{ role: 'Unconfigured Specialist', tasks: 1, summary: 'Implement APIs', steps: ['Implement safely'] }],
        agentBreakdownSource: 'fence',
        capabilityClassification: {
          proposed: { schemaVersion: 1, required: [], optional: [], excluded: [] },
          validation: { status: 'valid', warnings: [] },
        },
        mcpExecutionDesign: {
          proposed: {
            schemaVersion: 1,
            requirements: [],
            promptOverlays: {},
            requirementContexts: [],
            mcpAwareSubtasks: [],
            normalizationErrors: [normalizationError],
            normalizationEvidence: [{
              schemaVersion: 1,
              category: 'normalization',
              code: 'mcp_design_nested_policy_invalid',
              message: 'MCP execution design contains one invalid nested policy declaration.',
            }],
          },
          validation: {
            status: 'blocked',
            runtimeEnforcement: 'not_implemented',
            health: [],
            blocked: [normalizationError],
            warnings: [],
          },
          grantDecisions: {
            schemaVersion: 1,
            runtimeEnforcement: 'not_implemented',
            summary: { proposed: 0, warning: 0, blocked: 0 },
            decisions: [],
          },
        },
      },
    }, {
      activeAgents: [{ agentType: 'backend', displayName: 'Backend' }],
      idFactory: () => `00000000-0000-4000-8000-${String(++nextId).padStart(12, '0')}`,
    })
    const materializedPackage = rows.workPackages[0]
    expect(materializedPackage.metadata).toMatchObject({
      mcpNormalizationErrors: [normalizationError],
      mcpNormalizationEvidence: [expect.objectContaining({
        category: 'normalization',
        code: 'mcp_design_nested_policy_invalid',
      })],
    })

    const awaitingTask = {
      id: 'task-normalization-blocked',
      projectId: 'project-1',
      status: 'awaiting_approval',
      updatedAt: new Date('2026-07-14T00:00:00.000Z'),
    }
    const project = { id: 'project-1', mcpConfig: {} }
    mockDbSelect
      .mockReturnValueOnce(chain([awaitingTask]))
      .mockReturnValueOnce(chain([project]))
      .mockReturnValueOnce(chain([project]))
      .mockReturnValueOnce(chain([awaitingTask]))
      .mockReturnValueOnce(chain([materializedPackage]))

    const { POST } = await import('@/app/api/tasks/[id]/approve/route')
    const res = await POST(authRequest('/api/tasks/task-normalization-blocked/approve', { method: 'POST' }) as never, {
      params: Promise.resolve({ id: awaitingTask.id }),
    })

    expect(res.status).toBe(409)
    await expect(res.json()).resolves.toMatchObject({
      error: expect.stringContaining(normalizationError),
      primaryRecoveryAction: 'revise_plan',
      workPackageId: materializedPackage.id,
    })
    expect(mockDbUpdate).not.toHaveBeenCalled()
    expect(mockRedisLpush).not.toHaveBeenCalled()
  })

  it('refuses plan approval when required filesystem context is explicitly denied', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    const awaitingTask = {
      id: 'task-approval',
      projectId: 'project-1',
      status: 'awaiting_approval',
      updatedAt: new Date('2026-06-25T00:00:00.000Z'),
    }
    const workPackageRow = {
      id: 'pkg-fs',
      assignedRole: 'frontend',
      title: 'Frontend work package',
      mcpRequirements: [{
        mcpId: 'filesystem',
        agent: 'frontend',
        requirement: 'required',
        capabilities: ['filesystem.project.read', 'filesystem.project.search'],
        fallback: { action: 'block', message: '' },
      }],
      metadata: {
        mcpGrantPhases: {
          effective: {
            schemaVersion: 1,
            phase: 'effective',
            source: 'explicit-grant-approval',
            grantApprovalId: 'grant-denied-1',
            runtimeEnforcement: 'bounded_context_packet',
            status: 'denied',
            deniedAt: '2026-06-25T00:00:00.000Z',
            deniedCapabilities: ['filesystem.project.read', 'filesystem.project.search'],
          },
        },
      },
    }
    mockDbSelect
      .mockReturnValueOnce(chain([awaitingTask]))
      .mockReturnValueOnce(chain([{ id: 'project-1', mcpConfig: {} }]))
      .mockReturnValueOnce(chain([{ id: 'project-1', mcpConfig: {} }]))
      .mockReturnValueOnce(chain([awaitingTask]))
      .mockReturnValueOnce(chain([workPackageRow]))

    const { POST } = await import('@/app/api/tasks/[id]/approve/route')
    const res = await POST(authRequest('/api/tasks/task-approval/approve', { method: 'POST' }) as never, {
      params: Promise.resolve({ id: 'task-approval' }),
    })

    expect(res.status).toBe(409)
    await expect(res.json()).resolves.toMatchObject({
      primaryRecoveryAction: 'approve_project_filesystem_context',
      workPackageId: 'pkg-fs',
    })
    expect(mockDbUpdate).not.toHaveBeenCalled()
    expect(mockRedisLpush).not.toHaveBeenCalled()
  })

  it('uses project-level filesystem approval when approving a plan', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    const awaitingTask = {
      id: 'task-approval',
      projectId: 'project-1',
      status: 'awaiting_approval',
      updatedAt: new Date('2026-06-25T00:00:00.000Z'),
    }
    const { deriveMcpGrantDecisions, evaluateWorkPackageMcpBroker, parseMcpExecutionDesign } =
      await import('@/worker/mcp-execution-design')
    const normalizedDesign = parseMcpExecutionDesign(`\`\`\`mcp_execution_design_json\n${JSON.stringify({
      schemaVersion: 1,
      requirements: [{
        mcpId: 'filesystem',
        requirement: 'required',
        reason: 'Read and search project files.',
        assignment: { type: 'agent', targetAgents: ['frontend'], targetId: null },
        agentPermissions: { frontend: ['filesystem.project.read', 'filesystem.project.search'] },
        prohibitedCapabilities: [],
        fallback: { action: 'block', message: '' },
      }],
      promptOverlays: {},
      requirementContexts: [],
      mcpAwareSubtasks: [],
    })}\n\`\`\``).design!
    const normalizedRequirement = normalizedDesign.requirements[0]
    const workPackageRow = {
      id: 'pkg-fs',
      assignedRole: 'frontend',
      title: 'Frontend work package',
      mcpRequirements: [{
        requirementKey: normalizedRequirement.requirementKey,
        sourceRequirementIndex: normalizedRequirement.sourceRequirementIndex,
        mcpId: 'filesystem',
        agent: 'frontend',
        requirement: 'required',
        permissions: ['filesystem.project.read', 'filesystem.project.search'],
        prohibitedCapabilities: [],
        assignment: { type: 'agent', targetId: null },
        fallback: { action: 'block', message: '' },
      }],
      metadata: { mcpGrants: [] },
    }
    const taskUpdate = chain([{ ...awaitingTask, status: 'approved', updatedAt: new Date('2026-06-25T00:01:00.000Z') }])
    taskUpdate.set = vi.fn(() => taskUpdate)
    const packageUpdate = chain([{ id: 'pkg-fs' }])
    packageUpdate.set = vi.fn(() => packageUpdate)
    const gateUpdate = chain([{ id: 'gate-1' }])
    gateUpdate.set = vi.fn(() => gateUpdate)
    const projectRow = {
      id: 'project-1',
      rootBindingRevision: BigInt(1),
      mcpConfig: {
          profile: 'default' as const,
          requiredMcps: ['filesystem'],
          overrides: {},
          grants: {
            filesystem: {
              schemaVersion: 2,
              mcpId: 'filesystem',
              status: 'approved',
              grantMode: 'always_allow',
              capabilities: ['filesystem.project.read', 'filesystem.project.search'],
              grantApprovalId: 'grant-approval-1',
              approvedAt: '2026-07-05T00:00:00.000Z',
              approvedBy: FAKE_SESSION.userId,
              reason: 'Trusted project.',
              grantDecisionRevision: '1',
              rootBindingRevision: '1',
            },
          },
        },
    }
    const fixedOverview = {
      projectId: 'project-1', rootBindingRevision: '1', config: projectRow.mcpConfig, catalog: [], mcpsRoot: '/tmp/mcps',
      filesystemGrantDecision: {
        schemaVersion: 2 as const,
        decisionId: 'grant-approval-1',
        projectId: 'project-1',
        decision: 'approved' as const,
        capabilities: ['filesystem.project.read', 'filesystem.project.search'],
        grantDecisionRevision: '1',
        rootBindingRevision: '1',
        decisionFingerprint: `sha256:${'1'.repeat(64)}`,
        decisionGeneration: '1',
        decidedAt: '2026-07-05T00:00:00.000Z',
        decidedBy: FAKE_SESSION.userId,
        reason: 'Trusted project.',
        revocationReason: null,
      },
      statuses: [{
        mcpId: 'filesystem', displayName: 'Filesystem', description: '', installPath: '/tmp/mcps/filesystem',
        installState: 'installed' as const, status: 'healthy' as const, enabled: true, error: null,
        checkedAt: '2026-07-05T00:00:01.000Z',
      }],
      summary: { label: 'Healthy', status: 'healthy' as const, missing: 0, authRequired: 0, unhealthy: 0, disabled: 0 },
    }
    const preview = deriveMcpGrantDecisions(normalizedDesign, fixedOverview)
    expect(preview).toMatchObject({
      admissionStatus: 'allowed',
      decisions: [expect.objectContaining({ mode: 'bounded_context_approved', admissionStatus: 'allowed' })],
    })
    mockGetProjectMcpOverview.mockResolvedValueOnce(fixedOverview)
    mockLoadCurrentProjectFilesystemDecision
      .mockResolvedValueOnce(fixedOverview.filesystemGrantDecision)
      .mockResolvedValueOnce(fixedOverview.filesystemGrantDecision)
    mockDbSelect
      .mockReturnValueOnce(chain([awaitingTask]))
      .mockReturnValueOnce(chain([projectRow]))
      .mockReturnValueOnce(chain([projectRow]))
      .mockReturnValueOnce(chain([awaitingTask]))
      .mockReturnValueOnce(chain([workPackageRow]))
    mockDbUpdate
      .mockReturnValueOnce(taskUpdate)
      .mockReturnValueOnce(packageUpdate)
      .mockReturnValueOnce(gateUpdate)
    mockRedisLpush.mockResolvedValue(1)
    mockRedisPublish.mockResolvedValue(1)

    const { POST } = await import('@/app/api/tasks/[id]/approve/route')
    const res = await POST(authRequest('/api/tasks/task-approval/approve', { method: 'POST' }) as never, {
      params: Promise.resolve({ id: 'task-approval' }),
    })

    expect(res.status).toBe(200)
    const packageSetMock = packageUpdate.set as unknown as { mock: { calls: Array<[{ metadata?: { queryChunks?: unknown[] } }]> } }
    const packageGrantPhasesJson = packageSetMock.mock.calls[0][0].metadata?.queryChunks
      ?.find((chunk): chunk is string => typeof chunk === 'string' && chunk.includes('"project-filesystem-approval"'))
    expect(packageGrantPhasesJson).toBeDefined()
    const approvedPhases = JSON.parse(packageGrantPhasesJson as string)
    expect(approvedPhases).toMatchObject({
      effective: {
        source: 'project-filesystem-approval',
        grantMode: 'always_allow',
        grantApprovalId: 'grant-approval-1',
        status: 'approved',
        grants: [expect.objectContaining({
          grantApprovalId: 'grant-approval-1',
          capabilities: ['filesystem.project.read', 'filesystem.project.search'],
        })],
      },
    })
    const gateSetMock = gateUpdate.set as unknown as { mock: { calls: Array<[{ metadata?: { queryChunks?: unknown[] } }]> } }
    const approvalSnapshotJson = gateSetMock.mock.calls[0][0].metadata?.queryChunks
      ?.find((chunk): chunk is string => typeof chunk === 'string' && chunk.includes('approvalHealthSnapshot'))
    expect(JSON.parse(approvalSnapshotJson as string)).toMatchObject({
      approvalHealthSnapshot: [{
        schemaVersion: 1,
        observed: true,
        mcpId: 'filesystem',
        installState: 'installed',
        status: 'healthy',
        enabled: true,
        error: null,
        checkedAt: '2026-07-05T00:00:01.000Z',
      }],
    })
    expect(mockRedisLpush).toHaveBeenCalledWith(
      'forge:approvals',
      JSON.stringify({ taskId: 'task-approval', action: 'approve' }),
    )

    const approvedPackage = {
      ...workPackageRow,
      blockedReason: null,
      harnessId: 'harness-1',
      metadata: { ...workPackageRow.metadata, mcpGrantPhases: approvedPhases },
      sequence: 1,
      status: 'pending',
      updatedAt: new Date('2026-06-25T00:01:00.000Z'),
    }
    const broker = evaluateWorkPackageMcpBroker({
      assignedRole: approvedPackage.assignedRole,
      mcpOverview: fixedOverview,
      mcpRequirements: approvedPackage.mcpRequirements,
      metadata: approvedPackage.metadata,
      projectMcpConfig: projectRow.mcpConfig,
      projectFilesystemDecision: fixedOverview.filesystemGrantDecision,
      projectRootBindingRevision: projectRow.rootBindingRevision,
      title: approvedPackage.title,
    })
    expect(broker).toMatchObject({
      status: preview.admissionStatus,
      evaluations: [expect.objectContaining({
        decision: expect.objectContaining({ mode: preview.decisions[0].mode, status: 'allowed' }),
      })],
    })

    const selectFallback = mockDbSelect.getMockImplementation()
    const updateFallback = mockDbUpdate.getMockImplementation()
    mockDbSelect.mockReset()
    mockDbUpdate.mockReset()
    if (selectFallback) mockDbSelect.mockImplementation(selectFallback)
    if (updateFallback) mockDbUpdate.mockImplementation(updateFallback)
    mockGetProjectMcpOverview.mockReset()
    mockGetProjectMcpOverview.mockResolvedValueOnce(fixedOverview)
    mockLoadCurrentProjectFilesystemDecision.mockResolvedValueOnce(fixedOverview.filesystemGrantDecision)
    mockDbSelect
      .mockReturnValueOnce(chain([approvedPackage]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([{ project: projectRow }]))
      .mockReturnValueOnce(chain([{
        ...approvedPackage,
        localPath: null,
        mcpConfig: projectRow.mcpConfig,
        projectId: projectRow.id,
        rootBindingRevision: projectRow.rootBindingRevision,
      }]))
      .mockReturnValueOnce(chain([{
        id: projectRow.id,
        localPath: null,
        mcpConfig: projectRow.mcpConfig,
        rootBindingRevision: projectRow.rootBindingRevision,
      }]))
      .mockReturnValueOnce(chain([{
        id: 'task-approval',
        projectId: projectRow.id,
      }]))
      .mockReturnValueOnce(chain([approvedPackage]))
    const readyUpdate = chain([{ id: approvedPackage.id }])
    readyUpdate.set = vi.fn(() => readyUpdate)
    mockDbUpdate.mockReturnValueOnce(readyUpdate)
    const { handoffApprovedWorkPackages } = await vi.importActual<typeof import('@/worker/work-package-handoff')>(
      '@/worker/work-package-handoff',
    )
    await expect(handoffApprovedWorkPackages('task-approval', { claimEnabled: false })).resolves.toMatchObject({
      status: 'ready_only',
      readyPackageIds: [approvedPackage.id],
    })
    expect(readyUpdate.set).toHaveBeenCalledWith(expect.objectContaining({
      blockedReason: null,
      status: 'ready',
    }))
  })

  it('approves requirement-scoped planning context and queues the approval worker job', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    const awaitingTask = {
      id: 'task-approval',
      projectId: 'project-1',
      status: 'awaiting_approval',
      updatedAt: new Date('2026-06-25T00:00:00.000Z'),
    }
    const workPackageRow = {
      id: 'pkg-1',
      assignedRole: 'backend',
      title: 'Backend package',
      mcpRequirements: [{
        requirementKey: 'mcp-req-v1-github-read-1',
        sourceRequirementIndex: 0,
        mcpId: 'github',
        agent: 'backend',
        requirement: 'required',
        capabilities: ['github.issues.read'],
        assignment: { type: 'agent', targetId: null },
        fallback: { action: 'block', message: '' },
      }],
      metadata: {
        mcpGrants: [],
        promptOverlay: 'Use the supplied GitHub issue context.',
        requirementContexts: [{
          requirementKey: 'mcp-req-v1-github-read-1',
          agent: 'backend',
          mcpId: 'github',
          promptOverlay: 'Use the supplied GitHub issue context.',
        }],
      },
    }
    const approvedTask = {
      ...awaitingTask,
      status: 'approved',
      updatedAt: new Date('2026-06-25T00:01:00.000Z'),
    }
    const taskUpdate = chain([approvedTask])
    taskUpdate.set = vi.fn(() => taskUpdate)
    const packageUpdate = chain([{ id: 'pkg-1' }])
    packageUpdate.set = vi.fn(() => packageUpdate)
    const gateUpdate = chain([{ id: 'gate-1' }])
    gateUpdate.set = vi.fn(() => gateUpdate)
    mockDbSelect
      .mockReturnValueOnce(chain([awaitingTask]))
      .mockReturnValueOnce(chain([{ id: 'project-1', mcpConfig: {} }]))
      .mockReturnValueOnce(chain([{ id: 'project-1', mcpConfig: {} }]))
      .mockReturnValueOnce(chain([awaitingTask]))
      .mockReturnValueOnce(chain([workPackageRow]))
    mockDbUpdate
      .mockReturnValueOnce(taskUpdate)
      .mockReturnValueOnce(packageUpdate)
      .mockReturnValueOnce(gateUpdate)
    mockRedisLpush.mockResolvedValue(1)
    mockRedisPublish.mockResolvedValue(1)

    const { POST } = await import('@/app/api/tasks/[id]/approve/route')
    const res = await POST(authRequest('/api/tasks/task-approval/approve', { method: 'POST' }) as never, {
      params: Promise.resolve({ id: 'task-approval' }),
    })

    expect(res.status).toBe(200)
    expect(mockDbUpdate).toHaveBeenCalledTimes(3)
    const packageSetMock = packageUpdate.set as unknown as { mock: { calls: Array<[{ metadata?: { queryChunks?: unknown[] } }]> } }
    const packageSetPayload = packageSetMock.mock.calls[0][0]
    const packageGrantPhasesJson = packageSetPayload.metadata?.queryChunks
      ?.find((chunk): chunk is string => typeof chunk === 'string' && chunk.includes('"phase":"approved"'))
    expect(packageGrantPhasesJson).toBeDefined()
    expect(JSON.parse(packageGrantPhasesJson as string)).toMatchObject({
      schemaVersion: 1,
      approved: {
        phase: 'approved',
        runtimeEnforcement: 'approved_snapshot',
        grants: [],
      },
      effective: {
        phase: 'effective',
        runtimeEnforcement: 'approved_snapshot',
        source: 'task-approval',
        status: 'not_issued',
        grants: [],
      },
    })
    expect(gateUpdate.set).toHaveBeenCalledWith(expect.objectContaining({
      decidedBy: FAKE_SESSION.userId,
      status: 'approved',
    }))
    const gateSetMock = gateUpdate.set as unknown as { mock: { calls: Array<[{ metadata?: { queryChunks?: unknown[] } }]> } }
    const gateSetPayload = gateSetMock.mock.calls[0][0]
    const grantSnapshotJson = gateSetPayload.metadata?.queryChunks
      ?.find((chunk): chunk is string => typeof chunk === 'string' && chunk.includes('mcpGrantPhases'))
    expect(grantSnapshotJson).toBeDefined()
    expect(JSON.parse(grantSnapshotJson as string)).toMatchObject({
      approval: {
        approvedBy: FAKE_SESSION.userId,
        source: 'task-approval',
      },
      mcpGrantPhases: {
        approved: {
          phase: 'approved',
          runtimeIssued: false,
          runtimeEnforcement: 'approved_snapshot',
          packages: [{
            workPackageId: 'pkg-1',
            assignedRole: 'backend',
            proposedGrants: [],
            approvedGrants: [],
            effectiveGrants: [],
            proposedRequirements: [expect.objectContaining({
              mcpId: 'github',
              capabilities: ['github.issues.read'],
            })],
            promptOverlayPresent: true,
          }],
        },
        effective: {
          phase: 'effective',
          runtimeIssued: false,
          runtimeEnforcement: 'approved_snapshot',
          status: 'package_scoped',
        },
      },
      approvalHealthSnapshot: [{
        schemaVersion: 1,
        observed: false,
        mcpId: 'github',
        installState: 'unknown',
        status: 'unknown',
        enabled: false,
        error: null,
        checkedAt: null,
      }],
    })
    expect(mockRedisLpush).toHaveBeenCalledWith(
      'forge:approvals',
      JSON.stringify({ taskId: 'task-approval', action: 'approve' }),
    )
    const gateEvent = mockRedisPublish.mock.calls
      .map(([, payload]) => JSON.parse(payload as string))
      .find((payload) => payload.type === 'approval_gate:decided')
    expect(gateEvent).toMatchObject({
      gateId: 'gate-1',
      gateType: 'plan_approval',
      status: 'approved',
    })
    expect(mockRedisPublish).toHaveBeenCalledWith(
      'forge:task:task-approval',
      expect.stringContaining('"type":"approval_gate:decided"'),
    )
  })

  it('preserves explicit filesystem effective grants when approving the plan', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    const explicitEffective = {
      schemaVersion: 2,
      phase: 'effective',
      source: 'explicit-grant-approval',
      grantApprovalId: 'grant-approval-1',
      grantMode: 'allow_once',
      runtimeIssued: false,
      runtimeEnforcement: 'bounded_context_packet',
      status: 'approved',
      grantDecisionRevision: '1',
      rootBindingRevision: '1',
      grants: [{
        mcpId: 'filesystem',
        status: 'approved',
        capabilities: ['filesystem.project.read'],
      }],
    }
    const awaitingTask = {
      id: 'task-approval',
      projectId: 'project-1',
      status: 'awaiting_approval',
      updatedAt: new Date('2026-06-25T00:00:00.000Z'),
    }
    const workPackageRow = {
      id: 'pkg-1',
      assignedRole: 'backend',
      title: 'Backend package',
      mcpRequirements: [{
        mcpId: 'filesystem',
        agent: 'backend',
        requirement: 'required',
        capabilities: ['filesystem.project.read'],
        fallback: { action: 'block', message: '' },
      }],
      metadata: {
        mcpGrants: [],
        mcpGrantPhases: { effective: explicitEffective },
      },
    }
    const approvedTask = {
      ...awaitingTask,
      status: 'approved',
      updatedAt: new Date('2026-06-25T00:01:00.000Z'),
    }
    const taskUpdate = chain([approvedTask])
    taskUpdate.set = vi.fn(() => taskUpdate)
    const packageUpdate = chain([{ id: 'pkg-1' }])
    packageUpdate.set = vi.fn(() => packageUpdate)
    const gateUpdate = chain([{ id: 'gate-1' }])
    gateUpdate.set = vi.fn(() => gateUpdate)
    mockGetProjectMcpOverview.mockResolvedValueOnce({
      projectId: 'project-1', rootBindingRevision: '1', config: {}, catalog: [], mcpsRoot: '/tmp/mcps',
      statuses: [{
        mcpId: 'filesystem', displayName: 'Filesystem', description: '', installPath: '/tmp/mcps/filesystem',
        installState: 'installed', status: 'healthy', enabled: true, error: null,
        checkedAt: '2026-06-25T00:00:30.000Z',
      }],
      summary: { label: 'Healthy', status: 'healthy', missing: 0, authRequired: 0, unhealthy: 0, disabled: 0 },
    })
    mockDbSelect
      .mockReturnValueOnce(chain([awaitingTask]))
      .mockReturnValueOnce(chain([{ id: 'project-1', mcpConfig: {}, rootBindingRevision: BigInt(1) }]))
      .mockReturnValueOnce(chain([{ id: 'project-1', mcpConfig: {}, rootBindingRevision: BigInt(1) }]))
      .mockReturnValueOnce(chain([awaitingTask]))
      .mockReturnValueOnce(chain([workPackageRow]))
    mockDbUpdate
      .mockReturnValueOnce(taskUpdate)
      .mockReturnValueOnce(packageUpdate)
      .mockReturnValueOnce(gateUpdate)
    mockRedisLpush.mockResolvedValue(1)
    mockRedisPublish.mockResolvedValue(1)

    const { POST } = await import('@/app/api/tasks/[id]/approve/route')
    const res = await POST(authRequest('/api/tasks/task-approval/approve', { method: 'POST' }) as never, {
      params: Promise.resolve({ id: 'task-approval' }),
    })

    expect(res.status).toBe(200)
    const packageSetMock = packageUpdate.set as unknown as { mock: { calls: Array<[{ metadata?: { queryChunks?: unknown[] } }]> } }
    const packageGrantPhasesJson = packageSetMock.mock.calls[0][0].metadata?.queryChunks
      ?.find((chunk): chunk is string => typeof chunk === 'string' && chunk.includes('"phase":"approved"'))
    expect(JSON.parse(packageGrantPhasesJson as string)).toMatchObject({
      effective: explicitEffective,
    })
  })

  it('keeps approval intact when the approval worker job enqueue result is uncertain', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    const awaitingTask = {
      id: 'task-approval',
      projectId: 'project-1',
      status: 'awaiting_approval',
      updatedAt: new Date('2026-06-25T00:00:00.000Z'),
    }
    const approvedTask = {
      ...awaitingTask,
      status: 'approved',
      updatedAt: new Date('2026-06-25T00:01:00.000Z'),
    }
    const taskUpdate = chain([approvedTask])
    taskUpdate.set = vi.fn(() => taskUpdate)
    const gateUpdate = chain([{ id: 'gate-1' }])
    gateUpdate.set = vi.fn(() => gateUpdate)
    mockDbSelect
      .mockReturnValueOnce(chain([awaitingTask]))
      .mockReturnValueOnce(chain([{ id: 'project-1', mcpConfig: {} }]))
      .mockReturnValueOnce(chain([{ id: 'project-1', mcpConfig: {} }]))
      .mockReturnValueOnce(chain([awaitingTask]))
      .mockReturnValueOnce(chain([]))
    mockDbUpdate
      .mockReturnValueOnce(taskUpdate)
      .mockReturnValueOnce(gateUpdate)
    mockRedisLpush.mockRejectedValueOnce(new Error('redis unavailable'))

    const { POST } = await import('@/app/api/tasks/[id]/approve/route')
    const res = await POST(authRequest('/api/tasks/task-approval/approve', { method: 'POST' }) as never, {
      params: Promise.resolve({ id: 'task-approval' }),
    })

    expect(res.status).toBe(202)
    const body = await res.json()
    expect(body.error).toMatch(/could not be confirmed/i)
    expect(body.task).toMatchObject({ id: 'task-approval', status: 'approved' })
    expect(taskUpdate.set).toHaveBeenCalledWith(expect.objectContaining({
      errorMessage: null,
      status: 'approved',
    }))
    expect(mockDbUpdate).toHaveBeenCalledTimes(2)
    expect(mockRedisPublish).not.toHaveBeenCalled()
  })

  it('treats approval progress publish failures as best-effort after the worker job is queued', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    const awaitingTask = {
      id: 'task-approval',
      projectId: 'project-1',
      status: 'awaiting_approval',
      updatedAt: new Date('2026-06-25T00:00:00.000Z'),
    }
    const approvedTask = {
      ...awaitingTask,
      status: 'approved',
      updatedAt: new Date('2026-06-25T00:01:00.000Z'),
    }
    const taskUpdate = chain([approvedTask])
    taskUpdate.set = vi.fn(() => taskUpdate)
    const gateUpdate = chain([{ id: 'gate-1' }])
    gateUpdate.set = vi.fn(() => gateUpdate)
    mockDbSelect
      .mockReturnValueOnce(chain([awaitingTask]))
      .mockReturnValueOnce(chain([{ id: 'project-1', mcpConfig: {} }]))
      .mockReturnValueOnce(chain([{ id: 'project-1', mcpConfig: {} }]))
      .mockReturnValueOnce(chain([awaitingTask]))
      .mockReturnValueOnce(chain([]))
    mockDbUpdate
      .mockReturnValueOnce(taskUpdate)
      .mockReturnValueOnce(gateUpdate)
    mockRedisLpush.mockResolvedValue(1)
    mockRedisPublish.mockRejectedValueOnce(new Error('subscriber unavailable'))

    const { POST } = await import('@/app/api/tasks/[id]/approve/route')
    const res = await POST(authRequest('/api/tasks/task-approval/approve', { method: 'POST' }) as never, {
      params: Promise.resolve({ id: 'task-approval' }),
    })

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({
      task: expect.objectContaining({ id: 'task-approval', status: 'approved' }),
    })
    expect(mockRedisLpush).toHaveBeenCalledWith(
      'forge:approvals',
      JSON.stringify({ taskId: 'task-approval', action: 'approve' }),
    )
  })
})

// ---------------------------------------------------------------------------
// Suite 3.4z — Retry handoff: POST /api/tasks/:id/retry-handoff
// ---------------------------------------------------------------------------

describe('POST /api/tasks/:id/retry-handoff', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('returns 409 when the task is not approved', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    mockDbSelect.mockReturnValueOnce(chain([{ status: 'awaiting_approval' }]))

    const { POST } = await import('@/app/api/tasks/[id]/retry-handoff/route')
    const res = await POST(authRequest('/api/tasks/task-1/retry-handoff', { method: 'POST' }) as never, {
      params: Promise.resolve({ id: 'task-1' }),
    })

    expect(res.status).toBe(409)
    expect(mockRedisLpush).not.toHaveBeenCalled()
  })

  it('re-enqueues approval continuation for a running task', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    mockDbSelect.mockReturnValueOnce(chain([{ status: 'running' }]))
    mockRedisSet.mockResolvedValue('OK')
    mockRedisLpush.mockResolvedValue(1)

    const { POST } = await import('@/app/api/tasks/[id]/retry-handoff/route')
    const res = await POST(authRequest('/api/tasks/task-1/retry-handoff', { method: 'POST' }) as never, {
      params: Promise.resolve({ id: 'task-1' }),
    })

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({ result: { status: 'retry_enqueued' } })
    expect(mockRedisLpush).toHaveBeenCalledWith(
      'forge:approvals',
      JSON.stringify({ taskId: 'task-1', action: 'approve' }),
    )
  })

  it('re-enqueues approval handoff for an approved task even when no package is blocked', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    mockDbSelect.mockReturnValueOnce(chain([{ status: 'approved' }]))
    mockRedisSet.mockResolvedValue('OK')
    mockRedisLpush.mockResolvedValue(1)

    const { POST } = await import('@/app/api/tasks/[id]/retry-handoff/route')
    const res = await POST(authRequest('/api/tasks/task-1/retry-handoff', { method: 'POST' }) as never, {
      params: Promise.resolve({ id: 'task-1' }),
    })

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({ result: { status: 'retry_enqueued' } })
    expect(mockRedisLpush).toHaveBeenCalledWith(
      'forge:approvals',
      JSON.stringify({ taskId: 'task-1', action: 'approve' }),
    )
  })

  it('sets a retry dedupe marker before re-enqueuing approved handoff', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    mockDbSelect.mockReturnValueOnce(chain([{ status: 'approved' }]))
    mockRedisSet.mockResolvedValue('OK')
    mockRedisLpush.mockResolvedValue(1)

    const { POST } = await import('@/app/api/tasks/[id]/retry-handoff/route')
    const res = await POST(authRequest('/api/tasks/task-1/retry-handoff', { method: 'POST' }) as never, {
      params: Promise.resolve({ id: 'task-1' }),
    })

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({ result: { status: 'retry_enqueued' } })
    expect(mockRedisSet).toHaveBeenCalledWith(
      'forge:blocked-handoff-retry:task-1',
      expect.stringContaining('"source":"operator"'),
      'EX',
      60,
      'NX',
    )
    expect(mockRedisLpush).toHaveBeenCalledWith(
      'forge:approvals',
      JSON.stringify({ taskId: 'task-1', action: 'approve' }),
    )
  })

  it('does not enqueue duplicate approval jobs while a retry is already queued', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    mockDbSelect.mockReturnValueOnce(chain([{ status: 'approved' }]))
    mockRedisSet.mockResolvedValue(null)

    const { POST } = await import('@/app/api/tasks/[id]/retry-handoff/route')
    const res = await POST(authRequest('/api/tasks/task-1/retry-handoff', { method: 'POST' }) as never, {
      params: Promise.resolve({ id: 'task-1' }),
    })

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({ result: { status: 'retry_already_queued' } })
    expect(mockRedisLpush).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Suite 3.4a — Review gate decisions: POST /api/tasks/:id/approval-gates/:gateId
// ---------------------------------------------------------------------------

describe('POST /api/tasks/:id/approval-gates/:gateId', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('records a review gate decision through the review gate helper', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    mockDecideReviewGate.mockResolvedValue({
      status: 'decided',
      gateId: 'gate-1',
      gateType: 'qa_review',
      decision: 'completed',
      packageStatus: 'awaiting_review',
      taskCompleted: false,
      cancelledGateIds: [],
    })

    const { POST } = await import('@/app/api/tasks/[id]/approval-gates/[gateId]/route')
    const res = await POST(authRequest('/api/tasks/task-1/approval-gates/gate-1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        decision: 'completed',
        reason: 'QA passed.',
        sourceArtifactId: '11111111-1111-1111-1111-111111111111',
      }),
    }) as never, {
      params: Promise.resolve({ id: 'task-1', gateId: 'gate-1' }),
    })

    expect(res.status).toBe(200)
    expect(mockDecideReviewGate).toHaveBeenCalledWith({
      decision: 'completed',
      gateId: 'gate-1',
      reason: 'QA passed.',
      securityReview: undefined,
      sourceArtifactId: '11111111-1111-1111-1111-111111111111',
      taskId: 'task-1',
      userId: FAKE_SESSION.userId,
    })
    expect(mockRedisLpush).toHaveBeenCalledWith(
      'forge:approvals',
      JSON.stringify({ taskId: 'task-1', action: 'approve' }),
    )
    expect(mockProgressWorkforce).not.toHaveBeenCalled()
  })

  it('keeps the committed gate decision when worker continuation enqueue fails', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    mockDecideReviewGate.mockResolvedValue({
      status: 'decided',
      gateId: 'gate-1',
      gateType: 'qa_review',
      decision: 'completed',
      packageStatus: 'completed',
      taskCompleted: false,
      cancelledGateIds: [],
    })
    mockRedisLpush.mockRejectedValueOnce(new Error('redis unavailable'))

    const { POST } = await import('@/app/api/tasks/[id]/approval-gates/[gateId]/route')
    const res = await POST(authRequest('/api/tasks/task-1/approval-gates/gate-1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        decision: 'completed',
        reason: 'QA passed.',
        sourceArtifactId: '11111111-1111-1111-1111-111111111111',
      }),
    }) as never, {
      params: Promise.resolve({ id: 'task-1', gateId: 'gate-1' }),
    })

    expect(res.status).toBe(202)
    await expect(res.json()).resolves.toMatchObject({
      error: expect.stringMatching(/continuation/i),
      result: { status: 'decided', gateId: 'gate-1' },
    })
    expect(mockDecideReviewGate).toHaveBeenCalled()
    expect(mockProgressWorkforce).not.toHaveBeenCalled()
  })

  it('maps review gate ordering blocks to 409', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    mockDecideReviewGate.mockResolvedValue({
      status: 'reviewer_blocked',
      message: 'QA review must be completed before reviewer approval.',
    })

    const { POST } = await import('@/app/api/tasks/[id]/approval-gates/[gateId]/route')
    const res = await POST(authRequest('/api/tasks/task-1/approval-gates/gate-reviewer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        decision: 'completed',
        reason: 'Reviewer approves.',
        sourceArtifactId: '11111111-1111-1111-1111-111111111111',
      }),
    }) as never, {
      params: Promise.resolve({ id: 'task-1', gateId: 'gate-reviewer' }),
    })

    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error).toMatch(/QA review/)
  })

  it('maps invalid security review payloads to 400', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    mockDecideReviewGate.mockResolvedValue({
      status: 'invalid_security_review_payload',
      message: 'Security review completion requires SecurityFindingV1 findings or an explicit structured no-findings payload.',
    })

    const { POST } = await import('@/app/api/tasks/[id]/approval-gates/[gateId]/route')
    const res = await POST(authRequest('/api/tasks/task-1/approval-gates/gate-security', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        decision: 'completed',
        reason: 'Security review passed.',
        sourceArtifactId: '11111111-1111-1111-1111-111111111111',
      }),
    }) as never, {
      params: Promise.resolve({ id: 'task-1', gateId: 'gate-security' }),
    })

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/SecurityFindingV1/)
  })

  it('forwards structured security review payloads to the review gate helper', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    mockDecideReviewGate.mockResolvedValue({
      status: 'decided',
      gateId: 'gate-security',
      gateType: 'security_review',
      decision: 'completed',
      packageStatus: 'completed',
      taskCompleted: true,
      cancelledGateIds: [],
    })
    const securityReview = {
      schemaVersion: 1,
      findings: [],
      noFindings: {
        reviewSurface: 'Sandbox execution',
        evidenceRefs: ['artifact-1'],
        verificationState: 'Reviewed sandbox metadata; no host repository writes found.',
      },
    }

    const { POST } = await import('@/app/api/tasks/[id]/approval-gates/[gateId]/route')
    const res = await POST(authRequest('/api/tasks/task-1/approval-gates/gate-security', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        decision: 'completed',
        reason: 'Security review passed.',
        securityReview,
        sourceArtifactId: '11111111-1111-1111-1111-111111111111',
      }),
    }) as never, {
      params: Promise.resolve({ id: 'task-1', gateId: 'gate-security' }),
    })

    expect(res.status).toBe(200)
    expect(mockDecideReviewGate).toHaveBeenCalledWith(expect.objectContaining({
      gateId: 'gate-security',
      securityReview,
    }))
  })

  it('requires a decision reason', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)

    const { POST } = await import('@/app/api/tasks/[id]/approval-gates/[gateId]/route')
    const res = await POST(authRequest('/api/tasks/task-1/approval-gates/gate-1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'completed', reason: '' }),
    }) as never, {
      params: Promise.resolve({ id: 'task-1', gateId: 'gate-1' }),
    })

    expect(res.status).toBe(400)
    expect(mockDecideReviewGate).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Suite 3.4b — Change plan: POST /api/tasks/:id/replan
// ---------------------------------------------------------------------------

describe('POST /api/tasks/:id/replan', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('returns 409 when task is not awaiting approval', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    mockDbSelect.mockReturnValue(chain([{ id: 'task-9', status: 'pending', prompt: 'do x' }]))

    const { POST } = await import('@/app/api/tasks/[id]/replan/route')
    const req = authRequest('/api/tasks/task-9/replan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ feedback: 'tweak it' }),
    })
    const res = await POST(req as never, { params: Promise.resolve({ id: 'task-9' }) })

    expect(res.status).toBe(409)
    expect(mockDbUpdate).not.toHaveBeenCalled()
  })

  it('returns 400 when feedback is missing', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    mockDbSelect.mockReturnValue(chain([{ id: 'task-9', status: 'awaiting_approval', prompt: 'do x' }]))

    const { POST } = await import('@/app/api/tasks/[id]/replan/route')
    const req = authRequest('/api/tasks/task-9/replan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    const res = await POST(req as never, { params: Promise.resolve({ id: 'task-9' }) })

    expect(res.status).toBe(400)
    expect(mockDbUpdate).not.toHaveBeenCalled()
  })

  it('re-queues the task and appends feedback to the prompt on success', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    mockDbSelect.mockReturnValue(chain([{ id: 'task-9', status: 'awaiting_approval', prompt: 'do x' }]))
    mockDbUpdate.mockReturnValue(chain([{ id: 'task-9', status: 'pending', updatedAt: new Date() }]))

    const { POST } = await import('@/app/api/tasks/[id]/replan/route')
    const req = authRequest('/api/tasks/task-9/replan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ feedback: 'use a queue instead' }),
    })
    const res = await POST(req as never, { params: Promise.resolve({ id: 'task-9' }) })

    expect(res.status).toBe(200)
    expect(mockDbUpdate).toHaveBeenCalled()
    expect(mockRedisLpush).toHaveBeenCalledWith('forge:tasks', expect.stringContaining('task-9'))
  })
})

// ---------------------------------------------------------------------------
// Suite 3.4c — Local discovery: POST /api/providers/discover-local auth guard
// ---------------------------------------------------------------------------

describe('POST /api/providers/discover-local — auth guard', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('returns 401 when not authenticated', async () => {
    mockGetSession.mockResolvedValue(null)

    const { POST } = await import('@/app/api/providers/discover-local/route')
    const res = await POST(authRequest('/api/providers/discover-local', { method: 'POST' }) as never)

    expect(res.status).toBe(401)
  })

  it('reports LM Studio models discovered from the local native endpoint without configuring them', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    mockDbSelect.mockReturnValue(chain([]))
    mockDbInsert.mockReturnValue(chain(undefined))
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === 'http://localhost:11434/api/tags') {
        return new Response(JSON.stringify({ models: [] }), { status: 200 })
      }
      if (url === 'http://localhost:1234/api/v1/models') {
        return new Response(JSON.stringify({
          models: [
            { type: 'llm', key: 'gemma-local' },
            { type: 'embedding', key: 'nomic-embed' },
          ],
        }), { status: 200 })
      }
      return new Response('{}', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)

    try {
      const { POST } = await import('@/app/api/providers/discover-local/route')
      const res = await POST(authRequest('/api/providers/discover-local', { method: 'POST' }) as never)

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body).toMatchObject({
        added: [],
        ollamaReachable: false,
        lmstudioReachable: true,
      })
      expect(body.found).toBeGreaterThanOrEqual(1)
      expect(body.capabilityGroups).toEqual(expect.arrayContaining([
        expect.objectContaining({
          id: 'local-chat-models',
          candidates: expect.arrayContaining([
            expect.objectContaining({
              modelId: 'gemma-local',
              providerType: 'lmstudio',
              status: 'available',
              canConfigure: true,
            }),
          ]),
        }),
      ]))
      expect(body.auxiliaryCapabilityGroups).toEqual([
        expect.objectContaining({
          id: 'auxiliary-local',
          candidates: [
            expect.objectContaining({
              modelId: 'nomic-embed',
              providerType: 'lmstudio',
              status: 'reachable',
            }),
          ],
        }),
      ])
      expect(mockDbInsert).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('rejects malformed auto-configure candidates instead of configuring everything', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)

    const { POST } = await import('@/app/api/providers/discover-local/route')
    const res = await POST(authRequest('/api/providers/discover-local', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        autoConfigure: true,
        candidates: [{ providerType: 'lmstudio' }],
      }),
    }) as never)

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/providerType and modelId/i)
    expect(mockDbInsert).not.toHaveBeenCalled()
    expect(mockDbUpdate).not.toHaveBeenCalled()
  })

  it('rejects mixed valid and malformed auto-configure candidates', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)

    const { POST } = await import('@/app/api/providers/discover-local/route')
    const res = await POST(authRequest('/api/providers/discover-local', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        autoConfigure: true,
        candidates: [
          { providerType: 'lmstudio', modelId: 'gemma-local' },
          { providerType: 'ollama' },
        ],
      }),
    }) as never)

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/providerType and modelId/i)
    expect(mockDbInsert).not.toHaveBeenCalled()
    expect(mockDbUpdate).not.toHaveBeenCalled()
  })

  it('auto-configures a selected LM Studio model discovered from the local native endpoint', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    mockDbSelect.mockReturnValue(chain([]))
    mockDbInsert.mockReturnValue(chain(undefined))
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === 'http://localhost:11434/api/tags') {
        return new Response(JSON.stringify({ models: [] }), { status: 200 })
      }
      if (url === 'http://localhost:1234/api/v1/models') {
        return new Response(JSON.stringify({
          models: [{ type: 'llm', key: 'gemma-local', loaded_instances: [{ model: 'gemma-local' }] }],
        }), { status: 200 })
      }
      return new Response('{}', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)

    try {
      const { POST } = await import('@/app/api/providers/discover-local/route')
      const res = await POST(authRequest('/api/providers/discover-local', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          autoConfigure: true,
          candidates: [{ providerType: 'lmstudio', modelId: 'gemma-local' }],
        }),
      }) as never)

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body).toMatchObject({
        added: [{ providerType: 'lmstudio', modelId: 'gemma-local' }],
      })
      expect(mockDbInsert).toHaveBeenCalledOnce()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('keeps existing unselected providers marked configured after selected auto-configure', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    let selectCalls = 0
    mockDbSelect.mockImplementation(() => {
      selectCalls += 1
      return chain(selectCalls === 2
        ? [{
            id: 'provider-qwen',
            displayName: 'Qwen',
            baseUrl: 'http://localhost:1234/v1',
            isLocal: true,
            isActive: true,
          }]
        : [])
    })
    mockDbInsert.mockReturnValue(chain(undefined))
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === 'http://localhost:11434/api/tags') {
        return new Response(JSON.stringify({ models: [] }), { status: 200 })
      }
      if (url === 'http://localhost:1234/api/v1/models') {
        return new Response(JSON.stringify({
          models: [
            { type: 'llm', key: 'gemma-local', loaded_instances: [{ model: 'gemma-local' }] },
            { type: 'llm', key: 'qwen-local', loaded_instances: [{ model: 'qwen-local' }] },
          ],
        }), { status: 200 })
      }
      return new Response('{}', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)

    try {
      const { POST } = await import('@/app/api/providers/discover-local/route')
      const res = await POST(authRequest('/api/providers/discover-local', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          autoConfigure: true,
          candidates: [{ providerType: 'lmstudio', modelId: 'gemma-local' }],
        }),
      }) as never)

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body).toMatchObject({
        added: [{ providerType: 'lmstudio', modelId: 'gemma-local' }],
        configured: [{ providerType: 'lmstudio', modelId: 'qwen-local' }],
      })
      expect(body.capabilityGroups[0].candidates).toEqual(expect.arrayContaining([
        expect.objectContaining({
          modelId: 'qwen-local',
          providerType: 'lmstudio',
          status: 'configured',
          canConfigure: false,
        }),
      ]))
      expect(mockDbInsert).toHaveBeenCalledOnce()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('does not reactivate a disabled provider discovered by model id', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    let selectCalls = 0
    mockDbSelect.mockImplementation(() => {
      selectCalls += 1
      return chain(selectCalls === 1
        ? [{
            id: 'provider-existing',
            displayName: 'Old Gemma',
            baseUrl: 'http://localhost:1234/old',
            isLocal: true,
            isActive: false,
          }]
        : [])
    })
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === 'http://localhost:11434/api/tags') {
        return new Response(JSON.stringify({ models: [] }), { status: 200 })
      }
      if (url === 'http://localhost:1234/api/v1/models') {
        return new Response(JSON.stringify({
          models: [{ type: 'llm', key: 'google/gemma-local' }],
        }), { status: 200 })
      }
      return new Response('{}', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)

    try {
      const { POST } = await import('@/app/api/providers/discover-local/route')
      const res = await POST(authRequest('/api/providers/discover-local', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          autoConfigure: true,
          candidates: [{ providerType: 'lmstudio', modelId: 'google/gemma-local' }],
        }),
      }) as never)

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body).toMatchObject({
        added: [],
        updated: [],
        skipped: [{
          providerType: 'lmstudio',
          modelId: 'google/gemma-local',
          reason: 'provider_disabled',
        }],
      })
      expect(mockDbUpdate).not.toHaveBeenCalled()
      expect(mockDbInsert).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('normalizes the base URL for an active local LM Studio provider discovered by model id', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    let selectCalls = 0
    mockDbSelect.mockImplementation(() => {
      selectCalls += 1
      return chain(selectCalls === 1
        ? [{
            id: 'provider-existing',
            displayName: 'Old Gemma',
            baseUrl: 'http://localhost:1234',
            isLocal: true,
            isActive: true,
          }]
        : [])
    })
    mockDbUpdate.mockReturnValue(chain(undefined))
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === 'http://localhost:11434/api/tags') {
        return new Response(JSON.stringify({ models: [] }), { status: 200 })
      }
      if (url === 'http://localhost:1234/api/v1/models') {
        return new Response(JSON.stringify({
          models: [{ type: 'llm', key: 'google/gemma-local' }],
        }), { status: 200 })
      }
      return new Response('{}', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)

    try {
      const { POST } = await import('@/app/api/providers/discover-local/route')
      const res = await POST(authRequest('/api/providers/discover-local', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          autoConfigure: true,
          candidates: [{ providerType: 'lmstudio', modelId: 'google/gemma-local' }],
        }),
      }) as never)

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body).toMatchObject({
        added: [],
        updated: [{ providerType: 'lmstudio', modelId: 'google/gemma-local' }],
        skipped: [],
      })
      expect(mockDbUpdate).toHaveBeenCalledOnce()
      expect(mockDbInsert).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('does not overwrite an active local provider using a different base URL', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    let selectCalls = 0
    mockDbSelect.mockImplementation(() => {
      selectCalls += 1
      return chain(selectCalls === 1
        ? [{
            id: 'provider-existing',
            displayName: 'Remote Gemma',
            baseUrl: 'http://localhost:4321/v1',
            isLocal: true,
            isActive: true,
          }]
        : [])
    })
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === 'http://localhost:11434/api/tags') {
        return new Response(JSON.stringify({ models: [] }), { status: 200 })
      }
      if (url === 'http://localhost:1234/api/v1/models') {
        return new Response(JSON.stringify({
          models: [{ type: 'llm', key: 'google/gemma-local' }],
        }), { status: 200 })
      }
      return new Response('{}', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)

    try {
      const { POST } = await import('@/app/api/providers/discover-local/route')
      const res = await POST(authRequest('/api/providers/discover-local', { method: 'POST' }) as never)

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body).toMatchObject({
        added: [],
        updated: [],
        skipped: [{
          providerType: 'lmstudio',
          modelId: 'google/gemma-local',
          reason: 'base_url_conflict',
        }],
      })
      expect(mockDbUpdate).not.toHaveBeenCalled()
      expect(mockDbInsert).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('POST /api/providers/list-models — endpoint boundary', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('rejects custom base URLs for fixed cloud providers before making a fetch', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    try {
      const { POST } = await import('@/app/api/providers/list-models/route')
      const res = await POST(authRequest('/api/providers/list-models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          providerType: 'openrouter',
          apiKey: 'placeholder-key',
          baseUrl: 'https://attacker.example/v1',
        }),
      }) as never)

      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toMatch(/fixed endpoint|custom baseUrl/i)
      expect(fetchMock).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('lists fixed cloud models from the catalog endpoint when no custom base URL is supplied', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('https://openrouter.ai/api/v1/models')
      expect(init).toMatchObject({
        headers: { Authorization: 'Bearer placeholder-key' },
      })
      return new Response(JSON.stringify({ data: [{ id: 'openai/gpt-4.1' }] }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)

    try {
      const { POST } = await import('@/app/api/providers/list-models/route')
      const res = await POST(authRequest('/api/providers/list-models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          providerType: 'openrouter',
          apiKey: 'placeholder-key',
        }),
      }) as never)

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.models).toEqual(['openai/gpt-4.1'])
      expect(fetchMock).toHaveBeenCalledOnce()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('accepts a fixed cloud provider default base URL but still fetches the catalog endpoint', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('https://openrouter.ai/api/v1/models')
      expect(init).toMatchObject({
        headers: { Authorization: 'Bearer placeholder-key' },
      })
      return new Response(JSON.stringify({ data: [{ id: 'anthropic/claude-4-opus' }] }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)

    try {
      const { POST } = await import('@/app/api/providers/list-models/route')
      const res = await POST(authRequest('/api/providers/list-models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          providerType: 'openrouter',
          apiKey: 'placeholder-key',
          baseUrl: 'https://openrouter.ai/api/v1/',
        }),
      }) as never)

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.models).toEqual(['anthropic/claude-4-opus'])
      expect(fetchMock).toHaveBeenCalledOnce()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('lists LM Studio models from the native /api/v1/models endpoint', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('http://localhost:1234/api/v1/models')
      expect(init?.headers).toEqual({})
      return new Response(JSON.stringify({
        models: [
          { type: 'llm', key: 'google/gemma-local' },
          { type: 'embedding', key: 'nomic-embed' },
        ],
      }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)

    try {
      const { POST } = await import('@/app/api/providers/list-models/route')
      const res = await POST(authRequest('/api/providers/list-models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          providerType: 'lmstudio',
          baseUrl: 'http://localhost:1234',
        }),
      }) as never)

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.models).toEqual(['google/gemma-local'])
      expect(fetchMock).toHaveBeenCalledOnce()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('falls back to LM Studio OpenAI-compatible model listing when native listing is unavailable', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === 'http://localhost:1234/api/v1/models') {
        return new Response('{}', { status: 404 })
      }
      if (url === 'http://localhost:1234/v1/models') {
        return new Response(JSON.stringify({ data: [{ id: 'fallback-local' }] }), { status: 200 })
      }
      return new Response('{}', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)

    try {
      const { POST } = await import('@/app/api/providers/list-models/route')
      const res = await POST(authRequest('/api/providers/list-models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          providerType: 'lmstudio',
          baseUrl: 'http://localhost:1234',
        }),
      }) as never)

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.models).toEqual(['fallback-local'])
      expect(fetchMock).toHaveBeenNthCalledWith(
        1,
        'http://localhost:1234/api/v1/models',
        expect.any(Object),
      )
      expect(fetchMock).toHaveBeenNthCalledWith(
        2,
        'http://localhost:1234/v1/models',
        expect.any(Object),
      )
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

// ---------------------------------------------------------------------------
// Suite 3.4d — Filesystem MCP grant approvals
// ---------------------------------------------------------------------------

describe('PUT /api/tasks/:id/filesystem-grants — explicit grant approvals', () => {
  const FS_GRANT_APPROVAL_ID = '00000000-0000-4000-8000-000000000111'
  const FS_GRANT_DENIED_ID = '00000000-0000-4000-8000-000000000112'
  const FS_GRANT_PACKAGE_ID = '00000000-0000-4000-8000-000000000211'

  beforeEach(() => {
    vi.clearAllMocks()
    mockDbSelect.mockReset()
    mockDbInsert.mockReset()
    mockDbUpdate.mockReset()
    mockDbDelete.mockReset()
    mockDbTransaction.mockImplementation(async (callback: (tx: unknown) => unknown) =>
      callback({
        select: mockDbSelect,
        insert: mockDbInsert,
        update: mockDbUpdate,
        delete: mockDbDelete,
      }),
    )
  })

  async function withFilesystemProject<T>(
    callback: (project: Record<string, unknown>, filesystemPath: string) => Promise<T>,
  ): Promise<T> {
    const previousRoot = process.env.FORGE_WORKSPACE_ROOT
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-fs-grant-test-'))
    const localPath = path.join(workspaceRoot, 'projects', 'demo')
    const filesystemPath = path.join(workspaceRoot, 'mcps', 'filesystem')
    process.env.FORGE_WORKSPACE_ROOT = workspaceRoot
    await fs.mkdir(localPath, { recursive: true })
    await fs.mkdir(filesystemPath, { recursive: true })
    await fs.writeFile(
      path.join(filesystemPath, 'forge.mcp.json'),
      `${JSON.stringify({
        schemaVersion: 1,
        id: 'filesystem',
        displayName: 'Filesystem',
        source: 'forge-catalog',
        createdAt: new Date().toISOString(),
      })}\n`,
    )
    const project = {
      id: 'project-fs-grant',
      name: 'Filesystem grants',
      githubRepo: null,
      localPath,
      githubTokenEnvVar: null,
      pmProviderConfigId: null,
      mcpConfig: {
        profile: 'custom',
        requiredMcps: ['filesystem'],
        overrides: {},
      },
      grantDecisionRevision: BigInt(0),
      rootBindingRevision: BigInt(1),
      defaultBranch: 'main',
      createdAt: new Date(),
      updatedAt: new Date(),
      archivedAt: null,
    }

    try {
      return await callback(project, filesystemPath)
    } finally {
      if (previousRoot === undefined) {
        delete process.env.FORGE_WORKSPACE_ROOT
      } else {
        process.env.FORGE_WORKSPACE_ROOT = previousRoot
      }
      await fs.rm(workspaceRoot, { recursive: true, force: true })
    }
  }

  function grantTask(
    projectId = 'project-fs-grant',
    status = 'awaiting_approval',
    submittedBy: string | null = 'user-abc',
  ) {
    return {
      id: 'task-fs-grant',
      projectId,
      status,
      submittedBy,
      updatedAt: new Date('2026-07-03T00:00:00.000Z'),
    }
  }

  function grantPackage(metadata: Record<string, unknown> = {}) {
    return {
      id: FS_GRANT_PACKAGE_ID,
      taskId: 'task-fs-grant',
      assignedRole: 'backend',
      title: 'Read project files',
      status: 'pending',
      mcpRequirements: [{
        mcpId: 'filesystem',
        requirement: 'required',
        capabilities: ['filesystem.project.read', 'filesystem.project.search'],
      }],
      metadata,
      createdAt: new Date(),
      updatedAt: new Date(),
    }
  }

  function mockTaskGrantTransactionLocks(input: {
    packages: Array<Record<string, unknown>>
    project: Record<string, unknown>
    task: Record<string, unknown>
  }) {
    const lockedProject = {
      grantDecisionRevision: BigInt(0),
      rootBindingRevision: BigInt(1),
      mcpConfig: {},
      ...input.project,
    }
    const pointerRows = input.packages.slice(0, 1).map((pkg, index) => ({
      id: `00000000-0000-4000-8000-${String(700 + index).padStart(12, '0')}`,
      taskId: pkg.taskId,
      workPackageId: pkg.id,
      currentDecisionId: null,
      currentDecisionRevision: null,
      pointerFingerprint: `sha256:${'0'.repeat(64)}`,
      pointerVersion: BigInt(0),
      createdAt: new Date(),
      updatedAt: new Date(),
    }))
    const projectPointer = {
      projectId: String((lockedProject as Record<string, unknown>).id),
      currentDecisionId: null,
      currentDecisionProjectId: null,
      currentDecisionRevision: null,
      currentRootBindingRevision: null,
      currentDecisionFingerprint: null,
      currentDecisionGeneration: null,
      pointerGeneration: BigInt(0),
      createdAt: new Date(),
      updatedAt: new Date(),
    }
    const transactionSelect = vi.fn()
      .mockReturnValueOnce(chain([lockedProject]))
      .mockReturnValueOnce(chain([input.task]))
      .mockReturnValueOnce(chain(input.packages))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([projectPointer]))
      .mockReturnValueOnce(chain(pointerRows))
      .mockImplementation(() => mockDbSelect())
    const projectUpdate = chain([])
    let projectValues: Record<string, unknown> = {}
    projectUpdate.set = vi.fn((values: Record<string, unknown>) => {
      projectValues = values
      return projectUpdate
    })
    projectUpdate.returning = vi.fn(() => chain([{ ...lockedProject, ...projectValues }]))
    const dynamicUpdate = (row: Record<string, unknown>) => {
      const update = chain([])
      let values: Record<string, unknown> = {}
      update.set = vi.fn((next: Record<string, unknown>) => {
        values = next
        return update
      })
      update.returning = vi.fn(() => chain([{ ...row, ...values }]))
      return update
    }
    const transactionUpdate = vi.fn((table: Parameters<typeof getTableName>[0]) => {
      const tableName = getTableName(table)
      if (tableName === 'projects') return projectUpdate
      if (tableName === 'project_filesystem_current_decision_pointers') return dynamicUpdate(projectPointer)
      const configured = mockDbUpdate(table)
      if (configured) return configured
      if (tableName === 'work_packages') return dynamicUpdate(input.packages[0] ?? {})
      if (tableName === 'tasks') return dynamicUpdate(input.task)
      return dynamicUpdate({})
    })
    const transactionInsert = vi.fn((table: Parameters<typeof getTableName>[0]) => {
      if (getTableName(table) !== 'project_filesystem_grant_decisions') return mockDbInsert(table)
      const insert = chain([])
      let values: Record<string, unknown> = {}
      insert.values = vi.fn((next: Record<string, unknown>) => {
        values = next
        return insert
      })
      insert.returning = vi.fn(() => chain([values]))
      return insert
    })
    mockDbSelect.mockImplementation(() => chain([]))
    mockDbTransaction.mockImplementation(async (callback: (tx: unknown) => unknown) =>
      callback({
        select: transactionSelect,
        insert: transactionInsert,
        update: transactionUpdate,
        delete: mockDbDelete,
      }),
    )
    return { projectUpdate }
  }

  it('approves edited read-only filesystem grants and persists an effective phase', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    mockDbInsert.mockReturnValue(chain([{
      id: FS_GRANT_APPROVAL_ID,
      taskId: 'task-fs-grant',
      workPackageId: FS_GRANT_PACKAGE_ID,
      decision: 'approved',
      capabilities: ['filesystem.project.read'],
      reason: 'Need package context',
      updatedAt: new Date('2026-07-03T00:01:00.000Z'),
    }]))

    await withFilesystemProject(async (project, filesystemPath) => {
      const pkg = {
        ...grantPackage({ mcpGrants: [{ mcpId: 'filesystem', capabilities: ['filesystem.project.read', 'filesystem.project.search'] }] }),
        mcpRequirements: [{
          mcpId: 'filesystem',
          requirement: 'optional',
          capabilities: ['filesystem.project.read', 'filesystem.project.search'],
          fallback: { action: 'continue_without_mcp' },
        }],
      }
      const approvalUpdate = chain([{
        id: FS_GRANT_APPROVAL_ID,
        taskId: 'task-fs-grant',
        workPackageId: FS_GRANT_PACKAGE_ID,
        decision: 'approved',
        capabilities: ['filesystem.project.read'],
        reason: 'Need package context',
        updatedAt: new Date('2026-07-03T00:01:00.000Z'),
      }])
      approvalUpdate.set = vi.fn(() => approvalUpdate)
      const packageUpdate = chain([pkg])
      packageUpdate.set = vi.fn(() => packageUpdate)
      mockDbSelect
        .mockReturnValueOnce(chain([grantTask(project.id as string)]))
        .mockReturnValueOnce(chain([project]))
        .mockReturnValueOnce(chain([{ mcpId: 'filesystem', installPath: filesystemPath, enabled: true }]))
        .mockReturnValueOnce(chain([]))
        .mockReturnValueOnce(chain([pkg]))
        .mockReturnValue(chain([pkg]))
      mockTaskGrantTransactionLocks({
        packages: [pkg],
        project,
        task: grantTask(project.id as string),
      })
      mockDbUpdate
        .mockReturnValueOnce(approvalUpdate)
        .mockReturnValueOnce(packageUpdate)

      const { PUT } = await import('@/app/api/tasks/[id]/filesystem-grants/route')
      const res = await PUT(authRequest('/api/tasks/task-fs-grant/filesystem-grants', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          schemaVersion: 1,
          grants: [{
            workPackageId: FS_GRANT_PACKAGE_ID,
            decision: 'approved',
            capabilities: ['filesystem.project.read'],
            grantMode: 'allow_once',
            reason: 'Need package context',
          }],
        }),
      }) as never, {
        params: Promise.resolve({ id: 'task-fs-grant' }),
      })

      expect(res.status).toBe(200)
      const packageSetMock = packageUpdate.set as unknown as { mock: { calls: Array<[{ metadata?: { queryChunks?: unknown[] } }]> } }
      const phaseSql = flattenSqlChunks(packageSetMock.mock.calls[0][0].metadata)
      expect(phaseSql).toContain('"source":"explicit-grant-approval"')
      expect(phaseSql).toContain('"grantMode":"allow_once"')
      expect(phaseSql).toContain('"capabilities":["filesystem.project.read"]')
    })
  })

  it('blocks an always-allow project grant before any database write when project ingress is closed', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    mockDbSelect.mockReturnValueOnce(chain([grantTask()]))
    mockGuardEpic172ProjectManagementIngress.mockResolvedValueOnce(Response.json(
      {
        code: 'epic_172_project_management_ingress_closed',
        error: 'Project management is temporarily disabled while release safety checks are incomplete.',
        reason: 'disabled',
      },
      { status: 503 },
    ))

    const { PUT } = await import('@/app/api/tasks/[id]/filesystem-grants/route')
    const res = await PUT(authRequest('/api/tasks/task-fs-grant/filesystem-grants', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        schemaVersion: 1,
        grants: [{
          workPackageId: FS_GRANT_PACKAGE_ID,
          decision: 'approved',
          capabilities: ['filesystem.project.read'],
          grantMode: 'always_allow',
        }],
      }),
    }) as never, {
      params: Promise.resolve({ id: 'task-fs-grant' }),
    })

    expect(res.status).toBe(503)
    expect(mockGuardEpic172ProjectManagementIngress).toHaveBeenCalledOnce()
    expect(mockDbSelect).not.toHaveBeenCalled()
    expect(mockDbTransaction).not.toHaveBeenCalled()
    expect(mockDbInsert).not.toHaveBeenCalled()
    expect(mockDbUpdate).not.toHaveBeenCalled()
  })

  it('persists always-allow filesystem grants on the project MCP config', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    mockDbInsert.mockReturnValue(chain([{
      id: FS_GRANT_APPROVAL_ID,
      taskId: 'task-fs-grant',
      workPackageId: FS_GRANT_PACKAGE_ID,
      decision: 'approved',
      capabilities: ['filesystem.project.read', 'filesystem.project.search'],
      reason: 'Trusted project',
      updatedAt: new Date('2026-07-03T00:01:00.000Z'),
    }]))

    await withFilesystemProject(async (project, filesystemPath) => {
      const pkg = grantPackage()
      const approvalUpdate = chain([{
        id: FS_GRANT_APPROVAL_ID,
        taskId: 'task-fs-grant',
        workPackageId: FS_GRANT_PACKAGE_ID,
        decision: 'approved',
        capabilities: ['filesystem.project.read', 'filesystem.project.search'],
        reason: 'Trusted project',
        updatedAt: new Date('2026-07-03T00:01:00.000Z'),
      }])
      approvalUpdate.set = vi.fn(() => approvalUpdate)
      const packageUpdate = chain([pkg])
      packageUpdate.set = vi.fn(() => packageUpdate)
      mockDbSelect
        .mockReturnValueOnce(chain([grantTask(project.id as string)]))
        .mockReturnValueOnce(chain([project]))
        .mockReturnValueOnce(chain([{ mcpId: 'filesystem', installPath: filesystemPath, enabled: true }]))
        .mockReturnValueOnce(chain([]))
        .mockReturnValueOnce(chain([pkg]))
        .mockReturnValueOnce(chain([pkg]))
        .mockReturnValue(chain([pkg]))
      const { projectUpdate } = mockTaskGrantTransactionLocks({
        packages: [pkg],
        project,
        task: grantTask(project.id as string),
      })
      mockDbUpdate
        .mockReturnValueOnce(approvalUpdate)
        .mockReturnValueOnce(packageUpdate)

      const { PUT } = await import('@/app/api/tasks/[id]/filesystem-grants/route')
      const res = await PUT(authRequest('/api/tasks/task-fs-grant/filesystem-grants', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          schemaVersion: 1,
          grants: [{
            workPackageId: FS_GRANT_PACKAGE_ID,
            decision: 'approved',
            capabilities: ['filesystem.project.read', 'filesystem.project.search'],
            grantMode: 'always_allow',
            reason: 'Trusted project',
          }],
        }),
      }) as never, {
        params: Promise.resolve({ id: 'task-fs-grant' }),
      })

      expect(res.status).toBe(200)
      expect(projectUpdate.set).toHaveBeenCalledWith(expect.objectContaining({
        mcpConfig: expect.objectContaining({
          grants: expect.objectContaining({
            filesystem: expect.objectContaining({
              capabilities: ['filesystem.project.read', 'filesystem.project.search'],
              grantApprovalId: expect.any(String),
              grantMode: 'always_allow',
              status: 'approved',
            }),
          }),
        }),
      }))
    })
  })

  it('reconciles failed package grant blocks when enabling the project filesystem grant', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    mockDbInsert.mockReturnValue(chain([{
      id: FS_GRANT_APPROVAL_ID,
      decision: 'approved',
      capabilities: ['filesystem.project.read', 'filesystem.project.list', 'filesystem.project.search'],
    }]))

    await withFilesystemProject(async (project, filesystemPath) => {
      const failedPkg = {
        ...grantPackage({
          mcpGrantBlock: { source: 'filesystem-grant-approval', status: 'failed' },
        }),
        blockedReason: 'Missing filesystem grant.',
        status: 'failed',
      }
      const recoveredPkg = { ...failedPkg, blockedReason: null, status: 'ready' }
      const packageUpdate = chain([recoveredPkg])
      packageUpdate.set = vi.fn(() => packageUpdate)
      const taskUpdate = chain([{ ...grantTask(project.id as string, 'approved'), updatedAt: new Date('2026-07-03T00:02:00.000Z') }])
      taskUpdate.set = vi.fn(() => taskUpdate)

      mockDbSelect
        .mockReturnValueOnce(chain([project]))
        .mockReturnValueOnce(chain([{ mcpId: 'filesystem', installPath: filesystemPath, enabled: true }]))
        .mockReturnValueOnce(chain([]))
        .mockReturnValueOnce(chain([grantTask(project.id as string, 'failed')]))
        .mockReturnValueOnce(chain([failedPkg]))
        .mockReturnValueOnce(chain([]))
      mockTaskGrantTransactionLocks({
        packages: [failedPkg],
        project,
        task: grantTask(project.id as string, 'failed'),
      })
      mockDbUpdate
        .mockReturnValueOnce(packageUpdate)
        .mockReturnValueOnce(taskUpdate)

      const { PUT } = await import('@/app/api/projects/[id]/filesystem-grant/route')
      const res = await PUT(authRequest('/api/projects/project-fs-grant/filesystem-grant', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: true, reason: 'Trusted project' }),
      }) as never, {
        params: Promise.resolve({ id: project.id as string }),
      })

      expect(res.status).toBe(200)
      expect(packageUpdate.set).toHaveBeenCalledWith(expect.objectContaining({
        blockedReason: null,
        status: 'ready',
      }))
      const packageSetMock = packageUpdate.set as unknown as { mock: { calls: Array<[{ metadata?: unknown }]> } }
      expect(flattenSqlChunks(packageSetMock.mock.calls[0][0].metadata)).toContain('project-filesystem-approval')
      expect(flattenSqlChunks(packageSetMock.mock.calls[0][0].metadata)).toContain('mcpGrantBlock')
      expect(taskUpdate.set).toHaveBeenCalledWith(expect.objectContaining({
        errorMessage: null,
        status: 'approved',
      }))
      expect(mockRedisLpush).toHaveBeenCalledWith('forge:approvals', JSON.stringify({
        taskId: 'task-fs-grant',
        action: 'approve',
      }))
      expect(mockRedisPublish).not.toHaveBeenCalled()
    })
  })

  it('returns 202 when project grant recovery cannot enqueue the worker job', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    mockDbInsert.mockReturnValue(chain([{
      id: FS_GRANT_APPROVAL_ID,
      decision: 'approved',
      capabilities: ['filesystem.project.read', 'filesystem.project.list', 'filesystem.project.search'],
    }]))
    mockRedisLpush.mockRejectedValueOnce(new Error('redis offline'))

    await withFilesystemProject(async (project, filesystemPath) => {
      const failedPkg = {
        ...grantPackage({
          mcpGrantBlock: { source: 'filesystem-grant-approval', status: 'failed' },
        }),
        blockedReason: 'Missing filesystem grant.',
        status: 'failed',
      }
      const recoveredPkg = { ...failedPkg, blockedReason: null, status: 'ready' }
      const packageUpdate = chain([recoveredPkg])
      packageUpdate.set = vi.fn(() => packageUpdate)
      const taskUpdate = chain([{ ...grantTask(project.id as string, 'approved'), updatedAt: new Date('2026-07-03T00:02:00.000Z') }])
      taskUpdate.set = vi.fn(() => taskUpdate)

      mockDbSelect
        .mockReturnValueOnce(chain([project]))
        .mockReturnValueOnce(chain([{ mcpId: 'filesystem', installPath: filesystemPath, enabled: true }]))
        .mockReturnValueOnce(chain([]))
        .mockReturnValueOnce(chain([grantTask(project.id as string, 'failed')]))
        .mockReturnValueOnce(chain([failedPkg]))
        .mockReturnValueOnce(chain([]))
      mockTaskGrantTransactionLocks({
        packages: [failedPkg],
        project,
        task: grantTask(project.id as string, 'failed'),
      })
      mockDbUpdate
        .mockReturnValueOnce(packageUpdate)
        .mockReturnValueOnce(taskUpdate)

      const { PUT } = await import('@/app/api/projects/[id]/filesystem-grant/route')
      const res = await PUT(authRequest('/api/projects/project-fs-grant/filesystem-grant', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: true, reason: 'Trusted project' }),
      }) as never, {
        params: Promise.resolve({ id: project.id as string }),
      })

      expect(res.status).toBe(202)
      const body = await res.json()
      expect(body.error).toContain('wake-ups failed')
      expect(body.failedTaskIds).toEqual(['task-fs-grant'])
      expect(body.recoveredTaskIds).toEqual(['task-fs-grant'])
      expect(mockRedisPublish).not.toHaveBeenCalled()
    })
  })

  it('denies filesystem grants and records a blocking effective phase', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    mockDbInsert.mockReturnValue(chain([{
      id: FS_GRANT_DENIED_ID,
      taskId: 'task-fs-grant',
      workPackageId: FS_GRANT_PACKAGE_ID,
      decision: 'denied',
      capabilities: [],
      reason: 'Too broad',
      updatedAt: new Date('2026-07-03T00:01:00.000Z'),
    }]))
    const pkg = grantPackage()
    const approvalUpdate = chain([{
      id: FS_GRANT_DENIED_ID,
      taskId: 'task-fs-grant',
      workPackageId: FS_GRANT_PACKAGE_ID,
      decision: 'denied',
      capabilities: [],
      reason: 'Too broad',
      updatedAt: new Date('2026-07-03T00:01:00.000Z'),
    }])
    approvalUpdate.set = vi.fn(() => approvalUpdate)
    const packageUpdate = chain([pkg])
    packageUpdate.set = vi.fn(() => packageUpdate)
    mockDbSelect
      .mockReturnValueOnce(chain([grantTask()]))
      .mockReturnValueOnce(chain([{ id: 'project-fs-grant' }]))
      .mockReturnValueOnce(chain([pkg]))
    mockTaskGrantTransactionLocks({
      packages: [pkg],
      project: { id: 'project-fs-grant', mcpConfig: {} },
      task: grantTask(),
    })
    mockDbUpdate
      .mockReturnValueOnce(approvalUpdate)
      .mockReturnValueOnce(packageUpdate)

    const { PUT } = await import('@/app/api/tasks/[id]/filesystem-grants/route')
    const res = await PUT(authRequest('/api/tasks/task-fs-grant/filesystem-grants', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        schemaVersion: 1,
        grants: [{ workPackageId: FS_GRANT_PACKAGE_ID, decision: 'denied', capabilities: [], reason: 'Too broad' }],
      }),
    }) as never, {
      params: Promise.resolve({ id: 'task-fs-grant' }),
    })

    expect(res.status).toBe(200)
    const packageSetMock = packageUpdate.set as unknown as { mock: { calls: Array<[{ metadata?: { queryChunks?: unknown[] } }]> } }
    const phaseSql = flattenSqlChunks(packageSetMock.mock.calls[0][0].metadata)
    expect(phaseSql).toContain('"source":"explicit-grant-approval"')
    expect(phaseSql).toContain('"status":"denied"')
    expect(phaseSql).toContain('"deniedCapabilities":["filesystem.project.read","filesystem.project.search"]')
  })

  it('rejects filesystem write capability approvals', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    mockDbInsert.mockReturnValue(chain([]))
    mockDbSelect
      .mockReturnValueOnce(chain([grantTask()]))
      .mockReturnValueOnce(chain([{ id: 'project-fs-grant' }]))
      .mockReturnValueOnce(chain([grantPackage()]))
    mockTaskGrantTransactionLocks({
      packages: [grantPackage()],
      project: { id: 'project-fs-grant', mcpConfig: {} },
      task: grantTask(),
    })

    const { PUT } = await import('@/app/api/tasks/[id]/filesystem-grants/route')
    const res = await PUT(authRequest('/api/tasks/task-fs-grant/filesystem-grants', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        schemaVersion: 1,
        grants: [{ workPackageId: FS_GRANT_PACKAGE_ID, decision: 'approved', capabilities: ['filesystem.project.write'] }],
      }),
    }) as never, {
      params: Promise.resolve({ id: 'task-fs-grant' }),
    })

    expect(res.status).toBe(400)
    expect(mockDbUpdate).not.toHaveBeenCalled()
  })

  it('rejects malformed work package ids before querying package grants', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    mockDbSelect
      .mockReturnValueOnce(chain([grantTask()]))

    const { PUT } = await import('@/app/api/tasks/[id]/filesystem-grants/route')
    const res = await PUT(authRequest('/api/tasks/task-fs-grant/filesystem-grants', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        schemaVersion: 1,
        grants: [{ workPackageId: 'not-a-uuid', decision: 'approved', capabilities: ['filesystem.project.read'] }],
      }),
    }) as never, {
      params: Promise.resolve({ id: 'task-fs-grant' }),
    })

    expect(res.status).toBe(400)
    expect(mockDbUpdate).not.toHaveBeenCalled()
  })

  it('rejects approvals when a required filesystem capability is omitted', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    mockDbInsert.mockReturnValue(chain([]))
    await withFilesystemProject(async (project, filesystemPath) => {
      mockDbSelect
        .mockReturnValueOnce(chain([grantTask(project.id as string)]))
        .mockReturnValueOnce(chain([project]))
        .mockReturnValueOnce(chain([{ mcpId: 'filesystem', installPath: filesystemPath, enabled: true }]))
        .mockReturnValueOnce(chain([]))
        .mockReturnValueOnce(chain([grantPackage()]))
      mockTaskGrantTransactionLocks({
        packages: [grantPackage()],
        project,
        task: grantTask(project.id as string),
      })

      const { PUT } = await import('@/app/api/tasks/[id]/filesystem-grants/route')
      const res = await PUT(authRequest('/api/tasks/task-fs-grant/filesystem-grants', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          schemaVersion: 1,
          grants: [{ workPackageId: FS_GRANT_PACKAGE_ID, decision: 'approved', capabilities: ['filesystem.project.read'] }],
        }),
      }) as never, {
        params: Promise.resolve({ id: 'task-fs-grant' }),
      })

      expect(res.status).toBe(400)
      expect((await res.json()).error).toMatch(/required capabilities/i)
      expect(mockDbUpdate).not.toHaveBeenCalled()
    })
  })

  it('rejects approvals for packages that did not request filesystem context', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    mockDbInsert.mockReturnValue(chain([]))
    await withFilesystemProject(async (project, filesystemPath) => {
      mockDbSelect
        .mockReturnValueOnce(chain([grantTask(project.id as string)]))
        .mockReturnValueOnce(chain([project]))
        .mockReturnValueOnce(chain([{ mcpId: 'filesystem', installPath: filesystemPath, enabled: true }]))
        .mockReturnValueOnce(chain([]))
        .mockReturnValueOnce(chain([{ ...grantPackage(), mcpRequirements: [], metadata: {} }]))
      mockTaskGrantTransactionLocks({
        packages: [{ ...grantPackage(), mcpRequirements: [], metadata: {} }],
        project,
        task: grantTask(project.id as string),
      })

      const { PUT } = await import('@/app/api/tasks/[id]/filesystem-grants/route')
      const res = await PUT(authRequest('/api/tasks/task-fs-grant/filesystem-grants', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          schemaVersion: 1,
          grants: [{ workPackageId: FS_GRANT_PACKAGE_ID, decision: 'approved', capabilities: ['filesystem.project.read'] }],
        }),
      }) as never, {
        params: Promise.resolve({ id: 'task-fs-grant' }),
      })

      expect(res.status).toBe(400)
      expect((await res.json()).error).toMatch(/did not request filesystem/i)
      expect(mockDbUpdate).not.toHaveBeenCalled()
    })
  })

  it('returns 409 when the package becomes non-editable during grant persistence', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    mockDbInsert.mockReturnValue(chain([{
      id: FS_GRANT_APPROVAL_ID,
      taskId: 'task-fs-grant',
      workPackageId: FS_GRANT_PACKAGE_ID,
      decision: 'approved',
      capabilities: ['filesystem.project.read'],
      reason: '',
      updatedAt: new Date('2026-07-03T00:01:00.000Z'),
    }]))

    await withFilesystemProject(async (project, filesystemPath) => {
      const pkg = {
        ...grantPackage(),
        mcpRequirements: [{
          mcpId: 'filesystem',
          requirement: 'optional',
          capabilities: ['filesystem.project.read'],
          fallback: { action: 'continue_without_mcp' },
        }],
      }
      const approvalUpdate = chain([{
        id: FS_GRANT_APPROVAL_ID,
        taskId: 'task-fs-grant',
        workPackageId: FS_GRANT_PACKAGE_ID,
        decision: 'approved',
        capabilities: ['filesystem.project.read'],
        reason: '',
        updatedAt: new Date('2026-07-03T00:01:00.000Z'),
      }])
      approvalUpdate.set = vi.fn(() => approvalUpdate)
      const packageUpdate = chain([])
      packageUpdate.set = vi.fn(() => packageUpdate)
      mockDbSelect
        .mockReturnValueOnce(chain([grantTask(project.id as string)]))
        .mockReturnValueOnce(chain([project]))
        .mockReturnValueOnce(chain([{ mcpId: 'filesystem', installPath: filesystemPath, enabled: true }]))
        .mockReturnValueOnce(chain([]))
        .mockReturnValueOnce(chain([pkg]))
      mockTaskGrantTransactionLocks({
        packages: [pkg],
        project,
        task: grantTask(project.id as string),
      })
      mockDbUpdate
        .mockReturnValueOnce(approvalUpdate)
        .mockReturnValueOnce(packageUpdate)

      const { PUT } = await import('@/app/api/tasks/[id]/filesystem-grants/route')
      const res = await PUT(authRequest('/api/tasks/task-fs-grant/filesystem-grants', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          schemaVersion: 1,
          grants: [{ workPackageId: FS_GRANT_PACKAGE_ID, decision: 'approved', capabilities: ['filesystem.project.read'] }],
        }),
      }) as never, {
        params: Promise.resolve({ id: 'task-fs-grant' }),
      })

      expect(res.status).toBe(409)
      expect((await res.json()).error).toMatch(/no longer editable/i)
    })
  })

  it('allows failed filesystem grant packages to recover after a corrected approval', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    mockDbInsert.mockReturnValue(chain([{
      id: FS_GRANT_APPROVAL_ID,
      taskId: 'task-fs-grant',
      workPackageId: FS_GRANT_PACKAGE_ID,
      decision: 'approved',
      capabilities: ['filesystem.project.read', 'filesystem.project.search'],
      reason: 'Grant fixed',
      updatedAt: new Date('2026-07-03T00:01:00.000Z'),
    }]))

    await withFilesystemProject(async (project, filesystemPath) => {
      const failedPkg = {
        ...grantPackage({
          mcpGrantBlock: {
            blockedAt: '2026-07-03T00:00:30.000Z',
            missingCapabilities: ['filesystem.project.read', 'filesystem.project.search'],
            reason: 'Work package "Read project files" requires filesystem grant approval.',
            requestedCapabilities: ['filesystem.project.read', 'filesystem.project.search'],
            source: 'filesystem-grant-approval',
            status: 'failed',
          },
        }),
        status: 'failed',
        blockedReason: 'Work package "Read project files" requires filesystem grant approval.',
      }
      const recoveredPkg = { ...failedPkg, blockedReason: null, status: 'ready' }
      const approvalUpdate = chain([{
        id: FS_GRANT_APPROVAL_ID,
        taskId: 'task-fs-grant',
        workPackageId: FS_GRANT_PACKAGE_ID,
        decision: 'approved',
        capabilities: ['filesystem.project.read', 'filesystem.project.search'],
        reason: 'Grant fixed',
        updatedAt: new Date('2026-07-03T00:01:00.000Z'),
      }])
      approvalUpdate.set = vi.fn(() => approvalUpdate)
      const packageUpdate = chain([recoveredPkg])
      packageUpdate.set = vi.fn(() => packageUpdate)
      const taskUpdate = chain([{ ...grantTask(project.id as string, 'approved'), updatedAt: new Date('2026-07-03T00:02:00.000Z') }])
      taskUpdate.set = vi.fn(() => taskUpdate)
      mockDbSelect
        .mockReturnValueOnce(chain([grantTask(project.id as string, 'failed')]))
        .mockReturnValueOnce(chain([project]))
        .mockReturnValueOnce(chain([{ mcpId: 'filesystem', installPath: filesystemPath, enabled: true }]))
        .mockReturnValueOnce(chain([]))
        .mockReturnValueOnce(chain([failedPkg]))
        .mockReturnValueOnce(chain([]))
      mockTaskGrantTransactionLocks({
        packages: [failedPkg],
        project,
        task: grantTask(project.id as string, 'failed'),
      })
      mockDbUpdate
        .mockReturnValueOnce(approvalUpdate)
        .mockReturnValueOnce(packageUpdate)
        .mockReturnValueOnce(taskUpdate)

      const { PUT } = await import('@/app/api/tasks/[id]/filesystem-grants/route')
      const res = await PUT(authRequest('/api/tasks/task-fs-grant/filesystem-grants', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          schemaVersion: 1,
          grants: [{
            workPackageId: FS_GRANT_PACKAGE_ID,
            decision: 'approved',
            capabilities: ['filesystem.project.read', 'filesystem.project.search'],
            reason: 'Grant fixed',
          }],
        }),
      }) as never, {
        params: Promise.resolve({ id: 'task-fs-grant' }),
      })

      expect(res.status).toBe(200)
      expect(packageUpdate.set).toHaveBeenCalledWith(expect.objectContaining({
        blockedReason: null,
        status: 'ready',
      }))
      const packageSetMock = packageUpdate.set as unknown as { mock: { calls: Array<[{ metadata?: unknown }]> } }
      expect(flattenSqlChunks(packageSetMock.mock.calls[0][0].metadata)).toContain('- mcpGrantBlock')
      expect(taskUpdate.set).toHaveBeenCalledWith(expect.objectContaining({
        errorMessage: null,
        status: 'approved',
      }))
      // The recovered task must be re-enqueued so the worker picks it up again.
      expect(mockRedisLpush).toHaveBeenCalledWith(
        'forge:approvals',
        JSON.stringify({ taskId: 'task-fs-grant', action: 'approve' }),
      )
    })
  })

  it('does not recover or requeue a failed task when the operator denies the filesystem grant', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    mockDbInsert.mockReturnValue(chain([{
      id: FS_GRANT_DENIED_ID,
      taskId: 'task-fs-grant',
      workPackageId: FS_GRANT_PACKAGE_ID,
      decision: 'denied',
      capabilities: [],
      reason: 'Still too broad',
      updatedAt: new Date('2026-07-03T00:01:00.000Z'),
    }]))

    const failedPkg = {
      ...grantPackage({
        mcpGrantBlock: {
          blockedAt: '2026-07-03T00:00:30.000Z',
          missingCapabilities: ['filesystem.project.read', 'filesystem.project.search'],
          reason: 'Work package "Read project files" requires filesystem grant approval.',
          requestedCapabilities: ['filesystem.project.read', 'filesystem.project.search'],
          source: 'filesystem-grant-approval',
          status: 'failed',
        },
      }),
      status: 'failed',
      blockedReason: 'Work package "Read project files" requires filesystem grant approval.',
    }
    const deniedPkg = {
      ...failedPkg,
      status: 'blocked',
      blockedReason: 'Filesystem grant denied by operator; execution remains blocked.',
    }
    const approvalUpdate = chain([{
      id: FS_GRANT_DENIED_ID,
      taskId: 'task-fs-grant',
      workPackageId: FS_GRANT_PACKAGE_ID,
      decision: 'denied',
      capabilities: [],
      reason: 'Still too broad',
      updatedAt: new Date('2026-07-03T00:01:00.000Z'),
    }])
    approvalUpdate.set = vi.fn(() => approvalUpdate)
    const packageUpdate = chain([deniedPkg])
    packageUpdate.set = vi.fn(() => packageUpdate)
    mockDbSelect
      .mockReturnValueOnce(chain([grantTask('project-fs-grant', 'failed')]))
      .mockReturnValueOnce(chain([{ id: 'project-fs-grant' }]))
      .mockReturnValueOnce(chain([failedPkg]))
    mockTaskGrantTransactionLocks({
      packages: [failedPkg],
      project: { id: 'project-fs-grant', mcpConfig: {} },
      task: grantTask('project-fs-grant', 'failed'),
    })
    mockDbUpdate
      .mockReturnValueOnce(approvalUpdate)
      .mockReturnValueOnce(packageUpdate)

    const { PUT } = await import('@/app/api/tasks/[id]/filesystem-grants/route')
    const res = await PUT(authRequest('/api/tasks/task-fs-grant/filesystem-grants', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        schemaVersion: 1,
        grants: [{
          workPackageId: FS_GRANT_PACKAGE_ID,
          decision: 'denied',
          capabilities: [],
          reason: 'Still too broad',
        }],
      }),
    }) as never, {
      params: Promise.resolve({ id: 'task-fs-grant' }),
    })

    expect(res.status).toBe(200)
    expect(packageUpdate.set).toHaveBeenCalledWith(expect.objectContaining({
      blockedReason: expect.stringContaining('operator decision'),
      status: 'blocked',
    }))
    expect(mockRedisLpush).not.toHaveBeenCalled()
    expect(mockRedisPublish).not.toHaveBeenCalled()
    expect(mockDbUpdate).toHaveBeenCalledTimes(2)
  })

  it('allows a corrected approval after a failed-task grant denial left the package blocked', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    mockDbInsert.mockReturnValue(chain([{
      id: FS_GRANT_APPROVAL_ID,
      taskId: 'task-fs-grant',
      workPackageId: FS_GRANT_PACKAGE_ID,
      decision: 'approved',
      capabilities: ['filesystem.project.read', 'filesystem.project.search'],
      reason: 'Approved after review',
      updatedAt: new Date('2026-07-03T00:03:00.000Z'),
    }]))

    await withFilesystemProject(async (project, filesystemPath) => {
      const blockedPkg = {
        ...grantPackage({
          mcpGrantBlock: {
            blockedAt: '2026-07-03T00:00:30.000Z',
            missingCapabilities: ['filesystem.project.read', 'filesystem.project.search'],
            reason: 'Work package "Read project files" requires filesystem grant approval.',
            requestedCapabilities: ['filesystem.project.read', 'filesystem.project.search'],
            source: 'filesystem-grant-approval',
            status: 'failed',
          },
        }),
        status: 'blocked',
        blockedReason: 'Filesystem grant denied by operator; execution remains blocked.',
      }
      const recoveredPkg = { ...blockedPkg, blockedReason: null, status: 'ready' }
      const approvalUpdate = chain([{
        id: FS_GRANT_APPROVAL_ID,
        taskId: 'task-fs-grant',
        workPackageId: FS_GRANT_PACKAGE_ID,
        decision: 'approved',
        capabilities: ['filesystem.project.read', 'filesystem.project.search'],
        reason: 'Approved after review',
        updatedAt: new Date('2026-07-03T00:03:00.000Z'),
      }])
      approvalUpdate.set = vi.fn(() => approvalUpdate)
      const packageUpdate = chain([recoveredPkg])
      packageUpdate.set = vi.fn(() => packageUpdate)
      const taskUpdate = chain([{ ...grantTask(project.id as string, 'approved'), updatedAt: new Date('2026-07-03T00:04:00.000Z') }])
      taskUpdate.set = vi.fn(() => taskUpdate)
      mockDbSelect
        .mockReturnValueOnce(chain([grantTask(project.id as string, 'failed')]))
        .mockReturnValueOnce(chain([project]))
        .mockReturnValueOnce(chain([{ mcpId: 'filesystem', installPath: filesystemPath, enabled: true }]))
        .mockReturnValueOnce(chain([]))
        .mockReturnValueOnce(chain([blockedPkg]))
        .mockReturnValueOnce(chain([]))
      mockTaskGrantTransactionLocks({
        packages: [blockedPkg],
        project,
        task: grantTask(project.id as string, 'failed'),
      })
      mockDbUpdate
        .mockReturnValueOnce(approvalUpdate)
        .mockReturnValueOnce(packageUpdate)
        .mockReturnValueOnce(taskUpdate)

      const { PUT } = await import('@/app/api/tasks/[id]/filesystem-grants/route')
      const res = await PUT(authRequest('/api/tasks/task-fs-grant/filesystem-grants', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          schemaVersion: 1,
          grants: [{
            workPackageId: FS_GRANT_PACKAGE_ID,
            decision: 'approved',
            capabilities: ['filesystem.project.read', 'filesystem.project.search'],
            reason: 'Approved after review',
          }],
        }),
      }) as never, {
        params: Promise.resolve({ id: 'task-fs-grant' }),
      })

      expect(res.status).toBe(200)
      expect(packageUpdate.set).toHaveBeenCalledWith(expect.objectContaining({
        blockedReason: null,
        status: 'ready',
      }))
      expect(taskUpdate.set).toHaveBeenCalledWith(expect.objectContaining({
        errorMessage: null,
        status: 'approved',
      }))
      expect(mockRedisLpush).toHaveBeenCalledWith(
        'forge:approvals',
        JSON.stringify({ taskId: 'task-fs-grant', action: 'approve' }),
      )
    })
  })

  it('does not recover or requeue the task while another failed package still exists', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    mockDbInsert.mockReturnValue(chain([{
      id: FS_GRANT_APPROVAL_ID,
      taskId: 'task-fs-grant',
      workPackageId: FS_GRANT_PACKAGE_ID,
      decision: 'approved',
      capabilities: ['filesystem.project.read', 'filesystem.project.search'],
      reason: 'Partial recovery',
      updatedAt: new Date('2026-07-03T00:03:00.000Z'),
    }]))

    await withFilesystemProject(async (project, filesystemPath) => {
      const failedPkg = {
        ...grantPackage({
          mcpGrantBlock: {
            blockedAt: '2026-07-03T00:00:30.000Z',
            missingCapabilities: ['filesystem.project.read', 'filesystem.project.search'],
            reason: 'Work package "Read project files" requires filesystem grant approval.',
            requestedCapabilities: ['filesystem.project.read', 'filesystem.project.search'],
            source: 'filesystem-grant-approval',
            status: 'failed',
          },
        }),
        status: 'failed',
        blockedReason: 'Work package "Read project files" requires filesystem grant approval.',
      }
      const recoveredPkg = { ...failedPkg, blockedReason: null, status: 'ready' }
      const approvalUpdate = chain([{
        id: FS_GRANT_APPROVAL_ID,
        taskId: 'task-fs-grant',
        workPackageId: FS_GRANT_PACKAGE_ID,
        decision: 'approved',
        capabilities: ['filesystem.project.read', 'filesystem.project.search'],
        reason: 'Partial recovery',
        updatedAt: new Date('2026-07-03T00:03:00.000Z'),
      }])
      approvalUpdate.set = vi.fn(() => approvalUpdate)
      const packageUpdate = chain([recoveredPkg])
      packageUpdate.set = vi.fn(() => packageUpdate)
      mockDbSelect
        .mockReturnValueOnce(chain([grantTask(project.id as string, 'failed')]))
        .mockReturnValueOnce(chain([project]))
        .mockReturnValueOnce(chain([{ mcpId: 'filesystem', installPath: filesystemPath, enabled: true }]))
        .mockReturnValueOnce(chain([]))
        .mockReturnValueOnce(chain([failedPkg]))
        .mockReturnValueOnce(chain([{
          status: 'failed',
          metadata: { mcpGrantBlock: { source: 'filesystem-grant-approval', status: 'failed' } },
        }]))
      mockTaskGrantTransactionLocks({
        packages: [
          failedPkg,
          {
            ...grantPackage(),
            id: '00000000-0000-4000-8000-000000000212',
            status: 'failed',
            metadata: {},
          },
        ],
        project,
        task: grantTask(project.id as string, 'failed'),
      })
      mockDbUpdate
        .mockReturnValueOnce(approvalUpdate)
        .mockReturnValueOnce(packageUpdate)

      const { PUT } = await import('@/app/api/tasks/[id]/filesystem-grants/route')
      const res = await PUT(authRequest('/api/tasks/task-fs-grant/filesystem-grants', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          schemaVersion: 1,
          grants: [{
            workPackageId: FS_GRANT_PACKAGE_ID,
            decision: 'approved',
            capabilities: ['filesystem.project.read', 'filesystem.project.search'],
            reason: 'Partial recovery',
          }],
        }),
      }) as never, {
        params: Promise.resolve({ id: 'task-fs-grant' }),
      })

      expect(res.status).toBe(200)
      expect(mockDbUpdate).toHaveBeenCalledTimes(2)
      expect(mockRedisLpush).not.toHaveBeenCalled()
      expect(mockRedisPublish).not.toHaveBeenCalled()
    })
  })

  it('does not recover or requeue the task while another grant-blocked package remains blocked', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    mockDbInsert.mockReturnValue(chain([{
      id: FS_GRANT_APPROVAL_ID,
      taskId: 'task-fs-grant',
      workPackageId: FS_GRANT_PACKAGE_ID,
      decision: 'approved',
      capabilities: ['filesystem.project.read', 'filesystem.project.search'],
      reason: 'Partial recovery',
      updatedAt: new Date('2026-07-03T00:03:00.000Z'),
    }]))

    await withFilesystemProject(async (project, filesystemPath) => {
      const failedPkg = {
        ...grantPackage({
          mcpGrantBlock: {
            blockedAt: '2026-07-03T00:00:30.000Z',
            missingCapabilities: ['filesystem.project.read', 'filesystem.project.search'],
            reason: 'Work package "Read project files" requires filesystem grant approval.',
            requestedCapabilities: ['filesystem.project.read', 'filesystem.project.search'],
            source: 'filesystem-grant-approval',
            status: 'failed',
          },
        }),
        status: 'failed',
        blockedReason: 'Work package "Read project files" requires filesystem grant approval.',
      }
      const recoveredPkg = { ...failedPkg, blockedReason: null, status: 'ready' }
      const approvalUpdate = chain([{
        id: FS_GRANT_APPROVAL_ID,
        taskId: 'task-fs-grant',
        workPackageId: FS_GRANT_PACKAGE_ID,
        decision: 'approved',
        capabilities: ['filesystem.project.read', 'filesystem.project.search'],
        reason: 'Partial recovery',
        updatedAt: new Date('2026-07-03T00:03:00.000Z'),
      }])
      approvalUpdate.set = vi.fn(() => approvalUpdate)
      const packageUpdate = chain([recoveredPkg])
      packageUpdate.set = vi.fn(() => packageUpdate)
      mockDbSelect
        .mockReturnValueOnce(chain([grantTask(project.id as string, 'failed')]))
        .mockReturnValueOnce(chain([project]))
        .mockReturnValueOnce(chain([{ mcpId: 'filesystem', installPath: filesystemPath, enabled: true }]))
        .mockReturnValueOnce(chain([]))
        .mockReturnValueOnce(chain([failedPkg]))
        .mockReturnValueOnce(chain([{
          status: 'blocked',
          metadata: { mcpGrantBlock: { source: 'filesystem-grant-approval', status: 'failed' } },
        }]))
      mockTaskGrantTransactionLocks({
        packages: [
          failedPkg,
          {
            ...grantPackage(),
            id: '00000000-0000-4000-8000-000000000212',
            status: 'blocked',
            metadata: { mcpGrantBlock: { source: 'filesystem-grant-approval', status: 'failed' } },
          },
        ],
        project,
        task: grantTask(project.id as string, 'failed'),
      })
      mockDbUpdate
        .mockReturnValueOnce(approvalUpdate)
        .mockReturnValueOnce(packageUpdate)

      const { PUT } = await import('@/app/api/tasks/[id]/filesystem-grants/route')
      const res = await PUT(authRequest('/api/tasks/task-fs-grant/filesystem-grants', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          schemaVersion: 1,
          grants: [{
            workPackageId: FS_GRANT_PACKAGE_ID,
            decision: 'approved',
            capabilities: ['filesystem.project.read', 'filesystem.project.search'],
            reason: 'Partial recovery',
          }],
        }),
      }) as never, {
        params: Promise.resolve({ id: 'task-fs-grant' }),
      })

      expect(res.status).toBe(200)
      expect(mockDbUpdate).toHaveBeenCalledTimes(2)
      expect(mockRedisLpush).not.toHaveBeenCalled()
      expect(mockRedisPublish).not.toHaveBeenCalled()
    })
  })

  it('returns 404 for privileged grant edits on a legacy null-owned task', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    mockDbSelect
      .mockReturnValueOnce(chain([grantTask('project-fs-grant', 'failed', null)]))

    const { PUT } = await import('@/app/api/tasks/[id]/filesystem-grants/route')
    const res = await PUT(authRequest('/api/tasks/task-fs-grant/filesystem-grants', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        schemaVersion: 1,
        grants: [{ workPackageId: FS_GRANT_PACKAGE_ID, decision: 'denied', capabilities: [] }],
      }),
    }) as never, {
      params: Promise.resolve({ id: 'task-fs-grant' }),
    })

    expect(res.status).toBe(404)
    expect(mockDbInsert).not.toHaveBeenCalled()
    expect(mockDbUpdate).not.toHaveBeenCalled()
  })

  it('returns 404 for privileged filesystem grant reads on a legacy null-owned task', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    mockDbSelect
      .mockReturnValueOnce(chain([grantTask('project-fs-grant', 'failed', null)]))

    const { GET } = await import('@/app/api/tasks/[id]/filesystem-grants/route')
    const res = await GET(authRequest('/api/tasks/task-fs-grant/filesystem-grants') as never, {
      params: Promise.resolve({ id: 'task-fs-grant' }),
    })

    expect(res.status).toBe(404)
    expect(mockDbInsert).not.toHaveBeenCalled()
    expect(mockDbUpdate).not.toHaveBeenCalled()
  })

  it('returns 202 and leaves the task approved when the recovered task cannot be requeued', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    mockDbInsert.mockReturnValue(chain([{
      id: FS_GRANT_APPROVAL_ID,
      taskId: 'task-fs-grant',
      workPackageId: FS_GRANT_PACKAGE_ID,
      decision: 'approved',
      capabilities: ['filesystem.project.read', 'filesystem.project.search'],
      reason: 'Grant fixed',
      updatedAt: new Date('2026-07-03T00:01:00.000Z'),
    }]))
    mockRedisLpush.mockRejectedValueOnce(new Error('redis down'))

    await withFilesystemProject(async (project, filesystemPath) => {
      const failedPkg = {
        ...grantPackage({
          mcpGrantBlock: {
            blockedAt: '2026-07-03T00:00:30.000Z',
            missingCapabilities: ['filesystem.project.read', 'filesystem.project.search'],
            reason: 'Work package "Read project files" requires filesystem grant approval.',
            requestedCapabilities: ['filesystem.project.read', 'filesystem.project.search'],
            source: 'filesystem-grant-approval',
            status: 'failed',
          },
        }),
        status: 'failed',
        blockedReason: 'Work package "Read project files" requires filesystem grant approval.',
      }
      const recoveredPkg = { ...failedPkg, blockedReason: null, status: 'ready' }
      const approvalUpdate = chain([{
        id: FS_GRANT_APPROVAL_ID,
        taskId: 'task-fs-grant',
        workPackageId: FS_GRANT_PACKAGE_ID,
        decision: 'approved',
        capabilities: ['filesystem.project.read', 'filesystem.project.search'],
        reason: 'Grant fixed',
        updatedAt: new Date('2026-07-03T00:01:00.000Z'),
      }])
      approvalUpdate.set = vi.fn(() => approvalUpdate)
      const packageUpdate = chain([recoveredPkg])
      packageUpdate.set = vi.fn(() => packageUpdate)
      const taskApproveUpdate = chain([{ ...grantTask(project.id as string, 'approved'), updatedAt: new Date('2026-07-03T00:02:00.000Z') }])
      taskApproveUpdate.set = vi.fn(() => taskApproveUpdate)
      mockDbSelect
        .mockReturnValueOnce(chain([grantTask(project.id as string, 'failed')]))
        .mockReturnValueOnce(chain([project]))
        .mockReturnValueOnce(chain([{ mcpId: 'filesystem', installPath: filesystemPath, enabled: true }]))
        .mockReturnValueOnce(chain([]))
        .mockReturnValueOnce(chain([failedPkg]))
        .mockReturnValueOnce(chain([]))
      mockTaskGrantTransactionLocks({
        packages: [failedPkg],
        project,
        task: grantTask(project.id as string, 'failed'),
      })
      mockDbUpdate
        .mockReturnValueOnce(approvalUpdate)
        .mockReturnValueOnce(packageUpdate)
        .mockReturnValueOnce(taskApproveUpdate)

      const { PUT } = await import('@/app/api/tasks/[id]/filesystem-grants/route')
      const res = await PUT(authRequest('/api/tasks/task-fs-grant/filesystem-grants', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          schemaVersion: 1,
          grants: [{
            workPackageId: FS_GRANT_PACKAGE_ID,
            decision: 'approved',
            capabilities: ['filesystem.project.read', 'filesystem.project.search'],
            reason: 'Grant fixed',
          }],
        }),
      }) as never, {
        params: Promise.resolve({ id: 'task-fs-grant' }),
      })

      expect(res.status).toBe(202)
      expect(mockDbUpdate).toHaveBeenCalledTimes(3)
    })
  })

  it('does not open failed grant recovery for unrelated failed packages', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    const failedPkg = {
      ...grantPackage(),
      status: 'failed',
      mcpRequirements: [],
      metadata: {},
    }
    mockDbSelect
      .mockReturnValueOnce(chain([grantTask('project-fs-grant', 'failed')]))
      .mockReturnValueOnce(chain([{ id: 'project-fs-grant' }]))
      .mockReturnValueOnce(chain([failedPkg]))
    mockTaskGrantTransactionLocks({
      packages: [failedPkg],
      project: { id: 'project-fs-grant', mcpConfig: {} },
      task: grantTask('project-fs-grant', 'failed'),
    })

    const { PUT } = await import('@/app/api/tasks/[id]/filesystem-grants/route')
    const res = await PUT(authRequest('/api/tasks/task-fs-grant/filesystem-grants', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        schemaVersion: 1,
        grants: [{ workPackageId: FS_GRANT_PACKAGE_ID, decision: 'denied', capabilities: [], reason: 'Still blocked' }],
      }),
    }) as never, {
      params: Promise.resolve({ id: 'task-fs-grant' }),
    })

    expect(res.status).toBe(409)
    expect(mockDbInsert).not.toHaveBeenCalled()
    expect(mockDbUpdate).not.toHaveBeenCalled()
  })

  it('does not open failed grant recovery for a filesystem package that failed for an unrelated reason', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    // Filesystem surface is present (it requested filesystem access), but the
    // failure was not a grant block — there is no mcpGrantBlock marker — so a
    // grant edit must not silently clear the real failure via recovery.
    const failedPkg = {
      ...grantPackage(),
      status: 'failed',
      blockedReason: 'Model execution failed during implementation.',
    }
    mockDbSelect
      .mockReturnValueOnce(chain([grantTask('project-fs-grant', 'failed')]))
      .mockReturnValueOnce(chain([{ id: 'project-fs-grant' }]))
      .mockReturnValueOnce(chain([failedPkg]))
    mockTaskGrantTransactionLocks({
      packages: [failedPkg],
      project: { id: 'project-fs-grant', mcpConfig: {} },
      task: grantTask('project-fs-grant', 'failed'),
    })

    const { PUT } = await import('@/app/api/tasks/[id]/filesystem-grants/route')
    const res = await PUT(authRequest('/api/tasks/task-fs-grant/filesystem-grants', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        schemaVersion: 1,
        grants: [{ workPackageId: FS_GRANT_PACKAGE_ID, decision: 'denied', capabilities: [], reason: 'Try again' }],
      }),
    }) as never, {
      params: Promise.resolve({ id: 'task-fs-grant' }),
    })

    expect(res.status).toBe(409)
    expect(mockDbInsert).not.toHaveBeenCalled()
    expect(mockDbUpdate).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Suite 3.4e — Open questions: POST /api/tasks/:id/questions
// ---------------------------------------------------------------------------

describe('POST /api/tasks/:id/questions', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('returns 401 when not authenticated', async () => {
    mockGetSession.mockResolvedValue(null)
    const { POST } = await import('@/app/api/tasks/[id]/questions/route')
    const req = authRequest('/api/tasks/task-1/questions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answers: [{ id: 'q1', answer: 'yes' }] }),
    })
    const res = await POST(req as never, { params: Promise.resolve({ id: 'task-1' }) })
    expect(res.status).toBe(401)
  })

  it('returns 409 when the task is not awaiting answers', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    mockDbSelect.mockReturnValue(chain([{ id: 'task-1', status: 'awaiting_approval' }]))
    const { POST } = await import('@/app/api/tasks/[id]/questions/route')
    const req = authRequest('/api/tasks/task-1/questions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answers: [{ id: 'q1', answer: 'yes' }] }),
    })
    const res = await POST(req as never, { params: Promise.resolve({ id: 'task-1' }) })
    expect(res.status).toBe(409)
    expect(mockDbUpdate).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Suite 3.5 — Agent type sanitisation: PUT /api/agents/../../etc/passwd returns 400
//
// The route handler validates agent types against a safe slug pattern. A path
// segment like "../../etc/passwd" is URL-decoded before being passed as `type`,
// then rejected because it is not a safe slug.
// This test documents the path traversal regression guard.
// ---------------------------------------------------------------------------

describe('PUT /api/agents/[type] — path traversal blocked', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('resolves the default prompt sync directory under the native workspace when cwd is web', async () => {
    const previous = process.env.FORGE_AGENT_CONFIG_DIR
    delete process.env.FORGE_AGENT_CONFIG_DIR

    try {
      const { resolveAgentConfigDir } = await import('@/lib/agent-prompts')
      const repoRoot = path.join(os.tmpdir(), 'Forge')
      const workspaceRoot = path.join(os.tmpdir(), 'Documents', 'Forge')
      expect(resolveAgentConfigDir(path.join(repoRoot, 'web'))).toBe(
        path.join(os.homedir(), 'Documents', 'Forge', 'prompts', 'agents'),
      )
      expect(resolveAgentConfigDir(path.join(repoRoot, 'web'), workspaceRoot)).toBe(
        path.join(workspaceRoot, 'prompts', 'agents'),
      )
    } finally {
      if (previous === undefined) {
        delete process.env.FORGE_AGENT_CONFIG_DIR
      } else {
        process.env.FORGE_AGENT_CONFIG_DIR = previous
      }
    }
  })

  it('returns 400 for an unsafe agent slug path traversal attempt', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)

    const { PUT } = await import('@/app/api/agents/[type]/route')
    const req = authRequest('/api/agents/../../etc/passwd', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ systemPrompt: 'injected' }),
    })
    // Simulate Next.js passing the raw decoded segment as params.type
    const params = Promise.resolve({ type: '../../etc/passwd' })

    const res = await PUT(req as never, { params })

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/invalid agent type/i)
  })
})

// ---------------------------------------------------------------------------
// Suite 3.5b — Dynamic agents and editable workforces
// ---------------------------------------------------------------------------

describe('dynamic agents and workforces', () => {
  beforeEach(() => { vi.clearAllMocks() })
  afterEach(() => {
    mockDbInsert.mockReset()
    mockDbSelect.mockReset()
    mockDbUpdate.mockReset()
    mockDbDelete.mockReset()
  })

  it('creates an arbitrary safe agent slug instead of requiring a fixed role', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    mockDbSelect.mockReturnValue(chain([]))
    mockDbInsert.mockReturnValue(chain([{
      id: 'agent-1',
      agentType: 'security-red-team',
      displayName: 'Security Red Team',
      description: 'Adversarial review specialist.',
      isSystem: false,
      isActive: true,
      providerConfigId: null,
      systemPrompt: 'Review changes adversarially.',
      frontmatterOverrides: null,
      updatedAt: new Date(),
      updatedBy: FAKE_SESSION.userId,
    }]))
    const previousRoot = process.env.FORGE_WORKSPACE_ROOT
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-agent-create-'))

    try {
      process.env.FORGE_WORKSPACE_ROOT = workspaceRoot

      const { POST } = await import('@/app/api/agents/route')
      const req = authRequest('/api/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agentType: 'security-red-team',
          displayName: 'Security Red Team',
          description: 'Adversarial review specialist.',
          systemPrompt: 'Review changes adversarially.',
        }),
      })

      const res = await POST(req as never)
      expect(res.status).toBe(201)
      const body = await res.json()
      expect(body.agent.agentType).toBe('security-red-team')
      expect(mockDbInsert).toHaveBeenCalledOnce()
      await expect(
        fs.readFile(path.join(workspaceRoot, 'prompts', 'agents', 'security-red-team.toml'), 'utf-8'),
      ).resolves.toContain('Review changes adversarially.')
    } finally {
      if (previousRoot === undefined) {
        delete process.env.FORGE_WORKSPACE_ROOT
      } else {
        process.env.FORGE_WORKSPACE_ROOT = previousRoot
      }
      await fs.rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('creates a new agent from name only and generates the slug and prompt internally', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    mockDbSelect.mockReturnValue(chain([]))
    mockDbInsert.mockReturnValue(chain([{
      id: 'agent-name-only',
      agentType: 'security-red-team',
      displayName: 'Security Red Team',
      description: '',
      isSystem: false,
      isActive: true,
      providerConfigId: null,
      systemPrompt: 'You are the Security Red Team specialist agent for Forge.',
      frontmatterOverrides: null,
      updatedAt: new Date(),
      updatedBy: FAKE_SESSION.userId,
    }]))
    const previousRoot = process.env.FORGE_WORKSPACE_ROOT
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-agent-name-only-'))

    try {
      process.env.FORGE_WORKSPACE_ROOT = workspaceRoot

      const { POST } = await import('@/app/api/agents/route')
      const res = await POST(authRequest('/api/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Security Red Team' }),
      }) as never)

      expect(res.status).toBe(201)
      const body = await res.json()
      expect(body.agent.agentType).toBe('security-red-team')
      await expect(
        fs.readFile(path.join(workspaceRoot, 'prompts', 'agents', 'security-red-team.toml'), 'utf-8'),
      ).resolves.toContain('Security Red Team specialist')
    } finally {
      if (previousRoot === undefined) {
        delete process.env.FORGE_WORKSPACE_ROOT
      } else {
        process.env.FORGE_WORKSPACE_ROOT = previousRoot
      }
      await fs.rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('rejects duplicate agent names after trimming, whitespace collapse, and case folding', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    mockDbSelect.mockReturnValue(chain([{
      agentType: 'security-red-team',
      displayName: ' Security   Red Team ',
    }]))

    const { POST } = await import('@/app/api/agents/route')
    const req = authRequest('/api/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'security red team',
        systemPrompt: 'Review changes adversarially.',
      }),
    })

    const res = await POST(req as never)
    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(/agent name/i)
    expect(mockDbInsert).not.toHaveBeenCalled()
  })

  it('returns workforce member assignment details without exposing system prompts', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    mockDbSelect
      .mockReturnValueOnce(chain([{
        id: 'workforce-1',
        slug: 'release-squad',
        displayName: 'Release Squad',
        description: 'Release readiness team.',
        isDefault: false,
        isActive: true,
        metadata: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      }]))
      .mockReturnValueOnce(chain([{
        id: 'member-1',
        workforceId: 'workforce-1',
        agentConfigId: '00000000-0000-4000-8000-000000000001',
        roleLabel: 'Release reviewer',
        sequence: 1,
        isRequired: true,
        metadata: {},
        createdAt: new Date(),
        updatedAt: new Date(),
        agentType: 'reviewer',
        displayName: 'Reviewer',
        description: 'Review work.',
        isActive: true,
      }]))

    const { GET } = await import('@/app/api/workforces/route')
    const res = await GET(authRequest('/api/workforces') as never)

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.workforces[0].members[0]).toMatchObject({
      agentType: 'reviewer',
      roleLabel: 'Release reviewer',
    })
    expect(body.workforces[0].members[0].systemPrompt).toBeUndefined()
  })

  it('removes the inserted agent row if prompt file creation fails', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    mockDbSelect.mockReturnValue(chain([]))
    mockDbInsert.mockReturnValue(chain([{
      id: 'agent-rollback',
      agentType: 'security-red-team',
      displayName: 'Security Red Team',
      description: 'Adversarial review specialist.',
      isSystem: false,
      isActive: true,
      providerConfigId: null,
      systemPrompt: 'Review changes adversarially.',
      frontmatterOverrides: null,
      updatedAt: new Date(),
      updatedBy: FAKE_SESSION.userId,
    }]))
    mockDbDelete.mockReturnValue(chain([]))
    const previousRoot = process.env.FORGE_WORKSPACE_ROOT
    const previousPromptDir = process.env.FORGE_AGENT_CONFIG_DIR
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-agent-rollback-'))
    const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-agent-outside-'))

    try {
      process.env.FORGE_WORKSPACE_ROOT = workspaceRoot
      process.env.FORGE_AGENT_CONFIG_DIR = outsideRoot

      const { POST } = await import('@/app/api/agents/route')
      const req = authRequest('/api/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agentType: 'security-red-team',
          displayName: 'Security Red Team',
          description: 'Adversarial review specialist.',
          systemPrompt: 'Review changes adversarially.',
        }),
      })

      const res = await POST(req as never)
      expect(res.status).toBe(500)
      const body = await res.json()
      expect(body.error).toMatch(/prompt file/i)
      expect(mockDbDelete).toHaveBeenCalledOnce()
    } finally {
      if (previousRoot === undefined) {
        delete process.env.FORGE_WORKSPACE_ROOT
      } else {
        process.env.FORGE_WORKSPACE_ROOT = previousRoot
      }
      if (previousPromptDir === undefined) {
        delete process.env.FORGE_AGENT_CONFIG_DIR
      } else {
        process.env.FORGE_AGENT_CONFIG_DIR = previousPromptDir
      }
      await fs.rm(workspaceRoot, { recursive: true, force: true })
      await fs.rm(outsideRoot, { recursive: true, force: true })
    }
  })

  it('restores the previous prompt file when an agent update fails after disk sync', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    mockDbSelect.mockReturnValue(chain([{
      id: 'agent-rollback',
      agentType: 'security-red-team',
      displayName: 'Security Red Team',
      description: 'Adversarial review specialist.',
      isSystem: false,
      isActive: true,
      providerConfigId: null,
      systemPrompt: 'Old prompt.',
      frontmatterOverrides: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      updatedBy: FAKE_SESSION.userId,
    }]))
    mockDbUpdate.mockImplementation(() => {
      throw new Error('database update failed')
    })
    const previousRoot = process.env.FORGE_WORKSPACE_ROOT
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-agent-update-rollback-'))
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      process.env.FORGE_WORKSPACE_ROOT = workspaceRoot
      const { syncAgentPromptFileToWorkspace } = await import('@/lib/agent-prompts')
      await syncAgentPromptFileToWorkspace({
        agentType: 'security-red-team',
        systemPrompt: 'Old prompt.',
      })

      const { PUT } = await import('@/app/api/agents/[type]/route')
      const req = authRequest('/api/agents/security-red-team', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemPrompt: 'New prompt that should roll back.',
          providerConfigId: '00000000-0000-4000-8000-000000000001',
        }),
      })

      const res = await PUT(req as never, { params: Promise.resolve({ type: 'security-red-team' }) })
      expect(res.status).toBe(500)
      const promptFile = await fs.readFile(
        path.join(workspaceRoot, 'prompts', 'agents', 'security-red-team.toml'),
        'utf-8',
      )
      expect(promptFile).toContain('Old prompt.')
      expect(promptFile).not.toContain('New prompt that should roll back.')
    } finally {
      consoleError.mockRestore()
      if (previousRoot === undefined) {
        delete process.env.FORGE_WORKSPACE_ROOT
      } else {
        process.env.FORGE_WORKSPACE_ROOT = previousRoot
      }
      await fs.rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('creates an editable workforce with selected agent memberships', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    mockDbInsert
      .mockReturnValueOnce(chain([{ id: 'workforce-1' }]))
      .mockReturnValueOnce(chain([]))
    mockDbSelect
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([{
        id: 'workforce-1',
        slug: 'release-squad',
        displayName: 'Release Squad',
        description: '',
        isDefault: false,
        isActive: true,
        metadata: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      }]))
      .mockReturnValueOnce(chain([{
        id: 'member-1',
        workforceId: 'workforce-1',
        agentConfigId: '00000000-0000-4000-8000-000000000001',
        roleLabel: 'Release reviewer',
        sequence: 1,
        isRequired: true,
        metadata: {},
        createdAt: new Date(),
        updatedAt: new Date(),
        agentType: 'reviewer',
        displayName: 'Reviewer',
        description: 'Review work.',
        isActive: true,
      }]))
    const previousRoot = process.env.FORGE_WORKSPACE_ROOT
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-workforce-create-'))

    try {
      process.env.FORGE_WORKSPACE_ROOT = workspaceRoot

      const { POST } = await import('@/app/api/workforces/route')
      const req = authRequest('/api/workforces', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          slug: 'release-squad',
          displayName: 'Release Squad',
          members: [
            {
              agentConfigId: '00000000-0000-4000-8000-000000000001',
              roleLabel: 'Release reviewer',
            },
          ],
        }),
      })

      const res = await POST(req as never)
      expect(res.status).toBe(201)
      expect(mockDbTransaction).toHaveBeenCalledOnce()
      expect(mockDbInsert).toHaveBeenCalledTimes(2)
      await expect(
        fs.readFile(path.join(workspaceRoot, 'workforces', 'release-squad', 'manager-prompt.md'), 'utf-8'),
      ).resolves.toContain('Release Squad')
    } finally {
      if (previousRoot === undefined) {
        delete process.env.FORGE_WORKSPACE_ROOT
      } else {
        process.env.FORGE_WORKSPACE_ROOT = previousRoot
      }
      await fs.rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('rejects duplicate workforce names after trimming, whitespace collapse, and case folding', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    mockDbSelect.mockReturnValue(chain([{
      slug: 'release-squad',
      displayName: ' Release   Squad ',
    }]))

    const { POST } = await import('@/app/api/workforces/route')
    const req = authRequest('/api/workforces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'release squad',
      }),
    })

    const res = await POST(req as never)
    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(/workforce name/i)
    expect(mockDbTransaction).not.toHaveBeenCalled()
  })

  it('returns a warning instead of failing when workforce file export fails after commit', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    mockDbInsert
      .mockReturnValueOnce(chain([{ id: 'workforce-1' }]))
    mockDbSelect
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([{
        id: 'workforce-1',
        slug: 'release-squad',
        displayName: 'Release Squad',
        description: '',
        isDefault: false,
        isActive: true,
        metadata: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      }]))
      .mockReturnValueOnce(chain([]))
    const previousRoot = process.env.FORGE_WORKSPACE_ROOT
    const workspaceFile = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'forge-workforce-export-fail-')), 'not-a-directory')
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      await fs.writeFile(workspaceFile, 'file blocks directory creation')
      process.env.FORGE_WORKSPACE_ROOT = workspaceFile

      const { POST } = await import('@/app/api/workforces/route')
      const req = authRequest('/api/workforces', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          slug: 'release-squad',
          displayName: 'Release Squad',
        }),
      })

      const res = await POST(req as never)
      expect(res.status).toBe(201)
      const body = await res.json()
      expect(body.workforces).toHaveLength(1)
      expect(body.warnings[0]).toMatch(/could not be refreshed/i)
    } finally {
      consoleError.mockRestore()
      if (previousRoot === undefined) {
        delete process.env.FORGE_WORKSPACE_ROOT
      } else {
        process.env.FORGE_WORKSPACE_ROOT = previousRoot
      }
      await fs.rm(path.dirname(workspaceFile), { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// Suite 3.6 — Provider validation: baseUrl is required only for self-hosted
//              endpoints (custom/litellm). Local runtimes like ollama default to
//              a known localhost URL, so no baseUrl is required.
// ---------------------------------------------------------------------------

describe('POST /api/providers — baseUrl requirement', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetSession.mockReset()
    mockDbSelect.mockReset()
    mockDbInsert.mockReset()
    mockDbUpdate.mockReset()
    mockDbDelete.mockReset()
    mockRedisLpush.mockReset()
    mockRedisPublish.mockReset()
  })

  it('allows ollama without baseUrl (defaults to the local endpoint)', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    mockDbInsert.mockReturnValue(chain([{
      id: 'provider-ollama',
      displayName: 'Local Ollama',
      providerType: 'ollama',
      modelId: 'llama3',
      baseUrl: null,
      apiKeyEnvVar: null,
      apiKeyCiphertext: null,
      isLocal: true,
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    }]))

    const { POST } = await import('@/app/api/providers/route')
    const req = authRequest('/api/providers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        displayName: 'Local Ollama',
        providerType: 'ollama',
        modelId: 'llama3',
        isLocal: true,
        // no baseUrl — ollama defaults to http://localhost:11434
      }),
    })

    const res = await POST(req as never)

    expect(res.status).toBe(201)
  })

  it('returns 400 when providerType is custom and baseUrl is missing', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)

    const { POST } = await import('@/app/api/providers/route')
    const req = authRequest('/api/providers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        displayName: 'Custom Orchestrator',
        providerType: 'custom',
        modelId: 'gpt-5.5',
        isLocal: false,
      }),
    })

    const res = await POST(req as never)

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/baseUrl/i)
  })

  it('creates a custom provider when baseUrl is present', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    const createdProvider = {
      id: 'provider-custom',
      displayName: 'Custom Orchestrator',
      providerType: 'custom',
      modelId: 'provider/model-anything',
      baseUrl: 'https://models.example.com/v1',
      apiKeyEnvVar: null,
      isLocal: false,
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    }
    mockDbInsert.mockReturnValue(chain([createdProvider]))

    const { POST } = await import('@/app/api/providers/route')
    const req = authRequest('/api/providers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        displayName: createdProvider.displayName,
        providerType: createdProvider.providerType,
        modelId: createdProvider.modelId,
        baseUrl: createdProvider.baseUrl,
        isLocal: createdProvider.isLocal,
      }),
    })

    const res = await POST(req as never)

    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.provider).toMatchObject({
      providerType: 'custom',
      modelId: 'provider/model-anything',
      baseUrl: 'https://models.example.com/v1',
    })
  })

  it('rejects apiKeyEnvVar for custom providers with arbitrary endpoints', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)

    const { POST } = await import('@/app/api/providers/route')
    const req = authRequest('/api/providers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        displayName: 'Custom Orchestrator',
        providerType: 'custom',
        modelId: 'provider/model-anything',
        baseUrl: 'https://models.example.com/v1',
        apiKeyEnvVar: 'SESSION_SECRET',
        isLocal: false,
      }),
    })

    const res = await POST(req as never)

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/cannot read API keys from server environment variables/i)
    expect(mockDbInsert).not.toHaveBeenCalled()
  })

  it('allows a fixed cloud provider to use its allowlisted env var', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    const createdProvider = {
      id: 'provider-openai',
      displayName: 'OpenAI',
      providerType: 'openai',
      modelId: 'gpt-4.1',
      baseUrl: null,
      apiKeyEnvVar: 'OPENAI_API_KEY',
      apiKeyCiphertext: null,
      isLocal: false,
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    }
    mockDbInsert.mockReturnValue(chain([createdProvider]))

    const { POST } = await import('@/app/api/providers/route')
    const req = authRequest('/api/providers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        displayName: createdProvider.displayName,
        providerType: 'openai',
        modelId: createdProvider.modelId,
        apiKeyEnvVar: 'OPENAI_API_KEY',
        isLocal: false,
      }),
    })

    const res = await POST(req as never)

    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.provider).toMatchObject({
      providerType: 'openai',
      apiKeyEnvVar: 'OPENAI_API_KEY',
    })
  })

  it('rejects fixed cloud providers with custom base URLs', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)

    const { POST } = await import('@/app/api/providers/route')
    const req = authRequest('/api/providers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        displayName: 'OpenRouter',
        providerType: 'openrouter',
        modelId: 'openai/gpt-4.1',
        baseUrl: 'https://attacker.example/v1',
        apiKeyEnvVar: 'OPENROUTER_API_KEY',
        isLocal: false,
      }),
    })

    const res = await POST(req as never)

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/fixed endpoint|custom baseUrl/i)
    expect(mockDbInsert).not.toHaveBeenCalled()
  })

  it('allows fixed cloud providers to submit their default base URL but stores no custom endpoint', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    const createdProvider = {
      id: 'provider-openrouter',
      displayName: 'OpenRouter',
      providerType: 'openrouter',
      modelId: 'openai/gpt-4.1',
      baseUrl: null,
      apiKeyEnvVar: 'OPENROUTER_API_KEY',
      apiKeyCiphertext: null,
      isLocal: false,
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    }
    const insertChain = chain([createdProvider]) as Record<string, unknown>
    const valuesSpy = vi.fn(() => insertChain)
    insertChain.values = valuesSpy
    mockDbInsert.mockReturnValue(insertChain)

    const { POST } = await import('@/app/api/providers/route')
    const req = authRequest('/api/providers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        displayName: createdProvider.displayName,
        providerType: 'openrouter',
        modelId: createdProvider.modelId,
        baseUrl: 'https://openrouter.ai/api/v1',
        apiKeyEnvVar: 'OPENROUTER_API_KEY',
        isLocal: false,
      }),
    })

    const res = await POST(req as never)

    expect(res.status).toBe(201)
    expect(valuesSpy).toHaveBeenCalledWith(expect.objectContaining({ baseUrl: null }))
    const body = await res.json()
    expect(body.provider).toMatchObject({
      providerType: 'openrouter',
      baseUrl: null,
    })
  })

  it('clears unsafe legacy provider env vars during normal provider edits', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    const existingProvider = {
      id: 'provider-legacy-custom',
      displayName: 'Legacy Custom',
      providerType: 'custom',
      modelId: 'provider/model',
      baseUrl: 'https://models.example.com/v1',
      apiKeyEnvVar: 'SESSION_SECRET',
      apiKeyCiphertext: null,
      isLocal: false,
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    }
    const updatedProvider = {
      ...existingProvider,
      displayName: 'Legacy Custom Edited',
      apiKeyEnvVar: null,
      updatedAt: new Date(),
    }
    mockDbSelect.mockReturnValue(chain([existingProvider]))
    const updateChain = chain([updatedProvider]) as Record<string, unknown>
    const updateSetSpy = vi.fn(() => updateChain)
    updateChain.set = updateSetSpy
    mockDbUpdate.mockReturnValue(updateChain)

    const { PUT } = await import('@/app/api/providers/[id]/route')
    const req = authRequest('/api/providers/provider-legacy-custom', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        displayName: 'Legacy Custom Edited',
      }),
    })

    const res = await PUT(req as never, {
      params: Promise.resolve({ id: 'provider-legacy-custom' }),
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.provider.apiKeyEnvVar).toBeNull()
    expect(updateSetSpy).toHaveBeenCalledWith(expect.objectContaining({ apiKeyEnvVar: null }))
  })

  it('creates an ACP provider with a known agent id, selected model, and no credentials', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    const createdProvider = {
      id: 'provider-acp',
      displayName: 'Claude Agent ACP',
      providerType: 'acp',
      modelId: 'claude-agent::claude-opus',
      baseUrl: null,
      apiKeyEnvVar: null,
      apiKeyCiphertext: null,
      isLocal: true,
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    }
    const insertChain = chain([createdProvider]) as Record<string, unknown>
    const valuesSpy = vi.fn(() => insertChain)
    insertChain.values = valuesSpy
    mockDbInsert.mockReturnValue(insertChain)

    const { POST } = await import('@/app/api/providers/route')
    const req = authRequest('/api/providers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        displayName: createdProvider.displayName,
        providerType: 'acp',
        modelId: 'claude-agent::claude-opus',
        isLocal: false,
      }),
    })

    const res = await POST(req as never)

    expect(res.status).toBe(201)
    expect(valuesSpy).toHaveBeenCalledWith(expect.objectContaining({
      modelId: 'claude-agent::claude-opus',
      baseUrl: null,
      apiKeyEnvVar: null,
      isLocal: true,
    }))
    const body = await res.json()
    expect(body.provider).toMatchObject({
      providerType: 'acp',
      modelId: 'claude-agent::claude-opus',
      baseUrl: null,
      apiKeyEnvVar: null,
      hasApiKey: false,
      isLocal: true,
    })
  })

  it('allows duplicate ACP runtime rows when selected models differ', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    const createdProvider = {
      id: 'provider-acp-gpt5',
      displayName: 'Codex ACP GPT-5',
      providerType: 'acp',
      modelId: 'codex-cli::gpt-5',
      baseUrl: null,
      apiKeyEnvVar: null,
      apiKeyCiphertext: null,
      isLocal: true,
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    }
    mockDbInsert.mockReturnValue(chain([createdProvider]))

    const { POST } = await import('@/app/api/providers/route')
    const res = await POST(authRequest('/api/providers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        displayName: createdProvider.displayName,
        providerType: 'acp',
        modelId: 'codex-cli::gpt-5',
        isLocal: true,
      }),
    }) as never)

    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.provider).toMatchObject({
      providerType: 'acp',
      modelId: 'codex-cli::gpt-5',
    })
  })

  it('rejects ACP providers that include credentials or endpoints', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)

    const { POST } = await import('@/app/api/providers/route')
    const req = authRequest('/api/providers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        displayName: 'Codex ACP',
        providerType: 'acp',
        modelId: 'codex-cli',
        baseUrl: 'http://localhost:9999',
        apiKeyEnvVar: 'OPENAI_API_KEY',
        apiKey: 'secret',
        isLocal: true,
      }),
    })

    const res = await POST(req as never)

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/baseUrl|apiKey/i)
    expect(mockDbInsert).not.toHaveBeenCalled()
  })

  it('deactivates an unassigned provider without confirmation', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    const existingProvider = {
      id: 'provider-unused',
      displayName: 'Unused Provider',
      providerType: 'openrouter',
      modelId: 'openai/gpt-4.1',
      baseUrl: null,
      apiKeyEnvVar: 'OPENROUTER_API_KEY',
      apiKeyCiphertext: null,
      isLocal: false,
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    }
    const updateChain = chain(undefined) as Record<string, unknown>
    const setSpy = vi.fn(() => updateChain)
    updateChain.set = setSpy
    mockDbSelect
      .mockReturnValueOnce(chain([{ id: 'user-abc' }]))
      .mockReturnValueOnce(chain([existingProvider]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([]))
    mockDbUpdate.mockReturnValue(updateChain)

    const { DELETE } = await import('@/app/api/providers/[id]/route')
    const res = await DELETE(nextAuthRequest('/api/providers/provider-unused') as never, {
      params: Promise.resolve({ id: 'provider-unused' }),
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({
      ok: true,
      deactivatedProviderId: 'provider-unused',
      fallbackProvider: null,
      reassigned: { agentConfigs: 0, tasks: 0 },
    })
    expect(setSpy).toHaveBeenCalledWith(expect.objectContaining({ isActive: false }))
  })

  it('returns provider deactivation impact without confirmation when assignments exist', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    const existingProvider = {
      id: 'provider-current',
      displayName: 'Current Provider',
      providerType: 'openrouter',
      modelId: 'openai/gpt-4.1',
      baseUrl: null,
      apiKeyEnvVar: 'OPENROUTER_API_KEY',
      apiKeyCiphertext: null,
      isLocal: false,
      isActive: true,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date(),
    }
    const fallbackProvider = {
      ...existingProvider,
      id: 'provider-fallback',
      displayName: 'Fallback Provider',
      createdAt: new Date('2026-01-02T00:00:00Z'),
    }
    mockDbSelect
      .mockReturnValueOnce(chain([{ id: 'user-abc' }]))
      .mockReturnValueOnce(chain([existingProvider]))
      .mockReturnValueOnce(chain([
        { id: 'agent-backend', agentType: 'backend', displayName: 'Backend' },
      ]))
      .mockReturnValueOnce(chain([
        { id: 'task-pending', title: 'Pending work', status: 'pending' },
      ]))
      .mockReturnValueOnce(chain([fallbackProvider]))

    const { DELETE } = await import('@/app/api/providers/[id]/route')
    const res = await DELETE(nextAuthRequest('/api/providers/provider-current') as never, {
      params: Promise.resolve({ id: 'provider-current' }),
    })

    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.code).toBe('provider_deactivation_requires_confirmation')
    expect(body.confirmationRequired).toBe(true)
    expect(body.impact.hasDefaultProviderFallback).toBe(true)
    expect(body.impact.fallbackProvider).toBeNull()
    expect(body.impact.affectedAssignments.agentConfigs).toEqual([
      { id: 'agent-backend', role: 'backend', displayName: 'Backend' },
    ])
    expect(body.impact.affectedAssignments.tasks).toEqual([
      { id: 'task-pending', title: 'Pending work', status: 'pending' },
    ])
    expect(mockDbUpdate).not.toHaveBeenCalled()
  })

  it('rejects provider deactivation for non-bootstrap users', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    mockDbSelect.mockReturnValueOnce(chain([{ id: 'user-owner' }]))

    const { DELETE } = await import('@/app/api/providers/[id]/route')
    const res = await DELETE(nextAuthRequest('/api/providers/provider-current') as never, {
      params: Promise.resolve({ id: 'provider-current' }),
    })

    expect(res.status).toBe(403)
    expect(mockDbUpdate).not.toHaveBeenCalled()
  })

  it('deactivates a confirmed provider and clears affected agent defaults and task overrides', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    const existingProvider = {
      id: 'provider-current',
      displayName: 'Current Provider',
      providerType: 'openrouter',
      modelId: 'openai/gpt-4.1',
      baseUrl: null,
      apiKeyEnvVar: 'OPENROUTER_API_KEY',
      apiKeyCiphertext: null,
      isLocal: false,
      isActive: true,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date(),
    }
    const fallbackProvider = {
      ...existingProvider,
      id: 'provider-fallback',
      displayName: 'Fallback Provider',
      createdAt: new Date('2026-01-02T00:00:00Z'),
    }
    const updateChain = chain(undefined) as Record<string, unknown>
    const setSpy = vi.fn(() => updateChain)
    updateChain.set = setSpy
    mockDbSelect
      .mockReturnValueOnce(chain([{ id: 'user-abc' }]))
      .mockReturnValueOnce(chain([existingProvider]))
      .mockReturnValueOnce(chain([
        { id: 'agent-backend', agentType: 'backend', displayName: 'Backend' },
      ]))
      .mockReturnValueOnce(chain([
        { id: 'task-approved', title: 'Approved work', status: 'approved' },
      ]))
      .mockReturnValueOnce(chain([fallbackProvider]))
      .mockReturnValueOnce(chain([
        { id: 'agent-backend', agentType: 'backend', displayName: 'Backend' },
      ]))
      .mockReturnValueOnce(chain([
        { id: 'task-approved', title: 'Approved work', status: 'approved' },
      ]))
    mockDbUpdate.mockReturnValue(updateChain)

    const { DELETE } = await import('@/app/api/providers/[id]/route')
    const res = await DELETE(nextAuthRequest('/api/providers/provider-current', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        confirm: true,
        expectedAgentConfigIds: ['agent-backend'],
        expectedTaskIds: ['task-approved'],
      }),
    }) as never, {
      params: Promise.resolve({ id: 'provider-current' }),
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.fallbackProvider).toBeNull()
    expect(body.reassigned).toEqual({ agentConfigs: 1, tasks: 1 })
    expect(setSpy).toHaveBeenCalledWith(expect.objectContaining({ providerConfigId: null }))
    expect(setSpy).toHaveBeenCalledWith(expect.objectContaining({ pmProviderConfigId: null }))
    expect(setSpy).toHaveBeenCalledWith(expect.objectContaining({ isActive: false }))
  })

  it('deactivates and clears agent defaults when confirmed deactivation has no fallback', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    const existingProvider = {
      id: 'provider-current',
      displayName: 'Current Provider',
      providerType: 'openrouter',
      modelId: 'openai/gpt-4.1',
      baseUrl: null,
      apiKeyEnvVar: 'OPENROUTER_API_KEY',
      apiKeyCiphertext: null,
      isLocal: false,
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    }
    mockDbSelect
      .mockReturnValueOnce(chain([{ id: 'user-abc' }]))
      .mockReturnValueOnce(chain([existingProvider]))
      .mockReturnValueOnce(chain([
        { id: 'agent-reviewer', agentType: 'reviewer', displayName: '' },
      ]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([
        { id: 'agent-reviewer', agentType: 'reviewer', displayName: '' },
      ]))
      .mockReturnValueOnce(chain([]))
    const updateChain = chain(undefined) as Record<string, unknown>
    const setSpy = vi.fn(() => updateChain)
    updateChain.set = setSpy
    mockDbUpdate.mockReturnValue(updateChain)

    const { DELETE } = await import('@/app/api/providers/[id]/route')
    const res = await DELETE(nextAuthRequest('/api/providers/provider-current', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        confirm: true,
        expectedAgentConfigIds: ['agent-reviewer'],
        expectedTaskIds: [],
      }),
    }) as never, {
      params: Promise.resolve({ id: 'provider-current' }),
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.setupPrompt).toMatch(/Create or activate another provider/i)
    expect(body.fallbackProvider).toBeNull()
    expect(body.reassigned).toEqual({ agentConfigs: 1, tasks: 0 })
    expect(setSpy).toHaveBeenCalledWith(expect.objectContaining({ providerConfigId: null }))
    expect(setSpy).toHaveBeenCalledWith(expect.objectContaining({ isActive: false }))
  })

  it('requires a fresh impact review when confirmed provider deactivation assignments changed', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    const existingProvider = {
      id: 'provider-current',
      displayName: 'Current Provider',
      providerType: 'openrouter',
      modelId: 'openai/gpt-4.1',
      baseUrl: null,
      apiKeyEnvVar: 'OPENROUTER_API_KEY',
      apiKeyCiphertext: null,
      isLocal: false,
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    }
    mockDbSelect
      .mockReturnValueOnce(chain([{ id: 'user-abc' }]))
      .mockReturnValueOnce(chain([existingProvider]))
      .mockReturnValueOnce(chain([
        { id: 'agent-reviewer', agentType: 'reviewer', displayName: 'Reviewer' },
        { id: 'agent-backend', agentType: 'backend', displayName: 'Backend' },
      ]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([]))

    const { DELETE } = await import('@/app/api/providers/[id]/route')
    const res = await DELETE(nextAuthRequest('/api/providers/provider-current', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        confirm: true,
        expectedAgentConfigIds: ['agent-reviewer'],
        expectedTaskIds: [],
      }),
    }) as never, {
      params: Promise.resolve({ id: 'provider-current' }),
    })

    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.code).toBe('provider_deactivation_requires_confirmation')
    expect(body.impact.affectedAssignments.agentConfigs).toHaveLength(2)
    expect(mockDbUpdate).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Suite 3.7 — Task creation enqueues to Redis: POST /api/tasks calls redis.lpush
// ---------------------------------------------------------------------------

describe('POST /api/tasks — enqueues to Redis', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetSession.mockReset()
    mockDbSelect.mockReset()
    mockDbInsert.mockReset()
    mockDbUpdate.mockReset()
    mockRedisLpush.mockReset()
    mockRedisPublish.mockReset()
  })

  it('calls redis.lpush("forge:tasks", ...) when task is created', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    mockDbSelect.mockReturnValue(chain([{ id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11' }]))

    const createdTask = {
      id: 'task-new',
      projectId: 'proj-uuid-1234-5678-9012-3456789012',
      title: 'My task',
      prompt: 'Do a thing',
      status: 'pending',
      submittedBy: 'user-abc',
      pmProviderConfigId: null,
      githubBranch: null,
      githubPrUrl: null,
      errorMessage: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      completedAt: null,
    }
    mockDbInsert.mockReturnValue(chain([createdTask]))
    mockRedisLpush.mockResolvedValue(1)

    const { POST } = await import('@/app/api/tasks/route')
    const req = authRequest('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
        title: 'My task',
        prompt: 'Do a thing',
      }),
    })

    const res = await POST(req as never)

    expect(res.status).toBe(201)
    expect(mockRedisLpush).toHaveBeenCalledOnce()
    const [queueKey, payload] = mockRedisLpush.mock.calls[0]
    expect(queueKey).toBe('forge:tasks')
    const parsed = JSON.parse(payload as string)
    expect(parsed).toHaveProperty('taskId', 'task-new')
  })

  it('returns 404 and does not enqueue when the project is missing', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    mockDbSelect.mockReturnValue(chain([]))

    const { POST } = await import('@/app/api/tasks/route')
    const req = authRequest('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
        title: 'My task',
        prompt: 'Do a thing',
      }),
    })

    const res = await POST(req as never)

    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error).toMatch(/project not found/i)
    expect(mockDbInsert).not.toHaveBeenCalled()
    expect(mockRedisLpush).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Suite 3.7a — Stopped task retry can requeue with a provider override
// ---------------------------------------------------------------------------

describe('POST /api/tasks/:id/retry', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetSession.mockReset()
    mockDbSelect.mockReset()
    mockDbUpdate.mockReset()
    mockRedisLpush.mockReset()
    mockRedisPublish.mockReset()
  })

  it('returns 409 when the task is not stopped', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    mockDbSelect.mockReturnValue(chain([{
      id: 'task-running',
      status: 'running',
      pmProviderConfigId: null,
    }]))

    const { POST } = await import('@/app/api/tasks/[id]/retry/route')
    const res = await POST(authRequest('/api/tasks/task-running/retry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }) as never, { params: Promise.resolve({ id: 'task-running' }) })

    expect(res.status).toBe(409)
    expect(mockDbUpdate).not.toHaveBeenCalled()
    expect(mockRedisLpush).not.toHaveBeenCalled()
  })

  it('returns 400 when the selected provider is inactive or missing', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    mockDbSelect
      .mockReturnValueOnce(chain([{
        id: 'task-failed',
        status: 'failed',
        pmProviderConfigId: null,
      }]))
      .mockReturnValueOnce(chain([]))

    const { POST } = await import('@/app/api/tasks/[id]/retry/route')
    const res = await POST(authRequest('/api/tasks/task-failed/retry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pmProviderConfigId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11' }),
    }) as never, { params: Promise.resolve({ id: 'task-failed' }) })

    expect(res.status).toBe(400)
    expect(mockDbUpdate).not.toHaveBeenCalled()
    expect(mockRedisLpush).not.toHaveBeenCalled()
  })

  it('sets a stopped task back to pending and requeues it', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    const providerId = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'
    mockDbSelect
      .mockReturnValueOnce(chain([{
        id: 'task-failed',
        status: 'failed',
        pmProviderConfigId: null,
      }]))
      .mockReturnValueOnce(chain([{ id: providerId }]))
      .mockReturnValueOnce(chain([]))
    mockDbUpdate.mockReturnValue(chain([{
      id: 'task-failed',
      status: 'pending',
      pmProviderConfigId: providerId,
      updatedAt: new Date(),
    }]))
    mockRedisLpush.mockResolvedValue(1)

    const { POST } = await import('@/app/api/tasks/[id]/retry/route')
    const res = await POST(authRequest('/api/tasks/task-failed/retry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pmProviderConfigId: providerId }),
    }) as never, { params: Promise.resolve({ id: 'task-failed' }) })

    expect(res.status).toBe(200)
    expect(mockDbUpdate).toHaveBeenCalled()
    expect(mockRedisLpush).toHaveBeenCalledOnce()
    const [queueKey, payload] = mockRedisLpush.mock.calls[0]
    expect(queueKey).toBe('forge:tasks')
    expect(JSON.parse(payload as string)).toMatchObject({ taskId: 'task-failed' })
    expect(mockRedisPublish).toHaveBeenCalledWith(
      'forge:task:task-failed',
      expect.stringContaining('"status":"pending"'),
    )
  })

  it('requeues failed handoff tasks through the approval worker when a package is failed or blocked', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    mockDbSelect
      .mockReturnValueOnce(chain([{
        id: 'task-failed',
        status: 'failed',
        pmProviderConfigId: null,
      }]))
      .mockReturnValueOnce(chain([{ id: 'pkg-1', status: 'failed' }]))
    const update = chain([{
      id: 'task-failed',
      status: 'approved',
      pmProviderConfigId: null,
      updatedAt: new Date(),
    }])
    update.set = vi.fn(() => update)
    mockDbUpdate.mockReturnValue(update)
    mockRedisLpush.mockResolvedValue(1)

    const { POST } = await import('@/app/api/tasks/[id]/retry/route')
    const res = await POST(authRequest('/api/tasks/task-failed/retry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }) as never, { params: Promise.resolve({ id: 'task-failed' }) })

    expect(res.status).toBe(200)
    expect(update.set).toHaveBeenCalledWith(expect.objectContaining({
      status: 'approved',
    }))
    expect(mockRedisLpush).toHaveBeenCalledOnce()
    const [queueKey, payload] = mockRedisLpush.mock.calls[0]
    expect(queueKey).toBe('forge:approvals')
    expect(JSON.parse(payload as string)).toMatchObject({ taskId: 'task-failed', action: 'approve' })
    expect(mockRedisPublish).toHaveBeenCalledWith(
      'forge:task:task-failed',
      expect.stringContaining('"status":"approved"'),
    )
  })

  it('keeps failed replans with stale pending packages on the architect retry path', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    mockDbSelect
      .mockReturnValueOnce(chain([{
        id: 'task-failed-replan',
        status: 'failed',
        pmProviderConfigId: null,
      }]))
      .mockReturnValueOnce(chain([]))
    const update = chain([{
      id: 'task-failed-replan',
      status: 'pending',
      pmProviderConfigId: null,
      updatedAt: new Date(),
    }])
    update.set = vi.fn(() => update)
    mockDbUpdate.mockReturnValue(update)
    mockRedisLpush.mockResolvedValue(1)

    const { POST } = await import('@/app/api/tasks/[id]/retry/route')
    const res = await POST(authRequest('/api/tasks/task-failed-replan/retry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }) as never, { params: Promise.resolve({ id: 'task-failed-replan' }) })

    expect(res.status).toBe(200)
    expect(update.set).toHaveBeenCalledWith(expect.objectContaining({
      status: 'pending',
    }))
    expect(mockRedisLpush).toHaveBeenCalledOnce()
    const [queueKey, payload] = mockRedisLpush.mock.calls[0]
    expect(queueKey).toBe('forge:tasks')
    expect(JSON.parse(payload as string)).toMatchObject({ taskId: 'task-failed-replan' })
  })

  it('preserves the failed task provider when retry is submitted without an override', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    const providerId = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'
    mockDbSelect
      .mockReturnValueOnce(chain([{
        id: 'task-failed',
        status: 'failed',
        pmProviderConfigId: providerId,
      }]))
      .mockReturnValueOnce(chain([{ id: providerId }]))
      .mockReturnValueOnce(chain([]))
    const update = chain([{
      id: 'task-failed',
      status: 'pending',
      pmProviderConfigId: providerId,
      updatedAt: new Date(),
    }])
    update.set = vi.fn(() => update)
    mockDbUpdate.mockReturnValue(update)
    mockRedisLpush.mockResolvedValue(1)

    const { POST } = await import('@/app/api/tasks/[id]/retry/route')
    const res = await POST(authRequest('/api/tasks/task-failed/retry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }) as never, { params: Promise.resolve({ id: 'task-failed' }) })

    expect(res.status).toBe(200)
    expect(update.set).toHaveBeenCalledWith(expect.objectContaining({
      pmProviderConfigId: providerId,
      status: 'pending',
    }))
    expect(mockRedisLpush).toHaveBeenCalledOnce()
  })
})

// ---------------------------------------------------------------------------
// Suite 3.8 — Task listing includes the project name from the joined project
// ---------------------------------------------------------------------------

describe('GET /api/tasks — includes project name', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetSession.mockReset()
    mockDbSelect.mockReset()
    mockDbUpdate.mockReturnValue(chain([]))
  })

  it('returns task rows with projectName', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)

    const listedTask = {
      id: 'task-listed',
      projectId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
      projectName: 'Forge Web',
      title: 'Listed task',
      prompt: 'Do a listed thing',
      status: 'pending',
      submittedBy: 'user-abc',
      pmProviderConfigId: null,
      githubBranch: null,
      githubPrUrl: null,
      errorMessage: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      completedAt: null,
    }

    mockDbSelect
      .mockReturnValueOnce(chain([listedTask]))
      .mockReturnValueOnce(chain([{ total: 1 }]))

    const { GET } = await import('@/app/api/tasks/route')
    const res = await GET(nextAuthRequest('/api/tasks') as never)

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.tasks).toHaveLength(1)
    expect(body.tasks[0]).toMatchObject({
      id: 'task-listed',
      projectId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
      projectName: 'Forge Web',
    })
    expect(body.total).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Suite 3.9 — Sidebar task summary
// ---------------------------------------------------------------------------

describe('GET /api/tasks/summary', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetSession.mockReset()
    mockDbSelect.mockReset()
    mockDbUpdate.mockReturnValue(chain([]))
  })

  it('returns 401 when not authenticated', async () => {
    mockGetSession.mockResolvedValue(null)

    const { GET } = await import('@/app/api/tasks/summary/route')
    const res = await GET(nextAuthRequest('/api/tasks/summary') as never)

    expect(res.status).toBe(401)
    expect(mockDbSelect).not.toHaveBeenCalled()
  })

  it('aggregates task statuses and returns the latest attention tasks', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    mockDbSelect
      .mockReturnValueOnce(chain([
        { status: 'pending', total: 2 },
        { status: 'running', total: 1 },
        { status: 'approved', total: 1 },
        { status: 'awaiting_approval', total: 3 },
        { status: 'awaiting_answers', total: 1 },
        { status: 'failed', total: 1 },
        { status: 'completed', total: 10 },
        { status: 'cancelled', total: 4 },
      ]))
      .mockReturnValueOnce(chain([
        { id: 'task-newest', title: 'Needs approval', status: 'awaiting_approval' },
        { id: 'task-failed', title: 'Investigate failure', status: 'failed' },
      ]))

    const { GET } = await import('@/app/api/tasks/summary/route')
    const res = await GET(nextAuthRequest('/api/tasks/summary') as never)

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({
      active: 4,
      attention: 5,
      byStatus: {
        pending: 2,
        running: 1,
        approved: 1,
        awaiting_approval: 3,
        awaiting_answers: 1,
        failed: 1,
        completed: 10,
        cancelled: 4,
      },
      attentionTasks: [
        { id: 'task-newest', title: 'Needs approval', status: 'awaiting_approval' },
        { id: 'task-failed', title: 'Investigate failure', status: 'failed' },
      ],
    })
    expect(mockDbSelect).toHaveBeenCalledTimes(2)
  })

  it('returns 500 when the summary query fails', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    mockDbSelect
      .mockReturnValueOnce(rejectingChain(new Error('database unavailable')))

    const { GET } = await import('@/app/api/tasks/summary/route')
    const res = await GET(nextAuthRequest('/api/tasks/summary') as never)

    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'Internal server error' })
  })
})

// ---------------------------------------------------------------------------
// Suite 3.10 — Epic 172 disabled ingress covers every mutation family
// ---------------------------------------------------------------------------

describe('Epic 172 disabled mutation ingress', () => {
  type InvokeMutation = () => Promise<Response>

  function closedIngressResponse() {
    return Response.json({
      code: 'epic_172_project_management_ingress_closed',
      error: 'Project management is temporarily disabled while release safety checks are incomplete.',
      reason: 'disabled',
    }, { status: 503 })
  }

  const taskParams = { params: Promise.resolve({ id: 'task-closed' }) }
  const gateParams = { params: Promise.resolve({ id: 'task-closed', gateId: 'gate-closed' }) }
  const mutationFamilies: Array<[string, InvokeMutation]> = [
    ['task create and enqueue', async () => {
      const { POST } = await import('@/app/api/tasks/route')
      return POST(authRequest('/api/tasks', { method: 'POST' }) as never)
    }],
    ['task cancellation', async () => {
      const { DELETE } = await import('@/app/api/tasks/[id]/route')
      return DELETE(authRequest('/api/tasks/task-closed', { method: 'DELETE' }) as never, taskParams)
    }],
    ['task approval', async () => {
      const { POST } = await import('@/app/api/tasks/[id]/approve/route')
      return POST(authRequest('/api/tasks/task-closed/approve', { method: 'POST' }) as never, taskParams)
    }],
    ['task rejection', async () => {
      const { POST } = await import('@/app/api/tasks/[id]/reject/route')
      return POST(authRequest('/api/tasks/task-closed/reject', { method: 'POST' }) as never, taskParams)
    }],
    ['task answers', async () => {
      const { POST } = await import('@/app/api/tasks/[id]/questions/route')
      return POST(authRequest('/api/tasks/task-closed/questions', { method: 'POST' }) as never, taskParams)
    }],
    ['approval-gate decision', async () => {
      const { POST } = await import('@/app/api/tasks/[id]/approval-gates/[gateId]/route')
      return POST(authRequest('/api/tasks/task-closed/approval-gates/gate-closed', { method: 'POST' }) as never, gateParams)
    }],
    ['task replan', async () => {
      const { POST } = await import('@/app/api/tasks/[id]/replan/route')
      return POST(authRequest('/api/tasks/task-closed/replan', { method: 'POST' }) as never, taskParams)
    }],
    ['task retry', async () => {
      const { POST } = await import('@/app/api/tasks/[id]/retry/route')
      return POST(authRequest('/api/tasks/task-closed/retry', { method: 'POST' }) as never, taskParams)
    }],
    ['handoff retry enqueue', async () => {
      const { POST } = await import('@/app/api/tasks/[id]/retry-handoff/route')
      return POST(authRequest('/api/tasks/task-closed/retry-handoff', { method: 'POST' }) as never, taskParams)
    }],
    ['MCP plan review', async () => {
      const { POST } = await import('@/app/api/tasks/[id]/mcp-plan-review/route')
      return POST(authRequest('/api/tasks/task-closed/mcp-plan-review', { method: 'POST' }) as never, taskParams)
    }],
    ['task filesystem grant', async () => {
      const { PUT } = await import('@/app/api/tasks/[id]/filesystem-grants/route')
      return PUT(authRequest('/api/tasks/task-closed/filesystem-grants', { method: 'PUT' }) as never, taskParams)
    }],
    ['provider deactivation and task repointing', async () => {
      const { DELETE } = await import('@/app/api/providers/[id]/route')
      return DELETE(
        authRequest('/api/providers/provider-closed', { method: 'DELETE' }) as never,
        { params: Promise.resolve({ id: 'provider-closed' }) },
      )
    }],
    ['workspace directory creation', async () => {
      const { POST } = await import('@/app/api/filesystem/directories/route')
      return POST(authRequest('/api/filesystem/directories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parentPath: '/never-read', name: 'never-created' }),
      }) as never)
    }],
    ['workspace settings update', async () => {
      const { PUT } = await import('@/app/api/settings/workspace/route')
      return PUT(authRequest('/api/settings/workspace', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceRoot: '/never-read' }),
      }) as never)
    }],
  ]

  it.each(mutationFamilies)('returns 503 with zero mutation side effects for %s', async (_name, invoke) => {
    vi.clearAllMocks()
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    mockGuardEpic172ProjectManagementIngress.mockImplementation(async () => closedIngressResponse())

    const response = await invoke()

    expect(response.status).toBe(503)
    expect(mockGuardEpic172ProjectManagementIngress).toHaveBeenCalledOnce()
    expect(mockDbSelect).not.toHaveBeenCalled()
    expect(mockDbInsert).not.toHaveBeenCalled()
    expect(mockDbUpdate).not.toHaveBeenCalled()
    expect(mockDbDelete).not.toHaveBeenCalled()
    expect(mockDbTransaction).not.toHaveBeenCalled()
    expect(mockRedisLpush).not.toHaveBeenCalled()
    expect(mockRedisPublish).not.toHaveBeenCalled()
    expect(mockRedisSet).not.toHaveBeenCalled()
    expect(mockRedisZadd).not.toHaveBeenCalled()
    expect(mockRedisExpire).not.toHaveBeenCalled()
    expect(mockRedisDel).not.toHaveBeenCalled()
    expect(mockDecideReviewGate).not.toHaveBeenCalled()
    expect(mockExecFile).not.toHaveBeenCalled()
  })

  it('returns 503 before workspace or directory routes can touch the filesystem', async () => {
    vi.clearAllMocks()
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    mockGuardEpic172ProjectManagementIngress.mockImplementation(async () => closedIngressResponse())
    const previousRoot = process.env.FORGE_WORKSPACE_ROOT
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-epic-172-disabled-workspace-'))
    process.env.FORGE_WORKSPACE_ROOT = workspaceRoot
    const directoryPath = path.join(workspaceRoot, 'never-created-directory')
    const replacementRoot = path.join(workspaceRoot, 'never-created-workspace')

    try {
      const [{ POST }, { PUT }] = await Promise.all([
        import('@/app/api/filesystem/directories/route'),
        import('@/app/api/settings/workspace/route'),
      ])
      const directoryResponse = await POST(authRequest('/api/filesystem/directories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parentPath: workspaceRoot, name: path.basename(directoryPath) }),
      }) as never)
      const workspaceResponse = await PUT(authRequest('/api/settings/workspace', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceRoot: replacementRoot }),
      }) as never)

      expect(directoryResponse.status).toBe(503)
      expect(workspaceResponse.status).toBe(503)
      expect(mockGuardEpic172ProjectManagementIngress).toHaveBeenCalledTimes(2)
      await expect(fs.stat(directoryPath)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(fs.stat(replacementRoot)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(fs.stat(path.join(workspaceRoot, 'global-settings.json'))).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await fs.readdir(workspaceRoot)).toEqual([])
      expect(mockDbSelect).not.toHaveBeenCalled()
      expect(mockDbInsert).not.toHaveBeenCalled()
      expect(mockDbUpdate).not.toHaveBeenCalled()
      expect(mockRedisLpush).not.toHaveBeenCalled()
    } finally {
      if (previousRoot === undefined) {
        delete process.env.FORGE_WORKSPACE_ROOT
      } else {
        process.env.FORGE_WORKSPACE_ROOT = previousRoot
      }
      await fs.rm(workspaceRoot, { recursive: true, force: true })
    }
  })
})
