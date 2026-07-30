import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import {
  CanonicalMcpOperatorPanel,
  canonicalMcpOperatorActionRequest,
} from '@/app/dashboard/tasks/[id]/page'
import { BrandedTerminalJoinView } from '@/components/mcps/BrandedTerminalJoinView'
import {
  CANONICAL_MCP_PRESENTATION_MAX_AGE_MS,
  canonicalMcpPresentationAgeMs,
  canonicalMcpPresentationIsFresh,
  canonicalMcpTaskPresentationFromUnknown,
  type CanonicalMcpOperatorAction,
  type CanonicalMcpTaskPresentation,
} from '@/lib/mcps/admission-copy'

const taskId = '00000000-0000-4000-8000-000000000001'
const packageId = '00000000-0000-4000-8000-000000000002'
const auditId = '00000000-0000-4000-8000-000000000003'
const evidenceId = '00000000-0000-4000-8000-000000000004'
const freshness = `sha256:${'a'.repeat(64)}`
const marker = `sha256:${'b'.repeat(64)}`
const evidence = `sha256:${'c'.repeat(64)}`

function packet(overrides: Partial<CanonicalMcpTaskPresentation> = {}): CanonicalMcpTaskPresentation {
  return {
    schemaVersion: 1,
    computedAt: new Date().toISOString(),
    freshnessFingerprint: freshness,
    taskId,
    localEvidenceAvailable: true,
    admission: [{ workPackageId: packageId, title: 'Packet package', requiresMcp: true, decision: 'approved' }],
    recoveries: [{
      workPackageId: packageId,
      title: 'Packet package',
      badgeText: 'Recovery available',
      headline: 'Operator recovery is available',
      body: 'Choose a server-authorized action.',
      tone: 'warning',
      actions: [{
        action: 'retry_execution',
        label: 'Retry packet execution',
        identity: { schemaVersion: 2, priorRuntimeAuditId: auditId, markerFingerprint: marker },
      }],
    }],
    terminals: [],
    ...overrides,
  }
}

describe('canonical task MCP presentation', () => {
  it('renders an allowed packet recovery action and forwards its exact endpoint identity', () => {
    const presentation = packet()
    const markup = renderToStaticMarkup(
      <CanonicalMcpOperatorPanel presentation={presentation} pending={false} onAction={() => undefined} />,
    )

    expect(markup).toContain('Retry packet execution')
    expect(markup).toContain('Current admission approved')
    expect(canonicalMcpOperatorActionRequest(presentation.recoveries[0].actions[0], freshness)).toEqual({
      schemaVersion: 1,
      action: 'retry_execution',
      expectedFreshnessFingerprint: freshness,
      priorRuntimeAuditId: auditId,
      markerFingerprint: marker,
    })
  })

  it('renders a local marker with its exact local-evidence identity', () => {
    const presentation = packet({
      recoveries: [{
        workPackageId: packageId,
        title: 'Local package',
        badgeText: 'Recovery available',
        headline: 'Operator recovery is available',
        body: 'Choose a server-authorized action.',
        tone: 'warning',
        actions: [{
          action: 'retry_local_execution',
          label: 'Start another local attempt',
          identity: { schemaVersion: 1, localRunEvidenceId: evidenceId, evidenceFingerprint: evidence },
        }],
      }],
    })

    expect(canonicalMcpOperatorActionRequest(presentation.recoveries[0].actions[0], freshness)).toEqual({
      schemaVersion: 1,
      action: 'retry_local_execution',
      expectedFreshnessFingerprint: freshness,
      localRunEvidenceId: evidenceId,
      evidenceFingerprint: evidence,
    })
  })

  it('rejects mixed action families in both directions and never creates a request', () => {
    const invalidActions = [
      {
        action: 'retry_execution',
        label: 'Invalid mixed action',
        identity: { schemaVersion: 1, localRunEvidenceId: evidenceId, evidenceFingerprint: evidence },
      },
      {
        action: 'retry_local_execution',
        label: 'Invalid mixed action',
        identity: { schemaVersion: 2, priorRuntimeAuditId: auditId, markerFingerprint: marker },
      },
    ] satisfies readonly CanonicalMcpOperatorAction[]
    for (const action of invalidActions) {
      expect(canonicalMcpTaskPresentationFromUnknown(packet({
        recoveries: [{ ...packet().recoveries[0], actions: [action] }],
      }))).toBeNull()
      expect(canonicalMcpOperatorActionRequest(action, freshness)).toBeNull()
      const forgedMarkup = renderToStaticMarkup(
        <CanonicalMcpOperatorPanel
          presentation={packet({ recoveries: [{ ...packet().recoveries[0], actions: [action] }] })}
          pending={false}
          onAction={() => undefined}
        />,
      )
      expect(forgedMarkup).not.toContain('<button')
    }
  })

  it('expires an observation on the bounded client clock and hides its controls on the next render', () => {
    vi.useFakeTimers()
    const observedAt = new Date('2026-07-31T00:00:00.000Z')
    vi.setSystemTime(observedAt)
    const presentation = packet({ computedAt: observedAt.toISOString() })
    expect(canonicalMcpPresentationIsFresh(presentation)).toBe(true)
    expect(renderToStaticMarkup(<CanonicalMcpOperatorPanel presentation={presentation} pending={false} onAction={() => undefined} />)).toContain('<button')

    vi.advanceTimersByTime(CANONICAL_MCP_PRESENTATION_MAX_AGE_MS + 1)
    expect(canonicalMcpPresentationIsFresh(presentation)).toBe(false)
    const staleMarkup = renderToStaticMarkup(<CanonicalMcpOperatorPanel presentation={presentation} pending={false} onAction={() => undefined} />)
    expect(staleMarkup).not.toContain('<button')
    expect(staleMarkup).toContain('Recovery actions are hidden')
    vi.useRealTimers()
  })

  it('fails closed for future observations and client clock rollback', () => {
    const observedAt = new Date('2026-07-31T00:00:30.000Z')
    const presentation = packet({ computedAt: observedAt.toISOString() })

    expect(canonicalMcpPresentationAgeMs(presentation, observedAt.getTime() - 1)).toBeNull()
    expect(canonicalMcpPresentationIsFresh(presentation, observedAt.getTime() - 1)).toBe(false)
    expect(canonicalMcpPresentationIsFresh(
      packet({ computedAt: new Date(observedAt.getTime() + CANONICAL_MCP_PRESENTATION_MAX_AGE_MS + 1).toISOString() }),
      observedAt.getTime(),
    )).toBe(false)
  })

  it('keeps current and terminal-only observations non-live while terminal outcomes stay live', () => {
    const observedAt = new Date()
    const currentMarkup = renderToStaticMarkup(
      <CanonicalMcpOperatorPanel presentation={packet({ computedAt: observedAt.toISOString() })} pending={false} onAction={() => undefined} />,
    )
    expect(currentMarkup).toContain('aria-hidden="true"')
    expect(currentMarkup).not.toContain('role="status"')

    const staleMarkup = renderToStaticMarkup(
      <CanonicalMcpOperatorPanel presentation={packet({ computedAt: new Date(0).toISOString() })} pending={false} onAction={() => undefined} />,
    )
    expect(staleMarkup).toContain('role="status"')
    expect(staleMarkup).toContain('Recovery actions are hidden')

    const terminalMarkup = renderToStaticMarkup(
      <BrandedTerminalJoinView presentation={{ state: 'terminal', terminalAt: 'now', outcome: 'failed' }} />,
    )
    const terminalOnlyMarkup = renderToStaticMarkup(
      <BrandedTerminalJoinView presentation={{ state: 'terminal_only', message: 'stale' }} />,
    )
    expect(terminalMarkup).toContain('role="status"')
    expect(terminalMarkup).toContain('aria-live="polite"')
    expect(terminalOnlyMarkup).not.toContain('role="status"')
  })

  it('hides controls for unavailable, terminal, and stale/unknown server presentations while branding terminal evidence', () => {
    const presentation = packet({
      localEvidenceAvailable: false,
      recoveries: [{
        ...packet().recoveries[0],
        badgeText: 'Terminal',
        actions: [],
      }],
      terminals: [{
        workPackageId: packageId,
        title: 'Packet package',
        state: 'terminal',
        outcome: 'failed',
        terminalAt: '2026-07-30T00:00:00.000Z',
      }],
    })
    const markup = renderToStaticMarkup(
      <CanonicalMcpOperatorPanel presentation={presentation} pending={false} onAction={() => undefined} />,
    )

    expect(markup).not.toContain('<button')
    expect(markup).toContain('Terminal')
    expect(markup).toContain('Packet package: failed')
    expect(markup).toContain('Protected local evidence is unavailable')
  })
})
