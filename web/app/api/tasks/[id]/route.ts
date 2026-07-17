import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { db } from '@/db'
import {
  agentHarnesses,
  approvalGates,
  artifacts,
  agentRuns,
  filesystemMcpRuntimeAudits,
  repositoryCommandAudits,
  taskAttempts,
  taskQuestions,
  tasks,
  vcsChanges,
  workPackages,
} from '@/db/schema'
import { and, eq, asc, inArray, or, sql } from 'drizzle-orm'
import { getSession } from '@/lib/session'
import { publishTaskEvent } from '@/worker/events'
import { recordTaskLogBestEffort } from '@/worker/task-logs'
import { accessibleTaskCondition, getAccessibleTask } from '@/lib/task-access'
import { validateMcpOperatorReviewHistory } from '@/worker/mcp-plan-review'

// ---------------------------------------------------------------------------
// GET /api/tasks/:id
// ---------------------------------------------------------------------------

const TERMINAL_TASK_STATUSES = ['completed', 'failed', 'cancelled', 'rejected'] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function metadataString(metadata: unknown, key: string): string | null {
  if (!isRecord(metadata)) return null
  const value = metadata[key]
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

function errorCode(err: unknown): string | null {
  if (!isRecord(err)) return null
  if (typeof err.code === 'string') return err.code
  return errorCode(err.cause)
}

function optionalAuditUnavailableReason(err: unknown): 'missing' | 'permission' | null {
  const code = errorCode(err)
  if (code === '42P01') return 'missing'
  if (code === '42501') return 'permission'
  return null
}

// A missing GRANT or an un-applied migration on an optional audit table is a
// persistent condition, so warning on every task-detail request just floods the
// logs. Warn once per (table, reason) per process, then degrade quietly — the
// task detail still returns without the audit rows regardless.
const warnedAuditGaps = new Set<string>()
function warnAuditGapOnce(
  table: string,
  reason: 'missing' | 'permission',
  taskId: string,
  rowLabel: string,
): void {
  const key = `${table}:${reason}`
  if (warnedAuditGaps.has(key)) return
  warnedAuditGaps.add(key)
  const remedy = reason === 'permission'
    ? `Grant SELECT on "${table}" to the database role in DATABASE_URL.`
    : 'Run `npm run db:migrate` to create it.'
  console.warn(
    `[GET /api/tasks/:id] "${table}" is ${reason === 'missing' ? 'missing' : 'not readable'}; returning task detail without ${rowLabel} audit rows. ${remedy} (logged once per process)`,
    { taskId, reason },
  )
}

async function selectTaskCommandAudits(taskId: string): Promise<(typeof repositoryCommandAudits.$inferSelect)[]> {
  try {
    return await db
      .select()
      .from(repositoryCommandAudits)
      .where(eq(repositoryCommandAudits.taskId, taskId))
      .orderBy(asc(repositoryCommandAudits.startedAt))
  } catch (err) {
    const reason = optionalAuditUnavailableReason(err)
    if (reason) {
      warnAuditGapOnce('repository_command_audits', reason, taskId, 'command')
      return []
    }
    throw err
  }
}

async function selectTaskFilesystemAudits(taskId: string): Promise<(typeof filesystemMcpRuntimeAudits.$inferSelect)[]> {
  try {
    return await db
      .select()
      .from(filesystemMcpRuntimeAudits)
      .where(eq(filesystemMcpRuntimeAudits.taskId, taskId))
      .orderBy(asc(filesystemMcpRuntimeAudits.createdAt))
  } catch (err) {
    const reason = optionalAuditUnavailableReason(err)
    if (reason) {
      warnAuditGapOnce('filesystem_mcp_runtime_audits', reason, taskId, 'filesystem MCP')
      return []
    }
    throw err
  }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { id } = await params

    const task = await getAccessibleTask(id, session.userId)

    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 })
    }

    // Fetch agent runs ordered by createdAt asc
    const runs = await db
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.taskId, id))
      .orderBy(asc(agentRuns.createdAt))

    const attempts = await db
      .select()
      .from(taskAttempts)
      .where(eq(taskAttempts.taskId, id))
      .orderBy(asc(taskAttempts.createdAt))

    const questions = await db
      .select()
      .from(taskQuestions)
      .where(eq(taskQuestions.taskId, id))
      .orderBy(asc(taskQuestions.createdAt))

    // Fetch artifacts for all runs
    const runIds = runs.map((r) => r.id)
    const workPackageIdByRunId = new Map(
      runs
        .filter((run) => typeof run.workPackageId === 'string' && run.workPackageId.length > 0)
        .map((run) => [run.id, run.workPackageId as string]),
    )
    let taskArtifacts: typeof artifacts.$inferSelect[] = []
    if (runIds.length > 0) {
      taskArtifacts = await db
        .select()
        .from(artifacts)
        .where(inArray(artifacts.agentRunId, runIds))
        .orderBy(asc(artifacts.createdAt))
    }
    const artifactsByWorkPackageId = new Map<string, typeof taskArtifacts>()
    for (const artifact of taskArtifacts) {
      const workPackageId = workPackageIdByRunId.get(artifact.agentRunId)
      if (!workPackageId) continue
      const existing = artifactsByWorkPackageId.get(workPackageId) ?? []
      existing.push(artifact)
      artifactsByWorkPackageId.set(workPackageId, existing)
    }

    const [taskWorkPackages, taskApprovalGates, taskVcsChanges, taskCommandAudits, taskFilesystemAudits] = await Promise.all([
      db
        .select()
        .from(workPackages)
        .where(eq(workPackages.taskId, id))
        .orderBy(asc(workPackages.sequence), asc(workPackages.createdAt)),
      db
        .select()
        .from(approvalGates)
        .where(eq(approvalGates.taskId, id))
        .orderBy(asc(approvalGates.createdAt)),
      db
        .select()
        .from(vcsChanges)
        .where(eq(vcsChanges.taskId, id))
        .orderBy(asc(vcsChanges.createdAt)),
      selectTaskCommandAudits(id),
      selectTaskFilesystemAudits(id),
    ])
    const harnessIds = [
      ...new Set(
        taskWorkPackages
          .map((pkg) => pkg.harnessId)
          .filter((harnessId): harnessId is string => typeof harnessId === 'string' && harnessId.length > 0),
      ),
    ]
    const taskHarnesses = harnessIds.length > 0
      ? await db
        .select({
          id: agentHarnesses.id,
          role: agentHarnesses.role,
          displayName: agentHarnesses.displayName,
          description: agentHarnesses.description,
        })
        .from(agentHarnesses)
        .where(inArray(agentHarnesses.id, harnessIds))
      : []
    const harnessById = new Map(taskHarnesses.map((harness) => [harness.id, harness]))
    const taskWorkPackagesWithPrompts = taskWorkPackages.map((pkg) => {
      const harness = pkg.harnessId ? harnessById.get(pkg.harnessId) : undefined
      return {
        ...pkg,
        harnessRole: harness?.role ?? null,
        harnessDisplayName: harness?.displayName ?? null,
        harnessDescription: harness?.description ?? null,
        promptOverlay: metadataString(pkg.metadata, 'promptOverlay'),
        artifacts: artifactsByWorkPackageId.get(pkg.id) ?? [],
      }
    })
    const taskApprovalGatesWithValidatedReviews = taskApprovalGates.map((gate) => {
      const validation = validateMcpOperatorReviewHistory(gate.metadata, gate.sourceArtifactId)
      return {
        ...gate,
        validatedMcpOperatorReview: validation.valid ? validation.head : null,
        mcpOperatorReviewIntegrity: validation.valid ? 'valid' : 'invalid',
      }
    })

    return NextResponse.json({
      task,
      runs,
      artifacts: taskArtifacts,
      attempts,
      questions,
      workPackages: taskWorkPackagesWithPrompts,
      approvalGates: taskApprovalGatesWithValidatedReviews,
      commandAudits: taskCommandAudits,
      filesystemAudits: taskFilesystemAudits,
      vcsChanges: taskVcsChanges,
    })
  } catch (err) {
    console.error('[GET /api/tasks/:id] Unexpected error', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// ---------------------------------------------------------------------------
// DELETE /api/tasks/:id
// ---------------------------------------------------------------------------

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { id } = await params
    const mode = new URL(request.url).searchParams.get('mode') === 'delete' ? 'delete' : 'cancel'

    const existing = await getAccessibleTask(id, session.userId)

    if (!existing) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 })
    }

    if (mode === 'delete') {
      if (!TERMINAL_TASK_STATUSES.includes(existing.status as typeof TERMINAL_TASK_STATUSES[number])) {
        return NextResponse.json(
          { error: `Cannot delete active task with status '${existing.status}'. Stop it first, then delete it after cancellation completes.` },
          { status: 409 },
        )
      }
      return NextResponse.json(
        { error: 'Task deletion is disabled because Forge retains task, run, and review evidence. The terminal task remains available in history.' },
        { status: 409 },
      )
    }

    if (TERMINAL_TASK_STATUSES.includes(existing.status as typeof TERMINAL_TASK_STATUSES[number])) {
      return NextResponse.json(
        { error: `Cannot stop task with status '${existing.status}'. Forge retains terminal task and execution history.` },
        { status: 409 },
      )
    }

    const now = new Date()
    const cancelled = await db.transaction(async (tx) => {
      const [task] = await tx
        .update(tasks)
        .set({
          completedAt: now,
          errorMessage: 'Task stopped by operator.',
          status: 'cancelled',
          updatedAt: now,
        })
        .where(and(
          eq(tasks.id, id),
          accessibleTaskCondition(id, session.userId),
          or(
            eq(tasks.status, 'pending'),
            eq(tasks.status, 'running'),
            eq(tasks.status, 'awaiting_answers'),
            eq(tasks.status, 'awaiting_approval'),
            eq(tasks.status, 'approved'),
            eq(tasks.status, 'failed'),
          )!,
        ))
        .returning({ id: tasks.id })

      if (!task) return null

      await tx
        .update(workPackages)
        .set({
          blockedReason: 'Task stopped by operator.',
          status: 'cancelled',
          updatedAt: now,
        })
        .where(and(
          eq(workPackages.taskId, id),
          inArray(workPackages.status, ['pending', 'ready', 'running', 'awaiting_review', 'needs_rework', 'blocked']),
        ))

      await tx
        .update(approvalGates)
        .set({
          metadata: sql`coalesce(${approvalGates.metadata}, '{}'::jsonb) || ${JSON.stringify({
            cancelledReason: 'Task stopped by operator.',
            source: 'task-delete-route',
          })}::jsonb`,
          status: 'cancelled',
          updatedAt: now,
        })
        .where(and(eq(approvalGates.taskId, id), eq(approvalGates.status, 'pending')))

      await tx
        .update(agentRuns)
        .set({
          completedAt: now,
          errorMessage: 'Task stopped by operator.',
          status: 'cancelled',
        })
        .where(and(eq(agentRuns.taskId, id), eq(agentRuns.status, 'running')))

      return task
    })

    if (!cancelled) {
      return NextResponse.json(
        { error: `Cannot stop task with status '${existing.status}'.` },
        { status: 409 },
      )
    }

    await recordTaskLogBestEffort({
      eventType: 'task.cancelled',
      level: 'warning',
      message: 'Task was stopped by an operator.',
      metadata: { cancelledAt: now.toISOString(), previousStatus: existing.status },
      source: 'api',
      taskId: id,
      title: 'Task cancelled',
    })

    await publishTaskEvent(id, 'task:status', {
      errorMessage: 'Task stopped by operator.',
      status: 'cancelled',
      updatedAt: now.toISOString(),
    }).catch(() => undefined)

    console.info('[DELETE /api/tasks/:id] Cancelled task', { id })
    return NextResponse.json({ ok: true, mode: 'cancel' })
  } catch (err) {
    console.error('[DELETE /api/tasks/:id] Unexpected error', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
