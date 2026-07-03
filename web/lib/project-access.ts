import { and, eq, isNull, or } from 'drizzle-orm'
import { db } from '@/db'
import { projects } from '@/db/schema'

// Project ownership scoping (mirrors lib/task-access.ts). A project is
// accessible to the user who created it, or to anyone when submittedBy is null
// (pre-ownership rows), so existing single-operator installs are unaffected
// while new projects are scoped to their creator.

export function accessibleProjectCondition(projectId: string, userId: string) {
  return and(
    eq(projects.id, projectId),
    or(eq(projects.submittedBy, userId), isNull(projects.submittedBy)),
  )
}

export function accessibleProjectOwnerCondition(userId: string) {
  return or(eq(projects.submittedBy, userId), isNull(projects.submittedBy))
}

export async function getAccessibleProject(projectId: string, userId: string) {
  const [project] = await db
    .select()
    .from(projects)
    .where(accessibleProjectCondition(projectId, userId))
    .limit(1)

  return project ?? null
}
