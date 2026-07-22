import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import fixture from './__fixtures__/local-projection-overlimit-v2.json'
import {
  inspectLocalProjectionOverlimit,
  localProjectionArchiveExitCode,
  parseArchiveLocalProjectionOverlimitArgs,
  parseInspectLocalProjectionOverlimitArgs,
  parseLocalProjectionArchiveRoutineResult,
  parseLocalProjectionOverlimitSnapshot,
  runLocalProjectionOverlimitArchive,
  type LocalProjectionArchiveDatabase,
  type LocalProjectionArchiveRoutineResult,
} from '@/lib/mcps/local-projection-overlimit-archive'
import { archiveLocalProjectionOverlimitUsage } from '@/scripts/archive-local-projection-overlimit'
import {
  inspectLocalProjectionOverlimitUsage,
  requiredLocalProjectionArchiverDatabaseUrl,
} from '@/scripts/inspect-local-projection-overlimit'

const SOURCE = fixture.legacy257.taskId
const REPLACEMENT = fixture.replacement256.taskId
const ORDINARY = fixture.ordinary256.taskId
const ACTOR = '00000000-0000-4000-8000-000000000111'
const OPERATION = '00000000-0000-4000-8000-000000000999'

function fingerprint(character: string): string {
  return `sha256:${character.repeat(64)}`
}

function result(state: LocalProjectionArchiveRoutineResult['state'], fingerprint: string): LocalProjectionArchiveRoutineResult {
  const source = parseLocalProjectionOverlimitSnapshot(
    state === 'archived' ? fixture.sourceArchived257 : fixture.legacy257,
  )
  const replacement = parseLocalProjectionOverlimitSnapshot(state === 'rolled_back'
    ? fixture.replacement256
    : state === 'archived'
      ? fixture.replacementEligible256
      : state === 'cancelled'
        ? fixture.replacementCancelled256
        : fixture.replacementPending256)
  return {
    operationId: OPERATION,
    state,
    operationFingerprint: `sha256:${fingerprint.repeat(64)}`,
    snapshot: { schemaVersion: 2, source, replacement, checkpoint: state },
  }
}

function database(overrides: Partial<LocalProjectionArchiveDatabase> = {}): LocalProjectionArchiveDatabase {
  return {
    async inspect(taskId) {
      if (taskId === SOURCE) return structuredClone(fixture.legacy257)
      if (taskId === REPLACEMENT) return structuredClone(fixture.replacement256)
      if (taskId === ORDINARY) return structuredClone(fixture.ordinary256)
      throw new Error('unknown fixture task')
    },
    async apply() { return result('validated', '5') },
    async resume() { return result('quiesced', '6') },
    async rollback() { return result('rolled_back', '7') },
    async cancel() { return result('cancelled', '8') },
    ...overrides,
  }
}

describe('local-projection over-limit operator commands', () => {
  it('keeps task 256 active and proves the exact 2,048-head boundary', async () => {
    const parsed = parseLocalProjectionOverlimitSnapshot(fixture.ordinary256)
    expect(parsed).toMatchObject({ packageCount: 256, claimable: true })
    expect(parsed.projection).toMatchObject({
      expectedHeadKindCount: 8,
      expectedHeadCount: 2048,
      actualHeadCount: 2048,
      integrityState: 'coherent',
    })
    await expect(inspectLocalProjectionOverlimit({ taskId: ORDINARY }, database())).resolves.toMatchObject({
      command: 'inspect-local-projection-overlimit',
      taskId: ORDINARY,
      snapshot: { scopeState: 'active', packageCount: 256, claimable: true },
    })
  })

  it('recognizes package 257 as a durable, non-claimable archive hold', () => {
    expect(parseLocalProjectionOverlimitSnapshot(fixture.legacy257)).toMatchObject({
      scopeState: 'archive_pending',
      packageCount: 257,
      overlimitPackageCount: 257,
      claimable: false,
      projection: {
        expectedHeadCount: 2056,
        actualHeadCount: 0,
        distinctPackageCount: 0,
        integrityState: 'missing_heads',
      },
    })
  })

  it('rejects widened, internally inconsistent, or free-form inspect snapshots', () => {
    expect(() => parseLocalProjectionOverlimitSnapshot({ ...fixture.ordinary256, title: '/private/repo' }))
      .toThrow(/unexpected snapshot shape/)
    expect(() => parseLocalProjectionOverlimitSnapshot({
      ...fixture.ordinary256,
      projection: { ...fixture.ordinary256.projection, expectedHeadCount: 2047 },
    })).toThrow(/internally inconsistent/)
    expect(() => parseLocalProjectionOverlimitSnapshot({ ...fixture.ordinary256, taskFingerprint: 'not-a-digest' }))
      .toThrow(/sha256:/)
  })

  it('parses only the exact inspect, dry-run, apply, resume, rollback, and cancel surfaces', () => {
    expect(parseInspectLocalProjectionOverlimitArgs(['--task', SOURCE])).toEqual({ taskId: SOURCE })
    expect(parseArchiveLocalProjectionOverlimitArgs([
      '--task', SOURCE, '--replacement', REPLACEMENT, '--actor', ACTOR,
    ])).toEqual({ mode: 'dry-run', sourceTaskId: SOURCE, replacementTaskId: REPLACEMENT, actorId: ACTOR })
    expect(parseArchiveLocalProjectionOverlimitArgs([
      '--task', SOURCE, '--replacement', REPLACEMENT, '--actor', ACTOR, '--apply',
    ])).toEqual({ mode: 'apply', sourceTaskId: SOURCE, replacementTaskId: REPLACEMENT, actorId: ACTOR })
    for (const mode of ['resume', 'rollback', 'cancel'] as const) {
      expect(parseArchiveLocalProjectionOverlimitArgs([
        `--${mode}`, '--operation', OPERATION, '--operation-fingerprint', fingerprint('9'), '--actor', ACTOR,
      ])).toEqual({
        mode,
        operationId: OPERATION,
        operationFingerprint: fingerprint('9'),
        actorId: ACTOR,
      })
    }
    expect(() => parseArchiveLocalProjectionOverlimitArgs([
      '--apply', '--resume', '--task', SOURCE, '--replacement', REPLACEMENT, '--actor', ACTOR,
    ])).toThrow(/Choose only one/)
    expect(() => parseArchiveLocalProjectionOverlimitArgs([
      '--resume', '--task', SOURCE, '--operation', OPERATION,
      '--operation-fingerprint', fingerprint('9'), '--actor', ACTOR,
    ])).toThrow(/not valid/)
    expect(() => parseArchiveLocalProjectionOverlimitArgs([
      '--task', SOURCE, '--replacement', SOURCE, '--actor', ACTOR,
    ])).toThrow(/different tasks/)
    expect(() => parseInspectLocalProjectionOverlimitArgs(['--task', SOURCE, '--title', 'unsafe']))
      .toThrow(/Unknown option/)
  })

  it('keeps dry-run read-only and labels both exact snapshots', async () => {
    const db = database({
      apply: vi.fn().mockRejectedValue(new Error('dry-run must not apply')),
      resume: vi.fn().mockRejectedValue(new Error('dry-run must not resume')),
      rollback: vi.fn().mockRejectedValue(new Error('dry-run must not rollback')),
      cancel: vi.fn().mockRejectedValue(new Error('dry-run must not cancel')),
    })
    const output = await runLocalProjectionOverlimitArchive({
      mode: 'dry-run', sourceTaskId: SOURCE, replacementTaskId: REPLACEMENT, actorId: ACTOR,
    }, db)
    expect(output).toMatchObject({
      mode: 'dry-run',
      source: { taskId: SOURCE, snapshot: { packageCount: 257 } },
      replacement: {
        taskId: REPLACEMENT,
        snapshot: { packageCount: 256, replacement: null, claimable: true },
      },
    })
    expect(db.apply).not.toHaveBeenCalled()
  })

  it('rejects a partially populated legacy head set before dry-run or apply', async () => {
    const apply = vi.fn(async () => result('validated', '5'))
    const inspect = vi.fn(async (taskId: string) => (
      taskId === SOURCE ? structuredClone(fixture.partialLegacy257) : structuredClone(fixture.replacement256)
    ))
    const db = database({ inspect, apply })
    await expect(runLocalProjectionOverlimitArchive({
      mode: 'dry-run', sourceTaskId: SOURCE, replacementTaskId: REPLACEMENT, actorId: ACTOR,
    }, db)).rejects.toThrow(/zero-head archive shape/)
    await expect(runLocalProjectionOverlimitArchive({
      mode: 'apply', sourceTaskId: SOURCE, replacementTaskId: REPLACEMENT, actorId: ACTOR,
    }, db)).rejects.toThrow(/zero-head archive shape/)
    expect(apply).not.toHaveBeenCalled()
  })

  it('passes task fingerprints, not replacement metadata fingerprints, to apply', async () => {
    const apply = vi.fn(async () => result('validated', '5'))
    const output = await runLocalProjectionOverlimitArchive({
      mode: 'apply', sourceTaskId: SOURCE, replacementTaskId: REPLACEMENT, actorId: ACTOR,
    }, database({ apply }))
    expect(apply).toHaveBeenCalledWith({
      sourceTaskId: SOURCE,
      replacementTaskId: REPLACEMENT,
      actorId: ACTOR,
      expectedSourceFingerprint: fixture.legacy257.taskFingerprint,
      expectedReplacementFingerprint: fixture.replacement256.taskFingerprint,
    })
    expect(output).toMatchObject({ state: 'validated', operationId: OPERATION })
    if (!('state' in output)) throw new Error('apply unexpectedly returned a dry-run result')
    expect(output.snapshot.replacement).toMatchObject({
      replacement: { sourceTaskId: SOURCE, state: 'pending', version: 1 },
      claimable: false,
    })
    expect(localProjectionArchiveExitCode(output)).toBe(2)
  })

  it('resumes safely from a committed checkpoint after a simulated crash', async () => {
    let durableState: 'validated' | 'quiesced' | 'archived' | null = null
    let durableFingerprint = ''
    const apply = vi.fn(async () => {
      durableState = 'validated'
      durableFingerprint = fingerprint('5')
      throw new Error('injected disconnect after validated checkpoint')
    })
    const resume = vi.fn(async (input: { expectedOperationFingerprint: string }) => {
      expect(input.expectedOperationFingerprint).toBe(durableFingerprint)
      durableState = durableState === 'validated' ? 'quiesced' : 'archived'
      durableFingerprint = durableState === 'quiesced' ? fingerprint('6') : fingerprint('7')
      return result(durableState, durableState === 'quiesced' ? '6' : '7')
    })
    const db = database({ apply, resume })

    await expect(runLocalProjectionOverlimitArchive({
      mode: 'apply', sourceTaskId: SOURCE, replacementTaskId: REPLACEMENT, actorId: ACTOR,
    }, db)).rejects.toThrow('injected disconnect after validated checkpoint')
    expect(durableState).toBe('validated')

    const afterCrash = await runLocalProjectionOverlimitArchive({
      mode: 'resume', operationId: OPERATION, operationFingerprint: fingerprint('5'), actorId: ACTOR,
    }, db)
    expect(afterCrash).toMatchObject({ state: 'quiesced', operationFingerprint: fingerprint('6') })
    expect(localProjectionArchiveExitCode(afterCrash)).toBe(2)

    const complete = await runLocalProjectionOverlimitArchive({
      mode: 'resume', operationId: OPERATION, operationFingerprint: fingerprint('6'), actorId: ACTOR,
    }, db)
    expect(complete).toMatchObject({
      state: 'archived',
      operationFingerprint: fingerprint('7'),
      snapshot: {
        checkpoint: 'archived',
        source: { scopeState: 'legacy_archived' },
        replacement: { replacement: { state: 'eligible', version: 2 } },
      },
    })
    expect(localProjectionArchiveExitCode(complete)).toBe(0)
    expect(resume).toHaveBeenCalledTimes(2)
  })

  it('exposes rollback and cancellation as explicit terminal routine calls', async () => {
    const rollback = vi.fn(async () => result('rolled_back', '7'))
    const cancel = vi.fn(async () => result('cancelled', '8'))
    const db = database({ rollback, cancel })
    const base = { operationId: OPERATION, operationFingerprint: fingerprint('5'), actorId: ACTOR }

    const rolledBack = await runLocalProjectionOverlimitArchive({ mode: 'rollback', ...base }, db)
    const cancelled = await runLocalProjectionOverlimitArchive({ mode: 'cancel', ...base }, db)
    if (!('state' in rolledBack) || !('state' in cancelled)) {
      throw new Error('terminal archive action unexpectedly returned a dry-run result')
    }
    expect(rollback).toHaveBeenCalledWith({
      operationId: OPERATION, actorId: ACTOR, expectedOperationFingerprint: fingerprint('5'),
    })
    expect(cancel).toHaveBeenCalledWith({
      operationId: OPERATION, actorId: ACTOR, expectedOperationFingerprint: fingerprint('5'),
    })
    expect(localProjectionArchiveExitCode(rolledBack)).toBe(0)
    expect(localProjectionArchiveExitCode(cancelled)).toBe(0)
    expect(rolledBack.snapshot.replacement).toMatchObject({ replacement: null, claimable: true })
    expect(cancelled.snapshot.replacement).toMatchObject({
      replacement: { sourceTaskId: SOURCE, state: 'cancelled', version: 2 },
      claimable: false,
    })

    const freshApply = vi.fn(async () => result('validated', 'a'))
    await expect(runLocalProjectionOverlimitArchive({
      mode: 'apply', sourceTaskId: SOURCE, replacementTaskId: REPLACEMENT, actorId: ACTOR,
    }, database({ apply: freshApply }))).resolves.toMatchObject({ state: 'validated' })
    expect(freshApply).toHaveBeenCalledOnce()
  })

  it('rejects widened or inconsistent routine result snapshots before printing', () => {
    expect(parseLocalProjectionArchiveRoutineResult(result('validated', '5'))).toMatchObject({
      state: 'validated',
      snapshot: { checkpoint: 'validated', replacement: { replacement: { state: 'pending' } } },
    })
    expect(() => parseLocalProjectionArchiveRoutineResult({
      ...result('validated', '5'),
      snapshot: { ...result('validated', '5').snapshot, title: 'unexpected' },
    })).toThrow(/snapshot is invalid/)
    expect(() => parseLocalProjectionArchiveRoutineResult({
      ...result('validated', '5'),
      snapshot: { ...result('validated', '5').snapshot, checkpoint: 'quiesced' },
    })).toThrow(/checkpoint does not match/)
    expect(() => parseLocalProjectionArchiveRoutineResult({
      ...result('validated', '5'),
      operationFingerprint: '5'.repeat(64),
    })).toThrow(/sha256:/)
    expect(() => parseLocalProjectionArchiveRoutineResult({
      ...result('validated', '5'),
      snapshot: { ...result('validated', '5').snapshot, source: fixture.partialLegacy257 },
    })).toThrow(/zero-head archive shape/)
    expect(() => parseLocalProjectionArchiveRoutineResult({
      ...result('rolled_back', '7'),
      snapshot: { ...result('rolled_back', '7').snapshot, replacement: fixture.replacementPending256 },
    })).toThrow(/unbound, coherent, claimable/)
  })

  it('keeps package scripts, command help, routines, environment, and runbook in parity', () => {
    const webRoot = fileURLToPath(new URL('..', import.meta.url))
    const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      scripts: Record<string, string>
    }
    const inspectSource = readFileSync(new URL('../scripts/inspect-local-projection-overlimit.ts', import.meta.url), 'utf8')
    const runbook = readFileSync(new URL('../../docs/operators/local-projection-overlimit-archive-v2.md', import.meta.url), 'utf8')

    expect(webRoot).toContain('/web')
    expect(packageJson.scripts['protocol:inspect-local-projection-overlimit'])
      .toBe('tsx scripts/inspect-local-projection-overlimit.ts')
    expect(packageJson.scripts['protocol:archive-local-projection-overlimit'])
      .toBe('tsx scripts/archive-local-projection-overlimit.ts')
    expect(inspectLocalProjectionOverlimitUsage()).toContain('protocol:inspect-local-projection-overlimit')
    expect(archiveLocalProjectionOverlimitUsage()).toContain('protocol:archive-local-projection-overlimit')
    expect(inspectSource).toContain('process.env.FORGE_LOCAL_PROJECTION_ARCHIVER_DATABASE_URL')
    expect(inspectSource).not.toContain('process.env.FORGE_DATABASE_ADMIN_URL')
    expect(inspectSource).not.toMatch(/\b(?:insert\s+into|update\s+[a-z_]|delete\s+from)\b/i)
    for (const routine of [
      'inspect_local_projection_overlimit_v2',
      'apply_local_projection_overlimit_archive_v2',
      'resume_local_projection_overlimit_archive_v2',
      'rollback_local_projection_overlimit_archive_v2',
      'cancel_local_projection_overlimit_archive_v2',
    ]) expect(inspectSource).toContain(`forge.${routine}`)
    for (const mode of ['--apply', '--resume', '--rollback', '--cancel']) expect(runbook).toContain(mode)
    expect(runbook).toMatch(/exit code `2`/i)
    expect(runbook).toContain('FORGE_LOCAL_PROJECTION_ARCHIVER_DATABASE_URL')
  })

  it('accepts only the exact passwordless fixed-principal database URL', () => {
    const environmentNames = [
      'FORGE_LOCAL_PROJECTION_ARCHIVER_DATABASE_URL',
      'PGPASSWORD',
      'PGPASSFILE',
      'PGSERVICE',
      'PGSERVICEFILE',
      'PGSSLPASSWORD',
    ] as const
    const prior = Object.fromEntries(environmentNames.map((name) => [name, process.env[name]]))
    try {
      for (const name of environmentNames) delete process.env[name]
      process.env.FORGE_LOCAL_PROJECTION_ARCHIVER_DATABASE_URL =
        'postgresql://forge_local_projection_archiver@database.example/forge?sslmode=verify-full'
      expect(requiredLocalProjectionArchiverDatabaseUrl()).toContain('forge_local_projection_archiver@')
      process.env.FORGE_LOCAL_PROJECTION_ARCHIVER_DATABASE_URL = 'postgresql://forge@database.example/forge'
      expect(() => requiredLocalProjectionArchiverDatabaseUrl()).toThrow(/passwordless PostgreSQL URL/)
      process.env.FORGE_LOCAL_PROJECTION_ARCHIVER_DATABASE_URL =
        'postgresql://forge_local_projection_archiver:secret@database.example/forge'
      expect(() => requiredLocalProjectionArchiverDatabaseUrl()).toThrow(/passwordless PostgreSQL URL/)
      process.env.FORGE_LOCAL_PROJECTION_ARCHIVER_DATABASE_URL =
        'postgresql://forge_local_projection_archiver@database.example/forge?password=secret'
      expect(() => requiredLocalProjectionArchiverDatabaseUrl()).toThrow(/passwordless PostgreSQL URL/)
      process.env.FORGE_LOCAL_PROJECTION_ARCHIVER_DATABASE_URL =
        'postgresql://forge_local_projection_archiver@database.example/forge?sslpassword=secret'
      expect(() => requiredLocalProjectionArchiverDatabaseUrl()).toThrow(/sslpassword/)
      process.env.FORGE_LOCAL_PROJECTION_ARCHIVER_DATABASE_URL = 'https://forge_local_projection_archiver@database.example/forge'
      expect(() => requiredLocalProjectionArchiverDatabaseUrl()).toThrow(/passwordless PostgreSQL URL/)
      process.env.FORGE_LOCAL_PROJECTION_ARCHIVER_DATABASE_URL =
        'postgresql://forge_local_projection_archiver@database.example/forge?sslmode=verify-full'
      for (const name of ['PGPASSWORD', 'PGPASSFILE', 'PGSERVICE', 'PGSERVICEFILE', 'PGSSLPASSWORD'] as const) {
        process.env[name] = name === 'PGPASSWORD' ? '' : 'inherited-credential-source'
        expect(() => requiredLocalProjectionArchiverDatabaseUrl()).toThrow(new RegExp(`${name} must be unset`))
        delete process.env[name]
      }
    } finally {
      for (const name of environmentNames) {
        const value = prior[name]
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }
  })

  it('keeps the disposable upgrade proof strict for the fixed archiver login', () => {
    const proof = readFileSync(
      new URL('../scripts/ci/sql/migration-0027-expansion-assertions.sql', import.meta.url),
      'utf8',
    )
    for (const evidence of [
      "role.rolname = 'forge_local_projection_archiver'",
      'role.rolpassword IS NULL',
      'pg_catalog.pg_db_role_setting',
      'pg_catalog.pg_auth_members',
      "has_schema_privilege('forge_local_projection_archiver', 'forge', 'usage')",
      'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER',
      'inspect_local_projection_overlimit_v2(uuid)',
      'apply_local_projection_overlimit_archive_v2(uuid,uuid,uuid,text,text)',
      'resume_local_projection_overlimit_archive_v2(uuid,uuid,text)',
      'rollback_local_projection_overlimit_archive_v2(uuid,uuid,text)',
      'cancel_local_projection_overlimit_archive_v2(uuid,uuid,text)',
      'acl.grantee = 0',
      'can execute a non-archive forge routine',
    ]) expect(proof).toContain(evidence)
  })
})
