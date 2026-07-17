import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
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
    controllerTokenDigest: Buffer.alloc(32, 0xb),
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
    for (const length of [39, 41, 63, 65]) {
      expect(decideEpic172ProjectManagementIngress(
        provisionalState({ reviewedSha: 'a'.repeat(length) }),
        NOW,
      )).toEqual({ allowed: false, reason: 'incomplete_identity' })
    }
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
    expect(decideEpic172ProjectManagementIngress(
      provisionalState({ reviewedSha: 'b'.repeat(64) }),
      NOW,
    )).toEqual({ allowed: true, state: 'provisional' })
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
  const projectApiRoot = fileURLToPath(new URL('../app/api/projects/', import.meta.url))
  const apiRoot = fileURLToPath(new URL('../app/api/', import.meta.url))

  function collectRouteFiles(directory: string): string[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const entryPath = path.join(directory, entry.name)
      if (entry.isDirectory()) return collectRouteFiles(entryPath)
      return entry.name === 'route.ts' ? [entryPath] : []
    })
  }

  function routeHandlers(source: string) {
    const matches = [...source.matchAll(/export async function (GET|POST|PUT|PATCH|DELETE)\b/g)]
    return matches.map((match, index) => ({
      body: source.slice(match.index, matches[index + 1]?.index ?? source.length),
      method: match[1],
    }))
  }

  function routeLabel(routePath: string): string {
    return `../app/api/${path.relative(apiRoot, routePath).split(path.sep).join('/')}`
  }

  it('guards every POST, PUT, and DELETE while preserving GET reads', () => {
    const guarded: string[] = []
    for (const routePath of collectRouteFiles(projectApiRoot).sort()) {
      const source = readFileSync(routePath, 'utf8')
      for (const { body, method } of routeHandlers(source)) {
        const label = `${routeLabel(routePath)}:${method}`
        if (method === 'GET') {
          expect(body, label).not.toContain('guardEpic172ProjectManagementIngress()')
          expect(body, label).not.toMatch(/\b(?:db|tx)\s*\.\s*(?:insert|update|delete)\s*\(/)
          expect(body, label).not.toMatch(/\bfs\s*\.\s*(?:appendFile|mkdir|rename|rm|unlink|writeFile)\s*\(/)
          expect(body, label).not.toContain('claimAccessibleLegacyProjects(')
          if (body.includes('getProjectMcpOverview(')) {
            expect(body, label).toContain('{ cache: false, ensureWorkspace: false }')
          }
        } else {
          expect(body.match(/guardEpic172ProjectManagementIngress\(\)/g), label).toHaveLength(1)
          guarded.push(label)
        }
      }
    }
    expect(guarded.sort()).toEqual([
      '../app/api/projects/route.ts:POST',
      '../app/api/projects/[id]/route.ts:PUT',
      '../app/api/projects/[id]/route.ts:DELETE',
      '../app/api/projects/[id]/filesystem-grant/route.ts:PUT',
      '../app/api/projects/[id]/issues/route.ts:POST',
      '../app/api/projects/[id]/mcps/route.ts:PUT',
      '../app/api/projects/[id]/mcps/install-recommended/route.ts:POST',
    ].sort())
  })

  it('requires the gate before every project-table or project-filesystem mutation in any API route', () => {
    const mutationPatterns = [
      /\.(?:insert|update|delete)\s*\(\s*projects\s*\)/g,
      /await\s+(?:registerProjectPath|setProjectMcpConfig|unregisterProjectPath)\s*\(/g,
    ]
    const observedMutations: string[] = []

    for (const routePath of collectRouteFiles(apiRoot)) {
      const source = readFileSync(routePath, 'utf8')
      for (const { body, method } of routeHandlers(source)) {
        for (const pattern of mutationPatterns) {
          for (const match of body.matchAll(pattern)) {
            const label = `${routeLabel(routePath)}:${method}:${match[0]}`
            observedMutations.push(label)
            const guardIndex = body.indexOf('guardEpic172ProjectManagementIngress()')
            expect(guardIndex, label).toBeGreaterThanOrEqual(0)
            expect(guardIndex, label).toBeLessThan(match.index ?? 0)
          }
        }
      }
    }
    expect(observedMutations).toContain(
      '../app/api/tasks/[id]/filesystem-grants/route.ts:PUT:.update(projects)',
    )
  })

  it('inventories and gates every task, package, approval, answer, and enqueue mutation', () => {
    const mutationPatterns = [
      /\.(?:insert|update|delete)\s*\(\s*(?:tasks|workPackages|approvalGates|taskQuestions|filesystemMcpGrantApprovals|projects)\s*\)/g,
      /redis\.(?:lpush|rpush)\s*\(\s*['"]forge:(?:tasks|approvals|answers)['"]/g,
      /\b(?:decideReviewGate|enqueueBlockedHandoffRetry)\s*\(/g,
    ]
    const guardedHandlers = new Set<string>()
    const observedMutations: string[] = []

    for (const routePath of collectRouteFiles(apiRoot).sort()) {
      const source = readFileSync(routePath, 'utf8')
      for (const { body, method } of routeHandlers(source)) {
        const handlerLabel = `${routeLabel(routePath)}:${method}`
        const matches = mutationPatterns.flatMap((pattern) => [...body.matchAll(pattern)])
        if (matches.length === 0) continue

        const guardMatches = [...body.matchAll(/guardEpic172ProjectManagementIngress\(\)/g)]
        expect(guardMatches, handlerLabel).toHaveLength(1)
        const guardIndex = guardMatches[0].index ?? -1
        expect(guardIndex, handlerLabel).toBeGreaterThanOrEqual(0)
        for (const match of matches) {
          observedMutations.push(`${handlerLabel}:${match[0]}`)
          expect(guardIndex, `${handlerLabel}:${match[0]}`).toBeLessThan(match.index ?? 0)
        }

        // Authentication is the sole route work allowed before the release gate.
        // Params, request bodies, access lookups, database writes, queue calls,
        // and filesystem operations must all occur after it.
        for (const postAuthOperation of [
          'await params',
          'request.json()',
          'getAccessibleTask(',
          'getAccessibleProject(',
          'generateTaskTitle(',
          'fs.',
        ]) {
          const operationIndex = body.indexOf(postAuthOperation)
          if (operationIndex >= 0) {
            expect(guardIndex, `${handlerLabel}:${postAuthOperation}`).toBeLessThan(operationIndex)
          }
        }
        guardedHandlers.add(handlerLabel)
      }
    }

    expect([...guardedHandlers].sort()).toEqual([
      '../app/api/projects/[id]/filesystem-grant/route.ts:PUT',
      '../app/api/projects/[id]/route.ts:DELETE',
      '../app/api/projects/[id]/route.ts:PUT',
      '../app/api/projects/route.ts:POST',
      '../app/api/providers/[id]/route.ts:DELETE',
      '../app/api/tasks/route.ts:POST',
      '../app/api/tasks/[id]/route.ts:DELETE',
      '../app/api/tasks/[id]/approval-gates/[gateId]/route.ts:POST',
      '../app/api/tasks/[id]/approve/route.ts:POST',
      '../app/api/tasks/[id]/filesystem-grants/route.ts:PUT',
      '../app/api/tasks/[id]/mcp-plan-review/route.ts:POST',
      '../app/api/tasks/[id]/questions/route.ts:POST',
      '../app/api/tasks/[id]/reject/route.ts:POST',
      '../app/api/tasks/[id]/replan/route.ts:POST',
      '../app/api/tasks/[id]/retry-handoff/route.ts:POST',
      '../app/api/tasks/[id]/retry/route.ts:POST',
    ].sort())
    expect(observedMutations.some((mutation) => mutation.includes("redis.lpush('forge:tasks'"))).toBe(true)
    expect(observedMutations.some((mutation) => mutation.includes("redis.lpush('forge:approvals'"))).toBe(true)
    expect(observedMutations.some((mutation) => mutation.includes("redis.lpush('forge:answers'"))).toBe(true)
  })

  it('gates provider deactivation before affected task or agent repointing', () => {
    const routePath = fileURLToPath(new URL('../app/api/providers/[id]/route.ts', import.meta.url))
    const source = readFileSync(routePath, 'utf8')
    const deleteHandler = routeHandlers(source).find(({ method }) => method === 'DELETE')
    expect(deleteHandler).toBeDefined()
    const body = deleteHandler?.body ?? ''
    const guardMatches = [...body.matchAll(/guardEpic172ProjectManagementIngress\(\)/g)]
    expect(guardMatches).toHaveLength(1)
    const guardIndex = guardMatches[0].index ?? -1
    for (const operation of ['await params', '.update(agentConfigs)', '.update(tasks)', '.update(providerConfigs)']) {
      const operationIndex = body.indexOf(operation)
      expect(operationIndex, operation).toBeGreaterThanOrEqual(0)
      expect(guardIndex, operation).toBeLessThan(operationIndex)
    }
  })

  it('keeps shared project and task access helpers read-only', () => {
    for (const relativePath of ['../lib/project-access.ts', '../lib/task-access.ts']) {
      const source = readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8')
      expect(source, relativePath).not.toMatch(/\bdb\s*\.\s*(?:insert|update|delete)\s*\(/)
      expect(source, relativePath).not.toContain('claimAccessibleLegacyProjects')
    }
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
    expect(source).toContain('from forge.read_epic_172_enablement_state_v1()')
    expect(source).not.toContain('.from(forgeEpic172EnablementState)')
    expect(source).toContain("reason: 'database_unavailable'")
  })
})
