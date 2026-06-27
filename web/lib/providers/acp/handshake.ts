import { getAcpAgent } from './catalog'
import { AcpTransport, defaultAcpSpawn, type AcpSpawn } from './transport'

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
export const ACP_PROTOCOL_VERSION = 1

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

/**
 * Spawns the adapter for `agentId`, sends an ACP `initialize` request, and
 * classifies the outcome. `spawnFn` is injectable for tests so we never need
 * to actually shell out to `npx`/`claude`/`codex` in CI.
 */
export async function checkAcpReadiness(
  agentId: string,
  spawnFn: AcpSpawn = defaultAcpSpawn,
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

  let transport: AcpTransport
  try {
    transport = new AcpTransport(command, spawnFn)
  } catch (err) {
    return {
      status: 'unreachable',
      message: `Could not start the ${agent.label} ACP adapter: ${
        err instanceof Error ? err.message : String(err)
      }. Make sure Node/npx is on PATH.`,
      latencyMs: null,
    }
  }

  try {
    await transport.request(
      'initialize',
      { protocolVersion: ACP_PROTOCOL_VERSION, clientCapabilities: {} },
      ACP_HANDSHAKE_TIMEOUT_MS,
    )
    return {
      status: 'ready',
      message: `${agent.label} is reachable and completed the ACP handshake.`,
      latencyMs: Date.now() - start,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)

    if (/timed out/i.test(message)) {
      return {
        status: 'handshake_failed',
        message: `Timed out after ${ACP_HANDSHAKE_TIMEOUT_MS}ms waiting for ${agent.label}'s ACP adapter to respond to the initialize handshake.`,
        latencyMs: null,
      }
    }

    if (/exited unexpectedly|process error/i.test(message)) {
      return {
        status: 'unreachable',
        message: `The ${agent.label} ACP adapter exited immediately or could not be reached: ${message}${
          transport.recentStderr ? '' : ' Is the underlying CLI installed and on PATH?'
        }`,
        latencyMs: null,
      }
    }

    return {
      status: looksLikeAuthFailure(message) ? 'authenticated_unavailable' : 'handshake_failed',
      message: `${agent.label}'s ACP adapter rejected the initialize handshake: ${message}`,
      latencyMs: Date.now() - start,
    }
  } finally {
    transport.close()
  }
}
