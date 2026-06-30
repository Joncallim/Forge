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

type AcpResponder = (method: string, id: number) => Record<string, unknown> | null

class FakeChildProcess extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  kill = vi.fn()
  // Auto-respond to each JSON-RPC request the transport writes, so multi-step
  // handshakes (initialize -> session/new) can be driven by a single responder.
  responder: AcpResponder = (_method, id) => ({ jsonrpc: '2.0', id, result: {} })
  stdin = {
    write: vi.fn((raw: string) => {
      const request = JSON.parse(raw.trim()) as { id: number; method: string }
      const response = this.responder(request.method, request.id)
      if (response) {
        // Defer so the transport has registered the pending request first.
        setTimeout(() => writeJsonLine(this.stdout, response), 0)
      }
      return true
    }),
  }
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

  it('returns ready only after both initialize and a session probe succeed', async () => {
    const child = new FakeChildProcess()
    child.responder = (method, id) => {
      if (method === 'initialize') return { jsonrpc: '2.0', id, result: { protocolVersion: 1 } }
      if (method === 'session/new') return { jsonrpc: '2.0', id, result: { sessionId: 'sess-1' } }
      return null
    }
    const spawnFn = makeSpawnFn(child)

    const result = await checkAcpReadiness('codex-cli', spawnFn)

    expect(result.status).toBe('ready')
    expect(result.latencyMs).not.toBeNull()
    expect(spawnFn).toHaveBeenCalledWith('npx', ['-y', '@zed-industries/codex-acp'])
    expect(child.stdin.write).toHaveBeenCalledTimes(2)
  })

  it('reports authenticated_unavailable when the session probe needs login', async () => {
    const child = new FakeChildProcess()
    child.responder = (method, id) => {
      if (method === 'initialize') return { jsonrpc: '2.0', id, result: { protocolVersion: 1 } }
      // initialize succeeds, but starting a session requires authentication.
      return { jsonrpc: '2.0', id, error: { message: 'Not authenticated, please login' } }
    }
    const spawnFn = makeSpawnFn(child)

    const result = await checkAcpReadiness('codex-cli', spawnFn)

    expect(result.status).toBe('authenticated_unavailable')
  })

  it('classifies an auth-related initialize error as authenticated_unavailable', async () => {
    const child = new FakeChildProcess()
    child.responder = (_method, id) => ({ jsonrpc: '2.0', id, error: { message: 'Not authenticated, please login' } })
    const spawnFn = makeSpawnFn(child)

    const result = await checkAcpReadiness('codex-cli', spawnFn)

    expect(result.status).toBe('authenticated_unavailable')
  })

  it('classifies a non-auth handshake error as handshake_failed', async () => {
    const child = new FakeChildProcess()
    child.responder = (_method, id) => ({ jsonrpc: '2.0', id, error: { message: 'Unsupported protocol version' } })
    const spawnFn = makeSpawnFn(child)

    const result = await checkAcpReadiness('codex-cli', spawnFn)

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
