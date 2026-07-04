import { and, asc, eq, isNull } from 'drizzle-orm'
import { db } from '@/db'
import { projects, users } from '@/db/schema'

// Project ownership scoping. Legacy rows are backfilled during the migration to
// the oldest existing user so upgraded installs keep a deterministic owner
// without leaving `submitted_by IS NULL` rows globally accessible.

export function accessibleProjectCondition(projectId: string, userId: string) {
  return and(
    eq(projects.id, projectId),
    eq(projects.submittedBy, userId),
  )
}

export function accessibleProjectOwnerCondition(userId: string) {
  return eq(projects.submittedBy, userId)
}

async function getBootstrapOwnerId() {
  const [bootstrapOwner] = await db
    .select({ id: users.id })
    .from(users)
    .orderBy(asc(users.createdAt), asc(users.id))
    .limit(1)

  return bootstrapOwner?.id ?? null
}

export async function claimAccessibleLegacyProjects(userId: string) {
  if ((await getBootstrapOwnerId()) !== userId) return

  await db
    .update(projects)
    .set({ submittedBy: userId })
    .where(isNull(projects.submittedBy))
}

export async function getAccessibleProject(projectId: string, userId: string) {
  const [project] = await db
    .select()
    .from(projects)
    .where(accessibleProjectCondition(projectId, userId))
    .limit(1)

  if (project) return project
  if ((await getBootstrapOwnerId()) !== userId) return null

  const [claimedProject] = await db
    .update(projects)
    .set({ submittedBy: userId })
    .where(and(eq(projects.id, projectId), isNull(projects.submittedBy)))
    .returning()

  return claimedProject ?? null
}
