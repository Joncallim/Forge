#!/usr/bin/env node

import { randomUUID } from 'node:crypto'
import net from 'node:net'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import process from 'node:process'

const SOCKET = '/run/forge-host-boundary-controller/control.sock'
const MAX_RESPONSE_BYTES = 16 * 1024
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const SAFE_ARGUMENT = /^\S{1,256}$/
const SHA = /^[a-f0-9]{40}$|^[a-f0-9]{64}$/
const FINGERPRINT = /^sha256:[a-f0-9]{64}$/
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

function parseOptions(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    if (key === '--apply' || key === '--discard') {
      if (key in options) throw new Error('Duplicate controller option.')
      options[key] = true
      continue
    }
    if (!key?.startsWith('--') || index + 1 >= argv.length || argv[index + 1].startsWith('--')) {
      throw new Error('Invalid controller option.')
    }
    if (key in options) throw new Error('Duplicate controller option.')
    options[key] = argv[++index]
  }
  return options
}

function exactOptions(options, required, flags = []) {
  const expected = [...required, ...flags].sort()
  const actual = Object.keys(options).sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error('Controller command options do not match the supported interface.')
  }
  for (const key of required) {
    if (typeof options[key] !== 'string' || !SAFE_ARGUMENT.test(options[key])) {
      throw new Error('Controller command contains an invalid identifier.')
    }
  }
}

function buildRequest(operation, options) {
  const requestId = randomUUID()
  if (operation === 'inspect') {
    exactOptions(options, ['--run', '--sha'])
    if (!OPAQUE_ID.test(options['--run']) || !SHA.test(options['--sha'])) throw new Error('Reviewed SHA is invalid.')
    return { schemaVersion: 2, requestId, operation: 'inspect_controller_run', runId: options['--run'], reviewedSha: options['--sha'] }
  }
  if (operation === 'verify-ruleset') {
    exactOptions(options, ['--app-id', '--check', '--repository'])
    if (!/^[1-9]\d{0,19}$/.test(options['--app-id']) || !REPOSITORY.test(options['--repository']) || options['--check'] !== 'forge/host-boundary-controller') {
      throw new Error('Ruleset verification binding is invalid.')
    }
    return { schemaVersion: 2, requestId, operation: 'verify_exact_app_ruleset', appId: options['--app-id'], checkName: options['--check'], repository: options['--repository'] }
  }
  if (operation === 'retry') {
    exactOptions(options, ['--actor', '--expected-state', '--run', '--sha'], ['--apply'])
    if (!OPAQUE_ID.test(options['--run']) || !OPAQUE_ID.test(options['--actor']) || !SHA.test(options['--sha']) || !['failed', 'timed_out'].includes(options['--expected-state'])) {
      throw new Error('Retry binding is invalid.')
    }
    return { schemaVersion: 2, requestId, operation: 'retry_failed_controller_check', actorId: options['--actor'], expectedState: options['--expected-state'], reviewedSha: options['--sha'], runId: options['--run'] }
  }
  if (operation === 'rotate-key') {
    if ('--rotation' in options) {
      exactOptions(options, ['--actor', '--rotation'], ['--apply', '--discard'])
      if (!OPAQUE_ID.test(options['--actor']) || !OPAQUE_ID.test(options['--rotation'])) throw new Error('Rotation binding is invalid.')
      return { schemaVersion: 2, requestId, operation: 'discard_pending_controller_key', actorId: options['--actor'], rotationId: options['--rotation'] }
    }
    const flags = options['--apply'] ? ['--apply'] : []
    exactOptions(options, ['--actor', '--pending-key-ref'], flags)
    if (!OPAQUE_ID.test(options['--actor']) || !OPAQUE_ID.test(options['--pending-key-ref'])) throw new Error('Rotation binding is invalid.')
    return {
      schemaVersion: 2,
      requestId,
      operation: options['--apply'] ? 'apply_controller_key_rotation' : 'inspect_controller_key_rotation_plan',
      actorId: options['--actor'],
      pendingKeyRef: options['--pending-key-ref'],
    }
  }
  if (operation === 'inspect-key-rotation') {
    exactOptions(options, ['--rotation'])
    if (!OPAQUE_ID.test(options['--rotation'])) throw new Error('Rotation binding is invalid.')
    return { schemaVersion: 2, requestId, operation: 'inspect_controller_key_rotation', rotationId: options['--rotation'] }
  }
  throw new Error('Unsupported external controller operation.')
}

export function buildHostBoundaryControllerRequest(operation, argv) {
  return buildRequest(operation, parseOptions(argv))
}

export function validateHostBoundaryControllerResponse(value, request) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Controller response is invalid.')
  const keys = Object.keys(value).sort()
  const expected = ['disposition', 'facts', 'messageCode', 'operation', 'requestId', 'schemaVersion'].sort()
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error('Controller response has an unexpected field.')
  }
  if (
    value.schemaVersion !== 2
    || value.requestId !== request.requestId
    || value.operation !== request.operation
    || !['accepted', 'blocked', 'no_change'].includes(value.disposition)
    || typeof value.messageCode !== 'string'
    || !/^[a-z][a-z0-9_]{0,63}$/.test(value.messageCode)
  ) {
    throw new Error('Controller response binding is invalid.')
  }
  if (!value.facts || typeof value.facts !== 'object' || Array.isArray(value.facts)) {
    throw new Error('Controller response facts are invalid.')
  }
  const factKeys = Object.keys(value.facts).sort()
  const expectedFactKeys = [
    'appId',
    'keyGeneration',
    'reviewedSha',
    'rotationId',
    'rulesetFingerprint',
    'runId',
    'sourceRunId',
    'sourceState',
    'state',
  ].sort()
  if (factKeys.length !== expectedFactKeys.length || factKeys.some((key, index) => key !== expectedFactKeys[index])) {
    throw new Error('Controller response facts have an unexpected field.')
  }
  if (
    !['disabled', 'pending', 'failed', 'timed_out', 'succeeded', 'rotation_pending', 'rotation_blocked'].includes(value.facts.state)
    || ![value.facts.rotationId, value.facts.runId, value.facts.sourceRunId]
      .every((fact) => fact === null || (typeof fact === 'string' && OPAQUE_ID.test(fact)))
    || !(value.facts.appId === null || (typeof value.facts.appId === 'string' && /^[1-9]\d{0,19}$/.test(value.facts.appId)))
    || !(value.facts.rulesetFingerprint === null || (
      typeof value.facts.rulesetFingerprint === 'string' && FINGERPRINT.test(value.facts.rulesetFingerprint)
    ))
    || !(value.facts.sourceState === null || ['failed', 'timed_out'].includes(value.facts.sourceState))
    || !(value.facts.reviewedSha === null || (typeof value.facts.reviewedSha === 'string' && SHA.test(value.facts.reviewedSha)))
    || !(value.facts.keyGeneration === null || (Number.isSafeInteger(value.facts.keyGeneration) && value.facts.keyGeneration > 0))
  ) {
    throw new Error('Controller response facts are invalid.')
  }
  if (request.operation === 'retry_failed_controller_check') {
    if (
      value.facts.sourceRunId !== request.runId
      || value.facts.sourceState !== request.expectedState
      || value.facts.reviewedSha !== request.reviewedSha
      || (value.disposition === 'accepted' && (
        value.facts.state !== 'pending'
        || value.facts.runId === null
        || value.facts.runId === request.runId
      ))
    ) {
      throw new Error('Controller retry response did not bind a fresh operation.')
    }
  } else {
    if (value.facts.sourceRunId !== null) throw new Error('Controller response has an unexpected source run.')
    if (value.facts.sourceState !== null) throw new Error('Controller response has an unexpected source state.')
    if (request.runId && value.facts.runId !== request.runId) throw new Error('Controller response run binding is invalid.')
  }
  if (request.reviewedSha && value.facts.reviewedSha !== request.reviewedSha) throw new Error('Controller response SHA binding is invalid.')
  if (request.appId && value.facts.appId !== request.appId) throw new Error('Controller response App binding is invalid.')
  if (request.rotationId && value.facts.rotationId !== request.rotationId) throw new Error('Controller response rotation binding is invalid.')
  if (
    request.operation === 'verify_exact_app_ruleset'
    && (value.disposition !== 'accepted' || value.facts.rulesetFingerprint === null)
  ) {
    throw new Error('Controller ruleset verification did not prove the exact App binding.')
  }
  return value
}

function callController(request) {
  if (!path.isAbsolute(SOCKET)) throw new Error('Controller socket must be absolute.')
  const bytes = Buffer.from(`${JSON.stringify(request)}\n`, 'utf8')
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: SOCKET })
    const chunks = []
    let byteCount = 0
    let settled = false
    const finish = (error, value) => {
      if (settled) return
      settled = true
      socket.destroy()
      if (error) reject(error)
      else resolve(value)
    }
    socket.setTimeout(10_000)
    socket.once('connect', () => socket.end(bytes))
    socket.on('data', (chunk) => {
      byteCount += chunk.length
      if (byteCount > MAX_RESPONSE_BYTES) finish(new Error('Controller response is too large.'))
      else chunks.push(chunk)
    })
    socket.once('timeout', () => finish(new Error('Controller request timed out.')))
    socket.once('error', () => finish(new Error('Controller request failed.')))
    socket.once('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim()
      if (!raw || raw.includes('\n')) return finish(new Error('Controller response is invalid.'))
      try {
        finish(undefined, JSON.parse(raw))
      } catch {
        finish(new Error('Controller response is invalid.'))
      }
    })
  })
}

async function main() {
  const [operation, ...argv] = process.argv.slice(2)
  if (!operation) throw new Error('A controller operation is required.')
  const request = buildHostBoundaryControllerRequest(operation, argv)
  const response = validateHostBoundaryControllerResponse(await callController(request), request)
  process.stdout.write(`${JSON.stringify(response)}\n`)
  if (response.disposition === 'blocked') process.exitCode = 2
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    void error
    process.stderr.write('HOST_BOUNDARY_CONTROLLER_REQUEST_REJECTED\n')
    process.exitCode = 1
  })
}
