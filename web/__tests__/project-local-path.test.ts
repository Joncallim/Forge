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

import { assertProjectLocalPathForExecution } from '@/lib/projects/local-path'

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
    mocks.getWorkspaceSettings.mockResolvedValue({ workspaceRoot })
    mocks.dbSelect.mockReturnValue(chain([]))
  })

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  it('returns the real project directory when it is inside the active workspace', async () => {
    await expect(assertProjectLocalPathForExecution({ id: 'project-1', localPath: projectRoot }))
      .resolves.toBe(projectRoot)
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
})
