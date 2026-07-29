import { describe, expect, it } from 'vitest'
import {
  classifySensitivePayloadKey,
  sanitizeLogStructuredValue,
} from '@/lib/task-log-sanitization'

describe('sanitizeLogStructuredValue sensitive-key removal', () => {
  it('strips shapeless secrets stored under secret-named keys', () => {
    const cleaned = sanitizeLogStructuredValue({
      apiKey: 'a-plain-value-with-no-token-shape',
      githubToken: 'plain-github-secret',
      slackToken: 'plain-slack-secret',
      idToken: 'opaque-oidc-token',
      nested: { credential: 'opaque-secret', password: 'hunter2' },
      access_token: 'shapeless',
    }) as Record<string, unknown>

    expect(cleaned).not.toHaveProperty('apiKey')
    expect(cleaned).not.toHaveProperty('githubToken')
    expect(cleaned).not.toHaveProperty('slackToken')
    expect(cleaned).not.toHaveProperty('idToken')
    expect(cleaned).not.toHaveProperty('access_token')
    const nested = cleaned.nested as Record<string, unknown>
    expect(nested).not.toHaveProperty('credential')
    expect(nested).not.toHaveProperty('password')
  })

  it('classifies camel, snake, and kebab aliases through one canonical registry', () => {
    for (const key of ['systemPrompt', 'system_prompt', 'system-prompt', 'promptOverlay', 'prompt_overlay']) {
      expect(classifySensitivePayloadKey(key)).toBe('prompt')
    }
    for (const key of ['apiKey', 'api_key', 'api-key', 'githubToken']) {
      expect(classifySensitivePayloadKey(key)).toBe('secret')
    }
    expect(classifySensitivePayloadKey('stderr')).toBe('snapshot')
    expect(classifySensitivePayloadKey('prompt_sha256')).toBe('unkeyed_digest')
    expect(classifySensitivePayloadKey('inputTokens')).toBeNull()
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

  it('removes clarification text aliases from structured task logs', () => {
    const cleaned = sanitizeLogStructuredValue({
      id: 'question-1',
      status: 'open',
      question: 'RAW-QUESTION-SENTINEL',
      suggestions: ['RAW-SUGGESTION-SENTINEL'],
      answer: 'RAW-ANSWER-SENTINEL',
      nested: {
        openQuestions: [{ question: 'RAW-NESTED-QUESTION-SENTINEL' }],
        answeredQuestions: [{ answer: 'RAW-NESTED-ANSWER-SENTINEL' }],
      },
    }) as Record<string, unknown>

    expect(cleaned).toEqual({
      id: 'question-1',
      status: 'open',
      nested: {},
    })
    expect(JSON.stringify(cleaned)).not.toContain('RAW-')
    for (const key of [
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
    ]) {
      expect(classifySensitivePayloadKey(key)).toBe('prompt')
    }
  })

  it('leaves ordinary values untouched', () => {
    const cleaned = sanitizeLogStructuredValue({
      status: 'ready',
      count: 3,
    }) as Record<string, unknown>

    expect(cleaned).toEqual({ status: 'ready', count: 3 })
  })

  it('never returns truncated raw text for oversized or unknown legacy values', () => {
    const sentinel = 'RAW-PLAN-SENTINEL'
    const cleaned = sanitizeLogStructuredValue({
      oversized: sentinel.repeat(100),
      stdout: `${sentinel} /private/repository/path`,
    }, { stringByteLimit: 32 }) as Record<string, unknown>

    expect(cleaned.oversized).toEqual({
      kind: 'unknown_legacy_digest',
      byteCount: sentinel.repeat(100).length,
    })
    expect(cleaned.stdout).toEqual({
      kind: 'unknown_legacy_digest',
      byteCount: Buffer.byteLength(`${sentinel} /private/repository/path`),
    })
    expect(JSON.stringify(cleaned)).not.toContain(sentinel)
    expect(JSON.stringify(cleaned)).not.toContain('/private/repository/path')
    expect(JSON.stringify(cleaned)).not.toContain('truncated')
  })
})
