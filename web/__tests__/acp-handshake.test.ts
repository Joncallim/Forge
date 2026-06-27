/**
 * Tests for lib/providers/acp/handshake.ts — the adapter-spawn readiness
 * check used by ACP provider health checks.
 *
 * A fake EventEmitter-based child process stands in for `spawn()` so these
 * tests never shell out to `npx`/`claude`/`codex`.
 */

import { EventEmitter } from 'node:events'
import { describe, it, expect, vi } from 'vitest'
import { checkAcpReadiness, getAcpAdapterCommand, isAcpAdapterSupported } from '@/lib/providers/acp/handshake'

class FakeChildProcess extends EventEmitter {
  stdin = { write: vi.fn() }
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  kill = vi.fn()
}

function makeSpawnFn(child: FakeChildProcess) {
  return vi.fn().mockReturnValue(child)
}

function writeJsonLine(emitter: EventEmitter, value: unknown) {
  emitter.emit('data', Buffer.from(`${JSON.stringify(value)}\n`))
}

describe('getAcpAdapterCommand / isAcpAdapterSupported', () => {
  it('maps known catalog agent ids to their zed-industries adapter command', () => {
    expect(getAcpAdapterCommand('claude-agent')).toEqual(['npx', '-y', '@zed-industries/claude-agent-acp'])
    expect(getAcpAdapterCommand('codex-cli')).toEqual(['npx', '-y', '@zed-industries/codex-acp'])
    expect(isAcpAdapterSupported('claude-agent')).toBe(true)
  })

  it('returns null for agents without a wired-up adapter', () => {
    expect(getAcpAdapterCommand('some-other-agent')).toBeNull()
    expect(isAcpAdapterSupported('some-other-agent')).toBe(false)
  })
})

describe('checkAcpReadiness', () => {
  it('returns not_configured for an unknown agent id', async () => {
    const result = await checkAcpReadiness('totally-unknown-agent')
    expect(result.status).toBe('not_configured')
  })

  it('returns not_configured when no adapter command is wired up for a known agent', async () => {
    const result = await checkAcpReadiness('cline')
    expect(result.status).toBe('not_configured')
  })

  it('returns ready when the adapter responds successfully to initialize', async () => {
    const child = new FakeChildProcess()
    const spawnFn = makeSpawnFn(child)

    const promise = checkAcpReadiness('codex-cli', spawnFn)
    writeJsonLine(child.stdout, { jsonrpc: '2.0', id: 1, result: { protocolVersion: 1 } })
    const result = await promise

    expect(result.status).toBe('ready')
    expect(result.latencyMs).not.toBeNull()
    expect(spawnFn).toHaveBeenCalledWith('npx', ['-y', '@zed-industries/codex-acp'])
  })

  it('classifies an auth-related handshake error as authenticated_unavailable', async () => {
    const child = new FakeChildProcess()
    const spawnFn = makeSpawnFn(child)

    const promise = checkAcpReadiness('codex-cli', spawnFn)
    writeJsonLine(child.stdout, { jsonrpc: '2.0', id: 1, error: { message: 'Not authenticated, please login' } })
    const result = await promise

    expect(result.status).toBe('authenticated_unavailable')
  })

  it('classifies a non-auth handshake error as handshake_failed', async () => {
    const child = new FakeChildProcess()
    const spawnFn = makeSpawnFn(child)

    const promise = checkAcpReadiness('codex-cli', spawnFn)
    writeJsonLine(child.stdout, { jsonrpc: '2.0', id: 1, error: { message: 'Unsupported protocol version' } })
    const result = await promise

    expect(result.status).toBe('handshake_failed')
  })

  it('classifies an early process exit as unreachable', async () => {
    const child = new FakeChildProcess()
    const spawnFn = makeSpawnFn(child)

    const promise = checkAcpReadiness('codex-cli', spawnFn)
    child.emit('exit', 1)
    const result = await promise

    expect(result.status).toBe('unreachable')
  })

  it('classifies a synchronous spawn failure as unreachable', async () => {
    const spawnFn = vi.fn().mockImplementation(() => {
      throw new Error('spawn npx ENOENT')
    })

    const result = await checkAcpReadiness('codex-cli', spawnFn)

    expect(result.status).toBe('unreachable')
    expect(result.message).toContain('ENOENT')
  })
})
