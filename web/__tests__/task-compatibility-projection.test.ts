import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  projectTaskCompatibilityArtifact,
  projectTaskCompatibilityAttempt,
  projectTaskCompatibilityRun,
  projectTaskCompatibilityTask,
  projectTaskCompatibilityVcsChange,
} from '@/lib/mcps/leakage-drain'
import { ARCHITECT_PLAN_HEADER } from '@/lib/mcps/architect-plan-entries'

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

  it('removes local repository locations from VCS compatibility output', () => {
    const change = projectTaskCompatibilityVcsChange({
      id: 'change-1', repository: '/private/forge/local-path-sentinel', diffSummary: 'raw diff', metadata: {},
    })
    expect(change.repository).toBe('legacy_task_log_unavailable')
    expect(change.diffSummary).toBe('legacy_task_log_unavailable')
    expect(JSON.stringify(change)).not.toContain('local-path-sentinel')
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
      content: ARCHITECT_PLAN_HEADER,
      metadata: { historyAvailable: true },
    }))
    expect(JSON.stringify(protectedArtifact)).not.toContain('legacy Architect plan body')
    expect(ordinaryArtifact.content).toBe('ordinary test output')
    expect(ordinaryArtifact.metadata).toEqual({ result: 'passed' })
  })

  it('uses the canonical Architect header for detail and SSE artifact projections', () => {
    const root = process.cwd()
    const drain = fs.readFileSync(path.join(root, 'lib/mcps/leakage-drain.ts'), 'utf8')
    const detail = fs.readFileSync(path.join(root, 'app/api/tasks/[id]/route.ts'), 'utf8')
    const runs = fs.readFileSync(path.join(root, 'app/api/tasks/[id]/runs/route.ts'), 'utf8')

    expect(drain).toContain("import { ARCHITECT_PLAN_HEADER } from '@/lib/mcps/architect-plan-entries'")
    expect(drain).not.toContain('Protected Architect history is available through the protected history reader.')
    expect(detail).toContain('projectTaskCompatibilityArtifact')
    expect(runs).toContain('projectTaskCompatibilityArtifact')
  })
})
