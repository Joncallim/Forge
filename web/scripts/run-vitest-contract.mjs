#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

function parseArgs(argv) {
  const separator = argv.indexOf('--')
  if (separator < 0) throw new Error('The Vitest contract wrapper requires -- before Vitest arguments.')
  const own = argv.slice(0, separator)
  const command = argv.slice(separator + 1)
  const result = { command }
  for (let index = 0; index < own.length; index += 2) {
    const key = own[index]
    const value = own[index + 1]
    if (!['--manifest', '--partition'].includes(key) || !value) throw new Error('Invalid Vitest contract wrapper arguments.')
    result[key.slice(2)] = value
  }
  if (!result.manifest || result.partition !== 'contract') throw new Error('Vitest wrapper accepts only the contract partition.')
  if (command.length === 0) throw new Error('Vitest command is required.')
  return result
}

function expectedFromManifest(value) {
  if (!value || typeof value !== 'object' || value.schemaVersion !== 2 || value.contractVersion !== 'mcp-admission-v2' || !Array.isArray(value.partitions)) {
    throw new Error('Invalid MCP admission suite manifest.')
  }
  const partition = value.partitions.find((candidate) => candidate.id === 'contract')
  if (!partition || partition.runner !== 'vitest' || !Array.isArray(partition.executionKeys) || partition.executionKeys.length !== partition.expectedCount || partition.expectedCount <= 0) {
    throw new Error('Invalid Vitest contract partition.')
  }
  return [...partition.executionKeys].sort()
}

function executionKey(assertion) {
  const matches = assertion.fullName.match(/\[scenarioId=([^\]]+)\]/g) ?? []
  if (matches.length !== 1) throw new Error('Every manifest-bound Vitest test needs one scenarioId marker.')
  return `vitest::${matches[0].slice('[scenarioId='.length, -1)}`
}

function hasScenarioId(assertion) {
  return /\[scenarioId=[^\]]+\]/.test(assertion.fullName)
}

// The output-quarantine contract permits fixed schema-free status codes and
// canonical scenario IDs on the live runner channel, but never child bytes.
const CANONICAL_EXECUTION_KEY = /^vitest::[a-z0-9][a-z0-9.-]*$/

function rejection(code, detail) {
  const error = new Error(code)
  error.reasonCode = code
  if (detail) error.reasonDetail = detail
  return error
}

function identityDetail(expected, actual) {
  const expectedSet = new Set(expected)
  const actualSet = new Set(actual)
  const missing = expected.filter((key) => !actualSet.has(key))
  const unexpected = actual
    .filter((key) => !expectedSet.has(key))
    .filter((key) => typeof key === 'string' && CANONICAL_EXECUTION_KEY.test(key))
  const parts = []
  if (missing.length) parts.push(`missing=${missing.join(',')}`)
  if (unexpected.length) parts.push(`unexpected=${unexpected.join(',')}`)
  const suppressed = actual.filter((key) => !expectedSet.has(key)).length - unexpected.length
  if (suppressed > 0) parts.push(`unexpected_suppressed=${suppressed}`)
  return parts.join(' ')
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const expected = expectedFromManifest(JSON.parse(await readFile(args.manifest, 'utf8')))
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'forge-mcp-vitest-contract-'))
  const resultFile = path.join(temporaryDirectory, 'result.json')
  try {
    const [command, ...commandArgs] = args.command
    if (commandArgs.some((argument) => argument === '--retry' || argument.startsWith('--retry='))) {
      throw rejection('retry_override_forbidden')
    }
    const child = spawn(command, [
      ...commandArgs,
      '--retry=0',
      '--silent=true',
      '--reporter=json',
      `--outputFile=${resultFile}`,
    ], { stdio: ['ignore', 'ignore', 'ignore'], env: process.env })
    const exitCode = await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', (code) => resolve(code ?? 1))
    })
    const report = JSON.parse(await readFile(resultFile, 'utf8'))
    const assertions = report.testResults.flatMap((result) => result.assertionResults)
    if (assertions.some((assertion) => !hasScenarioId(assertion) && assertion.status !== 'skipped')) {
      throw rejection('unmanifested_test_executed')
    }
    const manifestAssertions = assertions.filter(hasScenarioId)
    const executed = manifestAssertions.map(executionKey).sort()
    if (expected.length !== executed.length || expected.some((key, index) => key !== executed[index])) {
      throw rejection('executed_identity_mismatch', identityDetail(expected, executed))
    }
    if (manifestAssertions.some((assertion) => assertion.status !== 'passed') || exitCode !== 0) {
      throw rejection('scenario_failed_or_skipped')
    }
    process.stdout.write('MCP_VITEST_CONTRACT_PASSED\n')
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true })
  }
}

main().catch((error) => {
  const code = typeof error?.reasonCode === 'string' ? error.reasonCode : 'wrapper_error'
  const detail = typeof error?.reasonDetail === 'string' && error.reasonDetail ? ` ${error.reasonDetail}` : ''
  process.stderr.write(`MCP_VITEST_CONTRACT_REJECTED reason=${code}${detail}\n`)
  process.exitCode = 1
})
