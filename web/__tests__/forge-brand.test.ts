import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  FORGE_MOTION_DURATION_MS,
  ForgeMark,
  ForgeMotionMark,
  ForgeStatusMark,
  ForgeWordmark,
  scheduleForgeMotionCompletion,
  type ForgeMotionTimerHost,
} from '@/components/brand'
import {
  hasPlayedForgeMotionInSession,
  rememberForgeMotionInSession,
} from '@/components/brand/ForgeMotionMark'
import {
  FORGE_NEGATIVE_SPACE_PATH,
  FORGE_STATUSES,
  isForgeStatus,
} from '@/lib/brand/forge-identity'

describe('FORGE brand components', () => {
  it('renders the static mark from exactly six canonical module uses', () => {
    const html = renderToStaticMarkup(createElement(ForgeMark, { size: 48 }))

    expect(html).toContain('data-forge-mark=""')
    expect(html.match(/data-forge-module=""/g)).toHaveLength(6)
    expect(html).toContain('viewBox="0 0 120 120"')
  })

  it('simplifies numeric and pixel-string sizes at 20px and below', () => {
    const numeric = renderToStaticMarkup(createElement(ForgeMark, { size: 16 }))
    const pixelString = renderToStaticMarkup(createElement(ForgeMark, { size: '16px' }))

    for (const html of [numeric, pixelString]) {
      expect(html).toContain('data-simplified="true"')
      expect(html).not.toContain(FORGE_NEGATIVE_SPACE_PATH)
      expect(html).not.toContain('forge-mark__core-inset')
    }
  })

  it('allows explicit detail control independent of size', () => {
    const full = renderToStaticMarkup(createElement(ForgeMark, {
      size: '16px',
      detail: 'full',
    }))
    const simplified = renderToStaticMarkup(createElement(ForgeMark, {
      size: 96,
      detail: 'simplified',
    }))

    expect(full).not.toContain('data-simplified="true"')
    expect(full).toContain(FORGE_NEGATIVE_SPACE_PATH)
    expect(simplified).toContain('data-simplified="true"')
    expect(simplified).not.toContain(FORGE_NEGATIVE_SPACE_PATH)
  })

  it('keeps decorative marks hidden from assistive technology', () => {
    const html = renderToStaticMarkup(createElement(ForgeMark, { decorative: true }))

    expect(html).toContain('aria-hidden="true"')
    expect(html).not.toContain('role="img"')
    expect(html).not.toContain('<title')
  })

  it('gives standalone marks a safe, unique accessible title', () => {
    const html = renderToStaticMarkup(createElement('div', null,
      createElement(ForgeMark, { decorative: false, title: 'FORGE identity' }),
      createElement(ForgeMark, { decorative: false, title: 'FORGE identity' }),
    ))
    const labelledByIds = [...html.matchAll(/aria-labelledby="([^"]+)"/g)].map((match) => match[1])

    expect(html).toContain('role="img"')
    expect(html).toContain('FORGE identity</title>')
    expect(html).not.toMatch(/id="[^"]*:[^"]*"/)
    expect(new Set(labelledByIds).size).toBe(2)
  })

  it('renders selectable FORGE text in the wordmark', () => {
    const html = renderToStaticMarkup(createElement(ForgeWordmark, { size: 'lg' }))

    expect(html).toContain('forge-wordmark__name')
    expect(html).toContain('>FORGE</span>')
  })

  it.each(FORGE_STATUSES)('renders the %s status with a visible label', (status) => {
    const html = renderToStaticMarkup(createElement(ForgeStatusMark, { status }))

    expect(html).toContain(`data-status="${status}"`)
    expect(html).toContain('forge-status-mark__label')
  })

  it('rejects unknown status values and safely normalizes runtime misuse', () => {
    expect(isForgeStatus('waiting-for-magic')).toBe(false)
    const html = renderToStaticMarkup(createElement(ForgeMark, {
      status: 'waiting-for-magic' as never,
    }))
    expect(html).toContain('data-status="idle"')
  })

  it('normalizes runtime-invalid status marks before selecting data and labels', () => {
    const html = renderToStaticMarkup(createElement(ForgeStatusMark, {
      status: 'waiting-for-magic' as never,
    }))

    expect(html.match(/data-status="idle"/g)).toHaveLength(2)
    expect(html).toContain('forge-status-mark__label">Idle</span>')
    expect(html).not.toContain('waiting-for-magic')
    expect(html).not.toContain('undefined')
  })

  it('uses the exact static mark as the non-playing motion state', () => {
    const html = renderToStaticMarkup(createElement(ForgeMotionMark, {
      autoplay: false,
      reducedMotionFallback: 'static',
    }))

    expect(html).toContain('data-playing="false"')
    expect(html).toContain('data-reduced-motion-fallback="static"')
    expect(html.match(/data-forge-module=""/g)).toHaveLength(6)
  })

  it('does not loop by default', () => {
    const html = renderToStaticMarkup(createElement(ForgeMotionMark))
    expect(html).toContain('data-loop="false"')
  })

  it('server-renders autoplay motion in its assembly state', () => {
    const html = renderToStaticMarkup(createElement(ForgeMotionMark, {
      showWordmark: true,
    }))

    expect(html).toContain('data-playing="true"')
    expect(html).toContain('data-complete="false"')
    expect(html).toContain('forge-motion-mark__assembly')
    expect(html.match(/data-forge-module=""/g)).toHaveLength(12)
  })

  it('shows a completed wordmark without animation data when autoplay is off', () => {
    const html = renderToStaticMarkup(createElement(ForgeMotionMark, {
      autoplay: false,
      showWordmark: true,
    }))

    expect(html).toContain('data-playing="false"')
    expect(html).toContain('data-complete="true"')
    expect(html).toContain('forge-motion-mark__name">FORGE</span>')
    expect(html).not.toContain('forge-motion-mark__assembly')
  })

  it('keeps the effective assembly duration at 1825ms', () => {
    expect(FORGE_MOTION_DURATION_MS).toBe(1825)
  })

  it('reads and writes the exact session motion key and sentinel', () => {
    const values = new Map<string, string>()
    const reads: string[] = []
    const writes: Array<[string, string]> = []
    const healthyStorageHost = {
      sessionStorage: {
        getItem(key: string) {
          reads.push(key)
          return values.get(key) ?? null
        },
        setItem(key: string, value: string) {
          writes.push([key, value])
          values.set(key, value)
        },
      },
    }

    expect(hasPlayedForgeMotionInSession(healthyStorageHost, 'forge:setup')).toBe(false)
    expect(reads).toEqual(['forge:setup'])

    expect(rememberForgeMotionInSession(healthyStorageHost, 'forge:setup')).toBe(true)
    expect(writes).toEqual([['forge:setup', '1']])

    expect(hasPlayedForgeMotionInSession(healthyStorageHost, 'forge:setup')).toBe(true)
    expect(reads).toEqual(['forge:setup', 'forge:setup'])
  })

  it('treats unavailable session storage as not previously played', () => {
    const blockedAccessHost = {
      get sessionStorage(): Storage {
        throw new DOMException('Storage access is blocked', 'SecurityError')
      },
    }
    const blockedMethodsHost = {
      sessionStorage: {
        getItem() {
          throw new DOMException('Storage reads are blocked', 'SecurityError')
        },
        setItem() {
          throw new DOMException('Storage writes are blocked', 'SecurityError')
        },
      },
    }

    for (const storageHost of [blockedAccessHost, blockedMethodsHost]) {
      expect(hasPlayedForgeMotionInSession(storageHost, 'forge:setup')).toBe(false)
      expect(rememberForgeMotionInSession(storageHost, 'forge:setup')).toBe(false)
    }
  })

  it('finishes motion and invokes onComplete at 1825ms', () => {
    const timeouts: Array<{ callback: () => void; delay: number }> = []
    const clearedTimeouts: number[] = []
    const events: string[] = []
    const timerHost: ForgeMotionTimerHost = {
      setTimeout(callback, delay) {
        timeouts.push({ callback, delay })
        return 41
      },
      clearTimeout(handle) {
        clearedTimeouts.push(handle)
      },
      setInterval() {
        return 42
      },
      clearInterval() {},
    }

    const cleanup = scheduleForgeMotionCompletion({
      loop: false,
      timerHost,
      onFinished: () => events.push('finished'),
      onComplete: () => events.push('complete'),
    })

    expect(timeouts).toHaveLength(1)
    expect(timeouts[0].delay).toBe(1825)
    expect(events).toEqual([])

    timeouts[0].callback()
    expect(events).toEqual(['finished', 'complete'])

    cleanup()
    expect(clearedTimeouts).toEqual([41])
  })

  it('restarts and completes every loop cycle on the shared 1825ms clock', () => {
    const intervals: Array<{ callback: () => void; delay: number }> = []
    const clearedIntervals: number[] = []
    const events: string[] = []
    const timerHost: ForgeMotionTimerHost = {
      setTimeout() {
        return 41
      },
      clearTimeout() {},
      setInterval(callback, delay) {
        intervals.push({ callback, delay })
        return 42
      },
      clearInterval(handle) {
        clearedIntervals.push(handle)
      },
    }

    const cleanup = scheduleForgeMotionCompletion({
      loop: true,
      timerHost,
      onCycle: () => events.push('cycle'),
      onComplete: () => events.push('complete'),
    })

    expect(intervals).toHaveLength(1)
    expect(intervals[0].delay).toBe(1825)
    intervals[0].callback()
    intervals[0].callback()
    expect(events).toEqual(['cycle', 'complete', 'cycle', 'complete'])

    cleanup()
    expect(clearedIntervals).toEqual([42])
  })

  it('scopes motion, status, and reduced-motion CSS to their intended states', () => {
    const css = readFileSync(new URL('../app/globals.css', import.meta.url), 'utf8')

    expect(css).toContain(
      '.forge-motion-mark[data-playing="true"] .forge-motion-mark__name',
    )
    expect(css).toContain(
      '.forge-motion-mark[data-reduced-motion-fallback="fade"] .forge-motion-mark__static',
    )
    expect(css).toContain('animation: forge-reduced-fade 160ms ease-out both !important;')
    expect(css).toMatch(/@keyframes forge-reduced-fade\s*{\s*from { opacity: 0; }\s*to { opacity: 1; }\s*}/)
    expect(css).toMatch(/\.forge-mark\[data-status="idle"\] \.forge-mark__core\s*{\s*opacity: 0\.72;/)
    expect(css).toMatch(/\.forge-mark\[data-status="completed"\] \.forge-mark__core\s*{[\s\S]*?transform-box: fill-box;[\s\S]*?transform-origin: center;/)
    expect(css).toMatch(/\.forge-mark\[data-status="disconnected"\] \.forge-mark__modules\s*{\s*opacity: 0\.48;/)
    expect(css).toMatch(/@keyframes forge-module-assemble\s*{[\s\S]*?fill-opacity: 0;[\s\S]*?stroke-opacity: 0\.82;/)
    expect(css).toMatch(/@keyframes forge-core-ignite\s*{[\s\S]*?92%, 100% { opacity: 0\.72;/)
    expect(css).not.toContain('animation-iteration-count: infinite')
  })
})
