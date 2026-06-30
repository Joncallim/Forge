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

vi.mock('@/lib/redis', () => ({
  redis: {
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
vi.mock('@/worker/review-gates', () => ({
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
  const methods = ['from', 'where', 'limit', 'orderBy', 'groupBy', 'values', 'returning', 'set', 'offset', 'innerJoin', 'onConflictDoUpdate', 'onConflictDoNothing']
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
  const methods = ['from', 'where', 'limit', 'orderBy', 'groupBy', 'values', 'returning', 'set', 'offset', 'innerJoin', 'onConflictDoUpdate', 'onConflictDoNothing']
  methods.forEach((m) => { thenable[m] = () => thenable })
  return thenable
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
  beforeEach(() => { vi.clearAllMocks() })

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
  beforeEach(() => { vi.clearAllMocks() })

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
      expect(body.error).toMatch(/workspace root/i)
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

  it('uses an allowlisted clone request githubTokenEnvVar and encodes the token in the clone URL', async () => {
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
      fs.mkdir(args[4], { recursive: true }).then(
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
      expect(mockExecFile).toHaveBeenCalledWith(
        'git',
        expect.arrayContaining([
          `https://x-access-token:${encodeURIComponent(token)}@github.com/owner/private-repo.git`,
          expectedLocalPath,
        ]),
        expect.any(Object),
        expect.any(Function),
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
      expect(body.error).toMatch(/workspace root/i)
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
})

describe('DELETE /api/projects/:id — file deletion boundary', () => {
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

  it('refuses to remove the shared workspace root', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    const previousRoot = process.env.FORGE_WORKSPACE_ROOT
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-delete-root-'))
    process.env.FORGE_WORKSPACE_ROOT = workspaceRoot
    mockDbSelect.mockReturnValue(chain([projectRow(workspaceRoot)]))

    try {
      const { DELETE } = await import('@/app/api/projects/[id]/route')
      const res = await DELETE(nextAuthRequest('/api/projects/project-delete?deleteFiles=true') as never, {
        params: Promise.resolve({ id: 'project-delete' }),
      })

      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toMatch(/shared Forge workspace directory/i)
      expect(mockDbDelete).not.toHaveBeenCalled()
      await expect(fs.stat(workspaceRoot)).resolves.toMatchObject({})
    } finally {
      if (previousRoot === undefined) {
        delete process.env.FORGE_WORKSPACE_ROOT
      } else {
        process.env.FORGE_WORKSPACE_ROOT = previousRoot
      }
      await fs.rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('removes a Forge-owned project directory with a matching marker', async () => {
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
    mockDbDelete.mockReturnValue(chain(undefined))

    try {
      const { DELETE } = await import('@/app/api/projects/[id]/route')
      const res = await DELETE(nextAuthRequest('/api/projects/project-delete?deleteFiles=true') as never, {
        params: Promise.resolve({ id: 'project-delete' }),
      })

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.filesDeleted).toBe(true)
      await expect(fs.stat(localPath)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      if (previousRoot === undefined) {
        delete process.env.FORGE_WORKSPACE_ROOT
      } else {
        process.env.FORGE_WORKSPACE_ROOT = previousRoot
      }
      await fs.rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('removes only the DB record when deleteFiles targets an external local path', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    const previousRoot = process.env.FORGE_WORKSPACE_ROOT
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-delete-external-workspace-'))
    const externalRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-delete-external-project-'))
    const externalFile = path.join(externalRoot, 'keep.txt')
    await fs.writeFile(externalFile, 'do not delete\n')
    process.env.FORGE_WORKSPACE_ROOT = workspaceRoot
    mockDbSelect.mockReturnValue(chain([projectRow(externalRoot)]))
    mockDbDelete.mockReturnValue(chain(undefined))

    try {
      const { DELETE } = await import('@/app/api/projects/[id]/route')
      const res = await DELETE(nextAuthRequest('/api/projects/project-delete?deleteFiles=true') as never, {
        params: Promise.resolve({ id: 'project-delete' }),
      })

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.filesDeleted).toBe(false)
      expect(body.fileDeletionSkippedReason).toBe('outside_forge_managed_projects')
      expect(body.fileDeletionMessage).toMatch(/outside Forge-managed projects/i)
      expect(body.localPath).toBe(externalRoot)
      expect(body.displayLocalPath).toBe(externalRoot)
      expect(mockDbDelete).toHaveBeenCalled()
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

  it('defaults to the active workspace projects directory', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    const previousRoot = process.env.FORGE_WORKSPACE_ROOT
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-workspace-test-'))
    process.env.FORGE_WORKSPACE_ROOT = workspaceRoot

    try {
      const { GET } = await import('@/app/api/filesystem/directories/route')
      const res = await GET(nextAuthRequest('/api/filesystem/directories') as never)

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.path).toBe(path.join(workspaceRoot, 'projects'))
      await expect(fs.stat(path.join(workspaceRoot, 'mcps'))).resolves.toMatchObject({})
      await expect(fs.stat(path.join(workspaceRoot, 'templates'))).resolves.toMatchObject({})
      await expect(fs.stat(path.join(workspaceRoot, 'global-settings.json'))).resolves.toMatchObject({})
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
        installState: 'installed',
        status: 'healthy',
      })
      expect(statuses.find((status) => status.mcpId === 'github')).toMatchObject({
        installState: 'installed',
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
})

// ---------------------------------------------------------------------------
// Suite 3.4 — Task status guard: DELETE /api/tasks/:id returns 409 when status is 'running'
// ---------------------------------------------------------------------------

describe('DELETE /api/tasks/:id — 409 when status is running', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('returns 409 when task status is running', async () => {
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

    const { DELETE } = await import('@/app/api/tasks/[id]/route')
    const req = authRequest('/api/tasks/task-1', { method: 'DELETE' })
    const params = Promise.resolve({ id: 'task-1' })

    const res = await DELETE(req as never, { params })

    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error).toMatch(/running/i)
  })
})

// ---------------------------------------------------------------------------
// Suite 3.4 — Task status guard: POST /api/tasks/:id/approve returns 409 when status is 'pending'
// ---------------------------------------------------------------------------

describe('POST /api/tasks/:id/approve — 409 when status is pending', () => {
  beforeEach(() => { vi.clearAllMocks() })

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

  it('approves the plan gate and queues the approval worker job', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    const awaitingTask = {
      id: 'task-approval',
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
    mockDbSelect.mockReturnValue(chain([awaitingTask]))
    mockDbUpdate
      .mockReturnValueOnce(taskUpdate)
      .mockReturnValueOnce(gateUpdate)
    mockRedisLpush.mockResolvedValue(1)
    mockRedisPublish.mockResolvedValue(1)

    const { POST } = await import('@/app/api/tasks/[id]/approve/route')
    const res = await POST(authRequest('/api/tasks/task-approval/approve', { method: 'POST' }) as never, {
      params: Promise.resolve({ id: 'task-approval' }),
    })

    expect(res.status).toBe(200)
    expect(mockDbUpdate).toHaveBeenCalledTimes(2)
    expect(gateUpdate.set).toHaveBeenCalledWith(expect.objectContaining({
      decidedBy: FAKE_SESSION.userId,
      status: 'approved',
    }))
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

  it('keeps approval intact when the approval worker job enqueue result is uncertain', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    const awaitingTask = {
      id: 'task-approval',
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
    mockDbSelect.mockReturnValue(chain([awaitingTask]))
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
    mockDbSelect.mockReturnValue(chain([awaitingTask]))
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
    mockDbSelect.mockReturnValueOnce(chain([{ status: 'running' }]))

    const { POST } = await import('@/app/api/tasks/[id]/retry-handoff/route')
    const res = await POST(authRequest('/api/tasks/task-1/retry-handoff', { method: 'POST' }) as never, {
      params: Promise.resolve({ id: 'task-1' }),
    })

    expect(res.status).toBe(409)
    expect(mockRedisLpush).not.toHaveBeenCalled()
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
      sourceArtifactId: '11111111-1111-1111-1111-111111111111',
      taskId: 'task-1',
      userId: FAKE_SESSION.userId,
    })
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
// Suite 3.4d — Open questions: POST /api/tasks/:id/questions
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
  beforeEach(() => { vi.clearAllMocks() })

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
  beforeEach(() => { vi.clearAllMocks() })

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
  beforeEach(() => { vi.clearAllMocks() })

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
  beforeEach(() => { vi.clearAllMocks() })

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
  beforeEach(() => { vi.clearAllMocks() })

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
    mockDbSelect.mockReturnValueOnce(rejectingChain(new Error('database unavailable')))

    const { GET } = await import('@/app/api/tasks/summary/route')
    const res = await GET(nextAuthRequest('/api/tasks/summary') as never)

    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'Internal server error' })
  })
})
