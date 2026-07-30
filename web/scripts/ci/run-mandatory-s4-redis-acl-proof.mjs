import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'

if (process.env.FORGE_S4_REDIS_ACL_TEST_REQUIRED !== '1' || process.env.FORGE_S4_REDIS_ACL_DESTRUCTIVE_TEST !== '1' || !process.env.FORGE_S4_REDIS_ACL_TEST_ADMIN_URL) {
  throw new Error('Mandatory S4 Redis ACL proof requires explicit required, destructive, and dedicated-admin environment values.')
}

const directory = await mkdtemp(join(tmpdir(), 'forge-s4-redis-acl-'))
const reportPath = join(directory, 'vitest.json')
const markers = ['S4_REDIS_ACL_ROLE_ISOLATION_OK', 'S4_REDIS_ACL_DENIALS_OK', 'S4_REDIS_ACL_LEGACY_REVOKED_OK']
try {
  const child = spawn(process.execPath, [resolve('node_modules/vitest/vitest.mjs'), 'run', '__tests__/task-event-redis-acl.redis.test.ts', '--reporter=default', '--reporter=json', `--outputFile=${reportPath}`], { cwd: process.cwd(), env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', (chunk) => { output += String(chunk); process.stdout.write(chunk) })
  child.stderr.on('data', (chunk) => { output += String(chunk); process.stderr.write(chunk) })
  const status = await new Promise((resolveStatus) => child.on('close', resolveStatus))
  if (status !== 0) throw new Error('Mandatory S4 Redis ACL proof command failed.')
  for (const marker of markers) if ((output.match(new RegExp(marker, 'g')) ?? []).length !== 1) throw new Error(`Mandatory S4 Redis ACL marker cardinality failed for ${marker}.`)
  const report = JSON.parse(await readFile(reportPath, 'utf8'))
  if (!Array.isArray(report.testResults) || report.testResults.length !== 1 || report.testResults[0]?.status !== 'passed' || report.testResults[0]?.assertionResults?.length !== 3 || report.numTotalTests !== 3 || report.numPassedTests !== 3 || report.numFailedTests !== 0 || report.numPendingTests !== 0 || report.numTodoTests !== 0 || report.numFailedTestSuites !== 0 || report.numPendingTestSuites !== 0) {
    throw new Error('Mandatory S4 Redis ACL proof must collect exactly one file and exactly three passing tests with no failed, skipped, pending, or todo tests.')
  }
} finally {
  await rm(directory, { recursive: true, force: true })
}
