import { sanitizeWorkerMessage } from '@/worker/redaction'
import { ARCHITECT_PLAN_HEADER } from '@/lib/mcps/architect-plan-entries'

export const LEGACY_TASK_LOG_UNAVAILABLE = 'legacy_task_log_unavailable' as const

export type SensitivePayloadKeyKind = 'prompt' | 'secret' | 'snapshot' | 'unkeyed_digest'

/**
 * The one closed alias registry for task-log, API, export, and event leakage
 * filtering. Matching canonicalizes both this registry and the candidate key,
 * so camelCase, snake_case, and kebab-case spellings have identical behavior.
 */
export const SENSITIVE_PAYLOAD_KEY_ALIASES = [
  {
    kind: 'prompt',
    aliases: [
      'prompt',
      'promptInput',
      'promptOverlay',
      'promptOverlays',
      'requirementContext',
      'requirementContexts',
      'mcpAwareSubtask',
      'mcpAwareSubtasks',
      'architectPlanEntryReference',
      'architectPlanEntryReferences',
      'architectReplanReference',
      'architectReplanReferences',
      'systemPrompt',
      'userPrompt',
      'assistantPrompt',
      'sessionPrompt',
      'executablePrompt',
      'message',
      'messages',
      'instruction',
      'instructions',
      'content',
      'text',
      'delta',
      'planBody',
      'fullPlan',
      'architectPlan',
      'question',
      'questions',
      'suggestion',
      'suggestions',
      'answer',
      'answers',
      'openQuestion',
      'openQuestions',
      'answeredQuestion',
      'answeredQuestions',
      'path',
      'paths',
      'locator',
      'storageLocator',
      'selectedPath',
    ],
  },
  {
    kind: 'secret',
    aliases: [
      'apiKey',
      'token',
      'password',
      'passwd',
      'secret',
      'credential',
      'privateKey',
      'authorization',
      'bearer',
      'accessKey',
      'accessToken',
      'refreshToken',
      'authToken',
      'sessionSecret',
      'clientSecret',
      'encryptionKey',
      'signingKey',
      'dsn',
    ],
  },
  {
    kind: 'snapshot',
    aliases: [
      'stdout',
      'stderr',
      'output',
      'partialOutput',
      'errorMessage',
      'stack',
      'trace',
      'feedback',
      'raw',
    ],
  },
  {
    kind: 'unkeyed_digest',
    aliases: [
      'sha256',
      'promptSha256',
      'promptHash',
      'promptDigest',
      'legacyDigest',
    ],
  },
] as const satisfies readonly {
  kind: SensitivePayloadKeyKind
  aliases: readonly string[]
}[]

const DEFAULT_MAX_ARRAY_ITEMS = 100
const DEFAULT_MAX_DEPTH = 6
const DEFAULT_MAX_OBJECT_KEYS = 100
const DEFAULT_STRING_BYTE_LIMIT = 16 * 1024

function canonicalSensitiveKey(key: string): string {
  return key.toLowerCase().replace(/[\s_-]/g, '')
}

const SENSITIVE_KEY_KIND = new Map<string, SensitivePayloadKeyKind>(
  SENSITIVE_PAYLOAD_KEY_ALIASES.flatMap(({ aliases, kind }) =>
    aliases.map((alias) => [canonicalSensitiveKey(alias), kind] as const),
  ),
)

function isTokenMetric(key: string): boolean {
  return /token/.test(key) && /(?:count|input|output|total|used|prompt|completion|remaining)/.test(key)
}

export function classifySensitivePayloadKey(key: string): SensitivePayloadKeyKind | null {
  const canonical = canonicalSensitiveKey(key)
  if (isTokenMetric(canonical)) return null

  const exact = SENSITIVE_KEY_KIND.get(canonical)
  if (exact) return exact

  // Provider-specific secret names such as githubToken and stripeApiKey are
  // still classified by the one canonical function. This is intentionally
  // limited to secret suffixes; prompt aliases remain the closed list above.
  if (
    /token$/.test(canonical)
    || /(?:password|passwd|secret|credential|apikey|accesskey|privatekey|clientsecret|dsn)$/.test(canonical)
  ) {
    return 'secret'
  }
  return null
}

export function byteCount(input: string): number {
  return Buffer.byteLength(input, 'utf8')
}

function snapshotSource(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    const serialized = JSON.stringify(value)
    return typeof serialized === 'string' ? serialized : String(value)
  } catch {
    return String(value)
  }
}

export type UnknownLegacyDigest = {
  kind: 'unknown_legacy_digest'
  byteCount: number
}

export function unknownLegacyDigest(value: unknown): UnknownLegacyDigest {
  return {
    kind: 'unknown_legacy_digest',
    byteCount: byteCount(snapshotSource(value)),
  }
}

export function isUnknownLegacyDigest(value: unknown): value is UnknownLegacyDigest {
  return isRecord(value)
    && Object.keys(value).length === 2
    && value.kind === 'unknown_legacy_digest'
    && typeof value.byteCount === 'number'
    && Number.isSafeInteger(value.byteCount)
    && value.byteCount >= 0
}

export type SanitizeSensitivePayloadOptions = {
  maxArrayItems?: number
  maxDepth?: number
  maxObjectKeys?: number
  stringByteLimit?: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Recursively removes sensitive keyed values. Oversized or unknown values are
 * represented only by the closed legacy vocabulary; no truncated text or hash
 * prefix is emitted.
 */
export function sanitizeSensitivePayload(
  value: unknown,
  options: SanitizeSensitivePayloadOptions = {},
  depth = 0,
): unknown {
  const maxArrayItems = options.maxArrayItems ?? DEFAULT_MAX_ARRAY_ITEMS
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH
  const maxObjectKeys = options.maxObjectKeys ?? DEFAULT_MAX_OBJECT_KEYS
  const stringByteLimit = options.stringByteLimit ?? DEFAULT_STRING_BYTE_LIMIT

  if (value === null) return null
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'bigint') return value.toString()
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'undefined' || typeof value === 'function' || typeof value === 'symbol') {
    return LEGACY_TASK_LOG_UNAVAILABLE
  }
  if (depth >= maxDepth) return LEGACY_TASK_LOG_UNAVAILABLE

  if (typeof value === 'string') {
    const redacted = sanitizeWorkerMessage(value)
    return byteCount(redacted) > stringByteLimit ? unknownLegacyDigest(value) : redacted
  }

  if (Array.isArray(value)) {
    return value
      .slice(0, maxArrayItems)
      .map((item) => sanitizeSensitivePayload(item, options, depth + 1))
  }

  if (!isRecord(value)) return LEGACY_TASK_LOG_UNAVAILABLE

  const result: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value).slice(0, maxObjectKeys)) {
    if (typeof item === 'undefined' || typeof item === 'function' || typeof item === 'symbol') continue
    const kind = classifySensitivePayloadKey(key)
    if (kind === 'prompt' || kind === 'secret' || kind === 'unkeyed_digest') continue
    if (kind === 'snapshot') {
      result[key] = isUnknownLegacyDigest(item) ? item : unknownLegacyDigest(item)
      continue
    }
    result[key] = sanitizeSensitivePayload(item, options, depth + 1)
  }
  return result
}

export function sanitizePromptPayload(payload: Record<string, unknown>): Record<string, unknown> {
  return sanitizeSensitivePayload(payload) as Record<string, unknown>
}

/**
 * Work-package metadata is returned by authenticated task APIs and may contain
 * rows created before the protected Architect-context boundary existed. Keep
 * this wrapper as the one public-output policy for those legacy rows.
 */
export function sanitizeWorkPackageMetadata(metadata: unknown): unknown {
  return sanitizeSensitivePayload(metadata)
}

/**
 * Task-compatible readers must not turn persisted diagnostic text into a new
 * disclosure surface. Storage remains intact for the authority path, while
 * task detail, streams, logs, and exports receive this fixed vocabulary.
 */
export function taskCompatibilityError(value: unknown): string | null {
  return value === null || typeof value === 'undefined' ? null : LEGACY_TASK_LOG_UNAVAILABLE
}

type CompatibilityRecord = Record<string, unknown>

function compatibleField(input: CompatibilityRecord, key: string): unknown {
  return Object.hasOwn(input, key) ? input[key] : null
}

/**
 * Architect `adr_text` is always protected when it belongs to an Architect
 * run. Current rows carry a protected-history marker or planning/replan stage;
 * older rows can lack those markers, so the same structural run/type pairing
 * deliberately closes that legacy fallback too.
 */
export function isProtectedArchitectHistoryArtifact(
  artifact: CompatibilityRecord,
  run: CompatibilityRecord | undefined,
): boolean {
  if (artifact.artifactType !== 'adr_text' || run?.agentType !== 'architect') return false
  const metadata = isRecord(artifact.metadata) ? artifact.metadata : null
  const stage = typeof run.stage === 'string' ? run.stage.toLowerCase() : ''
  const currentProtectedMarker = metadata?.historyAvailable === true || /plan|replan/.test(stage)
  if (currentProtectedMarker) return true
  // Pre-S4 Architect plans have neither marker. Treat the remaining
  // Architect/adr_text structural pairing as legacy protected history rather
  // than exposing its body through a generic compatibility reader.
  return run.agentType === 'architect'
}

/** The one task-facing artifact projection. Ordinary artifacts retain content. */
export function projectTaskCompatibilityArtifact(
  artifact: CompatibilityRecord,
  run: CompatibilityRecord | undefined,
): Record<string, unknown> {
  const protectedHistory = isProtectedArchitectHistoryArtifact(artifact, run)
  const common = {
    id: compatibleField(artifact, 'id'),
    agentRunId: compatibleField(artifact, 'agentRunId'),
    artifactType: compatibleField(artifact, 'artifactType'),
    createdAt: compatibleField(artifact, 'createdAt'),
  }
  if (protectedHistory) {
    return {
      ...common,
      content: ARCHITECT_PLAN_HEADER,
      metadata: { historyAvailable: true },
    }
  }
  return {
    ...common,
    content: compatibleField(artifact, 'content'),
    metadata: sanitizeWorkPackageMetadata(compatibleField(artifact, 'metadata')),
  }
}

export function projectTaskCompatibilityRun(run: CompatibilityRecord): Record<string, unknown> {
  return {
    id: compatibleField(run, 'id'),
    taskId: compatibleField(run, 'taskId'),
    workPackageId: compatibleField(run, 'workPackageId'),
    harnessId: compatibleField(run, 'harnessId'),
    agentType: compatibleField(run, 'agentType'),
    stage: compatibleField(run, 'stage'),
    attemptNumber: compatibleField(run, 'attemptNumber'),
    modelIdUsed: compatibleField(run, 'modelIdUsed'),
    providerTypeUsed: compatibleField(run, 'providerTypeUsed'),
    providerIsLocalUsed: compatibleField(run, 'providerIsLocalUsed'),
    acpExecutionMode: compatibleField(run, 'acpExecutionMode'),
    status: compatibleField(run, 'status'),
    inputTokens: compatibleField(run, 'inputTokens'),
    outputTokens: compatibleField(run, 'outputTokens'),
    costUsd: compatibleField(run, 'costUsd'),
    startedAt: compatibleField(run, 'startedAt'),
    completedAt: compatibleField(run, 'completedAt'),
    errorMessage: taskCompatibilityError(compatibleField(run, 'errorMessage')),
    createdAt: compatibleField(run, 'createdAt'),
  }
}

export function projectTaskCompatibilityAttempt(attempt: CompatibilityRecord): Record<string, unknown> {
  return {
    id: compatibleField(attempt, 'id'),
    taskId: compatibleField(attempt, 'taskId'),
    queueName: compatibleField(attempt, 'queueName'),
    attemptNumber: compatibleField(attempt, 'attemptNumber'),
    status: compatibleField(attempt, 'status'),
    workerId: compatibleField(attempt, 'workerId'),
    errorMessage: taskCompatibilityError(compatibleField(attempt, 'errorMessage')),
    claimedAt: compatibleField(attempt, 'claimedAt'),
    startedAt: compatibleField(attempt, 'startedAt'),
    completedAt: compatibleField(attempt, 'completedAt'),
    nextRetryAt: compatibleField(attempt, 'nextRetryAt'),
    createdAt: compatibleField(attempt, 'createdAt'),
  }
}

export function projectTaskCompatibilityCommandAudit(audit: CompatibilityRecord): Record<string, unknown> {
  return {
    id: compatibleField(audit, 'id'),
    taskId: compatibleField(audit, 'taskId'),
    workPackageId: compatibleField(audit, 'workPackageId'),
    agentRunId: compatibleField(audit, 'agentRunId'),
    artifactId: compatibleField(audit, 'artifactId'),
    riskClass: compatibleField(audit, 'riskClass'),
    startedAt: compatibleField(audit, 'startedAt'),
    finishedAt: compatibleField(audit, 'finishedAt'),
    exitCode: compatibleField(audit, 'exitCode'),
    outputSummary: LEGACY_TASK_LOG_UNAVAILABLE,
    createdAt: compatibleField(audit, 'createdAt'),
  }
}

export function projectTaskCompatibilityFilesystemAudit(audit: CompatibilityRecord): Record<string, unknown> {
  return {
    id: compatibleField(audit, 'id'),
    taskId: compatibleField(audit, 'taskId'),
    workPackageId: compatibleField(audit, 'workPackageId'),
    agentRunId: compatibleField(audit, 'agentRunId'),
    operation: compatibleField(audit, 'operation'),
    status: compatibleField(audit, 'status'),
    capabilities: sanitizeSensitivePayload(compatibleField(audit, 'capabilities')),
    requestedCapabilities: sanitizeSensitivePayload(compatibleField(audit, 'requestedCapabilities')),
    fileCount: compatibleField(audit, 'fileCount'),
    byteCount: compatibleField(audit, 'byteCount'),
    omittedCount: compatibleField(audit, 'omittedCount'),
    redactionApplied: compatibleField(audit, 'redactionApplied'),
    protocolVersion: compatibleField(audit, 'protocolVersion'),
    metadata: sanitizeWorkPackageMetadata(compatibleField(audit, 'metadata')),
    createdAt: compatibleField(audit, 'createdAt'),
  }
}

export function projectTaskCompatibilityVcsChange(change: CompatibilityRecord): Record<string, unknown> {
  return {
    id: compatibleField(change, 'id'),
    taskId: compatibleField(change, 'taskId'),
    workPackageId: compatibleField(change, 'workPackageId'),
    agentRunId: compatibleField(change, 'agentRunId'),
    changeType: compatibleField(change, 'changeType'),
    status: compatibleField(change, 'status'),
    repository: LEGACY_TASK_LOG_UNAVAILABLE,
    branchName: compatibleField(change, 'branchName'),
    baseBranch: compatibleField(change, 'baseBranch'),
    commitSha: compatibleField(change, 'commitSha'),
    pullRequestUrl: compatibleField(change, 'pullRequestUrl'),
    diffSummary: LEGACY_TASK_LOG_UNAVAILABLE,
    metadata: sanitizeWorkPackageMetadata(compatibleField(change, 'metadata')),
    createdAt: compatibleField(change, 'createdAt'),
    updatedAt: compatibleField(change, 'updatedAt'),
  }
}

/** The authorized task object is the sole compatibility projection that includes `prompt`. */
export function projectTaskCompatibilityTask(task: CompatibilityRecord): Record<string, unknown> {
  return {
    id: compatibleField(task, 'id'),
    projectId: compatibleField(task, 'projectId'),
    submittedBy: compatibleField(task, 'submittedBy'),
    title: compatibleField(task, 'title'),
    prompt: compatibleField(task, 'prompt'),
    status: compatibleField(task, 'status'),
    pmProviderConfigId: compatibleField(task, 'pmProviderConfigId'),
    githubBranch: compatibleField(task, 'githubBranch'),
    githubPrUrl: compatibleField(task, 'githubPrUrl'),
    errorMessage: taskCompatibilityError(compatibleField(task, 'errorMessage')),
    createdAt: compatibleField(task, 'createdAt'),
    updatedAt: compatibleField(task, 'updatedAt'),
    completedAt: compatibleField(task, 'completedAt'),
  }
}
