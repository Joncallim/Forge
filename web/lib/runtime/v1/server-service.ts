import 'server-only'

import { randomUUID } from 'node:crypto'
import type { NextRequest } from 'next/server'
import postgres from 'postgres'
import { z } from 'zod'
import { getRequiredEnv } from '@/lib/env'
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
    taskId: string | null
  }): Promise<{ missionId: string; executionId: string }>
  readMissionForUser(missionId: string, ownerUserId: string): Promise<unknown | null>
  transitionForUser(executionId: string, ownerUserId: string, input: z.infer<typeof transitionExecutionRequestSchema>): Promise<void>
}

/**
 * The only production runtime store in A1.  The server boundary derives the
 * human identity first; protected routines then repeat owner/CAS checks in
 * PostgreSQL.  It intentionally has no Redis, scheduler, or egress path.
 */
export class PostgreSqlRuntimeStore implements RuntimeStore {
  private readonly sql: ReturnType<typeof postgres>

  constructor(databaseUrl = getRequiredEnv('DATABASE_URL')) {
    this.sql = postgres(databaseUrl, { max: 1, prepare: true, onnotice: () => {}, transform: { undefined: null } })
  }

  async close(): Promise<void> { await this.sql.end({ timeout: 5 }) }

  async createForUser(input: z.infer<typeof createMissionRequestSchema> & {
    missionId: string; executionId: string; ownerUserId: string; taskId: string | null
  }): Promise<{ missionId: string; executionId: string }> {
    const [row] = await this.sql<{ missionId: string; executionId: string }[]>`
      select mission_id as "missionId", execution_id as "executionId"
      from forge.create_vnext_mission_v1(
        ${input.missionId}::uuid, ${input.executionId}::uuid, ${input.taskId}::uuid, ${input.ownerUserId}::uuid,
        ${input.desiredOutcomeDigest}, ${input.constraintsDigest}, ${JSON.stringify(input.compatibilityPins)}::jsonb,
        ${input.compatibilityPins.workflowRevision}, ${JSON.stringify(input.resourceBindings)}::jsonb, ${'mission.created'}
      )
    `
    if (!row) throw new Error('Protected mission create routine returned no row.')
    return row
  }

  async readMissionForUser(missionId: string, ownerUserId: string): Promise<unknown | null> {
    const [row] = await this.sql`
      select id, lifecycle_state as "lifecycle", outcome, state_revision::text as revision,
        owner_principal_id as "ownerUserId", compatibility_pins as "compatibilityPins"
      from public.missions where id=${missionId}::uuid and owner_principal_id=${ownerUserId}::uuid
    `
    return row ?? null
  }

  async transitionForUser(executionId: string, ownerUserId: string, input: z.infer<typeof transitionExecutionRequestSchema>): Promise<void> {
    await this.sql`
      select * from forge.transition_vnext_execution_v1(
        ${executionId}::uuid, ${input.expectedRevision}::bigint, ${input.lifecycle}, ${input.outcome},
        ${input.blockerReasonCode}, ${ownerUserId}::uuid, ${input.reasonCode}, ${input.evidenceDigest}
      )
    `
  }
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
  return store.createForUser({ ...input, missionId: randomUUID(), executionId: randomUUID(), ownerUserId, taskId: null })
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
  return store.createForUser({ ...input, missionId: randomUUID(), executionId: randomUUID(), ownerUserId, taskId })
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
