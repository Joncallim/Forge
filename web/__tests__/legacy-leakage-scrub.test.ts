import { readFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import safeV2TaskEvents from './__fixtures__/safe-v2-task-events.json'
import {
  LEGACY_TASK_LOG_UNAVAILABLE,
} from '@/lib/mcps/leakage-drain'
import { scanJsonObjectKeys } from '@/lib/json-object-key-scan'
import {
  containsForbiddenV2EventData,
  compareCanonicalCodeUnits,
  LEGACY_LEAKAGE_SCRUB_DATABASE_POLICY,
  LEGACY_LEAKAGE_SCRUB_CHECKPOINT_PREFIX,
  legacyLeakageRowFingerprint,
  legacyLeakageSentinelSetFingerprint,
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
  legacyLeakageScrubUsage,
  parseLegacyLeakageScrubCheckpoint,
  parseLegacyLeakageScrubArgs,
} from '@/scripts/scrub-legacy-leakage'

const RECEIPT = '11111111-1111-4111-8111-111111111111'
const FINGERPRINT_KEY = Buffer.alloc(32, 7)
const FINGERPRINT_KEY_ID = 'test-scrub-key-v2'

function validCheckpointJson(changes: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 2,
    operationId: 'checkpoint-operation',
    actor: 'operator',
    authorizationReceiptId: RECEIPT,
    fingerprintKeyId: FINGERPRINT_KEY_ID,
    sentinelSetFingerprint: 'a'.repeat(64),
    phase: 'task_logs',
    state: 'running',
    lastKey: null,
    rowsExamined: 0,
    rowsChanged: 0,
    conflicts: 0,
    redisKeysExamined: 0,
    redisKeysDeleted: 0,
    redisV2ValuesExamined: 0,
    lastPreFingerprint: null,
    lastPostFingerprint: null,
    databaseTime: '2026-07-28T00:00:00.000Z',
    ...changes,
  })
}

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
  approvalGates: LegacyLeakageScrubRow[] = []
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
    phase: 'task_logs' | 'artifacts' | 'work_packages' | 'approval_gates',
    afterId: string | null,
    limit: number,
  ): Promise<LegacyLeakageScrubRow[]> {
    const source = phase === 'task_logs'
      ? this.taskLogs
      : phase === 'artifacts'
        ? this.artifacts
        : phase === 'work_packages'
          ? this.workPackages
          : this.approvalGates
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
        : input.row.kind === 'work_package'
          ? this.workPackages
          : this.approvalGates
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
    if (legacyLeakageRowFingerprint(rows[index], FINGERPRINT_KEY) !== input.expectedRowFingerprint) return 'row_conflict'
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
  legacyViolations = 0
  legacyViolationAfterApply = false
  applyCalls: boolean[] = []

  async purgeLegacyTaskEventKeys({ apply }: { apply: boolean }): Promise<RedisScanEvidence> {
    this.applyCalls.push(apply)
    const found = this.oldKeys
    const violations = this.legacyViolations
    if (apply) {
      this.oldKeys = 0
      if (this.legacyViolationAfterApply) this.legacyViolations = 1
    }
    return evidence({
      keysDeleted: apply ? found : 0,
      keysExamined: found,
      remainingKeys: this.oldKeys,
      violations,
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

function approvalGate(id = '00000000-0000-4000-8000-000000000007'): LegacyLeakageScrubRow {
  return {
    id,
    kind: 'approval_gate',
    metadata: {
      mcpOperatorReviewRequired: true,
      s4State: 'activated',
      mcpOperatorReviews: [{
        schemaVersion: 1,
        items: [{ promptOverlays: { backend: 'RAW-ACTIVATED-S4-PROMPT-SENTINEL' } }],
        reviewedDesign: { systemPrompt: 'RAW-ACTIVATED-S4-SYSTEM-SENTINEL' },
      }],
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
    database.approvalGates = [approvalGate()]

    const result = await runLegacyLeakageScrub({
      actor: 'operator',
      authorizationReceiptId: RECEIPT,
      fingerprintKey: FINGERPRINT_KEY,
      fingerprintKeyId: FINGERPRINT_KEY_ID,
      mode: 'dry-run',
    }, { database, redis })

    expect(result).toMatchObject({
      checkpoint: null,
      dryRun: true,
      preview: {
        artifactRowsChanged: 3,
        taskLogRowsChanged: 1,
        workPackageRowsChanged: 1,
        approvalGateRowsChanged: 1,
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
    database.approvalGates = [approvalGate()]
    database.conflictOnceFor = database.taskLogs[0].id

    const first = await runLegacyLeakageScrub({
      actor: 'operator',
      authorizationReceiptId: RECEIPT,
      fingerprintKey: FINGERPRINT_KEY,
      fingerprintKeyId: FINGERPRINT_KEY_ID,
      mode: 'apply',
      operationId: 'leakage-operation',
    }, { database, redis })
    expect(first.checkpoint).toMatchObject({ state: 'paused_conflict', conflicts: 1, lastKey: null })

    const resumed = await runLegacyLeakageScrub({
      actor: 'operator',
      authorizationReceiptId: RECEIPT,
      fingerprintKey: FINGERPRINT_KEY,
      fingerprintKeyId: FINGERPRINT_KEY_ID,
      mode: 'resume',
      operationId: 'leakage-operation',
    }, { database, redis })
    expect(resumed.checkpoint).toMatchObject({ phase: 'complete', state: 'complete', rowsChanged: 6 })

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
    expect(database.approvalGates[0]).toEqual({
      id: '00000000-0000-4000-8000-000000000007',
      kind: 'approval_gate',
      metadata: {
        mcpOperatorReviewRequired: true,
        s4State: 'activated',
        mcpOperatorReviews: [{ schemaVersion: 1, items: [{}], reviewedDesign: {} }],
      },
    })
    expect(JSON.stringify(database.approvalGates[0])).not.toContain('RAW-')
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
      fingerprintKey: FINGERPRINT_KEY,
      fingerprintKeyId: FINGERPRINT_KEY_ID,
      mode: 'apply',
      operationId: 'crash-operation',
    }, { database, redis })).rejects.toThrow('injected disconnect after commit')
    expect(database.taskLogs[0]).toMatchObject({ message: LEGACY_TASK_LOG_UNAVAILABLE })

    const resumed = await runLegacyLeakageScrub({
      actor: 'operator',
      authorizationReceiptId: RECEIPT,
      fingerprintKey: FINGERPRINT_KEY,
      fingerprintKeyId: FINGERPRINT_KEY_ID,
      mode: 'resume',
      operationId: 'crash-operation',
    }, { database, redis })
    expect(resumed.checkpoint?.state).toBe('complete')
    const updateCount = database.updates

    const verifiedAgain = await runLegacyLeakageScrub({
      actor: 'operator',
      authorizationReceiptId: RECEIPT,
      fingerprintKey: FINGERPRINT_KEY,
      fingerprintKeyId: FINGERPRINT_KEY_ID,
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
      fingerprintKey: FINGERPRINT_KEY,
      fingerprintKeyId: FINGERPRINT_KEY_ID,
      mode: 'apply',
      operationId: 'unauthorized-operation',
    }, { database, redis })).rejects.toThrow('fixed S4 producers-disabled drain contract')
    expect(database.checkpoint).toBeNull()
    expect(redis.applyCalls).toEqual([])
  })

  it('completes a write-free v2 preflight before legacy deletion and pauses without deleting v2 evidence', async () => {
    const database = new FakeDatabase()
    const redis = new FakeRedis()
    redis.v2Violations = 1
    const result = await runLegacyLeakageScrub({
      actor: 'operator',
      authorizationReceiptId: RECEIPT,
      fingerprintKey: FINGERPRINT_KEY,
      fingerprintKeyId: FINGERPRINT_KEY_ID,
      mode: 'apply',
      operationId: 'v2-preflight-operation',
    }, { database, redis })
    expect(result.checkpoint).toMatchObject({ phase: 'redis_legacy', state: 'paused_conflict' })
    expect(redis.applyCalls).toEqual([false])
    expect(redis.oldKeys).toBe(2)
  })

  it('uses domain-separated keyed fingerprints and binds resume to key and order-independent sentinels', async () => {
    const row = taskLog()
    const otherKey = Buffer.alloc(32, 8)
    expect(legacyLeakageRowFingerprint(row, FINGERPRINT_KEY)).not.toBe(legacyLeakageRowFingerprint(row, otherKey))
    expect(legacyLeakageSentinelSetFingerprint(['B', 'A', 'A'], FINGERPRINT_KEY))
      .toBe(legacyLeakageSentinelSetFingerprint(['A', 'B'], FINGERPRINT_KEY))

    const database = new FakeDatabase()
    const redis = new FakeRedis()
    await runLegacyLeakageScrub({
      actor: 'operator', authorizationReceiptId: RECEIPT, fingerprintKey: FINGERPRINT_KEY,
      fingerprintKeyId: FINGERPRINT_KEY_ID, sentinels: ['B', 'A'], mode: 'apply', operationId: 'bound-operation',
    }, { database, redis })
    await expect(runLegacyLeakageScrub({
      actor: 'operator', authorizationReceiptId: RECEIPT, fingerprintKey: otherKey,
      fingerprintKeyId: 'rotated-key-v3', sentinels: ['A', 'B'], mode: 'resume', operationId: 'bound-operation',
    }, { database, redis })).rejects.toThrow('fingerprint key ID')
    await expect(runLegacyLeakageScrub({
      actor: 'operator', authorizationReceiptId: RECEIPT, fingerprintKey: FINGERPRINT_KEY,
      fingerprintKeyId: FINGERPRINT_KEY_ID, sentinels: ['A', 'C'], mode: 'resume', operationId: 'bound-operation',
    }, { database, redis })).rejects.toThrow('sentinel set')
    expect(JSON.stringify(database.checkpoint)).not.toContain('A')
    expect(JSON.stringify(database.checkpoint)).not.toContain(FINGERPRINT_KEY.toString('hex'))
  })

  it('uses explicit code-unit HMAC ordering for non-ASCII object keys and sentinels', () => {
    expect(['é', 'z', 'a', 'ä', '𝌆'].sort(compareCanonicalCodeUnits)).toEqual(['a', 'z', 'ä', 'é', '𝌆'])
    expect(legacyLeakageSentinelSetFingerprint(['é', 'z', 'a', 'ä', '𝌆', 'a'], FINGERPRINT_KEY))
      .toBe('f57d110257c9a31528c0b6d85f2072c524203b96551abb5afe6185a25ba9a33c')
    const first = { ...taskLog(), metadata: { 'é': 1, z: 2, a: 3, 'ä': 4, '𝌆': 5 } }
    const second = { ...taskLog(), metadata: { '𝌆': 5, 'ä': 4, a: 3, z: 2, 'é': 1 } }
    expect(legacyLeakageRowFingerprint(first, FINGERPRINT_KEY)).toBe(legacyLeakageRowFingerprint(second, FINGERPRINT_KEY))
  })

  it('rejects a checkpoint whose embedded operation identity differs from the requested storage key', async () => {
    const database = new FakeDatabase()
    const redis = new FakeRedis()
    await runLegacyLeakageScrub({
      actor: 'operator', authorizationReceiptId: RECEIPT, fingerprintKey: FINGERPRINT_KEY,
      fingerprintKeyId: FINGERPRINT_KEY_ID, mode: 'apply', operationId: 'stored-operation',
    }, { database, redis })
    const checkpoint = database.checkpoint!
    database.checkpoint = {
      checkpoint: { ...checkpoint.checkpoint, operationId: 'embedded-other-operation' },
      token: checkpoint.token,
    }
    const writesBefore = database.checkpointWrites
    await expect(runLegacyLeakageScrub({
      actor: 'operator', authorizationReceiptId: RECEIPT, fingerprintKey: FINGERPRINT_KEY,
      fingerprintKeyId: FINGERPRINT_KEY_ID, mode: 'resume', operationId: 'stored-operation',
    }, { database, redis })).rejects.toThrow('operation identity does not match its storage key')
    expect(database.checkpointWrites).toBe(writesBefore)
  })

  it('fails closed instead of resuming an unsafe v1 checkpoint and exposes a closed sink policy', () => {
    expect(() => parseLegacyLeakageScrubCheckpoint(JSON.stringify({ schemaVersion: 1, operationId: 'old' })))
      .toThrow('unsafe legacy format; start a new --apply operation')
    expect(LEGACY_LEAKAGE_SCRUB_DATABASE_POLICY.task_logs.updated).toEqual(['message', 'front_matter', 'metadata'])
    expect(LEGACY_LEAKAGE_SCRUB_DATABASE_POLICY.artifacts.excluded).toContain('architect_plan_entries.content')
    expect(LEGACY_LEAKAGE_SCRUB_DATABASE_POLICY.retainedAuthorities).toEqual(expect.arrayContaining([
      'tasks.prompt', 'architect_plan_versions', 'architect_plan_entries', 'ordinary_non_plan_artifact.content',
    ]))
  })

  it('accepts only the complete closed v2 checkpoint shape', () => {
    expect(parseLegacyLeakageScrubCheckpoint(validCheckpointJson())).toMatchObject({ schemaVersion: 2, phase: 'task_logs' })
    const invalid = [
      validCheckpointJson({ phase: 'unknown_phase' }),
      validCheckpointJson({ state: 'unknown_state' }),
      validCheckpointJson({ operationId: '' }),
      validCheckpointJson({ actor: ' operator ' }),
      validCheckpointJson({ authorizationReceiptId: 'not-a-uuid' }),
      validCheckpointJson({ fingerprintKeyId: 'bad key id' }),
      validCheckpointJson({ sentinelSetFingerprint: 'not-a-fingerprint' }),
      validCheckpointJson({ lastKey: 'not-a-uuid' }),
      validCheckpointJson({ lastPreFingerprint: 'short' }),
      validCheckpointJson({ rowsExamined: -1 }),
      validCheckpointJson({ rowsChanged: 1.5 }),
      validCheckpointJson({ conflicts: Number.MAX_SAFE_INTEGER + 1 }),
      validCheckpointJson({ rowsExamined: 0, rowsChanged: 1 }),
      validCheckpointJson({ redisKeysExamined: 0, redisKeysDeleted: 1 }),
      validCheckpointJson({ databaseTime: 'not-a-date' }),
      validCheckpointJson({ phase: 'complete', state: 'running' }),
      validCheckpointJson({ phase: 'complete', state: 'complete', lastKey: '00000000-0000-4000-8000-000000000001' }),
      validCheckpointJson({ unexpected: true }),
      JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(validCheckpointJson())).filter(([key]) => key !== 'actor'))),
      '{not json}',
    ]
    for (const malformed of invalid) {
      expect(() => parseLegacyLeakageScrubCheckpoint(malformed)).toThrow('Stored leakage scrub checkpoint is malformed')
    }
  })

  it('does not mutate a loaded checkpoint when a runtime phase is impossible', async () => {
    const database = new FakeDatabase()
    const redis = new FakeRedis()
    database.checkpoint = {
      checkpoint: JSON.parse(validCheckpointJson({ operationId: 'runtime-corrupt', phase: 'unknown_phase' })) as LegacyLeakageScrubCheckpoint,
      token: validCheckpointJson({ operationId: 'runtime-corrupt', phase: 'unknown_phase' }),
    }
    await expect(runLegacyLeakageScrub({
      actor: 'operator', authorizationReceiptId: RECEIPT, fingerprintKey: FINGERPRINT_KEY,
      fingerprintKeyId: FINGERPRINT_KEY_ID, mode: 'resume', operationId: 'runtime-corrupt',
    }, { database, redis })).rejects.toThrow('unknown phase')
    expect(database.checkpointWrites).toBe(0)
    expect(database.updates).toBe(0)
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
      'questions:answered',
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
      if (event.type === 'questions:answered') {
        richProducerData.questions = [{
          question: 'RAW-QUESTION-SENTINEL',
          suggestions: ['RAW-SUGGESTION-SENTINEL'],
          answer: 'RAW-ANSWER-SENTINEL',
        }]
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
    expect(projectV2TaskEventData('questions:answered', {
      answeredCount: 1,
      allAnswered: false,
      questions: [{ question: 'private question', suggestions: ['private suggestion'], answer: 'private answer' }],
    })).toEqual({ answeredCount: 1, allAnswered: false })
  })

  it('rechecks database and Redis zero scans before trusting a completed checkpoint', async () => {
    const database = new FakeDatabase()
    const redis = new FakeRedis()
    const options = {
      actor: 'operator',
      authorizationReceiptId: RECEIPT,
      fingerprintKey: FINGERPRINT_KEY,
      fingerprintKeyId: FINGERPRINT_KEY_ID,
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

  it('does not trust completed Redis verification when legacy evidence reports a violation', async () => {
    const database = new FakeDatabase()
    const redis = new FakeRedis()
    const options = {
      actor: 'operator', authorizationReceiptId: RECEIPT, fingerprintKey: FINGERPRINT_KEY,
      fingerprintKeyId: FINGERPRINT_KEY_ID, mode: 'apply' as const, operationId: 'completion-legacy-violation',
    }
    const completed = await runLegacyLeakageScrub(options, { database, redis })
    expect(completed.checkpoint?.state).toBe('complete')

    redis.legacyViolations = 1
    await expect(runLegacyLeakageScrub({ ...options, mode: 'resume' }, { database, redis }))
      .rejects.toThrow('database or Redis leakage reappeared')
    expect(redis.applyCalls.at(-1)).toBe(false)
  })

  it('returns final legacy violations to the redis_legacy recovery path before another delete', async () => {
    const database = new FakeDatabase()
    const redis = new FakeRedis()
    redis.legacyViolationAfterApply = true
    const options = {
      actor: 'operator', authorizationReceiptId: RECEIPT, fingerprintKey: FINGERPRINT_KEY,
      fingerprintKeyId: FINGERPRINT_KEY_ID, mode: 'apply' as const, operationId: 'final-legacy-violation',
    }
    const first = await runLegacyLeakageScrub(options, { database, redis })
    expect(first.checkpoint).toMatchObject({ phase: 'redis_legacy', state: 'paused_conflict' })
    const deletes = redis.applyCalls.filter(Boolean).length

    const resumed = await runLegacyLeakageScrub({ ...options, mode: 'resume' }, { database, redis })
    expect(resumed.checkpoint).toMatchObject({ phase: 'redis_legacy', state: 'paused_conflict' })
    expect(redis.applyCalls.filter(Boolean)).toHaveLength(deletes)
  })
})

describe('legacy leakage Redis adapter', () => {
  const TASK_A = '00000000-0000-4000-8000-000000000001'
  const TASK_B = '00000000-0000-4000-8000-000000000002'

  type RedisCell = Readonly<{ type: string; value?: string; entries?: readonly [string, string][] }>

  function storedEnvelope(id: number, type = 'task:status', data: Record<string, unknown> = {
    errorMessage: null,
    status: 'running',
    updatedAt: '2026-07-22T00:00:00.000Z',
  }): string {
    return JSON.stringify({ schemaVersion: 2, id, type, data })
  }

  function fakeRedisFor(cells: Map<string, RedisCell>, options: Readonly<{
    duplicate?: boolean
    loop?: boolean
    reappearLegacyAfterDelete?: boolean
    reappearMalformedLegacyAfterDelete?: boolean
    reappearV2AfterDelete?: boolean
  }> = {}) {
    const deleted: string[] = []
    const fakeRedis = {
      scan: vi.fn(async (cursor: string, _match: string, pattern: string) => {
        if (options.loop) return [cursor === '0' ? '7' : '7', []]
        const regex = new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replaceAll('\\*', '.*')}$`)
        const matched = [...cells.keys()].filter((key) => regex.test(key))
        return ['0', options.duplicate ? [...matched, ...matched] : matched]
      }),
      type: vi.fn(async (key: string) => cells.get(key)?.type ?? 'none'),
      get: vi.fn(async (key: string) => cells.get(key)?.value ?? null),
      zscan: vi.fn(async (key: string) => [
        '0',
        (cells.get(key)?.entries ?? []).flatMap(([value, score]) => [value, score]),
      ]),
      del: vi.fn(async (...keys: string[]) => {
        let count = 0
        for (const key of keys) {
          deleted.push(key)
          if (cells.delete(key)) count += 1
        }
        if (options.reappearLegacyAfterDelete) {
          cells.set(`forge:task:${TASK_B}:seq`, { type: 'string', value: '3' })
        }
        if (options.reappearMalformedLegacyAfterDelete) {
          cells.set('forge:task:not-a-uuid:history', { type: 'zset' })
        }
        if (options.reappearV2AfterDelete) {
          cells.set(`forge:task-events:v2:${TASK_B}:live`, { type: 'string', value: 'forbidden' })
        }
        return count
      }),
    }
    return { fakeRedis, deleted }
  }

  function validV2Cells(taskId = TASK_A): Map<string, RedisCell> {
    return new Map([
      [`forge:task-events:v2:${taskId}:history`, { type: 'zset', entries: [[storedEnvelope(1), '1']] }],
      [`forge:task-events:v2:${taskId}:seq`, { type: 'string', value: '1' }],
    ])
  }

  it('deletes only exact legacy UUID history/sequence keys after a write-free v2 preflight', async () => {
    const cells = validV2Cells()
    cells.set(`forge:task:${TASK_B}:history`, { type: 'zset' })
    cells.set(`forge:task:${TASK_B}:seq`, { type: 'string', value: '3' })
    const { fakeRedis, deleted } = fakeRedisFor(cells, { duplicate: true })
    const adapter = createLegacyLeakageRedisAdapter(fakeRedis as never)

    const purged = await adapter.purgeLegacyTaskEventKeys({ apply: true })
    expect(purged).toMatchObject({ complete: true, keysDeleted: 2, remainingKeys: 0, violations: 0 })
    expect(new Set(deleted)).toEqual(new Set([
      `forge:task:${TASK_B}:history`,
      `forge:task:${TASK_B}:seq`,
    ]))
    expect([...cells.keys()].sort()).toEqual([
      `forge:task-events:v2:${TASK_A}:history`,
      `forge:task-events:v2:${TASK_A}:seq`,
    ])
    const retry = await adapter.purgeLegacyTaskEventKeys({ apply: true })
    expect(retry).toMatchObject({ keysDeleted: 0, remainingKeys: 0, violations: 0 })
  })

  it('treats malformed legacy matches as violations and deletes nothing', async () => {
    const cells = validV2Cells()
    cells.set('forge:task:not-a-uuid:history', { type: 'zset' })
    cells.set(`forge:task:${TASK_B}:history:extra`, { type: 'zset' })
    const { fakeRedis, deleted } = fakeRedisFor(cells)
    const evidence = await createLegacyLeakageRedisAdapter(fakeRedis as never).purgeLegacyTaskEventKeys({ apply: true })
    expect(evidence).toMatchObject({ violations: 2, keysDeleted: 0 })
    expect(deleted).toEqual([])
  })

  it('exhaustively rejects unknown v2 suffixes, wrong types, malformed sequence, and unsafe envelopes without deletion', async () => {
    const cases: Array<readonly [string, Map<string, RedisCell>]> = [
      ['stored live channel', new Map([[`forge:task-events:v2:${TASK_A}:live`, { type: 'string', value: 'x' }]])],
      ['history wrong type', new Map([[`forge:task-events:v2:${TASK_A}:history`, { type: 'string', value: '1' }]])],
      ['malformed sequence', new Map([
        [`forge:task-events:v2:${TASK_A}:history`, { type: 'zset', entries: [[storedEnvelope(1), '1']] }],
        [`forge:task-events:v2:${TASK_A}:seq`, { type: 'string', value: '01' }],
      ])],
      ['invalid envelope', new Map([
        [`forge:task-events:v2:${TASK_A}:history`, { type: 'zset', entries: [[JSON.stringify({ schemaVersion: 2, id: 1, type: 'run:chunk', data: {} }), '1']] }],
        [`forge:task-events:v2:${TASK_A}:seq`, { type: 'string', value: '1' }],
      ])],
      ['duplicate top-level data', new Map([
        [`forge:task-events:v2:${TASK_A}:history`, { type: 'zset', entries: [[
          '{"schemaVersion":2,"id":1,"type":"task:status","data":{},"data":{"errorMessage":null,"status":"running","updatedAt":"2026-07-22T00:00:00.000Z"}}', '1',
        ]] }],
        [`forge:task-events:v2:${TASK_A}:seq`, { type: 'string', value: '1' }],
      ])],
      ['duplicate nested key', new Map([
        [`forge:task-events:v2:${TASK_A}:history`, { type: 'zset', entries: [[
          '{"schemaVersion":2,"id":1,"type":"task:status","data":{"errorMessage":null,"status":"running","updatedAt":"2026-07-22T00:00:00.000Z","nested":{"a":1,"a":2}}}', '1',
        ]] }],
        [`forge:task-events:v2:${TASK_A}:seq`, { type: 'string', value: '1' }],
      ])],
      ['escaped-equivalent duplicate key hiding a sentinel', new Map([
        [`forge:task-events:v2:${TASK_A}:history`, { type: 'zset', entries: [[
          String.raw`{"schemaVersion":2,"id":1,"type":"task:status","data":{"errorMessage":null,"\u0065rrorMessage":"RAW-SENTINEL","status":"running","updatedAt":"2026-07-22T00:00:00.000Z"}}`, '1',
        ]] }],
        [`forge:task-events:v2:${TASK_A}:seq`, { type: 'string', value: '1' }],
      ])],
      ['score mismatch', new Map([
        [`forge:task-events:v2:${TASK_A}:history`, { type: 'zset', entries: [[storedEnvelope(2), '1']] }],
        [`forge:task-events:v2:${TASK_A}:seq`, { type: 'string', value: '2' }],
      ])],
      ['non-integral score', new Map([
        [`forge:task-events:v2:${TASK_A}:history`, { type: 'zset', entries: [[storedEnvelope(1), '1.5']] }],
        [`forge:task-events:v2:${TASK_A}:seq`, { type: 'string', value: '1' }],
      ])],
      ['incomplete pair', new Map([
        [`forge:task-events:v2:${TASK_A}:seq`, { type: 'string', value: '1' }],
      ])],
      ['sequence behind history', new Map([
        [`forge:task-events:v2:${TASK_A}:history`, { type: 'zset', entries: [[storedEnvelope(2), '2']] }],
        [`forge:task-events:v2:${TASK_A}:seq`, { type: 'string', value: '1' }],
      ])],
    ]
    for (const [, cells] of cases) {
      const { fakeRedis, deleted } = fakeRedisFor(cells)
      const adapter = createLegacyLeakageRedisAdapter(fakeRedis as never)
      const v2 = await adapter.scanV2TaskEventHistory(['RAW-SENTINEL'])
      expect(v2.violations).toBeGreaterThan(0)
      const purge = await adapter.purgeLegacyTaskEventKeys({ apply: true, sentinels: ['RAW-SENTINEL'] })
      expect(purge.keysDeleted).toBe(0)
      expect(deleted).toEqual([])
    }
  })

  it('detects post-delete v2 drift and cursor loops without a v2 deletion command', async () => {
    const cells = validV2Cells()
    cells.set(`forge:task:${TASK_B}:history`, { type: 'zset' })
    const drift = fakeRedisFor(cells, { reappearV2AfterDelete: true })
    const adapter = createLegacyLeakageRedisAdapter(drift.fakeRedis as never)
    const evidence = await adapter.purgeLegacyTaskEventKeys({ apply: true })
    expect(evidence.violations).toBeGreaterThan(0)
    expect(drift.deleted).toEqual([`forge:task:${TASK_B}:history`])
    expect(drift.deleted.every((key) => !key.startsWith('forge:task-events:v2:'))).toBe(true)

    const loop = fakeRedisFor(validV2Cells(), { loop: true })
    const loopEvidence = await createLegacyLeakageRedisAdapter(loop.fakeRedis as never).scanV2TaskEventHistory([])
    expect(loopEvidence.complete).toBe(false)
    expect(loop.deleted).toEqual([])

    const reappeared = fakeRedisFor(new Map([
      [`forge:task:${TASK_B}:history`, { type: 'zset' }],
    ]), { reappearLegacyAfterDelete: true })
    const reappearedEvidence = await createLegacyLeakageRedisAdapter(reappeared.fakeRedis as never)
      .purgeLegacyTaskEventKeys({ apply: true })
    expect(reappearedEvidence.remainingKeys).toBeGreaterThan(0)

    const malformedReappeared = fakeRedisFor(new Map([
      [`forge:task:${TASK_B}:history`, { type: 'zset' }],
    ]), { reappearMalformedLegacyAfterDelete: true })
    const malformedEvidence = await createLegacyLeakageRedisAdapter(malformedReappeared.fakeRedis as never)
      .purgeLegacyTaskEventKeys({ apply: true })
    expect(malformedEvidence).toMatchObject({ remainingKeys: 0, violations: 1 })
  })

  it('detects decoded duplicate JSON keys at every object level without conflating sibling objects', () => {
    expect(scanJsonObjectKeys('{"data":{},"data":{}}')).toBe('duplicate-key')
    expect(scanJsonObjectKeys('{"outer":{"key":1,"key":2}}')).toBe('duplicate-key')
    expect(scanJsonObjectKeys(String.raw`{"data":{},"\u0064ata":{}}`)).toBe('duplicate-key')
    expect(scanJsonObjectKeys('{"left":{"key":1},"right":{"key":2}}')).toBe('valid')
    expect(scanJsonObjectKeys('{')).toBe('invalid')
    expect(scanJsonObjectKeys(`${'{'.repeat(130)}${'}'.repeat(130)}`)).toBe('invalid')
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
    const envExample = await readFile('../.env.example', 'utf8')
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
      'FORGE_LEGACY_LEAKAGE_SCRUB_FINGERPRINT_KEY',
      'FORGE_LEGACY_LEAKAGE_SCRUB_FINGERPRINT_KEY_ID',
      'S4_SCRUB_POSTGRES_START',
      'S4_SCRUB_POSTGRES_AUTH_CAS_RESUME_OK',
      'S4_SCRUB_POSTGRES_ARTIFACT_LINK_RACE_OK',
    ]) {
      expect(runbook).toContain(contractText)
    }
    for (const envName of [
      'FORGE_DATABASE_ADMIN_URL',
      'FORGE_LEGACY_LEAKAGE_SCRUB_FINGERPRINT_KEY',
      'FORGE_LEGACY_LEAKAGE_SCRUB_FINGERPRINT_KEY_ID',
    ]) {
      expect(envExample).toContain(envName)
    }
    expect(runbook).toContain('Redis credential-revocation/namespace proof')
    expect(runbook).toContain('complete cross-sink production proof')
    expect(runbook).toContain('schemaVersion: 2')
    expect(runbook).toContain('sentinelSetFingerprint')
    expect(runbook).toContain('legacy_task_log_unavailable')
    expect(runbook).toContain('unknown_legacy_digest')
    expect(commandSource).toContain('process.env.FORGE_DATABASE_ADMIN_URL')
    expect(commandSource).not.toContain("getRequiredEnv('DATABASE_URL')")
    expect(commandSource).toContain("receipt.owner_issue = 179")
    expect(commandSource).toContain("predecessor.evidence_kind = 's4_expand'")
    expect(commandSource).toContain("enablement.state = 'disabled'")
    expect(commandSource).toContain("'legacy_prompt_and_event_data_zero_scan_green'")
    expect(commandSource).toContain('select distinct plan_artifact_id from architect_plan_versions')
    expect(commandSource).toContain('where version.plan_artifact_id is null')
    expect(commandSource).toContain('and version.plan_artifact_id is null')
    expect(commandSource).toContain('select a.id::text as id')
    expect(commandSource).toContain('for update')
    expect(commandSource).toContain('and not exists (')
    const identityStart = commandSource.indexOf("if (input.row.kind === 'artifact')")
    const reloadStart = commandSource.indexOf('const sourceRows =', identityStart)
    expect(identityStart).toBeGreaterThan(-1)
    expect(reloadStart).toBeGreaterThan(identityStart)
    expect(commandSource.slice(identityStart, reloadStart)).not.toContain('a.content')
    expect(commandSource.slice(reloadStart)).toContain('and not exists (')
    expect(commandSource).toContain('FORGE_LEGACY_LEAKAGE_SCRUB_FINGERPRINT_KEY')
    expect(commandSource).toContain('FORGE_LEGACY_LEAKAGE_SCRUB_FINGERPRINT_KEY_ID')
    expect(commandSource).not.toContain('createHash')
    expect(commandSource).not.toContain('historyAvailable":true')
  })

  it('keeps the accepted textual key generator and complete destructive inventory closed across policy, runbook, and help', async () => {
    const runbook = await readFile('../docs/operators/legacy-leakage-scrub-v1.md', 'utf8')
    const operatorGuide = await readFile('../docs/operator-guide.md', 'utf8')
    const environmentExample = await readFile('../.env.example', 'utf8')
    const cliHelp = legacyLeakageScrubUsage()
    const normalizeProse = (value: string) => value.replace(/\s+/g, ' ').trim()
    const normalizedRunbook = normalizeProse(runbook)
    const normalizedOperatorGuide = normalizeProse(operatorGuide)
    const normalizedEnvironmentExample = normalizeProse(
      environmentExample
        .split('\n')
        .map((line) => (line.startsWith('# ') ? line.slice(2) : line))
        .join('\n'),
    )
    const credentialSelectionClauses = [
      'In legacy mode, shared `REDIS_URL` is used only when neither dedicated URL is configured.',
      'A complete, distinct, authenticated dedicated pair takes precedence even in legacy mode.',
      'Exactly one dedicated URL is a partial pair and fails closed.',
      'Protected mode requires the complete dedicated pair and never falls back to shared `REDIS_URL`.',
    ]
    const offlineCutoverClauses = [
      'Create the Redis ACL principals and store their secrets out of process before the drain.',
      'Do not inject `FORGE_TASK_EVENT_PUBLISHER_REDIS_URL` or `FORGE_TASK_EVENT_SUBSCRIBER_REDIS_URL` into any running legacy web, worker, publisher, or subscriber process.',
      'Drain and stop every legacy process and old Server-Sent Events client before configuring replacement processes.',
      'Configure the dedicated URLs only on replacement processes while those processes remain stopped.',
      'Start the replacement processes with the dedicated URLs only after the separately authorized database activation step permits protected mode.',
    ]
    const databaseInventory = `Database mutation inventory: task_logs; eligible, unversioned legacy Architect
artifacts; work_packages; approval_gates; and the operation-scoped app_settings
checkpoint key (${LEGACY_LEAKAGE_SCRUB_CHECKPOINT_PREFIX}<operation-id>).`
    const redisBoundaries = `Redis is separate: apply/resume purge only legacy forge:task:*:history and
forge:task:*:seq keys and exhaustively validate (but never delete) stored v2
forge:task-events:v2:* keys.`
    const runbookInventoryStart = runbook.indexOf('The command has one closed database mutation inventory.')
    const runbookRedisStart = runbook.indexOf('Redis is a separate boundary, not part of that database inventory.')
    expect(runbookInventoryStart).toBeGreaterThan(-1)
    expect(runbookRedisStart).toBeGreaterThan(runbookInventoryStart)
    const runbookInventory = runbook.slice(runbookInventoryStart, runbookRedisStart)

    expect(Object.keys(LEGACY_LEAKAGE_SCRUB_DATABASE_POLICY)).toEqual([
      'task_logs', 'artifacts', 'work_packages', 'approval_gates', 'retainedAuthorities',
    ])
    expect(runbook).toContain('openssl rand -hex 32 >"$key_file"')
    expect(runbook).toContain('export FORGE_LEGACY_LEAKAGE_SCRUB_FINGERPRINT_KEY="$(<"$key_file")"')
    expect(runbook).not.toContain('openssl rand 32')
    for (const requiredInventoryTerm of [
      'task_logs.message',
      'eligible, unversioned legacy Architect',
      'artifacts.content',
      'work_packages.metadata',
      'approval_gates.metadata',
      'app_settings',
      `${LEGACY_LEAKAGE_SCRUB_CHECKPOINT_PREFIX}<operation-id>`,
    ]) expect(runbookInventory).toContain(requiredInventoryTerm)
    expect(cliHelp).toContain(databaseInventory)
    expect(cliHelp).toContain(redisBoundaries)
    expect(runbook).toContain('Redis is a separate boundary, not part of that database inventory.')
    expect(runbook).toMatch(/never repairs,\s+rewrites,\s+expires,\s+or deletes v2 evidence/)
    expect(runbook).toContain('full `forge:task-events:v2:*` prefix')
    expect(runbook).toContain('unknown or malformed v2 keys')
    expect(runbook).toContain('Expiry is not erasure.')
    expect(runbook).toContain('database-authoritative S4 runtime mode')
    expect(runbook).toContain('FORGE_TASK_EVENT_PUBLISHER_REDIS_URL')
    expect(runbook).toContain('FORGE_TASK_EVENT_SUBSCRIBER_REDIS_URL')
    for (const clause of credentialSelectionClauses) {
      expect(normalizedRunbook).toContain(clause)
      expect(normalizedOperatorGuide).toContain(clause)
      expect(normalizedEnvironmentExample).toContain(clause)
    }
    for (const clause of offlineCutoverClauses) {
      expect(normalizedRunbook).toContain(clause)
      expect(normalizedOperatorGuide).toContain(clause)
    }
    const operatorCutoverPositions = offlineCutoverClauses.map((clause) => normalizedOperatorGuide.indexOf(clause))
    const runbookCutoverPositions = offlineCutoverClauses.map((clause) => normalizedRunbook.indexOf(clause))
    expect(operatorCutoverPositions).toEqual([...operatorCutoverPositions].sort((left, right) => left - right))
    expect(runbookCutoverPositions).toEqual([...runbookCutoverPositions].sort((left, right) => left - right))
    for (const unsafeForm of [
      'While the database mode is legacy, the shared application `REDIS_URL` is the compatibility path.',
      'While the mode is legacy, the shared application `REDIS_URL` is the compatibility path.',
      'Keep placeholders blank until the DB authority has been activated',
      'Preprovision separate publisher and subscriber principals and URLs while the database mode remains legacy. Do not use them yet.',
    ]) {
      expect(normalizedRunbook).not.toContain(unsafeForm)
      expect(normalizedOperatorGuide).not.toContain(unsafeForm)
      expect(normalizedEnvironmentExample).not.toContain(unsafeForm)
    }
    expect(runbook).toMatch(/old Redis clients\s+are absent/)
    expect(runbook).toMatch(/old live connection and fresh old\s+credentials cannot write/)
    expect(runbook).toContain('FORGE_S4_REQUIRE_REDIS_TEST=1')
    expect(runbook).toContain('FORGE_S4_REDIS_ACL_TEST_REQUIRED=1')
    for (const proofContract of [
      'S4_SCRUB_REDIS_START',
      'S4_SCRUB_REDIS_V2_IMMUTABLE_OK',
      'S4_SCRUB_REDIS_PURGE_RETRY_OK',
      'S4_REDIS_ACL_ROLE_ISOLATION_OK',
      'S4_REDIS_ACL_DENIALS_OK',
      'S4_REDIS_ACL_LEGACY_REVOKED_OK',
    ]) expect(runbook).toContain(proofContract)
    expect(runbook).toMatch(/deferred complete cross-sink\s+production proof/)
    expect(operatorGuide).toContain('database-authoritative S4 runtime mode')
    expect(operatorGuide).toMatch(/Changing environment values\s+alone cannot flip the mode/)
    for (const aclToken of [
      '~forge:task-events:v2:*:history',
      '~forge:task-events:v2:*:seq',
      '&forge:task-events:v2:*:live',
      '+select|<db>',
      '+client|setinfo',
      '+zremrangebyrank',
      '+zrangebyscore',
      '+punsubscribe',
    ]) expect(operatorGuide).toContain(aclToken)
    for (const proofContract of [
      'FORGE_S4_REQUIRE_POSTGRES_TEST=1',
      'FORGE_S4_REDIS_TEST_URL=redis://localhost:6380/15',
      'FORGE_S4_REDIS_ACL_TEST_ADMIN_URL=redis://localhost:6380/14',
      'S4_SCRUB_POSTGRES_AUTH_CAS_RESUME_OK',
      'S4_REDIS_ACL_LEGACY_REVOKED_OK',
    ]) expect(operatorGuide).toContain(proofContract)
    expect(operatorGuide).not.toMatch(/redis:\/\/[^\s`]+:[^@\s`]+@/)
    expect(runbook).not.toMatch(/redis:\/\/[^\s`]+:[^@\s`]+@/)
    expect(LEGACY_LEAKAGE_SCRUB_DATABASE_POLICY).toEqual({
      task_logs: expect.objectContaining({ updated: ['message', 'front_matter', 'metadata'] }),
      artifacts: expect.objectContaining({ updated: ['content', 'metadata'] }),
      work_packages: expect.objectContaining({ updated: ['metadata'] }),
      approval_gates: expect.objectContaining({ updated: ['metadata'] }),
      retainedAuthorities: expect.any(Array),
    })
  })

  it('keeps the PostgreSQL adapter selection and mutation surface aligned with the closed policy', async () => {
    const commandSource = await readFile('scripts/scrub-legacy-leakage.ts', 'utf8')
    const contractSource = await readFile('lib/mcps/legacy-leakage-scrub.ts', 'utf8')
    for (const column of LEGACY_LEAKAGE_SCRUB_DATABASE_POLICY.task_logs.updated) {
      expect(commandSource).toContain(column)
    }
    for (const column of LEGACY_LEAKAGE_SCRUB_DATABASE_POLICY.artifacts.updated) {
      expect(commandSource).toContain(`a.${column}`)
    }
    expect(commandSource).toContain('update work_packages')
    expect(commandSource).toContain('update approval_gates')
    expect(commandSource).not.toContain('from architect_plan_entries')
    expect(contractSource).toContain("createHmac('sha256'")
    expect(contractSource).not.toContain("createHash('sha256'")
  })
})
