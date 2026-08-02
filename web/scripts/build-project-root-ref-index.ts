import '../lib/load-env'
import postgres from 'postgres'

type IndexState = {
  exists: boolean
  canonical: boolean
  valid: boolean
  ready: boolean
}

async function main(): Promise<void> {
  if (process.argv.slice(2).join(' ') !== '--apply') {
    throw new Error('Concurrent root-reference index creation is actionless without --apply.')
  }
  const adminUrl = process.env.FORGE_DATABASE_ADMIN_URL?.trim()
  if (!adminUrl) throw new Error('FORGE_DATABASE_ADMIN_URL is required for the short-lived concurrent DDL step.')
  const admin = postgres(adminUrl, { max: 1, onnotice: () => {} })
  try {
    await admin`select pg_catalog.pg_advisory_lock(pg_catalog.hashtext('forge:projects_root_ref_idx:v1'))`
    const inspect = async () => admin<IndexState[]>`
      with candidate as (select pg_catalog.to_regclass('public.projects_root_ref_idx') as index_oid)
      select (candidate.index_oid is not null) as exists,
        coalesce(idx.indisvalid, false) as valid, coalesce(idx.indisready, false) as ready,
        coalesce(idx.indisunique and idx.indisvalid and idx.indisready and idx.indnkeyatts=1 and idx.indnatts=1
          and pg_catalog.pg_get_indexdef(idx.indexrelid) = 'CREATE UNIQUE INDEX projects_root_ref_idx ON public.projects USING btree (root_ref) WHERE (root_ref IS NOT NULL)', false) as canonical
      from candidate left join pg_catalog.pg_index idx on idx.indexrelid = candidate.index_oid
    `
    let index: IndexState | undefined = (await inspect())[0]
    if (index?.exists && !index.canonical && index.valid && index.ready) throw new Error('projects_root_ref_idx exists with a noncanonical definition.')
    if (index?.exists && (!index.valid || !index.ready)) {
      await admin.unsafe('DROP INDEX CONCURRENTLY public.projects_root_ref_idx')
      index = undefined
    }
    // PostgreSQL rejects CONCURRENTLY inside a transaction. Keep this isolated
    // from reconciliation, whose dedicated login never receives this URL.
    if (!index?.exists) await admin.unsafe('CREATE UNIQUE INDEX CONCURRENTLY projects_root_ref_idx ON public.projects(root_ref) WHERE root_ref IS NOT NULL')
    ;[index] = await inspect()
    if (!index?.canonical) throw new Error('Concurrent projects(root_ref) index is not exact and valid.')
  } finally {
    await admin`select pg_catalog.pg_advisory_unlock(pg_catalog.hashtext('forge:projects_root_ref_idx:v1'))`.catch(() => undefined)
    await admin.end({ timeout: 5 })
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Concurrent index build failed.')
  process.exitCode = 1
})
