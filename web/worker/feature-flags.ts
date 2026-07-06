export type DefaultOnFeatureFlagState = {
  enabled: boolean
  rawValue: string | null
  recognized: boolean
}

const DISABLED_VALUES = new Set(['0', 'false', 'off', 'no', 'disabled'])
const ENABLED_VALUES = new Set(['1', 'true', 'on', 'yes', 'enabled'])

export function defaultOnFeatureFlagState(value: string | undefined): DefaultOnFeatureFlagState {
  if (value === undefined) return { enabled: true, rawValue: null, recognized: true }

  const normalized = value.trim().toLowerCase()
  if (normalized === '') return { enabled: true, rawValue: value, recognized: true }
  if (DISABLED_VALUES.has(normalized)) return { enabled: false, rawValue: value, recognized: true }
  if (ENABLED_VALUES.has(normalized)) return { enabled: true, rawValue: value, recognized: true }
  return { enabled: true, rawValue: value, recognized: false }
}

export function defaultOnFeatureFlagEnabled(value: string | undefined): boolean {
  return defaultOnFeatureFlagState(value).enabled
}
