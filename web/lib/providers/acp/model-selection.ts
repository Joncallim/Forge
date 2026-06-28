import type { AcpModelSelectionSupport } from './catalog'

export type AcpModelConfigRequest = {
  sessionId: string
  configId: string
  value: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function normalized(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_-]+/g, '')
}

function candidateStrings(record: Record<string, unknown>, keys: string[]): string[] {
  return keys
    .map((key) => stringValue(record[key]))
    .filter((value): value is string => value !== null)
}

function findConfigOptionRecords(value: unknown, seen = new Set<unknown>()): Record<string, unknown>[] {
  if (!isRecord(value) || seen.has(value)) return []
  seen.add(value)

  const records: Record<string, unknown>[] = []
  const hasConfigIdentity = candidateStrings(value, ['configId', 'id', 'name', 'key']).length > 0
  const hasOptionShape = Array.isArray(value.options) || Array.isArray(value.values)
  const category = stringValue(value.category)
  const optionType = stringValue(value.type)
  if (hasConfigIdentity && (hasOptionShape || category !== null || optionType !== null)) {
    records.push(value)
  }

  for (const child of Object.values(value)) {
    if (Array.isArray(child)) {
      for (const item of child) records.push(...findConfigOptionRecords(item, seen))
    } else if (isRecord(child)) {
      records.push(...findConfigOptionRecords(child, seen))
    }
  }
  return records
}

function modelValueFromOption(configOption: Record<string, unknown>, selectedModel: string): string {
  const rawOptions = Array.isArray(configOption.options)
    ? configOption.options
    : Array.isArray(configOption.values)
      ? configOption.values
      : []
  if (rawOptions.length === 0) return selectedModel

  const selected = normalized(selectedModel)
  for (const option of rawOptions) {
    if (typeof option === 'string' && normalized(option) === selected) return option
    if (!isRecord(option)) continue
    const values = candidateStrings(option, ['value', 'id', 'name', 'label', 'title'])
    if (values.some((value) => normalized(value) === selected)) {
      return stringValue(option.value) ?? stringValue(option.id) ?? values[0]
    }
  }

  return selectedModel
}

function scoreConfigOption(configOption: Record<string, unknown>, support: AcpModelSelectionSupport): number {
  const identities = candidateStrings(configOption, ['configId', 'id', 'name', 'key'])
    .map(normalized)
  const labels = candidateStrings(configOption, ['label', 'title', 'description'])
    .map(normalized)
  const categories = candidateStrings(configOption, ['category'])
    .map(normalized)
  const idCandidates = support.configIdCandidates.map(normalized)
  const categoryCandidates = support.optionCategoryCandidates.map(normalized)

  let score = 0
  if (identities.some((value) => idCandidates.includes(value))) score += 100
  if (identities.some((value) => value.includes('model'))) score += 50
  if (categories.some((value) => categoryCandidates.includes(value) || value.includes('model'))) score += 25
  if (labels.some((value) => value.includes('model'))) score += 10
  return score
}

export function buildAcpModelConfigRequest(
  sessionId: string,
  selectedModel: string,
  support: AcpModelSelectionSupport,
  sessionResult: unknown,
): AcpModelConfigRequest {
  const configOptions = findConfigOptionRecords(sessionResult)
    .map((option) => ({ option, score: scoreConfigOption(option, support) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)

  const configOption = configOptions[0]?.option
  const configId = configOption
    ? stringValue(configOption.configId) ??
      stringValue(configOption.id) ??
      stringValue(configOption.name) ??
      stringValue(configOption.key) ??
      support.configIdCandidates[0]
    : support.configIdCandidates[0]

  return {
    sessionId,
    configId,
    value: configOption ? modelValueFromOption(configOption, selectedModel) : selectedModel,
  }
}
