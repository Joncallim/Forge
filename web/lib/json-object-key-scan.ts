export type JsonObjectKeyScanResult = 'valid' | 'duplicate-key' | 'invalid'

/**
 * Scans JSON before JSON.parse can silently discard a repeated object member.
 * The result deliberately carries no source-derived content.
 */
export function scanJsonObjectKeys(json: string): JsonObjectKeyScanResult {
  const MAX_DEPTH = 128
  const MAX_JSON_CODE_UNITS = 1_000_000
  if (json.length > MAX_JSON_CODE_UNITS) return 'invalid'
  let index = 0
  let duplicateKey = false

  const skipWhitespace = (): void => {
    while (index < json.length && /[\u0020\u0009\u000a\u000d]/.test(json[index])) index += 1
  }

  const parseString = (): string | null => {
    if (json[index] !== '"') return null
    index += 1
    let decoded = ''
    while (index < json.length) {
      const character = json[index]
      if (character === '"') {
        index += 1
        return decoded
      }
      if (character.charCodeAt(0) <= 0x1f) return null
      if (character !== '\\') {
        decoded += character
        index += 1
        continue
      }
      index += 1
      if (index >= json.length) return null
      const escape = json[index]
      const simpleEscapes: Record<string, string> = {
        '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t',
      }
      if (Object.hasOwn(simpleEscapes, escape)) {
        decoded += simpleEscapes[escape]
        index += 1
        continue
      }
      if (escape !== 'u') return null
      const hex = json.slice(index + 1, index + 5)
      if (hex.length !== 4 || !/^[0-9a-f]{4}$/i.test(hex)) return null
      decoded += String.fromCharCode(Number.parseInt(hex, 16))
      index += 5
    }
    return null
  }

  const parseNumber = (): boolean => {
    if (json[index] === '-') index += 1
    if (json[index] === '0') index += 1
    else {
      if (!/[1-9]/.test(json[index] ?? '')) return false
      while (/[0-9]/.test(json[index] ?? '')) index += 1
    }
    if (json[index] === '.') {
      index += 1
      if (!/[0-9]/.test(json[index] ?? '')) return false
      while (/[0-9]/.test(json[index] ?? '')) index += 1
    }
    if (json[index] === 'e' || json[index] === 'E') {
      index += 1
      if (json[index] === '+' || json[index] === '-') index += 1
      if (!/[0-9]/.test(json[index] ?? '')) return false
      while (/[0-9]/.test(json[index] ?? '')) index += 1
    }
    return true
  }

  const parseValue = (depth: number): boolean => {
    if (depth > MAX_DEPTH) return false
    skipWhitespace()
    const character = json[index]
    if (character === '"') return parseString() !== null
    if (character === '-' || /[0-9]/.test(character ?? '')) return parseNumber()
    if (json.startsWith('true', index)) { index += 4; return true }
    if (json.startsWith('false', index)) { index += 5; return true }
    if (json.startsWith('null', index)) { index += 4; return true }
    if (character === '[') {
      index += 1
      skipWhitespace()
      if (json[index] === ']') { index += 1; return true }
      while (index < json.length) {
        if (!parseValue(depth + 1)) return false
        skipWhitespace()
        if (json[index] === ']') { index += 1; return true }
        if (json[index] !== ',') return false
        index += 1
        skipWhitespace()
      }
      return false
    }
    if (character === '{') {
      index += 1
      skipWhitespace()
      if (json[index] === '}') { index += 1; return true }
      const keys = new Set<string>()
      while (index < json.length) {
        const key = parseString()
        if (key === null) return false
        if (keys.has(key)) duplicateKey = true
        keys.add(key)
        skipWhitespace()
        if (json[index] !== ':') return false
        index += 1
        if (!parseValue(depth + 1)) return false
        skipWhitespace()
        if (json[index] === '}') { index += 1; return true }
        if (json[index] !== ',') return false
        index += 1
        skipWhitespace()
      }
      return false
    }
    return false
  }

  const valid = parseValue(0)
  skipWhitespace()
  if (!valid || index !== json.length) return 'invalid'
  return duplicateKey ? 'duplicate-key' : 'valid'
}
