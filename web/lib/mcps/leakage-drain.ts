import { sanitizeWorkerMessage } from '@/worker/redaction'

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
