#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

function scenarioKey(assertion) {
  const matches = assertion.fullName.match(/\[scenarioId=([^\]]+)\]/g) ?? []
  if (matches.length !== 1) throw new Error('Every A1 conformance assertion needs exactly one scenarioId.')
  return `vitest::${matches[0].slice('[scenarioId='.length, -1)}`
}

async function main() {
  const manifest = JSON.parse(await readFile('test-contracts/vnext-phase0-v1.json', 'utf8'))
  const binding = manifest.runnerBindings?.find((candidate) => candidate.id === 'a1-vitest-static')
  if (!binding || binding.runner !== 'vitest' || binding.forbidSkipped !== true || !Array.isArray(binding.executionKeys)) throw new Error('Invalid A1 static conformance runner binding.')
  const directory = await mkdtemp(path.join(os.tmpdir(), 'forge-vnext-a1-contract-'))
  const output = path.join(directory, 'result.json')
  try {
    const child = spawn('npx', ['vitest', 'run', '__tests__/vnext-phase0-conformance.contract.test.ts', '--retry=0', '--silent=true', '--reporter=json', `--outputFile=${output}`], { stdio: 'ignore', env: process.env })
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (value) => resolve(value ?? 1)) })
    const report = JSON.parse(await readFile(output, 'utf8'))
    const assertions = report.testResults.flatMap((result) => result.assertionResults)
    if (assertions.some((assertion) => assertion.status === 'skipped')) throw new Error('A1 conformance runner rejected skipped scenarios.')
    const actual = assertions.map(scenarioKey).sort()
    const expected = [...binding.executionKeys].sort()
    if (code !== 0 || JSON.stringify(actual) !== JSON.stringify(expected) || assertions.some((assertion) => assertion.status !== 'passed')) throw new Error('A1 conformance runner rejected scenario identity or outcome.')
    process.stdout.write('VNEXT_A1_CONFORMANCE_PASSED\n')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

main().catch((error) => { process.stderr.write(`VNEXT_A1_CONFORMANCE_REJECTED ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1 })
