import 'server-only'
import type { ReactNode } from 'react'
import { BrandedTerminalJoinView, type TerminalJoinPresentation } from './BrandedTerminalJoinView'

export type { TerminalJoinPresentation } from './BrandedTerminalJoinView'

export type BrandedTerminalJoinProps = {
  presentation: TerminalJoinPresentation
  className?: string
  children?: ReactNode
}

export function BrandedTerminalJoin({ presentation, className, children }: BrandedTerminalJoinProps) {
  return <BrandedTerminalJoinView presentation={presentation} className={className}>{children}</BrandedTerminalJoinView>
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
