import { getAcpAdapterCommand } from './handshake'
import { ACP_PROTOCOL_VERSION } from './handshake'
import type { AcpModelSelectionSupport } from './catalog'
import { buildAcpModelConfigRequest } from './model-selection'
import { AcpTransport, defaultAcpSpawn, type AcpSpawn } from './transport'

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

export type AcpPromptResult = {
  text: string
  stopReason: string
}

export type AcpSessionStartOptions = {
  selectedModel?: string | null
  modelSelection?: AcpModelSelectionSupport | null
  spawnFn?: AcpSpawn
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
    const command = getAcpAdapterCommand(agentId)
    if (!command) {
      throw new Error(`No ACP adapter is wired up for agent "${agentId}".`)
    }

    const transport = new AcpTransport(command, options.spawnFn ?? defaultAcpSpawn)
    try {
      await transport.request(
        'initialize',
        { protocolVersion: ACP_PROTOCOL_VERSION, clientCapabilities: {} },
        30_000,
      )

      const sessionResult = (await transport.request('session/new', { cwd, mcpServers: [] }, 30_000)) as {
        sessionId?: string
      }
      const sessionId = sessionResult?.sessionId
      if (!sessionId) {
        throw new Error('ACP adapter did not return a sessionId from session/new')
      }

      const selectedModel = options.selectedModel?.trim()
      if (selectedModel) {
        if (!options.modelSelection) {
          throw new Error(`ACP model selection is not configured for agent "${agentId}".`)
        }
        try {
          await transport.request(
            'session/set_config_option',
            buildAcpModelConfigRequest(sessionId, selectedModel, options.modelSelection, sessionResult),
            30_000,
          )
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          throw new Error(`ACP runtime "${agentId}" could not set selected model "${selectedModel}": ${message}`)
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

    const result = (await this.transport.request(
      'session/prompt',
      { sessionId: this.sessionId, prompt: [{ type: 'text', text }] },
      ACP_SESSION_TIMEOUT_MS,
    )) as { stopReason?: string }

    return { text: accumulated, stopReason: result?.stopReason ?? 'end_turn' }
  }

  close(): void {
    this.transport.close()
  }
}
