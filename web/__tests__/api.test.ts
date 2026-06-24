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
import { vi, describe, it, expect, beforeEach } from 'vitest'

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

vi.mock('@/db', () => ({
  db: {
    select: mockDbSelect,
    insert: mockDbInsert,
    update: mockDbUpdate,
  },
}))

// Redis mock
const mockRedisLpush = vi.fn()
const mockRedisZadd = vi.fn()
const mockRedisExpire = vi.fn()
const mockRedisPublish = vi.fn()

vi.mock('@/lib/redis', () => ({
  redis: {
    lpush: mockRedisLpush,
    zadd: mockRedisZadd,
    expire: mockRedisExpire,
    publish: mockRedisPublish,
  },
}))

// Provider registry mock
vi.mock('@/lib/providers/registry', () => ({
  listActiveProviders: vi.fn().mockResolvedValue([]),
  getProvider: vi.fn().mockResolvedValue(null),
  getModel: vi.fn().mockResolvedValue(null),
}))

const mockGetGitHubStatus = vi.fn()
const mockResolveGitHubToken = vi.fn()
vi.mock('@/lib/github', () => ({
  getGitHubStatus: mockGetGitHubStatus,
  resolveGitHubToken: mockResolveGitHubToken,
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
  const methods = ['from', 'where', 'limit', 'orderBy', 'values', 'returning', 'set', 'offset', 'innerJoin', 'onConflictDoUpdate']
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

// ---------------------------------------------------------------------------
// Suite 3.1c — Folder browser lists local directories for authenticated users
// ---------------------------------------------------------------------------

describe('GET /api/filesystem/directories — folder selector', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('returns the requested directory listing', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)

    const { GET } = await import('@/app/api/filesystem/directories/route')
    const res = await GET(nextAuthRequest('/api/filesystem/directories?path=/tmp') as never)

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.path).toBe('/tmp')
    expect(Array.isArray(body.directories)).toBe(true)
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
    const parentPath = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-folder-test-'))

    try {
      const { POST } = await import('@/app/api/filesystem/directories/route')
      const res = await POST(nextAuthRequest('/api/filesystem/directories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parentPath, name: 'new-app' }),
      }) as never)

      expect(res.status).toBe(201)
      const body = await res.json()
      const createdPath = path.join(parentPath, 'new-app')
      expect(body.path).toBe(createdPath)
      const stat = await fs.stat(createdPath)
      expect(stat.isDirectory()).toBe(true)
    } finally {
      await fs.rm(parentPath, { recursive: true, force: true })
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
        projectsRoot: string
        mcpsRoot: string
        templatesRoot: string
        localMemoryRoot: string
        checkpointsRoot: string
      }
      expect(globalSettings.projectsRoot).toMatch(/\/projects$/)
      expect(globalSettings.mcpsRoot).toMatch(/\/mcps$/)
      expect(globalSettings.templatesRoot).toMatch(/\/templates$/)
      expect(globalSettings.localMemoryRoot).toMatch(/\/local-memory$/)
      expect(globalSettings.checkpointsRoot).toMatch(/\/local-memory\/checkpoints$/)
      await expect(fs.stat(path.join(workspaceRoot, 'local-memory', 'checkpoints'))).resolves.toMatchObject({})
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
      expect(body.overview.catalog.map((entry: { id: string }) => entry.id)).toEqual(['filesystem', 'github'])
      expect(body.overview.summary.missing).toBe(2)
      expect(body.overview.statuses.map((status: { installState: string }) => status.installState)).toEqual([
        'missing',
        'missing',
      ])
    })
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
// Suite 3.3 — Task status guard: DELETE /api/tasks/:id returns 409 when status is 'running'
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

  it('adds LM Studio models discovered from the local OpenAI-compatible endpoint', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    mockDbSelect.mockReturnValue(chain([]))
    mockDbInsert.mockReturnValue(chain(undefined))
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === 'http://localhost:11434/api/tags') {
        return new Response(JSON.stringify({ models: [] }), { status: 200 })
      }
      if (url === 'http://localhost:1234/v1/models') {
        return new Response(JSON.stringify({ data: [{ id: 'gemma-local' }] }), { status: 200 })
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
        found: 1,
        added: [{ providerType: 'lmstudio', modelId: 'gemma-local' }],
        ollamaReachable: false,
        lmstudioReachable: true,
      })
      expect(mockDbInsert).toHaveBeenCalledOnce()
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
// The route handler validates agent types against a strict allowlist
// (VALID_AGENT_TYPES). A path segment like "../../etc/passwd" is URL-decoded
// before being passed as `type`, then rejected because it is not allowlisted.
// This test documents the path traversal regression guard.
// ---------------------------------------------------------------------------

describe('PUT /api/agents/[type] — path traversal blocked', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('returns 400 for a non-allowlisted agent type (path traversal attempt)', async () => {
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
      apiKeyEnvVar: 'CUSTOM_API_KEY',
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
        apiKeyEnvVar: createdProvider.apiKeyEnvVar,
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

  it('creates an ACP provider with a known agent id and no credentials', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION)
    const createdProvider = {
      id: 'provider-acp',
      displayName: 'Claude Agent ACP',
      providerType: 'acp',
      modelId: 'claude-agent',
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
    const req = authRequest('/api/providers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        displayName: createdProvider.displayName,
        providerType: 'acp',
        modelId: 'claude-agent',
        isLocal: false,
      }),
    })

    const res = await POST(req as never)

    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.provider).toMatchObject({
      providerType: 'acp',
      modelId: 'claude-agent',
      baseUrl: null,
      apiKeyEnvVar: null,
      hasApiKey: false,
      isLocal: true,
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
