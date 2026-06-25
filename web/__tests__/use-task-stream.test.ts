import { describe, expect, it } from 'vitest'
import {
  artifactFromStreamEventData,
  shouldRefreshTaskDetailsForArtifact,
} from '@/hooks/useTaskStream'

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

  it('hydrates workPackageId from package-scoped artifact events', () => {
    const artifact = artifactFromStreamEventData({
      id: 'artifact-3',
      agentRunId: 'run-3',
      artifactType: 'log_output',
      content: 'Handoff recorded',
      metadata: { workPackageId: 'package-1' },
    })

    expect(artifact.workPackageId).toBe('package-1')

    const explicitArtifact = artifactFromStreamEventData({
      id: 'artifact-4',
      agentRunId: 'run-4',
      artifactType: 'log_output',
      content: 'Specialist run recorded',
      metadata: { workPackageId: 'metadata-package' },
      workPackageId: 'event-package',
    })

    expect(explicitArtifact.workPackageId).toBe('event-package')
  })

  it('requests detail refresh only for package-scoped artifacts', () => {
    expect(shouldRefreshTaskDetailsForArtifact(artifactFromStreamEventData({
      id: 'artifact-5',
      agentRunId: 'run-5',
      artifactType: 'log_output',
      content: 'Specialist output',
      workPackageId: 'package-1',
    }))).toBe(true)

    expect(shouldRefreshTaskDetailsForArtifact(artifactFromStreamEventData({
      id: 'artifact-6',
      agentRunId: 'run-6',
      artifactType: 'adr_text',
      content: 'Task plan',
    }))).toBe(false)
  })
})
