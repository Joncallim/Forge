import type {
  LanguageModelV2,
  LanguageModelV2CallOptions,
  LanguageModelV2FinishReason,
  LanguageModelV2Prompt,
  LanguageModelV2StreamPart,
} from '@ai-sdk/provider'
import { AcpSessionClient } from './client'

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

export class AcpLanguageModel implements LanguageModelV2 {
  readonly specificationVersion = 'v2' as const
  readonly provider = 'acp'
  readonly modelId: string
  readonly supportedUrls: Record<string, RegExp[]> = {}

  constructor(agentId: string) {
    this.modelId = agentId
  }

  async doGenerate(options: LanguageModelV2CallOptions) {
    const client = await AcpSessionClient.start(this.modelId, process.cwd())
    try {
      const text = flattenPrompt(options.prompt)
      const { text: resultText, stopReason } = await client.prompt(text)

      return {
        content: [{ type: 'text' as const, text: resultText }],
        finishReason: mapStopReason(stopReason),
        usage: { inputTokens: undefined, outputTokens: undefined, totalTokens: undefined },
        warnings: [],
      }
    } finally {
      client.close()
    }
  }

  async doStream(options: LanguageModelV2CallOptions) {
    const client = await AcpSessionClient.start(this.modelId, process.cwd())
    const text = flattenPrompt(options.prompt)

    const stream = new ReadableStream<LanguageModelV2StreamPart>({
      async start(controller) {
        controller.enqueue({ type: 'stream-start', warnings: [] })
        controller.enqueue({ type: 'text-start', id: '0' })

        try {
          const { stopReason } = await client.prompt(text, (delta) => {
            controller.enqueue({ type: 'text-delta', id: '0', delta })
          })

          controller.enqueue({ type: 'text-end', id: '0' })
          controller.enqueue({
            type: 'finish',
            finishReason: mapStopReason(stopReason),
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
