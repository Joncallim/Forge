import { cn } from '@/lib/utils'
import {
  FORGE_STATUS_LABELS,
  normalizeForgeStatus,
  type ForgeStatus,
} from '@/lib/brand/forge-identity'
import { ForgeMark, type ForgeAppearance } from './ForgeMark'

export interface ForgeStatusMarkProps {
  status: ForgeStatus
  size?: number | string
  className?: string
  markClassName?: string
  appearance?: ForgeAppearance
  label?: string
  showLabel?: boolean
  decorative?: boolean
}

export function ForgeStatusMark({
  status: requestedStatus,
  size = 24,
  className,
  markClassName,
  appearance = 'default',
  label,
  showLabel = true,
  decorative = false,
}: ForgeStatusMarkProps) {
  const status = normalizeForgeStatus(requestedStatus)
  const effectiveLabel = label ?? FORGE_STATUS_LABELS[status]
  const markIsDecorative = decorative || showLabel

  return (
    <span
      className={cn('forge-status-mark', className)}
      data-status={status}
      aria-hidden={decorative ? 'true' : undefined}
    >
      <ForgeMark
        size={size}
        className={markClassName}
        appearance={appearance}
        status={status}
        decorative={markIsDecorative}
        title={effectiveLabel}
      />
      {showLabel && <span className="forge-status-mark__label">{effectiveLabel}</span>}
    </span>
  )
}
