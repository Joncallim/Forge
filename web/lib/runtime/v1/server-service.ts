import 'server-only'

import { randomUUID } from 'node:crypto'
import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { getSession } from '@/lib/session'
import { getAccessibleTask } from '@/lib/task-access'
import {
  digestSchema,
  executionLifecycleSchema,
  executionOutcomeSchema,
  missionSpecSchema,
  reasonCodeSchema,
  revisionSchema,
} from './contracts'

// These schemas are the only inputs a route may pass into this service. Owner
// and actor identity are intentionally absent: the authenticated server session
// supplies them below, and internal principals are reserved for closed code.
export const createMissionRequestSchema = missionSpecSchema.omit({ parentMissionId: true })
export const transitionExecutionRequestSchema = z.object({
  expectedRevision: revisionSchema,
  lifecycle: executionLifecycleSchema,
  outcome: executionOutcomeSchema.nullable(),
  blockerReasonCode: reasonCodeSchema.nullable(),
  reasonCode: reasonCodeSchema,
  evidenceDigest: digestSchema.nullable(),
}).strict()

export class RuntimeAuthorizationError extends Error {
  constructor() { super('Unauthorized') }
}

export class RuntimeNotFoundError extends Error {
  constructor() { super('Runtime compatibility task not found') }
}

export type RuntimeStore = {
  createForUser(input: z.infer<typeof createMissionRequestSchema> & {
    missionId: string
    executionId: string
    ownerUserId: string
  }): Promise<{ missionId: string; executionId: string }>
  readMissionForUser(missionId: string, ownerUserId: string): Promise<unknown | null>
  transitionForUser(executionId: string, ownerUserId: string, input: z.infer<typeof transitionExecutionRequestSchema>): Promise<void>
}

async function authenticatedUserId(request: NextRequest): Promise<string> {
  const session = await getSession(request)
  if (!session) throw new RuntimeAuthorizationError()
  return session.userId
}

export async function createMissionForAuthorizedSession(
  request: NextRequest,
  untrustedInput: unknown,
  store: RuntimeStore,
): Promise<{ missionId: string; executionId: string }> {
  const input = createMissionRequestSchema.parse(untrustedInput)
  const ownerUserId = await authenticatedUserId(request)
  return store.createForUser({ ...input, missionId: randomUUID(), executionId: randomUUID(), ownerUserId })
}

// The Task seam is intentionally one-way: compatibility ownership comes from
// the existing Task authority (`submittedBy`), never from a Task request body.
export async function createTaskMissionForAuthorizedSession(
  request: NextRequest,
  taskId: string,
  untrustedInput: unknown,
  store: RuntimeStore,
): Promise<{ missionId: string; executionId: string }> {
  const ownerUserId = await authenticatedUserId(request)
  const task = await getAccessibleTask(taskId, ownerUserId)
  if (!task || task.submittedBy !== ownerUserId) throw new RuntimeNotFoundError()
  const input = createMissionRequestSchema.parse(untrustedInput)
  return store.createForUser({ ...input, missionId: randomUUID(), executionId: randomUUID(), ownerUserId })
}

export async function readMissionForAuthorizedSession(
  request: NextRequest,
  missionId: string,
  store: RuntimeStore,
): Promise<unknown | null> {
  return store.readMissionForUser(missionId, await authenticatedUserId(request))
}

export async function transitionExecutionForAuthorizedSession(
  request: NextRequest,
  executionId: string,
  untrustedInput: unknown,
  store: RuntimeStore,
): Promise<void> {
  const input = transitionExecutionRequestSchema.parse(untrustedInput)
  await store.transitionForUser(executionId, await authenticatedUserId(request), input)
}
