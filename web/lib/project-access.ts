import { and, eq } from 'drizzle-orm'
import { db } from '@/db'
import { projects } from '@/db/schema'

// Project ownership scoping. Legacy rows are claimed transactionally when the
// bootstrap owner registers. Request-time access checks stay read-only so a GET
// can never mutate ownership while the Epic 172 management gate is closed.

export function accessibleProjectCondition(projectId: string, userId: string) {
  return and(
    eq(projects.id, projectId),
    eq(projects.submittedBy, userId),
  )
}

export function accessibleProjectOwnerCondition(userId: string) {
  return eq(projects.submittedBy, userId)
}

export async function getAccessibleProject(projectId: string, userId: string) {
  const [project] = await db
    .select()
    .from(projects)
    .where(accessibleProjectCondition(projectId, userId))
    .limit(1)

  return project ?? null
}
