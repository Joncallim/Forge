import type { TaskLog } from '@/db/schema'
import { sanitizeWorkerMessage } from '@/worker/redaction'
import {
  LEGACY_TASK_LOG_UNAVAILABLE,
  classifySensitivePayloadKey,
  sanitizeSensitivePayload,
  unknownLegacyDigest,
  type SanitizeSensitivePayloadOptions,
  type UnknownLegacyDigest,
} from '@/lib/mcps/leakage-drain'

const DEFAULT_STRING_BYTE_LIMIT = 16 * 1024

type SanitizeOptions = SanitizeSensitivePayloadOptions

function truncateSafeField(value: string, maxBytes: number): string {
  const sanitized = sanitizeWorkerMessage(value)
  const buffer = Buffer.from(sanitized)
  if (buffer.byteLength <= maxBytes) return sanitized
  return LEGACY_TASK_LOG_UNAVAILABLE
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function sanitizeLogStructuredValue(
  value: unknown,
  options: SanitizeOptions = {},
): unknown {
  return sanitizeSensitivePayload(value, {
    stringByteLimit: options.stringByteLimit ?? DEFAULT_STRING_BYTE_LIMIT,
    maxArrayItems: options.maxArrayItems,
    maxDepth: options.maxDepth,
    maxObjectKeys: options.maxObjectKeys,
  })
}

export function sanitizePromptSnapshot(value: unknown): UnknownLegacyDigest {
  return unknownLegacyDigest(value)
}

export function sanitizeLogFrontMatter(frontMatter: Record<string, unknown>): Record<string, unknown> {
  return sanitizeLogStructuredValue(frontMatter, {
    stringByteLimit: DEFAULT_STRING_BYTE_LIMIT,
  }) as Record<string, unknown>
}

export function sanitizeLogRecordForOutput<T extends TaskLog>(log: T): T {
  return {
    ...log,
    eventType: truncateSafeField(log.eventType, 500),
    frontMatter: sanitizeLogFrontMatter(isRecord(log.frontMatter) ? log.frontMatter : {}) as Record<string, string>,
    level: truncateSafeField(log.level, 50),
    message: LEGACY_TASK_LOG_UNAVAILABLE,
    metadata: sanitizeLogStructuredValue(log.metadata, {
      stringByteLimit: DEFAULT_STRING_BYTE_LIMIT,
    }) as Record<string, unknown>,
    source: truncateSafeField(log.source, 100),
    title: truncateSafeField(log.title, 500),
  }
}

export {
  LEGACY_TASK_LOG_UNAVAILABLE,
  classifySensitivePayloadKey,
}
