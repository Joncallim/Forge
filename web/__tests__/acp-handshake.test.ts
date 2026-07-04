/**
 * Tests for lib/providers/acp/handshake.ts — the adapter-spawn readiness
 * check used by ACP provider health checks.
 *
 * A fake EventEmitter-based child process stands in for `spawn()` so these
 * tests never shell out to ACP adapters or underlying `claude`/`codex` CLIs.
 */

import { EventEmitter } from 'node:events'
import path from 'node:path'
import { describe, it, expect, vi } from 'vitest'
import { checkAcpReadiness, getAcpAdapterCommand, isAcpAdapterSupported } from '@/lib/providers/acp/handshake'
import { AcpSessionClient } from '@/lib/providers/acp/client'
import { AcpTransport, buildAcpAdapterEnv } from '@/lib/providers/acp/transport'

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

function fixtureSecret(...parts: string[]) {
  return parts.join('')
}

function executableName(command: string[] | null) {
  expect(command).not.toBeNull()
  expect(command).toHaveLength(1)
  return path.basename(command![0])
}

describe('getAcpAdapterCommand / isAcpAdapterSupported', () => {
  it('maps known catalog agent ids to pinned local adapter commands', () => {
    expect(executableName(getAcpAdapterCommand('claude-agent'))).toMatch(/^claude-agent-acp(?:\.cmd)?$/)
    expect(executableName(getAcpAdapterCommand('codex-cli'))).toMatch(/^codex-acp(?:\.cmd)?$/)
    expect(isAcpAdapterSupported('claude-agent')).toBe(true)
  })

  it('returns null for agents without a wired-up adapter', () => {
    expect(getAcpAdapterCommand('some-other-agent')).toBeNull()
    expect(isAcpAdapterSupported('some-other-agent')).toBe(false)
  })
})

describe('buildAcpAdapterEnv', () => {
  it('passes only deny-by-default adapter environment variables', () => {
    const env = buildAcpAdapterEnv({
      AWS_SECRET_ACCESS_KEY: 'aws-secret',
      DATABASE_URL: 'postgres://user:pass@db/app',
      ENCRYPTION_KEY: 'encryption-secret',
      GITHUB_TOKEN: 'github-token',
      HOME: '/home/forge',
      OPENAI_API_KEY: 'openai-secret',
      PATH: '/usr/bin',
      REDIS_URL: 'redis://localhost:6379',
      XDG_CONFIG_HOME: '/home/forge/.config',
    })

    expect(env).toMatchObject({
      HOME: '/home/forge',
      PATH: '/usr/bin',
      XDG_CONFIG_HOME: '/home/forge/.config',
    })
    expect(env).not.toHaveProperty('AWS_SECRET_ACCESS_KEY')
    expect(env).not.toHaveProperty('DATABASE_URL')
    expect(env).not.toHaveProperty('ENCRYPTION_KEY')
    expect(env).not.toHaveProperty('GITHUB_TOKEN')
    expect(env).not.toHaveProperty('OPENAI_API_KEY')
    expect(env).not.toHaveProperty('REDIS_URL')
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
    const command = getAcpAdapterCommand('codex-cli')!

    const result = await checkAcpReadiness('codex-cli', spawnFn)

    expect(result.status).toBe('ready')
    expect(result.latencyMs).not.toBeNull()
    expect(spawnFn).toHaveBeenCalledWith(command[0], [], expect.objectContaining({
      cwd: process.cwd(),
      env: expect.objectContaining({
        PATH: expect.stringContaining('node_modules/.bin'),
      }),
      shell: false,
      windowsHide: true,
    }))
    const spawnOptions = spawnFn.mock.calls[0][2] as { env?: Record<string, string> }
    expect(spawnOptions.env).not.toEqual(expect.objectContaining({
      DATABASE_URL: expect.any(String),
      GITHUB_TOKEN: expect.any(String),
      OPENAI_API_KEY: expect.any(String),
      REDIS_URL: expect.any(String),
    }))
    expect(child.stdin.write).toHaveBeenCalledTimes(2)
    expect(child.kill).toHaveBeenCalled()
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
    expect(child.kill).toHaveBeenCalled()
  })

  it('classifies an auth-related initialize error as authenticated_unavailable', async () => {
    const child = new FakeChildProcess()
    child.responder = (_method, id) => ({ jsonrpc: '2.0', id, error: { message: 'Not authenticated, please login' } })
    const spawnFn = makeSpawnFn(child)

    const result = await checkAcpReadiness('codex-cli', spawnFn)

    expect(result.status).toBe('authenticated_unavailable')
    expect(child.kill).toHaveBeenCalled()
  })

  it('redacts sensitive adapter messages before returning auth failures', async () => {
    const child = new FakeChildProcess()
    const leakedToken = fixtureSecret('ghp', '_', '1234567890', 'abcdef')
    child.responder = (_method, id) => ({
      jsonrpc: '2.0',
      id,
      error: {
        message: `Not authenticated as dev@example.com with Bearer ${leakedToken}`,
      },
    })
    const spawnFn = makeSpawnFn(child)

    const result = await checkAcpReadiness('codex-cli', spawnFn)

    expect(result.status).toBe('authenticated_unavailable')
    expect(result.message).toContain('[redacted-email]')
    expect(result.message).toContain('Bearer [redacted-token]')
    expect(result.message).not.toContain('dev@example.com')
    expect(result.message).not.toContain(leakedToken)
    expect(child.kill).toHaveBeenCalled()
  })

  it('classifies a non-auth handshake error as handshake_failed', async () => {
    const child = new FakeChildProcess()
    child.responder = (_method, id) => ({ jsonrpc: '2.0', id, error: { message: 'Unsupported protocol version' } })
    const spawnFn = makeSpawnFn(child)

    const result = await checkAcpReadiness('codex-cli', spawnFn)

    expect(result.status).toBe('handshake_failed')
    expect(child.kill).toHaveBeenCalled()
  })

  it('classifies an early process exit as unreachable', async () => {
    const child = new FakeChildProcess()
    const leakedToken = fixtureSecret('ghp', '_', '1234567890', 'abcdef')
    const spawnFn = makeSpawnFn(child)

    const promise = checkAcpReadiness('codex-cli', spawnFn)
    child.stderr.emit('data', Buffer.from(`token ${leakedToken} for dev@example.com`))
    child.emit('exit', 1)
    const result = await promise

    expect(result.status).toBe('unreachable')
    expect(result.message).not.toContain(leakedToken)
    expect(result.message).not.toContain('dev@example.com')
  })

  it('classifies a synchronous spawn failure as unreachable', async () => {
    const spawnFn = vi.fn().mockImplementation(() => {
      throw new Error('spawn codex-acp ENOENT')
    })

    const result = await checkAcpReadiness('codex-cli', spawnFn)

    expect(result.status).toBe('unreachable')
    expect(result.message).toContain('ENOENT')
  })

  it('treats a filesystem "permission denied" process error as unreachable, not an auth failure', async () => {
    const child = new FakeChildProcess()
    const spawnFn = makeSpawnFn(child)

    const promise = checkAcpReadiness('codex-cli', spawnFn)
    child.stderr.emit('data', Buffer.from('EACCES: permission denied, open /home/user/.codex/config.toml'))
    child.emit('exit', 1)
    const result = await promise

    // A filesystem/install permission problem must surface as the real
    // unreachable/permissions failure rather than telling the operator to sign in.
    expect(result.status).toBe('unreachable')
  })
})

describe('AcpSessionClient', () => {
  it('spawns the ACP adapter from the requested session cwd', async () => {
    const child = new FakeChildProcess()
    child.responder = (method, id) => {
      if (method === 'initialize') return { jsonrpc: '2.0', id, result: { protocolVersion: 1 } }
      if (method === 'session/new') return { jsonrpc: '2.0', id, result: { sessionId: 'sess-1' } }
      return null
    }
    const spawnFn = makeSpawnFn(child)
    const command = getAcpAdapterCommand('codex-cli')!

    const client = await AcpSessionClient.start('codex-cli', '/tmp/forge-package-sandbox', { spawnFn })

    expect(spawnFn).toHaveBeenCalledWith(command[0], [], expect.objectContaining({
      cwd: '/tmp/forge-package-sandbox',
      env: expect.objectContaining({
        PATH: expect.stringContaining('node_modules/.bin'),
      }),
      shell: false,
      windowsHide: true,
    }))
    client.close()
  })
})

describe('AcpTransport.close', () => {
  it('rejects in-flight requests instead of leaving them pending until timeout', async () => {
    const child = new FakeChildProcess()
    // Never respond, so the request stays pending until close() settles it.
    child.responder = () => null
    const transport = new AcpTransport(['adapter'], makeSpawnFn(child))

    const pending = transport.request('initialize', {}, 30_000)
    transport.close()

    await expect(pending).rejects.toThrow(/closed before the request completed/i)
    expect(child.kill).toHaveBeenCalled()
  })
})

describe('AcpTransport stdout decoding', () => {
  it('reassembles a multi-byte UTF-8 sequence split across two stdout chunks', async () => {
    const child = new FakeChildProcess()
    const transport = new AcpTransport(['adapter'], makeSpawnFn(child))

    let received: unknown = null
    transport.onNotification('test/echo', (params) => { received = params })

    const message = `${JSON.stringify({ jsonrpc: '2.0', method: 'test/echo', params: { text: 'café-☃' } })}\n`
    const buf = Buffer.from(message, 'utf8')
    // Split one byte into the 3-byte snowman so the sequence straddles chunks.
    const splitAt = buf.indexOf(Buffer.from('☃', 'utf8')) + 1
    child.stdout.emit('data', buf.subarray(0, splitAt))
    child.stdout.emit('data', buf.subarray(splitAt))

    expect(received).toEqual({ text: 'café-☃' })
  })
})
