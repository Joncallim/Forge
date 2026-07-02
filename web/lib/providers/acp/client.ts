import { getAcpAdapterCommand } from './handshake'
import { ACP_PROTOCOL_VERSION } from './handshake'
import type { AcpModelSelectionSupport } from './catalog'
import { buildAcpModelConfigRequest } from './model-selection'
import { AcpTransport, buildAcpSpawnOptions, defaultAcpSpawn, type AcpSpawn } from './transport'
import { redactAdapterMessage } from './redaction'

// ---------------------------------------------------------------------------
// ACP session client
//
// Runs an actual task turn through a spawned ACP adapter: initialize, open a
// session, send one prompt, and collect the streamed agent_message_chunk
// text back into a single string. One client/process per call — Forge's
// provider call sites (orchestrator, work-package-executor, etc.) each call
// getModel()/generateText()/streamText() once per task, so there is no need
// to pool or reuse adapter processes across turns.
// ---------------------------------------------------------------------------

const ACP_SESSION_TIMEOUT_MS = 5 * 60_000

export class AcpStartupError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AcpStartupError'
  }
}

export class AcpTransportError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AcpTransportError'
  }
}

export type AcpPromptResult = {
  text: string
  stopReason: string
}

export type AcpSessionStartOptions = {
  selectedModel?: string | null
  modelSelection?: AcpModelSelectionSupport | null
  spawnFn?: AcpSpawn
}

function startupError(agentId: string, method: string, err: unknown): Error {
  const message = redactAdapterMessage(err instanceof Error ? err.message : String(err))
  if (/timed out/i.test(message)) {
    return new AcpStartupError(`ACP runtime "${agentId}" did not respond to ${method}. Make sure the underlying CLI is installed, authenticated, and able to start in the configured project folder.`)
  }
  if (/exited unexpectedly|process error/i.test(message)) {
    return new AcpStartupError(`ACP runtime "${agentId}" could not start. Make sure the underlying CLI is installed, authenticated, and on PATH. Details: ${message}`)
  }
  return new AcpStartupError(`ACP runtime "${agentId}" failed during ${method}: ${message}`)
}

export class AcpSessionClient {
  private readonly transport: AcpTransport
  private readonly sessionId: string

  private constructor(transport: AcpTransport, sessionId: string) {
    this.transport = transport
    this.sessionId = sessionId
  }

  static async start(
    agentId: string,
    cwd: string,
    options: AcpSessionStartOptions = {},
  ): Promise<AcpSessionClient> {
    const sessionCwd = cwd.trim()
    if (!sessionCwd) {
      throw new AcpStartupError('Project localPath is required before Forge can start an ACP session.')
    }

    const command = getAcpAdapterCommand(agentId)
    if (!command) {
      throw new AcpStartupError(`No ACP adapter is wired up for agent "${agentId}".`)
    }

    const transport = new AcpTransport(
      command,
      options.spawnFn ?? defaultAcpSpawn,
      buildAcpSpawnOptions({ cwd: sessionCwd }),
    )
    try {
      try {
        await transport.request(
          'initialize',
          { protocolVersion: ACP_PROTOCOL_VERSION, clientCapabilities: {} },
          30_000,
        )
      } catch (err) {
        throw startupError(agentId, 'initialize', err)
      }

      let sessionResult: { sessionId?: string }
      try {
        sessionResult = (await transport.request('session/new', { cwd: sessionCwd, mcpServers: [] }, 30_000)) as {
          sessionId?: string
        }
      } catch (err) {
        throw startupError(agentId, 'session/new', err)
      }
      const sessionId = sessionResult?.sessionId
      if (!sessionId) {
        throw new AcpStartupError('ACP adapter did not return a sessionId from session/new')
      }

      const selectedModel = options.selectedModel?.trim()
      if (selectedModel) {
        if (!options.modelSelection) {
          throw new AcpStartupError(`ACP model selection is not configured for agent "${agentId}".`)
        }
        try {
          await transport.request(
            'session/set_config_option',
            buildAcpModelConfigRequest(sessionId, selectedModel, options.modelSelection, sessionResult),
            30_000,
          )
        } catch (err) {
          const message = redactAdapterMessage(err instanceof Error ? err.message : String(err))
          throw new AcpStartupError(`ACP runtime "${agentId}" could not set selected model "${selectedModel}": ${message}`)
        }
      }

      return new AcpSessionClient(transport, sessionId)
    } catch (err) {
      transport.close()
      throw err
    }
  }

  async prompt(text: string, onChunk?: (delta: string) => void): Promise<AcpPromptResult> {
    let accumulated = ''

    this.transport.onNotification('session/update', (rawParams) => {
      const params = rawParams as {
        sessionId?: string
        update?: { sessionUpdate?: string; content?: { type?: string; text?: string } }
      }
      if (params?.sessionId !== this.sessionId) return
      if (params.update?.sessionUpdate !== 'agent_message_chunk') return

      const delta = params.update.content?.type === 'text' ? params.update.content.text ?? '' : ''
      if (!delta) return
      accumulated += delta
      onChunk?.(delta)
    })

    let result: { stopReason?: string }
    try {
      result = (await this.transport.request(
        'session/prompt',
        { sessionId: this.sessionId, prompt: [{ type: 'text', text }] },
        ACP_SESSION_TIMEOUT_MS,
      )) as { stopReason?: string }
    } catch (err) {
      const message = redactAdapterMessage(err instanceof Error ? err.message : String(err))
      throw new AcpTransportError(`ACP session transport failed while waiting for agent output: ${message}`)
    }

    return { text: accumulated, stopReason: result?.stopReason ?? 'end_turn' }
  }

  close(): void {
    this.transport.close()
  }
}
