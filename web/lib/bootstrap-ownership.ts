import { isNull } from 'drizzle-orm'
import { db } from '@/db'
import { projects, tasks } from '@/db/schema'

type OwnershipExecutor = {
  update: typeof db.update
}

type OwnershipUpdateChain = {
    set: (values: Record<string, unknown>) => {
      where: (...args: unknown[]) => Promise<unknown> | unknown
    }
}

export async function claimLegacyOwnership(executor: OwnershipExecutor, userId: string) {
  const projectUpdate = executor.update(projects) as unknown as OwnershipUpdateChain
  await projectUpdate
    .set({ submittedBy: userId })
    .where(isNull(projects.submittedBy))

  const taskUpdate = executor.update(tasks) as unknown as OwnershipUpdateChain
  await taskUpdate
    .set({ submittedBy: userId })
    .where(isNull(tasks.submittedBy))
}
