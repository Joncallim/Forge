#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

const PARTITIONS = new Set(['postgres', 'issuance', 'operator-desktop', 'operator-mobile', 'host-boundary'])
const MANIFEST_PARTITIONS = Object.freeze({
  contract: { runner: 'vitest', prefix: 'vitest::' },
  'host-boundary': { runner: 'playwright', prefix: 'mcp-host-boundary::' },
  issuance: { runner: 'playwright', prefix: 'mcp-issuance::' },
  'operator-desktop': { runner: 'playwright', prefix: 'mcp-operator-desktop::' },
  'operator-mobile': { runner: 'playwright', prefix: 'mcp-operator-mobile::' },
  postgres: { runner: 'playwright', prefix: 'mcp-postgres::' },
})

function parseArgs(argv) {
  const separator = argv.indexOf('--')
  if (separator < 0) throw new Error('The Playwright contract wrapper requires -- before Playwright arguments.')
  const own = argv.slice(0, separator)
  const playwright = argv.slice(separator + 1)
  const result = { partitions: [], playwright, forbidRetries: false, forbidSkips: false, requireAttestationSignature: false }
  for (let index = 0; index < own.length; index += 1) {
    const key = own[index]
    if (key === '--forbid-retries') result.forbidRetries = true
    else if (key === '--forbid-skips') result.forbidSkips = true
    else if (key === '--require-attestation-signature') result.requireAttestationSignature = true
    else if (key === '--partition') result.partitions.push(own[++index])
    else if (['--manifest', '--preflight-attestation', '--attestation-public-key'].includes(key)) result[key.slice(2)] = own[++index]
    else throw new Error(`Unsupported contract wrapper argument: ${key}.`)
  }
  if (!result.manifest || result.partitions.length === 0) throw new Error('Manifest and partition are required.')
  if (result.partitions.some((partition) => !PARTITIONS.has(partition))) throw new Error('Unsupported Playwright partition.')
  if (new Set(result.partitions).size !== result.partitions.length) throw new Error('Duplicate Playwright partition.')
  return result
}

function parseManifest(value, requestedPartitions) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.schemaVersion !== 2 || value.contractVersion !== 'mcp-admission-v2') {
    throw new Error('Invalid MCP admission suite manifest.')
  }
  if (Object.keys(value).sort().join('\n') !== ['contractVersion', 'partitions', 'schemaVersion'].join('\n')) {
    throw new Error('Suite manifest has an unexpected field.')
  }
  if (!Array.isArray(value.partitions) || value.partitions.length !== 6) throw new Error('Suite manifest must have six partitions.')
  const manifestIds = value.partitions.map((partition) => partition?.id).sort()
  const expectedIds = Object.keys(MANIFEST_PARTITIONS).sort()
  if (manifestIds.some((id, index) => id !== expectedIds[index])) throw new Error('Suite manifest partition set is invalid.')
  const allKeys = []
  for (const partition of value.partitions) {
    const contract = MANIFEST_PARTITIONS[partition.id]
    const keys = Object.keys(partition).sort()
    if (
      keys.join('\n') !== ['executionKeys', 'expectedCount', 'id', 'runner'].join('\n')
      || partition.runner !== contract.runner
      || !Number.isSafeInteger(partition.expectedCount)
      || partition.expectedCount <= 0
      || !Array.isArray(partition.executionKeys)
      || partition.executionKeys.length !== partition.expectedCount
      || partition.executionKeys.some((key) => (
        typeof key !== 'string'
        || !key.startsWith(contract.prefix)
        || key.includes('*')
        || key.includes('?')
      ))
      || partition.executionKeys.some((key, index) => key !== [...partition.executionKeys].sort()[index])
      || new Set(partition.executionKeys).size !== partition.executionKeys.length
    ) throw new Error(`Invalid ${partition.id} partition contract.`)
    allKeys.push(...partition.executionKeys)
  }
  if (new Set(allKeys).size !== allKeys.length) throw new Error('Duplicate execution key across manifest partitions.')
  const selected = value.partitions.filter((partition) => requestedPartitions.includes(partition.id))
  if (selected.length !== requestedPartitions.length) throw new Error('Requested partition is missing from the suite manifest.')
  for (const partition of selected) {
    if (partition.runner !== 'playwright') {
      throw new Error('Invalid Playwright partition contract.')
    }
  }
  const expected = selected.flatMap((partition) => partition.executionKeys).sort()
  if (new Set(expected).size !== expected.length) throw new Error('Duplicate expected execution key.')
  return expected
}

function sameArray(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const manifest = JSON.parse(await readFile(args.manifest, 'utf8'))
  const expected = parseManifest(manifest, args.partitions)
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'forge-mcp-contract-'))
  const resultFile = path.join(temporaryDirectory, 'result.json')
  try {
    const environment = {
      ...process.env,
      FORGE_MCP_CONTRACT_RESULT_FILE: resultFile,
    }
    if (args.partitions.includes('host-boundary')) {
      if (!args.requireAttestationSignature || !args['preflight-attestation'] || !args['attestation-public-key']) {
        throw new Error('Host-boundary execution requires its preflight attestation and public key.')
      }
      environment.FORGE_TRUSTED_HOST_BOUNDARY = '1'
      environment.FORGE_HOST_BOUNDARY_PREFLIGHT_ATTESTATION = args['preflight-attestation']
      environment.FORGE_HOST_BOUNDARY_ATTESTATION_PUBLIC_KEY = args['attestation-public-key']
    }
    const reporter = path.resolve('scripts/mcp-playwright-contract-reporter.mjs')
    const child = spawn('npx', ['playwright', 'test', ...args.playwright, `--reporter=${reporter}`], {
      env: environment,
      stdio: ['ignore', 'ignore', 'ignore'],
    })
    const exitCode = await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', (code) => resolve(code ?? 1))
    })
    const report = JSON.parse(await readFile(resultFile, 'utf8'))
    const collected = [...report.collected].sort()
    const executed = report.executed.map((entry) => entry.executionKey).sort()
    if (!sameArray(expected, collected) || !sameArray(expected, executed)) throw new Error('Manifest execution identity mismatch.')
    if (args.forbidRetries && report.executed.some((entry) => entry.retry !== 0)) throw new Error('A required scenario retried.')
    if (args.forbidSkips && report.executed.some((entry) => entry.status === 'skipped')) throw new Error('A required scenario skipped.')
    if (report.executed.some((entry) => entry.status !== 'passed') || exitCode !== 0) throw new Error('A required scenario failed.')
    process.stdout.write('MCP_PLAYWRIGHT_CONTRACT_PASSED\n')
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true })
  }
}

main().catch((error) => {
  void error
  process.stderr.write('MCP_PLAYWRIGHT_CONTRACT_REJECTED\n')
  process.exitCode = 1
})
