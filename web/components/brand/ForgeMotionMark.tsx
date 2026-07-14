'use client'

import { useId, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { cn } from '@/lib/utils'
import {
  FORGE_CORE_INSET_PATH,
  FORGE_CORE_PATH,
  FORGE_MODULE_PATH,
  FORGE_MODULE_ROTATIONS,
  FORGE_NEGATIVE_SPACE_PATH,
  FORGE_TRACE_PATH,
  FORGE_VIEW_BOX,
  shouldSimplifyForgeDetails,
  type ForgeAppearance,
  type ForgeDetail,
} from '@/lib/brand/forge-identity'
import { ForgeMark } from './ForgeMark'

export const FORGE_MOTION_DURATION_MS = 1825

export interface ForgeMotionTimerHost {
  setTimeout(callback: () => void, delay: number): number
  clearTimeout(handle: number): void
  setInterval(callback: () => void, delay: number): number
  clearInterval(handle: number): void
}

interface ScheduleForgeMotionCompletionOptions {
  loop: boolean
  timerHost: ForgeMotionTimerHost
  onComplete: () => void
  onCycle?: () => void
  onFinished?: () => void
}

interface ForgeMotionStorageHost {
  readonly sessionStorage: {
    getItem(key: string): string | null
    setItem(key: string, value: string): void
  }
}

export function hasPlayedForgeMotionInSession(
  storageHost: ForgeMotionStorageHost,
  playOnceKey: string,
): boolean {
  try {
    return storageHost.sessionStorage.getItem(playOnceKey) === '1'
  } catch {
    return false
  }
}

export function rememberForgeMotionInSession(
  storageHost: ForgeMotionStorageHost,
  playOnceKey: string,
): boolean {
  try {
    storageHost.sessionStorage.setItem(playOnceKey, '1')
    return true
  } catch {
    return false
  }
}

export function scheduleForgeMotionCompletion({
  loop,
  timerHost,
  onComplete,
  onCycle,
  onFinished,
}: ScheduleForgeMotionCompletionOptions): () => void {
  if (loop) {
    const interval = timerHost.setInterval(() => {
      onCycle?.()
      onComplete()
    }, FORGE_MOTION_DURATION_MS)
    return () => timerHost.clearInterval(interval)
  }

  const completion = timerHost.setTimeout(() => {
    onFinished?.()
    onComplete()
  }, FORGE_MOTION_DURATION_MS)
  return () => timerHost.clearTimeout(completion)
}

export interface ForgeMotionMarkProps {
  size?: number | string
  className?: string
  autoplay?: boolean
  loop?: boolean
  showWordmark?: boolean
  onComplete?: () => void
  reducedMotionFallback?: 'static' | 'fade'
  appearance?: ForgeAppearance
  detail?: ForgeDetail
  decorative?: boolean
  /** Session-scoped key used by first-run surfaces to avoid remount replays. */
  playOnceKey?: string
}

export function ForgeMotionMark({
  size = 96,
  className,
  autoplay = true,
  loop = false,
  showWordmark = false,
  onComplete,
  reducedMotionFallback = 'static',
  appearance = 'default',
  detail = 'auto',
  decorative = true,
  playOnceKey,
}: ForgeMotionMarkProps) {
  const instanceId = `forge-motion-${useId().replaceAll(':', '')}`
  const moduleId = `${instanceId}-module`
  const traceId = `${instanceId}-trace`
  const maskId = `${instanceId}-negative-space`
  const [playing, setPlaying] = useState(autoplay)
  const [complete, setComplete] = useState(!autoplay)
  const [cycle, setCycle] = useState(0)
  const onCompleteRef = useRef(onComplete)
  const simplified = shouldSimplifyForgeDetails(size, detail)

  useLayoutEffect(() => {
    onCompleteRef.current = onComplete
  }, [onComplete])

  useLayoutEffect(() => {
    if (!autoplay) {
      setPlaying(false)
      setComplete(true)
      return
    }

    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    const hasPlayed = playOnceKey
      ? hasPlayedForgeMotionInSession(window, playOnceKey)
      : false
    if (media.matches || hasPlayed) {
      setPlaying(false)
      setComplete(true)
      const completion = window.setTimeout(() => onCompleteRef.current?.(), 0)
      return () => window.clearTimeout(completion)
    }

    if (playOnceKey) rememberForgeMotionInSession(window, playOnceKey)
    setPlaying(true)
    setComplete(false)
    setCycle(0)

    return scheduleForgeMotionCompletion({
      loop,
      timerHost: {
        setTimeout: (callback, delay) => window.setTimeout(callback, delay),
        clearTimeout: (handle) => window.clearTimeout(handle),
        setInterval: (callback, delay) => window.setInterval(callback, delay),
        clearInterval: (handle) => window.clearInterval(handle),
      },
      onComplete: () => onCompleteRef.current?.(),
      onCycle: () => setCycle((currentCycle) => currentCycle + 1),
      onFinished: () => {
        setPlaying(false)
        setComplete(true)
      },
    })
  }, [autoplay, loop, playOnceKey])

  const staticMarkIsDecorative = decorative || showWordmark

  return (
    <span
      className={cn('forge-motion-mark', showWordmark && 'forge-motion-mark--wordmark', className)}
      data-playing={playing ? 'true' : 'false'}
      data-complete={complete ? 'true' : 'false'}
      data-loop={loop ? 'true' : 'false'}
      data-reduced-motion-fallback={reducedMotionFallback}
      aria-hidden={decorative ? 'true' : undefined}
    >
      <span className="forge-motion-mark__symbol" style={{ width: size, height: size }}>
        <ForgeMark
          size={size}
          appearance={appearance}
          detail={detail}
          decorative={staticMarkIsDecorative}
          className="forge-motion-mark__static"
        />

        {playing && (
          <svg
            key={cycle}
            xmlns="http://www.w3.org/2000/svg"
            viewBox={FORGE_VIEW_BOX}
            width={size}
            height={size}
            className="forge-motion-mark__assembly forge-mark"
            data-appearance={appearance}
            data-simplified={simplified ? 'true' : undefined}
            aria-hidden="true"
            focusable="false"
          >
            <defs>
              <path id={moduleId} d={FORGE_MODULE_PATH} />
              <path id={traceId} d={FORGE_TRACE_PATH} />
              <mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width="120" height="120">
                <rect width="120" height="120" fill="white" />
                {!simplified && <path d={FORGE_NEGATIVE_SPACE_PATH} fill="black" />}
              </mask>
            </defs>

            <g className="forge-mark__body" mask={`url(#${maskId})`}>
              <g className="forge-motion-mark__traces forge-mark__traces">
                {FORGE_MODULE_ROTATIONS.map((angle) => (
                  <use key={angle} href={`#${traceId}`} transform={`rotate(${angle} 60 60)`} />
                ))}
              </g>

              <g className="forge-motion-mark__modules forge-mark__modules">
                {FORGE_MODULE_ROTATIONS.map((angle, index) => (
                  <g key={angle} transform={`rotate(${angle} 60 60)`}>
                    <use
                      href={`#${moduleId}`}
                      className="forge-motion-mark__module"
                      data-forge-module=""
                      style={{ '--forge-module-index': index } as CSSProperties}
                    />
                  </g>
                ))}
              </g>

              <path
                className="forge-motion-mark__core forge-mark__core"
                d={FORGE_CORE_PATH}
              />
              {!simplified && (
                <path
                  className="forge-motion-mark__core-inset forge-mark__core-inset"
                  d={FORGE_CORE_INSET_PATH}
                />
              )}
            </g>
          </svg>
        )}
      </span>

      {showWordmark && <span key={`wordmark-${cycle}`} className="forge-motion-mark__name">FORGE</span>}
    </span>
  )
}
