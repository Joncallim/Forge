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
})
