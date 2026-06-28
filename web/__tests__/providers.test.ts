/**
 * Suite 2 — Provider registry
 *
 * Tests for lib/providers/registry.ts:
 *  - getProvider instantiates the right factory for each providerType
 *  - getProvider returns null for inactive rows
 *  - getProvider allows only provider-specific apiKeyEnvVar values
 *  - getModel returns a LanguageModel (the factory's return value)
 *
 * vi.hoisted() is required because vi.mock() factories are hoisted before
 * variable declarations — without it, factory closures reference uninitialized
 * consts and throw ReferenceError.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

// ---------------------------------------------------------------------------
// Hoisted mock functions
// ---------------------------------------------------------------------------

const {
  mockDbSelect,
  mockCreateAnthropic,
  mockCreateOpenAI,
  mockCreateGoogleGenerativeAI,
  mockGenerateText,
  mockAnthropicInstance,
  mockOpenAIInstance,
  mockOpenAIChat,
  mockCheckAcpReadiness,
} = vi.hoisted(() => {
  const mockAnthropicInstance = vi.fn().mockReturnValue({ _tag: 'anthropic-model' })
  const mockOpenAIChat = vi.fn().mockReturnValue({ _tag: 'openai-chat-model' })
  const mockOpenAIInstance = Object.assign(
    vi.fn().mockReturnValue({ _tag: 'openai-model' }),
    { chat: mockOpenAIChat },
  )
  const mockGoogleInstance = vi.fn().mockReturnValue({ _tag: 'google-model' })
  return {
    mockDbSelect: vi.fn(),
    mockCreateAnthropic: vi.fn().mockReturnValue(mockAnthropicInstance),
    mockCreateOpenAI: vi.fn().mockReturnValue(mockOpenAIInstance),
    mockCreateGoogleGenerativeAI: vi.fn().mockReturnValue(mockGoogleInstance),
    mockGenerateText: vi.fn().mockResolvedValue({ text: 'ok' }),
    mockAnthropicInstance,
    mockOpenAIInstance,
    mockOpenAIChat,
    mockGoogleInstance,
    mockCheckAcpReadiness: vi.fn(),
  }
})

// ---------------------------------------------------------------------------
// Module-level mocks
// ---------------------------------------------------------------------------

vi.mock('@/db', () => ({
  db: { select: mockDbSelect },
}))

vi.mock('@ai-sdk/anthropic', () => ({ createAnthropic: mockCreateAnthropic }))
vi.mock('@ai-sdk/openai', () => ({ createOpenAI: mockCreateOpenAI }))
vi.mock('@ai-sdk/google', () => ({ createGoogleGenerativeAI: mockCreateGoogleGenerativeAI }))
vi.mock('ai', () => ({ generateText: mockGenerateText }))
vi.mock('@/lib/providers/acp/handshake', () => ({ checkAcpReadiness: mockCheckAcpReadiness }))

// ---------------------------------------------------------------------------
// Drizzle chain factory
// ---------------------------------------------------------------------------

function chain(resolveValue: unknown) {
  const t: Record<string, unknown> = {
    then: (ok: (v: unknown) => unknown, err?: (e: unknown) => unknown) =>
      Promise.resolve(resolveValue).then(ok, err),
    catch: (onRejected: (e: unknown) => unknown) =>
      Promise.resolve(resolveValue).catch(onRejected),
  }
  ;['from', 'where', 'limit', 'orderBy'].forEach((m) => { t[m] = () => t })
  return t
}

// ---------------------------------------------------------------------------
// Import SUT after mocks
// ---------------------------------------------------------------------------

import { getProvider, getModel } from '@/lib/providers/registry'
import { checkProviderHealth } from '@/lib/providers/health'
import { ACP_AGENTS, ACP_AGENTS_SOURCE_URL, getAcpAgent } from '@/lib/providers/acp/catalog'
import { PROVIDER_CATALOG, providerCategory } from '@/lib/providers/catalog'
import { encryptSecret } from '@/lib/crypto'
import type { ProviderConfig } from '@/db/schema'

// ---------------------------------------------------------------------------
// Row factory
// ---------------------------------------------------------------------------

function makeRow(overrides: Partial<ProviderConfig>): ProviderConfig {
  return {
    id: 'config-id',
    displayName: 'Test Provider',
    providerType: 'anthropic',
    modelId: 'claude-3-5-sonnet-20241022',
    baseUrl: null,
    apiKeyEnvVar: null,
    apiKeyCiphertext: null,
    isLocal: false,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests — getProvider
// ---------------------------------------------------------------------------

describe('getProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Reset factory mocks to their default return values
    mockCreateAnthropic.mockReturnValue(mockAnthropicInstance)
    mockCreateOpenAI.mockReturnValue(mockOpenAIInstance)
    // Clear env vars
    delete process.env.ANTHROPIC_API_KEY
    delete process.env.OPENAI_API_KEY
    delete process.env.OPENROUTER_API_KEY
    delete process.env.TEST_OPENROUTER_KEY
    delete process.env.TEST_CUSTOM_KEY
    delete process.env.UNSET_KEY_VARIABLE
  })

  it('instantiates createAnthropic with the API key from the env var', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test'
    mockDbSelect.mockReturnValue(chain([
      makeRow({ providerType: 'anthropic', apiKeyEnvVar: 'ANTHROPIC_API_KEY' }),
    ]))

    await getProvider('config-id')

    expect(mockCreateAnthropic).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'sk-ant-test' }),
    )
  })

  it('instantiates createOpenAI with baseURL=https://openrouter.ai/api/v1 for openrouter', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-test'
    mockDbSelect.mockReturnValue(chain([
      makeRow({ providerType: 'openrouter', apiKeyEnvVar: 'OPENROUTER_API_KEY' }),
    ]))

    await getProvider('config-id')

    expect(mockCreateOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({ baseURL: 'https://openrouter.ai/api/v1' }),
    )
  })

  it('ignores legacy custom baseUrl values for fixed cloud OpenAI-compatible providers', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-test'
    mockDbSelect.mockReturnValue(chain([
      makeRow({
        providerType: 'openrouter',
        baseUrl: 'https://attacker.example/v1',
        apiKeyEnvVar: 'OPENROUTER_API_KEY',
      }),
    ]))

    await getProvider('config-id')

    expect(mockCreateOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({ baseURL: 'https://openrouter.ai/api/v1' }),
    )
    expect(mockCreateOpenAI).not.toHaveBeenCalledWith(
      expect.objectContaining({ baseURL: 'https://attacker.example/v1' }),
    )
  })

  it('routes ollama through the OpenAI-compatible /v1 endpoint', async () => {
    mockDbSelect.mockReturnValue(chain([
      makeRow({ providerType: 'ollama', baseUrl: 'http://localhost:11434', apiKeyEnvVar: null }),
    ]))

    await getProvider('config-id')

    expect(mockCreateOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'ollama', baseURL: 'http://localhost:11434/v1' }),
    )
  })

  it('does not append /v1 twice for ollama base URLs that already include it', async () => {
    mockDbSelect.mockReturnValue(chain([
      makeRow({ providerType: 'ollama', baseUrl: 'http://localhost:11434/v1', apiKeyEnvVar: null }),
    ]))

    await getProvider('config-id')

    expect(mockCreateOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'ollama', baseURL: 'http://localhost:11434/v1' }),
    )
  })

  it('normalizes LM Studio host-only base URLs to the OpenAI-compatible /v1 runtime endpoint', async () => {
    mockDbSelect.mockReturnValue(chain([
      makeRow({ providerType: 'lmstudio', baseUrl: 'http://localhost:1234', apiKeyEnvVar: null }),
    ]))

    await getProvider('config-id')

    expect(mockCreateOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'lm-studio', baseURL: 'http://localhost:1234/v1' }),
    )
  })

  it('normalizes LM Studio native API base URLs back to the /v1 runtime endpoint', async () => {
    mockDbSelect.mockReturnValue(chain([
      makeRow({ providerType: 'lmstudio', baseUrl: 'http://localhost:1234/api/v1', apiKeyEnvVar: null }),
    ]))

    await getProvider('config-id')

    expect(mockCreateOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'lm-studio', baseURL: 'http://localhost:1234/v1' }),
    )
  })

  it('instantiates createOpenAI with baseURL from the DB row for litellm', async () => {
    mockDbSelect.mockReturnValue(chain([
      makeRow({ providerType: 'litellm', baseUrl: 'http://litellm:4000', apiKeyEnvVar: null }),
    ]))

    await getProvider('config-id')

    expect(mockCreateOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({ baseURL: 'http://litellm:4000' }),
    )
  })

  it('instantiates createOpenAI with baseURL from the DB row for custom providers without reading env vars', async () => {
    process.env.TEST_CUSTOM_KEY = 'sk-custom-test'
    mockDbSelect.mockReturnValue(chain([
      makeRow({
        providerType: 'custom',
        baseUrl: 'https://models.example.com/v1',
        apiKeyEnvVar: 'TEST_CUSTOM_KEY',
      }),
    ]))

    await getProvider('config-id')

    expect(mockCreateOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: undefined,
        baseURL: 'https://models.example.com/v1',
      }),
    )
  })

  it('throws when a custom provider is missing baseUrl', async () => {
    mockDbSelect.mockReturnValue(chain([
      makeRow({ providerType: 'custom', baseUrl: null }),
    ]))

    await expect(getProvider('config-id')).rejects.toThrow(/baseUrl is required/i)
  })

  it('returns a callable ACP provider factory instead of an SDK client', async () => {
    mockDbSelect.mockReturnValue(chain([
      makeRow({ providerType: 'acp', modelId: 'claude-agent', isLocal: true }),
    ]))

    const result = await getProvider('config-id')
    expect(typeof result?.provider).toBe('function')
    expect(mockCreateOpenAI).not.toHaveBeenCalled()
    expect(mockCreateAnthropic).not.toHaveBeenCalled()
  })

  it('returns null for an isActive=false row', async () => {
    mockDbSelect.mockReturnValue(chain([makeRow({ isActive: false })]))

    const result = await getProvider('config-id')
    expect(result).toBeNull()
  })

  it('returns null when no config row is found', async () => {
    mockDbSelect.mockReturnValue(chain([]))

    const result = await getProvider('missing-id')
    expect(result).toBeNull()
  })

  it('emits console.warn when an allowed apiKeyEnvVar is undefined', async () => {
    // ANTHROPIC_API_KEY is deliberately not set in the environment
    mockDbSelect.mockReturnValue(chain([
      makeRow({ providerType: 'anthropic', apiKeyEnvVar: 'ANTHROPIC_API_KEY' }),
    ]))

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await getProvider('config-id')

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('ANTHROPIC_API_KEY'),
    )

    warnSpy.mockRestore()
  })

  it('ignores unsafe legacy apiKeyEnvVar values instead of reading arbitrary env vars', async () => {
    process.env.SESSION_SECRET = 'do-not-read'
    mockDbSelect.mockReturnValue(chain([
      makeRow({
        providerType: 'custom',
        baseUrl: 'https://models.example.com/v1',
        apiKeyEnvVar: 'SESSION_SECRET',
      }),
    ]))

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await getProvider('config-id')

    expect(mockCreateOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: undefined,
        baseURL: 'https://models.example.com/v1',
      }),
    )
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('ignored unsafe apiKeyEnvVar'),
    )

    warnSpy.mockRestore()
  })

  it('prefers the encrypted stored key over the env var', async () => {
    process.env.SESSION_SECRET = 'a'.repeat(64)
    process.env.ANTHROPIC_API_KEY = 'from-env'
    const apiKeyCiphertext = encryptSecret('from-db')

    mockDbSelect.mockReturnValue(chain([
      makeRow({
        providerType: 'anthropic',
        apiKeyEnvVar: 'ANTHROPIC_API_KEY',
        apiKeyCiphertext,
      }),
    ]))

    await getProvider('config-id')

    expect(mockCreateAnthropic).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'from-db' }),
    )
  })
})

// ---------------------------------------------------------------------------
// Tests — getModel
// ---------------------------------------------------------------------------

describe('getModel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockCreateAnthropic.mockReturnValue(mockAnthropicInstance)
  })

  it('returns null when the config is not found', async () => {
    mockDbSelect.mockReturnValue(chain([]))
    const result = await getModel('missing-id')
    expect(result).toBeNull()
  })

  it('returns the LanguageModel by calling provider(modelId)', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test'
    mockDbSelect.mockReturnValue(chain([
      makeRow({
        providerType: 'anthropic',
        apiKeyEnvVar: 'ANTHROPIC_API_KEY',
        modelId: 'claude-opus-4-5',
      }),
    ]))

    const model = await getModel('config-id')

    // The anthropic factory instance was called with the modelId
    expect(mockAnthropicInstance).toHaveBeenCalledWith('claude-opus-4-5')
    expect(model).toEqual({ _tag: 'anthropic-model' })
  })

  it('uses chat completions for LM Studio models instead of the Responses API', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe('http://localhost:1234/api/v1/models')
      return new Response(JSON.stringify({
        models: [
          {
            type: 'llm',
            key: 'google/gemma-4-e4b',
            loaded_instances: [{ model: 'google/gemma-4-e4b' }],
          },
        ],
      }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    mockDbSelect.mockReturnValue(chain([
      makeRow({
        providerType: 'lmstudio',
        baseUrl: 'http://localhost:1234/v1',
        modelId: 'google/gemma-4-e4b',
        isLocal: true,
      }),
    ]))

    try {
      const model = await getModel('config-id')

      expect(mockOpenAIChat).toHaveBeenCalledWith('google/gemma-4-e4b')
      expect(mockOpenAIInstance).not.toHaveBeenCalledWith('google/gemma-4-e4b')
      expect(model).toEqual({ _tag: 'openai-chat-model' })
      expect(fetchMock).toHaveBeenCalledOnce()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('loads an available LM Studio model before returning the chat model', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === 'http://localhost:1234/api/v1/models') {
        return new Response(JSON.stringify({
          models: [{ type: 'llm', key: 'google/gemma-4-e4b', loaded_instances: [] }],
        }), { status: 200 })
      }
      expect(url).toBe('http://localhost:1234/api/v1/models/load')
      expect(init?.method).toBe('POST')
      expect(init?.body).toBe(JSON.stringify({ model: 'google/gemma-4-e4b' }))
      return new Response(JSON.stringify({}), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    mockDbSelect.mockReturnValue(chain([
      makeRow({
        providerType: 'lmstudio',
        baseUrl: 'http://localhost:1234/v1',
        modelId: 'google/gemma-4-e4b',
        isLocal: true,
      }),
    ]))

    try {
      await getModel('config-id')

      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(mockOpenAIChat).toHaveBeenCalledWith('google/gemma-4-e4b')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('does not preload LM Studio models for non-loopback endpoints', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    mockDbSelect.mockReturnValue(chain([
      makeRow({
        providerType: 'lmstudio',
        baseUrl: 'https://example.com/v1',
        modelId: 'google/gemma-4-e4b',
        isLocal: true,
      }),
    ]))

    try {
      await getModel('config-id')

      expect(fetchMock).not.toHaveBeenCalled()
      expect(mockOpenAIChat).toHaveBeenCalledWith('google/gemma-4-e4b')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('does not preload LM Studio models for non-local configs', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    mockDbSelect.mockReturnValue(chain([
      makeRow({
        providerType: 'lmstudio',
        baseUrl: 'http://localhost:1234/v1',
        modelId: 'google/gemma-4-e4b',
        isLocal: false,
      }),
    ]))

    try {
      await getModel('config-id')

      expect(fetchMock).not.toHaveBeenCalled()
      expect(mockOpenAIChat).toHaveBeenCalledWith('google/gemma-4-e4b')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('surfaces LM Studio preload failures before returning the model', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === 'http://localhost:1234/api/v1/models') {
        return new Response(JSON.stringify({
          models: [{ type: 'llm', key: 'google/gemma-4-e4b', loaded_instances: [] }],
        }), { status: 200 })
      }
      return new Response('out of memory', { status: 500 })
    })
    vi.stubGlobal('fetch', fetchMock)
    mockDbSelect.mockReturnValue(chain([
      makeRow({
        providerType: 'lmstudio',
        baseUrl: 'http://localhost:1234/v1',
        modelId: 'google/gemma-4-e4b',
        isLocal: true,
      }),
    ]))

    try {
      await expect(getModel('config-id')).rejects.toThrow(/could not load.*out of memory/i)
      expect(mockOpenAIChat).not.toHaveBeenCalledWith('google/gemma-4-e4b')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('ACP provider catalog', () => {
  it('defines a keyless local provider family and sourced agent list', () => {
    expect(PROVIDER_CATALOG.acp).toMatchObject({
      category: 'local',
      requiresApiKey: false,
      requiresBaseUrl: false,
    })
    expect(providerCategory('acp')).toBe('local')
    expect(ACP_AGENTS_SOURCE_URL).toBe('https://agentclientprotocol.com/get-started/agents')
    expect(ACP_AGENTS.length).toBeGreaterThan(10)
    expect(getAcpAgent('claude-agent')).toMatchObject({
      label: 'Claude Code',
      adapterUrl: 'https://github.com/zed-industries/claude-agent-acp',
      modelSelection: expect.objectContaining({ type: 'session_config_option' }),
    })
    expect(getAcpAgent('codex-cli')).toMatchObject({
      label: 'Codex CLI',
      adapterUrl: 'https://github.com/zed-industries/codex-acp',
      modelSelection: expect.objectContaining({ type: 'session_config_option' }),
    })
  })
})

describe('checkProviderHealth', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('reports a ready ACP provider as reachable based on the adapter handshake', async () => {
    mockCheckAcpReadiness.mockResolvedValueOnce({
      status: 'ready',
      message: 'Codex CLI is reachable and completed the ACP handshake.',
      latencyMs: 42,
    })

    const result = await checkProviderHealth(
      makeRow({ providerType: 'acp', modelId: 'codex-cli', isLocal: true }),
    )

    expect(mockCheckAcpReadiness).toHaveBeenCalledWith('codex-cli')
    expect(result).toMatchObject({
      status: 'ready',
      reachable: true,
      envVarPresent: true,
      latencyMs: 42,
      error: null,
    })
  })

  it('surfaces a failed ACP handshake as an actionable, non-reachable status', async () => {
    mockCheckAcpReadiness.mockResolvedValueOnce({
      status: 'handshake_failed',
      message: "Codex CLI's ACP adapter rejected the initialize handshake: boom",
      latencyMs: 12,
    })

    const result = await checkProviderHealth(
      makeRow({ providerType: 'acp', modelId: 'codex-cli', isLocal: true }),
    )

    expect(result).toMatchObject({
      status: 'handshake_failed',
      reachable: false,
      envVarPresent: true,
      latencyMs: 12,
      error: "Codex CLI's ACP adapter rejected the initialize handshake: boom",
    })
  })

  it('checks LM Studio health through model listing without starting generation', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('http://localhost:1234/api/v1/models')
      expect(init?.method).toBeUndefined()
      return new Response(JSON.stringify({
        models: [
          { type: 'llm', key: 'google/gemma-local', loaded_instances: [{ model: 'google/gemma-local' }] },
          { type: 'embedding', key: 'nomic-embed' },
        ],
      }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)

    try {
      const result = await checkProviderHealth(
        makeRow({
          providerType: 'lmstudio',
          baseUrl: 'http://localhost:1234',
          modelId: 'google/gemma-local',
          isLocal: true,
        }),
      )

      expect(result).toMatchObject({
        reachable: true,
        envVarPresent: true,
        error: null,
      })
      expect(result.latencyMs).toEqual(expect.any(Number))
      expect(fetchMock).toHaveBeenCalledOnce()
      expect(mockGenerateText).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('reports available LM Studio models as unloaded instead of ready', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      models: [
        { type: 'llm', key: 'google/gemma-local', loaded_instances: [] },
      ],
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    try {
      const result = await checkProviderHealth(
        makeRow({
          providerType: 'lmstudio',
          baseUrl: 'http://localhost:1234',
          modelId: 'google/gemma-local',
          isLocal: true,
        }),
      )

      expect(result).toMatchObject({
        status: 'available',
        reachable: false,
        envVarPresent: true,
      })
      expect(result.error).toMatch(/not loaded/i)
      expect(mockGenerateText).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('checks Ollama health through the lightweight model list endpoint', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('http://localhost:11434/api/tags')
      expect(init?.method).toBe('GET')
      return new Response(
        JSON.stringify({
          models: [
            { name: 'devstral-small:24b' },
            { model: 'qwen2.5-coder:7b' },
          ],
        }),
        { status: 200 },
      )
    })
    vi.stubGlobal('fetch', fetchMock)

    try {
      const result = await checkProviderHealth(
        makeRow({
          providerType: 'ollama',
          baseUrl: 'http://localhost:11434/v1',
          modelId: 'devstral-small:24b',
          isLocal: true,
        }),
      )

      expect(result).toMatchObject({
        reachable: true,
        envVarPresent: true,
        error: null,
      })
      expect(result.latencyMs).toEqual(expect.any(Number))
      expect(fetchMock).toHaveBeenCalledOnce()
      expect(mockGenerateText).not.toHaveBeenCalled()
      expect(mockCreateOpenAI).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('reports reachable Ollama servers that are missing the configured model', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ models: [{ name: 'llama3.2:3b' }] }), { status: 200 })),
    )

    try {
      const result = await checkProviderHealth(
        makeRow({
          providerType: 'ollama',
          baseUrl: 'http://localhost:11434',
          modelId: 'devstral-small:24b',
          isLocal: true,
        }),
      )

      expect(result).toMatchObject({
        reachable: false,
        envVarPresent: true,
        error: 'Ollama is reachable, but model "devstral-small:24b" is not installed',
      })
      expect(result.latencyMs).toEqual(expect.any(Number))
      expect(mockGenerateText).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('accepts Ollama latest tags for tagless model ids', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ models: [{ name: 'llama3.2:latest' }] }), { status: 200 })),
    )

    try {
      const result = await checkProviderHealth(
        makeRow({
          providerType: 'ollama',
          baseUrl: 'http://localhost:11434',
          modelId: 'llama3.2',
          isLocal: true,
        }),
      )

      expect(result).toMatchObject({
        reachable: true,
        envVarPresent: true,
        error: null,
      })
      expect(mockGenerateText).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('provider model construction call sites', () => {
  it('keeps runtime generation paths on getModel so OpenAI-compatible providers use chat completions', () => {
    const repoRoot = path.resolve(__dirname, '..')
    const files = [
      'worker/orchestrator.ts',
      'lib/agent-evaluation.ts',
      'lib/task-title.ts',
    ]

    for (const file of files) {
      const source = fs.readFileSync(path.join(repoRoot, file), 'utf8')
      expect(source).toContain('getModel(')
      expect(source).not.toMatch(/providerResult\.provider\s+as/)
    }
  })
})
