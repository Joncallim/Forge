import { describe, expect, it } from 'vitest'
import { AGENT_BREAKDOWN_FENCE, CAPABILITY_CLASSIFICATION_FENCE, MCP_EXECUTION_DESIGN_FENCE, OPEN_QUESTIONS_FENCE, stripKnownFences } from '@/lib/plan-fences'

describe('stripKnownFences', () => {
  it('removes both fenced blocks, in either order', () => {
    const text = [
      '# Plan',
      'Do the thing.',
      '',
      '```' + AGENT_BREAKDOWN_FENCE,
      '{"agents":[]}',
      '```',
      '',
      '```' + OPEN_QUESTIONS_FENCE,
      '{"questions":[]}',
      '```',
    ].join('\n')

    const stripped = stripKnownFences(text)
    expect(stripped).toBe('# Plan\nDo the thing.')
    expect(stripped).not.toContain(AGENT_BREAKDOWN_FENCE)
    expect(stripped).not.toContain(OPEN_QUESTIONS_FENCE)
  })

  it('is tolerant of casing and missing trailing newline before the closing fence', () => {
    const text = '# Plan\n```Agent_Breakdown_JSON\n{"agents":[]}```'
    expect(stripKnownFences(text)).toBe('# Plan')
  })

  it('leaves text unchanged when no fences are present', () => {
    expect(stripKnownFences('  # Plan\nbody  ')).toBe('# Plan\nbody')
  })

  it('returns the trimmed text when only one fence is present', () => {
    const text = '# Plan\n\n```' + AGENT_BREAKDOWN_FENCE + '\n{"agents":[]}\n```'
    expect(stripKnownFences(text)).toBe('# Plan')
  })

  it('falls back to a generic ```json fence matching the agent-breakdown shape', () => {
    const text = ['# Plan', 'Do the thing.', '', '```json', '{"agents":[{"role":"Backend"}]}', '```'].join('\n')
    const stripped = stripKnownFences(text)
    expect(stripped).toBe('# Plan\nDo the thing.')
  })

  it('falls back to a generic ```json fence matching the open-questions shape', () => {
    const text = ['# Plan', 'Do the thing.', '', '```json', '{"questions":["Which DB?"]}', '```'].join('\n')
    const stripped = stripKnownFences(text)
    expect(stripped).toBe('# Plan\nDo the thing.')
  })

  it('falls back to a bare untagged fence matching a known shape', () => {
    const text = ['# Plan', 'Do the thing.', '', '```', '{"agents":[{"role":"Backend"}]}', '```'].join('\n')
    const stripped = stripKnownFences(text)
    expect(stripped).toBe('# Plan\nDo the thing.')
  })

  it('prefers the exact tag over a coincidental generic-json fence elsewhere', () => {
    const text = [
      '# Plan',
      'Example API response:',
      '```json',
      '{"agents":["not the real shape, ignored anyway"]}',
      '```',
      '',
      '```' + AGENT_BREAKDOWN_FENCE,
      '{"agents":[{"role":"Backend"}]}',
      '```',
    ].join('\n')

    const stripped = stripKnownFences(text)
    expect(stripped).not.toContain(AGENT_BREAKDOWN_FENCE)
  })

  it('leaves an unrelated generic JSON code block untouched (does not match either known shape)', () => {
    const text = [
      '# Plan',
      'Example API response:',
      '```json',
      '{"status": "ok", "data": {"id": 1}}',
      '```',
    ].join('\n')

    expect(stripKnownFences(text)).toBe(text.trim())
  })

  it('removes the MCP execution design fence', () => {
    const text = [
      '# Plan',
      'Use scoped capabilities.',
      '',
      '```' + MCP_EXECUTION_DESIGN_FENCE,
      '{"schemaVersion":1,"requirements":[],"promptOverlays":{},"mcpAwareSubtasks":[]}',
      '```',
    ].join('\n')

    expect(stripKnownFences(text)).toBe('# Plan\nUse scoped capabilities.')
  })

  it('removes the capability classification fence', () => {
    const text = [
      '# Plan',
      'Classify the work.',
      '',
      '```' + CAPABILITY_CLASSIFICATION_FENCE,
      '{"schemaVersion":1,"required":["api-implementation"],"optional":[],"excluded":[]}',
      '```',
    ].join('\n')

    expect(stripKnownFences(text)).toBe('# Plan\nClassify the work.')
  })

  it('removes a trailing stray empty-object fence under an unrecognized tag', () => {
    const text = ['# Plan', 'Do the thing.', '', '```json', '{}', '```'].join('\n')
    expect(stripKnownFences(text)).toBe('# Plan\nDo the thing.')
  })

  it('removes a stray empty-array fence with no language tag', () => {
    const text = ['# Plan', 'Do the thing.', '', '```', '[]', '```'].join('\n')
    expect(stripKnownFences(text)).toBe('# Plan\nDo the thing.')
  })

  it('removes a whitespace-only fence', () => {
    const text = ['# Plan', 'Do the thing.', '', '```', '   ', '```'].join('\n')
    expect(stripKnownFences(text)).toBe('# Plan\nDo the thing.')
  })

  it('does not remove a non-empty unrecognized JSON fence', () => {
    const text = ['# Plan', 'Do the thing.', '', '```json', '{"note": "keep me"}', '```'].join('\n')
    const stripped = stripKnownFences(text)
    expect(stripped).toContain('{"note": "keep me"}')
  })

  it('preserves an intentional empty-object example placed mid-document', () => {
    const text = [
      '# Plan',
      'An empty request body looks like:',
      '```json',
      '{}',
      '```',
      'Send it as the POST body.',
    ].join('\n')
    expect(stripKnownFences(text)).toBe(text.trim())
  })

  it('preserves an intentional empty-array example placed mid-document', () => {
    const text = [
      '# Plan',
      'No items yet, so the response is:',
      '```json',
      '[]',
      '```',
      'This is expected on a fresh project.',
    ].join('\n')
    expect(stripKnownFences(text)).toBe(text.trim())
  })

  it('removes multiple stacked trailing trivial fences', () => {
    const text = ['# Plan', 'Do the thing.', '', '```json', '{}', '```', '', '```', '[]', '```'].join('\n')
    expect(stripKnownFences(text)).toBe('# Plan\nDo the thing.')
  })

  it('does not strip non-JSON fenced code blocks even if short', () => {
    const text = ['# Plan', 'Run this:', '', '```bash', 'echo hi', '```'].join('\n')
    expect(stripKnownFences(text)).toBe(text.trim())
  })
})
