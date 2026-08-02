import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'

const required = process.env.FORGE_S4_REQUIRE_REDIS_TEST === '1'
const destructive = process.env.FORGE_S4_REDIS_DESTRUCTIVE_TEST === '1'
const redisUrl = process.env.FORGE_S4_REDIS_TEST_URL
if (!required || !destructive || !redisUrl) {
  throw new Error('Mandatory S4 Redis proof requires FORGE_S4_REQUIRE_REDIS_TEST=1, FORGE_S4_REDIS_DESTRUCTIVE_TEST=1, and FORGE_S4_REDIS_TEST_URL.')
}

const reportDirectory = await mkdtemp(join(tmpdir(), 'forge-s4-redis-proof-'))
const reportPath = join(reportDirectory, 'vitest.json')
const markers = ['S4_SCRUB_REDIS_START', 'S4_SCRUB_REDIS_PURGE_RETRY_OK', 'S4_SCRUB_REDIS_V2_IMMUTABLE_OK']

try {
  const child = spawn(process.execPath, [
    resolve('node_modules/vitest/vitest.mjs'), 'run', '__tests__/legacy-leakage-scrub.redis.test.ts',
    '--reporter=default', '--reporter=json', `--outputFile=${reportPath}`,
  ], { cwd: process.cwd(), env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', (chunk) => { output += String(chunk); process.stdout.write(chunk) })
  child.stderr.on('data', (chunk) => { output += String(chunk); process.stderr.write(chunk) })
  const status = await new Promise((resolveStatus) => child.on('close', resolveStatus))
  if (status !== 0) throw new Error('Mandatory S4 Redis proof command failed.')
  for (const marker of markers) {
    if ((output.match(new RegExp(marker, 'g')) ?? []).length !== 1) {
      throw new Error(`Mandatory S4 Redis proof marker cardinality failed for ${marker}.`)
    }
  }
  const report = JSON.parse(await readFile(reportPath, 'utf8'))
  if (
    !Array.isArray(report.testResults)
    || report.testResults.length !== 1
    || report.testResults[0]?.status !== 'passed'
    || report.testResults[0]?.assertionResults?.length !== 3
    || report.numFailedTestSuites !== 0
    || report.numPendingTestSuites !== 0
    || report.numTotalTests !== 3
    || report.numPassedTests !== 3
    || report.numFailedTests !== 0
    || report.numPendingTests !== 0
    || report.numTodoTests !== 0
  ) {
    throw new Error('Mandatory S4 Redis proof must collect exactly one file and exactly three passing tests with no failed, skipped, pending, or todo tests.')
  }
} finally {
  await rm(reportDirectory, { recursive: true, force: true })
}
