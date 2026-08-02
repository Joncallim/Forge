import 'server-only'

import type { NextRequest } from 'next/server'
import { getSession } from '@/lib/session'
import { getAccessibleTask } from '@/lib/task-access'
import {
  readS5AuthoritativeTaskState,
  S5TaskNotFoundError,
  type S5AuthoritativeTaskState,
} from '@/lib/mcps/s5-server-reader'

export class S5RouteAuthorizationError extends Error {
  constructor(readonly status: 401 | 404) {
    super(status === 401 ? 'Unauthorized' : 'Task not found')
    this.name = 'S5RouteAuthorizationError'
  }
}

export async function readAuthorizedS5State(
  request: NextRequest,
  taskId: string,
): Promise<{ state: S5AuthoritativeTaskState; userId: string }> {
  const session = await getSession(request)
  if (!session) throw new S5RouteAuthorizationError(401)
  const task = await getAccessibleTask(taskId, session.userId)
  if (!task || task.submittedBy !== session.userId) throw new S5RouteAuthorizationError(404)
  try {
    return {
      state: await readS5AuthoritativeTaskState(taskId, session.userId),
      userId: session.userId,
    }
  } catch (error) {
    if (error instanceof S5TaskNotFoundError) throw new S5RouteAuthorizationError(404)
    throw error
  }
}
