export type CapabilityClassificationMetadata = {
  proposed: {
    schemaVersion: 1
    required: string[]
    optional: string[]
    excluded: Array<{
      capability: string
      reason: string
    }>
  }
  validation: {
    status: 'valid' | 'warnings'
    warnings: string[]
  }
}

export type CapabilityClassificationArtifact = {
  artifactType: string
  metadata: unknown
  createdAt?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}

function artifactTime(artifact: CapabilityClassificationArtifact): number {
  if (!artifact.createdAt) return 0
  const timestamp = new Date(artifact.createdAt).getTime()
  return Number.isFinite(timestamp) ? timestamp : 0
}

export function latestCapabilityClassificationFromArtifacts(
  artifacts: CapabilityClassificationArtifact[],
): CapabilityClassificationMetadata | null {
  const plans = artifacts
    .filter((artifact) => artifact.artifactType === 'adr_text')
    .sort((a, b) => artifactTime(a) - artifactTime(b))

  for (const artifact of [...plans].reverse()) {
    if (!isRecord(artifact.metadata) || !isRecord(artifact.metadata.capabilityClassification)) continue
    const classification = artifact.metadata.capabilityClassification
    if (!isRecord(classification.proposed) || !isRecord(classification.validation)) continue

    const proposed = classification.proposed
    const validation = classification.validation

    return {
      proposed: {
        schemaVersion: 1,
        required: normalizeStringArray(proposed.required),
        optional: normalizeStringArray(proposed.optional),
        excluded: Array.isArray(proposed.excluded)
          ? proposed.excluded.filter(isRecord).map((item) => ({
              capability: typeof item.capability === 'string' ? item.capability : '',
              reason: typeof item.reason === 'string' ? item.reason : '',
            }))
          : [],
      },
      validation: {
        status: validation.status === 'warnings' ? 'warnings' : 'valid',
        warnings: normalizeStringArray(validation.warnings),
      },
    }
  }

  return null
}
