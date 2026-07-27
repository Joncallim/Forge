import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  assertProjectLocalPathForExecution: vi.fn(),
  dbSelect: vi.fn(),
  getProvider: vi.fn(),
  loadCurrentProjectFilesystemDecision: vi.fn(),
  resolveDefaultProvider: vi.fn(),
}))

vi.mock('@/db', () => ({ db: { select: mocks.dbSelect } }))
vi.mock('@/lib/providers/registry', () => ({ getProvider: mocks.getProvider }))
vi.mock('@/lib/providers/default', () => ({ resolveDefaultProvider: mocks.resolveDefaultProvider }))
vi.mock('@/lib/projects/local-path', () => ({
  assertProjectLocalPathForExecution: mocks.assertProjectLocalPathForExecution,
}))
vi.mock('@/lib/mcps/filesystem-grant-reconciliation', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/mcps/filesystem-grant-reconciliation')>(),
  loadCurrentProjectFilesystemDecision: mocks.loadCurrentProjectFilesystemDecision,
}))

import {
  activateWorkPackageExecutionContext,
  ConfinedMaterializationUnavailableError,
  loadWorkPackageExecutionContext,
  loadWorkPackageExecutionPreflight,
  type WorkPackageExecutionPreflight,
} from '@/worker/work-package-executor'

function expectNoExecutionSideEffects() {
  expect(mocks.dbSelect).not.toHaveBeenCalled()
  expect(mocks.resolveDefaultProvider).not.toHaveBeenCalled()
  expect(mocks.getProvider).not.toHaveBeenCalled()
  expect(mocks.loadCurrentProjectFilesystemDecision).not.toHaveBeenCalled()
  expect(mocks.assertProjectLocalPathForExecution).not.toHaveBeenCalled()
}

describe('work-package execution context boundary', () => {
  it('rejects preflight before database, provider, or filesystem access', async () => {
    await expect(loadWorkPackageExecutionPreflight('task-1', 'pkg-1'))
      .rejects.toBeInstanceOf(ConfinedMaterializationUnavailableError)
    expectNoExecutionSideEffects()
  })

  it('rejects context activation before lifecycle callbacks or path validation', async () => {
    const assertS4LifecycleOwned = vi.fn()
    await expect(activateWorkPackageExecutionContext({} as WorkPackageExecutionPreflight, {
      assertS4LifecycleOwned,
    })).rejects.toBeInstanceOf(ConfinedMaterializationUnavailableError)
    expect(assertS4LifecycleOwned).not.toHaveBeenCalled()
    expectNoExecutionSideEffects()
  })

  it('rejects context loading before preflight, lifecycle, provider, or path access', async () => {
    const beforeProjectPathValidation = vi.fn()
    await expect(loadWorkPackageExecutionContext('task-1', 'pkg-1', {
      beforeProjectPathValidation,
    })).rejects.toBeInstanceOf(ConfinedMaterializationUnavailableError)
    expect(beforeProjectPathValidation).not.toHaveBeenCalled()
    expectNoExecutionSideEffects()
  })
})
