import { cn } from '@/lib/utils'
import { ForgeMark, type ForgeAppearance } from './ForgeMark'

export type ForgeWordmarkSize = 'xs' | 'sm' | 'md' | 'lg'
export type ForgeWordmarkLayout = 'horizontal' | 'compact' | 'symbol'

export interface ForgeWordmarkProps {
  size?: ForgeWordmarkSize
  className?: string
  showTagline?: boolean
  appearance?: ForgeAppearance
  layout?: ForgeWordmarkLayout
}

const MARK_SIZES: Record<ForgeWordmarkSize, number> = {
  xs: 18,
  sm: 22,
  md: 32,
  lg: 48,
}

export function ForgeWordmark({
  size = 'md',
  className,
  showTagline = false,
  appearance = 'default',
  layout = 'horizontal',
}: ForgeWordmarkProps) {
  if (layout === 'symbol') {
    return (
      <ForgeMark
        size={MARK_SIZES[size]}
        className={className}
        appearance={appearance}
        decorative={false}
        title="FORGE"
      />
    )
  }

  return (
    <span
      className={cn(
        'forge-wordmark',
        layout === 'compact' && 'forge-wordmark--compact',
        className,
      )}
      data-size={size}
      data-appearance={appearance}
    >
      <ForgeMark size={MARK_SIZES[size]} appearance={appearance} />
      <span className="forge-wordmark__copy">
        <span className="forge-wordmark__name">FORGE</span>
        {showTagline && (
          <span className="forge-wordmark__tagline">
            THE OPERATING SYSTEM FOR SOFTWARE ENGINEERING
          </span>
        )}
      </span>
    </span>
  )
}
