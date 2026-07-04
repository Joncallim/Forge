import { describe, expect, it } from 'vitest'
import { sanitizeLogStructuredValue } from '@/lib/task-log-sanitization'

describe('sanitizeLogStructuredValue secret-key redaction', () => {
  it('redacts shapeless secrets stored under secret-named keys', () => {
    const cleaned = sanitizeLogStructuredValue({
      apiKey: 'a-plain-value-with-no-token-shape',
      githubToken: 'plain-github-secret',
      slackToken: 'plain-slack-secret',
      idToken: 'opaque-oidc-token',
      nested: { credential: 'opaque-secret', password: 'hunter2' },
      access_token: 'shapeless',
    }) as Record<string, unknown>

    expect(cleaned.apiKey).toBe('[REDACTED_TOKEN]')
    expect(cleaned.githubToken).toBe('[REDACTED_TOKEN]')
    expect(cleaned.slackToken).toBe('[REDACTED_TOKEN]')
    expect(cleaned.idToken).toBe('[REDACTED_TOKEN]')
    expect(cleaned.access_token).toBe('[REDACTED_TOKEN]')
    const nested = cleaned.nested as Record<string, unknown>
    expect(nested.credential).toBe('[REDACTED_TOKEN]')
    expect(nested.password).toBe('[REDACTED_TOKEN]')
  })

  it('does not redact token-count fields that merely contain "token"', () => {
    const cleaned = sanitizeLogStructuredValue({
      inputTokens: 1200,
      totalTokens: 1540,
      tokenCount: 5,
    }) as Record<string, unknown>

    expect(cleaned.inputTokens).toBe(1200)
    expect(cleaned.totalTokens).toBe(1540)
    expect(cleaned.tokenCount).toBe(5)
  })

  it('leaves ordinary values untouched', () => {
    const cleaned = sanitizeLogStructuredValue({
      status: 'ready',
      count: 3,
    }) as Record<string, unknown>

    expect(cleaned).toEqual({ status: 'ready', count: 3 })
  })
})
