import net from 'node:net'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { test, expect } from '@playwright/test'
import {
  HOST_BOUNDARY_MAX_ENVELOPE_BYTES,
  verifyHostBoundaryAttestation,
} from '../scripts/lib/mcp-host-boundary-attestation.mjs'
import {
  createFixedHostBoundaryScenarioRequest,
  verifyHostBoundaryScenarioResult,
} from '../scripts/lib/mcp-host-boundary-scenario.mjs'
import { applyEpic172Step0E2EBridge } from './epic-172-step0-bridge'

const driverSocket = process.env.FORGE_HOST_BOUNDARY_DRIVER_SOCKET ?? ''
const challengePath = process.env.FORGE_HOST_BOUNDARY_CONTROLLER_CHALLENGE ?? ''
const attestationPath = process.env.FORGE_HOST_BOUNDARY_PREFLIGHT_ATTESTATION ?? ''
const publicKeyPath = process.env.FORGE_HOST_BOUNDARY_ATTESTATION_PUBLIC_KEY ?? ''
const FIXED_HOST_PATHS = Object.freeze({
  driverSocket: '/run/forge-host-boundary/scenario.sock',
  challengePath: '/run/forge-host-boundary/controller-challenge.json',
  attestationPath: path.resolve(process.cwd(), '.artifacts/mcp-host-boundary-preflight.signed.json'),
  publicKeyPath: '/usr/share/forge-host-boundary/attestation.pub',
})

let preflightEnvelope: unknown
let publicKeyPem: Buffer

async function readJson(filePath: string, label: string): Promise<unknown> {
  const bytes = await readFile(filePath)
  if (bytes.length === 0 || bytes.length > HOST_BOUNDARY_MAX_ENVELOPE_BYTES) {
    throw new Error(`${label} size is invalid.`)
  }
  return JSON.parse(bytes.toString('utf8')) as unknown
}

function requestFixedScenario(socketPath: string, request: unknown): Promise<unknown> {
  if (!path.isAbsolute(socketPath)) throw new Error('The host-boundary driver socket must be absolute.')
  const bytes = Buffer.from(`${JSON.stringify(request)}\n`, 'utf8')
  if (bytes.length > 16 * 1024) throw new Error('The fixed scenario request is too large.')

  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath })
    const chunks: Buffer[] = []
    let byteCount = 0
    let finished = false
    const finish = (error?: Error, result?: unknown) => {
      if (finished) return
      finished = true
      socket.destroy()
      if (error) reject(error)
      else resolve(result)
    }
    socket.setTimeout(85_000)
    socket.once('connect', () => socket.end(bytes))
    socket.on('data', (chunk: Buffer) => {
      byteCount += chunk.length
      if (byteCount > HOST_BOUNDARY_MAX_ENVELOPE_BYTES) {
        finish(new Error('The fixed scenario result exceeded its size limit.'))
        return
      }
      chunks.push(chunk)
    })
    socket.once('timeout', () => finish(new Error('The fixed scenario driver timed out.')))
    socket.once('error', () => finish(new Error('The fixed scenario driver failed.')))
    socket.once('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim()
      if (!raw || raw.includes('\n')) {
        finish(new Error('The fixed scenario driver returned an invalid envelope.'))
        return
      }
      try {
        finish(undefined, JSON.parse(raw))
      } catch {
        finish(new Error('The fixed scenario driver returned invalid JSON.'))
      }
    })
  })
}

test.describe('Epic 172 supported host boundary @mcp-host-boundary', () => {
  test.describe.configure({ mode: 'serial', retries: 0 })

  test.beforeEach(async ({}, testInfo) => {
    applyEpic172Step0E2EBridge(testInfo, 'mcp-host-boundary.spec.ts')
  })

  test.beforeAll(async () => {
    if (!driverSocket || !challengePath || !attestationPath || !publicKeyPath) {
      throw new Error('The trusted host-boundary project requires its external controller inputs.')
    }
    if (
      driverSocket !== FIXED_HOST_PATHS.driverSocket
      || challengePath !== FIXED_HOST_PATHS.challengePath
      || path.resolve(attestationPath) !== FIXED_HOST_PATHS.attestationPath
      || publicKeyPath !== FIXED_HOST_PATHS.publicKeyPath
    ) {
      throw new Error('The trusted host-boundary project requires the fixed reviewed paths.')
    }
    const [challenge, envelope, key] = await Promise.all([
      readJson(challengePath, 'Controller challenge'),
      readJson(attestationPath, 'Preflight attestation'),
      readFile(publicKeyPath),
    ])
    if (challenge === null || typeof challenge !== 'object' || Array.isArray(challenge)) {
      throw new Error('Controller challenge is invalid.')
    }
    const expectedChallenge = challenge as Record<string, unknown>
    preflightEnvelope = verifyHostBoundaryAttestation({
      envelope,
      expected: {
        bootId: expectedChallenge.bootId,
        controllerRunId: expectedChallenge.controllerRunId,
        harnessDigest: expectedChallenge.harnessDigest,
        imageDigest: expectedChallenge.imageDigest,
        jobId: expectedChallenge.jobId,
        nonce: expectedChallenge.nonce,
        reviewedSha: expectedChallenge.reviewedSha,
        signingKeyId: expectedChallenge.signingKeyId,
        tlsFixtureDigest: expectedChallenge.tlsFixtureDigest,
        workflowRunId: expectedChallenge.workflowRunId,
      },
      publicKeyPem: key,
    })
    publicKeyPem = key
  })

  async function runScenario(scenarioId: string): Promise<void> {
    const request = createFixedHostBoundaryScenarioRequest({ preflightEnvelope, scenarioId })
    expect(request).not.toHaveProperty('command')
    expect(request).not.toHaveProperty('path')
    const result = await requestFixedScenario(driverSocket, request)
    expect(() => verifyHostBoundaryScenarioResult({
      preflightEnvelope,
      publicKeyPem,
      result,
      scenarioId,
    })).not.toThrow()
  }

  test('epic-172.cgroup-descendant-containment', { tag: '@mcp-host-boundary', annotation: { type: 'scenarioId', description: 'epic-172.cgroup-descendant-containment' } }, async () => runScenario('epic-172.cgroup-descendant-containment'))
  test('epic-172.failure-injection-quiescence', { tag: '@mcp-host-boundary', annotation: { type: 'scenarioId', description: 'epic-172.failure-injection-quiescence' } }, async () => runScenario('epic-172.failure-injection-quiescence'))
  test('epic-172.peer-credential-boundary', { tag: '@mcp-host-boundary', annotation: { type: 'scenarioId', description: 'epic-172.peer-credential-boundary' } }, async () => runScenario('epic-172.peer-credential-boundary'))
  test('epic-172.protected-fence-service', { tag: '@mcp-host-boundary', annotation: { type: 'scenarioId', description: 'epic-172.protected-fence-service' } }, async () => runScenario('epic-172.protected-fence-service'))
  test('epic-172.supported-host-preflight', { tag: '@mcp-host-boundary', annotation: { type: 'scenarioId', description: 'epic-172.supported-host-preflight' } }, async () => runScenario('epic-172.supported-host-preflight'))
  test('epic-172.teardown-zero-residue', { tag: '@mcp-host-boundary', annotation: { type: 'scenarioId', description: 'epic-172.teardown-zero-residue' } }, async () => runScenario('epic-172.teardown-zero-residue'))
  test('epic-172.uid-credential-isolation', { tag: '@mcp-host-boundary', annotation: { type: 'scenarioId', description: 'epic-172.uid-credential-isolation' } }, async () => runScenario('epic-172.uid-credential-isolation'))
})
