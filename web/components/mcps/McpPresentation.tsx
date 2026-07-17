import type { ReactNode } from 'react'
import { Badge } from '@/components/ui/badge'
import type {
  AdmissionPresentation,
  PresentationCta,
} from '@/lib/mcps/admission-copy'
import { cn } from '@/lib/utils'

const TONE_CLASSES: Record<AdmissionPresentation['tone'], string> = {
  neutral: 'border-border bg-muted/20',
  positive: 'border-green-600/25 bg-green-500/5 dark:border-green-500/30',
  warning: 'border-amber-600/30 bg-amber-500/5 dark:border-amber-500/30',
  danger: 'border-destructive/30 bg-destructive/5',
}

const BADGE_CLASSES: Record<AdmissionPresentation['tone'], string> = {
  neutral: 'border-border text-muted-foreground',
  positive: 'border-green-600/30 text-green-800 dark:text-green-300',
  warning: 'border-amber-600/30 text-amber-800 dark:text-amber-300',
  danger: 'border-destructive/30 text-destructive',
}

export function McpPresentation({
  className,
  presentation,
  renderAction,
}: {
  className?: string
  presentation: AdmissionPresentation
  renderAction?: (action: PresentationCta, index: number) => ReactNode
}) {
  return (
    <div
      className={cn('min-w-0 rounded-lg border px-3 py-2.5', TONE_CLASSES[presentation.tone], className)}
      data-mcp-status={presentation.statusKey}
    >
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm font-medium text-foreground">{presentation.headline}</p>
        <Badge variant="outline" className={BADGE_CLASSES[presentation.tone]}>
          {presentation.badgeText}
        </Badge>
      </div>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
        {presentation.body}
      </p>
      {presentation.actions.length > 0 && renderAction && (
        <div
          role="group"
          aria-label={`${presentation.headline} actions`}
          className="mt-2 flex flex-col items-stretch gap-2 sm:flex-row sm:flex-wrap sm:items-center"
        >
          {presentation.actions.map((action, index) => (
            <div key={`${action.kind}-${index}`} className="contents">
              {renderAction(action, index)}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
