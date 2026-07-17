import { and, eq } from 'drizzle-orm'
import { db } from '@/db'
import { projects, tasks, workPackages } from '@/db/schema'

type GrantMutationTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0]

export type LockedTaskFilesystemGrantRows = Readonly<{
  lockedPackageRows: Array<typeof workPackages.$inferSelect>
  lockedProject: typeof projects.$inferSelect
  lockedTask: typeof tasks.$inferSelect
  tx: GrantMutationTransaction
}>

/**
 * Run one task filesystem-grant mutation under Forge's shared lock order.
 *
 * This service deliberately contains no HTTP or release-gate bypass. The API
 * authenticates and checks the Epic 172 gate before calling it. Keeping the
 * project -> task -> packages ordering here lets internal handoff and
 * concurrency tests exercise the same serialization boundary without opening
 * the disabled HTTP route.
 */
export async function withLockedTaskFilesystemGrantMutation<T>(input: Readonly<{
  apply: (rows: LockedTaskFilesystemGrantRows) => Promise<T>
  projectId: string
  taskId: string
}>): Promise<T> {
  return db.transaction(async (tx) => {
    const [lockedProject] = await tx
      .select()
      .from(projects)
      .where(eq(projects.id, input.projectId))
      .for('update')
    if (!lockedProject) {
      throw Object.assign(new Error('Project not found.'), { status: 404 })
    }

    const [lockedTask] = await tx
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, input.taskId), eq(tasks.projectId, lockedProject.id)))
      .for('update')
    if (!lockedTask) {
      throw Object.assign(new Error('Task not found.'), { status: 404 })
    }

    const lockedPackageRows = await tx
      .select()
      .from(workPackages)
      .where(eq(workPackages.taskId, input.taskId))
      .orderBy(workPackages.id)
      .for('update')

    return input.apply({ lockedPackageRows, lockedProject, lockedTask, tx })
  })
}
