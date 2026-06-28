import type {
  LanguageModelV2,
  LanguageModelV2CallOptions,
  LanguageModelV2FinishReason,
  LanguageModelV2Prompt,
  LanguageModelV2StreamPart,
} from '@ai-sdk/provider'
import { AcpSessionClient } from './client'
import { parseAcpProviderModelId } from './catalog'

// ---------------------------------------------------------------------------
// ACP-backed LanguageModelV2
//
// Forge's call sites (worker/orchestrator.ts, worker/work-package-executor.ts,
// lib/agent-evaluation.ts, lib/task-title.ts) all build a single-turn prompt —
// one `system` string plus one `prompt` string — and call streamText()/
// generateText(). This adapter flattens the AI SDK's LanguageModelV2Prompt
// back into that shape, runs it through an ACP session/prompt turn, and
// reports the result back through the LanguageModelV2 interface so it can be
// used as a drop-in LanguageModel.
//
// ACP doesn't expose tool calls or token usage through the methods Forge
// currently calls, so neither is implemented here.
// ---------------------------------------------------------------------------

function flattenPrompt(prompt: LanguageModelV2Prompt): string {
  const parts: string[] = []

  for (const message of prompt) {
    if (message.role === 'system') {
      parts.push(message.content)
      continue
    }
    if (message.role === 'tool') continue

    for (const part of message.content) {
      if (part.type === 'text') parts.push(part.text)
    }
  }

  return parts.join('\n\n')
}

function mapStopReason(stopReason: string): LanguageModelV2FinishReason {
  switch (stopReason) {
    case 'end_turn':
      return 'stop'
    case 'max_tokens':
      return 'length'
    case 'max_turn_requests':
      return 'other'
    case 'refusal':
      return 'content-filter'
    case 'cancelled':
      return 'other'
    default:
      return 'unknown'
  }
}

const ACP_FAILURE_PATTERNS = [
  /\busage limit\b/i,
  /\bquota\b/i,
  /\brate limit\b/i,
  /\btoo many requests\b/i,
  /\binsufficient[_ -]?quota\b/i,
  /\btoken limit\b/i,
  /\bcontext length\b/i,
  /\bmaximum context\b/i,
  /\bout of (tokens|credits)\b/i,
  /\bbilling\b/i,
  /\b429\b/,
]

const ACP_NO_OP_PATTERNS = [
  /\bno changes? (?:were )?(?:needed|required|made)\b/i,
  /\bnothing (?:to do|changed|was changed)\b/i,
  /\bno-op\b/i,
  /\bplaceholder response\b/i,
]

export function unsupportedAcpModelSelectionMessage(agentId: string, selectedModel: string): string {
  return `ACP runtime "${agentId}" does not expose explicit model selection through Forge yet; selected model "${selectedModel}" is stored on the provider config but not passed to this ACP runtime.`
}

export function classifyAcpPromptResult(result: { text: string; stopReason: string }): string {
  const text = result.text.trim()
  if (result.stopReason === 'max_tokens') {
    throw new Error('ACP runtime stopped at a token limit before producing complete output.')
  }
  if (result.stopReason === 'cancelled') {
    throw new Error('ACP runtime cancelled the request before producing output.')
  }
  if (text === '') {
    throw new Error('ACP runtime returned empty output.')
  }
  if (ACP_FAILURE_PATTERNS.some((pattern) => pattern.test(text))) {
    throw new Error(`ACP runtime reported usage, quota, rate-limit, or token exhaustion: ${text.slice(0, 300)}`)
  }
  if (ACP_NO_OP_PATTERNS.some((pattern) => pattern.test(text))) {
    throw new Error(`ACP runtime returned no-op output instead of implementation output: ${text.slice(0, 300)}`)
  }
  return text
}

export class AcpLanguageModel implements LanguageModelV2 {
  readonly specificationVersion = 'v2' as const
  readonly provider = 'acp'
  readonly modelId: string
  readonly supportedUrls: Record<string, RegExp[]> = {}
  private readonly agentId: string
  private readonly selectedModel: string | null
  private readonly supportsModelSelection: boolean

  constructor(modelId: string) {
    const parsed = parseAcpProviderModelId(modelId)
    this.agentId = parsed.agentId
    this.selectedModel = parsed.selectedModel
    this.supportsModelSelection = parsed.supportsModelSelection
    this.modelId = modelId
  }

  async doGenerate(options: LanguageModelV2CallOptions) {
    const client = await AcpSessionClient.start(this.agentId, process.cwd(), {
      selectedModel: this.supportsModelSelection ? this.selectedModel : null,
    })
    try {
      const text = flattenPrompt(options.prompt)
      const result = await client.prompt(text)
      const resultText = classifyAcpPromptResult(result)

      return {
        content: [{ type: 'text' as const, text: resultText }],
        finishReason: mapStopReason(result.stopReason),
        usage: { inputTokens: undefined, outputTokens: undefined, totalTokens: undefined },
        warnings: this.selectedModel && !this.supportsModelSelection
          ? [{ type: 'other' as const, message: unsupportedAcpModelSelectionMessage(this.agentId, this.selectedModel) }]
          : [],
      }
    } finally {
      client.close()
    }
  }

  async doStream(options: LanguageModelV2CallOptions) {
    const client = await AcpSessionClient.start(this.agentId, process.cwd(), {
      selectedModel: this.supportsModelSelection ? this.selectedModel : null,
    })
    const text = flattenPrompt(options.prompt)

    const stream = new ReadableStream<LanguageModelV2StreamPart>({
      async start(controller) {
        controller.enqueue({ type: 'stream-start', warnings: [] })
        controller.enqueue({ type: 'text-start', id: '0' })

        try {
          const result = await client.prompt(text, (delta) => {
            controller.enqueue({ type: 'text-delta', id: '0', delta })
          })
          classifyAcpPromptResult(result)

          controller.enqueue({ type: 'text-end', id: '0' })
          controller.enqueue({
            type: 'finish',
            finishReason: mapStopReason(result.stopReason),
            usage: { inputTokens: undefined, outputTokens: undefined, totalTokens: undefined },
          })
          controller.close()
        } catch (err) {
          controller.enqueue({ type: 'error', error: err })
          controller.close()
        } finally {
          client.close()
        }
      },
      cancel() {
        client.close()
      },
    })

    return { stream }
  }
}
