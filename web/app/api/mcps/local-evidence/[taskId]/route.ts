import 'server-only'
import { NextResponse, type NextRequest } from 'next/server'
import { safeLocalEvidencePresenter } from '@/lib/mcps/s5-server-reader'
import { readAuthorizedS5State, S5RouteAuthorizationError } from '@/lib/mcps/s5-route'

export async function GET(request: NextRequest, { params }: { params: Promise<{ taskId: string }> }) {
  try {
    const { taskId } = await params
    const { state } = await readAuthorizedS5State(request, taskId)
    return NextResponse.json({
      computedAt: state.computedAt,
      freshnessFingerprint: state.freshnessFingerprint,
      taskId,
      localEvidenceAvailable: state.localEvidenceAvailable,
      evidenceRecords: state.evidenceRecords.map(safeLocalEvidencePresenter),
    })
  } catch (error) {
    if (error instanceof S5RouteAuthorizationError) return NextResponse.json({ error: error.message }, { status: error.status })
    console.error('[mcps/local-evidence GET] Unexpected fixed-category failure')
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
