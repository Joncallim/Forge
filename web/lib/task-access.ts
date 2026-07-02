import { and, eq, isNull, or } from 'drizzle-orm'
import { db } from '@/db'
import { tasks } from '@/db/schema'

export function accessibleTaskCondition(taskId: string, userId: string) {
  return and(
    eq(tasks.id, taskId),
    or(eq(tasks.submittedBy, userId), isNull(tasks.submittedBy)),
  )
}

export function accessibleTaskOwnerCondition(userId: string) {
  return or(eq(tasks.submittedBy, userId), isNull(tasks.submittedBy))
}

export async function getAccessibleTask(taskId: string, userId: string) {
  const [task] = await db
    .select()
    .from(tasks)
    .where(accessibleTaskCondition(taskId, userId))
    .limit(1)

  return task ?? null
}
