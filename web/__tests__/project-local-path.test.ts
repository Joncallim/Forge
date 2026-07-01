import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  dbSelect: vi.fn(),
  getWorkspaceSettings: vi.fn(),
}))

vi.mock('@/db', () => ({
  db: { select: mocks.dbSelect },
}))

vi.mock('@/lib/workspace', async () => {
  const actual = await vi.importActual<typeof import('@/lib/workspace')>('@/lib/workspace')
  return {
    ...actual,
    getWorkspaceSettings: mocks.getWorkspaceSettings,
  }
})

import type { WorkspaceSettings } from '@/lib/workspace'
import {
  assertProjectLocalPathForExecution,
  assertProjectLocalPathPreflightAllowed,
  assertProjectPathNotProtected,
} from '@/lib/projects/local-path'

function chain(resolveValue: unknown) {
  const t: Record<string, unknown> = {
    then: (ok: (value: unknown) => unknown, err?: (reason: unknown) => unknown) =>
      Promise.resolve(resolveValue).then(ok, err),
  }
  ;['from'].forEach((method) => { t[method] = () => t })
  return t
}

describe('assertProjectLocalPathForExecution', () => {
  let root = ''
  let workspaceRoot = ''
  let projectRoot = ''

  beforeEach(async () => {
    vi.clearAllMocks()
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-local-path-test-'))
    workspaceRoot = path.join(root, 'workspace')
    projectRoot = path.join(workspaceRoot, 'projects', 'app')
    await fs.mkdir(projectRoot, { recursive: true })
    mocks.getWorkspaceSettings.mockResolvedValue({
      workspaceRoot,
      configRoot: path.join(workspaceRoot, 'config'),
      projectsRoot: path.join(workspaceRoot, 'projects'),
      mcpsRoot: path.join(workspaceRoot, 'mcps'),
      templatesRoot: path.join(workspaceRoot, 'templates'),
      localMemoryRoot: path.join(workspaceRoot, 'local-memory'),
      promptsRoot: path.join(workspaceRoot, 'prompts'),
      workforcesRoot: path.join(workspaceRoot, 'workforces'),
      runtimeRoot: path.join(workspaceRoot, 'runtime'),
      logsRoot: path.join(workspaceRoot, 'logs'),
      backupsRoot: path.join(workspaceRoot, 'backups'),
    })
    mocks.dbSelect.mockReturnValue(chain([]))
  })

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  it('returns the real project directory when it is inside the active workspace', async () => {
    const realProjectRoot = await fs.realpath(projectRoot)
    await expect(assertProjectLocalPathForExecution({ id: 'project-1', localPath: projectRoot }))
      .resolves.toBe(realProjectRoot)
  })

  it('rejects symlinks that resolve outside the active workspace', async () => {
    const outsideRoot = path.join(root, 'outside')
    const symlinkPath = path.join(workspaceRoot, 'projects', 'outside-link')
    await fs.mkdir(outsideRoot, { recursive: true })
    await fs.symlink(outsideRoot, symlinkPath)

    await expect(assertProjectLocalPathForExecution({ id: 'project-1', localPath: symlinkPath }))
      .rejects.toThrow(/outside the active Forge workspace/i)
  })

  it('rejects local paths that resolve to a file', async () => {
    const filePath = path.join(workspaceRoot, 'projects', 'file.txt')
    await fs.writeFile(filePath, 'not a directory')

    await expect(assertProjectLocalPathForExecution({ id: 'project-1', localPath: filePath }))
      .rejects.toThrow(/not a directory/i)
  })

  it('rejects paths that overlap another registered project', async () => {
    const nestedRoot = path.join(projectRoot, 'nested')
    await fs.mkdir(nestedRoot)
    mocks.dbSelect.mockReturnValue(chain([{ id: 'project-2', localPath: nestedRoot }]))

    await expect(assertProjectLocalPathForExecution({ id: 'project-1', localPath: projectRoot }))
      .rejects.toThrow(/overlaps another registered Forge project/i)
  })

  it('preflights non-existing paths that would overlap another registered project', async () => {
    const nestedRoot = path.join(projectRoot, 'future-child')
    mocks.dbSelect.mockReturnValue(chain([{ id: 'project-2', localPath: projectRoot }]))

    await expect(assertProjectLocalPathPreflightAllowed({ localPath: nestedRoot, projectId: 'project-1' }))
      .rejects.toThrow(/overlaps another registered Forge project/i)
    await expect(fs.stat(nestedRoot)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects protected Forge workspace directories', async () => {
    const configRoot = path.join(workspaceRoot, 'config')
    await fs.mkdir(configRoot, { recursive: true })

    await expect(assertProjectLocalPathForExecution({ id: 'project-1', localPath: configRoot }))
      .rejects.toThrow(/workspace config directory/i)
  })
})

describe('assertProjectPathNotProtected', () => {
  const workspace = {
    workspaceRoot: '/ws',
    projectsRoot: '/ws/nested/projects',
    configRoot: '/ws/config',
    mcpsRoot: '/ws/mcps',
    templatesRoot: '/ws/templates',
    localMemoryRoot: '/ws/local-memory',
    promptsRoot: '/ws/prompts',
    workforcesRoot: '/ws/workforces',
    runtimeRoot: '/ws/runtime',
    logsRoot: '/ws/logs',
    backupsRoot: '/ws/backups',
  } as unknown as WorkspaceSettings

  it('allows a normal child directory under the projects root', () => {
    expect(() => assertProjectPathNotProtected('/ws/nested/projects/app', workspace)).not.toThrow()
  })

  it('rejects the projects root itself', () => {
    expect(() => assertProjectPathNotProtected('/ws/nested/projects', workspace))
      .toThrow(/projects root itself or an ancestor/i)
  })

  it('rejects an ancestor directory that encloses the projects root', () => {
    expect(() => assertProjectPathNotProtected('/ws/nested', workspace))
      .toThrow(/projects root itself or an ancestor/i)
  })
})
