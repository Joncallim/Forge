import '../lib/load-env'
import postgres from 'postgres'
import { eq, sql } from 'drizzle-orm'
import { parseClaimedProjectRootChange, parseProjectRootReconciliationCommand } from '@/lib/mcps/project-root-reconciliation'

const usage = 'Usage: npm run project-roots:reconcile-expansion -- --through <nonnegative-generation> --actor <uuid> --apply'

function reconcilerUrl(): string {
  const value = process.env.FORGE_PROJECT_ROOT_RECONCILER_DATABASE_URL?.trim()
  if (!value) throw new Error('FORGE_PROJECT_ROOT_RECONCILER_DATABASE_URL is required.')
  const parsed = new URL(value)
  if (decodeURIComponent(parsed.username) !== 'forge_project_root_reconciler') {
    throw new Error('Project-root reconciliation requires the dedicated forge_project_root_reconciler login.')
  }
  return value
}

async function main(): Promise<void> {
  const command = parseProjectRootReconciliationCommand(process.argv.slice(2))
  if (!command.apply) {
    console.log(JSON.stringify({ mode: 'dry-run', through: command.throughGeneration.toString(), actor: command.actorId }))
    return
  }
  const url = reconcilerUrl()
  // The canonical S3 helper uses the repository's shared Drizzle transaction.
  // Set it before the dynamic imports so every mutation stays on this dedicated
  // login and the fixed routine completion remains in that same transaction.
  process.env.DATABASE_URL = url
  const [{ db, closeDb }, schema, reconciliation] = await Promise.all([
    import('@/db'),
    import('@/db/schema'),
    import('@/lib/mcps/filesystem-grant-reconciliation'),
  ])
  const observer = postgres(url, { max: 1, onnotice: () => {} })
  try {
    const [operation] = await observer<{
      operationId: string; state: string; lastProcessedGeneration: string; throughGeneration: string
    }[]>`
      select operation_id as "operationId", state, last_processed_generation::text as "lastProcessedGeneration",
        through_generation::text as "throughGeneration"
      from forge.begin_project_root_reconciliation_v1(null, ${command.actorId}::uuid, ${command.throughGeneration.toString()}::bigint)
    `
    if (!operation) throw new Error('Project-root reconciliation operation was not created.')
    if (operation.state === 'complete') {
      console.log(JSON.stringify({ mode: 'complete-replay', operationId: operation.operationId, through: operation.throughGeneration }))
      return
    }
    const batchSize = Number(process.env.FORGE_PROJECT_ROOT_RECONCILE_BATCH_SIZE ?? '25')
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100) throw new Error('FORGE_ROOT_REF_RECONCILE_BATCH_SIZE must be 1 through 100.')
    for (;;) {
      const result = await db.transaction(async (tx) => {
        await tx.execute(sql`set local lock_timeout = '5s'`)
        await tx.execute(sql`set local statement_timeout = '30s'`)
        const claimedRows = await tx.execute(sql`
          select generation::text as generation, project_id as "projectId", outcome,
            root_binding_revision::text as "rootBindingRevision", grant_decision_revision::text as "grantDecisionRevision"
          from forge.claim_project_root_reconciliation_batch_v1(
            ${operation.operationId}::uuid, ${command.actorId}::uuid, ${batchSize}
          )
        `)
        const claimed = (claimedRows as unknown as Array<Record<string, unknown>>).map(parseClaimedProjectRootChange)
        if (claimed.length === 0) return { completed: true, processed: 0 }
        for (const change of claimed) {
          await tx.execute(sql`select forge.enter_project_root_reconciliation_generation_v1(${operation.operationId}::uuid, ${command.actorId}::uuid, ${change.generation.toString()}::bigint, ${change.projectId}::uuid)`)
          const [project] = await tx.select().from(schema.projects)
            .where(eq(schema.projects.id, change.projectId))
          if (!project) throw new Error('Journal project disappeared before reconciliation.')
          const hasBoundFilesystemAuthority = project.rootBindingRevision > BigInt(0)
            || project.grantDecisionRevision > BigInt(0)
          // A legacy root-ref materialization can only be a no-authority
          // outcome while both authority revisions are the canonical zero.
          if (change.outcome !== 'insert' && hasBoundFilesystemAuthority) {
            await reconciliation.reconcileFilesystemGrantsForProject(tx, {
              actorId: command.actorId,
              grantDecisionRevision: project.grantDecisionRevision.toString(),
              lockedProject: project,
              nextMcpConfig: reconciliation.filesystemMcpConfigAfterRootRepoint({
                grantDecisionRevision: project.grantDecisionRevision,
                mcpConfig: project.mcpConfig,
                rootBindingRevision: project.rootBindingRevision,
              }),
              suppressPhasePersistence: true,
              rootReconciliationContext: { operationId: operation.operationId, actorId: command.actorId, generation: change.generation.toString(), projectId: change.projectId },
              trigger: 'project_root_repoint',
            })
          }
          const completionRows = await tx.execute(sql`
            select * from forge.complete_project_root_reconciliation_generation_v1(
              ${operation.operationId}::uuid, ${command.actorId}::uuid,
              ${change.generation.toString()}::bigint, ${change.projectId}::uuid, ${change.outcome}
            )
          `)
          const completion = (completionRows as unknown as Array<{ state?: unknown; last_processed_generation?: unknown }>)[0]
          if (!completion || (completion.state !== 'running' && completion.state !== 'complete')
            || String(completion.last_processed_generation) !== change.generation.toString()) {
            throw new Error('Project-root completion returned an invalid state.')
          }
          if (completion.state === 'complete') return { completed: true, processed: claimed.length }
        }
        return { completed: false, processed: claimed.length }
      })
      if (result.completed) break
      console.log(JSON.stringify({ mode: 'applied-batch', operationId: operation.operationId, processed: result.processed }))
    }
    console.log(JSON.stringify({ mode: 'complete', operationId: operation.operationId, through: command.throughGeneration.toString() }))
  } finally {
    await observer.end({ timeout: 5 })
    await closeDb()
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : usage)
  process.exitCode = 1
})
