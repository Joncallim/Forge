const PROMPT_BEARING_KEY_ALIASES = [
  'prompt',
  'system_prompt',
  'systemPrompt',
  'messages',
  'instruction',
  'instructions',
  'user_prompt',
  'userPrompt',
  'assistant_prompt',
  'content',
  'text',
  'plan_body',
  'full_plan',
  'architect_plan',
] as const

const SECRET_KEY_ALIASES = [
  'apiKey',
  'api_key',
  'token',
  'password',
  'secret',
  'credential',
  'privateKey',
  'private_key',
  'authorization',
  'bearer',
  'accessKey',
  'access_key',
  'sessionSecret',
  'session_secret',
  'encryptionKey',
  'encryption_key',
  'signingKey',
  'signing_key',
] as const

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[_-]/g, '')
}

const PROMPT_BEARING_KEYS = new Set(PROMPT_BEARING_KEY_ALIASES.map(normalizeKey))
const SECRET_KEYS = new Set(SECRET_KEY_ALIASES.map(normalizeKey))

const BYTE_LIMIT = 65536

const DEPTH_LIMIT = 5

export function byteCount(input: string): number {
  return Buffer.byteLength(input, 'utf8')
}

export function isPromptBearingKey(key: string): boolean {
  const lower = normalizeKey(key)
  for (const prefix of PROMPT_BEARING_KEYS) {
    if (lower === prefix || lower.startsWith(prefix) || lower.endsWith(prefix)) {
      return true
    }
  }
  return false
}

export function isSecretKey(key: string): boolean {
  const lower = normalizeKey(key)
  for (const prefix of SECRET_KEYS) {
    if (lower === prefix || lower.startsWith(prefix) || lower.endsWith(prefix)) {
      return true
    }
  }
  return false
}

function truncateUtf8Safe(value: string, maxBytes: number): string {
  if (byteCount(value) <= maxBytes) return value
  const buf = Buffer.from(value, 'utf8')
  let end = maxBytes
  while (end > 0 && (buf[end - 1] & 0xc0) === 0x80) end -= 1
  return buf.subarray(0, end).toString('utf8')
}

export function drainPromptLeakage(value: unknown, depth = 0): string | null {
  if (depth > DEPTH_LIMIT) return '[max depth]'

  if (typeof value === 'string') {
    const secretProbe = value
      .replaceAll('[REDACTED_TOKEN]', '')
      .replaceAll('[REDACTED_SECRET]', '')
    const secretProbeLower = secretProbe.toLowerCase()
    if (
      /(?:system[_ -]?prompt|user[_ -]?prompt|assistant[_ -]?prompt|plan[_ -]?body|full[_ -]?plan|architect[_ -]?plan)\s*[:=]/i.test(value) ||
      /api[_-]?key[=:/]\s*\S+/.test(secretProbeLower) ||
      /bearer\s+\S+/.test(secretProbeLower) ||
      /token[=:/]\s*\S+/.test(secretProbeLower) ||
      /password[=:/]\s*\S+/.test(secretProbeLower) ||
      /secret[=:/]\s*\S+/.test(secretProbeLower) ||
      /-----begin\s+(rsa|openssh|ec|dsa|pgp)\s+private/i.test(secretProbe) ||
      /sk-[a-zA-Z0-9]{20,}/.test(secretProbe) ||
      /ghp_[a-zA-Z0-9]{36}/.test(secretProbe) ||
      /gho_[a-zA-Z0-9]{36}/.test(secretProbe) ||
      /ghu_[a-zA-Z0-9]{36}/.test(secretProbe) ||
      /ghs_[a-zA-Z0-9]{36}/.test(secretProbe) ||
      /ghr_[a-zA-Z0-9]{36}/.test(secretProbe) ||
      /xox[bprsa]-[a-zA-Z0-9-]+/.test(secretProbe)
    ) {
      return '[secret value drained]'
    }
    return truncateUtf8Safe(value, BYTE_LIMIT)
  }

  if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
    return null
  }

  if (Array.isArray(value)) {
    const truncated: unknown[] = []
    let totalBytes = 0
    const maxItems = 100
    for (let index = 0; index < value.length && index < maxItems; index += 1) {
      const drained = drainPromptLeakage(value[index], depth + 1)
      if (drained !== null) {
        truncated.push(drained)
        totalBytes += byteCount(String(drained))
        if (totalBytes > BYTE_LIMIT) break
      }
    }
    return truncated.length > 0 ? JSON.stringify(truncated) : null
  }

  if (typeof value === 'object') {
    const result: Record<string, unknown> = {}
    let totalBytes = 0
    const keys = Object.keys(value as Record<string, unknown>).slice(0, 50)
    for (const key of keys) {
      if (isPromptBearingKey(key)) {
        result[key] = '[prompt content drained]'
        continue
      }
      if (isSecretKey(key)) {
        const raw = String((value as Record<string, unknown>)[key] ?? '')
        const byteLen = Buffer.byteLength(raw, 'utf8')
        result[key] = `[redacted: ${byteLen} bytes]`
        continue
      }
      const drained = drainPromptLeakage((value as Record<string, unknown>)[key], depth + 1)
      if (drained !== null) {
        result[key] = drained
        totalBytes += byteCount(JSON.stringify({ [key]: drained }))
        if (totalBytes > BYTE_LIMIT) break
      }
    }
    return Object.keys(result).length > 0 ? JSON.stringify(result) : null
  }

  return String(value)
}

export function sanitizePromptPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(payload)) {
    if (isPromptBearingKey(key)) {
      result[key] = '[prompt content drained by S4 leakage barrier]'
      continue
    }
    if (isSecretKey(key)) {
      const raw = String(value ?? '')
      result[key] = `[redacted: ${Buffer.byteLength(raw, 'utf8')} bytes]`
      continue
    }
    if (typeof value === 'object' && value !== null) {
      const drained = drainPromptLeakage(value)
      if (drained !== null) result[key] = drained
    } else if (typeof value === 'string') {
      result[key] = drainPromptLeakage(value) ?? '[content drained]'
    } else {
      result[key] = value
    }
  }
  return result
}
