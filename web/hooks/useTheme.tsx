'use client'

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'

// ---------------------------------------------------------------------------
// Appearance theme state
//
// Theme is a per-browser preference, so it is persisted to localStorage rather
// than server-side workspace settings. The no-flash inline script in the root
// layout applies the same stored values before first paint; this provider keeps
// the React tree in sync and drives the Settings > Appearance controls.
// ---------------------------------------------------------------------------

export type ThemeMode = 'light' | 'dark' | 'system'
export type ThemeAccent = 'default' | 'blue' | 'violet' | 'green' | 'rose'

export const THEME_MODE_STORAGE_KEY = 'forge-theme-mode'
export const THEME_ACCENT_STORAGE_KEY = 'forge-theme-accent'

export const THEME_MODES: ReadonlyArray<{ value: ThemeMode; label: string }> = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'System' },
]

export const THEME_ACCENTS: ReadonlyArray<{ value: ThemeAccent; label: string }> = [
  { value: 'default', label: 'Neutral' },
  { value: 'blue', label: 'Blue' },
  { value: 'violet', label: 'Violet' },
  { value: 'green', label: 'Green' },
  { value: 'rose', label: 'Rose' },
]

const MODE_VALUES = new Set<ThemeMode>(THEME_MODES.map((entry) => entry.value))
const ACCENT_VALUES = new Set<ThemeAccent>(THEME_ACCENTS.map((entry) => entry.value))

export const DEFAULT_THEME_MODE: ThemeMode = 'system'
export const DEFAULT_THEME_ACCENT: ThemeAccent = 'default'

export function normalizeThemeMode(value: unknown): ThemeMode {
  return typeof value === 'string' && MODE_VALUES.has(value as ThemeMode)
    ? (value as ThemeMode)
    : DEFAULT_THEME_MODE
}

export function normalizeThemeAccent(value: unknown): ThemeAccent {
  return typeof value === 'string' && ACCENT_VALUES.has(value as ThemeAccent)
    ? (value as ThemeAccent)
    : DEFAULT_THEME_ACCENT
}

/** Resolves a theme mode to the concrete light/dark value applied to the DOM. */
export function resolveThemeMode(mode: ThemeMode, systemPrefersDark: boolean): 'light' | 'dark' {
  if (mode === 'system') return systemPrefersDark ? 'dark' : 'light'
  return mode
}

function prefersDark(): boolean {
  return typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches
}

function applyThemeToDocument(mode: ThemeMode, accent: ThemeAccent): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  root.classList.toggle('dark', resolveThemeMode(mode, prefersDark()) === 'dark')
  root.dataset.accent = accent
}

type ThemeContextValue = {
  mode: ThemeMode
  accent: ThemeAccent
  resolvedMode: 'light' | 'dark'
  setMode: (mode: ThemeMode) => void
  setAccent: (accent: ThemeAccent) => void
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(DEFAULT_THEME_MODE)
  const [accent, setAccentState] = useState<ThemeAccent>(DEFAULT_THEME_ACCENT)
  const [systemDark, setSystemDark] = useState(false)

  // Hydrate from localStorage on mount (client only). The inline script already
  // applied the visual theme; this syncs React state to the same values.
  useEffect(() => {
    const storedMode = normalizeThemeMode(localStorage.getItem(THEME_MODE_STORAGE_KEY))
    const storedAccent = normalizeThemeAccent(localStorage.getItem(THEME_ACCENT_STORAGE_KEY))
    setModeState(storedMode)
    setAccentState(storedAccent)
    setSystemDark(prefersDark())
    applyThemeToDocument(storedMode, storedAccent)
  }, [])

  // Track OS/browser preference so `system` mode reacts live.
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const query = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => setSystemDark(query.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])

  // Re-apply whenever mode/accent/system preference changes.
  useEffect(() => {
    applyThemeToDocument(mode, accent)
  }, [mode, accent, systemDark])

  const setMode = useCallback((next: ThemeMode) => {
    setModeState(next)
    try {
      localStorage.setItem(THEME_MODE_STORAGE_KEY, next)
    } catch {
      // Storage may be unavailable (private mode); the choice still applies for the session.
    }
  }, [])

  const setAccent = useCallback((next: ThemeAccent) => {
    setAccentState(next)
    try {
      localStorage.setItem(THEME_ACCENT_STORAGE_KEY, next)
    } catch {
      // Ignore storage failures; the choice still applies for the session.
    }
  }, [])

  const value = useMemo<ThemeContextValue>(() => ({
    mode,
    accent,
    resolvedMode: resolveThemeMode(mode, systemDark),
    setMode,
    setAccent,
  }), [mode, accent, systemDark, setMode, setAccent])

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext)
  if (!context) {
    throw new Error('useTheme must be used within a ThemeProvider')
  }
  return context
}
