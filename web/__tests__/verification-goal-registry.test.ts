import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  MAX_VERIFICATION_GOAL_FILE_BYTES,
  VERIFICATION_GOAL_REGISTRY_PATH,
  loadVerificationGoalRegistry,
  type LoadedVerificationGoal,
} from '@/lib/verification-goals/registry'
import {
  importVerificationGoalRegistryForTest,
  type ImportVerificationGoalRegistryInput,
} from '@/worker/verification-goals/importer'
import type { VerificationGoalSnapshotStore } from '@/worker/verification-goals/snapshots'

const roots: string[] = []
const projectId = '11111111-1111-4111-8111-111111111111'

async function projectRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'forge-verification-goals-'))
  roots.push(root)
  return root
}

function definition(goalId: string, definitionVersion = 1) {
  return {
    schemaVersion: 1,
    goalId,
    definitionVersion,
    title: `${goalId} remains verifiable`,
    description: 'A declarative reference to a bounded deterministic operation.',
    capability: 'filesystem.project.read',
    severity: 'high',
    enabled: true,
    operations: [{ operationId: 'repository.status.read', operationVersion: 1 }],
  }
}

async function registry(root: string): Promise<string> {
  const directory = path.join(root, ...VERIFICATION_GOAL_REGISTRY_PATH.split('/'))
  await mkdir(directory, { recursive: true })
  return directory
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('verification goal repository registry', () => {
  it('loads direct-child JSON files and sorts canonical results by goal id', async () => {
    const root = await projectRoot()
    const directory = await registry(root)
    await writeFile(path.join(directory, 'zeta.json'), JSON.stringify(definition('zeta-goal')))
    await writeFile(path.join(directory, 'alpha.json'), JSON.stringify(definition('alpha-goal')))

    const loaded = await loadVerificationGoalRegistry(root)
    expect(loaded.map((goal) => goal.definition.goalId)).toEqual(['alpha-goal', 'zeta-goal'])
    expect(loaded.map((goal) => goal.sourcePath)).toEqual([
      '.forge/verification-goals/alpha.json',
      '.forge/verification-goals/zeta.json',
    ])
    expect(loaded.every((goal) => /^[0-9a-f]{64}$/.test(goal.definitionDigest))).toBe(true)
  })

  it('treats a missing registry as an empty declarative registry', async () => {
    await expect(loadVerificationGoalRegistry(await projectRoot())).resolves.toEqual([])
  })

  it('does not disclose a trusted host path when the project cannot be read', async () => {
    const root = path.join(await projectRoot(), 'missing-project')
    await expect(loadVerificationGoalRegistry(root)).rejects.toMatchObject({
      message: expect.not.stringContaining(root),
    })
  })

  it('validates every file before opening the snapshot store', async () => {
    const root = await projectRoot()
    const directory = await registry(root)
    await writeFile(path.join(directory, 'valid.json'), JSON.stringify(definition('valid-goal')))
    await writeFile(path.join(directory, 'invalid.json'), JSON.stringify({
      ...definition('invalid-goal'),
      argv: ['npm', 'test'],
    }))
    const importSnapshots = vi.fn()
    const store: VerificationGoalSnapshotStore = { importSnapshots }

    await expect(importVerificationGoalRegistryForTest({ projectId }, {
      loadProject: async () => ({ id: projectId, localPath: root }),
      canonicalizeProjectRoot: async () => root,
      store,
    }))
      .rejects.toThrow(/exactly the v1 definition keys/i)
    expect(importSnapshots).not.toHaveBeenCalled()
  })

  it('fails closed for unknown projects and projects without a local path', async () => {
    const root = await projectRoot()
    const importSnapshots = vi.fn()
    const canonicalizeProjectRoot = vi.fn(async () => root)
    const store: VerificationGoalSnapshotStore = { importSnapshots }

    await expect(importVerificationGoalRegistryForTest({ projectId }, {
      loadProject: async () => null,
      canonicalizeProjectRoot,
      store,
    })).rejects.toThrow(/could not be resolved/i)
    await expect(importVerificationGoalRegistryForTest({ projectId }, {
      loadProject: async () => ({ id: projectId, localPath: null }),
      canonicalizeProjectRoot,
      store,
    })).rejects.toThrow(/authoritative project localPath/i)
    expect(canonicalizeProjectRoot).not.toHaveBeenCalled()
    expect(importSnapshots).not.toHaveBeenCalled()
  })

  it('cannot use a caller-supplied root in place of the authoritative project root', async () => {
    const authoritativeRoot = await projectRoot()
    const callerRoot = await projectRoot()
    const authoritativeDirectory = await registry(authoritativeRoot)
    const callerDirectory = await registry(callerRoot)
    await writeFile(
      path.join(authoritativeDirectory, 'authoritative.json'),
      JSON.stringify(definition('authoritative-goal')),
    )
    await writeFile(
      path.join(callerDirectory, 'caller.json'),
      JSON.stringify(definition('caller-goal')),
    )
    const importSnapshots = vi.fn(async (
      _projectId: string,
      goals: readonly LoadedVerificationGoal[],
    ) => goals.map((goal) => ({
      snapshotId: '22222222-2222-4222-8222-222222222222',
      goalId: goal.definition.goalId,
      definitionVersion: goal.definition.definitionVersion,
      kind: 'inserted' as const,
    })))
    const inputWithUntrustedExtra: ImportVerificationGoalRegistryInput = {
      projectId,
      // @ts-expect-error Production callers cannot provide or override the root.
      projectRoot: callerRoot,
    }
    const result = await importVerificationGoalRegistryForTest(inputWithUntrustedExtra, {
      loadProject: async () => ({ id: projectId, localPath: authoritativeRoot }),
      canonicalizeProjectRoot: async (project) => project.localPath!,
      store: { importSnapshots },
    })

    expect(result.map((row) => row.goalId)).toEqual(['authoritative-goal'])
    expect(importSnapshots).toHaveBeenCalledWith(
      projectId,
      [expect.objectContaining({
        definition: expect.objectContaining({ goalId: 'authoritative-goal' }),
      })],
    )
  })

  it('rejects duplicate goal ids even when the source files use different versions', async () => {
    const root = await projectRoot()
    const directory = await registry(root)
    await writeFile(path.join(directory, 'one.json'), JSON.stringify(definition('same-goal', 1)))
    await writeFile(path.join(directory, 'two.json'), JSON.stringify(definition('same-goal', 2)))
    await expect(loadVerificationGoalRegistry(root)).rejects.toThrow(/appears more than once/i)
  })

  it('rejects symlinks, nested entries, unsafe names, excessive bytes, depth, and malformed JSON', async () => {
    const cases: Array<(root: string, directory: string) => Promise<void>> = [
      async (root, directory) => {
        const target = path.join(root, '.forge', 'outside.json')
        await writeFile(target, JSON.stringify(definition('linked-goal')))
        await symlink(target, path.join(directory, 'linked.json'))
      },
      async (_root, directory) => { await mkdir(path.join(directory, 'nested')) },
      async (_root, directory) => {
        await writeFile(path.join(directory, '.hidden.json'), JSON.stringify(definition('hidden-goal')))
      },
      async (_root, directory) => {
        await writeFile(path.join(directory, 'large.json'), ' '.repeat(MAX_VERIFICATION_GOAL_FILE_BYTES + 1))
      },
      async (_root, directory) => {
        await writeFile(path.join(directory, 'deep.json'), '{"a":{"b":{"c":{"d":{"e":1}}}}}')
      },
      async (_root, directory) => { await writeFile(path.join(directory, 'broken.json'), '{') },
    ]

    for (const arrange of cases) {
      const root = await projectRoot()
      const directory = await registry(root)
      await arrange(root, directory)
      await expect(loadVerificationGoalRegistry(root)).rejects.toThrow()
    }
  })
})
