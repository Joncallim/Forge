import { describe, expect, it, vi } from 'vitest'

import {
  createRepositoryBranchReadAdapter,
  createRepositoryDiffSummaryAdapter,
  createRepositoryStatusReadAdapter,
} from '@/worker/operations/adapters/repository-read'

describe('fixed repository operation adapters', () => {
  it('constructs fixed argv without a shell or model-controlled path and preserves the trusted root', async () => {
    const runCommand = vi.fn(async () => ({ exitCode: 0, outputSummary: 'bounded output' }))
    const status = createRepositoryStatusReadAdapter({ runCommand })
    const diff = createRepositoryDiffSummaryAdapter({ runCommand })
    const branch = createRepositoryBranchReadAdapter({ runCommand })

    await expect(status({ projectRoot: '/trusted/project' })).resolves.toMatchObject({
      output: { exitCode: 0, summary: 'bounded output' },
    })
    await expect(diff({ projectRoot: '/trusted/project' })).resolves.toMatchObject({
      output: { exitCode: 0, summary: 'bounded output' },
    })
    await expect(branch({ projectRoot: '/trusted/project' })).resolves.toMatchObject({
      output: { exitCode: 0, summary: 'bounded output' },
    })

    expect(runCommand.mock.calls).toEqual([
      [{ cwd: '/trusted/project', command: 'git', argv: ['status', '--short'] }],
      [{ cwd: '/trusted/project', command: 'git', argv: ['diff', '--no-ext-diff', '--no-textconv', '--stat', '--'] }],
      [{ cwd: '/trusted/project', command: 'git', argv: ['branch', '--show-current'] }],
    ])
  })

  it.each(['relative/project', '../outside', 'trusted/project\0outside'])(
    'rejects an unsafe trusted root before invoking the command boundary: %s',
    async (projectRoot) => {
      const runCommand = vi.fn(async () => ({ exitCode: 0, outputSummary: '' }))
      const status = createRepositoryStatusReadAdapter({ runCommand })

      await expect(status({ projectRoot })).rejects.toThrow('absolute filesystem path')
      expect(runCommand).not.toHaveBeenCalled()
    },
  )
})
