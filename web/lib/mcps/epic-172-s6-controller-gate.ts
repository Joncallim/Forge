import { createHash } from 'node:crypto'
import {
  EPIC_172_S6_SUITE_COMMANDS,
  epic172S6SuiteManifest,
} from './epic-172-s6-suite-contract'

const DIGEST = /^sha256:[a-f0-9]{64}$/
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const SHA = /^[a-f0-9]{40}$|^[a-f0-9]{64}$/
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
  imageDigest: string
  bootId: string
  databaseStartedAt: string
  completedAt: string
  leaseExpiresAt: string
  outerExpiresAt: string
  suiteManifestDigest: string
  executedIdsDigest: string
  outputScanDigest: string
  outputScanPassed: boolean
  preflightReceiptDigest: string
  teardownReceiptDigest: string
  teardownZeroResidue: boolean
  destructionReceiptDigest: string
  destructionVerified: boolean
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
) => Readonly<{ ok: true; value: Epic172S6ExternalEvidenceBundle }> | Readonly<{ ok: false }>

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
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return JSON.stringify(value)
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

function bundleShapeIsValid(bundle: Epic172S6ExternalEvidenceBundle): boolean {
  return bundle.schemaVersion === 2
    && ['pre_activation', 'post_activation', 'enabled_build_tests_green'].includes(bundle.phase)
    && ID.test(bundle.controllerRunId)
    && ID.test(bundle.jobId)
    && ID.test(bundle.bootId)
    && SHA.test(bundle.reviewedSha)
    && DIGEST.test(bundle.imageDigest)
    && DIGEST.test(bundle.suiteManifestDigest)
    && DIGEST.test(bundle.executedIdsDigest)
    && DIGEST.test(bundle.outputScanDigest)
    && DIGEST.test(bundle.preflightReceiptDigest)
    && DIGEST.test(bundle.teardownReceiptDigest)
    && DIGEST.test(bundle.destructionReceiptDigest)
    && Array.isArray(bundle.suites)
}

export function evaluateEpic172S6ControllerEvidence(
  untrustedInput: unknown,
  verifySignature: Epic172S6ExternalSignatureVerifier,
): Epic172S6ControllerGateResult {
  const verified = verifySignature(untrustedInput)
  if (!verified.ok) return disabled('signature_invalid')
  const bundle = verified.value
  if (!bundleShapeIsValid(bundle)) return disabled('malformed_evidence')

  const startedAt = validTime(bundle.databaseStartedAt)
  const completedAt = validTime(bundle.completedAt)
  const leaseExpiresAt = validTime(bundle.leaseExpiresAt)
  const outerExpiresAt = validTime(bundle.outerExpiresAt)
  if ([startedAt, completedAt, leaseExpiresAt, outerExpiresAt].some((value) => value === null)) {
    return disabled('malformed_evidence')
  }
  if (completedAt! < startedAt!) return disabled('cross_bound_evidence')
  if (completedAt! >= leaseExpiresAt!) return disabled('lease_expired')
  if (completedAt! >= outerExpiresAt!) return disabled('outer_deadline_expired')
  if (completedAt! - startedAt! > 660_000) {
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
