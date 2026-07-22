import { describe, expect, it, vi } from 'vitest'
import {
  advanceFilesystemGrantOperatorHoldProjection,
} from '@/lib/mcps/filesystem-grant-reconciliation'
import { buildFilesystemGrantBlockMetadata } from '@/lib/mcps/filesystem-grant-lifecycle'

const TASK_ID = '00000000-0000-4000-8000-000000000101'
const PACKAGE_ID = '00000000-0000-4000-8000-000000000102'

function chain<T>(value: T) {
  const query: Record<string, unknown> = {
    then: (onFulfilled: (resolved: T) => unknown) => Promise.resolve(value).then(onFulfilled),
  }
  for (const method of ['from', 'where']) query[method] = () => query
  return query
}

function contributionFromQuery(query: { queryChunks?: unknown[] }): Record<string, unknown> {
  const serialized = query.queryChunks?.find((chunk): chunk is string => (
    typeof chunk === 'string' && chunk.startsWith('{"authoritativeDecisionId"')
  ))
  if (!serialized) throw new Error('Expected a projection contribution JSON parameter.')
  return JSON.parse(serialized) as Record<string, unknown>
}

function projectionTx(input: { head?: Record<string, unknown> } = {}) {
  const contributions: Record<string, unknown>[] = []
  const execute = vi.fn(async (query: { queryChunks?: unknown[] }) => {
    contributions.push(contributionFromQuery(query))
    return [{ advanced: true }]
  })
  return {
    contributions,
    execute,
    tx: {
      execute,
      select: () => chain(input.head === undefined ? [{
        compareAndSetFingerprint: `head:v1:${TASK_ID}:${PACKAGE_ID}:operator_hold:5`,
        headFingerprint: `head:v1:${TASK_ID}:${PACKAGE_ID}:operator_hold:5`,
        headRevision: BigInt(0),
      }] : input.head ? [input.head] : []),
    },
  }
}

describe('filesystem operator-hold projection', () => {
  it('embeds the exact canonical full-capability marker for a hold transition', async () => {
    const marker = buildFilesystemGrantBlockMetadata({
      blockedAt: new Date('2026-07-17T00:00:00.000Z'),
      hold: {
        grantConsumed: false,
        grantDecisionRevision: null,
        grantPhase: 'none',
        holdKind: 'approval_required',
        revocationReason: null,
      },
      requirementKeys: ['requirement-2', 'requirement-1', 'requirement-1'],
      requestedCapabilities: [
        'filesystem.project.search',
        'filesystem.project.read',
        'filesystem.project.list',
        'filesystem.project.read',
      ],
      rootBindingRevision: '1',
    })
    const fixture = projectionTx()

    await advanceFilesystemGrantOperatorHoldProjection({
      authority: null,
      marker,
      priorBlockFingerprint: null,
      taskId: TASK_ID,
      transition: 'hold',
      tx: fixture.tx as never,
      workPackageId: PACKAGE_ID,
    })

    expect(marker.requestedCapabilities).toEqual([
      'filesystem.project.list',
      'filesystem.project.read',
      'filesystem.project.search',
    ])
    expect(fixture.contributions).toEqual([{
      authoritativeDecisionId: null,
      grantDecisionRevision: null,
      kind: 'filesystem_grant',
      mcpGrantBlock: marker,
      operatorHold: true,
      priorBlockFingerprint: null,
      schemaVersion: 1,
      transition: 'hold',
    }])
  })

  it('binds recovery to the exact prior marker and authoritative decision', async () => {
    const fixture = projectionTx()
    const priorBlockFingerprint = `sha256:${'a'.repeat(64)}`

    await advanceFilesystemGrantOperatorHoldProjection({
      authority: {
        decisionId: '00000000-0000-4000-8000-000000000103',
        grantDecisionRevision: '7',
      },
      marker: null,
      priorBlockFingerprint,
      taskId: TASK_ID,
      transition: 'recovery',
      tx: fixture.tx as never,
      workPackageId: PACKAGE_ID,
    })

    expect(fixture.contributions).toEqual([{
      authoritativeDecisionId: '00000000-0000-4000-8000-000000000103',
      grantDecisionRevision: '7',
      kind: 'filesystem_grant',
      mcpGrantBlock: null,
      operatorHold: false,
      priorBlockFingerprint,
      schemaVersion: 1,
      transition: 'recovery',
    }])
  })

  it('fails closed when an active package is missing its preallocated head', async () => {
    const fixture = projectionTx({ head: null as never })
    await expect(advanceFilesystemGrantOperatorHoldProjection({
      authority: null,
      marker: null,
      priorBlockFingerprint: `sha256:${'b'.repeat(64)}`,
      taskId: TASK_ID,
      transition: 'recovery',
      tx: fixture.tx as never,
      workPackageId: PACKAGE_ID,
    })).rejects.toThrow('preallocated operator-hold projection head is missing')
    expect(fixture.execute).not.toHaveBeenCalled()
  })
})
