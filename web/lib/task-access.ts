import { and, eq, isNull } from 'drizzle-orm'
import { db } from '@/db'
import { projects, tasks } from '@/db/schema'

export function accessibleTaskCondition(taskId: string, userId: string) {
  return and(
    eq(tasks.id, taskId),
    eq(tasks.submittedBy, userId),
  )
}

export function accessibleTaskOwnerCondition(userId: string) {
  return eq(tasks.submittedBy, userId)
}

export async function getAccessibleTask(taskId: string, userId: string) {
  const [task] = await db
    .select()
    .from(tasks)
    .where(accessibleTaskCondition(taskId, userId))
    .limit(1)

  if (task) return task

  const [legacyTask] = await db
    .select({ id: tasks.id })
    .from(tasks)
    .innerJoin(projects, eq(tasks.projectId, projects.id))
    .where(and(
      eq(tasks.id, taskId),
      isNull(tasks.submittedBy),
      eq(projects.submittedBy, userId),
    ))
    .limit(1)

  if (!legacyTask) return null

  const [claimedTask] = await db
    .update(tasks)
    .set({ submittedBy: userId })
    .where(and(eq(tasks.id, taskId), isNull(tasks.submittedBy)))
    .returning()

  return claimedTask ?? null
}
