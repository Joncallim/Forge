import { describe, expect, it } from 'vitest'
import { AGENT_BREAKDOWN_FENCE, parseAgentBreakdown } from '@/worker/agent-breakdown'

function withFence(json: string): string {
  return ['# Plan', '', '- [Frontend] Build UI', '', '```' + AGENT_BREAKDOWN_FENCE, json, '```'].join('\n')
}

describe('parseAgentBreakdown', () => {
  it('extracts structured agent breakdown and strips the fenced block', () => {
    const { planText, agents } = parseAgentBreakdown(
      withFence('{"agents":[{"role":"Frontend","tasks":2,"summary":"Build the task page"}]}'),
    )

    expect(agents).toEqual([
      { role: 'Frontend', tasks: 2, summary: 'Build the task page', steps: [] },
    ])
    expect(planText).toContain('[Frontend] Build UI')
    expect(planText).not.toContain(AGENT_BREAKDOWN_FENCE)
  })

  it('extracts the steps array when present', () => {
    const { agents } = parseAgentBreakdown(
      withFence(
        '{"agents":[{"role":"Frontend","tasks":2,"summary":"Build the task page","steps":["Build the task list component","Wire up state handling"]}]}',
      ),
    )

    expect(agents).toEqual([
      {
        role: 'Frontend',
        tasks: 2,
        summary: 'Build the task page',
        steps: ['Build the task list component', 'Wire up state handling'],
      },
    ])
  })

  it('falls back to role tags when the structured block is absent', () => {
    const { agents } = parseAgentBreakdown([
      '# Plan',
      '',
      '- [Frontend] Build UI',
      '- [Backend] Add API',
      '- [Frontend] Wire state',
    ].join('\n'))

    expect(agents).toEqual([
      { role: 'Frontend', tasks: 2, summary: 'Build UI; Wire state', steps: ['Build UI', 'Wire state'] },
      { role: 'Backend', tasks: 1, summary: 'Add API', steps: ['Add API'] },
    ])
  })

  it('falls back to a generic ```json fence when the model misses the exact tag', () => {
    const text = [
      '# Plan',
      '',
      '- [Frontend] Build UI',
      '',
      '```json',
      '{"agents":[{"role":"Frontend","tasks":2,"summary":"Build the task page"}]}',
      '```',
    ].join('\n')

    const { planText, agents } = parseAgentBreakdown(text)
    expect(agents).toEqual([
      { role: 'Frontend', tasks: 2, summary: 'Build the task page', steps: [] },
    ])
    expect(planText).not.toContain('```json')
    expect(planText).toContain('[Frontend] Build UI')
  })

  it('prefers the exact tag over a coincidental generic-json fence', () => {
    const text = [
      '# Plan',
      'Example response:',
      '```json',
      '{"agents":[{"role":"Coincidental"}]}',
      '```',
      '',
      '```' + AGENT_BREAKDOWN_FENCE,
      '{"agents":[{"role":"Backend","tasks":1,"summary":"Real"}]}',
      '```',
    ].join('\n')

    const { agents } = parseAgentBreakdown(text)
    expect(agents).toEqual([{ role: 'Backend', tasks: 1, summary: 'Real', steps: [] }])
  })

  it('does not extract from a generic JSON block that does not match the expected shape', () => {
    const text = [
      '# Plan',
      '- [Frontend] Build UI',
      'Example API response:',
      '```json',
      '{"status": "ok", "data": {"id": 1}}',
      '```',
    ].join('\n')

    const { planText, agents } = parseAgentBreakdown(text)
    expect(planText).toContain('```json')
    expect(planText).toContain('"status": "ok"')
    // Falls back to role-tag extraction since the structured block isn't present.
    expect(agents).toEqual([{ role: 'Frontend', tasks: 1, summary: 'Build UI', steps: ['Build UI'] }])
  })
})
