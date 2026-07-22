import { readFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import safeV2TaskEvents from './__fixtures__/safe-v2-task-events.json'
import {
  LEGACY_TASK_LOG_UNAVAILABLE,
} from '@/lib/mcps/leakage-drain'
import {
  containsForbiddenV2EventData,
  legacyLeakageRowFingerprint,
  projectV2TaskEventData,
  runLegacyLeakageScrub,
  type LegacyLeakageScrubCheckpoint,
  type LegacyLeakageScrubDatabase,
  type LegacyLeakageScrubRedis,
  type LegacyLeakageScrubRow,
  type LoadedLegacyLeakageCheckpoint,
  type RedisScanEvidence,
} from '@/lib/mcps/legacy-leakage-scrub'
import {
  createLegacyLeakageRedisAdapter,
  parseLegacyLeakageScrubArgs,
} from '@/scripts/scrub-legacy-leakage'

const RECEIPT = '11111111-1111-4111-8111-111111111111'

function evidence(changes: Partial<RedisScanEvidence> = {}): RedisScanEvidence {
  return {
    complete: true,
    keysDeleted: 0,
    keysExamined: 0,
    remainingKeys: 0,
    valuesExamined: 0,
    violations: 0,
    ...changes,
  }
}

class FakeDatabase implements LegacyLeakageScrubDatabase {
  checkpoint: LoadedLegacyLeakageCheckpoint | null = null
  taskLogs: LegacyLeakageScrubRow[] = []
  artifacts: LegacyLeakageScrubRow[] = []
  workPackages: LegacyLeakageScrubRow[] = []
  protectedPlanEntries = [{ id: 'protected-entry', content: 'PROTECTED-PLAN-SENTINEL' }]
  authorizationChecks = 0
  updates = 0
  checkpointWrites = 0
  conflictOnceFor: string | null = null
  throwAfterCommitOnce = false
  private clock = 0

  async databaseTime(): Promise<string> {
    this.clock += 1
    return `2026-07-22T00:00:${String(this.clock).padStart(2, '0')}.000Z`
  }

  async verifyDrainAuthorization(receiptId: string): Promise<boolean> {
    this.authorizationChecks += 1
    return receiptId === RECEIPT
  }

  async loadCheckpoint(): Promise<LoadedLegacyLeakageCheckpoint | null> {
    return this.checkpoint
  }

  async createCheckpoint(checkpoint: LegacyLeakageScrubCheckpoint): Promise<LoadedLegacyLeakageCheckpoint | null> {
    if (this.checkpoint) return null
    this.checkpointWrites += 1
    this.checkpoint = { checkpoint, token: JSON.stringify(checkpoint) }
    return this.checkpoint
  }

  async scanRows(
    phase: 'task_logs' | 'artifacts' | 'work_packages',
    afterId: string | null,
    limit: number,
  ): Promise<LegacyLeakageScrubRow[]> {
    const source = phase === 'task_logs'
      ? this.taskLogs
      : phase === 'artifacts'
        ? this.artifacts
        : this.workPackages
    return source.filter((row) => afterId === null || row.id > afterId).slice(0, limit)
  }

  async commitRow(input: {
    current: LoadedLegacyLeakageCheckpoint
    expectedRowFingerprint: string
    nextCheckpoint: LegacyLeakageScrubCheckpoint
    row: LegacyLeakageScrubRow
  }): Promise<'committed' | 'row_conflict' | 'checkpoint_conflict'> {
    if (this.checkpoint?.token !== input.current.token) return 'checkpoint_conflict'
    const rows = input.row.kind === 'task_log'
      ? this.taskLogs
      : input.row.kind === 'artifact'
        ? this.artifacts
        : this.workPackages
    const index = rows.findIndex((row) => row.id === input.row.id)
    if (index < 0) return 'row_conflict'
    if (this.conflictOnceFor === input.row.id) {
      const source = rows[index]
      if (source.kind === 'task_log') {
        rows[index] = {
          ...source,
          metadata: { ...source.metadata, safeConcurrentStatus: 'preserved' },
        }
      }
      this.conflictOnceFor = null
      return 'row_conflict'
    }
    if (legacyLeakageRowFingerprint(rows[index]) !== input.expectedRowFingerprint) return 'row_conflict'
    rows[index] = input.row
    this.updates += 1
    this.checkpointWrites += 1
    this.checkpoint = {
      checkpoint: input.nextCheckpoint,
      token: JSON.stringify(input.nextCheckpoint),
    }
    if (this.throwAfterCommitOnce) {
      this.throwAfterCommitOnce = false
      throw new Error('injected disconnect after commit')
    }
    return 'committed'
  }

  async compareAndSetCheckpoint(
    current: LoadedLegacyLeakageCheckpoint,
    next: LegacyLeakageScrubCheckpoint,
  ): Promise<LoadedLegacyLeakageCheckpoint | null> {
    if (this.checkpoint?.token !== current.token) return null
    this.checkpointWrites += 1
    this.checkpoint = { checkpoint: next, token: JSON.stringify(next) }
    return this.checkpoint
  }
}

class FakeRedis implements LegacyLeakageScrubRedis {
  oldKeys = 2
  v2Violations = 0
  applyCalls: boolean[] = []

  async purgeLegacyTaskEventKeys({ apply }: { apply: boolean }): Promise<RedisScanEvidence> {
    this.applyCalls.push(apply)
    const found = this.oldKeys
    if (apply) this.oldKeys = 0
    return evidence({
      keysDeleted: apply ? found : 0,
      keysExamined: found,
      remainingKeys: this.oldKeys,
    })
  }

  async scanV2TaskEventHistory(): Promise<RedisScanEvidence> {
    return evidence({ keysExamined: 1, valuesExamined: 2, violations: this.v2Violations })
  }
}

function taskLog(id = '00000000-0000-4000-8000-000000000001'): LegacyLeakageScrubRow {
  return {
    id,
    kind: 'task_log',
    message: 'RAW-MESSAGE-SENTINEL',
    frontMatter: {
      status: 'running',
      nested: { system_prompt: ['RAW-PROMPT-SENTINEL'] },
    },
    metadata: {
      safeCount: 3,
      stdout: 'RAW-OUTPUT-SENTINEL /private/project',
      nested: { apiKey: 'RAW-KEY-SENTINEL' },
    },
  }
}

function artifact(id = '00000000-0000-4000-8000-000000000002'): LegacyLeakageScrubRow {
  return {
    id,
    kind: 'artifact',
    content: 'RAW-ARTIFACT-SENTINEL',
    metadata: { promptOverlay: { messages: ['RAW-OVERLAY-SENTINEL'] }, status: 'created' },
    replaceContent: true,
  }
}

function ordinaryArtifact(id = '00000000-0000-4000-8000-000000000003'): LegacyLeakageScrubRow {
  return {
    id,
    kind: 'artifact',
    content: 'export function keepThisCode() { return true }',
    metadata: { systemPrompt: 'RAW-METADATA-SENTINEL', testCount: 42 },
    replaceContent: false,
  }
}

function protectedHistoryArtifact(id = '00000000-0000-4000-8000-000000000004'): LegacyLeakageScrubRow {
  return {
    id,
    kind: 'artifact',
    content: 'Architect plan available in protected history',
    metadata: { historyAvailable: true },
    replaceContent: false,
  }
}

function spoofedHistoryArtifact(id = '00000000-0000-4000-8000-000000000005'): LegacyLeakageScrubRow {
  return {
    id,
    kind: 'artifact',
    content: 'RAW-SPOOFED-HISTORY-SENTINEL',
    metadata: { historyAvailable: true },
    // The PostgreSQL adapter derives this from architect_plan_versions, not metadata.
    replaceContent: true,
  }
}

function workPackage(id = '00000000-0000-4000-8000-000000000006'): LegacyLeakageScrubRow {
  return {
    id,
    kind: 'work_package',
    metadata: {
      status: 'pending',
      promptOverlay: 'RAW-WORK-PACKAGE-OVERLAY-SENTINEL',
      requirementContexts: [{ promptOverlay: 'RAW-WORK-PACKAGE-CONTEXT-SENTINEL' }],
      mcpAwareSubtasks: [{ inputs: ['RAW-WORK-PACKAGE-SUBTASK-SENTINEL'] }],
      hostileMetadata: { apiKey: 'RAW-WORK-PACKAGE-KEY-SENTINEL' },
    },
  }
}

describe('legacy leakage scrub', () => {
  it('keeps dry-run actionless while reporting bounded database and Redis work', async () => {
    const database = new FakeDatabase()
    const redis = new FakeRedis()
    database.taskLogs = [taskLog()]
    database.artifacts = [artifact(), ordinaryArtifact(), protectedHistoryArtifact(), spoofedHistoryArtifact()]
    database.workPackages = [workPackage()]

    const result = await runLegacyLeakageScrub({
      actor: 'operator',
      authorizationReceiptId: RECEIPT,
      mode: 'dry-run',
    }, { database, redis })

    expect(result).toMatchObject({
      checkpoint: null,
      dryRun: true,
      preview: {
        artifactRowsChanged: 3,
        taskLogRowsChanged: 1,
        workPackageRowsChanged: 1,
        redis: { keysDeleted: 0, remainingKeys: 2 },
      },
    })
    expect(database.checkpointWrites).toBe(0)
    expect(database.updates).toBe(0)
    expect(database.authorizationChecks).toBe(1)
    expect(redis.applyCalls).toEqual([false])
    expect(database.taskLogs[0]).toEqual(taskLog())
  })

  it('pauses on a row fingerprint conflict and resumes from the current value without lost updates', async () => {
    const database = new FakeDatabase()
    const redis = new FakeRedis()
    database.taskLogs = [taskLog()]
    database.artifacts = [artifact(), ordinaryArtifact(), protectedHistoryArtifact(), spoofedHistoryArtifact()]
    database.workPackages = [workPackage()]
    database.conflictOnceFor = database.taskLogs[0].id

    const first = await runLegacyLeakageScrub({
      actor: 'operator',
      authorizationReceiptId: RECEIPT,
      mode: 'apply',
      operationId: 'leakage-operation',
    }, { database, redis })
    expect(first.checkpoint).toMatchObject({ state: 'paused_conflict', conflicts: 1, lastKey: null })

    const resumed = await runLegacyLeakageScrub({
      actor: 'operator',
      authorizationReceiptId: RECEIPT,
      mode: 'resume',
      operationId: 'leakage-operation',
    }, { database, redis })
    expect(resumed.checkpoint).toMatchObject({ phase: 'complete', state: 'complete', rowsChanged: 5 })

    const cleanedLog = database.taskLogs[0]
    expect(cleanedLog).toMatchObject({
      kind: 'task_log',
      message: LEGACY_TASK_LOG_UNAVAILABLE,
      frontMatter: { status: 'running', nested: {} },
      metadata: {
        safeCount: 3,
        safeConcurrentStatus: 'preserved',
        stdout: { kind: 'unknown_legacy_digest', byteCount: expect.any(Number) },
        nested: {},
      },
    })
    expect(JSON.stringify(cleanedLog)).not.toContain('RAW-')
    expect(database.artifacts[0]).toMatchObject({
      content: LEGACY_TASK_LOG_UNAVAILABLE,
      metadata: { status: 'created' },
      replaceContent: true,
    })
    expect(database.artifacts[1]).toEqual({
      id: '00000000-0000-4000-8000-000000000003',
      kind: 'artifact',
      content: 'export function keepThisCode() { return true }',
      metadata: { testCount: 42 },
      replaceContent: false,
    })
    expect(database.artifacts[2]).toEqual(protectedHistoryArtifact())
    expect(database.artifacts[3]).toMatchObject({
      content: LEGACY_TASK_LOG_UNAVAILABLE,
      metadata: { historyAvailable: true },
      replaceContent: true,
    })
    expect(database.workPackages[0]).toEqual({
      id: '00000000-0000-4000-8000-000000000006',
      kind: 'work_package',
      metadata: { status: 'pending', hostileMetadata: {} },
    })
    expect(JSON.stringify(database.workPackages[0])).not.toContain('RAW-')
    expect(database.protectedPlanEntries).toEqual([
      { id: 'protected-entry', content: 'PROTECTED-PLAN-SENTINEL' },
    ])
    expect(redis.oldKeys).toBe(0)
  })

  it('resumes idempotently when the client disconnects after an atomic row and checkpoint commit', async () => {
    const database = new FakeDatabase()
    const redis = new FakeRedis()
    database.taskLogs = [taskLog()]
    database.workPackages = [workPackage()]
    database.throwAfterCommitOnce = true

    await expect(runLegacyLeakageScrub({
      actor: 'operator',
      authorizationReceiptId: RECEIPT,
      mode: 'apply',
      operationId: 'crash-operation',
    }, { database, redis })).rejects.toThrow('injected disconnect after commit')
    expect(database.taskLogs[0]).toMatchObject({ message: LEGACY_TASK_LOG_UNAVAILABLE })

    const resumed = await runLegacyLeakageScrub({
      actor: 'operator',
      authorizationReceiptId: RECEIPT,
      mode: 'resume',
      operationId: 'crash-operation',
    }, { database, redis })
    expect(resumed.checkpoint?.state).toBe('complete')
    const updateCount = database.updates

    const verifiedAgain = await runLegacyLeakageScrub({
      actor: 'operator',
      authorizationReceiptId: RECEIPT,
      mode: 'resume',
      operationId: 'crash-operation',
    }, { database, redis })
    expect(verifiedAgain.checkpoint?.state).toBe('complete')
    expect(database.updates).toBe(updateCount)
    expect(redis.applyCalls.at(-1)).toBe(false)
    expect(JSON.stringify(database.workPackages)).not.toContain('RAW-')
    expect(database.authorizationChecks).toBe(3)
  })

  it('requires the recorded S4 drain authorization before creating a checkpoint', async () => {
    const database = new FakeDatabase()
    const redis = new FakeRedis()
    await expect(runLegacyLeakageScrub({
      actor: 'operator',
      authorizationReceiptId: 'wrong-receipt',
      mode: 'apply',
      operationId: 'unauthorized-operation',
    }, { database, redis })).rejects.toThrow('fixed S4 producers-disabled drain contract')
    expect(database.checkpoint).toBeNull()
    expect(redis.applyCalls).toEqual([])
  })

  it('requires closed per-event shapes and rejects free-form diagnostic strings without sentinels', () => {
    expect(containsForbiddenV2EventData({ type: 'task:status', data: { metadata: { prompt_overlay: 'x' } } })).toBe(true)
    expect(containsForbiddenV2EventData({ type: 'task:status', data: { metadata: { storageLocator: 'opaque' } } })).toBe(true)
    expect(containsForbiddenV2EventData({ type: 'task:status', data: { metadata: { prompt_sha256: 'abc' } } })).toBe(true)
    for (const field of ['blockedReason', 'error', 'errorMessage', 'metadata', 'title']) {
      expect(containsForbiddenV2EventData({
        type: field === 'blockedReason' ? 'work_package:status' : 'task:status',
        data: {
          status: 'failed',
          updatedAt: '2026-07-22T00:00:00.000Z',
          workPackageId: '00000000-0000-4000-8000-000000000001',
          [field]: 'safe-looking but still free-form',
        },
      })).toBe(true)
    }
    for (const hostile of [
      '/private/project/SECRET.md',
      '/workspace/project/SECRET.md',
      'C:\\Users\\operator\\project\\secret.txt',
      'api_key=not-allowed-in-history',
      'Bearer not-allowed-in-history',
      'postgresql://operator:password@database/forge',
      'storageLocator=opaque-but-resolvable',
    ]) {
      expect(containsForbiddenV2EventData({
        type: 'run:started',
        data: { runId: '00000000-0000-4000-8000-000000000001', modelIdUsed: hostile },
      })).toBe(true)
    }
    expect(containsForbiddenV2EventData({ type: 'unknown:event', data: { status: 'running' } })).toBe(true)
    expect(containsForbiddenV2EventData({ type: 'task:status', data: { unexpectedSafeLookingField: true } })).toBe(true)
    expect(containsForbiddenV2EventData({
      type: 'run:failed',
      data: {
        errorMessage: { kind: 'unknown_legacy_digest', byteCount: 12 },
        runId: '00000000-0000-4000-8000-000000000001',
      },
    })).toBe(false)
    expect(containsForbiddenV2EventData({
      type: 'task:status',
      data: { errorMessage: null, status: 'running', updatedAt: '2026-07-22T00:00:00.000Z' },
    })).toBe(false)
    expect(containsForbiddenV2EventData({
      type: 'artifact:created',
      data: { agentRunId: '00000000-0000-4000-8000-000000000001', historyAvailable: true },
    })).toBe(false)
  })

  it('accepts the closed durable-history fixture for every current v2 producer type', () => {
    const expectedTypes = [
      'artifact:created',
      'approval_gate:created',
      'approval_gate:decided',
      'questions:created',
      'run:completed',
      'run:failed',
      'run:progress',
      'run:started',
      'task:handoff',
      'task:log',
      'task:status',
      'work_package:handoff',
      'work_package:status',
    ]
    expect([...new Set(safeV2TaskEvents.map(({ type }) => type))].sort()).toEqual(expectedTypes.sort())
    for (const event of safeV2TaskEvents) {
      expect(containsForbiddenV2EventData(event), JSON.stringify(event)).toBe(false)
    }
    const ordinaryArtifact = safeV2TaskEvents.find((event) => (
      event.type === 'artifact:created' && 'artifactId' in event.data
    ))
    expect(ordinaryArtifact?.data).not.toHaveProperty('content')
    expect(ordinaryArtifact?.data).not.toHaveProperty('metadata')
  })

  it('projects every current producer type before the scrub inspects durable history', () => {
    for (const event of safeV2TaskEvents) {
      const richProducerData: Record<string, unknown> = {
        type: event.type,
        ...event.data,
        metadata: { storageLocator: '/workspace/operator/project' },
        title: 'Operator-facing title that is not durable history',
      }
      if (event.type === 'artifact:created' && 'artifactId' in event.data) {
        richProducerData.content = 'unprotected artifact content'
      }
      if (event.type === 'questions:created') {
        richProducerData.questions = [{ question: 'private prompt?', answer: 'private answer' }]
      }
      if (event.type === 'task:status' || event.type === 'run:failed') {
        richProducerData.errorMessage = 'failed at /workspace/operator/project with api_key=secret'
      }
      if (event.type === 'task:handoff' || event.type === 'work_package:status') {
        richProducerData.blockedReason = 'blocked at /workspace/operator/project'
      }
      if (event.type === 'task:handoff') richProducerData.reviewBlockReason = 'private review feedback'

      const projected = projectV2TaskEventData(event.type, richProducerData)
      expect(containsForbiddenV2EventData({ type: event.type, data: projected }), event.type).toBe(false)
      expect(projected).not.toHaveProperty('type')
      expect(projected).not.toHaveProperty('metadata')
      expect(projected).not.toHaveProperty('title')
      expect(projected).not.toHaveProperty('content')
    }
    expect(projectV2TaskEventData('run:chunk', { delta: 'private output' })).toBeNull()
    expect(projectV2TaskEventData('questions:answered', { answers: ['private answer'] })).toBeNull()
  })

  it('rechecks database and Redis zero scans before trusting a completed checkpoint', async () => {
    const database = new FakeDatabase()
    const redis = new FakeRedis()
    const options = {
      actor: 'operator',
      authorizationReceiptId: RECEIPT,
      mode: 'apply' as const,
      operationId: 'completion-zero-scan',
    }
    const completed = await runLegacyLeakageScrub(options, { database, redis })
    expect(completed.checkpoint?.state).toBe('complete')

    database.workPackages = [workPackage()]
    await expect(runLegacyLeakageScrub({ ...options, mode: 'resume' }, { database, redis }))
      .rejects.toThrow('database or Redis leakage reappeared')
    expect(database.authorizationChecks).toBe(2)
  })
})

describe('legacy leakage Redis adapter', () => {
  it('deletes both legacy namespaces and rejects unsafe v2 sorted-set members', async () => {
    const keys = new Map<string, string[]>([
      ['forge:task:one:history', []],
      ['forge:task:one:seq', []],
      ['forge:task-events:v2:one:history', [
        JSON.stringify({
          type: 'task:status',
          data: { errorMessage: null, status: 'running', updatedAt: '2026-07-22T00:00:00.000Z' },
        }),
        JSON.stringify({ type: 'run:chunk', data: { delta: 'RAW-DELTA-SENTINEL' } }),
      ]],
    ])
    const fakeRedis = {
      scan: vi.fn(async (_cursor: string, _match: string, pattern: string) => {
        const regex = new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replaceAll('\\*', '.*')}$`)
        return ['0', [...keys.keys()].filter((key) => regex.test(key))]
      }),
      del: vi.fn(async (...deleted: string[]) => {
        let count = 0
        for (const key of deleted) {
          if (keys.delete(key)) count += 1
        }
        return count
      }),
      zscan: vi.fn(async (key: string) => [
        '0',
        (keys.get(key) ?? []).flatMap((value, index) => [value, String(index + 1)]),
      ]),
    }
    const adapter = createLegacyLeakageRedisAdapter(fakeRedis as never)

    const purged = await adapter.purgeLegacyTaskEventKeys({ apply: true })
    expect(purged).toMatchObject({ complete: true, keysDeleted: 2, remainingKeys: 0 })
    expect([...keys.keys()]).toEqual(['forge:task-events:v2:one:history'])

    const v2 = await adapter.scanV2TaskEventHistory([])
    expect(v2).toMatchObject({ complete: true, valuesExamined: 2, violations: 1 })
  })
})

describe('legacy leakage CLI and operator guide', () => {
  it('keeps dry-run, apply, resume, package command, and runbook examples in parity', async () => {
    expect(parseLegacyLeakageScrubArgs([
      '--actor', 'operator', '--authorization-receipt', RECEIPT,
    ])).toMatchObject({ mode: 'dry-run', authorizationReceiptId: RECEIPT })
    expect(parseLegacyLeakageScrubArgs([
      '--actor', 'operator', '--apply', '--operation', 'operation-1',
      '--authorization-receipt', RECEIPT, '--sentinel', 'SENTINEL-A', '--sentinel', 'SENTINEL-B',
    ])).toMatchObject({ mode: 'apply', operationId: 'operation-1', sentinels: ['SENTINEL-A', 'SENTINEL-B'] })
    expect(parseLegacyLeakageScrubArgs([
      '--actor', 'operator', '--resume', '--operation', 'operation-1', '--authorization-receipt', RECEIPT,
    ])).toMatchObject({ mode: 'resume' })
    expect(() => parseLegacyLeakageScrubArgs(['--actor', 'operator'])).toThrow('--authorization-receipt')
    expect(() => parseLegacyLeakageScrubArgs([
      '--actor', 'operator', '--authorization-receipt', RECEIPT, '--apply',
    ])).toThrow('--operation')

    const packageJson = JSON.parse(await readFile('package.json', 'utf8')) as { scripts: Record<string, string> }
    const runbook = await readFile('../docs/operators/legacy-leakage-scrub-v1.md', 'utf8')
    const commandSource = await readFile('scripts/scrub-legacy-leakage.ts', 'utf8')
    expect(packageJson.scripts['protocol:scrub-legacy-leakage']).toBe('tsx scripts/scrub-legacy-leakage.ts')
    for (const contractText of [
      'protocol:scrub-legacy-leakage',
      '--authorization-receipt',
      '--operation',
      '--apply',
      '--resume',
      'architect_plan_entries',
      'architect_plan_versions',
      'work_packages',
      'forge:task-events:v2:{taskId}:history',
      'FORGE_DATABASE_ADMIN_URL',
    ]) {
      expect(runbook).toContain(contractText)
    }
    expect(commandSource).toContain('process.env.FORGE_DATABASE_ADMIN_URL')
    expect(commandSource).not.toContain("getRequiredEnv('DATABASE_URL')")
    expect(commandSource).toContain("receipt.owner_issue = 179")
    expect(commandSource).toContain("predecessor.evidence_kind = 's4_expand'")
    expect(commandSource).toContain("enablement.state = 'disabled'")
    expect(commandSource).toContain("'legacy_prompt_and_event_data_zero_scan_green'")
    expect(commandSource).toContain('select distinct plan_artifact_id from architect_plan_versions')
    expect(commandSource).not.toContain('historyAvailable":true')
  })
})
