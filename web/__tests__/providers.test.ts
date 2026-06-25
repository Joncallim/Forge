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

  it('throws a clear non-executable error for ACP providers', async () => {
    mockDbSelect.mockReturnValue(chain([
      makeRow({ providerType: 'acp', modelId: 'claude-agent', isLocal: true }),
    ]))

    await expect(getProvider('config-id')).rejects.toThrow(/ACP provider execution is not implemented yet/i)
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
    mockDbSelect.mockReturnValue(chain([
      makeRow({
        providerType: 'lmstudio',
        baseUrl: 'http://localhost:1234/v1',
        modelId: 'google/gemma-4-e4b',
        isLocal: true,
      }),
    ]))

    const model = await getModel('config-id')

    expect(mockOpenAIChat).toHaveBeenCalledWith('google/gemma-4-e4b')
    expect(mockOpenAIInstance).not.toHaveBeenCalledWith('google/gemma-4-e4b')
    expect(model).toEqual({ _tag: 'openai-chat-model' })
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
      label: 'Claude Agent',
      adapterUrl: 'https://github.com/zed-industries/claude-agent-acp',
    })
    expect(getAcpAgent('codex-cli')).toMatchObject({
      label: 'Codex CLI',
      adapterUrl: 'https://github.com/zed-industries/codex-acp',
    })
  })
})

describe('checkProviderHealth', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('reports ACP providers as configured but not executable', async () => {
    const result = await checkProviderHealth(
      makeRow({ providerType: 'acp', modelId: 'codex-cli', isLocal: true }),
    )

    expect(result).toMatchObject({
      reachable: false,
      envVarPresent: true,
      latencyMs: null,
      error: 'ACP provider execution is not implemented yet',
    })
  })

  it('checks LM Studio health through model listing without starting generation', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('http://localhost:1234/api/v1/models')
      expect(init?.method).toBeUndefined()
      return new Response(JSON.stringify({
        models: [
          { type: 'llm', key: 'google/gemma-local' },
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
