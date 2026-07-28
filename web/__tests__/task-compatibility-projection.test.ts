import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  projectTaskCompatibilityArtifact,
  projectTaskCompatibilityAttempt,
  projectTaskCompatibilityRun,
  projectTaskCompatibilityTask,
  projectTaskCompatibilityVcsChange,
  projectTaskCompatibilityWorkPackage,
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

  it('closes work-package rows while preserving authorized plan and public annotations', () => {
    const projected = projectTaskCompatibilityWorkPackage({
      id: 'package-1',
      taskId: 'task-1',
      harnessId: 'harness-1',
      assignedRole: 'backend',
      title: 'Implement the API',
      summary: 'Add the closed endpoint.',
      status: 'blocked',
      sequence: 2,
      steps: ['Implement', 'Test'],
      requiredCapabilities: { required: ['filesystem.read'] },
      acceptanceCriteria: ['No raw output'],
      mcpRequirements: [{ mcpId: 'filesystem' }],
      reviewRequirement: 'both',
      blockedReason: 'RAW-BLOCKED-REASON /private/secret prompt',
      metadata: { safeCount: 3, promptOverlay: 'RAW-METADATA-PROMPT' },
      createdAt: 'created',
      updatedAt: 'updated',
      futureDatabaseColumn: 'RAW-FUTURE-COLUMN',
    }, {
      metadata: { safeCount: 3 },
      harnessRole: 'backend',
      harnessDisplayName: 'Backend',
      harnessDescription: 'API specialist.',
      artifacts: [{ id: 'artifact-1' }],
    })

    expect(projected).toMatchObject({
      id: 'package-1',
      assignedRole: 'backend',
      title: 'Implement the API',
      summary: 'Add the closed endpoint.',
      status: 'blocked',
      sequence: 2,
      steps: ['Implement', 'Test'],
      acceptanceCriteria: ['No raw output'],
      reviewRequirement: 'both',
      blockedReason: 'legacy_task_log_unavailable',
      metadata: { safeCount: 3 },
      harnessRole: 'backend',
      harnessDisplayName: 'Backend',
      artifacts: [{ id: 'artifact-1' }],
    })
    expect(projected).not.toHaveProperty('futureDatabaseColumn')
    expect(JSON.stringify(projected)).not.toContain('RAW-')
    expect(projectTaskCompatibilityWorkPackage({ blockedReason: null }).blockedReason).toBeNull()
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
