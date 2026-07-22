import { describe, expect, it } from 'vitest'
import {
  computeReadyWorkPackageIds,
  isWorkPackageExecutionEnabled,
  isWorkPackageHandoffEnabled,
} from '@/worker/work-package-handoff'

const packageBase = {
  assignedRole: 'backend',
  harnessId: null,
  sequence: 1,
  status: 'pending',
  title: 'Backend package',
}

describe('computeReadyWorkPackageIds', () => {
  it('marks dependency-free pending packages ready', () => {
    expect(computeReadyWorkPackageIds([
      { ...packageBase, id: 'pkg-1' },
      { ...packageBase, id: 'pkg-2', assignedRole: 'qa', sequence: 2 },
    ], [])).toEqual(['pkg-1', 'pkg-2'])
  })

  it('waits for dependencies to complete before marking dependent packages ready', () => {
    const packages = [
      { ...packageBase, id: 'backend', status: 'completed' },
      { ...packageBase, id: 'qa', assignedRole: 'qa', sequence: 2 },
      { ...packageBase, id: 'reviewer', assignedRole: 'reviewer', sequence: 3 },
    ]
    const dependencies = [
      { workPackageId: 'qa', dependsOnWorkPackageId: 'backend' },
      { workPackageId: 'reviewer', dependsOnWorkPackageId: 'qa' },
    ]

    expect(computeReadyWorkPackageIds(packages, dependencies)).toEqual(['qa'])
  })

  it('does not re-ready packages that are already active or complete', () => {
    expect(computeReadyWorkPackageIds([
      { ...packageBase, id: 'pending' },
      { ...packageBase, id: 'ready', sequence: 2, status: 'ready' },
      { ...packageBase, id: 'running', sequence: 3, status: 'running' },
      { ...packageBase, id: 'completed', sequence: 4, status: 'completed' },
      { ...packageBase, id: 'needs-rework', sequence: 5, status: 'needs_rework' },
      { ...packageBase, id: 'blocked', sequence: 6, status: 'blocked' },
    ], [])).toEqual(['pending', 'needs-rework', 'blocked'])
  })

  it('never promotes a package carrying a packet recovery or malformed packet marker', () => {
    expect(computeReadyWorkPackageIds([
      { ...packageBase, id: 'plain' },
      { ...packageBase, id: 'recovering', status: 'blocked', metadata: { packet_issuance: { schemaVersion: 2 } } },
      { ...packageBase, id: 'integrity', status: 'blocked', metadata: { packet_integrity_hold: { schemaVersion: 2 } } },
      { ...packageBase, id: 'local', status: 'blocked', metadata: { local_effect_recovery: { schemaVersion: 1 } } },
    ], [])).toEqual(['plain'])
  })
})

describe('isWorkPackageHandoffEnabled', () => {
  it('defaults on and supports explicit disable values', () => {
    expect(isWorkPackageHandoffEnabled({})).toBe(true)
    expect(isWorkPackageHandoffEnabled({ FORGE_WORK_PACKAGE_HANDOFF: '1' })).toBe(true)
    expect(isWorkPackageHandoffEnabled({ FORGE_WORK_PACKAGE_HANDOFF: '0' })).toBe(false)
    expect(isWorkPackageHandoffEnabled({ FORGE_WORK_PACKAGE_HANDOFF: 'false' })).toBe(false)
  })
})

describe('isWorkPackageExecutionEnabled', () => {
  it('requires an explicit recognized opt-in and fails closed otherwise', () => {
    expect(isWorkPackageExecutionEnabled({})).toBe(false)
    expect(isWorkPackageExecutionEnabled({ FORGE_WORK_PACKAGE_EXECUTION: '1' })).toBe(true)
    expect(isWorkPackageExecutionEnabled({ FORGE_WORK_PACKAGE_EXECUTION: 'true' })).toBe(true)
    expect(isWorkPackageExecutionEnabled({ FORGE_WORK_PACKAGE_EXECUTION: '0' })).toBe(false)
    expect(isWorkPackageExecutionEnabled({ FORGE_WORK_PACKAGE_EXECUTION: 'false' })).toBe(false)
    expect(isWorkPackageExecutionEnabled({ FORGE_WORK_PACKAGE_EXECUTION: 'off' })).toBe(false)
    expect(isWorkPackageExecutionEnabled({ FORGE_WORK_PACKAGE_EXECUTION: 'no' })).toBe(false)
    expect(isWorkPackageExecutionEnabled({ FORGE_WORK_PACKAGE_EXECUTION: 'disabled' })).toBe(false)
    expect(isWorkPackageExecutionEnabled({ FORGE_WORK_PACKAGE_EXECUTION: '' })).toBe(false)
    expect(isWorkPackageExecutionEnabled({ FORGE_WORK_PACKAGE_EXECUTION: 'unexpected' })).toBe(false)
  })
})
