export const LOCAL_PROJECTION_ARCHIVE_SCHEMA_VERSION = 2 as const
export const LOCAL_PROJECTION_PACKAGE_LIMIT = 256 as const
export const LOCAL_PROJECTION_HEAD_KINDS = 8 as const

export type LocalProjectionScopeState = 'active' | 'archive_pending' | 'legacy_archived'
export type LocalProjectionReplacementState = 'pending' | 'eligible' | 'cancelled'
export type LocalProjectionIntegrityState = 'coherent' | 'over_limit' | 'missing_heads' | 'mismatched_heads'
export type LocalProjectionArchiveState = 'validated' | 'quiesced' | 'archived' | 'rolled_back' | 'cancelled'

export type LocalProjectionOverlimitSnapshot = Readonly<{
  schemaVersion: 2
  taskId: string
  scopeState: LocalProjectionScopeState
  packageCount: number
  overlimitPackageCount: number | null
  replacement: Readonly<{
    sourceTaskId: string
    state: LocalProjectionReplacementState
    version: number
    fingerprint: string
  }> | null
  projection: Readonly<{
    expectedHeadKindCount: 8
    expectedHeadCount: number
    actualHeadCount: number
    distinctPackageCount: number
    headsFingerprint: string
    aggregateFingerprint: string
    integrityState: LocalProjectionIntegrityState
  }>
  taskFingerprint: string
  claimable: boolean
}>

export type LocalProjectionArchiveRoutineResult = Readonly<{
  operationId: string
  state: LocalProjectionArchiveState
  operationFingerprint: string
  snapshot: Readonly<{
    schemaVersion: 2
    source: LocalProjectionOverlimitSnapshot
    replacement: LocalProjectionOverlimitSnapshot
    checkpoint: LocalProjectionArchiveState
  }>
}>

export type LocalProjectionArchiveDryRunResult = Readonly<{
  schemaVersion: 2
  command: 'archive-local-projection-overlimit'
  mode: 'dry-run'
  actorId: string
  source: Readonly<{ taskId: string; snapshot: LocalProjectionOverlimitSnapshot }>
  replacement: Readonly<{ taskId: string; snapshot: LocalProjectionOverlimitSnapshot }>
}>

export type LocalProjectionArchiveRunResult =
  | LocalProjectionArchiveDryRunResult
  | LocalProjectionArchiveRoutineResult

export interface LocalProjectionArchiveDatabase {
  inspect(taskId: string): Promise<unknown>
  apply(input: Readonly<{
    sourceTaskId: string
    replacementTaskId: string
    actorId: string
    expectedSourceFingerprint: string
    expectedReplacementFingerprint: string
  }>): Promise<unknown>
  resume(input: Readonly<{ operationId: string; actorId: string; expectedOperationFingerprint: string }>): Promise<unknown>
  rollback(input: Readonly<{ operationId: string; actorId: string; expectedOperationFingerprint: string }>): Promise<unknown>
  cancel(input: Readonly<{ operationId: string; actorId: string; expectedOperationFingerprint: string }>): Promise<unknown>
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SHA256 = /^sha256:[0-9a-f]{64}$/
const POSTGRES_INTEGER_MAX = 2_147_483_647

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= POSTGRES_INTEGER_MAX
}

function assertUuid(name: string, value: string): string {
  if (!UUID.test(value)) throw new Error(`${name} must be a UUID.`)
  return value.toLowerCase()
}

export function assertSha256(name: string, value: string): string {
  if (!SHA256.test(value)) throw new Error(`${name} must use the exact sha256:<64 lowercase hex> format.`)
  return value
}

export function parseLocalProjectionOverlimitSnapshot(value: unknown): LocalProjectionOverlimitSnapshot {
  if (!isRecord(value) || !hasExactKeys(value, [
    'schemaVersion', 'taskId', 'scopeState', 'packageCount', 'overlimitPackageCount',
    'replacement', 'projection', 'taskFingerprint', 'claimable',
  ])) {
    throw new Error('The fixed-principal inspect routine returned an unexpected snapshot shape.')
  }
  if (value.schemaVersion !== LOCAL_PROJECTION_ARCHIVE_SCHEMA_VERSION) {
    throw new Error('The fixed-principal inspect routine returned an unsupported schema version.')
  }
  if (typeof value.taskId !== 'string' || !UUID.test(value.taskId)) throw new Error('The inspect snapshot task ID is invalid.')
  if (!['active', 'archive_pending', 'legacy_archived'].includes(String(value.scopeState))) {
    throw new Error('The inspect snapshot scope state is invalid.')
  }
  if (!isNonNegativeInteger(value.packageCount)) throw new Error('The inspect snapshot package count is invalid.')
  if (value.overlimitPackageCount !== null && !isNonNegativeInteger(value.overlimitPackageCount)) {
    throw new Error('The inspect snapshot over-limit count is invalid.')
  }
  if (typeof value.claimable !== 'boolean') throw new Error('The inspect snapshot claimable flag is invalid.')
  if (typeof value.taskFingerprint !== 'string') throw new Error('The inspect snapshot task fingerprint is invalid.')
  assertSha256('The inspect snapshot task fingerprint', value.taskFingerprint)

  if (value.replacement !== null) {
    if (!isRecord(value.replacement) || !hasExactKeys(value.replacement, [
      'sourceTaskId', 'state', 'version', 'fingerprint',
    ])) throw new Error('The inspect snapshot replacement is invalid.')
    if (typeof value.replacement.sourceTaskId !== 'string' || !UUID.test(value.replacement.sourceTaskId)) {
      throw new Error('The inspect snapshot replacement source is invalid.')
    }
    if (!['pending', 'eligible', 'cancelled'].includes(String(value.replacement.state))) {
      throw new Error('The inspect snapshot replacement state is invalid.')
    }
    if (!Number.isSafeInteger(value.replacement.version) || Number(value.replacement.version) < 1) {
      throw new Error('The inspect snapshot replacement version is invalid.')
    }
    if (typeof value.replacement.fingerprint !== 'string') {
      throw new Error('The inspect snapshot replacement fingerprint is invalid.')
    }
    assertSha256('The inspect snapshot replacement fingerprint', value.replacement.fingerprint)
  }

  if (!isRecord(value.projection) || !hasExactKeys(value.projection, [
    'expectedHeadKindCount', 'expectedHeadCount', 'actualHeadCount', 'distinctPackageCount',
    'headsFingerprint', 'aggregateFingerprint', 'integrityState',
  ])) throw new Error('The inspect snapshot projection is invalid.')
  if (value.projection.expectedHeadKindCount !== LOCAL_PROJECTION_HEAD_KINDS) {
    throw new Error('The inspect snapshot did not use the closed eight-head projection.')
  }
  for (const key of ['expectedHeadCount', 'actualHeadCount', 'distinctPackageCount'] as const) {
    if (!isNonNegativeInteger(value.projection[key])) throw new Error(`The inspect snapshot ${key} is invalid.`)
  }
  if (value.projection.expectedHeadCount !== value.packageCount * LOCAL_PROJECTION_HEAD_KINDS) {
    throw new Error('The inspect snapshot expected head count is internally inconsistent.')
  }
  for (const key of ['headsFingerprint', 'aggregateFingerprint'] as const) {
    if (typeof value.projection[key] !== 'string') throw new Error(`The inspect snapshot ${key} is invalid.`)
    assertSha256(`The inspect snapshot ${key}`, value.projection[key])
  }
  if (!['coherent', 'over_limit', 'missing_heads', 'mismatched_heads'].includes(String(value.projection.integrityState))) {
    throw new Error('The inspect snapshot projection integrity state is invalid.')
  }
  const snapshot = value as LocalProjectionOverlimitSnapshot
  const { projection } = snapshot
  if (
    (projection.integrityState === 'coherent' && (
      snapshot.packageCount > LOCAL_PROJECTION_PACKAGE_LIMIT
      || projection.actualHeadCount !== projection.expectedHeadCount
      || projection.distinctPackageCount !== snapshot.packageCount
    ))
    || (projection.integrityState === 'over_limit' && (
      snapshot.packageCount <= LOCAL_PROJECTION_PACKAGE_LIMIT
      || projection.actualHeadCount !== projection.expectedHeadCount
      || projection.distinctPackageCount !== snapshot.packageCount
    ))
    || (projection.integrityState === 'missing_heads'
      && projection.actualHeadCount === projection.expectedHeadCount)
    || (projection.integrityState === 'mismatched_heads'
      && projection.actualHeadCount !== projection.expectedHeadCount)
  ) throw new Error('The inspect snapshot projection state is internally inconsistent.')

  if (
    (snapshot.scopeState === 'active'
      && snapshot.overlimitPackageCount !== null
      && snapshot.overlimitPackageCount <= LOCAL_PROJECTION_PACKAGE_LIMIT)
    || (snapshot.scopeState !== 'active'
      && (snapshot.overlimitPackageCount === null
        || snapshot.overlimitPackageCount <= LOCAL_PROJECTION_PACKAGE_LIMIT))
  ) throw new Error('The inspect snapshot scope and over-limit count are inconsistent.')

  if (snapshot.replacement !== null && (
    snapshot.scopeState !== 'active'
    || snapshot.overlimitPackageCount !== null
    || snapshot.packageCount > LOCAL_PROJECTION_PACKAGE_LIMIT
    || snapshot.projection.integrityState !== 'coherent'
    || snapshot.replacement.sourceTaskId.toLowerCase() === snapshot.taskId.toLowerCase()
  )) throw new Error('The inspect snapshot replacement binding is inconsistent.')

  const expectedClaimable = snapshot.scopeState === 'active'
    && snapshot.overlimitPackageCount === null
    && snapshot.packageCount <= LOCAL_PROJECTION_PACKAGE_LIMIT
    && snapshot.projection.integrityState === 'coherent'
    && snapshot.replacement === null
  if (snapshot.claimable !== expectedClaimable) {
    throw new Error('The inspect snapshot claimable flag is inconsistent.')
  }
  return snapshot
}

export function parseLocalProjectionArchiveRoutineResult(value: unknown): LocalProjectionArchiveRoutineResult {
  if (!isRecord(value) || !hasExactKeys(value, ['operationId', 'state', 'operationFingerprint', 'snapshot'])) {
    throw new Error('The fixed-principal archive routine returned an unexpected result shape.')
  }
  if (typeof value.operationId !== 'string' || !UUID.test(value.operationId)) {
    throw new Error('The archive operation ID is invalid.')
  }
  if (!['validated', 'quiesced', 'archived', 'rolled_back', 'cancelled'].includes(String(value.state))) {
    throw new Error('The archive operation state is invalid.')
  }
  if (typeof value.operationFingerprint !== 'string') throw new Error('The archive operation fingerprint is invalid.')
  assertSha256('The archive operation fingerprint', value.operationFingerprint)
  if (!isRecord(value.snapshot) || !hasExactKeys(value.snapshot, [
    'schemaVersion', 'source', 'replacement', 'checkpoint',
  ])) throw new Error('The archive operation snapshot is invalid.')
  if (value.snapshot.schemaVersion !== LOCAL_PROJECTION_ARCHIVE_SCHEMA_VERSION) {
    throw new Error('The archive operation snapshot schema version is invalid.')
  }
  if (value.snapshot.checkpoint !== value.state) {
    throw new Error('The archive operation checkpoint does not match its state.')
  }
  const state = value.state as LocalProjectionArchiveState
  const source = parseLocalProjectionOverlimitSnapshot(value.snapshot.source)
  const replacement = parseLocalProjectionOverlimitSnapshot(value.snapshot.replacement)
  if (source.taskId.toLowerCase() === replacement.taskId.toLowerCase()) {
    throw new Error('The archive operation source and replacement task IDs must differ.')
  }
  assertArchiveSourceSnapshot(source, state === 'archived' ? 'legacy_archived' : 'archive_pending')
  if (state === 'rolled_back') {
    assertUnboundReplacementSnapshot(replacement)
  } else {
    const expectedReplacementState = state === 'archived'
      ? 'eligible'
      : state === 'cancelled' ? 'cancelled' : 'pending'
    const expectedVersion = expectedReplacementState === 'pending' ? 1 : 2
    if (
      replacement.replacement?.sourceTaskId.toLowerCase() !== source.taskId.toLowerCase()
      || replacement.replacement.state !== expectedReplacementState
      || replacement.replacement.version !== expectedVersion
      || replacement.claimable
    ) throw new Error(`The archive operation ${state} replacement snapshot is invalid.`)
  }
  return {
    operationId: value.operationId,
    state,
    operationFingerprint: value.operationFingerprint,
    snapshot: {
      schemaVersion: LOCAL_PROJECTION_ARCHIVE_SCHEMA_VERSION,
      source,
      replacement,
      checkpoint: state,
    },
  }
}

function sourceHasCompleteOrZeroLegacyHeads(snapshot: LocalProjectionOverlimitSnapshot): boolean {
  return (
    snapshot.projection.integrityState === 'over_limit'
    && snapshot.projection.actualHeadCount === snapshot.projection.expectedHeadCount
    && snapshot.projection.distinctPackageCount === snapshot.packageCount
  ) || (
    snapshot.projection.integrityState === 'missing_heads'
    && snapshot.projection.actualHeadCount === 0
    && snapshot.projection.distinctPackageCount === 0
  )
}

function assertArchiveSourceSnapshot(
  snapshot: LocalProjectionOverlimitSnapshot,
  expectedScope: 'archive_pending' | 'legacy_archived',
): void {
  if (
    snapshot.scopeState !== expectedScope
    || snapshot.packageCount <= LOCAL_PROJECTION_PACKAGE_LIMIT
    || snapshot.overlimitPackageCount !== snapshot.packageCount
    || snapshot.replacement !== null
    || snapshot.claimable
    || !sourceHasCompleteOrZeroLegacyHeads(snapshot)
  ) throw new Error('The source is not the exact complete-head or migration-0026 zero-head archive shape.')
}

function assertUnboundReplacementSnapshot(snapshot: LocalProjectionOverlimitSnapshot): void {
  if (
    snapshot.scopeState !== 'active'
    || snapshot.packageCount > LOCAL_PROJECTION_PACKAGE_LIMIT
    || snapshot.overlimitPackageCount !== null
    || snapshot.replacement !== null
    || snapshot.projection.integrityState !== 'coherent'
    || !snapshot.claimable
  ) throw new Error('The replacement must be an unbound, coherent, claimable task with at most 256 packages.')
}

function assertArchivePairEligible(
  source: LocalProjectionOverlimitSnapshot,
  replacement: LocalProjectionOverlimitSnapshot,
): void {
  assertArchiveSourceSnapshot(source, 'archive_pending')
  assertUnboundReplacementSnapshot(replacement)
}

export type InspectLocalProjectionOverlimitCli = Readonly<{ taskId: string }>

export function parseInspectLocalProjectionOverlimitArgs(argv: readonly string[]): InspectLocalProjectionOverlimitCli {
  let taskId: string | undefined
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag !== '--task') throw new Error(`Unknown option: ${flag}`)
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) throw new Error('Missing value for --task.')
    if (taskId) throw new Error('--task may be provided only once.')
    taskId = value
    index += 1
  }
  if (!taskId) throw new Error('--task is required.')
  return { taskId: assertUuid('--task', taskId) }
}

export type LocalProjectionArchiveMode = 'dry-run' | 'apply' | 'resume' | 'rollback' | 'cancel'
export type ArchiveLocalProjectionOverlimitCli = Readonly<{
  mode: LocalProjectionArchiveMode
  actorId: string
  sourceTaskId?: string
  replacementTaskId?: string
  operationId?: string
  operationFingerprint?: string
}>

export function parseArchiveLocalProjectionOverlimitArgs(argv: readonly string[]): ArchiveLocalProjectionOverlimitCli {
  let mode: LocalProjectionArchiveMode = 'dry-run'
  const values = new Map<string, string>()
  const actionFlags = new Map<string, LocalProjectionArchiveMode>([
    ['--apply', 'apply'], ['--resume', 'resume'], ['--rollback', 'rollback'], ['--cancel', 'cancel'],
  ])
  let actionSeen = false

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    const action = actionFlags.get(flag)
    if (action) {
      if (actionSeen) throw new Error('Choose only one of --apply, --resume, --rollback, or --cancel.')
      mode = action
      actionSeen = true
      continue
    }
    if (!['--task', '--replacement', '--actor', '--operation', '--operation-fingerprint'].includes(flag)) {
      throw new Error(`Unknown option: ${flag}`)
    }
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}.`)
    if (values.has(flag)) throw new Error(`${flag} may be provided only once.`)
    values.set(flag, value)
    index += 1
  }

  const actor = values.get('--actor')
  if (!actor) throw new Error('--actor is required.')
  const actorId = assertUuid('--actor', actor)
  if (mode === 'dry-run' || mode === 'apply') {
    const task = values.get('--task')
    const replacement = values.get('--replacement')
    if (!task || !replacement) throw new Error('--task and --replacement are required for dry-run and apply.')
    if (values.has('--operation') || values.has('--operation-fingerprint')) {
      throw new Error('--operation and --operation-fingerprint are only valid for resume, rollback, or cancel.')
    }
    const sourceTaskId = assertUuid('--task', task)
    const replacementTaskId = assertUuid('--replacement', replacement)
    if (sourceTaskId === replacementTaskId) throw new Error('--task and --replacement must identify different tasks.')
    return { mode, actorId, sourceTaskId, replacementTaskId }
  }

  if (values.has('--task') || values.has('--replacement')) {
    throw new Error('--task and --replacement are not valid for resume, rollback, or cancel.')
  }
  const operation = values.get('--operation')
  const fingerprint = values.get('--operation-fingerprint')
  if (!operation || !fingerprint) {
    throw new Error('--operation and --operation-fingerprint are required for resume, rollback, and cancel.')
  }
  return {
    mode,
    actorId,
    operationId: assertUuid('--operation', operation),
    operationFingerprint: assertSha256('--operation-fingerprint', fingerprint),
  }
}

export async function inspectLocalProjectionOverlimit(
  cli: InspectLocalProjectionOverlimitCli,
  database: Pick<LocalProjectionArchiveDatabase, 'inspect'>,
): Promise<Record<string, unknown>> {
  const snapshot = parseLocalProjectionOverlimitSnapshot(await database.inspect(cli.taskId))
  if (snapshot.taskId.toLowerCase() !== cli.taskId) {
    throw new Error('The inspect routine returned a different task ID than requested.')
  }
  return {
    schemaVersion: LOCAL_PROJECTION_ARCHIVE_SCHEMA_VERSION,
    command: 'inspect-local-projection-overlimit',
    taskId: cli.taskId,
    snapshot,
  }
}

export async function runLocalProjectionOverlimitArchive(
  cli: ArchiveLocalProjectionOverlimitCli,
  database: LocalProjectionArchiveDatabase,
): Promise<LocalProjectionArchiveRunResult> {
  if (cli.mode === 'dry-run' || cli.mode === 'apply') {
    const source = parseLocalProjectionOverlimitSnapshot(await database.inspect(cli.sourceTaskId!))
    const replacement = parseLocalProjectionOverlimitSnapshot(await database.inspect(cli.replacementTaskId!))
    if (source.taskId.toLowerCase() !== cli.sourceTaskId || replacement.taskId.toLowerCase() !== cli.replacementTaskId) {
      throw new Error('The inspect routine returned a different task ID than requested.')
    }
    assertArchivePairEligible(source, replacement)
    if (cli.mode === 'dry-run') {
      return {
        schemaVersion: LOCAL_PROJECTION_ARCHIVE_SCHEMA_VERSION,
        command: 'archive-local-projection-overlimit',
        mode: cli.mode,
        actorId: cli.actorId,
        source: { taskId: cli.sourceTaskId, snapshot: source },
        replacement: { taskId: cli.replacementTaskId, snapshot: replacement },
      }
    }
    return parseLocalProjectionArchiveRoutineResult(await database.apply({
      sourceTaskId: cli.sourceTaskId!,
      replacementTaskId: cli.replacementTaskId!,
      actorId: cli.actorId,
      expectedSourceFingerprint: source.taskFingerprint,
      expectedReplacementFingerprint: replacement.taskFingerprint,
    }))
  }

  const input = {
    operationId: cli.operationId!,
    actorId: cli.actorId,
    expectedOperationFingerprint: cli.operationFingerprint!,
  }
  if (cli.mode === 'resume') return parseLocalProjectionArchiveRoutineResult(await database.resume(input))
  if (cli.mode === 'rollback') return parseLocalProjectionArchiveRoutineResult(await database.rollback(input))
  return parseLocalProjectionArchiveRoutineResult(await database.cancel(input))
}

export function localProjectionArchiveExitCode(result: LocalProjectionArchiveRunResult): number {
  return 'state' in result && (result.state === 'validated' || result.state === 'quiesced') ? 2 : 0
}
