import '../lib/load-env'
import { parseArgs } from 'node:util'
import type { ProviderConfig } from '../db/schema'
import { listActiveProviders } from '../lib/providers/registry'
import { checkProviderHealth } from '../lib/providers/health'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ProviderTestRow = {
  displayName: string
  providerType: string
  modelId: string
  reachable: boolean
  latencyMs: number | null
  error: string | null
}

// ---------------------------------------------------------------------------
// formatTable
// ---------------------------------------------------------------------------

const COLUMNS = ['PROVIDER', 'TYPE', 'MODEL', 'STATUS', 'LATENCY', 'ERROR'] as const

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

export function formatTable(rows: ProviderTestRow[]): string {
  const cellRows = rows.map((row) => [
    row.displayName,
    row.providerType,
    row.modelId,
    row.reachable ? 'ok' : 'FAIL',
    row.latencyMs !== null ? `${row.latencyMs}ms` : '-',
    row.error ? truncate(row.error, 60) : '-',
  ])

  const widths = COLUMNS.map((header, i) =>
    Math.max(header.length, ...cellRows.map((cells) => cells[i].length)),
  )

  function formatRow(cells: readonly string[]): string {
    return cells.map((cell, i) => cell.padEnd(widths[i])).join('  ').trimEnd()
  }

  const lines = [formatRow(COLUMNS), ...cellRows.map((cells) => formatRow(cells))]
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// summarize
// ---------------------------------------------------------------------------

export function summarize(rows: ProviderTestRow[]): { checked: number; failed: number; allPassed: boolean } {
  const checked = rows.length
  const failed = rows.filter((row) => !row.reachable).length
  return { checked, failed, allPassed: failed === 0 }
}

// ---------------------------------------------------------------------------
// filterProvidersByArg
// ---------------------------------------------------------------------------

export function filterProvidersByArg(
  providers: ProviderConfig[],
  arg: string | undefined,
): ProviderConfig[] {
  if (arg === undefined) return providers

  const lowerArg = arg.toLowerCase()
  return providers.filter((p) => p.id === arg || p.displayName.toLowerCase() === lowerArg)
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function printUsage(): void {
  console.info('Usage: tsx scripts/test-providers.ts [--provider <id-or-displayName>] [--help]')
  console.info('')
  console.info('Runs the same low-cost health probe used by the Providers page against active providers.')
  console.info('Exits non-zero if any checked provider fails (suitable for CI).')
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      provider: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  })

  if (values.help) {
    printUsage()
    process.exit(0)
  }

  const { closeDb } = await import('../db')
  const { redis } = await import('../lib/redis')

  let failed = false

  try {
    const activeProviders = await listActiveProviders()
    const filtered = filterProvidersByArg(activeProviders, values.provider)

    if (values.provider !== undefined && filtered.length === 0) {
      console.error(`No active provider found matching "${values.provider}".`)
      failed = true
      return
    }

    if (values.provider === undefined && activeProviders.length === 0) {
      console.info('No active providers configured.')
      return
    }

    const rows: ProviderTestRow[] = await Promise.all(
      filtered.map(async (config): Promise<ProviderTestRow> => {
        const health = await checkProviderHealth(config)
        return {
          displayName: config.displayName,
          providerType: config.providerType,
          modelId: config.modelId,
          reachable: health.reachable,
          latencyMs: health.latencyMs,
          error: health.error,
        }
      }),
    )

    console.info(formatTable(rows))

    const summary = summarize(rows)
    console.info(`${summary.checked} providers checked, ${summary.failed} failed.`)

    failed = !summary.allPassed
  } finally {
    await closeDb().catch(() => {})
    redis.disconnect()
  }

  process.exit(failed ? 1 : 0)
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
