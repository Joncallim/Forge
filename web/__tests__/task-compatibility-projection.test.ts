import { describe, expect, it } from 'vitest'
import {
  PROTECTED_ARCHITECT_HISTORY_HEADER,
  projectTaskCompatibilityArtifact,
  projectTaskCompatibilityAttempt,
  projectTaskCompatibilityRun,
  projectTaskCompatibilityTask,
} from '@/lib/mcps/leakage-drain'

describe('task compatibility projection', () => {
  it('keeps the authorized canonical task prompt but replaces derived diagnostic text', () => {
    const task = projectTaskCompatibilityTask({
      id: 'task-1',
      prompt: 'authorized canonical task prompt',
      errorMessage: 'prompt copied into a caught error',
      projectId: 'project-1',
      status: 'failed',
    })
    const run = projectTaskCompatibilityRun({
      id: 'run-1', taskId: 'task-1', errorMessage: 'secret/path/prompt diagnostic', status: 'failed',
    })
    const attempt = projectTaskCompatibilityAttempt({
      id: 'attempt-1', taskId: 'task-1', jobPayload: { prompt: 'must not escape' }, errorMessage: 'raw error',
    })

    expect(task.prompt).toBe('authorized canonical task prompt')
    expect(task.errorMessage).toBe('legacy_task_log_unavailable')
    expect(run.errorMessage).toBe('legacy_task_log_unavailable')
    expect(attempt.errorMessage).toBe('legacy_task_log_unavailable')
    expect(attempt).not.toHaveProperty('jobPayload')
  })

  it('closes current and legacy Architect adr_text while preserving ordinary artifact content and sanitizing metadata', () => {
    const architectRun = { id: 'run-architect', agentType: 'architect', stage: null }
    const protectedArtifact = projectTaskCompatibilityArtifact({
      id: 'artifact-architect', agentRunId: architectRun.id, artifactType: 'adr_text',
      content: 'legacy Architect plan body', metadata: { storageLocator: '/private/plan', historyAvailable: true },
    }, architectRun)
    const ordinaryArtifact = projectTaskCompatibilityArtifact({
      id: 'artifact-test', agentRunId: 'run-qa', artifactType: 'test_report',
      content: 'ordinary test output', metadata: { result: 'passed', selectedPath: '/private/nope' },
    }, { id: 'run-qa', agentType: 'qa', stage: 'verify' })

    expect(protectedArtifact).toEqual(expect.objectContaining({
      content: PROTECTED_ARCHITECT_HISTORY_HEADER,
      metadata: { historyAvailable: true },
    }))
    expect(JSON.stringify(protectedArtifact)).not.toContain('legacy Architect plan body')
    expect(ordinaryArtifact.content).toBe('ordinary test output')
    expect(ordinaryArtifact.metadata).toEqual({ result: 'passed' })
  })
})
