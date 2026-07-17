#!/usr/bin/env node

import { mkdir, open, readFile } from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import process from 'node:process'
import {
  HOST_BOUNDARY_MAX_ENVELOPE_BYTES,
  createFixedHostBoundaryRequest,
  verifyHostBoundaryAttestation,
} from './lib/mcp-host-boundary-attestation.mjs'

const FIXED_PREFLIGHT_PATHS = Object.freeze({
  '--harness-socket': '/run/forge-host-boundary/attest.sock',
  '--controller-challenge': '/run/forge-host-boundary/controller-challenge.json',
  '--public-key': '/usr/share/forge-host-boundary/attestation.pub',
  '--signed-envelope-out': path.resolve(process.cwd(), '.artifacts/mcp-host-boundary-preflight.signed.json'),
})

function parseArgs(argv) {
  const allowed = new Set(['--harness-socket', '--controller-challenge', '--public-key', '--signed-envelope-out'])
  const result = {}
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!allowed.has(key) || typeof value !== 'string' || value.length === 0 || value.startsWith('--')) {
      throw new Error('Expected exact host-boundary preflight arguments.')
    }
    if (key in result) throw new Error(`Duplicate argument: ${key}.`)
    result[key] = value
  }
  for (const key of allowed) {
    if (!(key in result)) throw new Error(`Missing required argument: ${key}.`)
  }
  return result
}

async function readJsonFile(filePath, label, maxBytes = HOST_BOUNDARY_MAX_ENVELOPE_BYTES) {
  const bytes = await readFile(filePath)
  if (bytes.length === 0 || bytes.length > maxBytes) throw new Error(`${label} size is invalid.`)
  let value
  try {
    value = JSON.parse(bytes.toString('utf8'))
  } catch {
    throw new Error(`${label} is not valid JSON.`)
  }
  return value
}

function requestAttestation(socketPath, request) {
  if (!path.isAbsolute(socketPath)) throw new Error('The root-harness socket path must be absolute.')
  const requestBytes = Buffer.from(`${JSON.stringify(request)}\n`, 'utf8')
  if (requestBytes.length > 16 * 1024) throw new Error('Controller challenge request is too large.')

  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath })
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
    socket.setTimeout(5_000)
    socket.once('connect', () => socket.end(requestBytes))
    socket.on('data', (chunk) => {
      byteCount += chunk.length
      if (byteCount > HOST_BOUNDARY_MAX_ENVELOPE_BYTES) {
        finish(new Error('Root-harness response exceeded the fixed size limit.'))
        return
      }
      chunks.push(chunk)
    })
    socket.once('timeout', () => finish(new Error('Root-harness response timed out.')))
    socket.once('error', (error) => finish(new Error(`Root-harness socket failed: ${error.code ?? 'unknown'}.`)))
    socket.once('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim()
      if (raw.length === 0 || raw.includes('\n')) {
        finish(new Error('Root-harness response must be one JSON envelope.'))
        return
      }
      try {
        finish(null, JSON.parse(raw))
      } catch {
        finish(new Error('Root-harness response is not valid JSON.'))
      }
    })
  })
}

async function writeFirstAttemptEnvelope(filePath, envelope) {
  const absolute = path.resolve(filePath)
  const parent = path.dirname(absolute)
  let handle
  try {
    await mkdir(parent, { recursive: true, mode: 0o700 })
    // A trusted run is first-attempt-only. Refuse to replace an earlier envelope;
    // replay or stale residue must stop the run instead of being hidden.
    handle = await open(absolute, 'wx', 0o600)
    await handle.writeFile(`${JSON.stringify(envelope)}\n`, 'utf8')
    await handle.sync()
    await handle.close()
    handle = undefined
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  for (const [key, fixedPath] of Object.entries(FIXED_PREFLIGHT_PATHS)) {
    if (path.resolve(args[key]) !== fixedPath) throw new Error('Host-boundary preflight path is not the fixed reviewed path.')
  }
  const challenge = await readJsonFile(args['--controller-challenge'], 'Controller challenge', 16 * 1024)
  const request = createFixedHostBoundaryRequest(challenge)
  const envelope = await requestAttestation(args['--harness-socket'], request)
  const publicKeyPem = await readFile(args['--public-key'])
  const expected = {
    bootId: challenge.bootId,
    controllerRunId: challenge.controllerRunId,
    harnessDigest: challenge.harnessDigest,
    imageDigest: challenge.imageDigest,
    jobId: challenge.jobId,
    nonce: challenge.nonce,
    reviewedSha: challenge.reviewedSha,
    signingKeyId: challenge.signingKeyId,
    tlsFixtureDigest: challenge.tlsFixtureDigest,
    workflowRunId: challenge.workflowRunId,
  }
  const verified = verifyHostBoundaryAttestation({ envelope, expected, publicKeyPem })
  await writeFirstAttemptEnvelope(args['--signed-envelope-out'], verified)
  process.stdout.write(`HOST_BOUNDARY_PREFLIGHT_VERIFIED run=${verified.payload.controllerRunId}\n`)
}

main().catch((error) => {
  void error
  process.stderr.write('HOST_BOUNDARY_PREFLIGHT_REJECTED\n')
  process.exitCode = 1
})
