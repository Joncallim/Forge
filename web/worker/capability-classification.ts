import {
  CAPABILITY_CLASSIFICATION_FENCE,
  findFence,
  isCapabilityClassificationShape,
} from '@/lib/plan-fences'

export const CAPABILITY_TAXONOMY = [
  'system-design',
  'api-contract-design',
  'data-modeling',
  'api-implementation',
  'database-migration',
  'business-logic',
  'background-jobs',
  'service-integration',
  'ui-implementation',
  'state-management',
  'routing',
  'api-integration',
  'unit-testing',
  'integration-testing',
  'e2e-testing',
  'coverage-analysis',
  'security-review',
  'code-review',
  'performance-review',
  'ci-cd-config',
  'infra-config',
  'deployment',
] as const

export type Capability = typeof CAPABILITY_TAXONOMY[number]

export type ExcludedCapability = {
  capability: Capability
  reason: string
}

export type CapabilityClassification = {
  schemaVersion: 1
  required: Capability[]
  optional: Capability[]
  excluded: ExcludedCapability[]
}

export type CapabilityClassificationValidation = {
  status: 'valid' | 'warnings'
  warnings: string[]
}

export type CapabilityClassificationMetadata = {
  proposed: CapabilityClassification
  validation: CapabilityClassificationValidation
}

export type ParsedCapabilityClassification = {
  planText: string
  capabilityClassification: CapabilityClassificationMetadata
}

const FENCE_REGEX = new RegExp(
  '```' + CAPABILITY_CLASSIFICATION_FENCE + '\\s*\\n([\\s\\S]*?)[ \\t]*\\n?[ \\t]*```',
  'i',
)

const TAXONOMY = new Set<string>(CAPABILITY_TAXONOMY)

function emptyClassification(): CapabilityClassification {
  return {
    schemaVersion: 1,
    required: [],
    optional: [],
    excluded: [],
  }
}

function cleanText(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return ''
  return value.trim().replace(/\s+/g, ' ').slice(0, maxLength)
}

function normalizeCapabilityArray(
  raw: unknown,
  bucket: string,
  warnings: string[],
): Capability[] {
  if (!Array.isArray(raw)) {
    warnings.push(`${bucket} capabilities must be an array.`)
    return []
  }

  const result: Capability[] = []
  for (const item of raw) {
    const capability = cleanText(item, 80)
    if (capability === '') continue
    if (!TAXONOMY.has(capability)) {
      warnings.push(`Unknown ${bucket} capability '${capability}' was ignored.`)
      continue
    }
    result.push(capability as Capability)
  }
  return result
}

function normalizeExcluded(raw: unknown, warnings: string[]): ExcludedCapability[] {
  if (!Array.isArray(raw)) {
    warnings.push('Excluded capabilities must be an array.')
    return []
  }

  const result: ExcludedCapability[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const value = item as Record<string, unknown>
    const capability = cleanText(value.capability, 80)
    const reason = cleanText(value.reason, 240)
    if (capability === '') continue
    if (!TAXONOMY.has(capability)) {
      warnings.push(`Unknown excluded capability '${capability}' was ignored.`)
      continue
    }
    if (reason === '') {
      warnings.push(`Excluded capability '${capability}' was ignored because it did not include a reason.`)
      continue
    }
    result.push({ capability: capability as Capability, reason })
  }
  return result
}

function dedupeByPrecedence(
  required: Capability[],
  optional: Capability[],
  excluded: ExcludedCapability[],
): CapabilityClassification {
  const seen = new Set<Capability>()
  const uniqueRequired: Capability[] = []
  const uniqueOptional: Capability[] = []
  const uniqueExcluded: ExcludedCapability[] = []

  for (const capability of required) {
    if (seen.has(capability)) continue
    uniqueRequired.push(capability)
    seen.add(capability)
  }

  for (const capability of optional) {
    if (seen.has(capability)) continue
    uniqueOptional.push(capability)
    seen.add(capability)
  }

  for (const item of excluded) {
    if (seen.has(item.capability)) continue
    uniqueExcluded.push(item)
    seen.add(item.capability)
  }

  return {
    schemaVersion: 1,
    required: uniqueRequired,
    optional: uniqueOptional,
    excluded: uniqueExcluded,
  }
}

function normalizeClassification(parsed: unknown): CapabilityClassificationMetadata {
  const warnings: string[] = []
  if (!isCapabilityClassificationShape(parsed)) {
    return {
      proposed: emptyClassification(),
      validation: {
        status: 'warnings',
        warnings: ['Architect capability classification was missing or malformed.'],
      },
    }
  }

  const value = parsed as Record<string, unknown>
  const required = normalizeCapabilityArray(value.required, 'required', warnings)
  const optional = normalizeCapabilityArray(value.optional, 'optional', warnings)
  const excluded = normalizeExcluded(value.excluded, warnings)

  return {
    proposed: dedupeByPrecedence(required, optional, excluded),
    validation: {
      status: warnings.length > 0 ? 'warnings' : 'valid',
      warnings,
    },
  }
}

export function parseCapabilityClassification(rawText: string): ParsedCapabilityClassification {
  const match = findFence(rawText, FENCE_REGEX, isCapabilityClassificationShape)
  if (!match) {
    return {
      planText: rawText.trim(),
      capabilityClassification: {
        proposed: emptyClassification(),
        validation: {
          status: 'warnings',
          warnings: ['Architect did not provide a machine-readable capability classification.'],
        },
      },
    }
  }

  let capabilityClassification: CapabilityClassificationMetadata
  try {
    capabilityClassification = normalizeClassification(JSON.parse(match.jsonBlock))
  } catch {
    capabilityClassification = {
      proposed: emptyClassification(),
      validation: {
        status: 'warnings',
        warnings: ['Architect capability classification JSON could not be parsed.'],
      },
    }
  }

  return {
    planText: rawText.replace(match.fullMatch, '').trim(),
    capabilityClassification,
  }
}
