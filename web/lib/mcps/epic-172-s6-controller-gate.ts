import { createHash } from 'node:crypto'
import {
  EPIC_172_S6_SUITE_COMMANDS,
  epic172S6SuiteManifest,
} from './epic-172-s6-suite-contract'
import {
  verifyEpic172S6ReleaseEvidenceInput,
  assertEpic172S6ReleaseOrderOwnership,
  EPIC_172_S6_RECORDABLE_EVIDENCE_KINDS,
  type Epic172S6RecordableEvidenceKind,
} from './epic-172-s6-release-adapter'

const DIGEST = /^sha256:[a-f0-9]{64}$/
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const SHA = /^[a-f0-9]{40}$|^[a-f0-9]{64}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const BUILD_VALUE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/
const GRAPH_NODE_BUILD_SLOTS = Object.freeze([
  'issue_179_s4',
  'issue_180_s5',
  'issue_181_s6',
] as const)
const ENABLED_BUILD_SLOTS = Object.freeze([
  'issue_178_s3',
  'issue_179_s4',
  'issue_180_s5',
  'issue_181_s6',
] as const)
const SUITE_BUDGET_SECONDS = Object.freeze({
  'test:mcp:contract': 60,
  'test:mcp:postgres': 240,
  'test:mcp:issuance': 300,
  'e2e:mcp-operator': 240,
  'test:mcp:host-boundary': 420,
} as const)
const REQUIRED_SUITE_COMMANDS = Object.freeze([...new Set(Object.values(EPIC_172_S6_SUITE_COMMANDS))].sort())

export type Epic172S6ControllerPhase = 'pre_activation' | 'post_activation' | 'enabled_build_tests_green'
export type Epic172S6ControllerFailureReason =
  | 'signature_invalid'
  | 'malformed_evidence'
  | 'cross_bound_evidence'
  | 'manifest_mismatch'
  | 'suite_incomplete'
  | 'suite_failed'
  | 'suite_not_concurrent'
  | 'suite_retried_or_skipped'
  | 'budget_exceeded'
  | 'output_scan_failed'
  | 'teardown_failed'
  | 'destruction_missing'
  | 'lease_expired'
  | 'outer_deadline_expired'

export type Epic172S6ExternalEvidenceBundle = Readonly<{
  schemaVersion: 2
  phase: Epic172S6ControllerPhase
  controllerRunId: string
  jobId: string
  reviewedSha: string
  githubAppId: string
  exactBuilds: readonly string[]
  epoch: number | null
  signerKeyId: string
  signerGeneration: number
  imageDigest: string
  bootId: string
  databaseStartedAt: string
  completedAt: string
  leaseExpiresAt: string
  outerExpiresAt: string
  phaseDurations: Readonly<{
    orchestrationSeconds: number
    preflightSeconds: number
    suitePhaseSeconds: number
    outputTeardownDestructionSeconds: number
    verificationRecordingSeconds: number
  }>
  suitesExecutedConcurrently: boolean
  suiteManifestDigest: string
  executedIdsDigest: string
  outputScanDigest: string
  outputScanPassed: boolean
  preflightReceiptDigest: string
  teardownReceiptDigest: string
  teardownZeroResidue: boolean
  destructionReceiptDigest: string
  destructionVerified: boolean
  releaseBindings: Readonly<{
    predecessorReceiptDigest: string
    linkedReceiptDigest: string | null
    signerLifecycleDigest: string
    writersIngressAndIssuanceDisabled: boolean
  }>
  suites: readonly Readonly<{
    command: keyof typeof SUITE_BUDGET_SECONDS
    durationSeconds: number
    firstAttempt: boolean
    retryCount: number
    skippedCount: number
    status: 'passed' | 'failed' | 'timed_out'
  }>[]
}>

export type Epic172S6ExternalSignatureVerifier = (
  untrustedInput: unknown,
) => Readonly<{ ok: true; value: unknown }> | Readonly<{ ok: false }>

export type Epic172S6ExpectedControllerBindings = Readonly<Pick<
  Epic172S6ExternalEvidenceBundle,
  | 'bootId'
  | 'controllerRunId'
  | 'epoch'
  | 'exactBuilds'
  | 'githubAppId'
  | 'imageDigest'
  | 'jobId'
  | 'phase'
  | 'releaseBindings'
  | 'reviewedSha'
  | 'signerGeneration'
  | 'signerKeyId'
>>

export type Epic172S6ControllerGateResult =
  | Readonly<{
    disposition: 'eligible_for_step0_recording'
    targetKind: 's6_pre_activation_green' | 's6_post_activation_green' | 'enabled_build_tests_green'
    bundle: Epic172S6ExternalEvidenceBundle
    liveAuthorityGranted: false
  }>
  | Readonly<{
    disposition: 'disabled'
    reason: Epic172S6ControllerFailureReason
    liveAuthorityGranted: false
  }>

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error('Unsupported suite manifest number.')
    return String(value)
  }
  if (typeof value === 'string') return JSON.stringify(value.normalize('NFC'))
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (typeof value !== 'object') throw new Error('Unsupported suite manifest value.')
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
}

export const EPIC_172_S6_SUITE_MANIFEST_DIGEST = `sha256:${createHash('sha256')
  .update(canonicalJson(epic172S6SuiteManifest), 'utf8')
  .digest('hex')}`

export const EPIC_172_S6_EXECUTED_IDS_DIGEST = `sha256:${createHash('sha256')
  .update(epic172S6SuiteManifest.partitions.flatMap((partition) => partition.executionKeys).sort().join('\n'), 'utf8')
  .digest('hex')}`

function disabled(reason: Epic172S6ControllerFailureReason): Epic172S6ControllerGateResult {
  return Object.freeze({ disposition: 'disabled', reason, liveAuthorityGranted: false })
}

function validTime(value: string): number | null {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? parsed : null
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index])
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function parseEpic172S6ExternalEvidenceBundle(value: unknown): Epic172S6ExternalEvidenceBundle {
  if (!isRecord(value) || !exactKeys(value, [
    'bootId',
    'completedAt',
    'controllerRunId',
    'databaseStartedAt',
    'destructionReceiptDigest',
    'destructionVerified',
    'epoch',
    'exactBuilds',
    'executedIdsDigest',
    'githubAppId',
    'imageDigest',
    'jobId',
    'leaseExpiresAt',
    'outerExpiresAt',
    'outputScanDigest',
    'outputScanPassed',
    'phaseDurations',
    'phase',
    'preflightReceiptDigest',
    'releaseBindings',
    'reviewedSha',
    'schemaVersion',
    'signerGeneration',
    'signerKeyId',
    'suiteManifestDigest',
    'suites',
    'suitesExecutedConcurrently',
    'teardownReceiptDigest',
    'teardownZeroResidue',
  ])) {
    throw new Error('S6 controller evidence has an invalid top-level shape.')
  }
  const expectedBuildSlots = value.phase === 'enabled_build_tests_green'
    ? ENABLED_BUILD_SLOTS
    : GRAPH_NODE_BUILD_SLOTS
  if (
    value.schemaVersion !== 2
    || !['pre_activation', 'post_activation', 'enabled_build_tests_green'].includes(String(value.phase))
    || typeof value.controllerRunId !== 'string' || !ID.test(value.controllerRunId)
    || typeof value.jobId !== 'string' || !ID.test(value.jobId)
    || typeof value.bootId !== 'string' || !ID.test(value.bootId)
    || typeof value.reviewedSha !== 'string' || !SHA.test(value.reviewedSha)
    || typeof value.githubAppId !== 'string' || !/^[1-9]\d{0,19}$/.test(value.githubAppId)
    || !Array.isArray(value.exactBuilds) || value.exactBuilds.length !== expectedBuildSlots.length
    || value.exactBuilds.some((build, index) => (
      typeof build !== 'string'
      || !build.startsWith(`${expectedBuildSlots[index]}@`)
      || !BUILD_VALUE.test(build.slice(expectedBuildSlots[index].length + 1))
    ))
    || !(value.epoch === null || (Number.isSafeInteger(value.epoch) && Number(value.epoch) > 0))
    || typeof value.signerKeyId !== 'string' || !UUID.test(value.signerKeyId)
    || !Number.isSafeInteger(value.signerGeneration) || Number(value.signerGeneration) <= 0
    || typeof value.imageDigest !== 'string' || !DIGEST.test(value.imageDigest)
    || typeof value.suiteManifestDigest !== 'string' || !DIGEST.test(value.suiteManifestDigest)
    || typeof value.executedIdsDigest !== 'string' || !DIGEST.test(value.executedIdsDigest)
    || typeof value.outputScanDigest !== 'string' || !DIGEST.test(value.outputScanDigest)
    || typeof value.preflightReceiptDigest !== 'string' || !DIGEST.test(value.preflightReceiptDigest)
    || typeof value.teardownReceiptDigest !== 'string' || !DIGEST.test(value.teardownReceiptDigest)
    || typeof value.destructionReceiptDigest !== 'string' || !DIGEST.test(value.destructionReceiptDigest)
    || typeof value.outputScanPassed !== 'boolean'
    || typeof value.teardownZeroResidue !== 'boolean'
    || typeof value.destructionVerified !== 'boolean'
    || typeof value.databaseStartedAt !== 'string'
    || typeof value.completedAt !== 'string'
    || typeof value.leaseExpiresAt !== 'string'
    || typeof value.outerExpiresAt !== 'string'
    || !isRecord(value.phaseDurations)
    || !exactKeys(value.phaseDurations, [
      'orchestrationSeconds',
      'outputTeardownDestructionSeconds',
      'preflightSeconds',
      'suitePhaseSeconds',
      'verificationRecordingSeconds',
    ])
    || Object.values(value.phaseDurations).some((duration) => !Number.isSafeInteger(duration) || Number(duration) < 0)
    || typeof value.suitesExecutedConcurrently !== 'boolean'
    || !isRecord(value.releaseBindings)
    || !exactKeys(value.releaseBindings, [
      'linkedReceiptDigest',
      'predecessorReceiptDigest',
      'signerLifecycleDigest',
      'writersIngressAndIssuanceDisabled',
    ])
    || typeof value.releaseBindings.predecessorReceiptDigest !== 'string'
    || !DIGEST.test(value.releaseBindings.predecessorReceiptDigest)
    || !(value.releaseBindings.linkedReceiptDigest === null || (
      typeof value.releaseBindings.linkedReceiptDigest === 'string'
      && DIGEST.test(value.releaseBindings.linkedReceiptDigest)
    ))
    || typeof value.releaseBindings.signerLifecycleDigest !== 'string'
    || !DIGEST.test(value.releaseBindings.signerLifecycleDigest)
    || typeof value.releaseBindings.writersIngressAndIssuanceDisabled !== 'boolean'
    || !Array.isArray(value.suites)
  ) {
    throw new Error('S6 controller evidence contains an invalid field.')
  }

  const suites = value.suites.map((suite) => {
    if (!isRecord(suite) || !exactKeys(suite, [
      'command', 'durationSeconds', 'firstAttempt', 'retryCount', 'skippedCount', 'status',
    ])) {
      throw new Error('S6 controller suite evidence has an invalid shape.')
    }
    if (
      typeof suite.command !== 'string'
      || !(suite.command in SUITE_BUDGET_SECONDS)
      || !Number.isSafeInteger(suite.durationSeconds) || Number(suite.durationSeconds) < 0
      || typeof suite.firstAttempt !== 'boolean'
      || !Number.isSafeInteger(suite.retryCount) || Number(suite.retryCount) < 0
      || !Number.isSafeInteger(suite.skippedCount) || Number(suite.skippedCount) < 0
      || !['passed', 'failed', 'timed_out'].includes(String(suite.status))
    ) {
      throw new Error('S6 controller suite evidence contains an invalid field.')
    }
    return Object.freeze({
      command: suite.command as keyof typeof SUITE_BUDGET_SECONDS,
      durationSeconds: Number(suite.durationSeconds),
      firstAttempt: suite.firstAttempt,
      retryCount: Number(suite.retryCount),
      skippedCount: Number(suite.skippedCount),
      status: suite.status as 'failed' | 'passed' | 'timed_out',
    })
  })

  return Object.freeze({
    schemaVersion: 2,
    phase: value.phase as Epic172S6ControllerPhase,
    controllerRunId: value.controllerRunId,
    jobId: value.jobId,
    reviewedSha: value.reviewedSha,
    githubAppId: value.githubAppId,
    exactBuilds: Object.freeze([...value.exactBuilds]),
    epoch: value.epoch as number | null,
    signerKeyId: value.signerKeyId,
    signerGeneration: Number(value.signerGeneration),
    imageDigest: value.imageDigest,
    bootId: value.bootId,
    databaseStartedAt: value.databaseStartedAt,
    completedAt: value.completedAt,
    leaseExpiresAt: value.leaseExpiresAt,
    outerExpiresAt: value.outerExpiresAt,
    phaseDurations: Object.freeze({
      orchestrationSeconds: Number(value.phaseDurations.orchestrationSeconds),
      preflightSeconds: Number(value.phaseDurations.preflightSeconds),
      suitePhaseSeconds: Number(value.phaseDurations.suitePhaseSeconds),
      outputTeardownDestructionSeconds: Number(value.phaseDurations.outputTeardownDestructionSeconds),
      verificationRecordingSeconds: Number(value.phaseDurations.verificationRecordingSeconds),
    }),
    suitesExecutedConcurrently: value.suitesExecutedConcurrently,
    suiteManifestDigest: value.suiteManifestDigest,
    executedIdsDigest: value.executedIdsDigest,
    outputScanDigest: value.outputScanDigest,
    outputScanPassed: value.outputScanPassed,
    preflightReceiptDigest: value.preflightReceiptDigest,
    teardownReceiptDigest: value.teardownReceiptDigest,
    teardownZeroResidue: value.teardownZeroResidue,
    destructionReceiptDigest: value.destructionReceiptDigest,
    destructionVerified: value.destructionVerified,
    releaseBindings: Object.freeze({
      predecessorReceiptDigest: value.releaseBindings.predecessorReceiptDigest,
      linkedReceiptDigest: value.releaseBindings.linkedReceiptDigest,
      signerLifecycleDigest: value.releaseBindings.signerLifecycleDigest,
      writersIngressAndIssuanceDisabled: value.releaseBindings.writersIngressAndIssuanceDisabled,
    }),
    suites: Object.freeze(suites),
  })
}

export function evaluateEpic172S6ControllerEvidence(
  untrustedInput: unknown,
  verifySignature: Epic172S6ExternalSignatureVerifier,
  expected: Epic172S6ExpectedControllerBindings,
  evaluatedAt: Date,
): Epic172S6ControllerGateResult {
  let verified: ReturnType<Epic172S6ExternalSignatureVerifier>
  try {
    verified = verifySignature(untrustedInput)
  } catch {
    return disabled('signature_invalid')
  }
  if (!verified.ok) return disabled('signature_invalid')
  try {
    assertEpic172S6ReleaseOrderOwnership()
  } catch {
    return disabled('cross_bound_evidence')
  }
  let bundle: Epic172S6ExternalEvidenceBundle
  try {
    bundle = parseEpic172S6ExternalEvidenceBundle(verified.value)
  } catch {
    return disabled('malformed_evidence')
  }
  if (
    bundle.bootId !== expected.bootId
    || bundle.controllerRunId !== expected.controllerRunId
    || bundle.epoch !== expected.epoch
    || bundle.exactBuilds.length !== expected.exactBuilds.length
    || bundle.exactBuilds.some((build, index) => build !== expected.exactBuilds[index])
    || bundle.githubAppId !== expected.githubAppId
    || bundle.imageDigest !== expected.imageDigest
    || bundle.jobId !== expected.jobId
    || bundle.phase !== expected.phase
    || bundle.reviewedSha !== expected.reviewedSha
    || bundle.signerGeneration !== expected.signerGeneration
    || bundle.signerKeyId !== expected.signerKeyId
    || bundle.releaseBindings.predecessorReceiptDigest !== expected.releaseBindings.predecessorReceiptDigest
    || bundle.releaseBindings.linkedReceiptDigest !== expected.releaseBindings.linkedReceiptDigest
    || bundle.releaseBindings.signerLifecycleDigest !== expected.releaseBindings.signerLifecycleDigest
    || bundle.releaseBindings.writersIngressAndIssuanceDisabled !== expected.releaseBindings.writersIngressAndIssuanceDisabled
  ) {
    return disabled('cross_bound_evidence')
  }
  const phaseBindingsAreValid = bundle.phase === 'pre_activation'
    ? bundle.epoch === null
      && bundle.releaseBindings.linkedReceiptDigest === null
      && bundle.releaseBindings.writersIngressAndIssuanceDisabled
    : bundle.phase === 'post_activation'
      ? bundle.epoch !== null
        && bundle.releaseBindings.linkedReceiptDigest !== null
        && bundle.releaseBindings.writersIngressAndIssuanceDisabled
      : bundle.epoch !== null
        && bundle.releaseBindings.linkedReceiptDigest !== null
        && !bundle.releaseBindings.writersIngressAndIssuanceDisabled
  if (!phaseBindingsAreValid) return disabled('cross_bound_evidence')

  const startedAt = validTime(bundle.databaseStartedAt)
  const completedAt = validTime(bundle.completedAt)
  const leaseExpiresAt = validTime(bundle.leaseExpiresAt)
  const outerExpiresAt = validTime(bundle.outerExpiresAt)
  if ([startedAt, completedAt, leaseExpiresAt, outerExpiresAt].some((value) => value === null)) {
    return disabled('malformed_evidence')
  }
  const evaluatedMilliseconds = evaluatedAt.getTime()
  if (!Number.isFinite(evaluatedMilliseconds)) return disabled('malformed_evidence')
  if (
    completedAt! < startedAt!
    || evaluatedMilliseconds < completedAt!
    || leaseExpiresAt! > outerExpiresAt!
    || leaseExpiresAt! - evaluatedMilliseconds > 45_000
  ) return disabled('cross_bound_evidence')
  if (completedAt! >= outerExpiresAt! || evaluatedMilliseconds >= outerExpiresAt!) return disabled('outer_deadline_expired')
  if (completedAt! >= leaseExpiresAt! || evaluatedMilliseconds >= leaseExpiresAt!) return disabled('lease_expired')
  if (completedAt! - startedAt! > 660_000 || evaluatedMilliseconds - startedAt! > 660_000) {
    return disabled('budget_exceeded')
  }
  if (bundle.suiteManifestDigest !== EPIC_172_S6_SUITE_MANIFEST_DIGEST || bundle.executedIdsDigest !== EPIC_172_S6_EXECUTED_IDS_DIGEST) {
    return disabled('manifest_mismatch')
  }

  const commands = bundle.suites.map((suite) => suite.command).sort()
  if (
    commands.length !== REQUIRED_SUITE_COMMANDS.length
    || commands.some((command, index) => command !== REQUIRED_SUITE_COMMANDS[index])
  ) {
    return disabled('suite_incomplete')
  }
  if (bundle.suites.some((suite) => suite.firstAttempt !== true || suite.retryCount !== 0 || suite.skippedCount !== 0)) {
    return disabled('suite_retried_or_skipped')
  }
  if (bundle.suites.some((suite) => suite.status !== 'passed')) return disabled('suite_failed')
  if (bundle.suites.some((suite) => !Number.isSafeInteger(suite.durationSeconds) || suite.durationSeconds < 0 || suite.durationSeconds > SUITE_BUDGET_SECONDS[suite.command])) {
    return disabled('budget_exceeded')
  }
  if (!bundle.suitesExecutedConcurrently) return disabled('suite_not_concurrent')
  const maximumSuiteDuration = Math.max(...bundle.suites.map((suite) => suite.durationSeconds))
  const measuredPhaseSeconds = Object.values(bundle.phaseDurations).reduce((total, duration) => total + duration, 0)
  if (
    bundle.phaseDurations.orchestrationSeconds > 60
    || bundle.phaseDurations.preflightSeconds > 30
    || bundle.phaseDurations.suitePhaseSeconds > 420
    || bundle.phaseDurations.suitePhaseSeconds < maximumSuiteDuration
    || bundle.phaseDurations.outputTeardownDestructionSeconds > 120
    || bundle.phaseDurations.verificationRecordingSeconds > 30
    || measuredPhaseSeconds !== Math.ceil((completedAt! - startedAt!) / 1_000)
  ) return disabled('budget_exceeded')
  if (!bundle.outputScanPassed) return disabled('output_scan_failed')
  if (!bundle.teardownZeroResidue) return disabled('teardown_failed')
  if (!bundle.destructionVerified) return disabled('destruction_missing')

  const targetKind = bundle.phase === 'pre_activation'
    ? 's6_pre_activation_green'
    : bundle.phase === 'post_activation'
      ? 's6_post_activation_green'
      : 'enabled_build_tests_green'
  return Object.freeze({
    disposition: 'eligible_for_step0_recording',
    targetKind,
    bundle,
    liveAuthorityGranted: false,
  })
}
