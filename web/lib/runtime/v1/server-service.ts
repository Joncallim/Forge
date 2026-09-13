import 'server-only'

import { randomUUID } from 'node:crypto'
import type { NextRequest } from 'next/server'
import postgres from 'postgres'
import { z } from 'zod'
import { getRequiredEnv } from '@/lib/env'
import { readSessionCredential } from '@/lib/session'
import { digestSchema, executionLifecycleSchema, executionOutcomeSchema, missionLifecycleSchema, missionOutcomeSchema, missionRefSchema, reasonCodeSchema, revisionSchema } from './contracts'

// Request bodies carry no identity, resource, policy/profile, or revision
// authority. The protected database routines derive all of that from the
// existing session and, for Task missions, the existing Task and Project.
export const createMissionRequestSchema = z.object({
  version: z.literal('v1'),
  desiredOutcomeDigest: digestSchema,
  constraintsDigest: digestSchema,
}).strict()

export const transitionExecutionRequestSchema = z.object({
  expectedRevision: revisionSchema,
  lifecycle: executionLifecycleSchema,
  outcome: executionOutcomeSchema.nullable(),
  blockerReasonCode: reasonCodeSchema.nullable(),
  reasonCode: reasonCodeSchema,
  evidenceDigest: digestSchema.nullable(),
}).strict()

export const transitionMissionRequestSchema = z.object({
  expectedRevision: revisionSchema,
  lifecycle: missionLifecycleSchema,
  outcome: missionOutcomeSchema.nullable(),
  reasonCode: reasonCodeSchema,
  evidenceDigest: digestSchema.nullable(),
}).strict()

export class RuntimeAuthorizationError extends Error {
  constructor() { super('Unauthorized') }
}

export type RuntimeStore = {
  createGeneric(input: z.infer<typeof createMissionRequestSchema> & { missionId: string; executionId: string; sessionCredential: Buffer }): Promise<{ missionId: string; executionId: string }>
  createTask(input: z.infer<typeof createMissionRequestSchema> & { taskId: string; missionId: string; executionId: string; sessionCredential: Buffer }): Promise<{ missionId: string; executionId: string }>
  readMission(missionId: string, sessionCredential: Buffer): Promise<unknown | null>
  transitionMission(missionId: string, sessionCredential: Buffer, input: z.infer<typeof transitionMissionRequestSchema>): Promise<void>
  transitionExecution(executionId: string, sessionCredential: Buffer, input: z.infer<typeof transitionExecutionRequestSchema>): Promise<void>
}

/** The only A1 production store: it can invoke the credential-only SQL API. */
export class PostgreSqlRuntimeStore implements RuntimeStore {
  private readonly sql: ReturnType<typeof postgres>

  constructor(databaseUrl = getRequiredEnv('FORGE_RUNTIME_DATABASE_URL')) {
    this.sql = postgres(databaseUrl, { max: 1, prepare: true, onnotice: () => {}, transform: { undefined: null } })
  }

  async close(): Promise<void> { await this.sql.end({ timeout: 5 }) }

  async createGeneric(input: z.infer<typeof createMissionRequestSchema> & { missionId: string; executionId: string; sessionCredential: Buffer }): Promise<{ missionId: string; executionId: string }> {
    const [row] = await this.sql<{ missionId: string; executionId: string }[]>`
      select mission_id as "missionId", execution_id as "executionId"
      from forge.create_vnext_generic_zero_mission_v1(${input.sessionCredential}::bytea, ${input.missionId}::uuid, ${input.executionId}::uuid, ${input.desiredOutcomeDigest}, ${input.constraintsDigest})
    `
    if (!row) throw new Error('Protected generic Mission create routine returned no row.')
    return row
  }

  async createTask(input: z.infer<typeof createMissionRequestSchema> & { taskId: string; missionId: string; executionId: string; sessionCredential: Buffer }): Promise<{ missionId: string; executionId: string }> {
    const [row] = await this.sql<{ missionId: string; executionId: string }[]>`
      select mission_id as "missionId", execution_id as "executionId"
      from forge.create_vnext_task_mission_v1(${input.sessionCredential}::bytea, ${input.taskId}::uuid, ${input.missionId}::uuid, ${input.executionId}::uuid, ${input.desiredOutcomeDigest}, ${input.constraintsDigest})
    `
    if (!row) throw new Error('Protected Task Mission create routine returned no row.')
    return row
  }

  async readMission(missionId: string, sessionCredential: Buffer): Promise<unknown | null> {
    const [row] = await this.sql`
      select id, lifecycle_state as "lifecycle", outcome, state_revision::text as revision,
        owner_principal_type as "ownerType", owner_principal_id as "ownerId",
        created_at as "createdAt", active_at as "activeAt", waiting_at as "waitingAt",
        paused_at as "pausedAt", terminal_at as "terminalAt", updated_at as "updatedAt"
      from forge.read_vnext_mission_v1(${sessionCredential}::bytea, ${missionId}::uuid)
    `
    if (!row) return null
    const value = row as Record<string, unknown>
    const iso = (timestamp: unknown): string | null => timestamp instanceof Date ? timestamp.toISOString() : typeof timestamp === 'string' ? timestamp : null
    return missionRefSchema.parse({
      version: 'v1', id: value.id, owner: { version: 'v1', type: value.ownerType, id: value.ownerId },
      lifecycle: value.lifecycle, outcome: value.outcome, revision: value.revision,
      createdAt: iso(value.createdAt), activeAt: iso(value.activeAt), waitingAt: iso(value.waitingAt),
      pausedAt: iso(value.pausedAt), terminalAt: iso(value.terminalAt), updatedAt: iso(value.updatedAt),
    })
  }

  async transitionMission(missionId: string, sessionCredential: Buffer, input: z.infer<typeof transitionMissionRequestSchema>): Promise<void> {
    await this.sql`select * from forge.transition_vnext_mission_for_session_v1(${sessionCredential}::bytea, ${missionId}::uuid, ${input.expectedRevision}::bigint, ${input.lifecycle}, ${input.outcome}, ${input.reasonCode}, ${input.evidenceDigest})`
  }

  async transitionExecution(executionId: string, sessionCredential: Buffer, input: z.infer<typeof transitionExecutionRequestSchema>): Promise<void> {
    await this.sql`select * from forge.transition_vnext_execution_for_session_v1(${sessionCredential}::bytea, ${executionId}::uuid, ${input.expectedRevision}::bigint, ${input.lifecycle}, ${input.outcome}, ${input.blockerReasonCode}, ${input.reasonCode}, ${input.evidenceDigest})`
  }
}

function credentialFromRequest(request: NextRequest): Buffer {
  const credential = readSessionCredential(request)
  if (!credential) throw new RuntimeAuthorizationError()
  return Buffer.from(credential, 'ascii')
}

async function withSessionCredential<T>(request: NextRequest, operation: (credential: Buffer) => Promise<T>): Promise<T> {
  const credential = credentialFromRequest(request)
  try {
    return await operation(credential)
  } finally {
    credential.fill(0)
  }
}

export async function createMissionForAuthorizedSession(request: NextRequest, untrustedInput: unknown, store: RuntimeStore): Promise<{ missionId: string; executionId: string }> {
  const input = createMissionRequestSchema.parse(untrustedInput)
  return withSessionCredential(request, (sessionCredential) => store.createGeneric({ ...input, missionId: randomUUID(), executionId: randomUUID(), sessionCredential }))
}

export async function createTaskMissionForAuthorizedSession(request: NextRequest, taskId: string, untrustedInput: unknown, store: RuntimeStore): Promise<{ missionId: string; executionId: string }> {
  const input = createMissionRequestSchema.parse(untrustedInput)
  return withSessionCredential(request, (sessionCredential) => store.createTask({ ...input, taskId, missionId: randomUUID(), executionId: randomUUID(), sessionCredential }))
}

export async function readMissionForAuthorizedSession(request: NextRequest, missionId: string, store: RuntimeStore): Promise<unknown | null> {
  return withSessionCredential(request, (sessionCredential) => store.readMission(missionId, sessionCredential))
}

export async function transitionExecutionForAuthorizedSession(request: NextRequest, executionId: string, untrustedInput: unknown, store: RuntimeStore): Promise<void> {
  const input = transitionExecutionRequestSchema.parse(untrustedInput)
  await withSessionCredential(request, (sessionCredential) => store.transitionExecution(executionId, sessionCredential, input))
}

export async function transitionMissionForAuthorizedSession(request: NextRequest, missionId: string, untrustedInput: unknown, store: RuntimeStore): Promise<void> {
  const input = transitionMissionRequestSchema.parse(untrustedInput)
  await withSessionCredential(request, (sessionCredential) => store.transitionMission(missionId, sessionCredential, input))
}
