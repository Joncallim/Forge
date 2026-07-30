import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  CanonicalMcpOperatorPanel,
  canonicalMcpOperatorActionRequest,
} from '@/app/dashboard/tasks/[id]/page'
import type { CanonicalMcpTaskPresentation } from '@/lib/mcps/admission-copy'

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
    computedAt: '2026-07-30T00:00:00.000Z',
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
