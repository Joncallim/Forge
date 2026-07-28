import { createHash, randomUUID } from 'node:crypto'
import Redis from 'ioredis'
import { getRequiredEnv } from '../lib/env'
import { scanJsonObjectKeys } from '../lib/json-object-key-scan'

const TASK_QUEUE_KEY = 'forge:tasks'
const TASK_PROCESSING_QUEUE_KEY = 'forge:tasks:processing'
const TASK_RETRY_QUEUE_KEY = 'forge:tasks:retry'
const TASK_DEAD_QUEUE_KEY = 'forge:tasks:dead'
const TASK_CLAIMS_KEY = 'forge:tasks:claims'
const TASK_ACK_RECEIPTS_KEY = 'forge:tasks:ack-receipts'
const TASK_RELEASE_RECEIPTS_KEY = 'forge:tasks:release-receipts'
const TASK_PROMOTION_DISPOSITIONS_KEY = 'forge:tasks:promotion-dispositions'
const TASK_PROMOTION_DISPOSITION_EXPIRY_KEY = 'forge:tasks:promotion-disposition-expiry'
const APPROVAL_QUEUE_KEY = 'forge:approvals'
const APPROVAL_PROCESSING_QUEUE_KEY = 'forge:approvals:processing'
const APPROVAL_RETRY_QUEUE_KEY = 'forge:approvals:retry'
const APPROVAL_DEAD_QUEUE_KEY = 'forge:approvals:dead'
const APPROVAL_CLAIMS_KEY = 'forge:approvals:claims'
const APPROVAL_ACK_RECEIPTS_KEY = 'forge:approvals:ack-receipts'
const APPROVAL_RELEASE_RECEIPTS_KEY = 'forge:approvals:release-receipts'
const APPROVAL_PROMOTION_DISPOSITIONS_KEY = 'forge:approvals:promotion-dispositions'
const APPROVAL_PROMOTION_DISPOSITION_EXPIRY_KEY =
  'forge:approvals:promotion-disposition-expiry'
const ANSWERS_QUEUE_KEY = 'forge:answers'
const ANSWERS_PROCESSING_QUEUE_KEY = 'forge:answers:processing'
const ANSWERS_RETRY_QUEUE_KEY = 'forge:answers:retry'
const ANSWERS_DEAD_QUEUE_KEY = 'forge:answers:dead'
const ANSWERS_CLAIMS_KEY = 'forge:answers:claims'
const ANSWERS_ACK_RECEIPTS_KEY = 'forge:answers:ack-receipts'
const ANSWERS_RELEASE_RECEIPTS_KEY = 'forge:answers:release-receipts'
const ANSWERS_PROMOTION_DISPOSITIONS_KEY = 'forge:answers:promotion-dispositions'
const ANSWERS_PROMOTION_DISPOSITION_EXPIRY_KEY = 'forge:answers:promotion-disposition-expiry'

const QUEUE_ENVELOPE_SCHEMA_VERSION = 1
const DEAD_LETTER_SCHEMA_VERSION = 1
const DEAD_LETTER_FAILURE_CATEGORY = 'job_processing_failed'
const STUCK_RECOVERY_SCAN_LIMIT = 100
const TRANSITION_RECEIPT_TTL_MS = 15 * 60 * 1000
const TRANSITION_RECEIPT_CAP = 50_000
const TRANSITION_RECEIPT_PRUNE_LIMIT = 100
const RETRY_PROMOTION_LIMIT_MAX = 100
const PROMOTION_DISPOSITION_TTL_MS = 15 * 60 * 1000
const PROMOTION_DISPOSITION_CAP = 50_000
const PROMOTION_DISPOSITION_PRUNE_LIMIT = 100
const RETRY_PROMOTION_FINGERPRINT_DOMAIN =
  'forge:queue:retry-promotion-disposition:v1'
const TASK_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const CLAIM_MARKER_PATTERN = /^([1-9][0-9]*):([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/

type RetryableJob = {
  attempt?: number
}

type QueueEnvelope<TJob> = {
  schemaVersion: typeof QUEUE_ENVELOPE_SCHEMA_VERSION
  occurrenceId: string
  job: TJob
}

export type QueueTransitionOutcome = 'applied' | 'already_applied'

export type QueueRetryResult = {
  outcome: QueueTransitionOutcome
  nextRetryAt: Date
}

export const RETRY_PROMOTION_CONFLICT_CODE = 'queue_retry_promotion_conflict' as const

export class RetryPromotionConflictError extends Error {
  declare readonly code: typeof RETRY_PROMOTION_CONFLICT_CODE

  constructor() {
    super('Queue retry promotion conflict')
    Object.defineProperty(this, 'name', {
      configurable: true,
      enumerable: false,
      value: 'RetryPromotionConflictError',
      writable: true,
    })
    Object.defineProperty(this, 'code', {
      configurable: false,
      enumerable: false,
      value: RETRY_PROMOTION_CONFLICT_CODE,
      writable: false,
    })
  }
}

type QueueTransitionResult = QueueTransitionOutcome | 'stale_not_owner'

type RetryPromotionCandidate = {
  destination: string
  mode: 'discard' | 'legacy' | 'occurrence'
  occurrenceId: string
}

type DueRetrySnapshot = {
  fingerprint: string
  rawBytes: Buffer
  rawText: string | null
  score: string
}

type RetryPromotionTransition =
  | {
      disposition: 'discarded'
      outcome: QueueTransitionOutcome
    }
  | {
      disposition: 'promoted'
      occurrenceId: string
      outcome: QueueTransitionOutcome
    }
  | {
      outcome: 'ownership_conflict'
    }
  | {
      outcome: 'receipt_integrity_failure'
    }

type ClaimedQueueJob<TJob> = {
  raw: string
  occurrenceId: string
  job: TJob
}

type TerminalIntent =
  | { kind: 'ack' }
  | { kind: 'dead_letter'; record: string }
  | { kind: 'release' }
  | { kind: 'retry'; delayMs: number; envelope: string }

type ActiveClaim = {
  marker: string
  occurrenceId: string
  raw: string
  intent?: TerminalIntent
}

const LUA_MARKER_HELPERS = `
local claim_uuid_pattern = '^[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]%-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]%-[1-8][0-9a-f][0-9a-f][0-9a-f]%-[89ab][0-9a-f][0-9a-f][0-9a-f]%-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]$'
local function redis_now_ms()
  local now = redis.call('TIME')
  return (tonumber(now[1]) * 1000) + math.floor(tonumber(now[2]) / 1000)
end
local function valid_uuid(value)
  return type(value) == 'string' and string.match(value, claim_uuid_pattern) ~= nil
end
local function valid_marker(marker, now_ms)
  if type(marker) ~= 'string' then
    return false
  end
  local timestamp, nonce = string.match(marker, '^([1-9][0-9]*):([^:]+)$')
  if not timestamp or not valid_uuid(nonce) then
    return false
  end
  local numeric_timestamp = tonumber(timestamp)
  if not numeric_timestamp
      or numeric_timestamp < 1
      or numeric_timestamp > 9007199254740991
      or numeric_timestamp > now_ms then
    return false
  end
  return true
end
`

const LUA_TYPE_HELPER = `
local function assert_type(key, expected)
  local actual = redis.call('TYPE', key)['ok']
  if actual ~= 'none' and actual ~= expected then
    error('forge_queue_type_mismatch')
  end
end
`

const LUA_RECEIPT_HELPERS = `
local function receipt_member(occurrence_id, marker)
  local _, nonce = string.match(marker, '^([1-9][0-9]*):([^:]+)$')
  if not valid_uuid(occurrence_id) or not valid_uuid(nonce) then
    error('forge_queue_receipt_identity_invalid')
  end
  return occurrence_id .. ':' .. nonce
end
local function prune_receipts(key, now_ms, ttl_ms, prune_limit)
  local cutoff = now_ms - ttl_ms
  local expired = redis.call(
    'ZRANGEBYSCORE',
    key,
    '-inf',
    cutoff,
    'LIMIT',
    0,
    prune_limit
  )
  if #expired > 0 then
    redis.call('ZREM', key, unpack(expired))
  end
end
local function require_receipt_capacity(key, cap)
  if redis.call('ZCARD', key) >= cap then
    error('forge_queue_receipt_capacity_exhausted')
  end
end
`

const CLAIM_JOB_SCRIPT = `
-- forge:queue:claim-v2
${LUA_TYPE_HELPER}
${LUA_MARKER_HELPERS}
assert_type(KEYS[1], 'list')
assert_type(KEYS[2], 'hash')
if not valid_uuid(ARGV[3]) or not valid_uuid(ARGV[4]) then
  error('forge_queue_claim_identity_invalid')
end
if redis.call('HEXISTS', KEYS[2], ARGV[3]) == 1 then
  return 0
end
if ARGV[5] == 'legacy' then
  if redis.call('LREM', KEYS[1], 1, ARGV[1]) ~= 1 then
    return 0
  end
  redis.call('LPUSH', KEYS[1], ARGV[2])
elseif ARGV[5] == 'envelope' then
  if not redis.call('LPOS', KEYS[1], ARGV[2]) then
    return 0
  end
else
  error('forge_queue_claim_mode_invalid')
end
local marker = tostring(redis_now_ms()) .. ':' .. ARGV[4]
redis.call('HSET', KEYS[2], ARGV[3], marker)
return marker
`

const ACK_JOB_SCRIPT = `
-- forge:queue:ack-v3
${LUA_TYPE_HELPER}
${LUA_MARKER_HELPERS}
${LUA_RECEIPT_HELPERS}
assert_type(KEYS[1], 'list')
assert_type(KEYS[2], 'hash')
assert_type(KEYS[3], 'zset')
local now_ms = redis_now_ms()
local current_marker = redis.call('HGET', KEYS[2], ARGV[2])
if current_marker and not valid_marker(current_marker, now_ms) then
  error('forge_queue_claim_marker_invalid')
end
if not valid_marker(ARGV[3], now_ms) then
  error('forge_queue_claim_marker_invalid')
end
local receipt = receipt_member(ARGV[2], ARGV[3])
prune_receipts(KEYS[3], now_ms, tonumber(ARGV[4]), tonumber(ARGV[6]))
if redis.call('LPOS', KEYS[1], ARGV[1]) then
  if current_marker ~= ARGV[3] then
    return 0
  end
  require_receipt_capacity(KEYS[3], tonumber(ARGV[5]))
  if redis.call('LREM', KEYS[1], 1, ARGV[1]) ~= 1 then
    return 0
  end
  redis.call('HDEL', KEYS[2], ARGV[2])
  redis.call('ZADD', KEYS[3], now_ms, receipt)
  return 1
end
if not current_marker and redis.call('ZSCORE', KEYS[3], receipt) then
  return 2
end
return 0
`

const RELEASE_JOB_SCRIPT = `
-- forge:queue:release-v1
${LUA_TYPE_HELPER}
${LUA_MARKER_HELPERS}
${LUA_RECEIPT_HELPERS}
assert_type(KEYS[1], 'list')
assert_type(KEYS[2], 'hash')
assert_type(KEYS[3], 'list')
assert_type(KEYS[4], 'zset')
local now_ms = redis_now_ms()
local current_marker = redis.call('HGET', KEYS[2], ARGV[2])
if current_marker and not valid_marker(current_marker, now_ms) then
  error('forge_queue_claim_marker_invalid')
end
if not valid_marker(ARGV[3], now_ms) then
  error('forge_queue_claim_marker_invalid')
end
local receipt = receipt_member(ARGV[2], ARGV[3])
prune_receipts(KEYS[4], now_ms, tonumber(ARGV[4]), tonumber(ARGV[6]))
if redis.call('LPOS', KEYS[1], ARGV[1]) then
  if current_marker ~= ARGV[3] then
    return 0
  end
  require_receipt_capacity(KEYS[4], tonumber(ARGV[5]))
  if redis.call('LREM', KEYS[1], 1, ARGV[1]) ~= 1 then
    return 0
  end
  redis.call('HDEL', KEYS[2], ARGV[2])
  redis.call('LPUSH', KEYS[3], ARGV[1])
  redis.call('ZADD', KEYS[4], now_ms, receipt)
  return 1
end
if not current_marker
    and redis.call('LPOS', KEYS[3], ARGV[1])
    and redis.call('ZSCORE', KEYS[4], receipt) then
  return 2
end
return 0
`

const DISCARD_INVALID_JOB_SCRIPT = `
-- forge:queue:discard-invalid-v2
${LUA_TYPE_HELPER}
assert_type(KEYS[1], 'list')
if redis.call('LREM', KEYS[1], 1, ARGV[1]) == 1 then
  return 1
end
return 2
`

const RETRY_JOB_SCRIPT = `
-- forge:queue:retry-v3
${LUA_TYPE_HELPER}
${LUA_MARKER_HELPERS}
assert_type(KEYS[1], 'list')
assert_type(KEYS[2], 'hash')
assert_type(KEYS[3], 'zset')
local max_safe_integer = 9007199254740991
local max_date_ms = 8640000000000000
local delay_ms_raw = ARGV[4]
local delay_ms = tonumber(delay_ms_raw)
if type(delay_ms_raw) ~= 'string'
    or not string.match(delay_ms_raw, '^[0-9]+$')
    or not delay_ms
    or delay_ms ~= delay_ms
    or delay_ms < 0
    or delay_ms > max_safe_integer
    or math.floor(delay_ms) ~= delay_ms then
  error('forge_queue_retry_delay_invalid')
end
local now_ms = redis_now_ms()
local current_marker = redis.call('HGET', KEYS[2], ARGV[2])
if current_marker and not valid_marker(current_marker, now_ms) then
  error('forge_queue_claim_marker_invalid')
end
if not valid_marker(ARGV[3], now_ms) then
  error('forge_queue_claim_marker_invalid')
end
if redis.call('LPOS', KEYS[1], ARGV[1]) then
  if current_marker ~= ARGV[3] then
    return {0, ''}
  end
  if redis.call('ZSCORE', KEYS[3], ARGV[5]) then
    return {0, ''}
  end
  if now_ms > max_safe_integer
      or now_ms > max_date_ms
      or delay_ms > max_safe_integer - now_ms
      or delay_ms > max_date_ms - now_ms then
    error('forge_queue_retry_timestamp_invalid')
  end
  if redis.call('LREM', KEYS[1], 1, ARGV[1]) ~= 1 then
    return {0, ''}
  end
  redis.call('HDEL', KEYS[2], ARGV[2])
  redis.call('ZADD', KEYS[3], now_ms + delay_ms, ARGV[5])
  return {1, redis.call('ZSCORE', KEYS[3], ARGV[5])}
end
if not current_marker and not redis.call('LPOS', KEYS[1], ARGV[1]) then
  local existing_score = redis.call('ZSCORE', KEYS[3], ARGV[5])
  if existing_score then
    return {2, existing_score}
  end
end
return {0, ''}
`

const DEAD_LETTER_JOB_SCRIPT = `
-- forge:queue:dead-letter-v2
${LUA_TYPE_HELPER}
${LUA_MARKER_HELPERS}
assert_type(KEYS[1], 'list')
assert_type(KEYS[2], 'hash')
assert_type(KEYS[3], 'list')
local now_ms = redis_now_ms()
local current_marker = redis.call('HGET', KEYS[2], ARGV[2])
if current_marker and not valid_marker(current_marker, now_ms) then
  error('forge_queue_claim_marker_invalid')
end
if not valid_marker(ARGV[3], now_ms) then
  error('forge_queue_claim_marker_invalid')
end
if redis.call('LPOS', KEYS[1], ARGV[1]) then
  if current_marker ~= ARGV[3] then
    return 0
  end
  if redis.call('LREM', KEYS[1], 1, ARGV[1]) ~= 1 then
    return 0
  end
  redis.call('HDEL', KEYS[2], ARGV[2])
  redis.call('LPUSH', KEYS[3], ARGV[4])
  return 1
end
if not current_marker and redis.call('LPOS', KEYS[3], ARGV[4]) then
  return 2
end
return 0
`

const LIST_DUE_RETRIES_SCRIPT = `
-- forge:queue:list-due-retries-v1
${LUA_TYPE_HELPER}
assert_type(KEYS[1], 'zset')
local limit = tonumber(ARGV[1])
if not limit or limit < 1 or limit > ${RETRY_PROMOTION_LIMIT_MAX}
    or math.floor(limit) ~= limit then
  error('forge_queue_retry_limit_invalid')
end
local now = redis.call('TIME')
local now_ms = (tonumber(now[1]) * 1000) + math.floor(tonumber(now[2]) / 1000)
return redis.call(
  'ZRANGEBYSCORE',
  KEYS[1],
  0,
  now_ms,
  'WITHSCORES',
  'LIMIT',
  0,
  limit
)
`

const PROMOTE_RETRY_SCRIPT = `
-- forge:queue:promote-retry-v4
${LUA_TYPE_HELPER}
${LUA_MARKER_HELPERS}
assert_type(KEYS[1], 'zset')
assert_type(KEYS[2], 'list')
assert_type(KEYS[3], 'hash')
assert_type(KEYS[4], 'zset')
local raw_member = ARGV[1]
local expected_score = ARGV[2]
local fingerprint = ARGV[3]
local mode = ARGV[4]
local destination = ARGV[5]
local candidate_occurrence_id = ARGV[6]
local ttl_ms = tonumber(ARGV[7])
local cap = tonumber(ARGV[8])
local prune_limit = tonumber(ARGV[9])
if type(fingerprint) ~= 'string'
    or string.len(fingerprint) ~= 64
    or not string.match(fingerprint, '^[0-9a-f]+$') then
  error('forge_queue_retry_fingerprint_invalid')
end
if not ttl_ms or ttl_ms < 1
    or not cap or cap < 1
    or not prune_limit or prune_limit < 1 then
  error('forge_queue_retry_receipt_bounds_invalid')
end
if mode ~= 'discard' and mode ~= 'legacy' and mode ~= 'occurrence' then
  error('forge_queue_retry_mode_invalid')
end
if mode ~= 'discard' and not valid_uuid(candidate_occurrence_id) then
  error('forge_queue_retry_occurrence_invalid')
end
local now_ms = redis_now_ms()
local cutoff = now_ms - ttl_ms
local current_score = redis.call('ZSCORE', KEYS[1], raw_member)
local existing = redis.call('HGET', KEYS[3], fingerprint)
local receipt_score = redis.call('ZSCORE', KEYS[4], fingerprint)
if not current_score then
  if not existing and not receipt_score then
    return {0, 'ownership_conflict', ''}
  end
  if not existing or not receipt_score then
    redis.call('HDEL', KEYS[3], fingerprint)
    redis.call('ZREM', KEYS[4], fingerprint)
    return {0, 'receipt_integrity_failure', ''}
  end
  local receipt_timestamp = tonumber(receipt_score)
  local receipt_timestamp_valid = receipt_timestamp
      and receipt_timestamp == receipt_timestamp
      and receipt_timestamp ~= math.huge
      and receipt_timestamp ~= -math.huge
      and receipt_timestamp <= now_ms
      and receipt_timestamp > cutoff
  local winning_occurrence_id = nil
  local disposition_valid = existing == 'discarded'
  if not disposition_valid then
    winning_occurrence_id = string.match(existing, '^promoted:([^:]+)$')
    disposition_valid = winning_occurrence_id and valid_uuid(winning_occurrence_id)
  end
  if not receipt_timestamp_valid or not disposition_valid then
    redis.call('HDEL', KEYS[3], fingerprint)
    redis.call('ZREM', KEYS[4], fingerprint)
    return {0, 'receipt_integrity_failure', ''}
  end
  if existing == 'discarded' and mode == 'discard' then
    return {2, 'discarded', ''}
  end
  if winning_occurrence_id and mode ~= 'discard' then
    return {2, 'promoted', winning_occurrence_id}
  end
  return {0, 'receipt_integrity_failure', ''}
end
if current_score ~= expected_score then
  return {0, 'ownership_conflict', ''}
end
if existing or receipt_score then
  return {0, 'receipt_integrity_failure', ''}
end
local expired = redis.call(
  'ZRANGEBYSCORE',
  KEYS[4],
  '-inf',
  cutoff,
  'LIMIT',
  0,
  prune_limit
)
for _, expired_fingerprint in ipairs(expired) do
  redis.call('ZREM', KEYS[4], expired_fingerprint)
  redis.call('HDEL', KEYS[3], expired_fingerprint)
end
if redis.call('HLEN', KEYS[3]) >= cap or redis.call('ZCARD', KEYS[4]) >= cap then
  error('forge_queue_retry_receipt_capacity_exhausted')
end
if redis.call('ZREM', KEYS[1], raw_member) ~= 1 then
  return {0, 'ownership_conflict', ''}
end
if mode == 'discard' then
  redis.call('HSET', KEYS[3], fingerprint, 'discarded')
  redis.call('ZADD', KEYS[4], now_ms, fingerprint)
  return {1, 'discarded', ''}
end
redis.call('LPUSH', KEYS[2], destination)
redis.call('HSET', KEYS[3], fingerprint, 'promoted:' .. candidate_occurrence_id)
redis.call('ZADD', KEYS[4], now_ms, fingerprint)
return {1, 'promoted', candidate_occurrence_id}
`

const RECOVER_STUCK_JOB_SCRIPT = `
-- forge:queue:recover-stuck-v2
${LUA_TYPE_HELPER}
${LUA_MARKER_HELPERS}
assert_type(KEYS[1], 'list')
assert_type(KEYS[2], 'hash')
assert_type(KEYS[3], 'list')
if not redis.call('LPOS', KEYS[1], ARGV[1]) then
  return 2
end
local now_ms = redis_now_ms()
local current_marker = redis.call('HGET', KEYS[2], ARGV[2])
if current_marker then
  if not valid_marker(current_marker, now_ms) then
    error('forge_queue_claim_marker_invalid')
  end
  local timestamp = tonumber(string.match(current_marker, '^([1-9][0-9]*):'))
  if (now_ms - timestamp) < tonumber(ARGV[3]) then
    if redis.call('LREM', KEYS[1], 1, ARGV[1]) ~= 1 then
      return 2
    end
    redis.call('RPUSH', KEYS[1], ARGV[1])
    return 3
  end
end
if redis.call('LREM', KEYS[1], 1, ARGV[1]) ~= 1 then
  return 2
end
redis.call('HDEL', KEYS[2], ARGV[2])
redis.call('LPUSH', KEYS[3], ARGV[1])
return 1
`

const RECOVER_LEGACY_JOB_SCRIPT = `
-- forge:queue:recover-legacy-v2
${LUA_TYPE_HELPER}
${LUA_MARKER_HELPERS}
assert_type(KEYS[1], 'list')
assert_type(KEYS[2], 'hash')
assert_type(KEYS[3], 'list')
if not redis.call('LPOS', KEYS[1], ARGV[1]) then
  return 2
end
local now_ms = redis_now_ms()
local current_marker = redis.call('HGET', KEYS[2], ARGV[1])
if current_marker then
  if not valid_marker(current_marker, now_ms) then
    error('forge_queue_claim_marker_invalid')
  end
  local timestamp = tonumber(string.match(current_marker, '^([1-9][0-9]*):'))
  if (now_ms - timestamp) < tonumber(ARGV[3]) then
    if redis.call('LREM', KEYS[1], 1, ARGV[1]) ~= 1 then
      return 2
    end
    redis.call('RPUSH', KEYS[1], ARGV[1])
    return 3
  end
end
if redis.call('LREM', KEYS[1], 1, ARGV[1]) ~= 1 then
  return 2
end
redis.call('HDEL', KEYS[2], ARGV[1])
redis.call('LPUSH', KEYS[3], ARGV[2])
return 1
`

export interface TaskJob {
  taskId: string
  attempt: number
}

export type ClaimedTaskJob = ClaimedQueueJob<TaskJob>

export interface ApprovalJob {
  taskId: string
  action: 'approve'
  attempt: number
}

export type ClaimedApprovalJob = ClaimedQueueJob<ApprovalJob>

export interface AnswersJob {
  taskId: string
  attempt: number
}

export type ClaimedAnswersJob = ClaimedQueueJob<AnswersJob>

function canonicalEnvelope<TJob>(occurrenceId: string, job: TJob): string {
  return JSON.stringify({
    schemaVersion: QUEUE_ENVELOPE_SCHEMA_VERSION,
    occurrenceId,
    job,
  } satisfies QueueEnvelope<TJob>)
}

function normalizeOccurrenceId(value: unknown): string {
  if (typeof value !== 'string' || !TASK_ID_PATTERN.test(value)) {
    throw new Error('queue occurrence must be a canonical UUID')
  }
  return value
}

function parseClosedObject(raw: string): Record<string, unknown> {
  if (scanJsonObjectKeys(raw) !== 'valid') {
    throw new Error('queue payload is not closed JSON')
  }
  const parsed = JSON.parse(raw) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('queue payload must be an object')
  }
  return parsed as Record<string, unknown>
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index])
}

function decodeExactUtf8(value: Buffer): string | null {
  try {
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(value)
    return Buffer.from(decoded, 'utf8').equals(value) ? decoded : null
  } catch {
    return null
  }
}

function promotionFingerprint(
  queueDiscriminator: string,
  rawMember: Buffer,
  score: Buffer,
): string {
  const digest = createHash('sha256')
  for (const part of [
    Buffer.from(RETRY_PROMOTION_FINGERPRINT_DOMAIN, 'utf8'),
    Buffer.from(queueDiscriminator, 'utf8'),
    rawMember,
    score,
  ]) {
    const length = Buffer.allocUnsafe(8)
    length.writeBigUInt64BE(BigInt(part.length))
    digest.update(length)
    digest.update(part)
  }
  return digest.digest('hex')
}

abstract class RedisListQueue<TJob extends RetryableJob> {
  protected readonly client: Redis
  private readonly activeClaims = new Map<string, ActiveClaim>()

  constructor(
    private readonly queueKey: string,
    private readonly processingQueueKey: string,
    private readonly retryQueueKey: string,
    private readonly deadQueueKey: string,
    private readonly claimsKey: string,
    private readonly ackReceiptsKey: string,
    private readonly releaseReceiptsKey: string,
    private readonly promotionDispositionsKey: string,
    private readonly promotionDispositionExpiryKey: string,
    redisUrl = getRequiredEnv('REDIS_URL'),
  ) {
    this.client = new Redis(redisUrl, {
      maxRetriesPerRequest: null,
      retryStrategy: (times) => Math.min(times * 100, 3000),
    })
    this.client.on('error', () => {
      console.warn('[worker/queue] Redis connection unavailable')
    })
  }

  protected abstract parse(raw: string): TJob

  private parseEnvelope(raw: string): QueueEnvelope<TJob> {
    const value = parseClosedObject(raw)
    if (!hasExactKeys(value, ['schemaVersion', 'occurrenceId', 'job'])
      || value.schemaVersion !== QUEUE_ENVELOPE_SCHEMA_VERSION) {
      throw new Error('queue occurrence envelope is not closed')
    }
    const occurrenceId = normalizeOccurrenceId(value.occurrenceId)
    const job = this.parse(JSON.stringify(value.job))
    if (canonicalEnvelope(occurrenceId, job) !== raw) {
      throw new Error('queue occurrence envelope is not canonical')
    }
    return { schemaVersion: QUEUE_ENVELOPE_SCHEMA_VERSION, occurrenceId, job }
  }

  private parseClaimCandidate(raw: string): {
    envelope: QueueEnvelope<TJob>
    envelopeRaw: string
    mode: 'envelope' | 'legacy'
  } {
    try {
      const envelope = this.parseEnvelope(raw)
      return { envelope, envelopeRaw: raw, mode: 'envelope' }
    } catch {
      const job = this.parse(raw)
      const occurrenceId = randomUUID()
      const envelope = {
        schemaVersion: QUEUE_ENVELOPE_SCHEMA_VERSION,
        occurrenceId,
        job,
      } satisfies QueueEnvelope<TJob>
      return { envelope, envelopeRaw: canonicalEnvelope(occurrenceId, job), mode: 'legacy' }
    }
  }

  private parseRetryPromotionCandidate(raw: string | null): RetryPromotionCandidate {
    if (raw === null) {
      return { destination: '', mode: 'discard', occurrenceId: '' }
    }
    try {
      const envelope = this.parseEnvelope(raw)
      return {
        destination: raw,
        mode: 'occurrence',
        occurrenceId: envelope.occurrenceId,
      }
    } catch {
      try {
        const job = this.parse(raw)
        const occurrenceId = randomUUID()
        return {
          destination: canonicalEnvelope(occurrenceId, job),
          mode: 'legacy',
          occurrenceId,
        }
      } catch {
        return { destination: '', mode: 'discard', occurrenceId: '' }
      }
    }
  }

  private async listDueRetrySnapshots(limit: number): Promise<DueRetrySnapshot[]> {
    let dueResult: unknown
    try {
      dueResult = await this.client.callBuffer(
        'EVAL',
        LIST_DUE_RETRIES_SCRIPT,
        1,
        this.retryQueueKey,
        String(limit),
      )
    } catch {
      throw new Error('Queue retry promotion scan failed')
    }
    if (!Array.isArray(dueResult)
      || dueResult.length > limit * 2
      || dueResult.length % 2 !== 0
      || dueResult.some((value) => !Buffer.isBuffer(value))) {
      throw new Error('Queue retry promotion scan returned an invalid result')
    }

    const snapshots: DueRetrySnapshot[] = []
    for (let index = 0; index < dueResult.length; index += 2) {
      const rawBytes = dueResult[index] as Buffer
      const scoreBytes = dueResult[index + 1] as Buffer
      const score = decodeExactUtf8(scoreBytes)
      const numericScore = score === null ? Number.NaN : Number(score)
      if (score === null || !Number.isFinite(numericScore) || numericScore < 0) {
        throw new Error('Queue retry promotion scan returned an invalid result')
      }
      snapshots.push({
        fingerprint: promotionFingerprint(this.retryQueueKey, rawBytes, scoreBytes),
        rawBytes,
        rawText: decodeExactUtf8(rawBytes),
        score,
      })
    }
    return snapshots
  }

  private async evalClosed(
    failureMessage: string,
    script: string,
    keys: readonly string[],
    args: readonly (Buffer | string)[],
  ): Promise<unknown> {
    try {
      return await this.client.call('EVAL', script, keys.length, ...keys, ...args)
    } catch {
      throw new Error(failureMessage)
    }
  }

  private decodeRetryPromotionTransition(result: unknown): RetryPromotionTransition {
    if (!Array.isArray(result) || result.length !== 3) {
      throw new Error('Queue retry promotion returned an invalid result')
    }
    const [rawOutcome, rawDisposition, rawOccurrenceId] = result
    const outcome = rawOutcome === 1
      ? 'applied'
      : rawOutcome === 2
        ? 'already_applied'
        : null
    if (rawOutcome === 0
      && rawDisposition === 'ownership_conflict'
      && rawOccurrenceId === '') {
      return { outcome: 'ownership_conflict' }
    }
    if (rawOutcome === 0
      && rawDisposition === 'receipt_integrity_failure'
      && rawOccurrenceId === '') {
      return { outcome: 'receipt_integrity_failure' }
    }
    if ((outcome === 'applied' || outcome === 'already_applied')
      && rawDisposition === 'discarded'
      && rawOccurrenceId === '') {
      return { disposition: rawDisposition, outcome }
    }
    if ((outcome === 'applied' || outcome === 'already_applied')
      && rawDisposition === 'promoted'
      && typeof rawOccurrenceId === 'string') {
      return {
        disposition: rawDisposition,
        occurrenceId: normalizeOccurrenceId(rawOccurrenceId),
        outcome,
      }
    }
    throw new Error('Queue retry promotion returned an invalid result')
  }

  private decodeTransition(result: unknown): QueueTransitionResult {
    if (result === 1) return 'applied'
    if (result === 2) return 'already_applied'
    if (result === 0) return 'stale_not_owner'
    throw new Error('Queue transition returned an invalid result')
  }

  private decodeRetryTransition(result: unknown): QueueRetryResult | 'stale_not_owner' {
    if (!Array.isArray(result) || result.length !== 2) {
      throw new Error('Queue retry transition returned an invalid result')
    }
    const [rawOutcome, rawScore] = result
    if (rawOutcome === 0 && rawScore === '') {
      return 'stale_not_owner'
    }
    const outcome = rawOutcome === 1
      ? 'applied'
      : rawOutcome === 2
        ? 'already_applied'
        : null
    if (!outcome
        || typeof rawScore !== 'string'
        || !/^(?:0|[1-9][0-9]*)$/.test(rawScore)) {
      throw new Error('Queue retry transition returned an invalid result')
    }
    const score = Number(rawScore)
    if (!Number.isFinite(score)
        || !Number.isSafeInteger(score)
        || score < 0
        || score > 8_640_000_000_000_000) {
      throw new Error('Queue retry transition returned an invalid result')
    }
    const nextRetryAt = new Date(score)
    if (nextRetryAt.getTime() !== score) {
      throw new Error('Queue retry transition returned an invalid result')
    }
    return { outcome, nextRetryAt }
  }

  private activeClaim(raw: string): ActiveClaim {
    let envelope: QueueEnvelope<TJob>
    try {
      envelope = this.parseEnvelope(raw)
    } catch {
      throw new Error('Queue transition ownership mismatch')
    }
    const active = this.activeClaims.get(envelope.occurrenceId)
    if (!active || active.raw !== raw) {
      throw new Error('Queue transition ownership mismatch')
    }
    return active
  }

  private intent(active: ActiveClaim, create: () => TerminalIntent): TerminalIntent {
    active.intent ??= create()
    return active.intent
  }

  private async transitionClaimed(
    script: string,
    active: ActiveClaim,
    keys: readonly string[],
    args: readonly string[],
  ): Promise<QueueTransitionOutcome> {
    const result = this.decodeTransition(await this.evalClosed(
      'Queue transition failed',
      script,
      keys,
      [active.raw, active.occurrenceId, active.marker, ...args],
    ))
    if (result === 'stale_not_owner') {
      throw new Error('Queue transition stale_not_owner')
    }
    this.activeClaims.delete(active.occurrenceId)
    return result
  }

  async claim(timeoutSeconds: number): Promise<ClaimedQueueJob<TJob> | null> {
    const raw = await this.client.brpoplpush(
      this.queueKey,
      this.processingQueueKey,
      timeoutSeconds,
    )
    if (raw === null) return null

    let candidate: ReturnType<RedisListQueue<TJob>['parseClaimCandidate']>
    try {
      candidate = this.parseClaimCandidate(raw)
    } catch {
      await this.evalClosed(
        'Queue invalid-job discard failed',
        DISCARD_INVALID_JOB_SCRIPT,
        [this.processingQueueKey],
        [raw],
      )
      console.warn('[worker/queue] Dropped invalid job payload')
      return null
    }

    const claimNonce = randomUUID()
    const marker = await this.evalClosed(
      'Queue claim transition failed',
      CLAIM_JOB_SCRIPT,
      [this.processingQueueKey, this.claimsKey],
      [
        raw,
        candidate.envelopeRaw,
        candidate.envelope.occurrenceId,
        claimNonce,
        candidate.mode,
      ],
    )
    if (marker === 0) {
      throw new Error('Queue claim is no longer available')
    }
    const markerMatch = typeof marker === 'string' ? CLAIM_MARKER_PATTERN.exec(marker) : null
    if (!markerMatch
      || !Number.isSafeInteger(Number(markerMatch[1]))
      || Number(markerMatch[1]) < 1
      || markerMatch[2] !== claimNonce) {
      throw new Error('Queue claim returned an invalid marker')
    }
    const validatedMarker = marker as string
    this.activeClaims.set(candidate.envelope.occurrenceId, {
      marker: validatedMarker,
      occurrenceId: candidate.envelope.occurrenceId,
      raw: candidate.envelopeRaw,
    })
    return {
      raw: candidate.envelopeRaw,
      occurrenceId: candidate.envelope.occurrenceId,
      job: candidate.envelope.job,
    }
  }

  async ack(raw: string): Promise<QueueTransitionOutcome> {
    const active = this.activeClaim(raw)
    const intent = this.intent(active, () => ({ kind: 'ack' }))
    if (intent.kind !== 'ack') {
      throw new Error('Queue transition ownership mismatch')
    }
    return this.transitionClaimed(
      ACK_JOB_SCRIPT,
      active,
      [this.processingQueueKey, this.claimsKey, this.ackReceiptsKey],
      [
        String(TRANSITION_RECEIPT_TTL_MS),
        String(TRANSITION_RECEIPT_CAP),
        String(TRANSITION_RECEIPT_PRUNE_LIMIT),
      ],
    )
  }

  async release(raw: string): Promise<QueueTransitionOutcome> {
    const active = this.activeClaim(raw)
    const intent = this.intent(active, () => ({ kind: 'release' }))
    if (intent.kind !== 'release') {
      throw new Error('Queue transition ownership mismatch')
    }
    return this.transitionClaimed(
      RELEASE_JOB_SCRIPT,
      active,
      [
        this.processingQueueKey,
        this.claimsKey,
        this.queueKey,
        this.releaseReceiptsKey,
      ],
      [
        String(TRANSITION_RECEIPT_TTL_MS),
        String(TRANSITION_RECEIPT_CAP),
        String(TRANSITION_RECEIPT_PRUNE_LIMIT),
      ],
    )
  }

  async retry(
    raw: string,
    job: TJob,
    delayMs: number,
  ): Promise<QueueRetryResult> {
    if (!Number.isFinite(delayMs) || !Number.isSafeInteger(delayMs) || delayMs < 0) {
      throw new Error('Queue retry delay must be a non-negative safe integer')
    }
    const active = this.activeClaim(raw)
    const current = this.parseEnvelope(raw)
    const canonicalJob = this.parse(JSON.stringify(job))
    if (JSON.stringify(canonicalJob) !== JSON.stringify(current.job)) {
      throw new Error('Queue transition ownership mismatch')
    }
    const intent = this.intent(active, () => {
      const nextJob = this.parse(JSON.stringify({
        ...canonicalJob,
        attempt: (canonicalJob.attempt ?? 1) + 1,
      }))
      return {
        kind: 'retry',
        delayMs,
        envelope: canonicalEnvelope(active.occurrenceId, nextJob),
      }
    })
    if (intent.kind !== 'retry') {
      throw new Error('Queue transition ownership mismatch')
    }
    const result = this.decodeRetryTransition(await this.evalClosed(
      'Queue transition failed',
      RETRY_JOB_SCRIPT,
      [this.processingQueueKey, this.claimsKey, this.retryQueueKey],
      [
        active.raw,
        active.occurrenceId,
        active.marker,
        String(intent.delayMs),
        intent.envelope,
      ],
    ))
    if (result === 'stale_not_owner') {
      throw new Error('Queue transition stale_not_owner')
    }
    this.activeClaims.delete(active.occurrenceId)
    return result
  }

  async deadLetter(raw: string, job: TJob): Promise<QueueTransitionOutcome> {
    const active = this.activeClaim(raw)
    const current = this.parseEnvelope(raw)
    const canonicalJob = this.parse(JSON.stringify(job))
    if (JSON.stringify(canonicalJob) !== JSON.stringify(current.job)) {
      throw new Error('Queue transition ownership mismatch')
    }
    const intent = this.intent(active, () => ({
      kind: 'dead_letter',
      record: JSON.stringify({
        schemaVersion: DEAD_LETTER_SCHEMA_VERSION,
        occurrenceId: active.occurrenceId,
        job: canonicalJob,
        failureCategory: DEAD_LETTER_FAILURE_CATEGORY,
        deadLetteredAt: new Date().toISOString(),
      }),
    }))
    if (intent.kind !== 'dead_letter') {
      throw new Error('Queue transition ownership mismatch')
    }
    return this.transitionClaimed(
      DEAD_LETTER_JOB_SCRIPT,
      active,
      [this.processingQueueKey, this.claimsKey, this.deadQueueKey],
      [intent.record],
    )
  }

  async promoteDueRetries(limit = 20): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > RETRY_PROMOTION_LIMIT_MAX) {
      throw new Error('Queue promotion limit must be a bounded positive safe integer')
    }
    const due = await this.listDueRetrySnapshots(limit)

    let promoted = 0
    for (const snapshot of due) {
      const candidate = this.parseRetryPromotionCandidate(snapshot.rawText)
      const result = this.decodeRetryPromotionTransition(await this.evalClosed(
        'Queue retry promotion failed',
        PROMOTE_RETRY_SCRIPT,
        [
          this.retryQueueKey,
          this.queueKey,
          this.promotionDispositionsKey,
          this.promotionDispositionExpiryKey,
        ],
        [
          snapshot.rawBytes,
          snapshot.score,
          snapshot.fingerprint,
          candidate.mode,
          candidate.destination,
          candidate.occurrenceId,
          String(PROMOTION_DISPOSITION_TTL_MS),
          String(PROMOTION_DISPOSITION_CAP),
          String(PROMOTION_DISPOSITION_PRUNE_LIMIT),
        ],
      ))
      if (result.outcome === 'ownership_conflict') {
        throw new RetryPromotionConflictError()
      }
      if (result.outcome === 'receipt_integrity_failure') {
        throw new Error('Queue retry promotion receipt integrity failure')
      }
      if (result.disposition === 'discarded') {
        if (result.outcome === 'applied') {
          console.warn('[worker/queue] Dropped invalid retry payload')
        }
        continue
      }
      if (result.outcome === 'applied') promoted += 1
    }

    return promoted
  }

  async recoverStuckJobs(
    staleMs: number,
    options: { drain?: boolean } = {},
  ): Promise<number> {
    if (!Number.isSafeInteger(staleMs) || staleMs < 0) {
      throw new Error('Queue stale interval must be a non-negative safe integer')
    }
    const initialLength = await this.client.llen(this.processingQueueKey)
    const pageCount = options.drain
      ? Math.ceil(initialLength / STUCK_RECOVERY_SCAN_LIMIT)
      : Math.min(initialLength, 1)
    let remaining = initialLength
    let recovered = 0

    for (let page = 0; page < pageCount; page += 1) {
      const pageSize = Math.min(remaining, STUCK_RECOVERY_SCAN_LIMIT)
      if (pageSize < 1) break
      const processing = await this.client.lrange(this.processingQueueKey, 0, pageSize - 1)
      remaining -= processing.length

      for (const raw of processing) {
        let envelope: QueueEnvelope<TJob>
        try {
          envelope = this.parseEnvelope(raw)
        } catch {
          let job: TJob
          try {
            job = this.parse(raw)
          } catch {
            throw new Error('Queue recovery found an invalid occurrence envelope')
          }
          const occurrenceId = randomUUID()
          const legacyResult = await this.evalClosed(
            'Queue legacy occurrence recovery failed',
            RECOVER_LEGACY_JOB_SCRIPT,
            [this.processingQueueKey, this.claimsKey, this.queueKey],
            [raw, canonicalEnvelope(occurrenceId, job), String(staleMs)],
          )
          if (legacyResult !== 1 && legacyResult !== 2 && legacyResult !== 3) {
            throw new Error('Queue legacy occurrence recovery returned an invalid result')
          }
          if (legacyResult === 1) recovered += 1
          continue
        }

        const rawResult = await this.evalClosed(
          'Queue recovery found an invalid claim marker',
          RECOVER_STUCK_JOB_SCRIPT,
          [this.processingQueueKey, this.claimsKey, this.queueKey],
          [raw, envelope.occurrenceId, String(staleMs)],
        )
        if (rawResult !== 1 && rawResult !== 2 && rawResult !== 3) {
          throw new Error('Queue recovery returned an invalid result')
        }
        if (rawResult === 1) {
          this.activeClaims.delete(envelope.occurrenceId)
          recovered += 1
        }
      }
    }

    return recovered
  }

  disconnect(): void {
    this.activeClaims.clear()
    this.client.disconnect()
  }
}

function normalizeAttempt(job: Partial<RetryableJob>): number {
  if (job.attempt === undefined) return 1
  if (typeof job.attempt !== 'number' || !Number.isSafeInteger(job.attempt) || job.attempt < 1) {
    throw new Error('attempt must be a positive safe integer')
  }
  return job.attempt
}

function normalizeTaskId(value: unknown): string {
  if (typeof value !== 'string' || !TASK_ID_PATTERN.test(value)) {
    throw new Error('taskId must be a canonical UUID')
  }
  return value
}

function parseClosedJob(raw: string, allowedKeys: readonly string[]): Record<string, unknown> {
  const job = parseClosedObject(raw)
  if (Object.keys(job).some((key) => !allowedKeys.includes(key))) {
    throw new Error('job payload contains unsupported fields')
  }
  return job
}

export class TaskQueue extends RedisListQueue<TaskJob> {
  constructor(redisUrl = getRequiredEnv('REDIS_URL')) {
    super(
      TASK_QUEUE_KEY,
      TASK_PROCESSING_QUEUE_KEY,
      TASK_RETRY_QUEUE_KEY,
      TASK_DEAD_QUEUE_KEY,
      TASK_CLAIMS_KEY,
      TASK_ACK_RECEIPTS_KEY,
      TASK_RELEASE_RECEIPTS_KEY,
      TASK_PROMOTION_DISPOSITIONS_KEY,
      TASK_PROMOTION_DISPOSITION_EXPIRY_KEY,
      redisUrl,
    )
  }

  protected parse(raw: string): TaskJob {
    const job = parseClosedJob(raw, ['taskId', 'attempt']) as Partial<TaskJob>
    return { taskId: normalizeTaskId(job.taskId), attempt: normalizeAttempt(job) }
  }

  override async claim(timeoutSeconds: number): Promise<ClaimedTaskJob | null> {
    return super.claim(timeoutSeconds)
  }
}

export class ApprovalQueue extends RedisListQueue<ApprovalJob> {
  constructor(redisUrl = getRequiredEnv('REDIS_URL')) {
    super(
      APPROVAL_QUEUE_KEY,
      APPROVAL_PROCESSING_QUEUE_KEY,
      APPROVAL_RETRY_QUEUE_KEY,
      APPROVAL_DEAD_QUEUE_KEY,
      APPROVAL_CLAIMS_KEY,
      APPROVAL_ACK_RECEIPTS_KEY,
      APPROVAL_RELEASE_RECEIPTS_KEY,
      APPROVAL_PROMOTION_DISPOSITIONS_KEY,
      APPROVAL_PROMOTION_DISPOSITION_EXPIRY_KEY,
      redisUrl,
    )
  }

  protected parse(raw: string): ApprovalJob {
    const job = parseClosedJob(raw, ['taskId', 'action', 'attempt']) as Partial<ApprovalJob>
    if (job.action !== 'approve') {
      throw new Error('approval action must be approve')
    }
    return {
      taskId: normalizeTaskId(job.taskId),
      action: job.action,
      attempt: normalizeAttempt(job),
    }
  }

  override async claim(timeoutSeconds: number): Promise<ClaimedApprovalJob | null> {
    return super.claim(timeoutSeconds)
  }
}

export class AnswersQueue extends RedisListQueue<AnswersJob> {
  constructor(redisUrl = getRequiredEnv('REDIS_URL')) {
    super(
      ANSWERS_QUEUE_KEY,
      ANSWERS_PROCESSING_QUEUE_KEY,
      ANSWERS_RETRY_QUEUE_KEY,
      ANSWERS_DEAD_QUEUE_KEY,
      ANSWERS_CLAIMS_KEY,
      ANSWERS_ACK_RECEIPTS_KEY,
      ANSWERS_RELEASE_RECEIPTS_KEY,
      ANSWERS_PROMOTION_DISPOSITIONS_KEY,
      ANSWERS_PROMOTION_DISPOSITION_EXPIRY_KEY,
      redisUrl,
    )
  }

  protected parse(raw: string): AnswersJob {
    const job = parseClosedJob(raw, ['taskId', 'attempt']) as Partial<AnswersJob>
    return { taskId: normalizeTaskId(job.taskId), attempt: normalizeAttempt(job) }
  }

  override async claim(timeoutSeconds: number): Promise<ClaimedAnswersJob | null> {
    return super.claim(timeoutSeconds)
  }
}
