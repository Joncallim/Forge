import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { vi } from 'vitest'

import {
  acpProviderDisplay,
  acpProviderModelId,
  getAcpModelSelection,
  parseAcpProviderModelId,
} from '@/lib/providers/acp/catalog'
import { AcpSessionClient } from '@/lib/providers/acp/client'
import {
  AcpLanguageModel,
  classifyAcpPromptResult,
  unsupportedAcpModelSelectionMessage,
} from '@/lib/providers/acp/language-model'

class FakeChildProcess extends EventEmitter {
  stdin = { write: vi.fn() }
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  kill = vi.fn()
}

function makeSpawnFn(child: FakeChildProcess) {
  return vi.fn().mockReturnValue(child)
}

function writeJsonLine(emitter: EventEmitter, value: unknown) {
  emitter.emit('data', Buffer.from(`${JSON.stringify(value)}\n`))
}

function writtenRequests(child: FakeChildProcess) {
  return child.stdin.write.mock.calls
    .map(([line]) => JSON.parse(String(line)) as { id: number; method: string; params: unknown })
}

describe('ACP provider model selection config', () => {
  it('uses the current AI SDK language model specification', () => {
    expect(new AcpLanguageModel('codex-cli::gpt-5').specificationVersion).toBe('v3')
  })

  it('stores ACP runtime and selected model in one provider row model id', () => {
    const modelId = acpProviderModelId('codex-cli', 'gpt-5')

    expect(modelId).toBe('codex-cli::gpt-5')
    expect(parseAcpProviderModelId(modelId)).toMatchObject({
      agentId: 'codex-cli',
      selectedModel: 'gpt-5',
      supportsModelSelection: true,
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
      modelSelectionLabel: 'gpt-5',
      supportsModelSelection: true,
    })
  })

  it('reports unsupported ACP model selection clearly for runtimes without a strategy', () => {
    expect(acpProviderDisplay('cline::sonnet')).toMatchObject({
      runtimeLabel: 'Cline',
      selectedModel: 'sonnet',
      modelSelectionLabel: 'sonnet (not passed to this ACP runtime)',
      supportsModelSelection: false,
    })
    expect(unsupportedAcpModelSelectionMessage('cline', 'sonnet'))
      .toMatch(/not passed/i)
  })
})

describe('ACP session model selection', () => {
  it('requires an explicit project cwd before spawning an ACP session', async () => {
    const spawnFn = vi.fn()

    await expect(AcpSessionClient.start('codex-cli', '   ', { spawnFn }))
      .rejects.toThrow(/localPath/i)
    expect(spawnFn).not.toHaveBeenCalled()
  })

  it('sets selected Codex CLI models through ACP session config, not session/new params', async () => {
    const child = new FakeChildProcess()
    const spawnFn = makeSpawnFn(child)
    const modelSelection = getAcpModelSelection('codex-cli::gpt-5')

    const promise = AcpSessionClient.start('codex-cli', '/repo', {
      selectedModel: 'gpt-5',
      modelSelection,
      spawnFn,
    })

    expect(writtenRequests(child)[0]).toMatchObject({ method: 'initialize' })
    writeJsonLine(child.stdout, { jsonrpc: '2.0', id: 1, result: { protocolVersion: 1 } })
    await Promise.resolve()

    expect(writtenRequests(child)[1]).toMatchObject({
      method: 'session/new',
      params: { cwd: '/repo', mcpServers: [] },
    })
    writeJsonLine(child.stdout, {
      jsonrpc: '2.0',
      id: 2,
      result: {
        sessionId: 'session-1',
        configOptions: [
          {
            configId: 'model',
            type: 'select',
            category: 'model',
            options: [{ value: 'gpt-5', label: 'GPT-5' }],
          },
        ],
      },
    })
    await Promise.resolve()

    expect(writtenRequests(child)[2]).toMatchObject({
      method: 'session/set_config_option',
      params: { sessionId: 'session-1', configId: 'model', value: 'gpt-5' },
    })
    writeJsonLine(child.stdout, { jsonrpc: '2.0', id: 3, result: {} })

    const client = await promise
    client.close()
  })

  it('fails clearly when the ACP runtime rejects selected model config', async () => {
    const child = new FakeChildProcess()
    const spawnFn = makeSpawnFn(child)

    const promise = AcpSessionClient.start('claude-agent', '/repo', {
      selectedModel: 'opus',
      modelSelection: getAcpModelSelection('claude-agent::opus'),
      spawnFn,
    })

    writeJsonLine(child.stdout, { jsonrpc: '2.0', id: 1, result: { protocolVersion: 1 } })
    await Promise.resolve()
    writeJsonLine(child.stdout, { jsonrpc: '2.0', id: 2, result: { sessionId: 'session-1' } })
    await Promise.resolve()
    writeJsonLine(child.stdout, {
      jsonrpc: '2.0',
      id: 3,
      error: { message: 'Unknown config option model' },
    })

    await expect(promise).rejects.toThrow(/could not set selected model "opus"/i)
  })

  it('redacts adapter secrets from selected model config failures', async () => {
    const child = new FakeChildProcess()
    const spawnFn = makeSpawnFn(child)
    const leakedToken = 'sk-proj-abcdefghijklmnopqrstuvwxyz'
    const leakedEmail = 'operator@example.com'

    const promise = AcpSessionClient.start('claude-agent', '/repo', {
      selectedModel: 'opus',
      modelSelection: getAcpModelSelection('claude-agent::opus'),
      spawnFn,
    })

    writeJsonLine(child.stdout, { jsonrpc: '2.0', id: 1, result: { protocolVersion: 1 } })
    await Promise.resolve()
    writeJsonLine(child.stdout, { jsonrpc: '2.0', id: 2, result: { sessionId: 'session-1' } })
    await Promise.resolve()
    writeJsonLine(child.stdout, {
      jsonrpc: '2.0',
      id: 3,
      error: { message: `Failed with ${leakedToken} for ${leakedEmail}` },
    })

    await expect(promise).rejects.toThrow(/could not set selected model "opus".*\[redacted-token\].*\[redacted-email\]/i)
    await expect(promise).rejects.not.toThrow(leakedToken)
    await expect(promise).rejects.not.toThrow(leakedEmail)
  })

  it('redacts adapter secrets from prompt transport failures', async () => {
    const child = new FakeChildProcess()
    const spawnFn = makeSpawnFn(child)
    const leakedToken = 'ghp_abcdefghijklmnopqrstuvwxyz'
    const leakedFineGrainedPat = 'github_pat_11ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz'
    const leakedUserToken = 'ghu_abcdefghijklmnopqrstuvwxyz'

    const promise = AcpSessionClient.start('codex-cli', '/repo', { spawnFn })
    writeJsonLine(child.stdout, { jsonrpc: '2.0', id: 1, result: { protocolVersion: 1 } })
    await Promise.resolve()
    writeJsonLine(child.stdout, { jsonrpc: '2.0', id: 2, result: { sessionId: 'session-1' } })

    const client = await promise
    const promptPromise = client.prompt('hello')
    await Promise.resolve()
    writeJsonLine(child.stdout, {
      jsonrpc: '2.0',
      id: 3,
      error: { message: `adapter failed with ${leakedToken} ${leakedFineGrainedPat} ${leakedUserToken}` },
    })

    await expect(promptPromise).rejects.toThrow(/\[redacted-token\]/)
    await expect(promptPromise).rejects.not.toThrow(leakedToken)
    await expect(promptPromise).rejects.not.toThrow(leakedFineGrainedPat)
    await expect(promptPromise).rejects.not.toThrow(leakedUserToken)
    client.close()
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

})
