import { describe, expect, it } from 'vitest'
import { artifactFromStreamEventData } from '@/hooks/useTaskStream'

describe('artifactFromStreamEventData', () => {
  it('preserves createdAt from live artifact events', () => {
    const artifact = artifactFromStreamEventData({
      id: 'artifact-1',
      agentRunId: 'run-1',
      artifactType: 'adr_text',
      content: 'Plan',
      metadata: { mcpExecutionDesign: { validation: { status: 'valid' } } },
      createdAt: '2026-06-24T10:00:00.000Z',
    })

    expect(artifact).toMatchObject({
      id: 'artifact-1',
      agentRunId: 'run-1',
      artifactType: 'adr_text',
      content: 'Plan',
      createdAt: '2026-06-24T10:00:00.000Z',
    })
  })

  it('continues to accept replay payloads that use artifactId', () => {
    const artifact = artifactFromStreamEventData({
      artifactId: 'artifact-2',
      agentRunId: 'run-2',
      artifactType: 'adr_text',
      content: 'Plan',
    })

    expect(artifact.id).toBe('artifact-2')
    expect(artifact.metadata).toBeNull()
    expect(artifact.createdAt).toBeUndefined()
  })
})
