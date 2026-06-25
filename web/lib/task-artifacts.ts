export interface ArtifactRecord {
  id: string
  agentRunId: string
  artifactType: string
  content: string
  workPackageId?: string
}

export type WorkforceRecord = Record<string, unknown>

function isRecord(value: unknown): value is WorkforceRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function artifactArrayField<T extends ArtifactRecord = ArtifactRecord>(
  record: WorkforceRecord,
  keys: string[],
): T[] {
  for (const key of keys) {
    const value = record[key]
    if (!Array.isArray(value)) continue
    return value.filter((item): item is T => {
      if (!isRecord(item)) return false
      return (
        typeof item.id === 'string' &&
        typeof item.agentRunId === 'string' &&
        typeof item.artifactType === 'string' &&
        typeof item.content === 'string'
      )
    })
  }
  return []
}

export function mergeArtifacts<T extends ArtifactRecord>(initialArtifacts: T[], streamArtifacts: T[]): T[] {
  const artifactsById = new Map<string, T>()
  for (const artifact of initialArtifacts) {
    artifactsById.set(artifact.id, artifact)
  }
  for (const artifact of streamArtifacts) {
    artifactsById.set(artifact.id, artifact)
  }
  return Array.from(artifactsById.values())
}

export function packageArtifactIds(workPackages: WorkforceRecord[]): Set<string> {
  return new Set(
    workPackages.flatMap((pkg) =>
      artifactArrayField(pkg, ['artifacts', 'packageArtifacts']).map((artifact) => artifact.id),
    ),
  )
}

export function taskLevelArtifactsForWorkPackages<T extends ArtifactRecord>(
  artifacts: T[],
  workPackages: WorkforceRecord[],
): T[] {
  const packageIds = packageArtifactIds(workPackages)
  return artifacts.filter((artifact) => !packageIds.has(artifact.id) && !artifact.workPackageId)
}
