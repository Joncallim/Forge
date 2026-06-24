/**
 * Suite 2 — Provider registry
 *
 * Tests for lib/providers/registry.ts:
 *  - getProvider instantiates the right factory for each providerType
 *  - getProvider returns null for inactive rows
 *  - getProvider warns when apiKeyEnvVar is set but env var is missing
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
    delete process.env.TEST_ANTHROPIC_KEY
    delete process.env.TEST_OPENAI_KEY
    delete process.env.TEST_OPENROUTER_KEY
    delete process.env.TEST_CUSTOM_KEY
    delete process.env.UNSET_KEY_VARIABLE
  })

  it('instantiates createAnthropic with the API key from the env var', async () => {
    process.env.TEST_ANTHROPIC_KEY = 'sk-ant-test'
    mockDbSelect.mockReturnValue(chain([
      makeRow({ providerType: 'anthropic', apiKeyEnvVar: 'TEST_ANTHROPIC_KEY' }),
    ]))

    await getProvider('config-id')

    expect(mockCreateAnthropic).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'sk-ant-test' }),
    )
  })

  it('instantiates createOpenAI with baseURL=https://openrouter.ai/api/v1 for openrouter', async () => {
    process.env.TEST_OPENROUTER_KEY = 'sk-or-test'
    mockDbSelect.mockReturnValue(chain([
      makeRow({ providerType: 'openrouter', apiKeyEnvVar: 'TEST_OPENROUTER_KEY' }),
    ]))

    await getProvider('config-id')

    expect(mockCreateOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({ baseURL: 'https://openrouter.ai/api/v1' }),
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

  it('instantiates createOpenAI with baseURL from the DB row for litellm', async () => {
    mockDbSelect.mockReturnValue(chain([
      makeRow({ providerType: 'litellm', baseUrl: 'http://litellm:4000', apiKeyEnvVar: null }),
    ]))

    await getProvider('config-id')

    expect(mockCreateOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({ baseURL: 'http://litellm:4000' }),
    )
  })

  it('instantiates createOpenAI with baseURL from the DB row for custom providers', async () => {
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
        apiKey: 'sk-custom-test',
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

  it('emits console.warn when apiKeyEnvVar is set but the env var is undefined', async () => {
    // UNSET_KEY_VARIABLE is deliberately not set in the environment
    mockDbSelect.mockReturnValue(chain([
      makeRow({ apiKeyEnvVar: 'UNSET_KEY_VARIABLE' }),
    ]))

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await getProvider('config-id')

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('UNSET_KEY_VARIABLE'),
    )

    warnSpy.mockRestore()
  })

  it('prefers the encrypted stored key over the env var', async () => {
    process.env.SESSION_SECRET = 'a'.repeat(64)
    process.env.TEST_ANTHROPIC_KEY = 'from-env'
    const apiKeyCiphertext = encryptSecret('from-db')

    mockDbSelect.mockReturnValue(chain([
      makeRow({
        providerType: 'anthropic',
        apiKeyEnvVar: 'TEST_ANTHROPIC_KEY',
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
    process.env.TEST_ANTHROPIC_KEY = 'sk-ant-test'
    mockDbSelect.mockReturnValue(chain([
      makeRow({
        providerType: 'anthropic',
        apiKeyEnvVar: 'TEST_ANTHROPIC_KEY',
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
