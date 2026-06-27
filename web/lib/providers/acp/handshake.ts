import { spawn } from 'node:child_process'
import { getAcpAgent } from './catalog'

// ---------------------------------------------------------------------------
// ACP adapter readiness check
//
// Forge does not implement ACP agents itself. Instead it spawns the
// zed-industries adapter package for the selected agent (a thin stdio bridge
// that wraps the real CLI — `claude` or `codex` — and speaks ACP JSON-RPC).
// This module's job is purely to answer "can Forge reach and handshake with
// that adapter right now", broken into actionable failure states instead of
// a single boolean.
// ---------------------------------------------------------------------------

export type AcpReadinessStatus =
  | 'not_configured'
  | 'unreachable'
  | 'handshake_failed'
  | 'authenticated_unavailable'
  | 'ready'

export type AcpReadinessResult = {
  status: AcpReadinessStatus
  message: string
  latencyMs: number | null
}

const ACP_HANDSHAKE_TIMEOUT_MS = 8000
const ACP_PROTOCOL_VERSION = 1

/**
 * Maps an ACP catalog agent id to the command that spawns its zed-industries
 * adapter. The adapter is fetched on demand via `npx` rather than bundled, so
 * no separate "install Zed" step is needed — but the underlying CLI (`claude`
 * or `codex`) must already be installed and authenticated on the host.
 */
const ACP_ADAPTER_COMMANDS: Record<string, string[]> = {
  'claude-agent': ['npx', '-y', '@zed-industries/claude-agent-acp'],
  'codex-cli': ['npx', '-y', '@zed-industries/codex-acp'],
}

export function getAcpAdapterCommand(agentId: string): string[] | null {
  return ACP_ADAPTER_COMMANDS[agentId] ?? null
}

export function isAcpAdapterSupported(agentId: string): boolean {
  return getAcpAdapterCommand(agentId) !== null
}

function looksLikeAuthFailure(message: string | undefined): boolean {
  if (!message) return false
  return /\b(auth|login|credential|unauthoriz|api key|token)/i.test(message)
}

type AcpSpawn = (command: string, args: string[]) => ReturnType<typeof spawn>

/**
 * Spawns the adapter for `agentId`, sends an ACP `initialize` request, and
 * classifies the outcome. `spawnFn` is injectable for tests so we never need
 * to actually shell out to `npx`/`claude`/`codex` in CI.
 */
export async function checkAcpReadiness(
  agentId: string,
  spawnFn: AcpSpawn = (command, args) => spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] }),
): Promise<AcpReadinessResult> {
  const agent = getAcpAgent(agentId)
  if (!agent) {
    return { status: 'not_configured', message: `Unknown ACP agent "${agentId}".`, latencyMs: null }
  }

  const command = getAcpAdapterCommand(agentId)
  if (!command) {
    return {
      status: 'not_configured',
      message: `No Zed ACP adapter is wired up for ${agent.label} yet. See ${agent.adapterUrl ?? agent.sourceUrl}.`,
      latencyMs: null,
    }
  }

  const start = Date.now()

  return new Promise<AcpReadinessResult>((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout>

    const settle = (result: AcpReadinessResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        child.kill()
      } catch {
        // Already exited.
      }
      resolve(result)
    }

    let child: ReturnType<typeof spawn>
    try {
      child = spawnFn(command[0], command.slice(1))
    } catch (err) {
      resolve({
        status: 'unreachable',
        message: `Could not start the ${agent.label} ACP adapter: ${
          err instanceof Error ? err.message : String(err)
        }. Make sure Node/npx is on PATH.`,
        latencyMs: null,
      })
      return
    }

    timer = setTimeout(() => {
      settle({
        status: 'handshake_failed',
        message: `Timed out after ${ACP_HANDSHAKE_TIMEOUT_MS}ms waiting for ${agent.label}'s ACP adapter to respond to the initialize handshake.`,
        latencyMs: null,
      })
    }, ACP_HANDSHAKE_TIMEOUT_MS)

    let stderr = ''
    let stdoutBuffer = ''

    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8').slice(0, 2000)
    })

    child.on('error', (err) => {
      settle({
        status: 'unreachable',
        message: `Could not reach the ${agent.label} ACP adapter process: ${err.message}`,
        latencyMs: null,
      })
    })

    child.on('exit', (code) => {
      if (settled) return
      settle({
        status: 'unreachable',
        message: `The ${agent.label} ACP adapter exited immediately (code ${code}).${
          stderr.trim() ? ` ${stderr.trim().slice(0, 300)}` : ' Is the underlying CLI installed and on PATH?'
        }`,
        latencyMs: null,
      })
    })

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString('utf8')
      const lines = stdoutBuffer.split('\n')
      stdoutBuffer = lines.pop() ?? ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue

        let parsed: unknown
        try {
          parsed = JSON.parse(trimmed)
        } catch {
          continue
        }
        if (!parsed || typeof parsed !== 'object') continue

        const message = parsed as { id?: unknown; result?: unknown; error?: { message?: string } }
        if (message.id !== 1) continue

        if (message.error) {
          settle({
            status: looksLikeAuthFailure(message.error.message) ? 'authenticated_unavailable' : 'handshake_failed',
            message: `${agent.label}'s ACP adapter rejected the initialize handshake: ${
              message.error.message ?? 'unknown error'
            }`,
            latencyMs: Date.now() - start,
          })
          return
        }

        settle({
          status: 'ready',
          message: `${agent.label} is reachable and completed the ACP handshake.`,
          latencyMs: Date.now() - start,
        })
        return
      }
    })

    const request = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: ACP_PROTOCOL_VERSION, clientCapabilities: {} },
    }
    child.stdin?.write(`${JSON.stringify(request)}\n`)
  })
}
