import { pathToFileURL } from 'node:url'
import postgres from 'postgres'
import {
  localProjectionArchiveExitCode,
  parseArchiveLocalProjectionOverlimitArgs,
  runLocalProjectionOverlimitArchive,
} from '../lib/mcps/local-projection-overlimit-archive'
import {
  createLocalProjectionArchiverPostgresAdapter,
  requiredLocalProjectionArchiverDatabaseUrl,
} from './inspect-local-projection-overlimit'

export function archiveLocalProjectionOverlimitUsage(): string {
  return `Archive one over-limit legacy task without moving or deleting its evidence

Dry-run (read-only):
  npm run protocol:archive-local-projection-overlimit -- \\
    --task <legacy-task-id> --replacement <replacement-task-id> --actor <operator-user-id>

Start apply (commits one validated checkpoint):
  npm run protocol:archive-local-projection-overlimit -- \\
    --task <legacy-task-id> --replacement <replacement-task-id> --actor <operator-user-id> --apply

Resume after apply or interruption:
  npm run protocol:archive-local-projection-overlimit -- \\
    --operation <operation-id> --operation-fingerprint <sha256:64-hex> --actor <operator-user-id> --resume

Rollback before the final archive:
  npm run protocol:archive-local-projection-overlimit -- \\
    --operation <operation-id> --operation-fingerprint <sha256:64-hex> --actor <operator-user-id> --rollback

Cancel the unused pending replacement before the final archive:
  npm run protocol:archive-local-projection-overlimit -- \\
    --operation <operation-id> --operation-fingerprint <sha256:64-hex> --actor <operator-user-id> --cancel

The command exits 2 after a validated or quiesced checkpoint. Use the returned
operationId and operationFingerprint for the next resume. Archived, rolled_back,
and cancelled are terminal and exit 0.

Environment:
  FORGE_LOCAL_PROJECTION_ARCHIVER_DATABASE_URL
    PostgreSQL URL for the dedicated forge_local_projection_archiver login.
  PGPASSWORD, PGPASSFILE, PGSERVICE, PGSERVICEFILE, PGSSLPASSWORD
    Must be unset. This command permits certificate or peer authentication only.`
}

export async function runArchiveLocalProjectionOverlimitCli(argv: readonly string[]): Promise<number> {
  const cli = parseArchiveLocalProjectionOverlimitArgs(argv)
  const sql = postgres(requiredLocalProjectionArchiverDatabaseUrl(), { max: 1 })
  try {
    const result = await runLocalProjectionOverlimitArchive(
      cli,
      createLocalProjectionArchiverPostgresAdapter(sql),
    )
    process.stdout.write(`${JSON.stringify(result)}\n`)
    return localProjectionArchiveExitCode(result)
  } finally {
    await sql.end({ timeout: 5 })
  }
}

async function main(): Promise<void> {
  try {
    const argv = process.argv.slice(2)
    if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
      process.stdout.write(`${archiveLocalProjectionOverlimitUsage()}\n`)
      return
    }
    process.exitCode = await runArchiveLocalProjectionOverlimitCli(argv)
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      error: error instanceof Error ? error.message : 'Local-projection archive failed.',
    })}\n`)
    process.exitCode = 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main()
