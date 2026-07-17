import 'server-only'
import type { ReactNode } from 'react'

export type TerminalJoinPresentation =
  | { state: 'terminal'; terminalAt: string; outcome: string }
  | { state: 'current'; freshnessSeconds: number; fingerprint: string }
  | { state: 'terminal_only'; message: string }

export type BrandedTerminalJoinProps = {
  presentation: TerminalJoinPresentation
  className?: string
  children?: ReactNode
}

export function BrandedTerminalJoin({ presentation, className, children }: BrandedTerminalJoinProps) {
  const base = 'flex items-center gap-2 text-xs font-mono px-3 py-1.5 rounded-md border'
  const colorClass = (() => {
    switch (presentation.state) {
    case 'terminal':
      return 'border-neutral-200 bg-neutral-50 text-neutral-600 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-400'
    case 'current':
      return 'border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-800 dark:bg-blue-950 dark:text-blue-300'
    case 'terminal_only':
      return 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300'
    }
  })()

  const badge = (() => {
    switch (presentation.state) {
    case 'terminal':
      return (
        <span className="inline-flex items-center gap-1">
          <span className="w-2 h-2 rounded-full bg-neutral-400 dark:bg-neutral-500" />
          <span className="font-semibold uppercase tracking-wide">Terminal</span>
          <span className="text-neutral-400 dark:text-neutral-500">{presentation.terminalAt}</span>
        </span>
      )
    case 'current':
      return (
        <span className="inline-flex items-center gap-1">
          <span className="w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
          <span className="font-semibold uppercase tracking-wide">Current</span>
          <span className="text-blue-400 dark:text-blue-500">
            {presentation.freshnessSeconds}s
          </span>
        </span>
      )
    case 'terminal_only':
      return (
        <span className="inline-flex items-center gap-1">
          <span className="w-2 h-2 rounded-full bg-amber-400" />
          <span className="font-semibold uppercase tracking-wide">
            Terminal Only
          </span>
        </span>
      )
    }
  })()

  return (
    <div className={`${base} ${colorClass} ${className ?? ''}`} role="status" aria-live="polite">
      {badge}
      {children && <span className="text-current/70">{children}</span>}
    </div>
  )
}

export type FreshnessJoinProps = {
  freshnessSeconds: number
  fingerprint: string
  children?: ReactNode
}

export function FreshnessJoin({ freshnessSeconds, fingerprint, children }: FreshnessJoinProps) {
  const presentation: TerminalJoinPresentation = freshnessSeconds < 0
    ? { state: 'terminal_only', message: `Stale data. Current fingerprint: ${fingerprint}` }
    : { state: 'current', freshnessSeconds: Math.max(0, freshnessSeconds), fingerprint }
  return (
    <BrandedTerminalJoin presentation={presentation}>
      {children}
    </BrandedTerminalJoin>
  )
}
