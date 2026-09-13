#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

function scenarioKey(assertion) {
  const matches = assertion.fullName.match(/\[scenarioId=([^\]]+)\]/g) ?? []
  if (matches.length !== 1) throw new Error('Every A1 static conformance assertion needs exactly one scenarioId.')
  return `vitest::${matches[0].slice('[scenarioId='.length, -1)}`
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.once('error', reject)
    child.once('exit', (code) => resolve({ code: code ?? 1, stdout, stderr }))
  })
}

function recoveryMarker(executionKey) {
  const scenario = executionKey.replace('command::vnext.a1.', '').replaceAll('-', '_').toUpperCase()
  return `VNEXT_A1_PROTECTED_${scenario.replace('PROTECTED_', '')}_PASSED`
}

async function runStaticBinding(binding) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'forge-vnext-a1-contract-'))
  const output = path.join(directory, 'result.json')
  try {
    const result = await run('npx', ['vitest', 'run', '__tests__/vnext-phase0-conformance.contract.test.ts', '--retry=0', '--silent=true', '--reporter=json', `--outputFile=${output}`], { env: process.env })
    const report = JSON.parse(await readFile(output, 'utf8'))
    const assertions = report.testResults.flatMap((testResult) => testResult.assertionResults)
    if (assertions.some((assertion) => assertion.status === 'skipped')) throw new Error('A1 static conformance runner rejected skipped scenarios.')
    const actual = assertions.map(scenarioKey).sort()
    const expected = [...binding.executionKeys].sort()
    if (result.code !== 0 || JSON.stringify(actual) !== JSON.stringify(expected) || assertions.some((assertion) => assertion.status !== 'passed')) {
      throw new Error('A1 static conformance runner rejected scenario identity or outcome.')
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

async function runRecoveryBinding(manifest, binding) {
  const proofs = manifest.proofs.filter((proof) => proof.runnerBinding === binding.id)
  if (binding.runner !== 'command' || binding.command !== 'npm run test:vnext-protected-migration-recovery' || binding.forbidSkipped !== true
    || proofs.length !== binding.executionKeys.length || proofs.some((proof) => proof.scenarioIds.length !== 1)) {
    throw new Error('Invalid executable protected-migration recovery runner binding.')
  }
  await Promise.all(proofs.map((proof) => access(proof.file)))
  const result = await run('npm', ['run', 'test:vnext-protected-migration-recovery'], { env: process.env })
  const output = `${result.stdout}\n${result.stderr}`
  const expectedMarkers = binding.executionKeys.map(recoveryMarker)
  const actualMarkers = output.split(/\r?\n/).filter((line) => expectedMarkers.includes(line))
  if (result.code !== 0 || /\b(?:skip|skipped)\b/i.test(output)
    || actualMarkers.length !== expectedMarkers.length || expectedMarkers.some((marker) => actualMarkers.filter((actual) => actual === marker).length !== 1)) {
    throw new Error('A1 protected-migration recovery runner rejected execution, skip state, or scenario identity.')
  }
}

async function main() {
  const manifest = JSON.parse(await readFile('test-contracts/vnext-phase0-v1.json', 'utf8'))
  const staticBinding = manifest.runnerBindings?.find((candidate) => candidate.id === 'a1-vitest-static')
  const recoveryBinding = manifest.runnerBindings?.find((candidate) => candidate.id === 'a1-protected-migration-recovery')
  if (!staticBinding || staticBinding.runner !== 'vitest' || staticBinding.forbidSkipped !== true || !Array.isArray(staticBinding.executionKeys)) {
    throw new Error('Invalid A1 static conformance runner binding.')
  }
  if (!recoveryBinding || !Array.isArray(recoveryBinding.executionKeys)) throw new Error('Missing A1 executable protected-migration recovery runner binding.')
  await runStaticBinding(staticBinding)
  await runRecoveryBinding(manifest, recoveryBinding)
  process.stdout.write('VNEXT_A1_CONFORMANCE_PASSED\n')
}

main().catch((error) => { process.stderr.write(`VNEXT_A1_CONFORMANCE_REJECTED ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1 })
