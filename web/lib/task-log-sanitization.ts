import type { TaskLog } from '@/db/schema'
import { sanitizeWorkerMessage } from '@/worker/redaction'
import { sanitizePromptPayload } from '@/lib/mcps/leakage-drain'

const DEFAULT_STRING_BYTE_LIMIT = 16 * 1024
const DEFAULT_MAX_DEPTH = 6
const DEFAULT_MAX_ARRAY_ITEMS = 100
const DEFAULT_MAX_OBJECT_KEYS = 100

type SanitizeOptions = {
  maxArrayItems?: number
  maxDepth?: number
  maxObjectKeys?: number
  stringByteLimit?: number
}

function truncateUtf8(value: string, maxBytes: number): string {
  const buffer = Buffer.from(value)
  if (buffer.byteLength <= maxBytes) return value
  return `${buffer.subarray(0, maxBytes).toString('utf8')}\n...[truncated]`
}

function sanitizeString(value: string, maxBytes: number): string {
  return truncateUtf8(sanitizeWorkerMessage(value), maxBytes)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export const LEGACY_TASK_LOG_PROMPT_KEYS = [
  'prompt',
  'promptInput',
  'prompt_input',
  'promptOverlay',
  'prompt_overlay',
  'systemPrompt',
  'system_prompt',
  'userPrompt',
  'user_prompt',
  'sessionPrompt',
  'session_prompt',
  'executablePrompt',
  'executable_prompt',
  'messages',
] as const

const LEGACY_TASK_LOG_PROMPT_KEY_SET = new Set<string>(LEGACY_TASK_LOG_PROMPT_KEYS)

function isPromptKey(key: string): boolean {
  return LEGACY_TASK_LOG_PROMPT_KEY_SET.has(key) || /prompt/i.test(key)
}

function isSnapshotOnlyKey(key: string): boolean {
  return /(?:stdout|stderr|output|errorMessage|stack|trace|feedback|raw)/i.test(key) ||
    /^message$/i.test(key)
}

// Redact by key name too, not just by value shape: a shapeless secret stored
// under an obviously-secret key (apiKey, token, password, credential, ...) would
// otherwise survive verbatim into the logs API and exports.
function isSecretNamedKey(key: string): boolean {
  // Token *counts* (inputTokens/outputTokens/tokenCount) are not secrets.
  if (/tokens?/i.test(key) && /(?:count|input|output|total|used|prompt|completion|remaining)/i.test(key)) {
    return false
  }
  return /(?:password|passwd|secret|credential|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret|(?:access|refresh|auth|api|bearer|npm|session)[_-]?token|token$|\btoken\b|\bdsn\b)/i.test(key)
}

export function sanitizeLogStructuredValue(
  value: unknown,
  options: SanitizeOptions = {},
  depth = 0,
): unknown {
  const stringByteLimit = options.stringByteLimit ?? DEFAULT_STRING_BYTE_LIMIT
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH
  const maxArrayItems = options.maxArrayItems ?? DEFAULT_MAX_ARRAY_ITEMS
  const maxObjectKeys = options.maxObjectKeys ?? DEFAULT_MAX_OBJECT_KEYS

  if (value === null) return null
  if (typeof value === 'string') return sanitizeString(value, stringByteLimit)
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'bigint') return value.toString()
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'undefined' || typeof value === 'function' || typeof value === 'symbol') return null
  if (depth >= maxDepth) return '[truncated-depth]'

  if (Array.isArray(value)) {
    const items = value.slice(0, maxArrayItems).map((item) =>
      sanitizeLogStructuredValue(item, options, depth + 1),
    )
    if (value.length > maxArrayItems) items.push(`...[${value.length - maxArrayItems} more items]`)
    return items
  }

  if (!isRecord(value)) return sanitizeString(String(value), stringByteLimit)

  const result: Record<string, unknown> = {}
  const entries = Object.entries(value).slice(0, maxObjectKeys)
  for (const [key, item] of entries) {
    // Prompt-bearing keys are removed at every depth. A digest of low-entropy
    // prompt text is still a prompt oracle, so no replacement value is emitted.
    if (isPromptKey(key)) continue
    const safeKey = sanitizeString(key, 256)
    if (isSecretNamedKey(key)) {
      // Redact the whole value regardless of shape — a shapeless secret under a
      // secret-named key would otherwise survive value-shape redaction. Use the
      // existing token placeholder for consistency.
      result[safeKey] = item === null || item === undefined ? item : '[REDACTED_TOKEN]'
      continue
    }
    if (isSnapshotOnlyKey(key)) {
      result[safeKey] = sanitizePromptSnapshot(item)
      continue
    }
    result[safeKey] = sanitizeLogStructuredValue(item, options, depth + 1)
  }
  if (Object.keys(value).length > maxObjectKeys) {
    result.__truncated_keys = Object.keys(value).length - maxObjectKeys
  }
  return result
}

function promptSnapshotSource(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

export function sanitizePromptSnapshot(value: unknown): { kind: 'unknown_legacy_digest'; byteCount: number } {
  const sanitized = sanitizeWorkerMessage(promptSnapshotSource(value))
  const buffer = Buffer.from(sanitized)
  return {
    kind: 'unknown_legacy_digest',
    byteCount: buffer.byteLength,
  }
}

export function sanitizeLogFrontMatter(frontMatter: Record<string, unknown>): Record<string, unknown> {
  return sanitizeLogStructuredValue(frontMatter, { stringByteLimit: DEFAULT_STRING_BYTE_LIMIT }) as Record<string, unknown>
}

export function sanitizeLogRecordForOutput<T extends TaskLog>(log: T): T {
  return {
    ...log,
    eventType: sanitizeString(log.eventType, 500),
    frontMatter: sanitizeLogFrontMatter(isRecord(log.frontMatter) ? log.frontMatter : {}) as Record<string, string>,
    level: sanitizeString(log.level, 50),
    message: String(
      sanitizePromptPayload({ message: sanitizeString(log.message, 60 * 1024) }).message
        ?? '[content drained]',
    ),
    metadata: sanitizeLogStructuredValue(log.metadata, { stringByteLimit: DEFAULT_STRING_BYTE_LIMIT }) as Record<string, unknown>,
    source: sanitizeString(log.source, 100),
    title: sanitizeString(log.title, 500),
  }
}
