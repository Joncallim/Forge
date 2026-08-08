import '../lib/load-env'
import { parseArgs } from 'node:util'
import { pathToFileURL } from 'node:url'

import { and, eq } from 'drizzle-orm'

import { db } from '../db'
import { capabilityAttempts } from '../db/schema'
import { readCohortReliability } from '../worker/reliability/reader'
import type { ReliabilitySummary } from '../lib/reliability/contracts'

export function inspectCapabilityReliabilityUsage(): string {
  return `Inspect capability reliability cohorts for a project (read-only)

Usage:
  npm run protocol:inspect-capability-reliability -- --project <uuid> [--capability <key>] [--json]

Options:
  --project     Project id (required)
  --capability  Restrict to one capability key (e.g. workpackage:backend/api-implementation)
  --json        Print machine-readable JSON instead of a table

This command performs no writes. It reports what evidence exists so far; a
missing or small sample is reported as "not enough evidence yet", never as a
passing or failing grade.`
}

export function parseInspectCapabilityReliabilityArgs(argv: string[]): {
  projectId: string
  capability: string | null
  json: boolean
} {
  const { values } = parseArgs({
    args: argv,
    options: {
      project: { type: 'string' },
      capability: { type: 'string' },
      json: { type: 'boolean', default: false },
    },
  })
  if (!values.project) throw new Error('--project <uuid> is required.')
  return { projectId: values.project, capability: values.capability ?? null, json: Boolean(values.json) }
}

async function loadCohortsForProject(projectId: string, capability: string | null): Promise<Array<{
  cohortFingerprint: string
  capabilityKey: string
}>> {
  const rows = await db
    .selectDistinct({
      cohortFingerprint: capabilityAttempts.cohortFingerprint,
      capabilityKey: capabilityAttempts.capabilityKey,
    })
    .from(capabilityAttempts)
    .where(
      capability
        ? and(eq(capabilityAttempts.projectId, projectId), eq(capabilityAttempts.capabilityKey, capability))
        : eq(capabilityAttempts.projectId, projectId),
    )
  return rows
}

function describeState(summary: ReliabilitySummary): string {
  if (summary.state === 'insufficient_evidence') {
    return `not enough evidence yet (${summary.sampleCount} attempt${summary.sampleCount === 1 ? '' : 's'} recorded)`
  }
  if (summary.state === 'evidence_drift') {
    return 'evidence has drifted since it was recorded; rates withheld'
  }
  const verified = summary.rates.independentlyVerifiedPass
  const verifiedText = verified === null ? 'no independently verified attempts yet' : `${(verified * 100).toFixed(0)}% independently verified pass rate`
  return `${summary.sampleCount} attempts in window, ${verifiedText}`
}

export async function inspectCapabilityReliability(input: {
  projectId: string
  capability: string | null
}): Promise<Array<{ capabilityKey: string; summary: ReliabilitySummary }>> {
  const cohorts = await loadCohortsForProject(input.projectId, input.capability)
  const results: Array<{ capabilityKey: string; summary: ReliabilitySummary }> = []
  for (const cohort of cohorts) {
    const summary = await readCohortReliability({ cohortFingerprint: cohort.cohortFingerprint })
    results.push({ capabilityKey: cohort.capabilityKey, summary })
  }
  return results
}

async function main(): Promise<void> {
  const args = parseInspectCapabilityReliabilityArgs(process.argv.slice(2))
  const results = await inspectCapabilityReliability(args)
  if (args.json) {
    console.log(JSON.stringify(results, null, 2))
    return
  }
  if (results.length === 0) {
    console.log('No capability reliability evidence recorded for this project yet.')
    return
  }
  for (const { capabilityKey, summary } of results) {
    console.log(`${capabilityKey}`)
    console.log(`  state: ${summary.state}`)
    console.log(`  ${describeState(summary)}`)
    console.log(`  critical failures: ${summary.criticalFailureCount}${summary.lastCriticalAt ? ` (last ${summary.lastCriticalAt})` : ''}`)
    console.log('')
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err))
    process.exitCode = 1
  })
}
