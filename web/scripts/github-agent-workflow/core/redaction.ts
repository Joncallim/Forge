// Best-effort redaction only. Callers must still avoid routing secrets,
// credentials, model transcripts, or local auth material into workflow text.
const SECRET_PATTERNS: readonly RegExp[] = Object.freeze([
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi,
  /\b(token|password|secret|api[_-]?key)\s*[:=]\s*['"]?[^'"\s,;]+/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
])

export function redactSecretLikeText(text: string): string {
  let redacted = text
  for (const pattern of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, '[redacted]')
  }
  return redacted
}

export function compactRedactedText(text: string): string {
  return redactSecretLikeText(text).replace(/\s+/g, ' ').trim()
}
