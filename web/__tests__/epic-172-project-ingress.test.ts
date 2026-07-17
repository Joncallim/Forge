import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { decideEpic172ProjectManagementIngress } from '@/lib/projects/epic-172-project-ingress'

type TestState = NonNullable<Parameters<typeof decideEpic172ProjectManagementIngress>[0]>

const NOW = new Date('2026-07-17T04:10:00.000Z')
const STARTED = new Date('2026-07-17T04:00:00.000Z')
const EXPIRES = new Date(STARTED.getTime() + 1_560_000)
const HEARTBEAT = new Date('2026-07-17T04:09:30.000Z')
const LEASE_EXPIRES = new Date('2026-07-17T04:10:15.000Z')

function provisionalState(overrides: Partial<TestState> = {}): TestState {
  return {
    state: 'provisional',
    ownerOperationId: 'enablement-operation-1',
    exactBuilds: ['issue_179_s4@build-1', 'issue_180_s5@build-2', 'issue_181_s6@build-3'],
    reviewedSha: 'a'.repeat(40),
    epoch: 2,
    startedAt: STARTED,
    expiresAt: EXPIRES,
    enablementReceiptId: '00000000-0000-4000-8000-000000000001',
    finalReadinessReceiptId: null,
    openingAuthorizationId: '00000000-0000-4000-8000-000000000002',
    controllerLoginId: 'forge-epic-172-controller',
    controllerRunId: 'controller-run-1',
    controllerTokenDigest: 'b'.repeat(64),
    leaseGeneration: 3,
    lastHeartbeatAt: HEARTBEAT,
    leaseExpiresAt: LEASE_EXPIRES,
    stateFingerprint: 'c'.repeat(64),
    ...overrides,
  }
}

function activeState(overrides: Partial<TestState> = {}): TestState {
  return {
    ...provisionalState(),
    state: 'active',
    expiresAt: null,
    finalReadinessReceiptId: '00000000-0000-4000-8000-000000000003',
    controllerTokenDigest: null,
    leaseGeneration: null,
    lastHeartbeatAt: null,
    leaseExpiresAt: null,
    ...overrides,
  }
}

describe('Epic 172 project-management ingress decision', () => {
  it('fails closed for missing, disabled, incomplete, and unknown state', () => {
    expect(decideEpic172ProjectManagementIngress(null, NOW)).toEqual({
      allowed: false,
      reason: 'missing_state',
    })
    expect(decideEpic172ProjectManagementIngress(provisionalState({ state: 'disabled' }), NOW)).toEqual({
      allowed: false,
      reason: 'disabled',
    })
    expect(decideEpic172ProjectManagementIngress(provisionalState({ reviewedSha: null }), NOW)).toEqual({
      allowed: false,
      reason: 'incomplete_identity',
    })
    expect(decideEpic172ProjectManagementIngress(
      { ...provisionalState(), state: 'unexpected' } as unknown as TestState,
      NOW,
    )).toEqual({ allowed: false, reason: 'invalid_state' })
  })

  it('allows only a complete active state or a live exact provisional state', () => {
    expect(decideEpic172ProjectManagementIngress(activeState(), NOW)).toEqual({
      allowed: true,
      state: 'active',
    })
    expect(decideEpic172ProjectManagementIngress(provisionalState(), NOW)).toEqual({
      allowed: true,
      state: 'provisional',
    })
    expect(decideEpic172ProjectManagementIngress(activeState({ finalReadinessReceiptId: null }), NOW)).toEqual({
      allowed: false,
      reason: 'incomplete_identity',
    })
  })

  it('treats equality as expired and rejects malformed provisional timelines', () => {
    expect(decideEpic172ProjectManagementIngress(provisionalState(), EXPIRES)).toEqual({
      allowed: false,
      reason: 'expired_provisional_window',
    })
    expect(decideEpic172ProjectManagementIngress(provisionalState(), LEASE_EXPIRES)).toEqual({
      allowed: false,
      reason: 'expired_controller_lease',
    })
    expect(decideEpic172ProjectManagementIngress(
      provisionalState({ expiresAt: new Date(EXPIRES.getTime() + 1) }),
      NOW,
    )).toEqual({ allowed: false, reason: 'invalid_timeline' })
    expect(decideEpic172ProjectManagementIngress(
      provisionalState({ leaseExpiresAt: new Date(HEARTBEAT.getTime() + 45_001) }),
      NOW,
    )).toEqual({ allowed: false, reason: 'invalid_timeline' })
  })
})

describe('Epic 172 project route ingress sentinel', () => {
  const routePaths = [
    '../app/api/projects/route.ts',
    '../app/api/projects/[id]/route.ts',
    '../app/api/projects/[id]/filesystem-grant/route.ts',
    '../app/api/projects/[id]/issues/route.ts',
    '../app/api/projects/[id]/mcps/route.ts',
    '../app/api/projects/[id]/mcps/install-recommended/route.ts',
    '../app/api/projects/[id]/roadmap/route.ts',
  ]

  it('guards every POST, PUT, and DELETE while preserving GET reads', () => {
    const guarded: string[] = []
    for (const relativePath of routePaths) {
      const source = readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8')
      const matches = [...source.matchAll(/export async function (GET|POST|PUT|DELETE)\b/g)]
      for (const [index, match] of matches.entries()) {
        const body = source.slice(match.index, matches[index + 1]?.index ?? source.length)
        const label = `${relativePath}:${match[1]}`
        if (match[1] === 'GET') {
          expect(body, label).not.toContain('guardEpic172ProjectManagementIngress()')
        } else {
          expect(body.match(/guardEpic172ProjectManagementIngress\(\)/g), label).toHaveLength(1)
          guarded.push(label)
        }
      }
    }
    expect(guarded).toEqual([
      '../app/api/projects/route.ts:POST',
      '../app/api/projects/[id]/route.ts:PUT',
      '../app/api/projects/[id]/route.ts:DELETE',
      '../app/api/projects/[id]/filesystem-grant/route.ts:PUT',
      '../app/api/projects/[id]/issues/route.ts:POST',
      '../app/api/projects/[id]/mcps/route.ts:PUT',
      '../app/api/projects/[id]/mcps/install-recommended/route.ts:POST',
    ])
  })

  it('checks removal ingress before rejecting file deletion or archiving', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../app/api/projects/[id]/route.ts', import.meta.url)),
      'utf8',
    )
    const deleteBody = source.slice(source.indexOf('export async function DELETE'))
    const guardIndex = deleteBody.indexOf('guardEpic172ProjectManagementIngress()')
    expect(guardIndex).toBeGreaterThan(0)
    for (const operation of ['deleteFiles', 'getAccessibleProject(', '.update(projects)']) {
      expect(deleteBody.indexOf(operation), operation).toBeGreaterThan(guardIndex)
    }
    expect(deleteBody).not.toContain('getWorkspaceSettings(')
    expect(deleteBody).not.toContain('checkProjectDeletePath(')
    expect(deleteBody).not.toContain('fs.rm(')
    expect(deleteBody).not.toContain('db.delete(')
    expect(deleteBody).toContain("archivedAt, updatedAt: archivedAt")
  })

  it('reads the singleton with database time and fails closed on read errors', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../lib/projects/epic-172-project-ingress.ts', import.meta.url)),
      'utf8',
    )
    expect(source).toContain('.from(forgeEpic172EnablementState)')
    expect(source).toContain(".where(eq(forgeEpic172EnablementState.singletonId, 'epic-172'))")
    expect(source).toContain('clock_timestamp()')
    expect(source).toContain("reason: 'database_unavailable'")
  })
})
