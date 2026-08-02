import 'server-only'
import { NextResponse, type NextRequest } from 'next/server'
import { readAuthorizedS5State, S5RouteAuthorizationError } from '@/lib/mcps/s5-route'

export async function GET(request: NextRequest, { params }: { params: Promise<{ taskId: string }> }) {
  try {
    const { taskId } = await params
    const { state } = await readAuthorizedS5State(request, taskId)
    // The age is the real elapsed time between observing the rows and
    // serialising them, measured on the server. It is deliberately not a
    // second `Date.now()` difference taken against itself, and there is no
    // browser-visible recheck token: currency is proven by echoing
    // `fingerprint` back and having the server re-read the same rows.
    return NextResponse.json({
      computedAt: state.computedAt,
      fingerprint: state.freshnessFingerprint,
      freshnessAgeMs: Math.max(0, Date.now() - state.observedAtMs),
      localEvidenceAvailable: state.localEvidenceAvailable,
      taskId,
    })
  } catch (error) {
    if (error instanceof S5RouteAuthorizationError) return NextResponse.json({ error: error.message }, { status: error.status })
    console.error('[mcps/freshness GET] Unexpected fixed-category failure')
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
