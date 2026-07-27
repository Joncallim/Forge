import '../lib/load-env'
import postgres from 'postgres'

async function main(): Promise<void> {
  if (process.argv.slice(2).join(' ') !== '--apply') {
    throw new Error('Concurrent root-reference index creation is actionless without --apply.')
  }
  const adminUrl = process.env.FORGE_DATABASE_ADMIN_URL?.trim()
  if (!adminUrl) throw new Error('FORGE_DATABASE_ADMIN_URL is required for the short-lived concurrent DDL step.')
  const admin = postgres(adminUrl, { max: 1, onnotice: () => {} })
  try {
    // PostgreSQL rejects CONCURRENTLY inside a transaction. Keep this isolated
    // from reconciliation, whose dedicated login never receives this URL.
    await admin.unsafe(
      'CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS projects_root_ref_idx ON public.projects(root_ref) WHERE root_ref IS NOT NULL',
    )
    const [index] = await admin<{ valid: boolean }[]>`
      select indisvalid as valid from pg_catalog.pg_index
      where indexrelid = 'public.projects_root_ref_idx'::pg_catalog.regclass
    `
    if (!index?.valid) throw new Error('Concurrent projects(root_ref) index is not valid.')
  } finally {
    await admin.end({ timeout: 5 })
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Concurrent index build failed.')
  process.exitCode = 1
})
