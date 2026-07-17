import { createHash } from 'node:crypto'
import { eq, and, desc } from 'drizzle-orm'
import { db } from '@/db'
import { architectPlanEntries, architectPlanVersions } from '@/db/schema'

const MAX_ENTRIES_PER_PLAN = 256

const MAX_ENTRY_CONTENT_BYTES = 65536

const PLAN_ARCHIVE_RETENTION = 10

export function entryContentDigest(content: string, digestKey: Buffer): string {
  const hmac = createHash('sha256')
  hmac.update('forge:architect-plan-entry:v1')
  hmac.update(digestKey)
  hmac.update(Buffer.from(content, 'utf8'))
  return `hmac-sha256:${hmac.digest('hex')}`
}

export function assertEntryContentSize(content: string): void {
  const bytes = Buffer.byteLength(content, 'utf8')
  if (bytes === 0) throw new Error('Architect plan entry content must not be empty.')
  if (bytes > MAX_ENTRY_CONTENT_BYTES) {
    throw new Error(
      `Architect plan entry content exceeds ${MAX_ENTRY_CONTENT_BYTES} bytes (got ${bytes} bytes).`,
    )
  }
}

export function assertEntryCountLimit(count: number): void {
  if (count > MAX_ENTRIES_PER_PLAN) {
    throw new Error(
      `Architect plan version exceeds ${MAX_ENTRIES_PER_PLAN} entries (got ${count}).`,
    )
  }
}

export async function archiveExcessPlanVersions(input: {
  taskId: string
}): Promise<{ archivedCount: number; replacedVersions: string[] }> {
  const versions = await db
    .select({ planVersion: architectPlanVersions.planVersion })
    .from(architectPlanVersions)
    .where(eq(architectPlanVersions.taskId, input.taskId))
    .orderBy(desc(architectPlanVersions.planVersion))

  const archived: string[] = []
  if (versions.length > PLAN_ARCHIVE_RETENTION) {
    const toArchive = versions.slice(PLAN_ARCHIVE_RETENTION)
    for (const version of toArchive) {
      await db
        .update(architectPlanVersions)
        .set({ entryCount: 0 })
        .where(
          and(
            eq(architectPlanVersions.taskId, input.taskId),
            eq(architectPlanVersions.planVersion, version.planVersion),
          ),
        )
      archived.push(version.planVersion.toString())
    }
  }

  return {
    archivedCount: archived.length,
    replacedVersions: archived,
  }
}

export async function replaceOverLimitEntry(input: {
  content: string
  entryId: string
  planVersion: bigint
  taskId: string
}): Promise<{ replaced: boolean }> {
  const bytes = Buffer.byteLength(input.content, 'utf8')
  if (bytes <= MAX_ENTRY_CONTENT_BYTES) return { replaced: false }

  const truncated = Buffer.from(input.content, 'utf8').subarray(0, MAX_ENTRY_CONTENT_BYTES - 200).toString('utf8')
  const notice = `\n\n[Content truncated: ${bytes} bytes replaced with ${Buffer.byteLength(truncated, 'utf8')} bytes. Original SHA-256: ${createHash('sha256').update(input.content).digest('hex')}]`

  await db
    .update(architectPlanEntries)
    .set({
      content: truncated + notice,
      contentDigest: entryContentDigest(truncated + notice, Buffer.alloc(0)),
    })
    .where(
      and(
        eq(architectPlanEntries.taskId, input.taskId),
        eq(architectPlanEntries.planVersion, input.planVersion),
        eq(architectPlanEntries.entryId, input.entryId),
      ),
    )

  return { replaced: true }
}
