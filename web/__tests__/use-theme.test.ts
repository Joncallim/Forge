import { describe, expect, it } from 'vitest'
import {
  DEFAULT_THEME_ACCENT,
  DEFAULT_THEME_MODE,
  normalizeThemeAccent,
  normalizeThemeMode,
  resolveThemeMode,
} from '@/hooks/useTheme'

describe('normalizeThemeMode', () => {
  it('accepts the supported modes', () => {
    expect(normalizeThemeMode('light')).toBe('light')
    expect(normalizeThemeMode('dark')).toBe('dark')
    expect(normalizeThemeMode('system')).toBe('system')
  })

  it('falls back to the default for unknown or missing values', () => {
    expect(normalizeThemeMode('sepia')).toBe(DEFAULT_THEME_MODE)
    expect(normalizeThemeMode(null)).toBe(DEFAULT_THEME_MODE)
    expect(normalizeThemeMode(undefined)).toBe(DEFAULT_THEME_MODE)
  })
})

describe('normalizeThemeAccent', () => {
  it('accepts the supported accents', () => {
    expect(normalizeThemeAccent('blue')).toBe('blue')
    expect(normalizeThemeAccent('rose')).toBe('rose')
  })

  it('falls back to the default for unknown or missing values', () => {
    expect(normalizeThemeAccent('teal')).toBe(DEFAULT_THEME_ACCENT)
    expect(normalizeThemeAccent(null)).toBe(DEFAULT_THEME_ACCENT)
  })
})

describe('resolveThemeMode', () => {
  it('returns the explicit mode regardless of system preference', () => {
    expect(resolveThemeMode('light', true)).toBe('light')
    expect(resolveThemeMode('dark', false)).toBe('dark')
  })

  it('follows the system preference in system mode', () => {
    expect(resolveThemeMode('system', true)).toBe('dark')
    expect(resolveThemeMode('system', false)).toBe('light')
  })
})
