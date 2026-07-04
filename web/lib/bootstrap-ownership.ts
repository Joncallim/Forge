import { isNull } from 'drizzle-orm'
import { projects, tasks } from '@/db/schema'

type OwnershipExecutor = {
  update: (table: typeof projects | typeof tasks) => {
    set: (values: Record<string, unknown>) => {
      where: (condition: unknown) => Promise<unknown>
    }
  }
}

export async function claimLegacyOwnership(executor: OwnershipExecutor, userId: string) {
  await executor
    .update(projects)
    .set({ submittedBy: userId })
    .where(isNull(projects.submittedBy))

  await executor
    .update(tasks)
    .set({ submittedBy: userId })
    .where(isNull(tasks.submittedBy))
}
