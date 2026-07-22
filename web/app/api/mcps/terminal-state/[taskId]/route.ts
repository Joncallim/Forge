import 'server-only'
import { NextResponse, type NextRequest } from 'next/server'
import { terminalProjection } from '@/lib/mcps/s5-server-reader'
import { readAuthorizedS5State, S5RouteAuthorizationError } from '@/lib/mcps/s5-route'

export async function GET(request: NextRequest, { params }: { params: Promise<{ taskId: string }> }) {
  try {
    const { taskId } = await params
    return NextResponse.json(terminalProjection((await readAuthorizedS5State(request, taskId)).state))
  } catch (error) {
    if (error instanceof S5RouteAuthorizationError) return NextResponse.json({ error: error.message }, { status: error.status })
    console.error('[mcps/terminal-state GET] Unexpected error', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
