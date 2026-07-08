import path from 'node:path'
import {
  handoffArtifactsSchema,
  positiveIntSchema,
  runIdSchema,
  type HandoffArtifacts,
  type RunId,
} from '../contracts/common'

// Handoff artifacts live in a per-run directory nested under the run record:
//   .forge/runs/<issue>/<run-id>/{handoff.md,prompt.md,metadata.json}
// That nested directory is intentionally git-ignored (only the sibling
// <run-id>.json run record is tracked), so local prompts and metadata never land
// in the durable, repository-visible run log.
export const HANDOFF_ARTIFACT_FILENAMES = Object.freeze({
  handoff: 'handoff.md',
  prompt: 'prompt.md',
  metadata: 'metadata.json',
} as const)

export function handoffArtifactDirectory(issueNumber: number, runId: RunId): string {
  const number = positiveIntSchema.parse(issueNumber)
  const id = runIdSchema.parse(runId)
  return path.posix.join('.forge', 'runs', String(number), id)
}

// Predictable artifact paths for #153. Returns the exact `handoffArtifacts`
// shape the run log (#146) already stores, so the handoff adapter records paths
// through the existing contract instead of inventing a new one.
export function buildHandoffArtifacts(input: { issueNumber: number; runId: RunId }): HandoffArtifacts {
  const directory = handoffArtifactDirectory(input.issueNumber, input.runId)
  return handoffArtifactsSchema.parse({
    handoffPath: path.posix.join(directory, HANDOFF_ARTIFACT_FILENAMES.handoff),
    promptPath: path.posix.join(directory, HANDOFF_ARTIFACT_FILENAMES.prompt),
    metadataPath: path.posix.join(directory, HANDOFF_ARTIFACT_FILENAMES.metadata),
  })
}
