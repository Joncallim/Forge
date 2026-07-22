import 'server-only'
import { NextResponse, type NextRequest } from 'next/server'
import { readAuthorizedS5State, S5RouteAuthorizationError } from '@/lib/mcps/s5-route'

export async function GET(request: NextRequest, { params }: { params: Promise<{ taskId: string }> }) {
  try {
    const { taskId } = await params
    const { state } = await readAuthorizedS5State(request, taskId)
    return NextResponse.json({
      computedAt: state.computedAt,
      fingerprint: state.freshnessFingerprint,
      casRecheckToken: state.freshnessFingerprint,
      freshnessAgeMs: 0,
      taskId,
    })
  } catch (error) {
    if (error instanceof S5RouteAuthorizationError) return NextResponse.json({ error: error.message }, { status: error.status })
    console.error('[mcps/freshness GET] Unexpected error', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
