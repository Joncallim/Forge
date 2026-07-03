import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getAcpAgent } from './catalog'
import { AcpTransport, defaultAcpSpawn, type AcpSpawn } from './transport'
import { redactAdapterMessage } from './redaction'

// ---------------------------------------------------------------------------
// ACP adapter readiness check
//
// Forge does not implement ACP agents itself. Instead it spawns the
// pinned Agent Client Protocol adapter package for the selected agent (a thin
// stdio bridge that wraps the real CLI — `claude` or `codex` — and speaks ACP
// JSON-RPC).
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
const ACP_SESSION_PROBE_TIMEOUT_MS = 12_000
export const ACP_PROTOCOL_VERSION = 1

/**
 * Maps an ACP catalog agent id to the local bin that spawns its ACP adapter.
 * Adapters are pinned package dependencies and launched directly from
 * node_modules/.bin so runtime checks do not fetch arbitrary package versions.
 * The underlying CLI (`claude` or `codex`) must already be installed and
 * authenticated on the host.
 */
const ACP_ADAPTER_BINS: Record<string, string> = {
  'claude-agent': 'claude-agent-acp',
  'codex-cli': 'codex-acp',
}

function binName(value: string): string {
  return process.platform === 'win32' ? `${value}.cmd` : value
}

function localAdapterBinPath(value: string): string | null {
  const executable = binName(value)
  const candidates = [
    join(process.cwd(), 'node_modules', '.bin', executable),
    join(process.cwd(), 'web', 'node_modules', '.bin', executable),
  ]

  return candidates.find((candidate) => existsSync(candidate)) ?? null
}

export function getAcpAdapterCommand(agentId: string): string[] | null {
  const adapterBin = ACP_ADAPTER_BINS[agentId]
  if (!adapterBin) return null
  return [localAdapterBinPath(adapterBin) ?? adapterBin]
}

export function isAcpAdapterSupported(agentId: string): boolean {
  return getAcpAdapterCommand(agentId) !== null
}

function looksLikeAuthFailure(message: string | undefined): boolean {
  if (!message) return false
  // Require a genuine auth-failure phrase rather than a bare word like "token"
  // or "auth", which routinely appear as noise in unrelated crash output and
  // would otherwise misclassify a plain process crash as an auth problem.
  return /(?:not\s+(?:authenticated|logged\s*in|signed\s*in)|unauthenticated|unauthoriz|please\s+(?:log\s*in|login|sign\s*in|authenticate)|require[sd]?\s+(?:authentication|login|sign\s*in|an?\s+api\s*key)|authentication\s+(?:required|failed)|login\s+required|sign\s*in\s+(?:required|to)|(?:invalid|missing|expired)\s+(?:api\s*key|token|credentials?)|api\s*key\s+(?:required|missing|invalid|not\s+set)|permission\s+denied|\bforbidden\b|\b40[13]\b)/i.test(message)
}

/**
 * Spawns the adapter for `agentId`, sends an ACP `initialize` request, and
 * classifies the outcome. `spawnFn` is injectable for tests so we never need
 * to actually shell out to ACP adapters or underlying `claude`/`codex` CLIs in
 * CI.
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
      message: `No pinned ACP adapter package is wired up for ${agent.label} yet. See ${agent.adapterUrl ?? agent.sourceUrl}.`,
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
      }. Make sure Node is on PATH and the pinned local ACP adapter dependency is installed.`,
      latencyMs: null,
    }
  }

  // A bare `initialize` only proves the adapter process can speak ACP — it
  // never invokes the underlying CLI (`codex`/`claude`), so it returns "ready"
  // even when that CLI is not installed or not authenticated. We additionally
  // open a throwaway session, which forces the adapter to actually start the
  // underlying CLI in a working directory. That is what makes a green indicator
  // mean "Forge can really use this runtime" rather than "an ACP adapter booted".
  let phase = 'initialize handshake'
  let probeDir: string | null = null
  try {
    await transport.request(
      'initialize',
      { protocolVersion: ACP_PROTOCOL_VERSION, clientCapabilities: {} },
      ACP_HANDSHAKE_TIMEOUT_MS,
    )

    phase = 'session probe'
    probeDir = await mkdtemp(join(tmpdir(), 'forge-acp-probe-'))
    await transport.request(
      'session/new',
      { cwd: probeDir, mcpServers: [] },
      ACP_SESSION_PROBE_TIMEOUT_MS,
    )
    return {
      status: 'ready',
      message: `${agent.label} is installed, authenticated, and started an ACP session successfully.`,
      latencyMs: Date.now() - start,
    }
  } catch (err) {
    return classifyAcpReadinessError(agent.label, err, start, phase)
  } finally {
    transport.close()
    if (probeDir) {
      await rm(probeDir, { recursive: true, force: true }).catch(() => {})
    }
  }
}

function classifyAcpReadinessError(
  label: string,
  err: unknown,
  start: number,
  phase: string,
): AcpReadinessResult {
  const message = redactAdapterMessage(err instanceof Error ? err.message : String(err))

  // Check for an auth signal first: an unauthenticated CLI often surfaces its
  // "please log in" prompt via a non-zero process exit, so the exit/process
  // branch below would otherwise misreport an actionable auth problem as an
  // "unreachable / not installed" transport error.
  if (looksLikeAuthFailure(message)) {
    return {
      status: 'authenticated_unavailable',
      message: `${label} is reachable but not authenticated: ${message}. Sign in to the underlying CLI first.`,
      latencyMs: Date.now() - start,
    }
  }

  if (/timed out/i.test(message)) {
    return {
      status: 'handshake_failed',
      message: `Timed out waiting for ${label}'s ACP adapter during the ${phase}. The underlying CLI may not be installed or signed in.`,
      latencyMs: null,
    }
  }

  if (/exited unexpectedly|process error/i.test(message)) {
    return {
      status: 'unreachable',
      message: `The ${label} ACP adapter exited or could not be reached during the ${phase}. Make sure the underlying CLI is installed, authenticated, and on PATH.`,
      latencyMs: null,
    }
  }

  return {
    status: 'handshake_failed',
    message: `${label}'s ACP adapter failed the ${phase}: ${message}`,
    latencyMs: Date.now() - start,
  }
}
