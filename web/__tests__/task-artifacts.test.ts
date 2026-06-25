import { describe, expect, it } from 'vitest'
import {
  artifactArrayField,
  mergeArtifacts,
  taskLevelArtifactsForWorkPackages,
} from '@/lib/task-artifacts'

const taskArtifact = {
  id: 'artifact-task',
  agentRunId: 'run-task',
  artifactType: 'adr_text',
  content: 'Task-level plan',
  metadata: null,
}

const packageArtifact = {
  id: 'artifact-package',
  agentRunId: 'run-package',
  artifactType: 'log_output',
  content: 'Package output',
  metadata: null,
}

describe('task artifact helpers', () => {
  it('extracts valid artifacts from work package fields', () => {
    const artifacts = artifactArrayField({
      artifacts: [
        packageArtifact,
        { id: 'missing-content', agentRunId: 'run-1', artifactType: 'log_output' },
      ],
    }, ['artifacts', 'packageArtifacts'])

    expect(artifacts).toEqual([packageArtifact])
  })

  it('merges initial and stream artifacts by id with stream events winning', () => {
    const merged = mergeArtifacts(
      [taskArtifact, { ...packageArtifact, content: 'Old output' }],
      [{ ...packageArtifact, content: 'Updated output' }],
    )

    expect(merged).toEqual([
      taskArtifact,
      { ...packageArtifact, content: 'Updated output' },
    ])
  })

  it('keeps package artifacts out of the task-level sidebar list', () => {
    const taskLevelArtifacts = taskLevelArtifactsForWorkPackages(
      [taskArtifact, packageArtifact, { ...packageArtifact, id: 'artifact-live', workPackageId: 'package-1' }],
      [{ id: 'package-1', artifacts: [packageArtifact] }],
    )

    expect(taskLevelArtifacts).toEqual([taskArtifact])
  })
})
