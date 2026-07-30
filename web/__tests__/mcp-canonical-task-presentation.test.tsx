import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import {
  CanonicalMcpOperatorPanel,
  canonicalMcpOperatorActionRequest,
} from '@/app/dashboard/tasks/[id]/page'
import {
  CANONICAL_MCP_PRESENTATION_MAX_AGE_MS,
  canonicalMcpPresentationIsFresh,
  canonicalMcpTaskPresentationFromUnknown,
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
    const packetActionWithLocalIdentity = {
      action: 'retry_execution',
      label: 'Invalid mixed action',
      identity: { schemaVersion: 1, localRunEvidenceId: evidenceId, evidenceFingerprint: evidence },
    }
    const localActionWithPacketIdentity = {
      action: 'retry_local_execution',
      label: 'Invalid mixed action',
      identity: { schemaVersion: 2, priorRuntimeAuditId: auditId, markerFingerprint: marker },
    }
    for (const action of [packetActionWithLocalIdentity, localActionWithPacketIdentity]) {
      expect(canonicalMcpTaskPresentationFromUnknown(packet({
        recoveries: [{ ...packet().recoveries[0], actions: [action] }],
      }))).toBeNull()
      expect(canonicalMcpOperatorActionRequest(action as never, freshness)).toBeNull()
      const forgedMarkup = renderToStaticMarkup(
        <CanonicalMcpOperatorPanel
          presentation={packet({ recoveries: [{ ...packet().recoveries[0], actions: [action as never] }] })}
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
