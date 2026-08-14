import { mkdtemp, mkdir, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { OPERATION_CATALOG } from '@/lib/operations/catalog'
import type { ProjectExecutionRootBinding } from '@/lib/projects/local-path'
import {
  MAX_VERIFICATION_GOAL_FILE_BYTES,
  VERIFICATION_GOAL_REGISTRY_PATH,
  loadVerificationGoalRegistry,
  loadVerificationGoalRegistryForTest,
  type LoadedVerificationGoal,
} from '@/lib/verification-goals/registry'
import {
  importVerificationGoalRegistryForTest,
  type ImportVerificationGoalRegistryInput,
  VerificationGoalImportError,
} from '@/worker/verification-goals/importer'
import type { VerificationGoalSnapshotStore } from '@/worker/verification-goals/snapshots'

const roots: string[] = []
const projectId = '11111111-1111-4111-8111-111111111111'

async function projectRoot(): Promise<string> {
  const created = await mkdtemp(path.join(tmpdir(), 'forge-verification-goals-'))
  const root = await realpath(created)
  roots.push(root)
  return root
}

async function projectBinding(root: string): Promise<ProjectExecutionRootBinding> {
  const identity = await stat(root, { bigint: true })
  return { path: root, dev: identity.dev, ino: identity.ino }
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

    const loaded = await loadVerificationGoalRegistry(await projectBinding(root))
    expect(loaded.map((goal) => goal.definition.goalId)).toEqual(['alpha-goal', 'zeta-goal'])
    expect(loaded.map((goal) => goal.sourcePath)).toEqual([
      '.forge/verification-goals/alpha.json',
      '.forge/verification-goals/zeta.json',
    ])
    expect(loaded.every((goal) => /^[0-9a-f]{64}$/.test(goal.definitionDigest))).toBe(true)
  })

  it('treats a missing registry as an empty declarative registry', async () => {
    const root = await projectRoot()
    await expect(loadVerificationGoalRegistry(await projectBinding(root))).resolves.toEqual([])
  })

  it('does not disclose a trusted host path when the project cannot be read', async () => {
    const root = path.join(await projectRoot(), 'missing-project')
    await expect(loadVerificationGoalRegistry({
      path: root,
      dev: BigInt(0),
      ino: BigInt(0),
    })).rejects.toMatchObject({
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
      bindProjectRoot: async () => projectBinding(root),
      store,
    }))
      .rejects.toThrow(/exactly the v1 definition keys/i)
    expect(importSnapshots).not.toHaveBeenCalled()
  })

  it('fails before storage when the anchored registry is moved outside and its path symlinks to that inode', async () => {
    const root = await projectRoot()
    const outsideRoot = await projectRoot()
    const directory = await registry(root)
    const movedDirectory = path.join(outsideRoot, 'moved-registry')
    await writeFile(path.join(directory, 'trusted.json'), JSON.stringify(definition('trusted-goal')))
    const importSnapshots = vi.fn()

    const importWithAdversarialReplacement = async () => {
      const goals = await loadVerificationGoalRegistryForTest(await projectBinding(root), OPERATION_CATALOG, {
        afterRegistryDirectoryAnchored: async () => {
          await rename(directory, movedDirectory)
          await symlink(movedDirectory, directory, 'dir')
        },
      })
      return importSnapshots(projectId, goals)
    }

    await expect(importWithAdversarialReplacement()).rejects.toThrow(/moved or was replaced|unsafe/i)
    expect(importSnapshots).not.toHaveBeenCalled()
  })

  it('fails closed for unknown projects and projects without a local path', async () => {
    const root = await projectRoot()
    const importSnapshots = vi.fn()
    const bindProjectRoot = vi.fn(async () => projectBinding(root))
    const store: VerificationGoalSnapshotStore = { importSnapshots }

    await expect(importVerificationGoalRegistryForTest({ projectId }, {
      loadProject: async () => null,
      bindProjectRoot,
      store,
    })).rejects.toMatchObject({
      name: 'VerificationGoalImportError',
      code: 'project_context_unavailable',
    })
    await expect(importVerificationGoalRegistryForTest({ projectId }, {
      loadProject: async () => ({ id: projectId, localPath: null }),
      bindProjectRoot,
      store,
    })).rejects.toMatchObject({
      name: 'VerificationGoalImportError',
      code: 'project_repository_unavailable',
    })
    expect(bindProjectRoot).not.toHaveBeenCalled()
    expect(importSnapshots).not.toHaveBeenCalled()
  })

  it('canonicalizes an uppercase project id before project resolution and storage', async () => {
    const root = await projectRoot()
    const uppercaseProjectId = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA'
    const canonicalProjectId = uppercaseProjectId.toLowerCase()
    const loadProject = vi.fn(async () => ({ id: canonicalProjectId, localPath: root }))
    const bindProjectRoot = vi.fn(async () => projectBinding(root))
    const importSnapshots = vi.fn(async () => [])

    await expect(importVerificationGoalRegistryForTest({ projectId: uppercaseProjectId }, {
      loadProject,
      bindProjectRoot,
      store: { importSnapshots },
    })).resolves.toEqual([])

    expect(loadProject).toHaveBeenCalledWith(canonicalProjectId)
    expect(bindProjectRoot).toHaveBeenCalledWith({ id: canonicalProjectId, localPath: root })
    expect(importSnapshots).toHaveBeenCalledWith(canonicalProjectId, [])
  })

  it('uses typed errors for invalid or mismatched project identity', async () => {
    const root = await projectRoot()
    const loadProject = vi.fn(async () => ({
      id: '22222222-2222-4222-8222-222222222222',
      localPath: root,
    }))
    const bindProjectRoot = vi.fn(async () => projectBinding(root))
    const store: VerificationGoalSnapshotStore = { importSnapshots: vi.fn() }

    await expect(importVerificationGoalRegistryForTest({ projectId: 'not-a-uuid' }, {
      loadProject,
      bindProjectRoot,
      store,
    })).rejects.toMatchObject({
      name: 'VerificationGoalImportError',
      code: 'invalid_project_id',
    })
    expect(loadProject).not.toHaveBeenCalled()

    await expect(importVerificationGoalRegistryForTest({ projectId }, {
      loadProject,
      bindProjectRoot,
      store,
    })).rejects.toMatchObject({
      name: 'VerificationGoalImportError',
      code: 'project_context_unavailable',
    })
    expect(bindProjectRoot).not.toHaveBeenCalled()
  })

  it('wraps project-root binding failures without retaining filesystem details', async () => {
    const root = await projectRoot()
    const importSnapshots = vi.fn()
    let failure: unknown

    try {
      await importVerificationGoalRegistryForTest({ projectId }, {
        loadProject: async () => ({ id: projectId, localPath: root }),
        bindProjectRoot: async () => {
          throw new Error('Unsafe path /private/secret-project and parser text TOP SECRET')
        },
        store: { importSnapshots },
      })
    } catch (error) {
      failure = error
    }

    expect(failure).toBeInstanceOf(VerificationGoalImportError)
    expect(failure).toMatchObject({ code: 'project_repository_unavailable' })
    expect(failure).not.toHaveProperty('cause')
    expect((failure as Error).message).not.toContain('/private/secret-project')
    expect((failure as Error).message).not.toContain('TOP SECRET')
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
      bindProjectRoot: async (project) => projectBinding(project.localPath!),
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

  it('fails before storage when the validated project root is rebound to an outside symlink', async () => {
    const root = await projectRoot()
    const outsideRoot = await projectRoot()
    const movedProject = path.join(outsideRoot, 'moved-project')
    const directory = await registry(root)
    await writeFile(path.join(directory, 'trusted.json'), JSON.stringify(definition('trusted-goal')))
    const importSnapshots = vi.fn()

    await expect(importVerificationGoalRegistryForTest({ projectId }, {
      loadProject: async () => ({ id: projectId, localPath: root }),
      bindProjectRoot: async () => {
        const validatedRoot = await projectBinding(await realpath(root))
        await rename(root, movedProject)
        await symlink(movedProject, root, 'dir')
        return validatedRoot
      },
      store: { importSnapshots },
    })).rejects.toThrow(/symlink|safely|fixed location/i)
    expect(importSnapshots).not.toHaveBeenCalled()
  })

  it('fails before storage when the bound project root is replaced by another real directory', async () => {
    const root = await projectRoot()
    const outsideRoot = await projectRoot()
    const replacementRoot = await projectRoot()
    const movedProject = path.join(outsideRoot, 'moved-project')
    const replacementDirectory = await registry(replacementRoot)
    await writeFile(
      path.join(replacementDirectory, 'outside.json'),
      JSON.stringify(definition('outside-goal')),
    )
    const importSnapshots = vi.fn()

    await expect(importVerificationGoalRegistryForTest({ projectId }, {
      loadProject: async () => ({ id: projectId, localPath: root }),
      bindProjectRoot: async () => {
        const binding = await projectBinding(root)
        await rename(root, movedProject)
        await rename(replacementRoot, root)
        return binding
      },
      store: { importSnapshots },
    })).rejects.toThrow(/changed|replaced|safely/i)
    expect(importSnapshots).not.toHaveBeenCalled()
  })

  it('fails before storage when an invalid file is added after registry enumeration', async () => {
    const root = await projectRoot()
    const directory = await registry(root)
    await writeFile(path.join(directory, 'current.json'), JSON.stringify(definition('current-goal')))
    const importSnapshots = vi.fn()

    await expect(importVerificationGoalRegistryForTest({ projectId }, {
      loadProject: async () => ({ id: projectId, localPath: root }),
      bindProjectRoot: async () => projectBinding(root),
      loadRegistry: (projectRoot) => loadVerificationGoalRegistryForTest(projectRoot, OPERATION_CATALOG, {
        afterAnchoredEnumeration: async () => {
          await writeFile(path.join(directory, 'unexpected.txt'), 'not a goal')
        },
      }),
      store: { importSnapshots },
    })).rejects.toThrow(/unsafe|membership|changed/i)
    expect(importSnapshots).not.toHaveBeenCalled()
  })

  it('fails before storage when a rename adds a duplicate goal after enumeration', async () => {
    const root = await projectRoot()
    const directory = await registry(root)
    const duplicateCandidate = path.join(root, '.forge', 'duplicate-candidate.json')
    await writeFile(path.join(directory, 'current.json'), JSON.stringify(definition('same-goal')))
    await writeFile(duplicateCandidate, JSON.stringify(definition('same-goal')))
    const importSnapshots = vi.fn()

    await expect(importVerificationGoalRegistryForTest({ projectId }, {
      loadProject: async () => ({ id: projectId, localPath: root }),
      bindProjectRoot: async () => projectBinding(root),
      loadRegistry: (projectRoot) => loadVerificationGoalRegistryForTest(projectRoot, OPERATION_CATALOG, {
        afterAnchoredEnumeration: async () => {
          await rename(duplicateCandidate, path.join(directory, 'duplicate.json'))
        },
      }),
      store: { importSnapshots },
    })).rejects.toThrow(/unsafe|membership|changed/i)
    expect(importSnapshots).not.toHaveBeenCalled()
  })

  it('fails before storage when an already-read file is removed and replaced', async () => {
    const root = await projectRoot()
    const directory = await registry(root)
    const readPath = path.join(directory, 'a-read.json')
    const movedReadPath = path.join(root, '.forge', 'original-read.json')
    const replacementPath = path.join(root, '.forge', 'replacement.json')
    await writeFile(readPath, JSON.stringify(definition('original-goal')))
    await writeFile(replacementPath, JSON.stringify(definition('replacement-goal')))
    const importSnapshots = vi.fn()

    await expect(importVerificationGoalRegistryForTest({ projectId }, {
      loadProject: async () => ({ id: projectId, localPath: root }),
      bindProjectRoot: async () => projectBinding(root),
      loadRegistry: (projectRoot) => loadVerificationGoalRegistryForTest(projectRoot, OPERATION_CATALOG, {
        afterFirstAnchoredEntryRead: async () => {
          await rename(readPath, movedReadPath)
          await rename(replacementPath, readPath)
        },
      }),
      store: { importSnapshots },
    })).rejects.toThrow(/unsafe|membership|changed/i)
    expect(importSnapshots).not.toHaveBeenCalled()
  })

  it('rejects duplicate goal ids even when the source files use different versions', async () => {
    const root = await projectRoot()
    const directory = await registry(root)
    await writeFile(path.join(directory, 'one.json'), JSON.stringify(definition('same-goal', 1)))
    await writeFile(path.join(directory, 'two.json'), JSON.stringify(definition('same-goal', 2)))
    await expect(loadVerificationGoalRegistry(await projectBinding(root))).rejects.toThrow(/appears more than once/i)
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
      await expect(loadVerificationGoalRegistry(await projectBinding(root))).rejects.toThrow()
    }
  })
})
