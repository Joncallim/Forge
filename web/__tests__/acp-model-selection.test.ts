import { describe, expect, it } from 'vitest'

import {
  acpProviderDisplay,
  acpProviderModelId,
  parseAcpProviderModelId,
} from '@/lib/providers/acp/catalog'
import {
  classifyAcpPromptResult,
  unsupportedAcpModelSelectionMessage,
} from '@/lib/providers/acp/language-model'

describe('ACP provider model selection config', () => {
  it('stores ACP runtime and selected model in one provider row model id', () => {
    const modelId = acpProviderModelId('codex-cli', 'gpt-5')

    expect(modelId).toBe('codex-cli::gpt-5')
    expect(parseAcpProviderModelId(modelId)).toMatchObject({
      agentId: 'codex-cli',
      selectedModel: 'gpt-5',
      supportsModelSelection: false,
    })
  })

  it('allows two provider configs to use the same runtime with different selected model values', () => {
    expect(acpProviderModelId('codex-cli', 'gpt-5')).not.toBe(acpProviderModelId('codex-cli', 'o4-mini'))
    expect(parseAcpProviderModelId('codex-cli::gpt-5').agentId)
      .toBe(parseAcpProviderModelId('codex-cli::o4-mini').agentId)
  })

  it('displays ACP runtime separately from the selected model and unsupported marker', () => {
    expect(acpProviderDisplay('codex-cli::gpt-5')).toMatchObject({
      runtimeLabel: 'Codex CLI',
      selectedModel: 'gpt-5',
      modelSelectionLabel: 'gpt-5 (not passed to this ACP runtime)',
      supportsModelSelection: false,
    })
  })
})

describe('ACP prompt result classification', () => {
  it('rejects token, quota, and rate-limit exhaustion as failures', () => {
    expect(() => classifyAcpPromptResult({
      text: 'Usage limit reached. Please upgrade your plan.',
      stopReason: 'end_turn',
    })).toThrow(/usage|quota|rate/i)
  })

  it('rejects empty and no-op output', () => {
    expect(() => classifyAcpPromptResult({ text: '', stopReason: 'end_turn' })).toThrow(/empty/i)
    expect(() => classifyAcpPromptResult({
      text: 'No changes were needed.',
      stopReason: 'end_turn',
    })).toThrow(/no-op/i)
  })

  it('rejects max-token stops as failures', () => {
    expect(() => classifyAcpPromptResult({ text: '{"partial":true}', stopReason: 'max_tokens' }))
      .toThrow(/token limit/i)
  })

  it('accepts normal ACP output', () => {
    expect(classifyAcpPromptResult({
      text: '{"schemaVersion":1,"summary":"Implemented","files":[{"path":"index.js","content":"console.log(1)"}],"commands":[]}',
      stopReason: 'end_turn',
    })).toBe('{"schemaVersion":1,"summary":"Implemented","files":[{"path":"index.js","content":"console.log(1)"}],"commands":[]}')
  })

  it('reports unsupported ACP model selection clearly', () => {
    expect(unsupportedAcpModelSelectionMessage('codex-cli', 'gpt-5'))
      .toMatch(/not passed/i)
  })
})
