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

async function runVitestBinding(binding) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'forge-vnext-a1-contract-'))
  const output = path.join(directory, 'result.json')
  try {
    const requiresPostgres = binding.id === 'a1-vitest-postgres'
    const testFile = requiresPostgres ? '__tests__/vnext-runtime-foundation.postgres.test.ts' : '__tests__/vnext-phase0-conformance.contract.test.ts'
    const result = await run('npx', ['vitest', 'run', testFile, '--retry=0', '--silent=true', '--reporter=json', `--outputFile=${output}`], {
      env: { ...process.env, ...(requiresPostgres ? { FORGE_VNEXT_RUNTIME_REQUIRE_POSTGRES_TEST: '1' } : {}) },
    })
    const report = JSON.parse(await readFile(output, 'utf8'))
    const assertions = report.testResults.flatMap((testResult) => testResult.assertionResults)
    if (assertions.some((assertion) => assertion.status === 'skipped')) throw new Error('A1 static conformance runner rejected skipped scenarios.')
    const taggedAssertions = assertions.filter((assertion) => assertion.fullName.includes('[scenarioId='))
    const actual = taggedAssertions.map(scenarioKey).sort()
    const expected = [...binding.executionKeys].sort()
    if (result.code !== 0 || JSON.stringify(actual) !== JSON.stringify(expected) || assertions.some((assertion) => assertion.status !== 'passed')) {
      throw new Error(`A1 ${binding.id} conformance runner rejected scenario identity or outcome.`)
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

async function runRecoveryBinding(manifest, binding) {
  const proofs = manifest.proofs.filter((proof) => proof.runnerBinding === binding.id)
  const commands = {
    'a1-protected-migration-recovery': {
      command: 'npm run test:vnext-protected-migration-recovery',
      args: ['run', 'test:vnext-protected-migration-recovery'],
      marker: recoveryMarker,
    },
    'a1-controller-sigkill-restart': {
      command: 'npm run test:managed-migration-controller-restart',
      args: ['run', 'test:managed-migration-controller-restart'],
      marker: () => 'VNEXT_A1_CONTROLLER_SIGKILL_RESTART_PASSED',
    },
  }
  const configured = commands[binding.id]
  if (!configured || binding.runner !== 'command' || binding.command !== configured.command || binding.forbidSkipped !== true
    || proofs.length !== binding.executionKeys.length || proofs.some((proof) => proof.scenarioIds.length !== 1)) {
    throw new Error('Invalid executable protected-migration recovery runner binding.')
  }
  await Promise.all(proofs.map((proof) => access(proof.file)))
  const result = await run('npm', configured.args, { env: process.env })
  const output = `${result.stdout}\n${result.stderr}`
  const expectedMarkers = binding.executionKeys.map(configured.marker)
  const actualMarkers = output.split(/\r?\n/).filter((line) => expectedMarkers.includes(line))
  if (result.code !== 0 || /\b(?:skip|skipped)\b/i.test(output)
    || actualMarkers.length !== expectedMarkers.length || expectedMarkers.some((marker) => actualMarkers.filter((actual) => actual === marker).length !== 1)) {
    throw new Error('A1 protected-migration recovery runner rejected execution, skip state, or scenario identity.')
  }
}

async function main() {
  const manifest = JSON.parse(await readFile('test-contracts/vnext-phase0-v1.json', 'utf8'))
  if (!Array.isArray(manifest.runnerBindings) || !Array.isArray(manifest.proofs)) throw new Error('Invalid A1 conformance manifest.')
  const ids = manifest.runnerBindings.map((binding) => binding.id)
  if (new Set(ids).size !== ids.length) throw new Error('A1 conformance manifest has duplicate runner bindings.')
  const runnerById = new Map(manifest.runnerBindings.map((binding) => [binding.id, binding.runner]))
  const proofKeys = manifest.proofs.flatMap((proof) => proof.scenarioIds.map((id) => `${runnerById.get(proof.runnerBinding)}::${id}`))
  if (new Set(proofKeys).size !== proofKeys.length) throw new Error('A1 conformance manifest has duplicate proof scenarios.')
  const bindingFlag = process.argv.indexOf('--binding')
  const requestedBinding = bindingFlag >= 0 ? process.argv[bindingFlag + 1] : undefined
  if (bindingFlag >= 0 && (!requestedBinding || !ids.includes(requestedBinding))) throw new Error('Unknown or missing A1 conformance runner binding selection.')
  const selectedBindings = requestedBinding ? manifest.runnerBindings.filter((binding) => binding.id === requestedBinding) : manifest.runnerBindings
  for (const binding of selectedBindings) {
    const proofs = manifest.proofs.filter((proof) => proof.runnerBinding === binding.id)
    if (!Array.isArray(binding.executionKeys) || proofs.length === 0 || JSON.stringify([...binding.executionKeys].sort()) !== JSON.stringify(proofs.flatMap((proof) => proof.scenarioIds.map((id) => `${binding.runner === 'command' ? 'command' : 'vitest'}::${id}`)).sort())) {
      throw new Error(`A1 conformance manifest has missing, duplicate, or orphan execution keys for ${binding.id}.`)
    }
    if (binding.runner === 'vitest' && binding.forbidSkipped === true) await runVitestBinding(binding)
    else if (binding.runner === 'command') await runRecoveryBinding(manifest, binding)
    else throw new Error(`Unsupported A1 conformance runner binding ${binding.id}.`)
  }
  process.stdout.write('VNEXT_A1_CONFORMANCE_PASSED\n')
}

main().catch((error) => { process.stderr.write(`VNEXT_A1_CONFORMANCE_REJECTED ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1 })
