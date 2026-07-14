import { useId, type CSSProperties } from 'react'
import { cn } from '@/lib/utils'
import {
  FORGE_CORE_INSET_PATH,
  FORGE_CORE_PATH,
  FORGE_MODULE_PATH,
  FORGE_MODULE_ROTATIONS,
  FORGE_NEGATIVE_SPACE_PATH,
  FORGE_STATUS_CUE_PATHS,
  FORGE_STATUS_LABELS,
  FORGE_TRACE_PATH,
  FORGE_VIEW_BOX,
  normalizeForgeStatus,
  shouldSimplifyForgeDetails,
  type ForgeAppearance,
  type ForgeDetail,
  type ForgeStatus,
} from '@/lib/brand/forge-identity'

export type { ForgeAppearance, ForgeDetail, ForgeStatus } from '@/lib/brand/forge-identity'

export interface ForgeMarkProps {
  size?: number | string
  className?: string
  title?: string
  decorative?: boolean
  appearance?: ForgeAppearance
  status?: ForgeStatus
  detail?: ForgeDetail
}

export function ForgeMark({
  size = 32,
  className,
  title,
  decorative = true,
  appearance = 'default',
  status: requestedStatus = 'idle',
  detail = 'auto',
}: ForgeMarkProps) {
  const instanceId = `forge-${useId().replaceAll(':', '')}`
  const status = normalizeForgeStatus(requestedStatus)
  const titleId = `${instanceId}-title`
  const moduleId = `${instanceId}-module`
  const traceId = `${instanceId}-trace`
  const maskId = `${instanceId}-negative-space`
  const simplified = shouldSimplifyForgeDetails(size, detail)
  const accessibleTitle = title ?? (
    status === 'idle' ? 'FORGE' : `FORGE: ${FORGE_STATUS_LABELS[status]}`
  )
  const style = { width: size, height: size } as CSSProperties
  const statusCue = FORGE_STATUS_CUE_PATHS[status]

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={FORGE_VIEW_BOX}
      width={size}
      height={size}
      style={style}
      className={cn('forge-mark shrink-0', className)}
      data-forge-mark=""
      data-appearance={appearance}
      data-status={status}
      data-simplified={simplified ? 'true' : undefined}
      aria-hidden={decorative ? 'true' : undefined}
      role={decorative ? undefined : 'img'}
      aria-labelledby={decorative ? undefined : titleId}
      focusable="false"
    >
      {!decorative && <title id={titleId}>{accessibleTitle}</title>}
      <defs>
        <path id={moduleId} d={FORGE_MODULE_PATH} />
        <path id={traceId} d={FORGE_TRACE_PATH} />
        <mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width="120" height="120">
          <rect width="120" height="120" fill="white" />
          {!simplified && <path d={FORGE_NEGATIVE_SPACE_PATH} fill="black" />}
        </mask>
      </defs>

      <g className="forge-mark__body" mask={`url(#${maskId})`} aria-hidden="true">
        <g className="forge-mark__traces">
          {FORGE_MODULE_ROTATIONS.map((angle) => (
            <use key={angle} href={`#${traceId}`} transform={`rotate(${angle} 60 60)`} />
          ))}
        </g>

        <g className="forge-mark__modules">
          {FORGE_MODULE_ROTATIONS.map((angle) => (
            <use
              key={angle}
              href={`#${moduleId}`}
              transform={`rotate(${angle} 60 60)`}
              data-forge-module=""
            />
          ))}
        </g>

        <path className="forge-mark__core" d={FORGE_CORE_PATH} />
        {!simplified && <path className="forge-mark__core-inset" d={FORGE_CORE_INSET_PATH} />}
      </g>
      {statusCue && !simplified && (
        <path className="forge-mark__status-cue" d={statusCue} aria-hidden="true" />
      )}
    </svg>
  )
}
