import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { getSession } from '@/lib/session'
import { db } from '@/db'
import { credentials } from '@/db/schema'
import { and, eq } from 'drizzle-orm'

// ---------------------------------------------------------------------------
// DELETE /api/auth/credentials/[id] — permanently remove a passkey
//
// This is a hard delete: the row is removed from the database, not flagged.
// A lingering row for a passkey the user already removed from their device
// or password manager is what makes the app keep treating a dead credential
// as usable, so there must be no "soft delete" state here.
// ---------------------------------------------------------------------------

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { id } = await params

    const [deleted] = await db
      .delete(credentials)
      .where(and(eq(credentials.id, id), eq(credentials.userId, session.userId)))
      .returning({ id: credentials.id })

    if (!deleted) {
      return NextResponse.json({ error: 'Credential not found' }, { status: 404 })
    }

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[DELETE /api/auth/credentials/[id]] Unexpected error', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
