import { describe, expect, it } from 'vitest'
import {
  type AgentRun,
  agentRunFromStartedStreamEventData,
  artifactFromStreamEventData,
  mergeStreamAgentRun,
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

describe('streamed agent run helpers', () => {
  it('preserves package execution metadata from run:started payloads', () => {
    expect(agentRunFromStartedStreamEventData({
      runId: 'run-1',
      agentType: 'frontend',
      attemptNumber: 3,
      modelIdUsed: 'model',
      stage: 'implementation',
      startedAt: '2026-06-30T10:00:00.000Z',
      workPackageId: 'pkg-1',
    }, 'task-1', '2026-06-30T09:59:00.000Z')).toMatchObject({
      id: 'run-1',
      taskId: 'task-1',
      agentType: 'frontend',
      attemptNumber: 3,
      modelIdUsed: 'model',
      stage: 'implementation',
      startedAt: '2026-06-30T10:00:00.000Z',
      status: 'running',
      workPackageId: 'pkg-1',
    })
  })

  it('merges duplicate streamed run snapshots without dropping package metadata', () => {
    const existing = agentRunFromStartedStreamEventData({
      runId: 'run-1',
      agentType: 'frontend',
      attemptNumber: 2,
      modelIdUsed: 'model',
      stage: 'implementation',
      workPackageId: 'pkg-1',
    }, 'task-1', '2026-06-30T09:59:00.000Z')
    const incoming = agentRunFromStartedStreamEventData({
      runId: 'run-1',
      agentType: 'frontend',
      modelIdUsed: 'model',
      status: 'completed',
    }, 'task-1', '2026-06-30T10:00:00.000Z')

    expect(existing).not.toBeNull()
    expect(incoming).not.toBeNull()
    expect(mergeStreamAgentRun([existing!], incoming!)).toMatchObject([{
      id: 'run-1',
      attemptNumber: 2,
      stage: 'implementation',
      status: 'completed',
      workPackageId: 'pkg-1',
    }])
  })

  it('does not revert a terminal run to running when run:started replays', () => {
    const completed: AgentRun = {
      ...agentRunFromStartedStreamEventData({
        runId: 'run-1',
        agentType: 'frontend',
        attemptNumber: 2,
        modelIdUsed: 'model',
        stage: 'implementation',
        workPackageId: 'pkg-1',
      }, 'task-1', '2026-06-30T09:59:00.000Z')!,
      status: 'completed',
      completedAt: '2026-06-30T10:05:00.000Z',
    }
    const replayedStart = agentRunFromStartedStreamEventData({
      runId: 'run-1',
      // Replayed start payloads may omit agentType/modelIdUsed.
      startedAt: '2026-06-30T10:00:00.000Z',
    }, 'task-1', '2026-06-30T10:00:00.000Z')

    expect(replayedStart).not.toBeNull()
    expect(mergeStreamAgentRun([completed], replayedStart!)).toMatchObject([{
      id: 'run-1',
      status: 'completed',
      agentType: 'frontend',
      modelIdUsed: 'model',
      completedAt: '2026-06-30T10:05:00.000Z',
    }])
  })
})
